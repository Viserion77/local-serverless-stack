// Unit test for the /api/config route. Mounts the router on a throwaway Express
// app and drives it with supertest; the ConfigManager singleton is stubbed and
// the real FunctionRegistry (reset per test) provides service ports for /ports.
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { configRouter } from '../../../src/server/routes/config';
import { ConfigManager, ConfigValidationError } from '../../../src/server/services/config-manager';
import { FunctionRegistry } from '../../../src/server/services/function-registry';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  return app;
}

interface StubOptions {
  proxyEnabled?: boolean;
  raw?: Record<string, unknown>;
  stateDir?: string;
}

// Stub every ConfigManager getter the snapshot reads, so route tests never
// touch the filesystem or env.
function stub(options: StubOptions = {}) {
  const cm = ConfigManager.getInstance();
  jest.spyOn(cm, 'getServerPort').mockReturnValue(14566);
  jest.spyOn(cm, 'getOrchestratorUrl').mockReturnValue('http://localhost:14566');
  jest.spyOn(cm, 'getEngineEndpoint').mockReturnValue('http://localhost:14566');
  jest.spyOn(cm, 'getSelfEngineConfig').mockReturnValue({
    port: 14566,
    dataDir: '/abs/engine',
    account: '000000000000',
    idleUnloadMs: 300000,
    memoryBudgetMb: 128,
    fsync: false,
    fallbackEndpoint: null,
    persistence: true,
    region: 'us-east-1',
  });
  jest.spyOn(cm, 'isEnableDynamoProxy').mockReturnValue(options.proxyEnabled ?? false);
  jest.spyOn(cm, 'getDynamoProxyPort').mockReturnValue(8000);
  jest.spyOn(cm, 'getRegion').mockReturnValue('us-east-1');
  jest.spyOn(cm, 'isPersistence').mockReturnValue(true);
  jest.spyOn(cm, 'isDebug').mockReturnValue(false);
  jest.spyOn(cm, 'getSeedsDir').mockReturnValue('/abs/seeds');
  jest.spyOn(cm, 'getStateDir').mockReturnValue(options.stateDir);
  jest.spyOn(cm, 'isAutoPackage').mockReturnValue(false);
  jest.spyOn(cm, 'getPackageCommand').mockReturnValue('npx serverless package');
  jest.spyOn(cm, 'getPackageTimeoutMs').mockReturnValue(300000);
  jest.spyOn(cm, 'isLambdaRuntimeEnabled').mockReturnValue(true);
  jest.spyOn(cm, 'getLambdaExecutionMode').mockReturnValue('auto');
  jest.spyOn(cm, 'getInvokePortOffset').mockReturnValue(10000);
  jest.spyOn(cm, 'getInvokeHost').mockReturnValue('127.0.0.1');
  jest.spyOn(cm, 'getSecretSeeds').mockReturnValue({ apiKey: 'secret-seed-value' } as never);
  jest.spyOn(cm, 'getEnvOverriddenKeys').mockReturnValue(['region']);
  jest.spyOn(cm, 'getConfig').mockReturnValue((options.raw ?? {}) as never);
  jest.spyOn(cm, 'getConfigPath').mockReturnValue('/abs/lss.config.json');
  jest.spyOn(cm, 'getProjectRoot').mockReturnValue('/abs');
  jest.spyOn(cm, 'getBranding').mockReturnValue({
    title: 'Local Serverless Stack',
    subtitle: 'Local development control plane',
    logoUrl: null,
    faviconUrl: null,
    defaultTheme: 'dark',
    colors: {},
    themeColors: { dark: {}, light: {} },
  });
  return cm;
}

beforeEach(() => {
  (FunctionRegistry as unknown as { instance?: FunctionRegistry }).instance = undefined;
});

afterEach(() => jest.restoreAllMocks());

