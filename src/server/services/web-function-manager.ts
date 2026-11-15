// Execution environments for Lambda Web Functions.
//
// One environment = one child process running the app's own HTTP server, per
// (service, function, revision), started lazily on the first request that
// needs it. This is the local half of AWS's contract (Lambda Developer Guide,
// "Web Function runtimes" and "Execution environment lifecycle"):
//
//   - Lambda chooses the listen address and hands it over in
//     AWS_LAMBDA_HTTP_ENDPOINT; the environment is ready when that port accepts
//     a connection (no health-check path) and must be within 10 s, or
//     initialisation fails (`Application.TimeoutListenError`).
//   - Up to MaxConcurrencyPerEnvironment requests share the process. On AWS
//     more environments would spin up past that; locally ONE process per
//     revision keeps the footprint predictable, and the overflow queues
//     (bounded by `webFunctions.queueFactor` × the cap; past that, 429).
//   - Shutdown: stop routing → let in-flight requests finish (bounded) →
//     SIGTERM → 1 s → SIGKILL. Used for idle unload, hot reload, re-register,
//     unregister and orchestrator shutdown alike.
//   - A process that exits on its own is marked cold and started again by the
//     next request — scale-to-zero and back, as on AWS.
//
// Scale target: 40 services registered, nothing running. A web function costs
// nothing until its URL is hit, and one Node process while it is warm; the
// idle check is ONE shared interval that exists only while something runs.

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { ConfigManager } from './config-manager.js';
import { projectCacheSegment } from './project-scope.js';
import { linkArtifactNodeModules } from './worker-runtime.js';
import type { RegisteredWebFunction, WebRevision } from './web-function-assembler.js';
import {
  buildWebFunctionEnv,
  hasNativeTypeScript,
  pickFreePort,
  typescriptPreloadArgs,
  waitForListening,
} from './web-function-runtime.js';

// The inner listen address. Loopback, always: the app is reached only through
// the endpoint listener in this process, never directly.
const INNER_HOST = '127.0.0.1';
const LOG_LIMIT = 500;
const REQUEST_LIMIT = 50;

export type WebEnvState = 'cold' | 'starting' | 'ready' | 'error';

/**
 * A failure LSS answers on the app's behalf. `errorType` is the documented
 * `lambda-web-error-type` value for that failure ("Troubleshooting Lambda Web
 * Functions" → Web Function error types); undefined where AWS sends none.
 */
export class WebFunctionError extends Error {
  constructor(readonly status: number, readonly errorType: string | undefined, message: string) {
    super(message);
    this.name = 'WebFunctionError';
  }
}

export interface WebServiceInfo {
  name: string;
  root: string;
  region?: string;
}

export interface WebLease {
  host: string;
  port: number;
  revision: WebRevision;
  // True for the request that paid for starting the process.
  coldStart: boolean;
  release: () => void;
}

export interface WebRequestRecord {
  at: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  revisionId?: string;
  requestId: string;
  endpoint: string;
  coldStart: boolean;
  // Set when LSS itself answered (`lambda-web-error-type`, or "Forbidden").
  errorType?: string;
}

export interface WebLogLine {
  at: number;
  stream: 'stdout' | 'stderr' | 'lss';
  revisionId: string;
  text: string;
}

export interface WebRevisionStatus {
  revisionId: string;
  state: WebEnvState;
  pid?: number;
  innerPort?: number;
  inFlight: number;
  queued: number;
  startedAt?: number;
  readyAt?: number;
  coldStartMs?: number;
  error?: string;
  errorType?: string;
  lastExitCode?: number | null;
}

interface Waiter {
  // true: a slot was handed over; false: the environment went away — retry.
  resolve: (granted: boolean) => void;
}

