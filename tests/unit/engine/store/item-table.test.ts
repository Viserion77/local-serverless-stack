// ItemTable behavior: hydrate discipline, WAL buffering/flush windows, replay
// (torn tail, seq skip after compaction), compaction, dehydrate/rehydrate,
// destroy and exact approxBytes accounting.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEngineStore, EngineStoreOptions } from '../../../../src/server/engine/store/engine-store.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dataDir: string;

const makeStore = (overrides: Partial<EngineStoreOptions> = {}) =>
  createEngineStore({ dataDir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, ...overrides });

const walPath = (rel: string) => path.join(dataDir, `${rel}.wal.jsonl`);
const snapshotPath = (rel: string) => path.join(dataDir, `${rel}.snapshot.jsonl`);
const readLines = (filePath: string) => fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l !== '');

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-engine-table-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('ItemTable basics', () => {
  test('data-plane calls before hydrate() throw', () => {
    const table = makeStore().table('db/us-east-1/users/items');
    expect(table.isHydrated()).toBe(false);
    expect(() => table.get('k')).toThrow(/hydrate/);
    expect(() => table.put('k', 1)).toThrow(/hydrate/);
    expect(() => table.delete('k')).toThrow(/hydrate/);
    expect(() => table.has('k')).toThrow(/hydrate/);
    expect(() => table.entries()).toThrow(/hydrate/);
    expect(() => table.size()).toThrow(/hydrate/);
  });

  test('hydrate is idempotent and safe to call concurrently', async () => {
    const table = makeStore().table('db/t');
    await Promise.all([table.hydrate(), table.hydrate()]);
    await table.hydrate();
    expect(table.isHydrated()).toBe(true);
    expect(table.size()).toBe(0);
  });

  test('put/get/has/delete and insertion-ordered entries', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('a', 1);
    table.put('b', 2);
    table.put('c', 3);
    table.delete('b');
    table.put('b', 22); // re-insert moves to the end
    table.put('a', 11); // overwrite keeps position
    expect(table.get('a')).toBe(11);
    expect(table.has('c')).toBe(true);
    expect(table.delete('nope')).toBe(false);
    expect(table.size()).toBe(3);
    expect([...table.entries()]).toEqual([['a', 11], ['c', 3], ['b', 22]]);
    expect(table.lastTouchedAt()).toBeGreaterThan(0);
  });
});