describe('GET /api/config', () => {
  it('returns the full snapshot and never leaks the token, env values or secret seeds', async () => {
    stub({
      raw: {
        packageArgs: ['--g'],
        packageEnv: { DEPLOY_KEY: 'super-secret-env' },
        servicePackaging: {
          access: {
            packageCommand: 'npx sls package',
            packageArgs: ['--s'],
            packageTimeoutMs: 60000,
            packageEnv: { NPM_TOKEN: 'secret-npm-token' },
          },
          billing: {},
        },
        lambdaRuntime: { watch: true },
        serviceRuntime: { access: { apiPort: 3001 } },
      },
    });
    const res = await request(appWith()).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      serverPort: 14566,
      engine: { kind: 'self', endpoint: 'http://localhost:14566' },
      selfEngine: { port: 14566, account: '000000000000', fallbackEndpoint: null },
      dynamoProxy: { enabled: false, port: 8000 },
      region: 'us-east-1',
      stateDir: null,
      packageArgs: ['--g'],
      packageEnvKeys: ['DEPLOY_KEY'],
      servicePackaging: {
        access: {
          packageCommand: 'npx sls package',
          packageArgs: ['--s'],
          packageTimeoutMs: 60000,
          packageEnvKeys: ['NPM_TOKEN'],
        },
        billing: { packageEnvKeys: [] },
      },
      lambdaRuntime: {
        enabled: true,
        execution: 'auto',
        watch: true,
        invokePortOffset: 10000,
        invokeHost: '127.0.0.1',
      },
      serviceRuntime: { access: { apiPort: 3001 } },
      secretSeedCount: 1,
      envOverrides: ['region'],
      configPath: '/abs/lss.config.json',
      projectRoot: '/abs',
    });
    // Secret VALUES must never appear anywhere in the payload.
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain('secret-token');
    expect(payload).not.toContain('super-secret-env');
    expect(payload).not.toContain('secret-npm-token');
    expect(payload).not.toContain('secret-seed-value');
  });

  it('applies defaults for an empty raw config and surfaces stateDir when set', async () => {
    stub({ stateDir: '/abs/state' });
    const res = await request(appWith()).get('/api/config');
    expect(res.body.stateDir).toBe('/abs/state');
    expect(res.body.packageArgs).toEqual([]);
    expect(res.body.packageEnvKeys).toEqual([]);
    expect(res.body.servicePackaging).toEqual({});
    expect(res.body.serviceRuntime).toEqual({});
    // watch not configured → null = mode-dependent default.
    expect(res.body.lambdaRuntime.watch).toBeNull();
  });
});

