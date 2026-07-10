// CatalogStore behavior: tolerant load, debounced atomic writes (tmp +
// rename), flush-forced persistence and reload across store instances.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEngineStore, EngineStoreOptions } from '../../../../src/server/engine/store/engine-store.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface QueueMeta {
  name: string;
  visibilityTimeout: number;
}

let dataDir: string;

const makeStore = (overrides: Partial<EngineStoreOptions> = {}) =>
  createEngineStore({ dataDir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, ...overrides });

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-engine-catalog-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('CatalogStore', () => {
  test('load() tolerates a missing backing file', async () => {
    const catalog = makeStore().catalog<QueueMeta>('sqs/us-east-1/queues');
    await catalog.load();
    expect(catalog.keys()).toEqual([]);
    expect(catalog.values()).toEqual([]);
    expect(catalog.get('nope')).toBeUndefined();
  });

  test('set/get/delete/keys/values round trip in memory', async () => {
    const catalog = makeStore().catalog<QueueMeta>('sqs/us-east-1/queues');
    await catalog.load();
    catalog.set('orders', { name: 'orders', visibilityTimeout: 30 });
    catalog.set('jobs', { name: 'jobs', visibilityTimeout: 60 });
    expect(catalog.get('orders')).toEqual({ name: 'orders', visibilityTimeout: 30 });
    expect(catalog.keys()).toEqual(['orders', 'jobs']);
    expect(catalog.values().map((v) => v.name)).toEqual(['orders', 'jobs']);
    expect(catalog.delete('orders')).toBe(true);
    expect(catalog.delete('orders')).toBe(false);
    expect(catalog.keys()).toEqual(['jobs']);
  });

  test('writes are debounced, then land atomically without an explicit flush', async () => {
    const catalog = makeStore().catalog<QueueMeta>('sqs/us-east-1/queues');
    await catalog.load();
    catalog.set('orders', { name: 'orders', visibilityTimeout: 30 });
    const filePath = path.join(dataDir, 'sqs/us-east-1/queues.json');
    expect(fs.existsSync(filePath)).toBe(false);
    await sleep(80);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed).toEqual({ orders: { name: 'orders', visibilityTimeout: 30 } });
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  test('flush() forces the pending write and a fresh store reloads it', async () => {
    const catalog = makeStore().catalog<QueueMeta>('sqs/us-east-1/queues');
    await catalog.load();
    catalog.set('orders', { name: 'orders', visibilityTimeout: 30 });
    catalog.set('orders', { name: 'orders', visibilityTimeout: 45 });
    catalog.delete('never-persisted');
    await catalog.flush();
    expect(fs.existsSync(path.join(dataDir, 'sqs/us-east-1/queues.json'))).toBe(true);

    const reloaded = makeStore().catalog<QueueMeta>('sqs/us-east-1/queues');
    await reloaded.load();
    await reloaded.load(); // idempotent
    expect(reloaded.get('orders')).toEqual({ name: 'orders', visibilityTimeout: 45 });
    expect(reloaded.keys()).toEqual(['orders']);
  });

  test('flush() with nothing dirty is a no-op', async () => {
    const catalog = makeStore().catalog<QueueMeta>('sqs/us-east-1/queues');
    await catalog.load();
    await catalog.flush();
    expect(fs.existsSync(path.join(dataDir, 'sqs/us-east-1/queues.json'))).toBe(false);
  });

  test('a corrupt catalog file is ignored with a warning', async () => {
    const filePath = path.join(dataDir, 'broken.json');
    fs.writeFileSync(filePath, 'not json {{{');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const catalog = makeStore().catalog<QueueMeta>('broken');
      await catalog.load();
      expect(catalog.keys()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable catalog'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  test('a relPath already ending in .json is not double-suffixed', async () => {
    const catalog = makeStore().catalog<QueueMeta>('sns/us-east-1/topics.json');
    await catalog.load();
    catalog.set('t', { name: 't', visibilityTimeout: 0 });
    await catalog.flush();
    expect(fs.existsSync(path.join(dataDir, 'sns/us-east-1/topics.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'sns/us-east-1/topics.json.json'))).toBe(false);
  });

  test('fsync mode persists the same way', async () => {
    const catalog = makeStore({ fsync: true }).catalog<QueueMeta>('sqs/us-east-1/queues');
    await catalog.load();
    catalog.set('orders', { name: 'orders', visibilityTimeout: 30 });
    await catalog.flush();
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'sqs/us-east-1/queues.json'), 'utf8'));
    expect(parsed.orders.visibilityTimeout).toBe(30);
  });
});
