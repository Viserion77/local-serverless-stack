// Pure-ish helpers behind a Lambda Web Function's execution environment: the
// environment a server process starts with, the TypeScript preload flags, the
// readiness probe and the free-port pick. Split out of web-function-manager.ts
// so each rule is testable on its own, the way worker-runtime.ts serves the
// event-function workers.

import net from 'net';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import { buildWorkerEnv, resolveInvocationEnv } from './worker-runtime.js';
import { RESERVED_WEB_ENV } from './web-function-assembler.js';

// What AWS documents for an execution environment ("Web Function runtimes" →
// Memory and the Node.js heap: "Each execution environment has 2 GB of
// memory"), exposed the way Lambda exposes it.
export const WEB_ENVIRONMENT_MEMORY_MB = 2048;

export interface WebEnvOptions {
  parentEnv: NodeJS.ProcessEnv;
  region: string;
  engineEndpoint: string;
  serviceRoot: string;
  // The revision's EnvironmentVariables (resolved).
  revisionEnv: Record<string, string>;
  // `serviceRuntime.<svc>.env` and `.functions.<fn>.env` from lss.config.json.
  serviceEnv?: Record<string, string>;
  functionEnv?: Record<string, string>;
  // The inner address the server must listen on.
  host: string;
  port: number;
  // Entry file relative to the code root (AWS_LAMBDA_NODEJS_ENTRYPOINT).
  entry: string;
}

/**
 * The environment a web function's server process starts with, lowest first:
 *
 *   1. the same AWS plumbing every LSS worker gets (buildWorkerEnv: SDK
 *      endpoint pointed at the engine, dummy credentials, the service region,
 *      inherited credentials and per-service endpoint overrides dropped);
 *   2. the revision's EnvironmentVariables — minus the names Lambda reserves,
 *      which AWS would have refused at deploy time;
 *   3. lss.config.json `serviceRuntime` env, service then function level, the
 *      operator's deliberate overrides (as for event functions);
 *   4. what Lambda itself sets for a web function: `AWS_LAMBDA_HTTP_ENDPOINT`
 *      (the address to listen on — Lambda chooses it, nobody overrides it),
 *      `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, and `AWS_LAMBDA_NODEJS_ENTRYPOINT`
 *      when the template did not set it; plus `PORT` / `HOSTNAME` mirroring the
 *      inner address, which is what the Serverless Framework sets so that apps
 *      written for `serverless dev` (and Next.js standalone) work unchanged.
 *
 * Variables AWS lists but LSS cannot honestly provide
 * (`AWS_LAMBDA_METADATA_API` / `_TOKEN` — there is no metadata endpoint
 * locally) are left unset rather than pointed at nothing.
 */
export function buildWebFunctionEnv(options: WebEnvOptions): NodeJS.ProcessEnv {
  const base = buildWorkerEnv(options.parentEnv, {
    region: options.region,
    engineEndpoint: options.engineEndpoint,
    serviceRoot: options.serviceRoot,
  });
  const revisionEnv = Object.fromEntries(
    Object.entries(options.revisionEnv).filter(([key]) => !RESERVED_WEB_ENV.has(key)),
  );
  const env: NodeJS.ProcessEnv = {
    ...base,
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(WEB_ENVIRONMENT_MEMORY_MB),
    AWS_LAMBDA_NODEJS_ENTRYPOINT: options.entry,
    ...resolveInvocationEnv(revisionEnv, options.serviceEnv, options.functionEnv),
  };
  env.AWS_LAMBDA_HTTP_ENDPOINT = `${options.host}:${options.port}`;
  env.PORT = String(options.port);
  env.HOSTNAME = options.host;
  return env;
}

// The TypeScript loaders tried for a `.ts` entry, in the order
// runtime/runtime-worker.ts tries them for event-function handlers (after the
// native type stripping it tries first) — one loader strategy for both
// function types. As preloads, because a web function's server is its own
// process rather than a module required into a worker.
const TS_PRELOADS: ReadonlyArray<{ id: string; flag: '--require' | '--import' }> = [
  { id: 'esbuild-register', flag: '--require' },
  // tsx's ESM loader also hooks CommonJS, so it covers both module systems.
  { id: 'tsx', flag: '--import' },
  { id: 'ts-node/register/transpile-only', flag: '--require' },
];

export const TS_ENTRY = /\.(?:ts|cts|mts)$/;

/**
 * Node flags that make `entry` loadable. Plain JavaScript needs none; neither
 * does TypeScript on a Node with native type stripping. Otherwise the first
 * loader found — resolved from the service's own node_modules first (its
 * version wins), then from LSS's — is preloaded. Throws when there is none.
 */
export function typescriptPreloadArgs(
  entry: string,
  resolveFrom: string[],
  nativeTypeScript: boolean,
): string[] {
  if (!TS_ENTRY.test(entry) || nativeTypeScript) return [];
  for (const base of resolveFrom) {
    const resolver = createRequire(path.resolve(base));
    for (const candidate of TS_PRELOADS) {
      try {
        const resolved = resolver.resolve(candidate.id);
        return [candidate.flag, candidate.flag === '--import' ? pathToFileURL(resolved).href : resolved];
      } catch {
        // Try the next loader / location.
      }
    }
  }
  throw new Error(
    `TypeScript entry ${entry} found but no TS loader is available. Install "esbuild-register" (or tsx/ts-node) ` +
      'in the service, or point AWS_LAMBDA_NODEJS_ENTRYPOINT at compiled JavaScript.',
  );
}

/** True when this Node strips TypeScript natively (Node >= 23.6, or the flag). */
export function hasNativeTypeScript(features: object = process.features): boolean {
  return Boolean((features as { typescript?: unknown }).typescript);
}

/** A port nothing listens on right now (the OS picks it), on `host`. */
export function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** One TCP connect attempt: does something accept connections there? */
export function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export type ReadinessOutcome = 'ready' | 'exited' | 'timeout';

/**
 * Lambda's readiness rule: the environment is ready when the port accepts a
 * connection — there is no health-check path. Polls every `pollMs` until it
 * does, the process is gone (`exited()`), or `timeoutMs` has passed.
 */
export async function waitForListening(options: {
  host: string;
  port: number;
  timeoutMs: number;
  pollMs: number;
  exited: () => boolean;
}): Promise<ReadinessOutcome> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (options.exited()) return 'exited';
    if (await canConnect(options.host, options.port)) return 'ready';
    if (Date.now() >= deadline) return 'timeout';
    await new Promise(resolve => setTimeout(resolve, options.pollMs));
  }
}