describe('WAL flush windows', () => {
  test('appends are buffered, then visible after flush()', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('k1', { a: 1 });
    expect(fs.existsSync(walPath('db/t'))).toBe(false); // still in the buffer
    await table.flush();
    const lines = readLines(walPath('db/t'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ seq: 1, op: 'PUT', key: 'k1', item: { a: 1 } });
  });

  test('the 20 ms debounce flushes without an explicit flush()', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('k1', 'v1');
    table.delete('k1');
    await sleep(80);
    const lines = readLines(walPath('db/t')).map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { seq: 1, op: 'PUT', key: 'k1', item: 'v1' },
      { seq: 2, op: 'DEL', key: 'k1' },
    ]);
  });

  test('a 256 KB buffer flushes immediately, without the debounce timer', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      table.put('big', 'x'.repeat(300 * 1024));
      // Spin until the size-triggered flush lands the WHOLE record — a plain
      // size > 0 check can observe a partially visible append mid-write.
      let tries = 0;
      while (tries++ < 2000 && !(fs.existsSync(walPath('db/t')) && fs.statSync(walPath('db/t')).size > 300 * 1024)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(fs.statSync(walPath('db/t')).size).toBeGreaterThan(300 * 1024);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('WAL replay', () => {
  test('a fresh store replays snapshot + WAL and preserves order', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('a', 1);
    table.put('b', 2);
    table.delete('a');
    table.put('a', 3);
    await table.flush();

    const replayed = makeStore().table('db/t');
    await replayed.hydrate();
    expect([...replayed.entries()]).toEqual([['b', 2], ['a', 3]]);
    expect(replayed.size()).toBe(2);
  });

  test('a torn final WAL line is dropped with a warning and the file is repaired', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('good', 1);
    await table.flush();
    fs.appendFileSync(walPath('db/t'), '{"seq":2,"op":"PUT","key":"torn"');

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let replayed;
    try {
      replayed = makeStore().table('db/t');
      await replayed.hydrate();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('torn WAL line'));
    } finally {
      warn.mockRestore();
    }
    expect(replayed.get('good')).toBe(1);
    expect(replayed.has('torn')).toBe(false);
    // Repaired: the WAL was compacted away so new appends cannot glue onto the torn tail.
    expect(fs.readFileSync(walPath('db/t'), 'utf8')).toBe('');

    replayed.put('extra', 2);
    await replayed.flush();
    const again = makeStore().table('db/t');
    await again.hydrate();
    expect([...again.entries()]).toEqual([['good', 1], ['extra', 2]]);
  });

  test('malformed but complete WAL/snapshot lines are skipped with warnings', async () => {
    fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
    fs.writeFileSync(
      snapshotPath('db/t'),
      '{"header":true,"lastSeq":1}\n{"key":"a","item":1}\n{"noKey":true}\n"scalar"\n',
    );
    fs.writeFileSync(
      walPath('db/t'),
      '{"seq":2,"op":"PUT","key":"b","item":2}\n{"seq":"x","op":"PUT","key":"c"}\n42\n',
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const table = makeStore().table('db/t');
      await table.hydrate();
      expect([...table.entries()]).toEqual([['a', 1], ['b', 2]]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed snapshot line'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed WAL line'));
    } finally {
      warn.mockRestore();
    }
  });

  test('WAL records with seq <= the snapshot lastSeq are skipped (crash between rename and truncate)', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('a', 'fresh-a'); // seq 1
    table.put('b', 'fresh-b'); // seq 2
    await table.compact();
    // Simulate the crash window: the snapshot landed but the WAL truncation did not.
    fs.writeFileSync(
      walPath('db/t'),
      '{"seq":1,"op":"PUT","key":"a","item":"stale-a"}\n{"seq":2,"op":"PUT","key":"b","item":"stale-b"}\n',
    );

    const replayed = makeStore().table('db/t');
    await replayed.hydrate();
    expect(replayed.get('a')).toBe('fresh-a');
    expect(replayed.get('b')).toBe('fresh-b');

    // seq keeps increasing past the snapshot's lastSeq — never reused.
    replayed.put('c', 'v'); // seq 3
    await replayed.flush();
    const lines = readLines(walPath('db/t')).map((l) => JSON.parse(l));
    expect(lines[lines.length - 1]).toEqual({ seq: 3, op: 'PUT', key: 'c', item: 'v' });

    const third = makeStore().table('db/t');
    await third.hydrate();
    expect([...third.entries()]).toEqual([['a', 'fresh-a'], ['b', 'fresh-b'], ['c', 'v']]);
  });
});

