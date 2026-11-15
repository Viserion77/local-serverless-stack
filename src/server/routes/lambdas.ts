import { Router, Request, Response } from 'express';
import os from 'os';
import { FunctionRegistry } from '../services/function-registry.js';
import { LambdaRuntimeManager } from '../services/lambda-runtime-manager.js';
import { ConfigManager } from '../services/config-manager.js';
import { InvocationActivity } from '../services/invocation-activity.js';
import { WebFunctionManager, type WebServiceInfo } from '../services/web-function-manager.js';
import { WebFunctionGateway, PIN_HEADER } from '../services/web-function-gateway.js';
import { getBindHost } from '../services/bind-host.js';
import type { RegisteredWebFunction } from '../services/web-function-assembler.js';

const router = Router();

// The address to reach a local listener at from this process: the bind host,
// unless it is a wildcard (then the loopback answers).
function connectHost(): string {
  const host = getBindHost();
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

// One web function as the list shows it: endpoints with their local URLs and
// listener state, revisions with their environment state, and the totals.
function describeWebFunction(service: WebServiceInfo, fn: RegisteredWebFunction) {
  const manager = WebFunctionManager.getInstance();
  const gateway = WebFunctionGateway.getInstance();
  const totals = manager.getTotals(service.name, fn.name);
  return {
    service: service.name,
    name: fn.name,
    logicalId: fn.logicalId,
    arn: fn.arn,
    state: manager.functionState(service.name, fn.name),
    endpoints: fn.endpoints.map(ep => ({
      name: ep.name,
      logicalId: ep.logicalId,
      arn: ep.arn,
      authType: ep.authType,
      endpointType: ep.endpointType,
      port: ep.port,
      // `DomainName` as Fn::GetAtt resolves it, and the URL to open. Plain
      // http: TLS is terminated at the endpoint on AWS, and nothing locally.
      domainName: ep.port === undefined ? undefined : `localhost:${ep.port}`,
      url: ep.port === undefined ? undefined : `http://localhost:${ep.port}`,
      weights: ep.weights,
      listener: gateway.getListenerStatus(service.name, fn.name, ep.name),
    })),
    revisions: fn.revisions.map(rev => ({
      logicalId: rev.logicalId,
      arn: rev.arn,
      runtime: rev.runtime,
      description: rev.description,
      timeoutSeconds: rev.timeoutSeconds,
      maxConcurrency: rev.maxConcurrency,
      code: rev.code,
      ...manager.revisionStatus(service.name, fn.name, rev.revisionId),
    })),
    warnings: fn.warnings,
    requests: totals.requests,
    errors: totals.errors,
    lastRequestAt: totals.lastRequestAt,
  };
}

function findWebFunction(req: Request): { service: WebServiceInfo; fn: RegisteredWebFunction } | undefined {
  return WebFunctionManager.getInstance()
    .listFunctions()
    .find(ref => ref.service.name === String(req.params.service) && ref.fn.name === String(req.params.name));
}

// Lambda Web Functions. Registered BEFORE /:name, which would otherwise claim
// `/web` as a function name (the same precedent as /activity).
router.get('/web', (_req: Request, res: Response) => {
  return res.json(WebFunctionManager.getInstance().listFunctions().map(ref => describeWebFunction(ref.service, ref.fn)));
});

router.get('/web/:service/:name', (req: Request, res: Response) => {
  const ref = findWebFunction(req);
  if (!ref) {
    return res.status(404).json({ error: `Web function not found: ${req.params.service}/${req.params.name}` });
  }
  const manager = WebFunctionManager.getInstance();
  return res.json({
    ...describeWebFunction(ref.service, ref.fn),
    environment: Object.fromEntries(ref.fn.revisions.map(rev => [rev.revisionId, rev.environment])),
    recentRequests: manager.getRequests(ref.service.name, ref.fn.name).reverse(),
    logs: manager.getLogs(ref.service.name, ref.fn.name),
  });
});

// Stop the function's environments (AWS shutdown sequence); the next request
// starts them again — the button for "pick up what I just changed" when the
// watcher is off.
router.post('/web/:service/:name/restart', async (req: Request, res: Response) => {
  const restarted = await WebFunctionManager.getInstance().restartFunction(String(req.params.service), String(req.params.name));
  if (!restarted) {
    return res.status(404).json({ error: `Web function not found: ${req.params.service}/${req.params.name}` });
  }
  return res.json({ restarted: true });
});

// Send one HTTP request to a web function endpoint and return what came back
// (status, headers, body — text, capped). This is how the MCP server lets an
// agent exercise the app without a network tool of its own; it goes through
// the real endpoint listener, so auth, revision weights and the request id all
// apply.
const BODY_LIMIT = 64 * 1024;

function headersOf(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}
router.post('/web/:service/:name/request', async (req: Request, res: Response) => {
  const ref = findWebFunction(req);
  if (!ref) {
    return res.status(404).json({ error: `Web function not found: ${req.params.service}/${req.params.name}` });
  }
  const input = (req.body ?? {}) as {
    method?: unknown; path?: unknown; headers?: unknown; body?: unknown; endpoint?: unknown; revision?: unknown;
  };
  const endpoint = typeof input.endpoint === 'string'
    ? ref.fn.endpoints.find(ep => ep.name === input.endpoint)
    : ref.fn.endpoints.find(ep => ep.port !== undefined);
  if (!endpoint?.port) {
    return res.status(404).json({ error: `No served endpoint ${typeof input.endpoint === 'string' ? `"${input.endpoint}" ` : ''}on ${ref.fn.name}` });
  }
  const method = typeof input.method === 'string' && input.method ? input.method.toUpperCase() : 'GET';
  const rawPath = typeof input.path === 'string' && input.path ? input.path : '/';
  const headers: Record<string, string> = {};
  if (input.headers && typeof input.headers === 'object') {
    for (const [key, value] of Object.entries(input.headers as Record<string, unknown>)) headers[key] = String(value);
  }
  if (typeof input.revision === 'string' && input.revision) headers[PIN_HEADER] = input.revision;
  const body = input.body === undefined || method === 'GET' || method === 'HEAD'
    ? undefined
    : typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
  // The longest timeout of the function's revisions, plus slack for a cold start.
  const timeoutMs = (Math.max(...ref.fn.revisions.map(rev => rev.timeoutSeconds), 30) + 15) * 1000;
  const startedAt = Date.now();
  try {
    const answer = await fetch(`http://${connectHost()}:${endpoint.port}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await answer.text();
    return res.json({
      status: answer.status,
      headers: headersOf(answer.headers),
      body: text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) : text,
      truncated: text.length > BODY_LIMIT,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return res.status(502).json({ error: `Request to ${endpoint.name} failed: ${(error as Error).message}` });
  }
});

function describeFunction(ref: ReturnType<FunctionRegistry['listFunctions']>[number]) {
  const runtimeManager = LambdaRuntimeManager.getInstance();
  const info = runtimeManager.getRuntimeInfo(ref.service.name);
  const history = runtimeManager.getHistory(ref.service.name, ref.fn.name);
  const last = history[history.length - 1];
  return {
    name: ref.fn.name,
    fullName: ref.fn.fullName,
    service: ref.service.name,
    handler: ref.fn.handler,
    runtime: ref.fn.runtime,
    memorySize: ref.fn.memorySize,
    timeout: ref.fn.timeout,
    triggers: ref.fn.triggers,
    invokePort: ref.service.invokePort,
    status: info.status,
    // False while the service's worker has not been forked yet (lazy start or
    // idle unload) — the function is still invocable, the first call just pays
    // a cold start.
    warm: info.warm ?? false,
    executionMode: info.resolvedMode,
    invocations: history.length,
    errors: history.filter(h => !h.ok).length,
    lastInvokedAt: last?.at,
    lastDurationMs: last?.durationMs,
    lastOk: last?.ok,
  };
}

// List every registered function across services, with runtime status.
router.get('/', (_req: Request, res: Response) => {
  const refs = FunctionRegistry.getInstance().listFunctions();
  return res.json(refs.map(describeFunction));
});

// Function detail — accepts the short or fully qualified name.
// What the stack is actually doing right now: which workers are resident, what
// ran recently, how much of it overlapped, and what that costs the host.
// Registered BEFORE /:name — the path would otherwise match a function called
// "activity".
router.get('/activity', (req: Request, res: Response) => {
  const runtimeManager = LambdaRuntimeManager.getInstance();
  const cm = ConfigManager.getInstance();
  const snapshot = InvocationActivity.getInstance().snapshot({
    windowMs: numeric(req.query.windowMs),
    buckets: numeric(req.query.buckets),
  });

  // One row per registered service: a worker is a whole OS process, so this is
  // the unit that actually costs memory — not the function count.
  //
  // `loadedFunctions` is the other half of the question, and the one the
  // service row cannot answer: a worker is one process serving many functions,
  // each loaded on ITS first invocation. "billing-service is warm" does not say
  // whether that is one handler or sixty, nor WHICH — and which is what an
  // operator debugging a silent lambda is actually looking for.
  const workers = FunctionRegistry.getInstance().listServices().map(service => {
    const info = runtimeManager.getRuntimeInfo(service.name);
    return {
      service: service.name,
      status: info.status,
      warm: info.warm ?? false,
      pid: info.pid,
      startedAt: info.startedAt,
      lastInvokedAt: info.lastInvokedAt,
      invocations: info.invocations,
      errors: info.errors,
      functions: service.functions.length,
      loadedFunctions: info.loadedFunctions ?? [],
      executionMode: info.resolvedMode,
    };
  });

  const memory = process.memoryUsage();
  return res.json({
    ...snapshot,
    workers,
    residency: {
      // The policy that bounds the whole thing, so the numbers above can be
      // read against their ceiling instead of in the abstract.
      warm: workers.filter(w => w.warm).length,
      maxWarmWorkers: cm.getLambdaMaxWarmWorkers(),
      lazy: cm.isLambdaRuntimeLazy(),
      idleTimeoutMs: cm.getLambdaIdleTimeoutMs(),
      // Handlers resident across every live worker, and how many exist in
      // total. The gap between them is the point of lazy loading: 3 of 1024
      // means the stack is paying for three.
      loadedFunctions: workers.reduce((sum, w) => sum + w.loadedFunctions.length, 0),
      registeredFunctions: workers.reduce((sum, w) => sum + w.functions, 0),
    },
    host: {
      // Resident set of the orchestrator process — with in-process emulation
      // and forked workers, this plus the workers IS the stack's footprint.
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      cpuCount: os.cpus().length,
      // 1-minute load average; 0 on platforms that do not report it.
      loadAvg1m: os.loadavg()[0],
      uptimeMs: Math.round(process.uptime() * 1000),
    },
  });
});

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

router.get('/:name', (req: Request, res: Response) => {
  const ref = FunctionRegistry.getInstance().resolve(String(req.params.name));
  if (!ref) {
    return res.status(404).json({ error: `Function not found: ${req.params.name}` });
  }
  return res.json({
    ...describeFunction(ref),
    environment: ref.fn.environment,
    routes: ref.service.routes
      .filter(r => r.functionName === ref.fn.name)
      .map(r => ({ method: r.method, path: r.path, eventType: r.eventType, authorizerName: r.authorizerName })),
  });
});

// Invoke any registered function (UI / LssClient / tests). The AWS-compatible
// channel is the per-service invoke port; this one returns logs and duration.
router.post('/:name/invoke', async (req: Request, res: Response) => {
  try {
    const ref = FunctionRegistry.getInstance().resolve(String(req.params.name));
    if (!ref) {
      return res.status(404).json({ error: `Function not found: ${req.params.name}` });
    }
    const { payload, invocationType } = req.body || {};

    if (invocationType === 'Event') {
      void LambdaRuntimeManager.getInstance().invoke(ref.service.name, ref.fn, payload ?? {});
      return res.status(202).json({ accepted: true });
    }

    const result = await LambdaRuntimeManager.getInstance().invoke(ref.service.name, ref.fn, payload ?? {});
    return res.json({
      ok: result.ok,
      payload: result.payload,
      functionError: result.ok ? undefined : { errorType: result.errorType, errorMessage: result.errorMessage, trace: result.trace },
      logs: result.logs,
      durationMs: result.durationMs,
    });
  } catch (error) {
    console.error('Error invoking function:', error);
    return res.status(500).json({ error: 'Failed to invoke function' });
  }
});

// Recent invocations (with captured console output) for one function.
router.get('/:name/logs', (req: Request, res: Response) => {
  const ref = FunctionRegistry.getInstance().resolve(String(req.params.name));
  if (!ref) {
    return res.status(404).json({ error: `Function not found: ${req.params.name}` });
  }
  const history = LambdaRuntimeManager.getInstance().getHistory(ref.service.name, ref.fn.name);
  return res.json({ invocations: history });
});

export { router as lambdasRouter };
