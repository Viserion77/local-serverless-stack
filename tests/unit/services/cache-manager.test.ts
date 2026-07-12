// Unit tests for CacheManager. Uses a real temp directory under os.tmpdir()
// so every fs/promises path runs for real. Catch branches are exercised with
// missing files / invalid JSON, and listServices' skip branches with a
// non-directory entry and a directory lacking metadata.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CacheManager, ServiceMetadata } from '../../../src/server/services/cache-manager';

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
  manager = new CacheManager();
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

describe('constructor default cacheDir', () => {
  it('defaults the cache dir under the home directory', () => {
    const m = new CacheManager();
    expect((m as any).cacheDir).toBe(path.join(os.homedir(), '.lss', 'orchestrator', 'cache'));
  });
});
