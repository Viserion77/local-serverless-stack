// Programmatic orchestrator lifecycle. start/stop/status/logs are process-spawn
// + PID/stateDir file work — NOT HTTP — so instead of duplicating the CLI's
// battle-tested logic we shell out to `bin/cli.js`. `waitUntilReady` then polls
// GET /api/health, because `lss start` returns before LocalStack is actually up.

import { spawn } from 'child_process';
import path from 'path';
import type { HealthApi } from './namespaces/health';

export interface StartOptions {
  /** Overrides the client's configPath for this invocation (threaded as --config). */
  configPath?: string;
  enableDynamoProxy?: boolean;
  external?: boolean;
  pro?: boolean;
  localstackToken?: string;
}
export interface StartResult {
  alreadyRunning: boolean;
  raw: string;
}
export interface StopResult {
  wasRunning: boolean;
  raw: string;
}
export interface StatusResult {
  running: boolean;
  raw: string;
}
export interface LogsResult {
  raw: string;
}
export interface WaitUntilReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface LifecycleApi {
  start(opts?: StartOptions): Promise<StartResult>;
  stop(): Promise<StopResult>;
  status(): Promise<StatusResult>;
  logs(): Promise<LogsResult>;
  /** Poll GET /api/health until LocalStack reports ready, or reject after timeoutMs. */
  waitUntilReady(opts?: WaitUntilReadyOptions): Promise<void>;
}

export interface LifecycleDeps {
  health: HealthApi;
  cwd: string;
  configPath?: string;
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// `bin/cli.js` always sits two levels above the built client (dist/client/ or,
// in tests, src/client/). LSS_CLI_PATH overrides it (e.g. to a fake CLI in tests
// or a pinned install). No require.resolve needed — the relative layout holds
// both in-repo and when installed under node_modules.
export function resolveCliPath(): string {
  return process.env.LSS_CLI_PATH || path.join(__dirname, '..', '..', 'bin', 'cli.js');
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveCliPath(), ...args], { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    (child.stdout as NodeJS.ReadableStream).on('data', (d) => (stdout += d.toString()));
    (child.stderr as NodeJS.ReadableStream).on('data', (d) => (stderr += d.toString()));
    /* istanbul ignore next -- defensive: process.execPath is always spawnable */
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cliError(verb: string, r: CliResult): Error {
  return new Error(`lss ${verb} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
}

export class Lifecycle implements LifecycleApi {
  constructor(private readonly deps: LifecycleDeps) {}

  private configArgs(override?: string): string[] {
    const cp = override ?? this.deps.configPath;
    return cp ? ['--config', path.resolve(this.deps.cwd, cp)] : [];
  }

  async start(opts: StartOptions = {}): Promise<StartResult> {
    const args = ['start', ...this.configArgs(opts.configPath)];
    if (opts.enableDynamoProxy) args.push('--enable-dynamo-proxy');
    if (opts.external) args.push('--external');
    if (opts.pro) args.push('--pro');
    if (opts.localstackToken) args.push('--localstack-token', opts.localstackToken);

    const r = await runCli(args, this.deps.cwd);
    if (r.code !== 0) throw cliError('start', r);
    return { alreadyRunning: /already running/i.test(r.stdout), raw: r.stdout };
  }

  async stop(): Promise<StopResult> {
    const r = await runCli(['stop', ...this.configArgs()], this.deps.cwd);
    if (r.code !== 0) throw cliError('stop', r);
    return { wasRunning: !/not running/i.test(r.stdout), raw: r.stdout };
  }

  async status(): Promise<StatusResult> {
    const r = await runCli(['status', ...this.configArgs()], this.deps.cwd);
    const running = /running/i.test(r.stdout) && !/not running/i.test(r.stdout);
    return { running, raw: r.stdout };
  }

  async logs(): Promise<LogsResult> {
    const r = await runCli(['logs', ...this.configArgs()], this.deps.cwd);
    return { raw: r.stdout };
  }

  async waitUntilReady(opts: WaitUntilReadyOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 120000;
    const intervalMs = opts.intervalMs ?? 1000;
    const startedAt = Date.now();
    for (;;) {
      try {
        const health = await this.deps.health.get();
        if (health.localstack === true) return;
      } catch {
        // Orchestrator not accepting connections yet — keep polling.
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`orchestrator not ready after ${timeoutMs}ms`);
      }
      await delay(intervalMs);
    }
  }
}
