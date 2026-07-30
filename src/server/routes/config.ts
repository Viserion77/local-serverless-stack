import { Router, Request, Response } from 'express';
import {
  ConfigManager,
  ConfigValidationError,
  BrandingAssetKind,
  ServicePackageConfig,
} from '../services/config-manager.js';
import { FunctionRegistry } from '../services/function-registry.js';
import { applyRegionToExplorers } from '../services/explorer-region.js';

const router = Router();

// Per-service packaging blocks may carry secret env VALUES (deploy keys,
// registry tokens) — expose key names only, mirroring printSummary().
function redactPackaging(map: Record<string, ServicePackageConfig>) {
  return Object.fromEntries(
    Object.entries(map).map(([service, cfg]) => [
      service,
      {
        packageCommand: cfg.packageCommand,
        packageArgs: cfg.packageArgs,
        packageTimeoutMs: cfg.packageTimeoutMs,
        packageEnvKeys: Object.keys(cfg.packageEnv ?? {}),
      },
    ]),
  );
}

// Public-safe LSS configuration snapshot — everything the dashboard shows and
// edits. Never expose secret VALUES: the LocalStack auth token collapses to
// hasAuthToken, packageEnv maps collapse to their key names, and the secrets
// seed map collapses to a count.
function buildConfigSnapshot(cm: ConfigManager) {
  const raw = cm.getConfig();
  const selfEngine = cm.getSelfEngineConfig();
  const aossSidecar = cm.getAossSidecarConfig();
  return {
    serverPort: cm.getServerPort(),
    engine: {
      kind: cm.getEngineKind(),
      endpoint: cm.getEngineEndpoint(),
    },
    localstack: {
      mode: cm.getMode(),
      endpoint: cm.getLocalStackEndpoint(),
      port: cm.getLocalStackPort(),
      edition: cm.getLocalStackEdition(),
      version: cm.getLocalStackVersion(),
      image: cm.getLocalStackImage(),
      hasAuthToken: Boolean(cm.getLocalStackAuthToken()),
    },
    selfEngine: {
      port: selfEngine.port,
      dataDir: selfEngine.dataDir,
      account: selfEngine.account,
      idleUnloadMs: selfEngine.idleUnloadMs,
      memoryBudgetMb: selfEngine.memoryBudgetMb,
      fsync: selfEngine.fsync,
      fallbackEndpoint: selfEngine.fallbackEndpoint,
    },
    aossSidecar: {
      enabled: aossSidecar.enabled,
      port: aossSidecar.port,
      endpoint: aossSidecar.endpoint,
    },
    dynamoProxy: {
      enabled: cm.isEnableDynamoProxy(),
      port: cm.getDynamoProxyPort(),
    },
    region: cm.getRegion(),
    services: cm.getServices(),
    persistence: cm.isPersistence(),
    debug: cm.isDebug(),
    seedsDir: cm.getSeedsDir(),
    stateDir: cm.getStateDir() ?? null,
    autoPackage: cm.isAutoPackage(),
    packageCommand: cm.getPackageCommand(),
    packageTimeoutMs: cm.getPackageTimeoutMs(),
    packageArgs: raw.packageArgs ?? [],
    packageEnvKeys: Object.keys(raw.packageEnv ?? {}),
    servicePackaging: redactPackaging(raw.servicePackaging ?? {}),
    lambdaRuntime: {
      enabled: cm.isLambdaRuntimeEnabled(),
      execution: cm.getLambdaExecutionMode(),
      // Raw tri-state: null = mode-dependent default (source→on, artifact→off).
      watch: raw.lambdaRuntime?.watch ?? null,
      invokePortOffset: cm.getInvokePortOffset(),
      invokeHost: cm.getInvokeHost(),
      // Residency policy: how many worker processes this stack may hold and for
      // how long. Resolved (not raw) because maxWarmWorkers' default is derived
      // from the host's RAM — the number that matters is the effective one.
      lazy: cm.isLambdaRuntimeLazy(),
      idleTimeoutMs: cm.getLambdaIdleTimeoutMs(),
      maxWarmWorkers: cm.getLambdaMaxWarmWorkers(),
    },
    serviceRuntime: raw.serviceRuntime ?? {},
    secretSeedCount: Object.keys(cm.getSecretSeeds()).length,
    // Keys whose file value is masked by an env var right now — the UI flags
    // these fields so an edit that "doesn't stick" is explained.
    envOverrides: cm.getEnvOverriddenKeys(),
    configPath: cm.getConfigPath(),
    projectRoot: cm.getProjectRoot(),
    branding: cm.getBranding(),
  };
}

router.get('/', (_req: Request, res: Response) => {
  res.json(buildConfigSnapshot(ConfigManager.getInstance()));
});

