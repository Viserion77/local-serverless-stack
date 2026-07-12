// EngineStore: the persistence layer of the self engine.
//
//   catalogs  — one JSON file each, atomically rewritten on a 20 ms debounce
//   tables    — JSONL snapshot + WAL (see wal.ts), hydrated on demand
//   blobs     — sha256 content-addressed files (S3 bodies), never in the heap
//
// Residency governance lives here: after any hydrate the summed approxBytes
// of hydrated tables is forced under memoryBudgetMb by dehydrating the
// least-recently-touched tables, and a single unref'd 60 s sweep dehydrates
// tables idle past idleUnloadMs. See docs/PRD_SELF_ENGINE.md §RF7.

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { CatalogStore, EngineStore, ItemTable } from './store-types.js';
import { atomicWriteFile } from './atomic.js';
import { JsonlItemTable } from './wal.js';

const CATALOG_FLUSH_DEBOUNCE_MS = 20;
const SWEEP_INTERVAL_MS = 60_000;

export interface EngineStoreOptions {
  dataDir: string;
  idleUnloadMs: number;
  memoryBudgetMb: number;
  fsync: boolean;
}

export function createEngineStore(options: EngineStoreOptions): EngineStore {
  return new FileEngineStore(options);
}

class JsonCatalog<T> implements CatalogStore<T> {
  private map = new Map<string, T>();
  private loadPromise: Promise<void> | null = null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  // Serializes rewrites; kept always-resolved (failures are logged) so a bad
  // write never wedges later flushes.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly fsync: boolean,
  ) {}

  load(): Promise<void> {
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  set(key: string, value: T): void {
    this.map.set(key, value);
    this.markDirty();
  }

  delete(key: string): boolean {
    const existed = this.map.delete(key);
    if (existed) this.markDirty();
    return existed;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  values(): T[] {
    return [...this.map.values()];
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.queueWrite();
  }

  private async doLoad(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // first boot
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, T>;
      this.map = new Map(Object.entries(parsed));
    } catch (err) {
      // Ground truth (CFN + seeds) is regenerable; a corrupt catalog should
      // not brick the engine.
      console.warn(`[engine-store] ignoring unreadable catalog ${this.filePath}:`, err);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.queueWrite().catch(() => undefined); // logged via writeChain
    }, CATALOG_FLUSH_DEBOUNCE_MS);
    this.timer.unref();
  }

  private queueWrite(): Promise<void> {
    if (!this.dirty) return this.writeChain;
    this.dirty = false;
    const data = JSON.stringify(Object.fromEntries(this.map), null, 2) + '\n';
    const next = this.writeChain.then(() => atomicWriteFile(this.filePath, data, this.fsync));
    this.writeChain = next.catch((err) => {
      console.warn(`[engine-store] catalog write failed for ${this.filePath}:`, err);
    });
    return next;
  }
}

class FileEngineStore implements EngineStore {
  private readonly dataDir: string;
  private readonly idleUnloadMs: number;
  private readonly budgetBytes: number;
  private readonly fsync: boolean;
  private catalogs = new Map<string, JsonCatalog<unknown>>();
  private tables = new Map<string, JsonlItemTable>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: EngineStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.idleUnloadMs = options.idleUnloadMs;
    this.budgetBytes = options.memoryBudgetMb * 1024 * 1024;
    this.fsync = options.fsync;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  dir(...segments: string[]): string {
    const full = path.join(this.dataDir, ...segments);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  catalog<T>(relPath: string): CatalogStore<T> {
    let catalog = this.catalogs.get(relPath);
    if (!catalog) {
      const rel = relPath.endsWith('.json') ? relPath : `${relPath}.json`;
      catalog = new JsonCatalog<unknown>(path.join(this.dataDir, rel), this.fsync);
      this.catalogs.set(relPath, catalog);
    }
    return catalog as CatalogStore<T>;
  }

  table(relPath: string): ItemTable {
    let table = this.tables.get(relPath);
    if (!table) {
      const base = path.join(this.dataDir, relPath);
      table = new JsonlItemTable({
        snapshotPath: `${base}.snapshot.jsonl`,
        walPath: `${base}.wal.jsonl`,
        fsync: this.fsync,
        hooks: {
          afterHydrate: (hydrated) => this.enforceBudget(hydrated),
          forget: () => {
            this.tables.delete(relPath);
          },
        },
      });
      this.tables.set(relPath, table);
    }
    return table;
  }

  async writeBlob(relDir: string, data: Buffer): Promise<string> {
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const blobPath = path.join(this.dataDir, relDir, hash.slice(0, 2), hash);
    // Content-addressed: an existing file already holds these exact bytes.
    if (!fs.existsSync(blobPath)) {
      await atomicWriteFile(blobPath, data, this.fsync);
    }
    return blobPath;
  }

  readBlob(blobPath: string): Promise<Buffer> {
    return fsp.readFile(blobPath);
  }

  async deleteBlob(blobPath: string): Promise<void> {
    await fsp.rm(blobPath, { force: true });
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle().catch((err) => {
        console.warn('[engine-store] idle sweep failed:', err);
      });
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([
      ...[...this.catalogs.values()].map((catalog) => catalog.flush()),
      ...[...this.tables.values()].map((table) => table.flush()),
    ]);
  }

  // Called by tables after every hydrate: dehydrate least-recently-touched
  // hydrated tables (never the one just hydrated) until under the budget.
  private async enforceBudget(justHydrated: ItemTable): Promise<void> {
    for (;;) {
      const hydrated = [...this.tables.values()].filter((table) => table.isHydrated());
      const total = hydrated.reduce((sum, table) => sum + table.approxBytes(), 0);
      if (total <= this.budgetBytes) return;
      const victim = hydrated
        .filter((table) => table !== justHydrated)
        .sort((a, b) => a.lastTouchedAt() - b.lastTouchedAt())[0];
      if (!victim) return;
      await victim.dehydrate();
    }
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleUnloadMs;
    for (const table of [...this.tables.values()]) {
      if (table.isHydrated() && table.lastTouchedAt() <= cutoff) {
        await table.dehydrate();
      }
    }
  }
}
