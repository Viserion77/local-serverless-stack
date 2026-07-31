import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { CloudFormationParser } from '../services/cloudformation-parser.js';
import { runServerlessPackage, ServerlessPackageError } from '../services/serverless-packager.js';
import { CacheManager } from '../services/cache-manager.js';
import { ResourceProvisioner } from '../services/resource-provisioner.js';
import { ProcessManager } from '../services/process-manager.js';
import { ServiceRegistrar, RegistrationError } from '../services/service-registrar.js';
import { ConfigManager } from '../services/config-manager.js';
import { scanForServices } from '../services/service-scanner.js';
import { LambdaRuntimeManager } from '../services/lambda-runtime-manager.js';
import { GatewayManager } from '../services/gateway-manager.js';
import { SourceWatcher } from '../services/source-watcher.js';

const router = Router();
const parser = new CloudFormationParser();
const cache = new CacheManager();
const provisioner = ResourceProvisioner.getInstance();
const processManager = new ProcessManager();

// Initialize cache on first request (lazy init)
let cacheInitialized = false;
async function ensureCacheInit() {
  if (!cacheInitialized) {
    await cache.init();
    cacheInitialized = true;
  }
}

// Register a service
router.post('/register', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();

    const { servicePath, invokePort, apiPort, region } = req.body;

    if (!servicePath) {
      return res.status(400).json({ error: 'servicePath is required' });
    }

    // Ports and region resolve inside the registrar (request > packaged
    // serverless-state hints > lss.config.json > defaults) — a bare
    // { servicePath } is a complete registration.
    console.log(`📝 Registering service from ${servicePath}`);

    // Validate servicePath to prevent path traversal
    const resolvedPath = path.resolve(servicePath);
    if (resolvedPath.includes('..') || !resolvedPath.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid service path' });
    }

    for (const [label, value] of [['invokePort', invokePort], ['apiPort', apiPort]] as const) {
      if (value && (typeof value !== 'number' || value < 1024 || value > 65535)) {
        return res.status(400).json({ error: `Invalid ${label}, must be between 1024-65535` });
      }
    }

    const result = await ServiceRegistrar.getInstance().register({
      servicePath: resolvedPath,
      invokePort,
      apiPort,
      region,
    });

    return res.json({
      success: true,
      serviceName: result.serviceName,
      resourcesCount: result.resources.length,
      functionsCount: result.functionsCount,
      routesCount: result.routesCount,
      warnings: result.warnings,
      resources: result.resources.map(r => ({
        type: r.type,
        name: 'name' in r ? r.name : r.functionName,
      })),
    });
  } catch (error) {
    if (error instanceof RegistrationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Registration error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// List all services
router.get('/', async (_req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const services = await cache.listServices();
    const withCount = await Promise.all(
      services.map(async (s) => {
        const template = await cache.getTemplate(s.name);
        const resources = template ? parser.parse(template) : [];
        const resourceBreakdown = {
          lambdas: resources.filter(r => r.type === 'lambda').length,
          tables: resources.filter(r => r.type === 'dynamodb').length,
          queues: resources.filter(r => r.type === 'sqs').length,
          topics: resources.filter(r => r.type === 'sns').length,
          buckets: resources.filter(r => r.type === 's3').length,
          buses: resources.filter(r => r.type === 'eventbus').length,
          eventRules: resources.filter(r => r.type === 'event-rule').length,
          collections: resources.filter(r => r.type === 'opensearch').length,
        };
        const runtime = LambdaRuntimeManager.getInstance().getRuntimeInfo(s.name);
        const gateway = GatewayManager.getInstance().getInfo(s.name);
        return {
          ...s,
          resourcesCount: resources.length,
          resourceBreakdown,
          functionsCount: s.functions?.length ?? 0,
          routesCount: s.routes?.length ?? 0,
          runtimeStatus: runtime.status,
          // Whether a worker process is actually alive — false means the
          // service is ready but not yet forked (lazy start / idle unload).
          runtimeWarm: runtime.warm ?? false,
          gateway,
        };
      }),
    );
    return res.json(withCount);
  } catch (error) {
    console.error('Error listing services:', error);
    return res.status(500).json({ error: 'Failed to list services' });
  }
});

// Discover Serverless/osls services under the project root, so onboarding and
// `lss scan` can offer them for registration. Registered BEFORE /:name — the
// path would otherwise match as a service called "scan".
router.get('/scan', async (_req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const registeredRoots = (await cache.listServices()).map(s => s.root);
    const cm = ConfigManager.getInstance();
    const projectRoot = cm.getProjectRoot();
    // Overlay the config on the yml hints: `serviceRuntime` ports win (same
    // precedence registration applies), and the effective package command is
    // what onboarding shows/edits (a `servicePackaging` entry, else global).
    const services = scanForServices(projectRoot, registeredRoots).map(svc => {
      const runtime = cm.getRuntimeConfigForService(svc.root);
      return {
        ...svc,
        apiPort: runtime.apiPort ?? svc.apiPort,
        invokePort: runtime.invokePort ?? svc.invokePort,
        packageCommand: cm.getPackageConfigForService(svc.root).command,
      };
    });
    return res.json({ projectRoot, services });
  } catch (error) {
    console.error('Error scanning for services:', error);
    return res.status(500).json({ error: 'Failed to scan for services' });
  }
});

