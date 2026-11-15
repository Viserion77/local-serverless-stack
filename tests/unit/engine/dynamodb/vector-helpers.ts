// Shared fixtures for the vector-index suites (vector-schema / vector-search):
// a real DynamoDbEmulator over a throwaway on-disk store, plus small builders
// for vectors and the catalog-style table every suite starts from.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap, AttributeValue, AwsRequest, EngineContext } from '../../../../src/server/engine/types';

export const REGION = 'us-east-1';
export const ACCOUNT = '000000000000';

export function makeCtx(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ddb-vector-'))): { ctx: EngineContext; dir: string } {
  const ctx: EngineContext = {
    config: {
      port: 14566, dataDir: dir, account: ACCOUNT, region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
  return { ctx, dir };
}

export const req: AwsRequest = {
  method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
  service: 'dynamodb', region: REGION, requestId: 'test-request',
};

export async function expectAwsError(promise: Promise<unknown>, code: string, message: RegExp | string): Promise<AwsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  const error = caught as AwsError;
  expect(error.code).toBe(code);
  if (typeof message === 'string') expect(error.message).toBe(message);
  else expect(error.message).toMatch(message);
  return error;
}

// {L: [{N}, …]} — the item-side shape of an embedding.
export const vec = (...components: number[]): AttributeValue => ({ L: components.map((n) => ({ N: String(n) })) });
// The SearchVector shape: a plain list of {N}, NOT wrapped in L.
export const query = (...components: number[]): AttributeValue[] => components.map((n) => ({ N: String(n) }));

export interface Harness {
  ctx: EngineContext;
  dir: string;
  emulator: DynamoDbEmulator;
  call: (op: string, input: Record<string, unknown>) => Promise<any>;
  cleanup: () => void;
}

export function makeHarness(): Harness {
  const { ctx, dir } = makeCtx();
  const emulator = new DynamoDbEmulator(ctx);
  return {
    ctx,
    dir,
    emulator,
    call: (op, input) => emulator.handle(op, input, req),
    cleanup: () => {
      emulator.stopTtlSweeper();
      ctx.store.stopSweeper();
      ctx.bus.removeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A catalog-style table: key `productId`, a partitioned 4-dim index
// (`category` HASH, `brand` inline filter) — the PRD's example shape scaled
// down so the golden numbers stay readable.
export function catalogTable(overrides: Record<string, unknown> = {}, index: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TableName: 'catalog',
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'productId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'productId', AttributeType: 'S' },
      { AttributeName: 'category', AttributeType: 'S' },
      { AttributeName: 'brand', AttributeType: 'S' },
    ],
    VectorIndexes: [{
      IndexName: 'EmbeddingIndex',
      VectorAttribute: { AttributeName: 'embedding' },
      SearchSchema: [
        { AttributeName: 'category', SearchSchemaElementType: 'HASH' },
        { AttributeName: 'brand', SearchSchemaElementType: 'INLINE_FILTER' },
      ],
      Projection: { ProjectionType: 'ALL' },
      Dimensions: 4,
      DistanceFunction: 'COSINE',
      ...index,
    }],
    ...overrides,
  };
}

// A table with one un-partitioned index per distance function — the guide's
// worked example is evaluated against all three at once.
export function flatTable(name: string, distance: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TableName: name,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    VectorIndexes: [{
      IndexName: 'flat',
      VectorAttribute: { AttributeName: 'v' },
      Projection: { ProjectionType: 'ALL' },
      Dimensions: 4,
      DistanceFunction: distance,
      ...extra,
    }],
  };
}

export function item(productId: string, attrs: AttributeMap): AttributeMap {
  return { productId: { S: productId }, ...attrs };
}
