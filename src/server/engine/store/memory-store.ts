// In-memory EngineStore — what `persistence: false` actually means.
//
// The file-backed store always wrote: catalogs, WALs and blobs landed under
// dataDir even with persistence off, so tables and queues survived a restart
// and the run left a `.lss/engine/` tree behind. That breaks the two things
// the flag exists for: a guaranteed clean slate for an automated test run, and
// "turning it off leaves nothing behind".
//
// Everything here lives in the heap for the lifetime of the process. There is
// no residency governance: dehydrating would mean dropping data with nowhere
// to reload it from, so the LRU/idle machinery is deliberately inert (the
// memory budget only ever protected against unbounded file-backed hydration).
// A run that needs the budget enforced wants persistence on.

import crypto from 'crypto';
import path from 'path';
import type { CatalogStore, EngineStore, ItemTable } from './store-types.js';

class MemoryCatalog<T> implements CatalogStore<T> {
  private map = new Map<string, T>();

  load(): Promise<void> {
    return Promise.resolve();
  }

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  set(key: string, value: T): void {
    this.map.set(key, value);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  values(): T[] {
    return [...this.map.values()];
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

// Same rough accounting the JSONL table uses, so approxBytes() stays
// comparable across the two implementations.
function approxSizeOf(key: string, value: unknown): number {
  return key.length + JSON.stringify(value ?? null).length + 2;
}

class MemoryItemTable implements ItemTable {
  private map = new Map<string, unknown>();
  private bytes = 0;
  private touchedAt = Date.now();

  private touch(): void {
    this.touchedAt = Date.now();
  }

  hydrate(): Promise<void> {
    this.touch();
    return Promise.resolve();
  }

  // Always resident: there is no backing file to rehydrate from.
  isHydrated(): boolean {
    return true;
  }

  get(key: string): unknown {
    this.touch();
    return this.map.get(key);
  }

  put(key: string, value: unknown): void {
    const previous = this.map.get(key);
    if (previous !== undefined) this.bytes -= approxSizeOf(key, previous);
    this.map.set(key, value);
    this.bytes += approxSizeOf(key, value);
    this.touch();
  }

  delete(key: string): boolean {
    const previous = this.map.get(key);
    const existed = this.map.delete(key);
    if (existed) this.bytes -= approxSizeOf(key, previous);
    this.touch();
    return existed;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  entries(): IterableIterator<[string, unknown]> {
    this.touch();
    return this.map.entries();
  }

  size(): number {
    return this.map.size;
  }

  approxBytes(): number {
    return this.bytes;
  }

  lastTouchedAt(): number {
    return this.touchedAt;
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  compact(): Promise<void> {
    return Promise.resolve();
  }

  // Deliberately keeps the rows: with no snapshot on disk, dropping them here
  // would be data loss rather than eviction.
  dehydrate(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.map.clear();
    this.bytes = 0;
    return Promise.resolve();
  }
}

export class MemoryEngineStore implements EngineStore {
  private catalogs = new Map<string, MemoryCatalog<unknown>>();
  private tables = new Map<string, MemoryItemTable>();
  private blobs = new Map<string, Buffer>();

  // A virtual path: nothing is created on disk. The only caller (the graceful
  // SQS snapshot in self-backend) is already gated on persistence being on.
  dir(...segments: string[]): string {
    return path.posix.join('/lss-memory', ...segments);
  }

  catalog<T>(relPath: string): CatalogStore<T> {
    let catalog = this.catalogs.get(relPath);
    if (!catalog) {
      catalog = new MemoryCatalog<unknown>();
      this.catalogs.set(relPath, catalog);
    }
    return catalog as CatalogStore<T>;
  }

  table(relPath: string): ItemTable {
    let table = this.tables.get(relPath);
    if (!table) {
      table = new MemoryItemTable();
      this.tables.set(relPath, table);
    }
    return table;
  }

  // Content-addressed like the file store, so the S3 emulator's
  // "same bytes → same handle" de-duplication behaves identically.
  writeBlob(relDir: string, data: Buffer): Promise<string> {
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const handle = `${this.dir(relDir)}/${hash.slice(0, 2)}/${hash}`;
    if (!this.blobs.has(handle)) this.blobs.set(handle, data);
    return Promise.resolve(handle);
  }

  readBlob(blobPath: string): Promise<Buffer> {
    const data = this.blobs.get(blobPath);
    if (!data) {
      const error = new Error(`ENOENT: no such blob, open '${blobPath}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(data);
  }

  deleteBlob(blobPath: string): Promise<void> {
    this.blobs.delete(blobPath);
    return Promise.resolve();
  }

  // No files to sweep or flush — the residency machinery has nothing to do.
  startSweeper(): void {}
  stopSweeper(): void {}

  flushAll(): Promise<void> {
    return Promise.resolve();
  }
}