// Resolve every symlink in a path, or null when it cannot be resolved
// (ENOENT on a missing component, EACCES on an unreadable one). Mirrors the
// `realpathOrSelf` idiom ConfigManager uses, but the caller here needs to tell
// "does not resolve" apart from "resolves to itself" — an unresolvable path is
// never a service directory.
function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

// Resolve and sanity-check the servicePath both preparation endpoints take.
// Returns the REAL directory, or answers the response and returns null.
//
// The path is confined to the project root: these endpoints run commands on
// the host, and every legitimate caller (the dashboard onboarding, `lss`)
// works from `GET /scan`, which never looks outside it. Without the fence the
// pair would be an arbitrary-directory execution surface for anything that can
// reach the port.
//
// The fence compares REAL paths, not lexical ones: `path.relative()` only
// looks at the string, so a symlink sitting inside the project root but
// pointing outside it (`services/orders` -> `/etc`) satisfies a lexical check
// while statSync — and the spawn that follows — happily walk through it.
// Resolving both sides first means the comparison is about where the path
// actually lands, and the resolved path is what is handed to the runner, which
// also shrinks the window between the check and the spawn.
function resolveServiceDir(res: Response, servicePath: unknown): string | null {
  if (!servicePath || typeof servicePath !== 'string') {
    res.status(400).json({ error: 'servicePath is required' });
    return null;
  }
  const resolved = path.resolve(servicePath);
  if (resolved.includes('..') || !resolved.startsWith('/')) {
    res.status(400).json({ error: 'Invalid service path' });
    return null;
  }
  const projectRoot = ConfigManager.getInstance().getProjectRoot();
  // `getProjectRoot()` already realpath-resolves, so this is belt-and-braces
  // for a root that comes from configuration: a root that cannot be resolved
  // is a misconfiguration rather than a caller error, so it keeps its lexical
  // form and still fences (nothing real can sit under a path that does not
  // exist, so every candidate is rejected below).
  const realRoot = realPathOrNull(projectRoot) ?? projectRoot;
  const realDir = realPathOrNull(resolved);
  if (!realDir) {
    res.status(400).json({ error: `Not a directory: ${resolved}` });
    return null;
  }
  const relative = path.relative(realRoot, realDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.status(400).json({ error: `Service path must be inside the project root (${projectRoot})` });
    return null;
  }
  // realpathSync + statSync are still two syscalls: the directory can vanish
  // between them, and statSync throws on EACCES. A throw inside an async
  // handler is an unhandled rejection that answers nothing and takes the
  // process down under Node's default policy, so it is treated as "not a
  // directory" here — the same reasoning as before, now one syscall later.
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(realDir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    res.status(400).json({ error: `Not a directory: ${resolved}` });
    return null;
  }
  return realDir;
}

