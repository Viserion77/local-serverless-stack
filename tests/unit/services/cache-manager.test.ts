// Unit tests for CacheManager. Uses a real temp directory under os.tmpdir()
// so every fs/promises path runs for real. Catch branches are exercised with
// missing files / invalid JSON, and listServices' skip branches with a
// non-directory entry and a directory lacking metadata. Per-project scoping
// (the fix for cross-project cache contamination) is covered at the end.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CacheManager, ServiceMetadata, projectCacheSegment } from '../../../src/server/services/cache-manager';
import { ConfigManager } from '../../../src/server/services/config-manager';

let cacheDir: string;
let manager: CacheManager;

const baseMeta: Omit<ServiceMetadata, 'name'> = {
  root: '/svc',
  templateHash: 'hash123',
  lastUpdated: 1700000000,
  status: 'registered',
};

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lss-cache-'));
  manager = new CacheManager('/proj/example');
  // Point the manager at the throwaway temp dir instead of ~/.lss/...
  (manager as any).cacheDir = cacheDir;
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

describe('init', () => {
  it('creates the cache directory recursively', async () => {
    const nested = path.join(cacheDir, 'a', 'b', 'cache');
    (manager as any).cacheDir = nested;
    await manager.init();
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('saveTemplate / getTemplate', () => {
  it('saves a template + metadata and reads the template back', async () => {
    const template = { Resources: { Foo: { Type: 'AWS::SQS::Queue' } } };
    await manager.saveTemplate('svc', template, baseMeta);

    expect(await manager.getTemplate('svc')).toEqual(template);

    const meta = await manager.getMetadata('svc');
    expect(meta).toEqual({ name: 'svc', ...baseMeta });
  });

  it('round-trips the runtime metadata fields (apiPort/stage/functions/routes/authorizers)', async () => {
    const runtimeMeta: Omit<ServiceMetadata, 'name'> = {
      ...baseMeta,
      invokePort: 13001,
      apiPort: 3001,
      region: 'us-east-1',
      stage: 'offline',
      functions: [
        {
          name: 'users',
          fullName: 'svc-offline-users',
          handler: 'src/users.handler',
          runtime: 'nodejs20.x',
          memorySize: 256,
          timeout: 10,
          environment: { TABLE: 'users' },
          triggers: ['http'],
          artifact: '.serverless/svc.zip',
        },
      ],
      routes: [
        { functionName: 'users', method: 'GET', path: '/users', eventType: 'http', cors: true, authorizerName: 'users:auth' },
      ],
      authorizers: [
        {
          name: 'users:auth',
          type: 'token',
          eventType: 'http',
          payloadVersion: '1.0',
          enableSimpleResponses: false,
          identitySource: ['method.request.header.Authorization'],
          resultTtlInSeconds: 300,
          functionName: 'auth',
        },
      ],
    };

    await manager.saveTemplate('svc', {}, runtimeMeta);
    expect(await manager.getMetadata('svc')).toEqual({ name: 'svc', ...runtimeMeta });

    // updateMetadata preserves the runtime fields it does not touch.
    await manager.updateMetadata('svc', { status: 'running' });
    const updated = await manager.getMetadata('svc');
    expect(updated!.apiPort).toBe(3001);
    expect(updated!.stage).toBe('offline');
    expect(updated!.functions).toHaveLength(1);
    expect(updated!.routes![0].path).toBe('/users');
    expect(updated!.authorizers![0].name).toBe('users:auth');
  });

  it('getTemplate returns null when the template is missing (catch)', async () => {
    expect(await manager.getTemplate('does-not-exist')).toBeNull();
  });

  it('getTemplate returns null when the template is invalid JSON (catch)', async () => {
    const dir = path.join(cacheDir, 'broken');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'cloudformation-template.json'), '{ not json');
    expect(await manager.getTemplate('broken')).toBeNull();
  });
});

describe('getMetadata', () => {
  it('returns null when metadata is missing (catch)', async () => {
    expect(await manager.getMetadata('nope')).toBeNull();
  });

  it('returns the parsed metadata when present', async () => {
    await manager.saveTemplate('svc', {}, baseMeta);
    expect(await manager.getMetadata('svc')).toEqual({ name: 'svc', ...baseMeta });
  });
});

describe('updateMetadata', () => {
  it('merges updates into existing metadata', async () => {
    await manager.saveTemplate('svc', {}, baseMeta);
    await manager.updateMetadata('svc', { status: 'running', pid: 4242 });
    expect(await manager.getMetadata('svc')).toEqual({
      name: 'svc',
      ...baseMeta,
      status: 'running',
      pid: 4242,
    });
  });

  it('throws when the service is not in the cache', async () => {
    await expect(manager.updateMetadata('ghost', { status: 'stopped' })).rejects.toThrow(
      'Service ghost not found in cache',
    );
  });
});

describe('listServices', () => {
  it('returns metadata for every directory that has metadata, skipping the rest', async () => {
    // Two valid services.
    await manager.saveTemplate('alpha', {}, baseMeta);
    await manager.saveTemplate('beta', {}, { ...baseMeta, root: '/beta' });
    // A directory with no metadata.json → skipped (getMetadata catch → null).
    await fs.mkdir(path.join(cacheDir, 'empty-dir'), { recursive: true });
    // A plain file at the top level → not a directory → skipped.
    await fs.writeFile(path.join(cacheDir, 'stray.txt'), 'ignore me');

    const services = await manager.listServices();
    const names = services.map(s => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('returns [] when the cache directory does not exist (catch)', async () => {
    (manager as any).cacheDir = path.join(cacheDir, 'missing');
    expect(await manager.listServices()).toEqual([]);
  });
});

describe('deleteService', () => {
  it('removes the service directory', async () => {
    await manager.saveTemplate('svc', {}, baseMeta);
    expect(await manager.getMetadata('svc')).not.toBeNull();

    await manager.deleteService('svc');
    expect(await manager.getMetadata('svc')).toBeNull();
  });

  it('is a no-op when the service does not exist (force:true)', async () => {
    await expect(manager.deleteService('never-existed')).resolves.toBeUndefined();
  });
});

describe('per-project cache scoping', () => {
  const base = (segment: string) =>
    path.join(os.homedir(), '.lss', 'orchestrator', 'cache', 'projects', segment);

  it('scopes the cache dir to the given project root', () => {
    const m = new CacheManager('/proj/example');
    expect((m as any).cacheDir).toBe(base(projectCacheSegment('/proj/example')));
  });

  it('defaults the project root to the one the ConfigManager serves', () => {
    const m = new CacheManager();
    const projectRoot = ConfigManager.getInstance().getProjectRoot();
    expect((m as any).cacheDir).toBe(base(projectCacheSegment(projectRoot)));
  });

  it('gives two projects with the same basename distinct namespaces', () => {
    const a = projectCacheSegment('/repos/one/orders');
    const b = projectCacheSegment('/repos/two/orders');
    expect(a).not.toBe(b);
    // Same readable slug, different hash suffix.
    expect(a.startsWith('orders-')).toBe(true);
    expect(b.startsWith('orders-')).toBe(true);
  });

  it('projectCacheSegment is stable, filesystem-safe and falls back for unusable basenames', () => {
    // Stable for the same root (relative and absolute spellings included).
    expect(projectCacheSegment('/proj/My App!')).toBe(projectCacheSegment('/proj/My App!'));
    // Slugified: lowercase, no spaces/punctuation.
    expect(projectCacheSegment('/proj/My App!')).toMatch(/^my-app-[0-9a-f]{8}$/);
    // A basename with no usable characters falls back to "project".
    expect(projectCacheSegment('/')).toMatch(/^project-[0-9a-f]{8}$/);
  });

  it('keeps same-named services from different projects invisible to each other', async () => {
    // Two orchestrators, one service name — the historical contamination case.
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'lss-projects-'));
    const managerA = new CacheManager('/repos/localstack-free');
    const managerB = new CacheManager('/repos/self-hosted');
    (managerA as any).cacheDir = path.join(tmpBase, 'projects', projectCacheSegment('/repos/localstack-free'));
    (managerB as any).cacheDir = path.join(tmpBase, 'projects', projectCacheSegment('/repos/self-hosted'));
    await managerA.init();
    await managerB.init();

    await managerA.saveTemplate('orders-service', { a: 1 }, { ...baseMeta, root: '/repos/localstack-free/orders' });
    await managerB.saveTemplate('orders-service', { b: 2 }, { ...baseMeta, root: '/repos/self-hosted/orders', apiPort: 3632 });

    // Neither overwrote the other, and each orchestrator only sees its own.
    expect(await managerA.getTemplate('orders-service')).toEqual({ a: 1 });
    expect(await managerB.getTemplate('orders-service')).toEqual({ b: 2 });
    expect((await managerA.listServices()).map(s => s.root)).toEqual(['/repos/localstack-free/orders']);
    expect((await managerB.listServices()).map(s => s.root)).toEqual(['/repos/self-hosted/orders']);

    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('does not see old flat-layout entries (pre-scoping cache root)', async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'lss-legacy-'));
    // A 0.x flat entry directly under the cache root.
    await fs.mkdir(path.join(tmpBase, 'orders-service'), { recursive: true });
    await fs.writeFile(
      path.join(tmpBase, 'orders-service', 'metadata.json'),
      JSON.stringify({ name: 'orders-service', ...baseMeta }),
    );

    const m = new CacheManager('/repos/localstack-free');
    (m as any).cacheDir = path.join(tmpBase, 'projects', projectCacheSegment('/repos/localstack-free'));
    await m.init();

    expect(await m.listServices()).toEqual([]);
    expect(await m.getMetadata('orders-service')).toBeNull();

    await fs.rm(tmpBase, { recursive: true, force: true });
  });
});
