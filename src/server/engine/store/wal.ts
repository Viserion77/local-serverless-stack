// ItemTable implementation: a JSONL snapshot plus an append-only WAL.
//
// On-disk layout (per table):
//   <base>.snapshot.jsonl   first line {"header":true,"lastSeq":n}, then one
//                           {"key":k,"item":v} per line
//   <base>.wal.jsonl        {"seq":n,"op":"PUT"|"DEL","key":k,"item":v}
//
// Replay = snapshot then WAL, skipping WAL records with seq <= the snapshot
// header's lastSeq — that makes the crash window between a compaction's
// rename and its WAL truncation harmless (the stale WAL is fully skipped).
// seq is monotonic for the life of the table files; it never restarts while
// a WAL record could still reference an earlier value.

import fs from 'fs';
import fsp from 'fs/promises';
import readline from 'readline';
import { appendToFile, ensureDirFor } from './atomic.js';
import type { ItemTable } from './store-types.js';

const WAL_FLUSH_DEBOUNCE_MS = 20;
const WAL_FLUSH_BYTES = 256 * 1024;
const SNAPSHOT_WRITE_CHUNK = 256 * 1024;

interface WalRecord {
  seq: number;
  op: 'PUT' | 'DEL';
  key: string;
  item?: unknown;
}

interface StoredEntry {
  item: unknown;
  bytes: number;
}

// Callbacks into the owning EngineStore: budget enforcement after a hydrate
// and instance forgetting after destroy().
export interface ItemTableHooks {
  afterHydrate(table: ItemTable): Promise<void>;
  forget(): void;
}

export interface ItemTableOptions {
  snapshotPath: string;
  walPath: string;
  fsync: boolean;
  hooks: ItemTableHooks;
}

// approxBytes accounting unit: JSON length of the item plus the key length.
// The per-entry figure is stored alongside the item so overwrite/delete
// arithmetic is exact.
function entryBytes(key: string, item: unknown): number {
  const json: string | undefined = JSON.stringify(item);
  return (json === undefined ? 0 : json.length) + key.length;
}

