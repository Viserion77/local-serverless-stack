// `persistence: false` swaps the file-backed store for the in-memory one.
// The contract under test is the promise the flag makes: nothing is written to
// dataDir, and a fresh store starts empty — that is what makes an automated
// test run reproducible and what keeps a disabled feature from leaving a
// `.lss/engine/` tree behind.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store.js';
import { MemoryEngineStore } from '../../../../src/server/engine/store/memory-store.js';

let dataDir: string;

const makeStore = (persistence: boolean | undefined) =>
  createEngineStore({ dataDir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, persistence });

beforeEach(() => {
  dataDir = path.join(os.tmpdir(), `lss-memory-store-${process.pid}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('createEngineStore(persistence)', () => {
  test('persistence:false selects the in-memory store and never touches dataDir', async () => {
    const store = makeStore(false);
    expect(store).toBeInstanceOf(MemoryEngineStore);

    const catalog = store.catalog<{ n: number }>('dynamodb/us-east-1/tables');
    await catalog.load();
    catalog.set('users', { n: 1 });
    await catalog.flush();
    store.table('dynamodb/us-east-1/users/items').put('k', { v: 1 });
    await store.flushAll();

    expect(fs.existsSync(dataDir)).toBe(false);
  });

  test('persistence:true (and the default) still selects the file store', () => {
    expect(makeStore(true)).not.toBeInstanceOf(MemoryEngineStore);
    expect(makeStore(undefined)).not.toBeInstanceOf(MemoryEngineStore);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  test('a second in-memory store starts empty (clean slate per run)', () => {
    makeStore(false).catalog<{ n: number }>('c').set('a', { n: 1 });
    expect(makeStore(false).catalog<{ n: number }>('c').get('a')).toBeUndefined();
  });
});

describe('MemoryEngineStore', () => {
  let store: MemoryEngineStore;

  beforeEach(() => {
    store = new MemoryEngineStore();
  });

  test('dir() returns a virtual path and creates nothing', () => {
    const dir = store.dir('s3', 'bucket', 'blobs');
    expect(dir).toBe('/lss-memory/s3/bucket/blobs');
    expect(fs.existsSync(dir)).toBe(false);
    expect(store.dir()).toBe('/lss-memory');
  });

  test('catalog: memoized, CRUD, keys/values, load/flush are no-ops', async () => {
    const catalog = store.catalog<number>('cat');
    expect(store.catalog<number>('cat')).toBe(catalog);

    await catalog.load();
    catalog.set('a', 1);
    catalog.set('b', 2);
    expect(catalog.get('a')).toBe(1);
    expect(catalog.get('missing')).toBeUndefined();
    expect(catalog.keys()).toEqual(['a', 'b']);
    expect(catalog.values()).toEqual([1, 2]);
    expect(catalog.delete('a')).toBe(true);
    expect(catalog.delete('a')).toBe(false);
    await expect(catalog.flush()).resolves.toBeUndefined();
  });

  test('table: memoized, CRUD, insertion order, size and byte accounting', async () => {
    const table = store.table('t');
    expect(store.table('t')).toBe(table);

    await table.hydrate();
    expect(table.isHydrated()).toBe(true);

    table.put('k1', { v: 'a' });
    table.put('k2', { v: 'b' });
    const afterTwo = table.approxBytes();
    expect(afterTwo).toBeGreaterThan(0);

    // Overwrite must replace, not double-count.
    table.put('k1', { v: 'aaaaaaaaaa' });
    expect(table.size()).toBe(2);
    expect(table.approxBytes()).toBeGreaterThan(afterTwo);

    expect(table.get('k1')).toEqual({ v: 'aaaaaaaaaa' });
    expect(table.has('k2')).toBe(true);
    expect(table.has('nope')).toBe(false);
    expect([...table.entries()].map(([k]) => k)).toEqual(['k1', 'k2']);

    expect(table.delete('k1')).toBe(true);
    expect(table.delete('k1')).toBe(false);
    expect(table.size()).toBe(1);
    expect(table.lastTouchedAt()).toBeGreaterThan(0);
  });

  test('table: flush/compact/dehydrate are inert and keep the rows', async () => {
    const table = store.table('t');
    table.put('k', { v: 1 });
    await table.flush();
    await table.compact();
    // No snapshot to reload from — dehydrating would be data loss, not eviction.
    await table.dehydrate();
    expect(table.isHydrated()).toBe(true);
    expect(table.get('k')).toEqual({ v: 1 });

    await table.destroy();
    expect(table.size()).toBe(0);
    expect(table.approxBytes()).toBe(0);
  });

  test('blobs are content-addressed, readable, de-duplicated and deletable', async () => {
    const body = Buffer.from('hello');
    const handle = await store.writeBlob('s3/b/blobs', body);
    expect(handle).toBe(await store.writeBlob('s3/b/blobs', Buffer.from('hello')));
    expect(await store.readBlob(handle)).toEqual(body);

    const other = await store.writeBlob('s3/b/blobs', Buffer.from('world'));
    expect(other).not.toBe(handle);

    await store.deleteBlob(handle);
    await expect(store.readBlob(handle)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('sweeper and flushAll are no-ops', async () => {
    store.startSweeper();
    store.stopSweeper();
    await expect(store.flushAll()).resolves.toBeUndefined();
  });
});
