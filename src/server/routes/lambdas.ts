import { Router, Request, Response } from 'express';
import os from 'os';
import { FunctionRegistry } from '../services/function-registry.js';
import { LambdaRuntimeManager } from '../services/lambda-runtime-manager.js';
import { ConfigManager } from '../services/config-manager.js';
import { InvocationActivity } from '../services/invocation-activity.js';

const router = Router();

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
