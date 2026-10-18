// Pure helpers behind the Lambda runtime worker's process setup: the env a
// forked worker starts with, the per-invocation env merge, the node_modules
// links that let an extracted artifact resolve bare ESM specifiers, the
// execArgv fence for the config API, the `runtime` vs Node major check, and
// the paths the source watcher must never react to.
//
// Split out of LambdaRuntimeManager / SourceWatcher (both integration-only:
// they fork processes and drive fs.watch) so every rule here is unit-tested.

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

// Credential and profile variables the ORCHESTRATOR may carry from the
// operator's shell. A forked worker must never inherit them: a handler with
// the developer's real session token, pointed at an endpoint it did not
// expect, is how local code ends up writing to a real account. The AWS SDK
// credential chain reads env credentials first, then the profile — so the
// session token (which would be paired with the dummy key below and rejected,
// or worse, accepted) and the profile selectors all go.
const INHERITED_AWS_VARS_TO_DROP = [
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
];

export interface WorkerEnvOptions {
  // The service's region — what AWS_REGION is inside a real Lambda.
  region: string;
  // The self engine's AWS endpoint (ConfigManager.getEngineEndpoint()).
  engineEndpoint: string;
  serviceRoot: string;
  // `serviceRuntime.<svc>.env` — applied at fork, so it also reaches module
  // init code that runs before the first invocation's env is applied.
  serviceEnv?: Record<string, string>;
}

/**
 * The environment a forked runtime worker starts with.
 *
 * Every SDK client a handler creates without an explicit endpoint must land on
 * the engine, not on AWS: `AWS_ENDPOINT_URL` is the variable AWS SDK v3 (and
 * the CLI, boto3, SDK v2 >= 2.1580) reads for that — `AWS_ENDPOINT`, which
 * many templates set, is only a convention that code has to read by hand.
 * Credentials are the engine's dummy pair and the region is the service's.
 *
 * What the orchestrator inherited is the BASE, not the authority: a
 * service-specific `AWS_ENDPOINT_URL_<SERVICE>` exported in the operator's
 * shell would outrank the generic endpoint inside the SDK, so those are dropped
 * too. A template or override that sets any of these explicitly still wins —
 * `serviceEnv` here at fork, function env per invocation in the worker.
 */
export function buildWorkerEnv(
  parentEnv: NodeJS.ProcessEnv,
  options: WorkerEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  for (const key of INHERITED_AWS_VARS_TO_DROP) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('AWS_ENDPOINT_URL_')) delete env[key];
  }
  Object.assign(env, {
    AWS_ENDPOINT_URL: options.engineEndpoint,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_REGION: options.region,
    AWS_DEFAULT_REGION: options.region,
    // Bundled artifacts with externalized deps still resolve against the
    // service's own node_modules — for CommonJS. ESM ignores NODE_PATH; see
    // linkArtifactNodeModules() for that half.
    NODE_PATH: [path.join(options.serviceRoot, 'node_modules'), parentEnv.NODE_PATH || '']
      .filter(Boolean)
      .join(path.delimiter),
  });
  return { ...env, ...(options.serviceEnv ?? {}) };
}

/**
 * The env one invocation runs with. Precedence, lowest first: the template's
 * function environment (provider + function level, already merged by the
 * packager), then `serviceRuntime.<svc>.env`, then
 * `serviceRuntime.<svc>.functions.<fn>.env` — the override closest to the
 * function wins, the way a function-level `environment:` beats the provider's.
 */
export function resolveInvocationEnv(
  templateEnv: Record<string, string> | undefined,
  serviceEnv: Record<string, string> | undefined,
  functionEnv: Record<string, string> | undefined,
): Record<string, string> {
  return { ...(templateEnv ?? {}), ...(serviceEnv ?? {}), ...(functionEnv ?? {}) };
}

// ---------------------------------------------------------------------------
// Artifact node_modules
// ---------------------------------------------------------------------------

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `node_modules` directory the service would resolve through, nearest
 * first — its own, then each ancestor's (a workspace monorepo hoists most
 * dependencies to the repo root, so the service's own dir is often partial or
 * absent).
 */
