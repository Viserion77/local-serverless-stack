// End-to-end service (re-)registration: read the `sls package` artifacts
// (CloudFormation template + serverless-state.json), parse resources, functions,
// routes and authorizers, persist to the cache, provision LocalStack resources,
// and activate the data plane (runtime worker + gateway/invoke listeners +
// watcher). Shared by the /register route, boot rehydration and hot reload.

import fs from 'fs/promises';
import path from 'path';
import { CloudFormationParser, Resource, LambdaResource } from './cloudformation-parser.js';
import { assembleRawApiResources, collectStackExports } from './raw-api-assembler.js';
import {
  ServerlessStateParser,
  RegisteredFunction,
  sanitizeEnvironmentValues,
  type ParsedServerlessState,
} from './serverless-state-parser.js';
import { CacheManager, ServiceMetadata, ServicePortHints } from './cache-manager.js';
import { ResourceProvisioner } from './resource-provisioner.js';
import { ConfigManager, ResolvedRuntimeConfig } from './config-manager.js';
import { FunctionRegistry } from './function-registry.js';
import { LambdaRuntimeManager } from './lambda-runtime-manager.js';
import { GatewayManager } from './gateway-manager.js';
import { SourceWatcher } from './source-watcher.js';
import { runServerlessPackage, ServerlessPackageError } from './serverless-packager.js';
import { detectStaleArtifact, formatStaleArtifactWarning } from './artifact-staleness.js';

export interface RegisterInput {
  servicePath: string;
  invokePort?: number;
  apiPort?: number;
  region?: string;
  // Run the service's packaging command before reading the template, even when
  // a template is already on disk. `autoPackage` only covers the MISSING-template
  // case, so without this the only way to load edited code was to know the
  // stack's packaging command from outside and run it by hand.
  repackage?: boolean;
}

export interface RegisterResult {
  serviceName: string;
  resources: Resource[];
  functionsCount: number;
  routesCount: number;
  warnings: string[];
}

const cfnParser = new CloudFormationParser();
const stateParser = new ServerlessStateParser();

