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
  const instance = { syncService: jest.fn(), getRuntimeInfo: jest.fn(), stopRuntime: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { ServiceRegistrar, isInsideProject } from '../../../src/server/services/service-registrar';
import { ConfigManager } from '../../../src/server/services/config-manager';
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