// Keep the last chunk of a long install/package log — the tail is where the
// error is, and the dashboard only has room for a summary.
function outputTail(stdout: string, stderr: string, limit = 8000): string {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  return combined.length > limit ? `…${combined.slice(-limit)}` : combined;
}

// A package manager installing the dependencies already declared in the
// service's own manifest — nothing else. The check is on the command's SHAPE,
// not just its first token: `node -e "<js>"`, `npm exec -- <anything>` and
// `npm install <some-package>` are all unrepresentable, so a caller cannot
// turn the endpoint into a general command runner. (Install lifecycle scripts
// from the checked-out project still run, exactly as they would in a
// terminal — that is what installing a project means.)
const INSTALL_RUNNERS = ['npm', 'yarn', 'pnpm'];
const INSTALL_VERBS = ['install', 'ci', 'i', 'add'];

// The flags an install may carry, as an ALLOWLIST — anything else is denied.
// "Every token after the verb starts with a dash" is not a check: a flag is not
// inert, it carries a value, and the dangerous ones look exactly like the
// harmless ones.
//   --registry=http://attacker.example  redirects WHERE THE CODE COMES FROM,
//                                       and its install scripts then run here
//   --userconfig=/tmp/evil.npmrc        swaps the whole npmrc (registry + auth)
//   --prefix=/tmp/x  --cwd=/etc  --dir=/etc
//                                       relocate the install and so defeat the
//                                       project-root fence resolveServiceDir
//                                       applies one layer up
// Deny-listing those cannot close the class — three package managers keep
// adding flags, and every new one would be allowed by default. So only the
// flags a real caller needs to say "install what this service declares"
// survive, and none of them names a location.
const INSTALL_ALLOWED_FLAGS = new Set([
  // Which dependency groups to install.
  '--production',
  // Lockfile strictness, in the npm/yarn/pnpm spellings.
  '--frozen-lockfile', '--no-frozen-lockfile', '--immutable',
  // Resolution/network behaviour that stays within the configured registry.
  '--no-audit', '--no-fund', '--prefer-offline', '--offline', '--legacy-peer-deps', '--force',
  // Verbosity.
  '--silent', '--quiet',
]);

// Flags accepted both bare (`--omit`) and value-carrying (`--omit=dev`). The
// value is unconstrained on purpose: these name a dependency group
// (dev/optional/peer) or a log level, so an unexpected one makes the package
// manager complain — it can never point the install at another location or
// another registry, which is the only property the allowlist exists to defend.
const INSTALL_ALLOWED_VALUE_FLAGS = new Set(['--omit', '--include', '--loglevel']);

function installCommandError(command: string): string | null {
  const [runner, verb, ...rest] = command.split(/\s+/);
  if (!INSTALL_RUNNERS.includes(runner)) {
    return `Command not allowed — must start with one of: ${INSTALL_RUNNERS.join(', ')}`;
  }
  // `yarn`/`pnpm` with no verb install; npm needs one.
  if (verb === undefined) {
    return runner === 'npm' ? 'Command not allowed — npm needs an install subcommand' : null;
  }
  if (!INSTALL_VERBS.includes(verb)) {
    return `Command not allowed — subcommand must be one of: ${INSTALL_VERBS.join(', ')}`;
  }
  for (const token of rest) {
    // A positional would be a package name (or worse) rather than "install
    // what this service declares" — including the value of a space-separated
    // flag (`--omit dev`), which is why only the `--flag=value` spelling gets
    // through.
    if (!token.startsWith('-')) {
      return `Command not allowed — unexpected argument "${token}"`;
    }
    // Match `--flag=value` on its name; a short flag (`-g`, `-D`) has no '='
    // and appears in neither list, so it is rejected here as well.
    const flag = token.split('=')[0];
    if (!INSTALL_ALLOWED_FLAGS.has(token) && !INSTALL_ALLOWED_VALUE_FLAGS.has(flag)) {
      return `Command not allowed — flag not permitted: "${flag}"`;
    }
  }
  return null;
}