describe('PUT /api/config', () => {
  it('persists the patch and returns the fresh snapshot with restart/env-mask info', async () => {
    const cm = stub();
    const update = jest.spyOn(cm, 'updateConfig').mockReturnValue({
      path: '/abs/lss.config.json',
      restartRequired: ['serverPort'],
      envOverridden: ['region'],
    });
    const res = await request(appWith()).put('/api/config').send({ serverPort: 3200 });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ serverPort: 3200 });
    expect(res.body.configPath).toBe('/abs/lss.config.json');
    expect(res.body.restartRequired).toEqual(['serverPort']);
    expect(res.body.envOverridden).toEqual(['region']);
    expect(res.body.config.serverPort).toBe(14566);
  });

  it('answers 400 with every detail on a validation error', async () => {
    const cm = stub();
    jest.spyOn(cm, 'updateConfig').mockImplementation(() => {
      throw new ConfigValidationError(['"debug" must be a boolean', 'unknown config key "nope"']);
    });
    const res = await request(appWith()).put('/api/config').send({ debug: 'yes', nope: 1 });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(['"debug" must be a boolean', 'unknown config key "nope"']);
    expect(res.body.error).toContain('"debug" must be a boolean');
  });

  it('answers 500 when the write fails', async () => {
    const cm = stub();
    jest.spyOn(cm, 'updateConfig').mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = await request(appWith()).put('/api/config').send({ debug: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('disk full');
  });

  it('answers 500 with a generic message for a non-Error throw', async () => {
    const cm = stub();
    jest.spyOn(cm, 'updateConfig').mockImplementation(() => {
      throw 'boom';
    });
    const res = await request(appWith()).put('/api/config').send({ debug: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update config');
  });
});

describe('POST /api/config/reload', () => {
  it('re-reads the file from disk and returns the fresh snapshot', async () => {
    const cm = stub();
    const reload = jest.spyOn(cm, 'reloadFromDisk').mockReturnValue({
      path: '/abs/lss.config.json',
      restartRequired: ['engine'],
    });
    const res = await request(appWith()).post('/api/config/reload');
    expect(res.status).toBe(200);
    expect(reload).toHaveBeenCalled();
    expect(res.body.configPath).toBe('/abs/lss.config.json');
    expect(res.body.restartRequired).toEqual(['engine']);
    expect(res.body.config.serverPort).toBe(14566);
  });

  it('answers 400 when the file no longer parses (working config kept)', async () => {
    const cm = stub();
    jest.spyOn(cm, 'reloadFromDisk').mockImplementation(() => {
      throw new ConfigValidationError(['/abs/lss.config.json is not valid JSON — fix the file and reload again']);
    });
    const res = await request(appWith()).post('/api/config/reload');
    expect(res.status).toBe(400);
    expect(res.body.details[0]).toContain('not valid JSON');
  });

  it('answers 500 on an unexpected reload failure', async () => {
    const cm = stub();
    jest.spyOn(cm, 'reloadFromDisk').mockImplementation(() => {
      throw new Error('EACCES');
    });
    const res = await request(appWith()).post('/api/config/reload');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('EACCES');
  });

  it('answers 500 with a generic message for a non-Error throw', async () => {
    const cm = stub();
    jest.spyOn(cm, 'reloadFromDisk').mockImplementation(() => {
      throw 'boom';
    });
    const res = await request(appWith()).post('/api/config/reload');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to reload config');
  });
});

describe('GET /api/config/ports', () => {
  it('lists orchestrator, engine, proxy and per-service listeners', async () => {
    stub({ proxyEnabled: true });
    FunctionRegistry.getInstance().registerService({
      name: 'svc-a',
      root: '/abs/svc-a',
      templateHash: 'h',
      lastUpdated: 1,
      status: 'registered',
      apiPort: 3001,
      invokePort: 13001,
      stage: 'offline',
      routes: [],
      authorizers: [],
    } as never);
    FunctionRegistry.getInstance().registerService({
      name: 'svc-b',
      root: '/abs/svc-b',
      templateHash: 'h',
      lastUpdated: 1,
      status: 'registered',
      routes: [],
      authorizers: [],
    } as never);
    const res = await request(appWith()).get('/api/config/ports');
    expect(res.status).toBe(200);
    expect(res.body.ports.map((p: { kind: string; name: string; port: number }) => [p.kind, p.name, p.port])).toEqual([
      ['orchestrator', 'Orchestrator', 14566],
      ['engine', 'Self engine', 14566],
      ['proxy', 'DynamoDB proxy', 8000],
      ['service-api', 'svc-a', 3001],
      ['service-invoke', 'svc-a', 13001],
    ]);
    expect(res.body.ports[1].url).toBe('http://localhost:14566');
  });

  it('omits the proxy row when the DynamoDB proxy is off', async () => {
    stub();
    const res = await request(appWith()).get('/api/config/ports');
    expect(res.body.ports.map((p: { kind: string }) => p.kind)).toEqual(['orchestrator', 'engine']);
  });
});

describe('GET /api/config/branding', () => {
  it('returns the branding block on its own', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getBranding').mockReturnValue({ title: 'Acme Cloud' } as never);
    const res = await request(appWith()).get('/api/config/branding');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'Acme Cloud' });
  });

  it('serves the configured local logo file', async () => {
    // .txt so supertest buffers the body as text — the route serves any file
    // getBrandingAssetFile resolves, the extension is irrelevant to it.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lss-branding-')), 'logo.txt');
    fs.writeFileSync(file, 'logo-bytes');
    const spy = jest.spyOn(ConfigManager.getInstance(), 'getBrandingAssetFile').mockReturnValue(file);
    const res = await request(appWith()).get('/api/config/branding/logo');
    expect(res.status).toBe(200);
    expect(res.text).toContain('logo-bytes');
    expect(spy).toHaveBeenCalledWith('logo');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('404s when no local favicon file is configured', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getBrandingAssetFile').mockReturnValue(undefined as never);
    const res = await request(appWith()).get('/api/config/branding/favicon');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('favicon');
  });
});
