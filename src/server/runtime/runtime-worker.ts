// Lambda runtime worker — one forked process per registered service. Loads
// handlers (compiled artifact or source, JS or TS) on demand, executes them with
// a Lambda-shaped context/timeout, and reports results over IPC. Keeping this in
// a child process isolates handler env vars and crashes from the orchestrator,
// while module caching between invocations gives "warm start" behavior.

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { installOutputCapture } from './log-capture.js';

interface InvokeMessage {
  type: 'invoke';
  invokeId: string;
  functionName: string;
  fullName: string;
  handler: string;
  handlerRoot: string;
  serviceRoot: string;
  timeoutSeconds: number;
  memorySize: number;
  region: string;
  env: Record<string, string>;
  event: unknown;
}

interface ResultMessage {
  type: 'result';
  invokeId: string;
  ok: boolean;
  payload?: unknown;
  error?: { errorType: string; errorMessage: string; trace?: string[] };
  logs: string[];
  durationMs: number;
  // The function whose handler is now in this worker's module cache. Only the
  // worker knows: a service's worker is one process for many functions, and a
  // handler is loaded on ITS first invocation, not when the worker is forked.
  // Reported so the manager can answer "which lambdas are actually resident?"
  // instead of only "which services have a process".
  loadedFunction?: string;
}

type HandlerFn = (event: unknown, context: unknown, callback?: (err: unknown, res?: unknown) => void) => unknown;

const handlerCache = new Map<string, HandlerFn>();
const logStorage = new AsyncLocalStorage<string[]>();
const activeLogs = new Set<string[]>();
let tsLoaderRegistered = false;

// Capture output per invocation without breaking interleaved async handlers —
// AsyncLocalStorage routes each line to the invocation that emitted it. The
// capture hooks the stream AND fd layers (not just console.*), so structured
// loggers like pino — which write JSON straight to fd 1 via sonic-boom — land
// in the invocation record too. Lines with no invocation context (module init
// during cold start, stray timers) attribute to the only in-flight invocation
// when that is unambiguous; otherwise they pass through to the worker's
// stdout/stderr for the manager to surface as service-level output.
const capture = installOutputCapture(() => {
  const contextual = logStorage.getStore();
  if (contextual && activeLogs.has(contextual)) return contextual;
  if (!contextual && activeLogs.size === 1) return activeLogs.values().next().value;
  return undefined;
});

function resolveHandlerFile(root: string, filePart: string): string | null {
  const base = path.resolve(root, filePart);
  const extensions = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'];
  for (const ext of extensions) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  // Handler may point at a directory with an index file.
  for (const ext of extensions) {
    const indexFile = path.join(base, `index${ext}`);
    if (fs.existsSync(indexFile)) return indexFile;
  }
  return null;
}

function hasNativeTypeScriptSupport(): boolean {
  return Boolean((process.features as NodeJS.ProcessFeatures & { typescript?: boolean }).typescript);
}