// Persist a partial config patch into the loaded config file (creating
// lss.config.json in the project root when none is loaded) and hot-reload the
// in-memory config. The human reviews and commits the file — LSS never
// touches git. Boot-materialized keys come back in restartRequired.
router.put('/', (req: Request, res: Response) => {
  const cm = ConfigManager.getInstance();
  try {
    const result = cm.updateConfig(req.body);
    // `region` is lazily consumed, so a patch that changes it takes effect at
    // once — the explorers' default has to follow or they keep answering for
    // the previous region.
    applyRegionToExplorers(cm.getRegion());
    res.json({
      config: buildConfigSnapshot(cm),
      configPath: result.path,
      restartRequired: result.restartRequired,
      envOverridden: result.envOverridden,
    });
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      res.status(400).json({ error: error.message, details: error.details });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update config' });
  }
});

// Re-read the config file from disk after a hand edit, without restarting the
// orchestrator. Lazily-consumed keys take effect immediately; the rest come
// back in restartRequired. A file that no longer parses answers 400 and keeps
// the working in-memory config untouched.
router.post('/reload', (_req: Request, res: Response) => {
  const cm = ConfigManager.getInstance();
  try {
    const result = cm.reloadFromDisk();
    applyRegionToExplorers(cm.getRegion());
    res.json({
      config: buildConfigSnapshot(cm),
      configPath: result.path,
      restartRequired: result.restartRequired,
    });
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      res.status(400).json({ error: error.message, details: error.details });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reload config' });
  }
});

// Every local port the stack exposes, so "what do I point my SDK/browser at?"
// has one answer: orchestrator, active engine (LocalStack edge or self engine),
// aoss sidecar, DynamoDB proxy, plus each registered service's HTTP API and
// Lambda invoke listeners.
router.get('/ports', (_req: Request, res: Response) => {
  const cm = ConfigManager.getInstance();
  const ports: Array<{
    name: string;
    kind: 'orchestrator' | 'engine' | 'sidecar' | 'proxy' | 'service-api' | 'service-invoke';
    port: number;
    url: string;
    description: string;
  }> = [];

  ports.push({
    name: 'Orchestrator',
    kind: 'orchestrator',
    port: cm.getServerPort(),
    url: cm.getOrchestratorUrl(),
    description: 'Dashboard UI + REST API (register, explorers, seeds)',
  });

  if (cm.isSelfEngine()) {
    const selfEngine = cm.getSelfEngineConfig();
    ports.push({
      name: 'Self engine',
      kind: 'engine',
      port: selfEngine.port,
      url: `http://localhost:${selfEngine.port}`,
      description: 'In-process AWS emulator — point SDK endpoints here',
    });
  } else {
    ports.push({
      name: `LocalStack (${cm.getMode()})`,
      kind: 'engine',
      port: cm.getLocalStackPort(),
      url: cm.getLocalStackEndpoint(),
      description: 'LocalStack edge — every AWS service on one port',
    });
    const aossSidecar = cm.getAossSidecarConfig();
    if (aossSidecar.enabled) {
      ports.push({
        name: 'OpenSearch Serverless sidecar',
        kind: 'sidecar',
        port: aossSidecar.port,
        url: aossSidecar.endpoint,
        description: 'aoss served in-process — no LocalStack edition provides it',
      });
    }
  }

  if (cm.isEnableDynamoProxy()) {
    ports.push({
      name: 'DynamoDB proxy',
      kind: 'proxy',
      port: cm.getDynamoProxyPort(),
      url: `http://localhost:${cm.getDynamoProxyPort()}`,
      description: 'Reverse proxy for tools that expect DynamoDB on a fixed port',
    });
  }

  for (const service of FunctionRegistry.getInstance().listServices()) {
    if (service.apiPort) {
      ports.push({
        name: service.name,
        kind: 'service-api',
        port: service.apiPort,
        url: `http://localhost:${service.apiPort}`,
        description: 'HTTP API (API Gateway emulation)',
      });
    }
    if (service.invokePort) {
      ports.push({
        name: service.name,
        kind: 'service-invoke',
        port: service.invokePort,
        url: `http://localhost:${service.invokePort}`,
        description: 'Lambda invoke listener (AWS SDK Invoke)',
      });
    }
  }

  res.json({ ports });
});

// Branding only — what the UI needs on boot (title, logo, theme colors).
router.get('/branding', (_req: Request, res: Response) => {
  res.json(ConfigManager.getInstance().getBranding());
});

// Serve logo/favicon files referenced by path in the config, so branding
// assets can live next to lss.config.json without a separate web server.
router.get('/branding/:asset(logo|favicon)', (req: Request, res: Response) => {
  const kind = req.params.asset as BrandingAssetKind;
  const file = ConfigManager.getInstance().getBrandingAssetFile(kind);
  if (!file) {
    res.status(404).json({ error: `No local ${kind} file configured` });
    return;
  }
  res.sendFile(file);
});

export { router as configRouter };
