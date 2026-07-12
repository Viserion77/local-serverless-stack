// Storage contracts for the self engine. Two shapes cover every emulator:
//
//   CatalogStore — small metadata catalogs (queue attributes, buses/rules,
//   function records). One JSON file, atomically rewritten (tmp + rename) on
//   a debounced flush. Loaded eagerly and kept resident: catalogs are the
//   "always resident" residency tier and stay in the low hundreds of KB.
//
//   ItemTable — keyed row data (DynamoDB items, S3 object index). JSONL
//   snapshot + append-only WAL, hydrated into a Map on first touch, streamed
//   line-by-line (never a whole-file readFileSync), dehydrated after idle or
//   under memory-budget pressure. Values are stored exactly as given (for
//   DynamoDB that means wire-format AttributeValue JSON — lossless N/B).
//
// Crash-safety bar (dev tool): a crash may lose the last flush window of
// writes; ground truth (CloudFormation + seeds) is regenerable.

export interface CatalogStore<T> {
  // Idempotent; loads the backing file once.
  load(): Promise<void>;
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): boolean;
  keys(): string[];
  values(): T[];
  // Force the debounced write to disk now (shutdown path).
  flush(): Promise<void>;
}

export interface ItemTable {
  // Idempotent; replays snapshot + WAL into memory on first call. A torn
  // final WAL line is dropped with a warning.
  hydrate(): Promise<void>;
  isHydrated(): boolean;
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  // Insertion-ordered entries (DynamoDB scan order / S3 index enumeration).
  entries(): IterableIterator<[string, unknown]>;
  size(): number;
  // Incrementally maintained rough heap estimate, used by the LRU budget.
  approxBytes(): number;
  lastTouchedAt(): number;
  // Flush buffered WAL appends to disk.
  flush(): Promise<void>;
  // Rewrite the snapshot from memory and truncate the WAL.
  compact(): Promise<void>;
  // compact + drop the in-memory map (metadata stays; rehydrates on demand).
  dehydrate(): Promise<void>;
  // Remove the backing files entirely (resource deletion).
  destroy(): Promise<void>;
}

export interface EngineStore {
  // Absolute path under the engine data dir; creates parent directories.
  dir(...segments: string[]): string;
  // Both constructors are memoizing: the same relative path returns the same
  // instance for the lifetime of the store.
  catalog<T>(relPath: string): CatalogStore<T>;
  table(relPath: string): ItemTable;
  // Content-addressed blob storage for S3 bodies (never held in the heap).
  writeBlob(relDir: string, data: Buffer): Promise<string>; // returns blob file path
  readBlob(blobPath: string): Promise<Buffer>;
  deleteBlob(blobPath: string): Promise<void>;
  // Hydration governance: called by tables on hydrate/touch; evicts
  // least-recently-used hydrated tables above the byte budget and dehydrates
  // tables idle past idleUnloadMs (single unref'd sweep timer).
  startSweeper(): void;
  stopSweeper(): void;
  // Flush every dirty catalog/table (graceful shutdown).
  flushAll(): Promise<void>;
}