interface WebEnvironment {
  service: WebServiceInfo;
  fnName: string;
  revision: WebRevision;
  state: WebEnvState;
  process?: ChildProcess;
  innerPort?: number;
  startedAt?: number;
  readyAt?: number;
  starting?: Promise<void>;
  error?: string;
  errorType?: string;
  lastExitCode?: number | null;
  inFlight: number;
  queue: Waiter[];
  lastUsedAt: number;
  // Taken out of routing (shutdown in progress, or replaced).
  retired: boolean;
  drained?: () => void;
}

interface FunctionEntry {
  service: WebServiceInfo;
  fn: RegisteredWebFunction;
  logs: WebLogLine[];
  requests: WebRequestRecord[];
  totalRequests: number;
  totalErrors: number;
}

export interface WebFunctionManagerOptions {
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  drainTimeoutMs?: number;
  killGraceMs?: number;
  // Where artifact zips are extracted (default ~/.lss/orchestrator/runtime).
  runtimeDir?: string;
  // Where LSS's own TypeScript loaders resolve from (index.ts passes its own
  // file; anything inside LSS's install works).
  lssResolveBase?: string;
  // Native type stripping available (default: this Node's answer).
  nativeTypeScript?: boolean;
  // Logged lines are also echoed to the orchestrator log (default true).
  echo?: boolean;
}

export class WebFunctionManager {
  private static instance: WebFunctionManager;
  private functions = new Map<string, FunctionEntry>();
  private environments = new Map<string, WebEnvironment>();
  private retiring = new Set<Promise<void>>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly options: Required<Omit<WebFunctionManagerOptions, 'runtimeDir'>> & { runtimeDir?: string };

  constructor(options: WebFunctionManagerOptions = {}) {
    this.options = {
      // AWS: "Your server must begin listening within 10 seconds of startup".
      readinessTimeoutMs: options.readinessTimeoutMs ?? 10_000,
      readinessPollMs: options.readinessPollMs ?? 50,
      drainTimeoutMs: options.drainTimeoutMs ?? 5_000,
      // AWS: "After SIGTERM, the process has up to 1 second to finish cleanup".
      killGraceMs: options.killGraceMs ?? 1_000,
      runtimeDir: options.runtimeDir,
      lssResolveBase: options.lssResolveBase ?? process.argv[1] ?? process.cwd(),
      nativeTypeScript: options.nativeTypeScript ?? hasNativeTypeScript(),
      echo: options.echo ?? true,
    };
  }

  static getInstance(): WebFunctionManager {
    if (!WebFunctionManager.instance) {
      WebFunctionManager.instance = new WebFunctionManager();
    }
    return WebFunctionManager.instance;
  }

  /** Where LSS's own TypeScript loaders resolve from — set once at boot. */
  setLssResolveBase(file: string): void {
    this.options.lssResolveBase = file;
  }

  // -------------------------------------------------------------------------
  // Registration lifecycle
  // -------------------------------------------------------------------------

  /**
   * Bring a service's web functions in line with its (re-)registration: every
   * running environment goes through the shutdown sequence (new code or config
   * is picked up by the next request), definitions are replaced, and the
   * recent requests / logs of functions that still exist are kept.
   */
  async syncService(service: WebServiceInfo, functions: RegisteredWebFunction[]): Promise<void> {
    await this.retireWhere(env => env.service.name === service.name, 're-registered');
    const kept = new Map<string, FunctionEntry>();
    for (const [key, entry] of this.functions) {
      if (entry.service.name === service.name) {
        kept.set(entry.fn.name, entry);
        this.functions.delete(key);
      }
    }
    for (const fn of functions) {
      const previous = kept.get(fn.name);
      this.functions.set(functionKey(service.name, fn.name), {
        service,
        fn,
        logs: previous?.logs ?? [],
        requests: previous?.requests ?? [],
        totalRequests: previous?.totalRequests ?? 0,
        totalErrors: previous?.totalErrors ?? 0,
      });
    }
  }

  async removeService(serviceName: string): Promise<void> {
    await this.retireWhere(env => env.service.name === serviceName, 'unregistered');
    for (const [key, entry] of this.functions) {
      if (entry.service.name === serviceName) this.functions.delete(key);
    }
  }

