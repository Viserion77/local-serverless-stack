// Unit tests for ServiceRegistrar's boot rehydration (rehydrateAll) and the
// isInsideProject helper. The full registration flow (packaging + provisioning
// + data plane) is integration-tested and coverage-excluded; here we pin the
// rehydration semantics: every entry in the (project-scoped) cache is
// reactivated — register() accepts services outside the config file's
// directory, so rehydration must too; out-of-tree roots only get a log line.
// The runtime manager is jest.mocked — the real module forks workers and uses
// import.meta.
import path from 'path';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = {
    syncService: jest.fn(),
    getRuntimeInfo: jest.fn(() => ({ resolvedMode: 'source' })),
    stopRuntime: jest.fn(),
  };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { ServiceRegistrar, isInsideProject, resolvePorts } from '../../../src/server/services/service-registrar';
import { ConfigManager } from '../../../src/server/services/config-manager';
import { FunctionRegistry } from '../../../src/server/services/function-registry';
import { GatewayManager } from '../../../src/server/services/gateway-manager';
import { SourceWatcher } from '../../../src/server/services/source-watcher';
import type { ServiceMetadata } from '../../../src/server/services/cache-manager';

const PROJECT_ROOT = '/repos/localstack-free';

function meta(name: string, root: string): ServiceMetadata {
  return { name, root, templateHash: 'h', lastUpdated: 1, status: 'registered' };
}

describe('isInsideProject', () => {
  it('accepts the project root itself and nested roots', () => {
    expect(isInsideProject(PROJECT_ROOT, PROJECT_ROOT)).toBe(true);
    expect(isInsideProject(path.join(PROJECT_ROOT, 'services', 'orders'), PROJECT_ROOT)).toBe(true);
  });

  it('rejects siblings, parents and lookalike prefixes', () => {
    expect(isInsideProject('/repos/self-hosted/orders', PROJECT_ROOT)).toBe(false);
    expect(isInsideProject('/repos', PROJECT_ROOT)).toBe(false);
    // Prefix of the path string but a different directory.
    expect(isInsideProject('/repos/localstack-free-other/orders', PROJECT_ROOT)).toBe(false);
  });
});

describe('rehydrateAll', () => {
  let registrar: ServiceRegistrar;
  let activateSpy: jest.SpyInstance;
  let listServicesMock: jest.Mock;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue(PROJECT_ROOT);

    registrar = new ServiceRegistrar();
    activateSpy = jest.spyOn(registrar, 'activate').mockResolvedValue(undefined);
    listServicesMock = jest.fn().mockResolvedValue([]);
    // Bypass the on-disk cache: rehydrateAll only needs listServices().
    (registrar as any).cacheReady = true;
    (registrar as any).cache = { listServices: listServicesMock };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reactivates every cached entry, noting roots outside the project root', async () => {
    const mine = meta('orders-service', path.join(PROJECT_ROOT, 'orders'));
    const outOfTree = meta('billing-service', '/repos/shared/billing');
    listServicesMock.mockResolvedValue([mine, outOfTree]);

    await registrar.rehydrateAll();

    expect(activateSpy).toHaveBeenCalledTimes(2);
    expect(activateSpy).toHaveBeenCalledWith(mine);
    expect(activateSpy).toHaveBeenCalledWith(outOfTree);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(
      'Cached service "billing-service" has its root outside the project root (/repos/shared/billing) — reactivating anyway',
    ));
    expect(logSpy).toHaveBeenCalledWith('🔁 Reactivated 2 cached service(s)');
  });

  it('activates an entry whose root IS the project root, without the out-of-tree note', async () => {
    listServicesMock.mockResolvedValue([meta('root-service', PROJECT_ROOT)]);

    await registrar.rehydrateAll();

    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('outside the project root'));
  });

  it('activates an entry without a recorded root (nothing to decide on)', async () => {
    const legacy = { name: 'no-root', templateHash: 'h', lastUpdated: 1, status: 'registered' } as ServiceMetadata;
    listServicesMock.mockResolvedValue([legacy]);

    await registrar.rehydrateAll();

    expect(activateSpy).toHaveBeenCalledWith(legacy);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('outside the project root'));
  });

  it('keeps going when one activation fails and only counts successes', async () => {
    const bad = meta('bad', path.join(PROJECT_ROOT, 'bad'));
    const good = meta('good', path.join(PROJECT_ROOT, 'good'));
    listServicesMock.mockResolvedValue([bad, good]);
    activateSpy.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await registrar.rehydrateAll();

    expect(activateSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith('❌ Failed to activate cached service "bad":', expect.any(Error));
    expect(logSpy).toHaveBeenCalledWith('🔁 Reactivated 1 cached service(s)');
  });

  it('logs no Reactivated line when every activation failed', async () => {
    listServicesMock.mockResolvedValue([meta('bad', path.join(PROJECT_ROOT, 'bad'))]);
    activateSpy.mockRejectedValue(new Error('boom'));

    await registrar.rehydrateAll();

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Reactivated'));
  });
});

