// Manages one runtime worker per registered service: resolves where handler code
// lives (packaged artifact vs source tree), forks/restarts the worker, and
// brokers invocations over IPC with Lambda-shaped results. This is what replaces
// serverless-offline as the thing that actually runs handlers.

import { fork, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { ConfigManager, LambdaExecutionMode } from './config-manager.js';
import { projectCacheSegment } from './cache-manager.js';
import { FunctionRegistry, ServiceEntry } from './function-registry.js';
import { resolveArtifacts } from './artifact-resolver.js';
import type { RegisteredFunction } from './serverless-state-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `idle` is internal: the service is registered and ready, but its worker has
// not been forked yet (lazy mode) or was unloaded after sitting unused.
// getRuntimeInfo() reports it as `online` with `warm: false`, because for every
// consumer — dashboard, routes, dispatch — it means "an invoke will be served".
export type RuntimeStatus = 'stopped' | 'idle' | 'starting' | 'online' | 'error';

export interface InvokeResult {
  ok: boolean;
  payload?: unknown;
  errorType?: string;
  errorMessage?: string;
  trace?: string[];
  logs: string[];
  durationMs: number;
}

export interface InvocationRecord {
  at: number;
  functionName: string;
  ok: boolean;
  // HTTP status of an API-Gateway-shaped payload — an "ok" invocation whose
  // handler answered a 500 must not read as healthy in the dashboard.
  statusCode?: number;
  durationMs: number;
  logs: string[];
}

export function httpStatusOf(payload: unknown): number | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const status = (payload as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return undefined;
}

export interface RuntimeInfo {
  // Never 'idle' — see the RuntimeStatus note; use `warm` to tell a forked
  // worker from one that will be forked on demand.
  status: RuntimeStatus;
  // False when no worker process is alive yet (lazy start or idle unload).
  warm?: boolean;
  executionMode?: LambdaExecutionMode;
  resolvedMode?: 'artifact' | 'source';
  handlerRoot?: string;
  pid?: number;
  startedAt?: number;
  error?: string;
  invocations: number;
  errors: number;
  lastInvokedAt?: number;
}

interface PendingInvoke {
  resolve: (result: InvokeResult) => void;
  timer: NodeJS.Timeout;
}

interface ServiceRuntime {
  entry: ServiceEntry;
  status: RuntimeStatus;
  executionMode: LambdaExecutionMode;
  resolvedMode?: 'artifact' | 'source';
  handlerRoot?: string;
  worker?: ChildProcess;
  startedAt?: number;
  error?: string;
  pending: Map<string, PendingInvoke>;
  // Invokes accepted while the worker is still booting.
  queue: Array<() => void>;
  invocations: number;
  errors: number;
  lastInvokedAt?: number;
  restartCount: number;
  lastRestartAt: number;
  history: InvocationRecord[];
  // Set while a worker is alive and idleTimeoutMs is configured.
  idleTimer?: NodeJS.Timeout;
}

const HISTORY_LIMIT = 50;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 30000;
// Manager-side grace on top of the function timeout, so a hung worker still
// yields a response instead of a dangling request.
const IPC_GRACE_MS = 5000;

export class LambdaRuntimeManager {
  private static instance: LambdaRuntimeManager;
  private runtimes = new Map<string, ServiceRuntime>();
  private configManager = ConfigManager.getInstance();

  static getInstance(): LambdaRuntimeManager {
    if (!LambdaRuntimeManager.instance) {
      LambdaRuntimeManager.instance = new LambdaRuntimeManager();
    }
    return LambdaRuntimeManager.instance;
  }

  // Bring the runtime for a service in line with its (re-)registration: restart
  // the worker so new code/config is picked up.
  async syncService(entry: ServiceEntry): Promise<void> {
    const runtimeConfig = this.configManager.getRuntimeConfigForService(entry.root);
    if (!runtimeConfig.enabled || entry.functions.length === 0) {
      await this.stopRuntime(entry.name);
      this.runtimes.delete(entry.name);
      return;
    }
    await this.stopRuntime(entry.name);
    const runtime: ServiceRuntime = {
      entry,
      status: 'stopped',
      executionMode: runtimeConfig.execution,
      pending: new Map(),
      queue: [],
      invocations: this.runtimes.get(entry.name)?.invocations ?? 0,
      errors: this.runtimes.get(entry.name)?.errors ?? 0,
      restartCount: 0,
      lastRestartAt: 0,
      history: this.runtimes.get(entry.name)?.history ?? [],
    };
    this.runtimes.set(entry.name, runtime);

    // Lazy (default): resolve where the handlers live now — so an unusable
    // artifact still fails loudly at registration — but leave the fork to the
    // first invocation. A worker is ~48 MB resident; a 40-service monorepo was
    // paying ~1.9 GB before a single handler ran.
    if (this.configManager.isLambdaRuntimeLazy()) {
      if (this.resolveHandlerRootInto(runtime)) runtime.status = 'idle';
      return;
    }
    this.startWorker(runtime);
  }

  async startRuntime(serviceName: string): Promise<RuntimeInfo> {
    const entry = FunctionRegistry.getInstance().getService(serviceName);
    if (!entry) throw new Error(`Service ${serviceName} not registered`);
    await this.syncService(entry);
    return this.getRuntimeInfo(serviceName);
  }

  async stopRuntime(serviceName: string): Promise<void> {
    const runtime = this.runtimes.get(serviceName);
    if (!runtime) return;
    runtime.status = 'stopped';
    runtime.error = undefined;
    this.clearIdleTimer(runtime);
    const worker = runtime.worker;
    runtime.worker = undefined;
    if (worker) {
      worker.removeAllListeners();
      worker.kill('SIGTERM');
    }
    for (const [, pending] of runtime.pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.errorResult('RuntimeStopped', 'Lambda runtime was stopped', 0));
    }
    runtime.pending.clear();
    runtime.queue = [];
  }

  async stopAll(): Promise<void> {
    for (const name of this.runtimes.keys()) {
      await this.stopRuntime(name);
    }
  }

  // Restart keeping the same registration (used by the source watcher — the
  // worker's module cache is the only thing that needs flushing).
  async restartRuntime(serviceName: string): Promise<void> {
    const runtime = this.runtimes.get(serviceName);
    if (!runtime) return;
    await this.syncService(runtime.entry);
  }

  // Drop a live worker back to `idle` (the next invoke re-forks it). Never
  // interrupts an in-flight invocation; returns false when it declined.
  private unloadWorker(runtime: ServiceRuntime, reason: string): boolean {
    if (runtime.status !== 'online' || runtime.pending.size > 0) return false;
    this.clearIdleTimer(runtime);
    const worker = runtime.worker;
    runtime.worker = undefined;
    runtime.status = 'idle';
    worker?.removeAllListeners();
    worker?.kill('SIGTERM');
    console.log(`💤 Lambda runtime for "${runtime.entry.name}" unloaded (${reason})`);
    return true;
  }

  // Unload a worker that has served nothing for idleTimeoutMs. LSS is a
  // development stack: a handler only needs to be resident while it is in use,
  // and re-forking costs ~20 ms.
  private armIdleUnload(runtime: ServiceRuntime): void {
    this.clearIdleTimer(runtime);
    const timeoutMs = this.configManager.getLambdaIdleTimeoutMs();
    if (!timeoutMs || !this.configManager.isLambdaRuntimeLazy()) return;
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = undefined;
      this.unloadWorker(runtime, `idle for ${timeoutMs} ms`);
    }, timeoutMs);
    runtime.idleTimer.unref();
  }

  // Hard ceiling on resident workers, enforced when one comes online: evict the
  // least-recently-invoked idle worker until the count is back under the cap.
  // Without it, a burst that touches every service inside the idle window (a
  // full test run, a boot script) would still hold N x ~48 MB at once — the
  // ceiling is what keeps host memory a function of services *in flight*
  // rather than services registered.
  private enforceWarmCap(justStarted: ServiceRuntime): void {
    const max = this.configManager.getLambdaMaxWarmWorkers();
    if (!max || !this.configManager.isLambdaRuntimeLazy()) return;
    for (;;) {
      const warm = [...this.runtimes.values()].filter(r => r.worker);
      if (warm.length <= max) return;
      const victim = warm
        .filter(r => r !== justStarted && r.status === 'online' && r.pending.size === 0)
        .sort((a, b) => (a.lastInvokedAt ?? a.startedAt ?? 0) - (b.lastInvokedAt ?? b.startedAt ?? 0))[0];
      // Nothing evictable right now (everything else is busy or still booting):
      // the cap is exceeded transiently rather than blocking the invocation.
      if (!victim || !this.unloadWorker(victim, `warm-worker cap of ${max} reached`)) return;
    }
  }

  private clearIdleTimer(runtime: ServiceRuntime): void {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
  }

  getRuntimeInfo(serviceName: string): RuntimeInfo {
    const runtime = this.runtimes.get(serviceName);
    if (!runtime) {
      return { status: 'stopped', invocations: 0, errors: 0 };
    }
    return {
      // `idle` means "ready, not forked yet" — every consumer treats it as
      // online; `warm` is the field that distinguishes the two.
      status: runtime.status === 'idle' ? 'online' : runtime.status,
      warm: Boolean(runtime.worker),
      executionMode: runtime.executionMode,
      resolvedMode: runtime.resolvedMode,
      handlerRoot: runtime.handlerRoot,
      pid: runtime.worker?.pid,
      startedAt: runtime.startedAt,
      error: runtime.error,
      invocations: runtime.invocations,
      errors: runtime.errors,
      lastInvokedAt: runtime.lastInvokedAt,
    };
  }

  getHistory(serviceName: string, functionName?: string): InvocationRecord[] {
    const runtime = this.runtimes.get(serviceName);
    if (!runtime) return [];
    return functionName
      ? runtime.history.filter(h => h.functionName === functionName)
      : runtime.history;
  }

  async invoke(serviceName: string, fn: RegisteredFunction, event: unknown): Promise<InvokeResult> {
    const runtime = this.runtimes.get(serviceName);
    if (!runtime || runtime.status === 'stopped' || runtime.status === 'error') {
      return this.errorResult(
        'RuntimeUnavailable',
        `Lambda runtime for service "${serviceName}" is not running${runtime?.error ? ` (${runtime.error})` : ''}`,
        0,
      );
    }

    // Lazy runtime, first invocation (or first after an idle unload): this is
    // the cold start the deferred fork trades the resident memory for.
    if (runtime.status === 'idle') {
      this.startWorker(runtime);
      if ((runtime.status as RuntimeStatus) === 'error') {
        return this.errorResult(
          'RuntimeUnavailable',
          `Lambda runtime for service "${serviceName}" failed to start (${runtime.error})`,
          0,
        );
      }
    }

    if (runtime.status === 'starting') {
      await new Promise<void>(resolve => runtime.queue.push(resolve));
      if ((runtime.status as RuntimeStatus) !== 'online') {
        return this.errorResult('RuntimeUnavailable', `Lambda runtime for service "${serviceName}" failed to start`, 0);
      }
    }

    const worker = runtime.worker;
    if (!worker) {
      return this.errorResult('RuntimeUnavailable', `Lambda runtime worker for "${serviceName}" is gone`, 0);
    }

    const invokeId = crypto.randomUUID();
    const timeoutSeconds = fn.timeout || 6;
    const startedAt = Date.now();

    const result = await new Promise<InvokeResult>(resolve => {
      const timer = setTimeout(() => {
        runtime.pending.delete(invokeId);
        resolve(this.errorResult(
          'TimeoutError',
          `Task timed out after ${timeoutSeconds.toFixed(2)} seconds (worker unresponsive)`,
          Date.now() - startedAt,
        ));
      }, timeoutSeconds * 1000 + IPC_GRACE_MS);

      runtime.pending.set(invokeId, { resolve, timer });
      worker.send({
        type: 'invoke',
        invokeId,
        functionName: fn.name,
        fullName: fn.fullName,
        handler: fn.handler,
        handlerRoot: runtime.handlerRoot,
        serviceRoot: runtime.entry.root,
        timeoutSeconds,
        memorySize: fn.memorySize,
        region: runtime.entry.region || 'us-east-1',
        env: fn.environment,
        event: event ?? {},
      });
    });

    runtime.invocations++;
    runtime.lastInvokedAt = Date.now();
    this.armIdleUnload(runtime);
    if (!result.ok) runtime.errors++;
    runtime.history.push({
      at: startedAt,
      functionName: fn.name,
      ok: result.ok,
      statusCode: result.ok ? httpStatusOf(result.payload) : undefined,
      durationMs: result.durationMs,
      logs: result.logs,
    });
    if (runtime.history.length > HISTORY_LIMIT) {
      runtime.history.splice(0, runtime.history.length - HISTORY_LIMIT);
    }
    return result;
  }

  // Resolve (and, in artifact mode, extract) where this service's handlers
  // live. Returns false and parks the runtime in `error` when that fails, so
  // an unusable registration is reported at registration time even when the
  // fork itself is deferred.
  private resolveHandlerRootInto(runtime: ServiceRuntime): boolean {
    try {
      const { handlerRoot, resolvedMode } = this.resolveHandlerRoot(runtime.entry, runtime.executionMode);
      runtime.handlerRoot = handlerRoot;
      runtime.resolvedMode = resolvedMode;
      runtime.error = undefined;
      return true;
    } catch (err) {
      runtime.status = 'error';
      runtime.error = err instanceof Error ? err.message : String(err);
      console.error(`❌ Lambda runtime for "${runtime.entry.name}": ${runtime.error}`);
      return false;
    }
  }

  private startWorker(runtime: ServiceRuntime): void {
    if (!this.resolveHandlerRootInto(runtime)) return;
    runtime.status = 'starting';
    runtime.error = undefined;

    const workerPath = path.join(__dirname, '../runtime/runtime-worker.js');
    const worker = fork(workerPath, [], {
      cwd: runtime.entry.root,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        // Bundled artifacts with externalized deps still resolve against the
        // service's own node_modules.
        NODE_PATH: [
          path.join(runtime.entry.root, 'node_modules'),
          process.env.NODE_PATH || '',
        ].filter(Boolean).join(path.delimiter),
      },
      execArgv: [],
    });

    // Per-invocation output arrives via IPC (the worker captures it at the
    // stream/fd level and swallows it there); anything still reaching these
    // pipes is unattributable — logger transports on worker threads, child
    // processes, writes after the invocation ended — and surfaces as
    // service-level output instead of vanishing.
    worker.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[${runtime.entry.name}:worker] ${text}`);
    });
    worker.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[${runtime.entry.name}:worker] ${text}`);
    });

    worker.on('message', (msg: { type?: string; invokeId?: string } & Partial<InvokeResult> & { error?: { errorType: string; errorMessage: string; trace?: string[] } }) => {
      if (msg?.type === 'ready') {
        runtime.status = 'online';
        runtime.startedAt = Date.now();
        console.log(`✅ Lambda runtime online for "${runtime.entry.name}" (${runtime.resolvedMode} mode, ${runtime.entry.functions.length} functions)`);
        this.armIdleUnload(runtime);
        this.enforceWarmCap(runtime);
        const queued = runtime.queue;
        runtime.queue = [];
        queued.forEach(release => release());
        return;
      }
      if (msg?.type === 'result' && msg.invokeId) {
        const pending = runtime.pending.get(msg.invokeId);
        if (!pending) return;
        runtime.pending.delete(msg.invokeId);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: Boolean(msg.ok),
          payload: msg.payload,
          errorType: msg.error?.errorType,
          errorMessage: msg.error?.errorMessage,
          trace: msg.error?.trace,
          logs: msg.logs || [],
          durationMs: msg.durationMs || 0,
        });
      }
    });

    worker.on('exit', (code) => {
      if (runtime.worker !== worker) return; // superseded by a restart/stop
      runtime.worker = undefined;
      for (const [, pending] of runtime.pending) {
        clearTimeout(pending.timer);
        pending.resolve(this.errorResult('RuntimeCrashed', `Lambda worker exited with code ${code}`, 0));
      }
      runtime.pending.clear();
      const queued = runtime.queue;
      runtime.queue = [];

      const now = Date.now();
      if (now - runtime.lastRestartAt > RESTART_WINDOW_MS) runtime.restartCount = 0;
      runtime.restartCount++;
      runtime.lastRestartAt = now;

      if (runtime.status !== 'stopped' && runtime.restartCount <= MAX_RESTARTS) {
        console.warn(`⚠️  Lambda worker for "${runtime.entry.name}" exited (code ${code}) — restarting (${runtime.restartCount}/${MAX_RESTARTS})`);
        this.startWorker(runtime);
      } else if (runtime.status !== 'stopped') {
        runtime.status = 'error';
        runtime.error = `Worker crashed ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 1000}s (last exit code ${code})`;
        console.error(`❌ Lambda runtime for "${runtime.entry.name}" gave up: ${runtime.error}`);
      }
      queued.forEach(release => release());
    });

    runtime.worker = worker;
  }

  private resolveHandlerRoot(
    entry: ServiceEntry,
    mode: LambdaExecutionMode,
  ): { handlerRoot: string; resolvedMode: 'artifact' | 'source' } {
    const artifacts = this.findArtifacts(entry);

    if (mode === 'artifact' || (mode === 'auto' && artifacts.length > 0)) {
      if (artifacts.length === 0) {
        throw new Error(`execution mode is "artifact" but no packaged zip was found under ${entry.root}/.serverless — run 'serverless package' first`);
      }
      return { handlerRoot: this.extractArtifacts(entry.name, artifacts), resolvedMode: 'artifact' };
    }
    return { handlerRoot: entry.root, resolvedMode: 'source' };
  }

  private findArtifacts(entry: ServiceEntry): string[] {
    return resolveArtifacts(entry.root, entry.functions.map(fn => fn.artifact));
  }

  // Extract artifact zips into a content-addressed dir under ~/.lss so repeated
  // registrations with unchanged artifacts reuse the same extraction.
  //
  // Scoped per project, like the template cache: the path used to be keyed on
  // the service name alone, so two orchestrators serving different checkouts
  // that both own a service called "api" shared one directory — and the
  // stale-extraction rmSync below would delete the code the other instance's
  // worker was running from.
  private extractArtifacts(serviceName: string, artifacts: string[]): string {
    const stamp = artifacts
      .map(p => {
        const stat = fs.statSync(p);
        return `${p}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('|');
    const hash = crypto.createHash('sha256').update(stamp).digest('hex').slice(0, 12);
    const baseDir = path.join(
      os.homedir(), '.lss', 'orchestrator', 'runtime',
      projectCacheSegment(this.configManager.getProjectRoot()), serviceName,
    );
    const targetDir = path.join(baseDir, hash);

    if (!fs.existsSync(targetDir)) {
      // Drop stale extractions before writing the new one.
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
      for (const artifact of artifacts) {
        new AdmZip(artifact).extractAllTo(targetDir, true);
      }
    }
    return targetDir;
  }

  private errorResult(errorType: string, errorMessage: string, durationMs: number): InvokeResult {
    return { ok: false, errorType, errorMessage, logs: [], durationMs };
  }
}
