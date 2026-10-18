// Query/Scan read limits: the 1 MB page cap (measured on the data READ,
// before FilterExpression, per the AWS item-size formula) and the rejection
// of strongly consistent reads on a GSI (an LSI and the base table accept
// them).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb';
import { MAX_PAGE_BYTES } from '../../../../src/server/engine/emulators/dynamodb/query';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap, AwsRequest, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-east-1';

interface PageResponse {
  Items?: AttributeMap[];
  Count: number;
  ScannedCount: number;
  LastEvaluatedKey?: AttributeMap;
}

// ~300 KB of payload per item: four of them cross the 1 MB cap.
const BIG = 'x'.repeat(300 * 1024);

describe('DynamoDB read limits', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: DynamoDbEmulator;
  const req: AwsRequest = {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'dynamodb', region: REGION, requestId: 'test-request',
  };
  const call = (op: string, input: Record<string, unknown>) => emulator.handle(op, input, req);
  const query = (input: Record<string, unknown>) => call('Query', { TableName: 'orders', ...input }) as Promise<PageResponse>;
  const scan = (input: Record<string, unknown>) => call('Scan', { TableName: 'orders', ...input }) as Promise<PageResponse>;
  const byPk = { KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: 'acme' } } };

  async function expectValidation(promise: Promise<unknown>, message: string): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AwsError);
    expect((caught as AwsError).code).toBe('ValidationException');
    expect((caught as AwsError).message).toBe(message);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ddb-limits-'));
    ctx = {
      config: {
        port: 14566, dataDir: dir, account: '000000000000', region: REGION,
        idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
      },
      store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
      bus: new EngineBus(),
      dispatcher: { invokeFunction: async () => ({ ok: true }) },
      endpoint: () => 'http://127.0.0.1:14566',
    };
    emulator = new DynamoDbEmulator(ctx);
    await call('CreateTable', {
      TableName: 'orders',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'kind', AttributeType: 'S' },
        { AttributeName: 'placedAt', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [{
        IndexName: 'byKind',
        KeySchema: [{ AttributeName: 'kind', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
      LocalSecondaryIndexes: [{
        IndexName: 'byPlacedAt',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'placedAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }],
      BillingMode: 'PAY_PER_REQUEST',
    });
    for (let i = 1; i <= 5; i++) {
      await call('PutItem', {
        TableName: 'orders',
        Item: {
          pk: { S: 'acme' }, sk: { S: `order#${i}` }, kind: { S: 'retail' },
          placedAt: { S: `2026-01-0${i}` }, blob: { S: BIG },
        },
      });
    }
  });

  afterAll(async () => {
    ctx.store.stopSweeper();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('1 MB page cap', () => {
    it('cuts a Query page once the items read reach 1 MB and resumes from the LastEvaluatedKey', async () => {
      expect(4 * BIG.length).toBeGreaterThanOrEqual(MAX_PAGE_BYTES);
      const first = await query(byPk);
      expect(first.Items!.map((i) => i.sk!.S)).toEqual(['order#1', 'order#2', 'order#3', 'order#4']);
      expect(first.ScannedCount).toBe(4);
      expect(first.LastEvaluatedKey).toEqual({ pk: { S: 'acme' }, sk: { S: 'order#4' } });

      const second = await query({ ...byPk, ExclusiveStartKey: first.LastEvaluatedKey });
      expect(second.Items!.map((i) => i.sk!.S)).toEqual(['order#5']);
      expect(second.LastEvaluatedKey).toBeUndefined();
    });

    it('measures before the filter: a page that matches nothing still stops with a LastEvaluatedKey', async () => {
      const page = await scan({ FilterExpression: 'sk = :none', ExpressionAttributeValues: { ':none': { S: 'none' } } });
      expect(page.Count).toBe(0);
      expect(page.ScannedCount).toBe(4);
      expect(page.LastEvaluatedKey).toEqual({ pk: { S: 'acme' }, sk: { S: 'order#4' } });
    });

    it('applies to Select COUNT as well', async () => {
      const page = await scan({ Select: 'COUNT' });
      expect(page.Items).toBeUndefined();
      expect(page.Count).toBe(4);
      expect(page.LastEvaluatedKey).toBeDefined();
    });

    it('carries no LastEvaluatedKey when the item reaching the cap is the last candidate', async () => {
      const page = await query({
        ...byPk,
        KeyConditionExpression: 'pk = :pk AND sk >= :from',
        ExpressionAttributeValues: { ':pk': { S: 'acme' }, ':from': { S: 'order#2' } },
      });
      expect(page.Items!.map((i) => i.sk!.S)).toEqual(['order#2', 'order#3', 'order#4', 'order#5']);
      expect(page.LastEvaluatedKey).toBeUndefined();
    });

    it('sizes an index read by the projected entry: KEYS_ONLY entries are small', async () => {
      const page = await query({
        IndexName: 'byKind',
        KeyConditionExpression: 'kind = :k',
        ExpressionAttributeValues: { ':k': { S: 'retail' } },
      });
      expect(page.Count).toBe(5);
      expect(page.LastEvaluatedKey).toBeUndefined();
    });

    it('lets a smaller Limit win over the size cap', async () => {
      const page = await query({ ...byPk, Limit: 2 });
      expect(page.Count).toBe(2);
      expect(page.LastEvaluatedKey).toEqual({ pk: { S: 'acme' }, sk: { S: 'order#2' } });
    });
  });

  describe('ConsistentRead on indexes', () => {
    const message = 'Consistent reads are not supported on global secondary indexes';

    it('rejects a consistent Query or Scan on a GSI', async () => {
      await expectValidation(query({
        IndexName: 'byKind',
        KeyConditionExpression: 'kind = :k',
        ExpressionAttributeValues: { ':k': { S: 'retail' } },
        ConsistentRead: true,
      }), message);
      await expectValidation(scan({ IndexName: 'byKind', ConsistentRead: true }), message);
    });

    it('accepts an eventually consistent GSI read', async () => {
      const page = await scan({ IndexName: 'byKind', ConsistentRead: false });
      expect(page.Count).toBe(5);
    });

    it('accepts consistent reads on an LSI and on the base table', async () => {
      const lsi = await query({
        IndexName: 'byPlacedAt',
        KeyConditionExpression: 'pk = :pk AND placedAt >= :d',
        ExpressionAttributeValues: { ':pk': { S: 'acme' }, ':d': { S: '2026-01-05' } },
        ConsistentRead: true,
      });
      expect(lsi.Items!.map((i) => i.sk!.S)).toEqual(['order#5']);
      const base = await query({ ...byPk, Limit: 1, ConsistentRead: true });
      expect(base.Count).toBe(1);
    });
  });
});