export function ancestorNodeModules(serviceRoot: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(serviceRoot);
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (isDirectory(candidate)) found.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/**
 * Make bare specifiers resolve from an artifact extracted OUTSIDE the service.
 *
 * The extraction lives under ~/.lss, so a bundle that keeps a package external
 * (`import pg from 'pg'`) has no node_modules anywhere above it. CommonJS gets
 * by on NODE_PATH; ESM does not — the ESM resolver ignores NODE_PATH entirely
 * and only walks the importing file's parent directories. So the walk is given
 * something to find: `<extractDir>/node_modules` links to the nearest
 * node_modules of the service, and `<extractDir>/../node_modules` (the
 * per-service directory that holds the content-addressed extractions) to the
 * next one up — which covers the service's own dependencies plus a monorepo's
 * hoisted root. Node resolves a package to its realpath, so the package's own
 * imports then resolve from inside the service tree as usual.
 *
 * An artifact that ships its own node_modules (non-bundled packaging) is
 * self-contained and left untouched. A link already pointing at the right
 * place is kept; one pointing elsewhere (the service moved) is replaced.
 * Linking is best effort: a filesystem that refuses links (some Windows setups)
 * costs only the ESM externals, so it warns instead of failing the boot.
 *
 * Returns the links that now exist, as `[link, target]` pairs.
 */
export function linkArtifactNodeModules(extractDir: string, serviceRoot: string): Array<[string, string]> {
  const own = path.join(extractDir, 'node_modules');
  const ownStat = lstatOrNull(own);
  if (ownStat && !ownStat.isSymbolicLink()) return [];

  const targets = ancestorNodeModules(serviceRoot);
  const slots = [extractDir, path.dirname(extractDir)];
  const links: Array<[string, string]> = [];
  slots.forEach((slot, index) => {
    const target = targets[index];
    if (!target) return;
    const link = path.join(slot, 'node_modules');
    try {
      const existing = lstatOrNull(link);
      if (existing) {
        // Anything that is not one of our links is someone else's directory.
        if (!existing.isSymbolicLink()) return;
        if (fs.readlinkSync(link) === target) {
          links.push([link, target]);
          return;
        }
        fs.unlinkSync(link);
      }
      // 'junction' makes the call succeed on Windows without the symlink
      // privilege; it is ignored everywhere else.
      fs.symlinkSync(target, link, 'junction');
      links.push([link, target]);
    } catch (err) {
      console.warn(
        `⚠️  Could not link ${link} -> ${target}: ${err instanceof Error ? err.message : String(err)} ` +
          '(ESM imports of external packages from the artifact will not resolve)',
      );
    }
  });
  return links;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// execArgv fence
// ---------------------------------------------------------------------------

// Node flags a worker may be forked with when the value arrives through
// PUT /api/config. That endpoint is unauthenticated and execArgv reaches
// fork() verbatim, so an open list would be code execution one flag away
// (`--import data:…`, `--require /tmp/x.js`, `--loader`, `--eval`). An
// allowlist rather than a blocklist, because node grows new code-loading flags
// and a blocklist silently goes stale. The set is what a developer actually
// reaches for: a debugger, source maps, heap/stack sizing, diagnostics.
//
// Like every other fence in config-manager.ts this guards the API only — a
// hand-edited lss.config.json is the operator's own shell and is read as is.
const EXEC_ARGV_BARE_FLAGS: ReadonlySet<string> = new Set([
  '--enable-source-maps',
  '--trace-warnings',
  '--trace-deprecation',
  '--trace-uncaught',
  '--no-warnings',
  '--no-deprecation',
  '--expose-gc',
  '--experimental-strip-types',
  '--no-experimental-strip-types',
  '--experimental-transform-types',
  '--experimental-vm-modules',
  '--experimental-require-module',
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
]);

const EXEC_ARGV_NUMERIC_FLAGS: ReadonlySet<string> = new Set([
  '--max-old-space-size',
  '--max-semi-space-size',
  '--stack-size',
  '--stack-trace-limit',
]);

const INSPECT_FLAGS: ReadonlySet<string> = new Set(['--inspect', '--inspect-brk', '--inspect-wait', '--inspect-port']);
const UNHANDLED_REJECTION_MODES: ReadonlySet<string> = new Set(['throw', 'strict', 'warn', 'none', 'warn-with-error-code']);

// A debugger is remote code execution for whoever can reach its port, so the
// inspector may only bind the loopback: `--inspect=9230`,
// `--inspect=127.0.0.1:9230`, `--inspect=localhost:9230`, `--inspect=[::1]:9230`.
const LOOPBACK_INSPECT_VALUE = /^(?:(?:127\.0\.0\.1|localhost|\[::1\]):)?\d{1,5}$/;

/** Null when `value` is an acceptable execArgv list, else the error message. */
export function execArgvError(key: string, value: unknown): string | null {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    return `"${key}" must be an array of strings`;
  }
  for (const [index, flag] of (value as string[]).entries()) {
    const eq = flag.indexOf('=');
    const name = eq === -1 ? flag : flag.slice(0, eq);
    const arg = eq === -1 ? undefined : flag.slice(eq + 1);
    const ok = arg === undefined
      ? EXEC_ARGV_BARE_FLAGS.has(name)
      : (INSPECT_FLAGS.has(name) && LOOPBACK_INSPECT_VALUE.test(arg))
        || (EXEC_ARGV_NUMERIC_FLAGS.has(name) && /^\d+$/.test(arg))
        || (name === '--unhandled-rejections' && UNHANDLED_REJECTION_MODES.has(arg));
    if (!ok) {
      return `"${key}[${index}]": "${flag}" is not an allowed worker flag — through the config API execArgv accepts ` +
        'only debugger (loopback), source-map, memory/stack sizing and diagnostic flags; ' +
        'set anything else by editing lss.config.json';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// runtime vs Node major
// ---------------------------------------------------------------------------

/**
 * A warning when the functions declare a Node runtime (`nodejs20.x`) whose
 * major differs from the Node the workers run on — handlers are executed by
 * the orchestrator's own Node, so a template targeting 18 that leans on an API
 * only 22 has (or the reverse) would pass locally and fail deployed. Null when
 * every declared Node runtime matches, or none is a Node runtime at all.
 */
export function runtimeMismatchWarning(
  serviceName: string,
  runtimes: Array<string | undefined>,
  nodeVersion: string,
): string | null {
  const workerMajor = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
  const declared = new Set<number>();
  for (const runtime of runtimes) {
    const match = /^nodejs(\d+)\.x$/.exec(runtime ?? '');
    if (match) declared.add(Number(match[1]));
  }
  const mismatched = [...declared].filter(major => major !== workerMajor).sort((a, b) => a - b);
  if (mismatched.length === 0) return null;
  return `⚠️  "${serviceName}" declares ${mismatched.map(m => `nodejs${m}.x`).join(', ')} but its Lambda workers ` +
    `run on Node ${workerMajor} (the orchestrator's) — behaviour that differs between the two majors will not show up locally`;
}

// ---------------------------------------------------------------------------
// Watcher exclusions
// ---------------------------------------------------------------------------

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * The paths among `candidates` that sit strictly INSIDE `root`, returned
 * relative to it (platform separators) — the form the watcher's event
 * filenames arrive in. Candidates outside the root, or equal to it, are
 * dropped: ignoring the root itself would silently disable the watch. Both
 * sides are realpath-resolved when they exist, so a symlinked checkout still
 * matches.
 */
export function ignoredSubpaths(root: string, candidates: Array<string | undefined>): string[] {
  const realRoot = realpathOrSelf(path.resolve(root));
  const result = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const relative = path.relative(realRoot, realpathOrSelf(path.resolve(candidate)));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    result.add(relative);
  }
  return [...result];
}

/** True when `filename` (relative to the watched root) is, or is under, one of `ignored`. */
export function isIgnoredSubpath(filename: string, ignored: string[]): boolean {
  return ignored.some(rel => filename === rel || filename.startsWith(rel + path.sep));
}
