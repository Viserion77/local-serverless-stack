// EngineStore behavior: dir(), memoization, content-addressed blobs, the LRU
// memory budget, the idle sweeper and flushAll.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEngineStore, EngineStoreOptions } from '../../../../src/server/engine/store/engine-store.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

let dataDir: string;

const makeStore = (overrides: Partial<EngineStoreOptions> = {}) =>
  createEngineStore({ dataDir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, ...overrides });

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-engine-store-'));
});

afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('dir() and memoization', () => {
  test('dir() creates the directory and returns an absolute path', () => {
    const store = makeStore();
    const dir = store.dir('dynamodb', 'us-east-1', 'users');
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.join(path.resolve(dataDir), 'dynamodb', 'us-east-1', 'users'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(store.dir('dynamodb', 'us-east-1', 'users')).toBe(dir); // idempotent
  });

  test('catalog() and table() memoize per relative path', () => {
    const store = makeStore();
    expect(store.catalog('sqs/queues')).toBe(store.catalog('sqs/queues'));
    expect(store.catalog('sqs/queues')).not.toBe(store.catalog('sns/topics'));
    expect(store.table('db/a')).toBe(store.table('db/a'));
    expect(store.table('db/a')).not.toBe(store.table('db/b'));
  });
});

describe('blobs', () => {
  test('writeBlob/readBlob/deleteBlob round trip, content-addressed', async () => {
    const store = makeStore();
    const data = Buffer.from('hello engine blob');
    const hash = crypto.createHash('sha256').update(data).digest('hex');

    const blobPath = await store.writeBlob('s3/my-bucket/blobs', data);
    expect(blobPath).toBe(path.join(path.resolve(dataDir), 's3/my-bucket/blobs', hash.slice(0, 2), hash));
    expect(await store.readBlob(blobPath)).toEqual(data);

    // Same content → same path, and rewriting is a no-op.
    expect(await store.writeBlob('s3/my-bucket/blobs', data)).toBe(blobPath);
    expect(await store.readBlob(blobPath)).toEqual(data);

    const other = await store.writeBlob('s3/my-bucket/blobs', Buffer.from('different'));
    expect(other).not.toBe(blobPath);

    await store.deleteBlob(blobPath);
    expect(fs.existsSync(blobPath)).toBe(false);
    await expect(store.readBlob(blobPath)).rejects.toThrow();
    await expect(store.deleteBlob(blobPath)).resolves.toBeUndefined(); // idempotent
  });
});

describe('memory budget (LRU eviction on hydrate)', () => {
  // Each table holds one 298-char string under key 'k': 300 (JSON) + 1 = 301 bytes.
  const seedTables = async (names: string[]) => {
    const seeder = makeStore();
    for (const name of names) {
      const table = seeder.table(`db/${name}`);
      await table.hydrate();
      table.put('k', 'x'.repeat(298));
    }
    await seeder.flushAll();
  };

  test('hydrating past the budget dehydrates the least-recently-touched table', async () => {
    await seedTables(['ta', 'tb']);
    // Budget of 450 bytes: one table fits, two do not.
    const store = makeStore({ memoryBudgetMb: 450 / (1024 * 1024) });
    const ta = store.table('db/ta');
    await ta.hydrate();
    expect(ta.isHydrated()).toBe(true);

    const tb = store.table('db/tb');
    await tb.hydrate();
    expect(tb.isHydrated()).toBe(true); // the just-hydrated table is never the victim
    expect(ta.isHydrated()).toBe(false);

    // The evicted table rehydrates on demand with its data intact.
    await ta.hydrate();
    expect(ta.get('k')).toBe('x'.repeat(298));
  });

  test('eviction picks the least-recently-touched table, not hydration order', async () => {
    await seedTables(['ta', 'tb', 'tc']);
    // 750 bytes: two tables fit, three do not.
    const store = makeStore({ memoryBudgetMb: 750 / (1024 * 1024) });
    const ta = store.table('db/ta');
    const tb = store.table('db/tb');
    const tc = store.table('db/tc');
    await ta.hydrate();
    await sleep(10);
    await tb.hydrate();
    await sleep(10);
    ta.get('k'); // touch ta — tb becomes the LRU
    await sleep(10);
    await tc.hydrate();

    expect(tb.isHydrated()).toBe(false);
    expect(ta.isHydrated()).toBe(true);
    expect(tc.isHydrated()).toBe(true);
  });

  test('a single table over the budget stays hydrated (never evict the one just hydrated)', async () => {
    await seedTables(['ta']);
    const store = makeStore({ memoryBudgetMb: 0 });
    const ta = store.table('db/ta');
    await ta.hydrate();
    expect(ta.isHydrated()).toBe(true);
  });
});

describe('idle sweeper', () => {
  test('dehydrates tables idle past idleUnloadMs', async () => {
    const store = makeStore({ idleUnloadMs: 1000 });
    const table = store.table('db/t');
    await table.hydrate();
    table.put('k', 'v');
    await table.flush();

    jest.useFakeTimers();
    try {
      store.startSweeper();
      store.startSweeper(); // idempotent: still a single interval
      jest.advanceTimersByTime(61_000);
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => !table.isHydrated());
    store.stopSweeper();

    // The sweep dehydrated (flush + compact), so the data survived.
    await table.hydrate();
    expect(table.get('k')).toBe('v');
  });

  test('leaves recently-touched tables hydrated', async () => {
    const store = makeStore({ idleUnloadMs: 10_000_000 });
    const table = store.table('db/t');
    await table.hydrate();
    jest.useFakeTimers();
    try {
      store.startSweeper();
      jest.advanceTimersByTime(61_000);
    } finally {
      jest.useRealTimers();
    }
    await sleep(50);
    expect(table.isHydrated()).toBe(true);
    store.stopSweeper();
  });

  test('stopSweeper() halts sweeping', async () => {
    const store = makeStore({ idleUnloadMs: 1 });
    const table = store.table('db/t');
    await table.hydrate();
    jest.useFakeTimers();
    try {
      store.startSweeper();
      store.stopSweeper();
      store.stopSweeper(); // idempotent
      jest.advanceTimersByTime(300_000);
    } finally {
      jest.useRealTimers();
    }
    await sleep(50);
    expect(table.isHydrated()).toBe(true);
  });
});

describe('flushAll', () => {
  test('flushes every dirty catalog and table', async () => {
    const store = makeStore();
    const catalog = store.catalog<{ arn: string }>('sns/us-east-1/topics');
    await catalog.load();
    catalog.set('t1', { arn: 'arn:aws:sns:us-east-1:000000000000:t1' });
    const table = store.table('db/t');
    await table.hydrate();
    table.put('k', 'v');

    await store.flushAll();

    const catalogFile = path.join(dataDir, 'sns/us-east-1/topics.json');
    expect(JSON.parse(fs.readFileSync(catalogFile, 'utf8')).t1.arn).toContain(':t1');
    const walLines = fs.readFileSync(path.join(dataDir, 'db/t.wal.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(walLines[0])).toEqual({ seq: 1, op: 'PUT', key: 'k', item: 'v' });
  });
});