  /** Hot reload: restart lazily, keeping the definitions. */
  async reloadService(serviceName: string): Promise<void> {
    await this.retireWhere(env => env.service.name === serviceName, 'source changed');
  }

  /** Stop one function's environments; the next request starts them again. */
  async restartFunction(serviceName: string, fnName: string): Promise<boolean> {
    if (!this.functions.has(functionKey(serviceName, fnName))) return false;
    await this.retireWhere(env => env.service.name === serviceName && env.fnName === fnName, 'restart requested');
    return true;
  }

  async stopAll(): Promise<void> {
    await this.retireWhere(() => true, 'orchestrator shutting down');
    await Promise.all([...this.retiring]);
    this.stopSweep();
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  listFunctions(): Array<{ service: WebServiceInfo; fn: RegisteredWebFunction }> {
    return [...this.functions.values()].map(entry => ({ service: entry.service, fn: entry.fn }));
  }

  getFunction(serviceName: string, fnName: string): RegisteredWebFunction | undefined {
    return this.functions.get(functionKey(serviceName, fnName))?.fn;
  }

  revisionStatus(serviceName: string, fnName: string, revisionId: string): WebRevisionStatus {
    const env = this.environments.get(environmentKey(serviceName, fnName, revisionId));
    if (!env) return { revisionId, state: 'cold', inFlight: 0, queued: 0 };
    return {
      revisionId,
      state: env.state,
      pid: env.process?.pid,
      innerPort: env.innerPort,
      inFlight: env.inFlight,
      queued: env.queue.length,
      startedAt: env.startedAt,
      readyAt: env.readyAt,
      coldStartMs: env.readyAt !== undefined && env.startedAt !== undefined ? env.readyAt - env.startedAt : undefined,
      error: env.error,
      errorType: env.errorType,
      lastExitCode: env.lastExitCode,
    };
  }

  /** Aggregate state of a function: error > ready > starting > cold. */
  functionState(serviceName: string, fnName: string): WebEnvState {
    const fn = this.getFunction(serviceName, fnName);
    const states = (fn?.revisions ?? []).map(rev => this.revisionStatus(serviceName, fnName, rev.revisionId).state);
    for (const state of ['error', 'ready', 'starting'] as const) {
      if (states.includes(state)) return state;
    }
    return 'cold';
  }

  getLogs(serviceName: string, fnName: string): WebLogLine[] {
    return [...(this.functions.get(functionKey(serviceName, fnName))?.logs ?? [])];
  }

  getRequests(serviceName: string, fnName: string): WebRequestRecord[] {
    return [...(this.functions.get(functionKey(serviceName, fnName))?.requests ?? [])];
  }

  getTotals(serviceName: string, fnName: string): { requests: number; errors: number; lastRequestAt?: number } {
    const entry = this.functions.get(functionKey(serviceName, fnName));
    return {
      requests: entry?.totalRequests ?? 0,
      errors: entry?.totalErrors ?? 0,
      lastRequestAt: entry?.requests[entry.requests.length - 1]?.at,
    };
  }

  recordRequest(serviceName: string, fnName: string, record: WebRequestRecord): void {
    const entry = this.functions.get(functionKey(serviceName, fnName));
    if (!entry) return;
    entry.totalRequests++;
    if (record.status >= 500) entry.totalErrors++;
    entry.requests.push(record);
    if (entry.requests.length > REQUEST_LIMIT) entry.requests.splice(0, entry.requests.length - REQUEST_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Request path
  // -------------------------------------------------------------------------

  /**
   * A slot in a ready environment of `revisionId`, starting the process if
   * needed. Requests that arrive while it starts wait on the same start (the
   * cold start is counted once, on the request that triggered it). Throws a
   * WebFunctionError when the environment cannot serve.
   */
  async acquire(serviceName: string, fnName: string, revisionId: string): Promise<WebLease> {
    let coldStart = false;
    // A handful of attempts covers "the environment was replaced (reload) or
    // died while this request waited" without ever spinning.
    for (let attempt = 0; attempt < 3; attempt++) {
      const env = this.environmentFor(serviceName, fnName, revisionId);
      if (env.state === 'cold' || env.state === 'error') {
        coldStart = true;
        await this.start(env);
      } else if (env.state === 'starting') {
        await env.starting;
      }
      if (env.retired) continue;

      if (env.inFlight < env.revision.maxConcurrency) {
        env.inFlight++;
      } else {
        const capacity = env.revision.maxConcurrency * ConfigManager.getInstance().getWebFunctionQueueFactor();
        if (env.queue.length >= capacity) {
          throw new WebFunctionError(
            429,
            'Platform.EndpointMaxEnvThrottle',
            `${env.revision.maxConcurrency} request(s) in flight (MaxConcurrencyPerEnvironment) and ${env.queue.length} queued — ` +
              'locally one environment serves a revision, and its queue is full (webFunctions.queueFactor).',
          );
        }
        const granted = await new Promise<boolean>(resolve => env.queue.push({ resolve }));
        if (!granted) continue;
      }
      if (env.retired || env.state !== 'ready') {
        this.releaseSlot(env);
        continue;
      }
      let released = false;
      return {
        host: INNER_HOST,
        port: env.innerPort as number,
        revision: env.revision,
        coldStart,
        release: () => {
          if (released) return;
          released = true;
          this.releaseSlot(env);
        },
      };
    }
    throw new WebFunctionError(503, 'Runtime.Unreachable', `the execution environment of ${fnName} kept going away while this request waited`);
  }

  private environmentFor(serviceName: string, fnName: string, revisionId: string): WebEnvironment {
    const key = environmentKey(serviceName, fnName, revisionId);
    const existing = this.environments.get(key);
    if (existing) return existing;
    const entry = this.functions.get(functionKey(serviceName, fnName));
    const revision = entry?.fn.revisions.find(rev => rev.revisionId === revisionId);
    if (!entry || !revision) {
      throw new WebFunctionError(404, 'Platform.InvalidEndpoint', `web function ${serviceName}/${fnName} revision ${revisionId} is not registered`);
    }
    const env: WebEnvironment = {
      service: entry.service,
      fnName,
      revision,
      state: 'cold',
      inFlight: 0,
      queue: [],
      lastUsedAt: Date.now(),
      retired: false,
    };
    this.environments.set(key, env);
    return env;
  }

  private releaseSlot(env: WebEnvironment): void {
    env.lastUsedAt = Date.now();
    const next = env.retired ? undefined : env.queue.shift();
    if (next) {
      // The slot moves to the next waiter; it re-checks the state itself.
      next.resolve(true);
      return;
    }
    env.inFlight--;
    if (env.inFlight === 0) env.drained?.();
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  private start(env: WebEnvironment): Promise<void> {
    env.state = 'starting';
    env.startedAt = Date.now();
    env.readyAt = undefined;
    env.error = undefined;
    env.errorType = undefined;
    const starting = this.boot(env).finally(() => {
      env.starting = undefined;
    });
    env.starting = starting;
    return starting;
  }

  private async boot(env: WebEnvironment): Promise<void> {
    const { revision, service } = env;
    const config = ConfigManager.getInstance();
    let child: ChildProcess | undefined;
    try {
      const root = this.codeRoot(env);
      const entry = path.resolve(root, revision.code.entry);
      if (!fs.existsSync(entry)) {
        throw new WebFunctionError(502, 'Runtime.ImportCodeError', `entry file ${entry} does not exist`);
      }
      let preload: string[];
      try {
        preload = typescriptPreloadArgs(entry, [path.join(service.root, 'noop.js'), this.options.lssResolveBase], this.options.nativeTypeScript);
      } catch (err) {
        throw new WebFunctionError(502, 'Runtime.ImportCodeError', (err as Error).message);
      }
      const port = await pickFreePort(INNER_HOST);
      env.innerPort = port;
      const overrides = config.getWorkerOverridesForService(service.root);
      const spawned = spawn(process.execPath, [...overrides.execArgv, ...preload, entry], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildWebFunctionEnv({
          parentEnv: process.env,
          region: service.region || config.getRegion(),
          engineEndpoint: config.getEngineEndpoint(),
          serviceRoot: service.root,
          revisionEnv: revision.environment,
          serviceEnv: overrides.env,
          functionEnv: overrides.functions[env.fnName]?.env,
          host: INNER_HOST,
          port,
          entry: revision.code.entry,
        }),
      });
      child = spawned;
      env.process = spawned;
      this.pipeOutput(env, spawned);
      spawned.on('exit', code => this.onExit(env, spawned, code));

      const outcome = await waitForListening({
        host: INNER_HOST,
        port,
        timeoutMs: this.options.readinessTimeoutMs,
        pollMs: this.options.readinessPollMs,
        exited: () => spawned.exitCode !== null || spawned.signalCode !== null,
      });
      if (outcome === 'exited') {
        throw new WebFunctionError(
          502,
          'Application.InitCodeError',
          `the server process exited (code ${spawned.exitCode ?? spawned.signalCode}) before listening on ${INNER_HOST}:${port} — see the logs`,
        );
      }
      if (outcome === 'timeout') {
        throw new WebFunctionError(
          502,
          'Application.TimeoutListenError',
          `the server did not start listening on AWS_LAMBDA_HTTP_ENDPOINT (${INNER_HOST}:${port}) within ` +
            `${this.options.readinessTimeoutMs / 1000} s — Lambda fails initialisation the same way`,
        );
      }
      env.state = 'ready';
      env.readyAt = Date.now();
      env.lastUsedAt = env.readyAt;
      this.log(env, 'lss', `listening on ${INNER_HOST}:${port} (pid ${spawned.pid}, cold start ${env.readyAt - (env.startedAt as number)} ms, ${revision.code.source} code)`);
      this.ensureSweep();
    } catch (err) {
      const failure = err instanceof WebFunctionError
        ? err
        : new WebFunctionError(502, 'Runtime.InitTimeout', `could not start the execution environment: ${(err as Error).message}`);
      env.state = 'error';
      env.error = failure.message;
      env.errorType = failure.errorType;
      this.log(env, 'lss', `initialisation failed (${failure.errorType}): ${failure.message}`);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      throw failure;
    }
  }

  // Artifact mode: extract the zip into a content-addressed directory, exactly
  // like the event-function runtime does — but under its own `<service>@web`
  // directory, because the event runtime clears `<service>/` whenever its own
  // artifacts change.
  private codeRoot(env: WebEnvironment): string {
    const code = env.revision.code;
    if (code.source === 'missing') {
      throw new WebFunctionError(502, 'Runtime.ImportCodeError', code.reason);
    }
    if (code.source !== 'artifact' || !code.artifact) return code.root;
    const stat = fs.statSync(code.artifact);
    const hash = crypto.createHash('sha256').update(`${code.artifact}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 12);
    const baseDir = path.join(
      this.options.runtimeDir ?? path.join(os.homedir(), '.lss', 'orchestrator', 'runtime'),
      projectCacheSegment(ConfigManager.getInstance().getProjectRoot()),
      `${env.service.name}@web`,
    );
    const target = path.join(baseDir, hash);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      new AdmZip(code.artifact).extractAllTo(target, true);
    }
    linkArtifactNodeModules(target, env.service.root);
    return target;
  }

  private pipeOutput(env: WebEnvironment, child: ChildProcess): void {
    const forward = (stream: 'stdout' | 'stderr') => {
      let partial = '';
      return (chunk: Buffer) => {
        const lines = (partial + chunk.toString('utf8')).split('\n');
        partial = lines.pop() as string;
        for (const line of lines) {
          if (line.trim()) this.log(env, stream, line);
        }
      };
    };
    child.stdout?.on('data', forward('stdout'));
    child.stderr?.on('data', forward('stderr'));
  }

  // Logs are per PROCESS, keyed `web:<service>/<function>`: with many requests
  // sharing one event loop, which request a line belongs to is not knowable,
  // so the recent-request list sits next to them instead.
  private log(env: WebEnvironment, stream: WebLogLine['stream'], text: string): void {
    const entry = this.functions.get(functionKey(env.service.name, env.fnName));
    if (entry) {
      entry.logs.push({ at: Date.now(), stream, revisionId: env.revision.revisionId, text });
      if (entry.logs.length > LOG_LIMIT) entry.logs.splice(0, entry.logs.length - LOG_LIMIT);
    }
    if (!this.options.echo) return;
    const line = `[web:${env.service.name}/${env.fnName}] ${text}`;
    if (stream === 'stderr') console.error(line);
    else console.log(line);
  }

  private onExit(env: WebEnvironment, child: ChildProcess, code: number | null): void {
    if (env.process !== child) return;
    env.process = undefined;
    env.lastExitCode = code;
    // A process that dies while serving is scaled back to zero; the next
    // request starts a fresh one. During boot, the readiness loop reports it.
    if (env.state === 'ready' && !env.retired) {
      env.state = 'cold';
      this.log(env, 'lss', `exited unexpectedly (code ${code}) — the next request starts a new environment`);
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  private async retireWhere(match: (env: WebEnvironment) => boolean, reason: string): Promise<void> {
    const targets = [...this.environments.entries()].filter(([, env]) => match(env));
    await Promise.all(targets.map(([key, env]) => {
      this.environments.delete(key);
      return this.retire(env, reason);
    }));
  }

  /**
   * AWS's shutdown sequence: stop routing (the environment leaves the map, so
   * new requests get a fresh one, and its queue is sent there too), let
   * in-flight requests finish for up to `drainTimeoutMs`, SIGTERM, and SIGKILL
   * whatever is still alive `killGraceMs` later.
   */
  private retire(env: WebEnvironment, reason: string): Promise<void> {
    env.retired = true;
    const waiters = env.queue;
    env.queue = [];
    for (const waiter of waiters) waiter.resolve(false);
    const done = (async () => {
      if (env.starting) await env.starting.catch(() => undefined);
      if (env.inFlight > 0) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.options.drainTimeoutMs);
          env.drained = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      const child = env.process;
      if (child) {
        this.log(env, 'lss', `stopping (${reason})`);
        await terminate(child, this.options.killGraceMs);
      }
      env.state = 'cold';
      this.stopSweepIfIdle();
    })();
    this.retiring.add(done);
    return done.finally(() => this.retiring.delete(done));
  }

  // One interval for every environment, alive only while something runs.
  private ensureSweep(): void {
    const idleMs = ConfigManager.getInstance().getLambdaIdleTimeoutMs();
    if (this.sweepTimer || idleMs <= 0) return;
    const every = Math.max(50, Math.min(5_000, Math.floor(idleMs / 4)));
    this.sweepTimer = setInterval(() => this.sweep(idleMs), every);
    this.sweepTimer.unref();
  }

  private sweep(idleMs: number): void {
    const now = Date.now();
    void this.retireWhere(
      env => env.state === 'ready' && env.inFlight === 0 && env.queue.length === 0 && now - env.lastUsedAt >= idleMs,
      `idle for ${idleMs} ms`,
    );
  }

  private stopSweepIfIdle(): void {
    if ([...this.environments.values()].some(env => env.process)) return;
    this.stopSweep();
  }

  private stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}

function functionKey(service: string, fn: string): string {
  return `${service}\u0000${fn}`;
}

function environmentKey(service: string, fn: string, revisionId: string): string {
  return `${service}\u0000${fn}\u0000${revisionId}`;
}

/** SIGTERM, then SIGKILL after `graceMs` if the process is still alive. */
export function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