// The port precedence, in the one place it lives. Registration and activation
// both call it, which is what makes a config edit take effect on the next boot
// instead of being shadowed for ever by the number cached at first register.
describe('resolvePorts', () => {
  const cm = { getInvokePortOffset: () => 10000 };

  it('config wins over the recorded hints', () => {
    expect(resolvePorts(cm, { apiPort: 3072, invokePort: 13072 }, { apiPort: 3999, invokePort: 13999 }))
      .toEqual({ apiPort: 3072, invokePort: 13072 });
  });

  it('falls back to the hints when the config says nothing', () => {
    expect(resolvePorts(cm, {}, { apiPort: 3075 })).toEqual({ apiPort: 3075, invokePort: 13075 });
  });

  it('derives the invoke port from the api port, and stays empty with neither', () => {
    expect(resolvePorts(cm, { apiPort: 3078 }, {})).toEqual({ apiPort: 3078, invokePort: 13078 });
    expect(resolvePorts(cm, {}, {})).toEqual({ apiPort: undefined, invokePort: undefined });
  });
});

// Item 8 of the feedback, third ask: a `serviceRuntime` entry deleted from
// lss.config.json went on being served from the cache on every boot. A config
// that no longer exists must not keep having effect.
describe('activate re-resolves ports from the current config', () => {
  let registrar: ServiceRegistrar;
  let updateMetadata: jest.Mock;
  let registerService: jest.Mock;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    updateMetadata = jest.fn().mockResolvedValue(undefined);
    registerService = jest.fn().mockImplementation((m: ServiceMetadata) => m);
    jest.spyOn(FunctionRegistry, 'getInstance').mockReturnValue({ registerService } as never);
    jest.spyOn(GatewayManager, 'getInstance').mockReturnValue({ syncService: jest.fn() } as never);
    jest.spyOn(SourceWatcher, 'getInstance').mockReturnValue({ watch: jest.fn(), unwatch: jest.fn() } as never);
    registrar = new ServiceRegistrar();
    (registrar as any).cacheReady = true;
    (registrar as any).cache = { updateMetadata };
  });

  afterEach(() => jest.restoreAllMocks());

  function withRuntimeConfig(over: Record<string, unknown>): void {
    jest.spyOn(ConfigManager.getInstance(), 'getRuntimeConfigForService').mockReturnValue({
      enabled: true, execution: 'auto', watch: undefined, ...over,
    } as never);
  }

  it('drops back to the packaged hint when the config override is gone', async () => {
    withRuntimeConfig({});
    const cached: ServiceMetadata = {
      ...meta('api', '/repo/api'), apiPort: 30729, invokePort: 40729,
      portHints: { apiPort: 3072 }, functions: [],
    };
    await registrar.activate(cached);
    expect(updateMetadata).toHaveBeenCalledWith('api', { apiPort: 3072, invokePort: 13072 });
    expect(registerService).toHaveBeenCalledWith(expect.objectContaining({ apiPort: 3072 }));
  });

  it('applies an edited config override without a re-register', async () => {
    withRuntimeConfig({ apiPort: 3100 });
    await registrar.activate({
      ...meta('api', '/repo/api'), apiPort: 3072, invokePort: 13072, portHints: { apiPort: 3072 }, functions: [],
    });
    expect(updateMetadata).toHaveBeenCalledWith('api', { apiPort: 3100, invokePort: 13100 });
  });

  it('writes nothing when the resolution is unchanged', async () => {
    withRuntimeConfig({ apiPort: 3072 });
    await registrar.activate({
      ...meta('api', '/repo/api'), apiPort: 3072, invokePort: 13072, portHints: {}, functions: [],
    });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  // An entry cached before hints existed keeps its ports: an upgrade must not
  // move a port that is already in someone's .env and forwardPorts.
  it('treats a legacy entry without portHints as its own hint', async () => {
    withRuntimeConfig({});
    await registrar.activate({
      ...meta('api', '/repo/api'), apiPort: 3072, invokePort: 13072, functions: [],
    });
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(registerService).toHaveBeenCalledWith(expect.objectContaining({ apiPort: 3072 }));
  });
});