async function tryNativeTypeScriptImport(file: string): Promise<Record<string, unknown> | null> {
  if (!hasNativeTypeScriptSupport()) return null;
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Register a TypeScript require hook, resolving the loader from the service's
// own node_modules first (its version wins), then from LSS's dependencies.
function ensureTsLoader(serviceRoot: string): void {
  if (tsLoaderRegistered) return;
  const resolvers = [
    createRequire(path.join(serviceRoot, 'noop.js')),
    createRequire(import.meta.url),
  ];
  const candidates = [
    { id: 'esbuild-register/dist/node', register: true },
    { id: 'tsx/cjs', register: false },
    { id: 'ts-node/register/transpile-only', register: false },
  ];
  for (const resolver of resolvers) {
    for (const candidate of candidates) {
      try {
        const mod = resolver(candidate.id);
        if (candidate.register && typeof mod.register === 'function') {
          mod.register();
        }
        tsLoaderRegistered = true;
        return;
      } catch {
        // Try the next loader/resolver.
      }
    }
  }
  throw new Error(
    'TypeScript handler found but no TS loader is available. Install "esbuild-register" (or tsx/ts-node) ' +
    'in the service, or use execution mode "artifact" so LSS loads the compiled bundle instead.',
  );
}

async function loadHandler(msg: InvokeMessage): Promise<HandlerFn> {
  const cacheKey = `${msg.handlerRoot}::${msg.handler}`;
  const cached = handlerCache.get(cacheKey);
  if (cached) return cached;

  const lastDot = msg.handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Invalid handler reference "${msg.handler}" (expected "path/to/file.exportName")`);
  }
  const filePart = msg.handler.slice(0, lastDot);
  const exportName = msg.handler.slice(lastDot + 1);

  const file = resolveHandlerFile(msg.handlerRoot, filePart);
  if (!file) {
    throw new Error(`Handler file not found for "${msg.handler}" under ${msg.handlerRoot}`);
  }

  let mod: Record<string, unknown> | null = null;
  if (/\.(ts|cts|mts)$/.test(file)) {
    // Node 22.6+/24 can strip TS types natively when process.features.typescript
    // is enabled. Prefer that path before requiring service-side loader deps.
    mod = await tryNativeTypeScriptImport(file);
    if (!mod) {
      ensureTsLoader(msg.serviceRoot);
    }
  }

  // Resolve like a module sitting inside the service, so relative requires and
  // the service's node_modules work; fall back to dynamic import for ESM files.
  const serviceRequire = createRequire(path.join(msg.handlerRoot, 'noop.js'));
  if (!mod) {
    try {
      mod = serviceRequire(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ERR_REQUIRE_ESM' || /\.mjs$/.test(file)) {
        mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      } else {
        throw err;
      }
    }
  }
  if (!mod) {
    throw new Error(`Handler module failed to load from ${file}`);
  }

  const candidate = mod[exportName]
    ?? (mod.default as Record<string, unknown> | undefined)?.[exportName];
  if (typeof candidate !== 'function') {
    throw new Error(`Export "${exportName}" not found (or not a function) in ${file}`);
  }

  const handler = candidate as HandlerFn;
  handlerCache.set(cacheKey, handler);
  return handler;
}

function buildContext(msg: InvokeMessage, deadline: number, requestId: string) {
  return {
    functionName: msg.fullName,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:${msg.region}:000000000000:function:${msg.fullName}`,
    memoryLimitInMB: String(msg.memorySize),
    awsRequestId: requestId,
    logGroupName: `/aws/lambda/${msg.fullName}`,
    logStreamName: `${new Date().toISOString().slice(0, 10)}/[$LATEST]${requestId}`,
    callbackWaitsForEmptyEventLoop: true,
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
  };
}

async function runHandler(handler: HandlerFn, event: unknown, context: unknown): Promise<unknown> {
  if (handler.length >= 3) {
    return new Promise((resolve, reject) => {
      const maybe = handler(event, context, (err, res) => (err ? reject(err) : resolve(res)));
      if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
        (maybe as Promise<unknown>).then(resolve, reject);
      }
    });
  }
  return handler(event, context);
}

async function handleInvoke(msg: InvokeMessage): Promise<void> {
  const logs: string[] = [];
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const deadline = startedAt + msg.timeoutSeconds * 1000;

  // Function env is applied to the shared process env (functions of one service
  // share a worker, mirroring how serverless-offline behaves).
  Object.assign(process.env, msg.env, {
    AWS_REGION: msg.region,
    AWS_DEFAULT_REGION: msg.region,
    AWS_LAMBDA_FUNCTION_NAME: msg.fullName,
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(msg.memorySize),
  });
  if (!process.env.AWS_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = 'test';
  if (!process.env.AWS_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = 'test';

  // Set once the handler is in the module cache — which is what makes this
  // function "resident", and is not the same as the worker being up.
  let loadedFunction: string | undefined;

  const reply = (result: Omit<ResultMessage, 'type' | 'invokeId' | 'logs' | 'durationMs'>) => {
    capture.flush(logs);
    const message: ResultMessage = {
      type: 'result',
      invokeId: msg.invokeId,
      logs,
      durationMs: Date.now() - startedAt,
      loadedFunction,
      ...result,
    };
    process.send?.(message);
  };

  activeLogs.add(logs);
  try {
    const handler = await loadHandler(msg);
    // Reported even when the handler then throws: it IS loaded, and a failing
    // handler that stays resident is exactly what an operator needs to see.
    loadedFunction = msg.functionName;
    const context = buildContext(msg, deadline, requestId);

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`${new Date().toISOString()} ${requestId} Task timed out after ${msg.timeoutSeconds.toFixed(2)} seconds`), {
          name: 'TimeoutError',
        }));
      }, deadline - Date.now());
      timer.unref();
    });

    const payload = await logStorage.run(logs, () => Promise.race([runHandler(handler, msg.event, context), timeout]));
    reply({ ok: true, payload: payload === undefined ? null : payload });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    reply({
      ok: false,
      error: {
        errorType: error.name || 'Error',
        errorMessage: error.message,
        trace: error.stack ? error.stack.split('\n') : undefined,
      },
    });
  } finally {
    activeLogs.delete(logs);
  }
}

process.on('message', (msg: InvokeMessage) => {
  if (msg && msg.type === 'invoke') {
    void handleInvoke(msg);
  }
});

// A handler's stray rejection must not kill the worker (and every in-flight
// invocation with it).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in lambda worker:', reason);
});

process.send?.({ type: 'ready' });