// Install a service's dependencies, so onboarding can prepare a freshly cloned
// service (packaging fails without node_modules).
router.post('/install', async (req: Request, res: Response) => {
  const dir = resolveServiceDir(res, req.body?.servicePath);
  if (!dir) return;
  const command = typeof req.body?.command === 'string' && req.body.command.trim()
    ? req.body.command.trim()
    : 'npm install';
  const commandError = installCommandError(command);
  if (commandError) {
    return res.status(400).json({ error: commandError });
  }
  console.log(`📥 Installing dependencies in ${dir} ('${command}')`);
  const startedAt = Date.now();
  try {
    const result = await runServerlessPackage({
      command,
      cwd: dir,
      timeoutMs: ConfigManager.getInstance().getPackageConfigForService(dir).timeoutMs,
    });
    return res.json({ success: true, exitCode: result.exitCode, durationMs: Date.now() - startedAt, output: outputTail(result.stdout, result.stderr) });
  } catch (error) {
    if (error instanceof ServerlessPackageError) {
      return res.status(422).json({ error: error.message, exitCode: error.result.exitCode, output: outputTail(error.result.stdout, error.result.stderr) });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// Package a service with its effective package command (global config merged
// with any `servicePackaging` override for this path) — the manual counterpart
// of what autoPackage does inside /register.
router.post('/package', async (req: Request, res: Response) => {
  const dir = resolveServiceDir(res, req.body?.servicePath);
  if (!dir) return;
  const pkg = ConfigManager.getInstance().getPackageConfigForService(dir);
  const displayCmd = [pkg.command, ...pkg.args].join(' ');
  console.log(`📦 Packaging ${dir} ('${displayCmd}')`);
  const startedAt = Date.now();
  try {
    const result = await runServerlessPackage({
      command: pkg.command,
      args: pkg.args,
      env: pkg.env,
      cwd: dir,
      timeoutMs: pkg.timeoutMs,
    });
    return res.json({ success: true, exitCode: result.exitCode, durationMs: Date.now() - startedAt, output: outputTail(result.stdout, result.stderr) });
  } catch (error) {
    if (error instanceof ServerlessPackageError) {
      return res.status(422).json({ error: error.message, exitCode: error.result.exitCode, output: outputTail(error.result.stdout, error.result.stderr) });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// Get service details
router.get('/:name', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const template = await cache.getTemplate(serviceName);
    const resources = parser.parse(template);

    return res.json({
      ...metadata,
      resourcesCount: resources.length,
      resources: resources.map(r => ({
        type: r.type,
        name: 'name' in r ? r.name : r.functionName,
      })),
    });
  } catch (error) {
    console.error('Error fetching service:', error);
    return res.status(500).json({ error: 'Failed to fetch service details' });
  }
});

// Delete service
router.delete('/:name', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    // Tear down the data plane first (worker, listeners, watcher, registry).
    await ServiceRegistrar.getInstance().deactivate(serviceName);

    // Clean up resources from LocalStack — re-parse the cached template so the cleanup
    // works even after an orchestrator restart (no in-memory state).
    const template = await cache.getTemplate(serviceName);
    const resources = template ? parser.parse(template) : [];
    await provisioner.cleanupResources(serviceName, resources);

    // Delete from cache
    await cache.deleteService(serviceName);

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting service:', error);
    return res.status(500).json({ error: 'Failed to delete service' });
  }
});

// Update service status
router.patch('/:name/status', async (req: Request, res: Response) => {
  try {
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const { status, pid } = req.body;
    
    // Validate status
    const validStatuses = ['registered', 'running', 'stopped', 'error'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    
    // Validate PID
    if (pid !== undefined && (typeof pid !== 'number' || pid < 0)) {
      return res.status(400).json({ error: 'Invalid PID' });
    }
    
    await cache.updateMetadata(serviceName, { status, pid });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error updating service status:', error);
    return res.status(500).json({ error: 'Failed to update service status' });
  }
});

// Which npm script `stage` may select. It is interpolated into the script name
// `start:${stage}` and handed to spawn() as one argv element — never a shell
// string — so this is not about shell injection: it constrains WHICH script of
// the service's own package.json a caller can pick, keeping the request from
// naming a path (`start:../../thing`) or smuggling a second argv token past a
// layer that splits on whitespace.
const STAGE_PATTERN = /^[A-Za-z0-9._-]+$/;

// Only package managers. The argv below is always the `run <script>` idiom, so
// `node`/`npx` cannot even express it (`node run start` is meaningless) — and
// they are exactly what turned this endpoint into an execution primitive:
// `node -e "<any js>"` used to be a valid body.
const START_RUNNERS = ['npm', 'yarn', 'pnpm'];

// Start a service process (serverless offline / npm start)
router.post('/:name/start', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // The server decides WHAT runs; the request only selects which service, and
    // optionally which package manager and which start script. `cwd`, `args`
    // and `env` used to come from the body and go straight into spawn(), which
    // made this a general command runner for anything able to reach the port —
    // no auth, `cors()` wide open, the listener bound to every interface, and
    // the service names handed out by GET /api/services. They are not read at
    // all now; no caller in the dashboard, the client or the CLI ever sent them.
    const { command, stage } = req.body || {};

    if (stage && (typeof stage !== 'string' || !STAGE_PATTERN.test(stage))) {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    // Message kept verbatim — it is the documented answer for this rejection.
    if (command && !START_RUNNERS.includes(command)) {
      return res.status(400).json({ error: 'Command not allowed' });
    }

    const result = processManager.start(serviceName, {
      // Always the registered root: the only directory this service is.
      cwd: metadata.root,
      command,
      args: ['run', stage ? `start:${stage}` : 'start'],
    });

    await cache.updateMetadata(serviceName, { status: 'running', pid: result.pid || undefined });

    return res.json({ success: true, pid: result.pid, status: result.status });
  } catch (error) {
    console.error('Error starting service:', error);
    return res.status(500).json({ error: 'Failed to start service' });
  }
});

// Stop a service process
router.post('/:name/stop', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const result = processManager.stop(serviceName);
    await cache.updateMetadata(serviceName, { status: 'stopped', pid: undefined });

    return res.json({ success: result.stopped });
  } catch (error) {
    console.error('Error stopping service:', error);
    return res.status(500).json({ error: 'Failed to stop service' });
  }
});

// Lambda runtime status for a service (worker + gateway/invoke listeners).
router.get('/:name/runtime', async (req: Request, res: Response) => {
  try {
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const runtime = LambdaRuntimeManager.getInstance().getRuntimeInfo(serviceName);
    const gateway = GatewayManager.getInstance().getInfo(serviceName);
    const watch = SourceWatcher.getInstance().getStatus(serviceName);
    return res.json({ runtime, gateway, watch });
  } catch (error) {
    console.error('Error fetching runtime status:', error);
    return res.status(500).json({ error: 'Failed to fetch runtime status' });
  }
});

// Start (or restart) the Lambda runtime for a service.
router.post('/:name/runtime/start', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }
    await ServiceRegistrar.getInstance().activate(metadata);
    const runtime = LambdaRuntimeManager.getInstance().getRuntimeInfo(serviceName);
    const gateway = GatewayManager.getInstance().getInfo(serviceName);
    return res.json({ success: true, runtime, gateway });
  } catch (error) {
    console.error('Error starting runtime:', error);
    return res.status(500).json({ error: 'Failed to start runtime' });
  }
});

// Stop the Lambda runtime (worker + listeners) for a service.
router.post('/:name/runtime/stop', async (req: Request, res: Response) => {
  try {
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    SourceWatcher.getInstance().unwatch(serviceName);
    await LambdaRuntimeManager.getInstance().stopRuntime(serviceName);
    await GatewayManager.getInstance().stopService(serviceName);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error stopping runtime:', error);
    return res.status(500).json({ error: 'Failed to stop runtime' });
  }
});

// Fetch logs for a running service
router.get('/:name/logs', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    const info = processManager.getLogs(serviceName);
    return res.json(info);
  } catch (error) {
    console.error('Error fetching logs:', error);
    return res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

export { router as servicesRouter, processManager };