// True when `serviceRoot` is `projectRoot` itself or lives underneath it.
export function isInsideProject(serviceRoot: string, projectRoot: string): boolean {
  const rel = path.relative(path.resolve(projectRoot), path.resolve(serviceRoot));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The one place the port precedence lives: `serviceRuntime` from
 * lss.config.json wins, then the hints recorded at registration (the explicit
 * request payload, then `custom.lss` from the packaged state), then the
 * apiPort → invokePort offset rule. Used by register() AND by activate(), so a
 * rehydrated service resolves its ports the same way a fresh registration does.
 */
export function resolvePorts(
  configManager: Pick<ConfigManager, 'getInvokePortOffset'>,
  runtimeConfig: Pick<ResolvedRuntimeConfig, 'apiPort' | 'invokePort'>,
  hints: ServicePortHints,
): { apiPort?: number; invokePort?: number } {
  const apiPort = runtimeConfig.apiPort ?? hints.apiPort;
  const invokePort = runtimeConfig.invokePort
    ?? hints.invokePort
    ?? (apiPort ? apiPort + configManager.getInvokePortOffset() : undefined);
  return { apiPort, invokePort };
}

export class ServiceRegistrar {
  private static instance: ServiceRegistrar;
  private cache = new CacheManager();
  private cacheReady = false;
  // Cross-service CloudFormation export map (Outputs[].Export.Name → value),
  // accumulated across registrations so a raw route's Fn::ImportValue target can
  // reduce to a concrete ARN regardless of which stack exported it.
  private exportMap = new Map<string, string>();

  static getInstance(): ServiceRegistrar {
    if (!ServiceRegistrar.instance) {
      ServiceRegistrar.instance = new ServiceRegistrar();
    }
    return ServiceRegistrar.instance;
  }

  private async ensureCache(): Promise<CacheManager> {
    if (!this.cacheReady) {
      await this.cache.init();
      this.cacheReady = true;
    }
    return this.cache;
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const configManager = ConfigManager.getInstance();
    const cache = await this.ensureCache();

    const resolvedPath = path.resolve(input.servicePath);
    const dirName = path.basename(resolvedPath);

    const warnings: string[] = [];
    const template = await this.readTemplate(
      resolvedPath,
      dirName,
      warnings,
      input.repackage ?? false,
    ) as Parameters<CloudFormationParser['parse']>[0];
    const resources = cfnParser.parse(template, warnings);
    const templateHash = cfnParser.calculateHash(template);

    // serverless-state.json is the declarative source for routes/authorizers.
    // Missing state (older setups) degrades gracefully: functions still come
    // from the CFN template, HTTP routes are just unavailable.
    const state = await this.readState(resolvedPath);
    let functions: RegisteredFunction[] = [];
    let routes: ServiceMetadata['routes'] = [];
    let authorizers: ServiceMetadata['authorizers'] = [];
    let stage = 'dev';
    // The service's identity is the `service:` name from serverless.yml (via
    // serverless-state.json), not the directory basename — two products can
    // both live in a folder called "bff". The basename remains the fallback
    // for stateless registrations.
    let serviceName = dirName;

    const cfnLambdas = resources.filter((r): r is LambdaResource => r.type === 'lambda');

    // Registration is self-serving: everything the retired 0.x plugin used to
    // POST alongside the request — provider.region and the custom.lss port
    // hints — is read from the packaged state, so `POST /register
    // {servicePath}` (or `lss register <dir>`) is enough.
    // An explicit request value still wins as a deliberate override.
    let parsed: ParsedServerlessState | null = null;
    if (state) {
      parsed = stateParser.parse(state);
    }
    const effectiveRegion = input.region
      || parsed?.region
      || configManager.getConfig().region
      || 'us-east-1';

    if (parsed) {
      if (parsed.serviceName) serviceName = parsed.serviceName;
      warnings.push(...parsed.warnings);
      stage = parsed.stage;
      routes = parsed.routes;
      authorizers = parsed.authorizers;
      // The CFN template carries the fully resolved function env (state may
      // still hold unresolved refs) — prefer it when the names line up.
      functions = parsed.functions.map(fn => {
        const cfn = cfnLambdas.find(l => l.name === fn.fullName);
        return cfn
          ? { ...fn, environment: { ...fn.environment, ...sanitizeEnvironmentValues(cfn.environment) } }
          : fn;
      });
    } else {
      warnings.push('serverless-state.json not found — functions registered from the CloudFormation template only (no HTTP routes).');
      functions = cfnLambdas.map(l => ({
        name: l.name,
        fullName: l.name,
        handler: l.handler,
        runtime: l.runtime,
        memorySize: l.memorySize,
        timeout: l.timeout,
        environment: sanitizeEnvironmentValues(l.environment),
        triggers: [],
      }));
    }

    // Fold raw AWS::ApiGatewayV2::Route/Integration/Authorizer resources (declared
    // under CFN `resources:`) into the same route/authorizer registry, resolving
    // cross-stack Lambda targets by ARN and deduping against the state routes
    // (which win). Genuinely-raw routes (a gateway stack fronting another stack's
    // Lambda) are appended; state mirrors are dropped.
    const assembled = assembleRawApiResources(cfnParser, {
      resources,
      region: effectiveRegion,
      localFunctions: functions,
      stateRoutes: routes ?? [],
      exports: this.exportMap,
      warnings,
    });
    if (assembled.routes.length > 0) {
      routes = [...(routes ?? []), ...assembled.routes];
      authorizers = [...(authorizers ?? []), ...assembled.authorizers];
    }
    // Record this stack's exports so a later service's Fn::ImportValue resolves.
    collectStackExports(cfnParser, resources, template.Outputs as Record<string, unknown> | undefined, effectiveRegion, this.exportMap);

    // Port resolution: lss.config.json serviceRuntime > request payload >
    // custom.lss hints from the packaged state > invokePortOffset rule
    // (apiPort 30xx → invokePort 130xx).
    //
    // The two lower layers are kept as `portHints` on the metadata so the
    // config layer can be re-applied on every activation. Without them the
    // effective number was the only thing on record, and a `serviceRuntime`
    // entry deleted from lss.config.json went on being served from the cache
    // for ever — a config you erased that still has effect.
    const portHints = {
      apiPort: input.apiPort ?? parsed?.apiPort,
      invokePort: input.invokePort ?? parsed?.invokePort,
    };
    const runtimeConfig = configManager.getRuntimeConfigForService(resolvedPath);
    const { apiPort, invokePort } = resolvePorts(configManager, runtimeConfig, portHints);
    console.log(`   Ports: api ${apiPort ?? '—'} · invoke ${invokePort ?? '—'} · region ${effectiveRegion}`);

    // A service with declared HTTP routes and no apiPort registers cleanly and
    // then serves nothing — reachable only through the Invoke API. That is the
    // right answer for a resources-only stack and almost never the intent for
    // one with routes, and the difference is knowable right here.
    if ((routes?.length ?? 0) > 0 && !apiPort) {
      warnings.push(
        `${routes?.length} HTTP route(s) declared but no apiPort resolved — this service will NOT answer HTTP. ` +
        `Declare serviceRuntime["${path.basename(resolvedPath)}"].apiPort in lss.config.json (or custom.lss.apiPort in serverless.yml).`,
      );
    }

    // 0.5.x keyed the cache by directory basename. When the real service name
    // differs, migrate: drop the legacy entry for this same root (data plane +
    // cache) so re-registration doesn't leave a ghost service behind.
    if (serviceName !== dirName) {
      const legacy = await cache.getMetadata(dirName);
      if (legacy && legacy.root === resolvedPath) {
        await this.deactivate(dirName);
        await cache.deleteService(dirName);
        console.log(`♻️  Migrated cached service "${dirName}" → "${serviceName}"`);
      }
    }

    const metadata: Omit<ServiceMetadata, 'name'> = {
      root: resolvedPath,
      templateHash,
      lastUpdated: Date.now(),
      status: 'registered',
      invokePort,
      apiPort,
      portHints,
      region: effectiveRegion,
      stage,
      functions,
      routes,
      authorizers,
    };
    await cache.saveTemplate(serviceName, template, metadata);

    // Provisioning is non-fatal by policy — but what it could not do travels
    // back with the result now, instead of living only in the daemon log.
    const provisioned = await ResourceProvisioner.getInstance().provisionResources(serviceName, resources, {
      invokePort,
      region: effectiveRegion,
    });
    warnings.push(...provisioned.warnings);

    await this.activate({ name: serviceName, ...metadata });

    for (const warning of warnings) {
      console.warn(`⚠️  [${serviceName}] ${warning}`);
    }

    return {
      serviceName,
      resources,
      functionsCount: functions.length,
      routesCount: routes?.length ?? 0,
      warnings,
    };
  }

  // Bring the data plane (registry, runtime worker, listeners, watcher) in line
  // with a service's metadata. Also used at boot for every cached service.
  async activate(metadata: ServiceMetadata): Promise<void> {
    const configManager = ConfigManager.getInstance();
    const registry = FunctionRegistry.getInstance();
    const runtime = LambdaRuntimeManager.getInstance();
    const gateway = GatewayManager.getInstance();
    const watcher = SourceWatcher.getInstance();

    const runtimeConfig = configManager.getRuntimeConfigForService(metadata.root);
    // Re-apply the config layer over the recorded hints on EVERY activation, so
    // boot rehydration reflects the lss.config.json that exists now — an edited
    // `serviceRuntime` entry takes effect, and a deleted one falls back to the
    // service's own hint instead of the cached number outliving the config that
    // produced it. Entries cached before hints were recorded keep their stored
    // ports as the hint, so an upgrade changes nothing for them.
    const hints = metadata.portHints ?? { apiPort: metadata.apiPort, invokePort: metadata.invokePort };
    const resolved = resolvePorts(configManager, runtimeConfig, hints);
    if (resolved.apiPort !== metadata.apiPort || resolved.invokePort !== metadata.invokePort) {
      console.log(
        `♻️  Ports for "${metadata.name}" re-resolved from lss.config.json: ` +
        `api ${metadata.apiPort ?? '—'} → ${resolved.apiPort ?? '—'} · invoke ${metadata.invokePort ?? '—'} → ${resolved.invokePort ?? '—'}`,
      );
      metadata = { ...metadata, ...resolved };
      const cache = await this.ensureCache();
      await cache.updateMetadata(metadata.name, resolved);
    }

    const entry = registry.registerService(metadata);

    await runtime.syncService(entry);
    await gateway.syncService(entry, runtimeConfig.enabled);

    // Watch default depends on how handlers are loaded: source mode reloads are
    // cheap (worker restart), artifact mode would need a re-package per save.
    const resolvedMode = runtime.getRuntimeInfo(metadata.name).resolvedMode;
    const watchEnabled = runtimeConfig.enabled
      && (runtimeConfig.watch ?? resolvedMode === 'source')
      && (metadata.functions?.length ?? 0) > 0;
    if (watchEnabled) {
      watcher.watch(metadata.name, metadata.root);
    } else {
      watcher.unwatch(metadata.name);
    }
  }

  async rehydrateAll(): Promise<void> {
    const cache = await this.ensureCache();
    const projectRoot = ConfigManager.getInstance().getProjectRoot();
    const services = await cache.listServices();
    let reactivated = 0;
    for (const metadata of services) {
      // The cache dir is project-scoped, so entries here belong to this
      // orchestrator even when their sources live outside the config file's
      // directory (config under infra/, services elsewhere) — register()
      // accepts those layouts, so rehydration must too. Log it for forensics.
      if (metadata.root && !isInsideProject(metadata.root, projectRoot)) {
        console.log(`ℹ️  Cached service "${metadata.name}" has its root outside the project root (${metadata.root}) — reactivating anyway`);
      }
      try {
        await this.activate(metadata);
        reactivated++;
      } catch (err) {
        console.error(`❌ Failed to activate cached service "${metadata.name}":`, err);
      }
    }
    if (reactivated) {
      console.log(`🔁 Reactivated ${reactivated} cached service(s)`);
    }
  }

  // Full reload for the watcher: re-package (when autoPackage allows) and
  // re-register using the ports/region already on record.
  async reregister(serviceName: string): Promise<void> {
    const cache = await this.ensureCache();
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) throw new Error(`Service ${serviceName} not found in cache`);

    if (ConfigManager.getInstance().isAutoPackage()) {
      const pkgConfig = ConfigManager.getInstance().getPackageConfigForService(metadata.root);
      await runServerlessPackage({
        command: pkgConfig.command,
        args: pkgConfig.args,
        cwd: pkgConfig.cwd,
        timeoutMs: pkgConfig.timeoutMs,
        env: pkgConfig.env,
      });
    }

    // The HINTS go back in, never the effective ports: re-injecting a resolved
    // number as an explicit request override would promote whatever the config
    // said at first registration into a value that outlives it — the same trap
    // the cached metadata used to spring on boot.
    await this.register({
      servicePath: metadata.root,
      invokePort: metadata.portHints?.invokePort ?? (metadata.portHints ? undefined : metadata.invokePort),
      apiPort: metadata.portHints?.apiPort ?? (metadata.portHints ? undefined : metadata.apiPort),
      region: metadata.region,
    });
  }

  async deactivate(serviceName: string): Promise<void> {
    SourceWatcher.getInstance().unwatch(serviceName);
    await LambdaRuntimeManager.getInstance().stopRuntime(serviceName);
    await GatewayManager.getInstance().removeService(serviceName);
    FunctionRegistry.getInstance().removeService(serviceName);
  }

  private async readTemplate(
    resolvedPath: string,
    serviceName: string,
    warnings: string[],
    repackage: boolean,
  ): Promise<Record<string, unknown>> {
    const configManager = ConfigManager.getInstance();
    const templatePath = path.join(resolvedPath, '.serverless', 'cloudformation-template-update-stack.json');

    // `--repackage` skips the read entirely: the whole point is to not register
    // what is already on disk.
    const existing = repackage ? null : await this.readTemplateIfPresent(templatePath);

    if (existing !== null) {
      // Registering artifacts that were produced by an earlier packaging run —
      // faithful, but silent about age. Say it out loud when the code moved on.
      await this.warnIfArtifactIsStale(resolvedPath, warnings);
      return JSON.parse(existing);
    }

    // An explicit `--repackage` is an operator gesture and runs regardless of
    // `autoPackage`, which governs only the automatic, template-missing path.
    if (!repackage && !configManager.isAutoPackage()) {
      throw new RegistrationError(
        400,
        `CloudFormation template not found at ${templatePath}. Run 'serverless package' in the service directory, or enable autoPackage in lss.config.json.`,
      );
    }

    await this.runPackaging(resolvedPath, serviceName, repackage);
    return JSON.parse(await fs.readFile(templatePath, 'utf-8'));
  }

  // ENOENT means "not packaged yet" and is the caller's decision to make; any
  // other read failure is a real fault and must not be mistaken for one.
  private async readTemplateIfPresent(templatePath: string): Promise<string | null> {
    try {
      return await fs.readFile(templatePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async warnIfArtifactIsStale(resolvedPath: string, warnings: string[]): Promise<void> {
    const verdict = await detectStaleArtifact(resolvedPath);
    if (!verdict) return;

    const pkgConfig = ConfigManager.getInstance().getPackageConfigForService(resolvedPath);
    const message = formatStaleArtifactWarning(
      verdict,
      resolvedPath,
      [pkgConfig.command, ...pkgConfig.args].join(' '),
    );
    console.warn(`⚠ ${resolvedPath}: ${message}`);
    warnings.push(message);
  }

  private async runPackaging(resolvedPath: string, serviceName: string, repackage: boolean): Promise<void> {
    const pkgConfig = ConfigManager.getInstance().getPackageConfigForService(resolvedPath);
    const displayCmd = [pkgConfig.command, ...pkgConfig.args].join(' ');
    const reason = repackage ? '--repackage requested' : 'Template missing';
    console.log(`📦 ${reason} — running '${displayCmd}' in ${pkgConfig.cwd} (service: ${serviceName})`);
    try {
      const result = await runServerlessPackage({
        command: pkgConfig.command,
        args: pkgConfig.args,
        cwd: pkgConfig.cwd,
        timeoutMs: pkgConfig.timeoutMs,
        env: pkgConfig.env,
      });
      console.log(`✅ Packaging finished for ${resolvedPath} (exit 0)`);
      if (result.stdout.trim()) {
        console.log(`--- ${displayCmd} stdout ---\n${result.stdout.trimEnd()}\n--- end ---`);
      }
    } catch (packageErr) {
      if (packageErr instanceof ServerlessPackageError) {
        console.error(`❌ Packaging failed for ${resolvedPath}: ${packageErr.message}`);
        if (packageErr.result.stdout.trim()) {
          console.error(`--- ${displayCmd} stdout ---\n${packageErr.result.stdout.trimEnd()}\n--- end ---`);
        }
        if (packageErr.result.stderr.trim()) {
          console.error(`--- ${displayCmd} stderr ---\n${packageErr.result.stderr.trimEnd()}\n--- end ---`);
        }
      } else {
        console.error(`❌ Packaging failed for ${resolvedPath}:`, packageErr);
      }
      const detail = packageErr instanceof ServerlessPackageError
        ? `${packageErr.message}\n${packageErr.result.stderr || packageErr.result.stdout}`.trim()
        : packageErr instanceof Error ? packageErr.message : 'Unknown error';
      throw new RegistrationError(
        500,
        `Packaging failed for ${resolvedPath}: ${detail}. Full stderr/stdout is in the orchestrator log (/tmp/lss-orchestrator.log).`,
      );
    }
  }

  private async readState(resolvedPath: string): Promise<Record<string, unknown> | null> {
    try {
      const statePath = path.join(resolvedPath, '.serverless', 'serverless-state.json');
      return JSON.parse(await fs.readFile(statePath, 'utf-8'));
    } catch {
      return null;
    }
  }
}

export class RegistrationError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}