describe('compaction', () => {
  test('compact() rewrites the snapshot from memory and truncates the WAL', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('a', 1); // seq 1
    table.put('b', 2); // seq 2
    table.put('c', 3); // seq 3
    await table.flush();
    table.delete('b'); // seq 4
    table.put('a', 9); // seq 5 — buffered appends are folded into the snapshot
    await table.compact();

    const lines = readLines(snapshotPath('db/t')).map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ header: true, lastSeq: 5 });
    expect(lines.slice(1)).toEqual([
      { key: 'a', item: 9 },
      { key: 'c', item: 3 },
    ]);
    expect(fs.readFileSync(walPath('db/t'), 'utf8')).toBe('');
    expect(fs.existsSync(`${snapshotPath('db/t')}.tmp`)).toBe(false);

    const replayed = makeStore().table('db/t');
    await replayed.hydrate();
    expect([...replayed.entries()]).toEqual([['a', 9], ['c', 3]]);
  });

  test('compact() before hydrate is a no-op', async () => {
    const table = makeStore().table('db/t');
    await table.compact();
    expect(fs.existsSync(snapshotPath('db/t'))).toBe(false);
  });

  // Compaction used to be reachable only through dehydrate(), which the idle
  // sweep and the LRU budget drive — so a table under sustained write load
  // never compacted and its WAL grew for the whole session (replayed in full on
  // the next boot). A hot table has to fold its own WAL back into the snapshot.
  test('a hot table self-compacts once the WAL outgrows the resident data', async () => {
    const table = makeStore().table('db/hot');
    await table.hydrate();

    // Rewrite the same few keys with a large payload: resident size stays flat
    // while the WAL keeps growing, which is exactly the runaway case.
    const payload = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 200; i++) {
      table.put(`k${i % 4}`, `${i}:${payload}`);
      await table.flush();
    }

    // Give the background compaction its turn.
    for (let i = 0; i < 50 && fs.statSync(walPath('db/hot')).size > 8 * 1024 * 1024; i++) {
      await sleep(20);
    }

    const walSize = fs.statSync(walPath('db/hot')).size;
    const totalWritten = 200 * payload.length; // ~13 MB of appends
    expect(walSize).toBeLessThan(totalWritten / 2);
    expect(fs.existsSync(snapshotPath('db/hot'))).toBe(true);

    // The fold must be lossless: a fresh store replays snapshot + WAL tail.
    const replayed = makeStore().table('db/hot');
    await replayed.hydrate();
    expect(replayed.size()).toBe(4);
    expect(replayed.get('k3')).toBe(`199:${payload}`);
  });
});

describe('dehydrate / destroy', () => {
  test('dehydrate + rehydrate round trip preserves data and resets residency metadata', async () => {
    const table = makeStore({ fsync: true }).table('db/t');
    await table.hydrate();
    table.put('a', { n: 1 });
    table.put('b', 'two');
    const bytesBefore = table.approxBytes();

    await table.dehydrate();
    expect(table.isHydrated()).toBe(false);
    expect(table.approxBytes()).toBe(0);
    expect(() => table.get('a')).toThrow(/hydrate/);

    await table.dehydrate(); // no-op when already dehydrated
    await table.hydrate();
    expect([...table.entries()]).toEqual([['a', { n: 1 }], ['b', 'two']]);
    expect(table.approxBytes()).toBe(bytesBefore);
  });

  test('destroy() removes both files and forgets the instance', async () => {
    const store = makeStore();
    const table = store.table('db/t');
    await table.hydrate();
    table.put('k', 'v');
    await table.compact();
    expect(fs.existsSync(snapshotPath('db/t'))).toBe(true);

    await table.destroy();
    expect(fs.existsSync(snapshotPath('db/t'))).toBe(false);
    expect(fs.existsSync(walPath('db/t'))).toBe(false);
    expect(table.isHydrated()).toBe(false);
    expect(() => table.put('x', 1)).toThrow(/hydrate/);

    const fresh = store.table('db/t');
    expect(fresh).not.toBe(table);
    await fresh.hydrate();
    expect(fresh.size()).toBe(0);
  });
});

describe('approxBytes accounting', () => {
  test('put/overwrite/delete arithmetic is exact', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    expect(table.approxBytes()).toBe(0);

    table.put('k1', { a: 1 }); // '{"a":1}' = 7 chars + 2 key chars
    expect(table.approxBytes()).toBe(9);

    table.put('k1', { a: 12 }); // overwrite replaces, not accumulates
    expect(table.approxBytes()).toBe(10);

    table.put('k2', 'xyz'); // '"xyz"' = 5 + 2
    expect(table.approxBytes()).toBe(17);

    table.delete('k1');
    expect(table.approxBytes()).toBe(7);
    table.delete('k2');
    expect(table.approxBytes()).toBe(0);
  });

  test('accounting is rebuilt identically from a replay', async () => {
    const table = makeStore().table('db/t');
    await table.hydrate();
    table.put('k1', { a: 12 });
    table.put('k2', 'xyz');
    table.put('k1', { a: 1 }); // replay must apply the overwrite too
    await table.flush();

    const replayed = makeStore().table('db/t');
    await replayed.hydrate();
    expect(replayed.approxBytes()).toBe(table.approxBytes());
  });
});
