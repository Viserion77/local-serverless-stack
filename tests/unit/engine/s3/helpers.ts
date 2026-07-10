// Test scaffolding for the S3 emulator: an in-memory EngineStore fake (blobs
// go to a temp dir, content-addressed like the real store), a context factory
// and small request/assertion helpers. The sibling engine modules are built
// concurrently, so tests deliberately depend only on the contract files.

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CatalogStore, EngineStore, ItemTable } from '../../../../src/server/engine/store/store-types.js';
import type { AwsRequest, EngineContext, S3ObjectEvent } from '../../../../src/server/engine/types.js';
import { EngineBus } from '../../../../src/server/engine/bus.js';
import { AwsError } from '../../../../src/server/engine/http/errors.js';

class MemoryCatalog<T> implements CatalogStore<T> {
  private map = new Map<string, T>();
  async load(): Promise<void> {}
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
  async flush(): Promise<void> {}
}

class MemoryTable implements ItemTable {
  private map = new Map<string, unknown>();
  private hydrated = false;
  async hydrate(): Promise<void> {
    this.hydrated = true;
  }
  isHydrated(): boolean {
    return this.hydrated;
  }
  get(key: string): unknown {
    return this.map.get(key);
  }
  put(key: string, value: unknown): void {
    this.map.set(key, value);
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries();
  }
  size(): number {
    return this.map.size;
  }
  approxBytes(): number {
    return 0;
  }
  lastTouchedAt(): number {
    return Date.now();
  }
  async flush(): Promise<void> {}
  async compact(): Promise<void> {}
  async dehydrate(): Promise<void> {}
  async destroy(): Promise<void> {
    this.map.clear();
  }
}

export class FakeEngineStore implements EngineStore {
  private catalogs = new Map<string, CatalogStore<unknown>>();
  private tables = new Map<string, ItemTable>();

  constructor(private root: string) {}

  dir(...segments: string[]): string {
    const dir = path.join(this.root, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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
      table = new MemoryTable();
      this.tables.set(relPath, table);
    }
    return table;
  }

  async writeBlob(relDir: string, data: Buffer): Promise<string> {
    const hash = createHash('sha256').update(data).digest('hex');
    const blobPath = path.join(this.dir(relDir), hash);
    fs.writeFileSync(blobPath, data);
    return blobPath;
  }

  async readBlob(blobPath: string): Promise<Buffer> {
    return fs.readFileSync(blobPath);
  }

  async deleteBlob(blobPath: string): Promise<void> {
    fs.rmSync(blobPath, { force: true });
  }

  startSweeper(): void {}
  stopSweeper(): void {}
  async flushAll(): Promise<void> {}
}

export interface TestContext {
  ctx: EngineContext;
  bus: EngineBus;
  root: string;
}

export function makeContext(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-engine-s3-'));
  const bus = new EngineBus();
  const ctx: EngineContext = {
    config: {
      port: 14566,
      dataDir: root,
      account: '000000000000',
      region: 'us-east-1',
      idleUnloadMs: 300000,
      memoryBudgetMb: 128,
      fsync: false,
      fallbackEndpoint: null,
      persistence: true,
    },
    store: new FakeEngineStore(root),
    bus,
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
  return { ctx, bus, root };
}

export function cleanupContext(context: TestContext): void {
  context.bus.removeAll();
  fs.rmSync(context.root, { recursive: true, force: true });
}

let requestCounter = 0;

export function makeReq(
  method: string,
  rawPath: string,
  options: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Buffer | string;
    region?: string;
  } = {},
): AwsRequest {
  const body =
    options.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body, 'utf8');
  return {
    method,
    rawPath,
    query: options.query ?? {},
    headers: options.headers ?? {},
    body,
    service: 's3',
    region: options.region ?? 'us-east-1',
    requestId: `test-req-${++requestCounter}`,
  };
}

export async function expectAwsError(run: Promise<unknown>, code: string, status: number): Promise<AwsError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(AwsError);
    const awsError = error as AwsError;
    expect(awsError.code).toBe(code);
    expect(awsError.status).toBe(status);
    return awsError;
  }
  throw new Error(`expected AwsError ${code}, but the call succeeded`);
}

export function bodyText(body: Buffer | string | undefined): string {
  if (body === undefined) return '';
  return typeof body === 'string' ? body : body.toString('utf8');
}

export function collectObjectEvents(bus: EngineBus): S3ObjectEvent[] {
  const events: S3ObjectEvent[] = [];
  bus.on('s3:object-event', payload => events.push(payload));
  return events;
}

// Object events are emitted via setImmediate — drain two macrotask turns.
export async function flushEvents(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)));
}