async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  if (!fs.existsSync(filePath)) return;
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim() !== '') yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export class JsonlItemTable implements ItemTable {
  private readonly snapshotPath: string;
  private readonly walPath: string;
  private readonly fsync: boolean;
  private readonly hooks: ItemTableHooks;

  private entriesMap: Map<string, StoredEntry> | null = null;
  private hydrating: Promise<void> | null = null;
  private seq = 0;
  private approx = 0;
  private touchedAt = 0;

  private walBuffer: string[] = [];
  private walBufferBytes = 0;
  private walTimer: NodeJS.Timeout | null = null;
  // Serializes WAL appends; kept always-resolved (failures are logged) so a
  // bad write never wedges later flushes.
  private walChain: Promise<void> = Promise.resolve();

  constructor(options: ItemTableOptions) {
    this.snapshotPath = options.snapshotPath;
    this.walPath = options.walPath;
    this.fsync = options.fsync;
    this.hooks = options.hooks;
  }

  async hydrate(): Promise<void> {
    if (this.entriesMap) return;
    if (!this.hydrating) {
      this.hydrating = this.doHydrate().finally(() => {
        this.hydrating = null;
      });
    }
    return this.hydrating;
  }

  isHydrated(): boolean {
    return this.entriesMap !== null;
  }

  get(key: string): unknown {
    const map = this.requireHydrated('get');
    this.touch();
    return map.get(key)?.item;
  }

  put(key: string, value: unknown): void {
    const map = this.requireHydrated('put');
    const bytes = entryBytes(key, value);
    const prev = map.get(key);
    if (prev) this.approx -= prev.bytes;
    map.set(key, { item: value, bytes });
    this.approx += bytes;
    this.appendWal({ seq: ++this.seq, op: 'PUT', key, item: value });
    this.touch();
  }

  delete(key: string): boolean {
    const map = this.requireHydrated('delete');
    const prev = map.get(key);
    if (!prev) return false;
    map.delete(key);
    this.approx -= prev.bytes;
    this.appendWal({ seq: ++this.seq, op: 'DEL', key });
    this.touch();
    return true;
  }

  has(key: string): boolean {
    const map = this.requireHydrated('has');
    this.touch();
    return map.has(key);
  }

  entries(): IterableIterator<[string, unknown]> {
    const map = this.requireHydrated('entries');
    this.touch();
    return (function* () {
      for (const [key, entry] of map) yield [key, entry.item] as [string, unknown];
    })();
  }

  size(): number {
    return this.requireHydrated('size').size;
  }

  approxBytes(): number {
    return this.approx;
  }

  lastTouchedAt(): number {
    return this.touchedAt;
  }

  async flush(): Promise<void> {
    await this.queueWalFlush();
  }

  async compact(): Promise<void> {
    const map = this.entriesMap;
    if (!map) return;
    // Buffered appends are superseded by the snapshot written below.
    this.dropBufferedWal();
    await this.walChain; // let in-flight appends settle before truncating
    const tmpPath = `${this.snapshotPath}.tmp`;
    await ensureDirFor(tmpPath);
    await this.writeSnapshot(tmpPath, map);
    await fsp.rename(tmpPath, this.snapshotPath);
    await fsp.writeFile(this.walPath, '');

  }

  async dehydrate(): Promise<void> {
    if (!this.entriesMap) return;
    await this.flush();
    await this.compact();
    this.entriesMap = null;
    this.approx = 0;
  }

  async destroy(): Promise<void> {
    this.dropBufferedWal();
    await this.walChain;
    this.entriesMap = null;
    this.approx = 0;
    this.seq = 0;

    await Promise.all([
      fsp.rm(this.snapshotPath, { force: true }),
      fsp.rm(`${this.snapshotPath}.tmp`, { force: true }),
      fsp.rm(this.walPath, { force: true }),
    ]);
    this.hooks.forget();
  }

  // -------------------------------------------------------------------------

  private requireHydrated(op: string): Map<string, StoredEntry> {
    if (!this.entriesMap) {
      throw new Error(`ItemTable.${op}() before hydrate() — callers must hydrate first`);
    }
    return this.entriesMap;
  }

  private touch(): void {
    this.touchedAt = Date.now();
  }

  private async doHydrate(): Promise<void> {
    const map = new Map<string, StoredEntry>();
    let approx = 0;
    let snapshotLastSeq = 0;
    let isFirstLine = true;

    for await (const line of readJsonlLines(this.snapshotPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn(`[engine-store] dropping unreadable snapshot line in ${this.snapshotPath}`);
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn(`[engine-store] dropping malformed snapshot line in ${this.snapshotPath}`);
        continue;
      }
      if (isFirstLine) {
        isFirstLine = false;
        const header = parsed as { header?: unknown; lastSeq?: unknown };
        if (header.header === true) {
          snapshotLastSeq = typeof header.lastSeq === 'number' ? header.lastSeq : 0;
          continue;
        }
      }
      const rec = parsed as { key?: unknown; item?: unknown };
      if (typeof rec.key !== 'string') {
        console.warn(`[engine-store] dropping malformed snapshot line in ${this.snapshotPath}`);
        continue;
      }
      const bytes = entryBytes(rec.key, rec.item);
      const prev = map.get(rec.key);
      if (prev) approx -= prev.bytes;
      map.set(rec.key, { item: rec.item, bytes });
      approx += bytes;
    }

    let lastSeq = snapshotLastSeq;
    let sawTornLine = false;
    for await (const line of readJsonlLines(this.walPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // The expected crash artifact: an append cut mid-line.
        console.warn(`[engine-store] dropping torn WAL line in ${this.walPath}`);
        sawTornLine = true;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn(`[engine-store] dropping malformed WAL line in ${this.walPath}`);
        continue;
      }
      const rec = parsed as Partial<WalRecord>;
      if (typeof rec.seq !== 'number' || typeof rec.key !== 'string' || (rec.op !== 'PUT' && rec.op !== 'DEL')) {
        console.warn(`[engine-store] dropping malformed WAL line in ${this.walPath}`);
        continue;
      }
      // Records already contained in the snapshot (crash between a compaction
      // rename and its WAL truncation) are skipped wholesale.
      if (rec.seq <= snapshotLastSeq) continue;
      if (rec.op === 'PUT') {
        const bytes = entryBytes(rec.key, rec.item);
        const prev = map.get(rec.key);
        if (prev) approx -= prev.bytes;
        map.set(rec.key, { item: rec.item, bytes });
        approx += bytes;
      } else {
        const prev = map.get(rec.key);
        if (prev) {
          map.delete(rec.key);
          approx -= prev.bytes;
        }
      }
      if (rec.seq > lastSeq) lastSeq = rec.seq;
    }

    this.entriesMap = map;
    this.approx = approx;
    this.seq = lastSeq;

    if (sawTornLine) {
      // Repair now: appending after a torn tail (no trailing newline) would
      // glue the next record onto it and lose both lines on the next replay.
      await this.compact();
    }
    this.touch();
    await this.hooks.afterHydrate(this);
  }

  private appendWal(rec: WalRecord): void {
    const line = JSON.stringify(rec) + '\n';
    this.walBuffer.push(line);
    this.walBufferBytes += Buffer.byteLength(line);
    if (this.walBufferBytes >= WAL_FLUSH_BYTES) {
      void this.queueWalFlush().catch(() => undefined); // logged via walChain
    } else if (!this.walTimer) {
      this.walTimer = setTimeout(() => {
        this.walTimer = null;
        void this.queueWalFlush().catch(() => undefined); // logged via walChain
      }, WAL_FLUSH_DEBOUNCE_MS);
      this.walTimer.unref();
    }
  }

  private queueWalFlush(): Promise<void> {
    if (this.walTimer) {
      clearTimeout(this.walTimer);
      this.walTimer = null;
    }
    if (this.walBuffer.length === 0) return this.walChain;
    const data = this.walBuffer.join('');
    this.walBuffer = [];
    this.walBufferBytes = 0;
    const next = this.walChain.then(() => appendToFile(this.walPath, data, this.fsync));
    this.walChain = next.catch((err) => {
      console.warn(`[engine-store] WAL append failed for ${this.walPath}:`, err);
    });
    return next;
  }

  private dropBufferedWal(): void {
    if (this.walTimer) {
      clearTimeout(this.walTimer);
      this.walTimer = null;
    }
    this.walBuffer = [];
    this.walBufferBytes = 0;
  }

  private async writeSnapshot(tmpPath: string, map: Map<string, StoredEntry>): Promise<void> {
    const handle = await fsp.open(tmpPath, 'w');
    try {
      let chunk = JSON.stringify({ header: true, lastSeq: this.seq }) + '\n';
      for (const [key, entry] of map) {
        chunk += JSON.stringify({ key, item: entry.item }) + '\n';
        if (chunk.length >= SNAPSHOT_WRITE_CHUNK) {
          await handle.write(chunk);
          chunk = '';
        }
      }
      if (chunk !== '') await handle.write(chunk);
      // Rename is the commit point: the tmp must be durable before it
      // replaces the snapshot, regardless of the fsync option.
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
