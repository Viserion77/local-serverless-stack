// End-to-end service (re-)registration: read the `sls package` artifacts
// (CloudFormation template + serverless-state.json), parse resources, functions,
// routes and authorizers, persist to the cache, provision LocalStack resources,
// and activate the data plane (runtime worker + gateway/invoke listeners +
// watcher). Shared by the /register route, boot rehydration and hot reload.

import fs from 'fs/promises';
import path from 'path';
import { CloudFormationParser, Resource, LambdaResource } from './cloudformation-parser.js';
import {
  ServerlessStateParser,
  RegisteredFunction,
  sanitizeEnvironmentValues,
} from './serverless-state-parser.js';
import { CacheManager, ServiceMetadata } from './cache-manager.js';
import { ResourceProvisioner } from './resource-provisioner.js';
import { ConfigManager } from './config-manager.js';
import { FunctionRegistry } from './function-registry.js';
import { LambdaRuntimeManager } from './lambda-runtime-manager.js';
import { GatewayManager } from './gateway-manager.js';
import { SourceWatcher } from './source-watcher.js';
import { runServerlessPackage, ServerlessPackageError } from './serverless-packager.js';

export interface RegisterInput {
  servicePath: string;
  invokePort?: number;
  apiPort?: number;
  region?: string;
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

export class ServiceRegistrar {
  private static instance: ServiceRegistrar;
  private cache = new CacheManager();
  private cacheReady = false;

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
    const effectiveRegion = input.region || configManager.getConfig().region || 'us-east-1';

    const warnings: string[] = [];
    const template = await this.readTemplate(resolvedPath, dirName) as Parameters<CloudFormationParser['parse']>[0];
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

    if (state) {
      const parsed = stateParser.parse(state);
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

    // Port resolution: lss.config.json serviceRuntime > plugin payload >
    // invokePortOffset rule (apiPort 30xx → invokePort 130xx).
    const runtimeConfig = configManager.getRuntimeConfigForService(resolvedPath);
    const apiPort = runtimeConfig.apiPort ?? input.apiPort;
    const invokePort = runtimeConfig.invokePort
      ?? input.invokePort
      ?? (apiPort ? apiPort + configManager.getInvokePortOffset() : undefined);

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
      region: effectiveRegion,
      stage,
      functions,
      routes,
      authorizers,
    };
    await cache.saveTemplate(serviceName, template, metadata);

    // Provision infra resources to LocalStack (unchanged behavior).
    await ResourceProvisioner.getInstance().provisionResources(serviceName, resources, {
      invokePort,
      region: effectiveRegion,
    });

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

    const entry = registry.registerService(metadata);
    const runtimeConfig = configManager.getRuntimeConfigForService(metadata.root);

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
        cwd: metadata.root,
        timeoutMs: pkgConfig.timeoutMs,
        env: pkgConfig.env,
      });
    }

    await this.register({
      servicePath: metadata.root,
      invokePort: metadata.invokePort,
      apiPort: metadata.apiPort,
      region: metadata.region,
    });
  }

  async deactivate(serviceName: string): Promise<void> {
    SourceWatcher.getInstance().unwatch(serviceName);
    await LambdaRuntimeManager.getInstance().stopRuntime(serviceName);
    await GatewayManager.getInstance().removeService(serviceName);
    FunctionRegistry.getInstance().removeService(serviceName);
  }

  private async readTemplate(resolvedPath: string, serviceName: string): Promise<Record<string, unknown>> {
    const configManager = ConfigManager.getInstance();
    const templatePath = path.join(resolvedPath, '.serverless', 'cloudformation-template-update-stack.json');
    let templateContent: string;
    try {
      templateContent = await fs.readFile(templatePath, 'utf-8');
    } catch (err) {
      const isENOENT = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      if (!isENOENT) throw err;

      if (!configManager.isAutoPackage()) {
        throw new RegistrationError(
          400,
          `CloudFormation template not found at ${templatePath}. Run 'serverless package' in the service directory, or enable autoPackage in lss.config.json.`,
        );
      }

      const pkgConfig = configManager.getPackageConfigForService(resolvedPath);
      const displayCmd = [pkgConfig.command, ...pkgConfig.args].join(' ');
      console.log(`📦 Template missing — running '${displayCmd}' in ${resolvedPath} (service: ${serviceName})`);
      try {
        const result = await runServerlessPackage({
          command: pkgConfig.command,
          args: pkgConfig.args,
          cwd: resolvedPath,
          timeoutMs: pkgConfig.timeoutMs,
          env: pkgConfig.env,
        });
        console.log(`✅ Auto-package finished for ${resolvedPath} (exit 0)`);
        if (result.stdout.trim()) {
          console.log(`--- ${displayCmd} stdout ---\n${result.stdout.trimEnd()}\n--- end ---`);
        }
      } catch (packageErr) {
        if (packageErr instanceof ServerlessPackageError) {
          console.error(`❌ Auto-package failed for ${resolvedPath}: ${packageErr.message}`);
          if (packageErr.result.stdout.trim()) {
            console.error(`--- ${displayCmd} stdout ---\n${packageErr.result.stdout.trimEnd()}\n--- end ---`);
          }
          if (packageErr.result.stderr.trim()) {
            console.error(`--- ${displayCmd} stderr ---\n${packageErr.result.stderr.trimEnd()}\n--- end ---`);
          }
        } else {
          console.error(`❌ Auto-package failed for ${resolvedPath}:`, packageErr);
        }
        const detail = packageErr instanceof ServerlessPackageError
          ? `${packageErr.message}\n${packageErr.result.stderr || packageErr.result.stdout}`.trim()
          : packageErr instanceof Error ? packageErr.message : 'Unknown error';
        throw new RegistrationError(
          500,
          `Auto-package failed for ${resolvedPath}: ${detail}. Full stderr/stdout is in the orchestrator log (/tmp/lss-orchestrator.log).`,
        );
      }
      templateContent = await fs.readFile(templatePath, 'utf-8');
    }
    return JSON.parse(templateContent);
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
