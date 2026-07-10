// Query/Scan parity: sort-key ranges, begins_with, ScanIndexForward,
// LEK/ESK round trips, the Limit-counts-examined-before-filter rule, GSI
// semantics (sparse items, KEYS_ONLY projection, index LEK carrying both key
// sets) and Select COUNT.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb';
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

describe('DynamoDB Query/Scan engine', () => {
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

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ddb-query-'));
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
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'total', AttributeType: 'N' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [{
        IndexName: 'byStatus',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'total', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }],
    });
    // Insertion order deliberately unsorted to prove Query sorts by sort key.
    const rows: Array<[string, string, string | undefined, string, string]> = [
      // [pk, sk, status(gsi pk, sparse), total(gsi sk), color]
      ['user#1', 'order#003', 'OPEN', '30', 'red'],
      ['user#1', 'order#001', 'OPEN', '10', 'blue'],
      ['user#1', 'order#005', 'DONE', '50', 'red'],
      ['user#1', 'order#002', undefined, '20', 'red'], // sparse: invisible in the GSI
      ['user#1', 'order#004', 'OPEN', '40', 'blue'],
      ['user#2', 'order#001', 'OPEN', '15', 'green'],
    ];
    for (const [pk, sk, status, total, color] of rows) {
      const item: AttributeMap = { pk: { S: pk }, sk: { S: sk }, total: { N: total }, color: { S: color } };
      if (status) item.status = { S: status };
      await call('PutItem', { TableName: 'orders', Item: item });
    }
  });

  afterAll(async () => {
    ctx.store.stopSweeper();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const skOf = (page: PageResponse) => page.Items!.map((i) => i.sk!.S);

  describe('Query on the base table', () => {
    it('pk equality returns the whole partition sorted by sort key', async () => {
      const page = await query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
      });
      expect(skOf(page)).toEqual(['order#001', 'order#002', 'order#003', 'order#004', 'order#005']);
      expect(page.Count).toBe(5);
      expect(page.ScannedCount).toBe(5);
      expect(page.LastEvaluatedKey).toBeUndefined();
    });

    it('supports sort-key ranges, BETWEEN and begins_with', async () => {
      const range = await query({
        KeyConditionExpression: 'pk = :pk AND sk > :from',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' }, ':from': { S: 'order#003' } },
      });
      expect(skOf(range)).toEqual(['order#004', 'order#005']);

      const between = await query({
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' }, ':a': { S: 'order#002' }, ':b': { S: 'order#004' } },
      });
      expect(skOf(between)).toEqual(['order#002', 'order#003', 'order#004']);

      const begins = await query({
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' }, ':prefix': { S: 'order#00' } },
      });
      expect(begins.Count).toBe(5);

      // Reversed partition/sort order in the expression still resolves by schema.
      const swapped = await query({
        KeyConditionExpression: 'sk = :sk AND pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' }, ':sk': { S: 'order#001' } },
      });
      expect(swapped.Count).toBe(1);
    });

    it('honors ScanIndexForward=false', async () => {
      const page = await query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
        ScanIndexForward: false,
      });
      expect(skOf(page)).toEqual(['order#005', 'order#004', 'order#003', 'order#002', 'order#001']);
    });

    it('LEK round trip: feeding LastEvaluatedKey back walks every page to exhaustion', async () => {
      const seen: string[] = [];
      let esk: AttributeMap | undefined;
      let pages = 0;
      do {
        const page = await query({
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
          Limit: 2,
          ExclusiveStartKey: esk,
        });
        seen.push(...skOf(page).map(String));
        esk = page.LastEvaluatedKey;
        pages++;
      } while (esk);
      expect(seen).toEqual(['order#001', 'order#002', 'order#003', 'order#004', 'order#005']);
      expect(pages).toBe(3); // 2 + 2 + 1 (last page under the limit → no LEK)
    });

    it('a page stopping exactly on the limit still returns a LEK; the next page is empty', async () => {
      const exact = await query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
        Limit: 5,
      });
      expect(exact.Count).toBe(5);
      expect(exact.LastEvaluatedKey).toEqual({ pk: { S: 'user#1' }, sk: { S: 'order#005' } });
      const empty = await query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
        ExclusiveStartKey: exact.LastEvaluatedKey,
      });
      expect(empty.Count).toBe(0);
      expect(empty.LastEvaluatedKey).toBeUndefined();
    });

    it('LEK round trip works backwards too', async () => {
      const first = await query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
        ScanIndexForward: false,
        Limit: 3,
      });
      expect(skOf(first)).toEqual(['order#005', 'order#004', 'order#003']);
      const second = await query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
        ScanIndexForward: false,
        ExclusiveStartKey: first.LastEvaluatedKey,
      });
      expect(skOf(second)).toEqual(['order#002', 'order#001']);
    });

    it('PINNED: Limit counts items examined BEFORE FilterExpression', async () => {
      // Partition has 5 items; the first two by sk are blue/red. With Limit 2
      // and a filter on blue, AWS examines 2 items and returns only 1.
      const page = await query({
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: 'color = :c',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' }, ':c': { S: 'blue' } },
        Limit: 2,
      });
      expect(page.ScannedCount).toBe(2);
      expect(page.Count).toBe(1);
      expect(skOf(page)).toEqual(['order#001']);
      expect(page.LastEvaluatedKey).toEqual({ pk: { S: 'user#1' }, sk: { S: 'order#002' } });
    });

    it('Select COUNT omits Items', async () => {
      const page = await query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
        Select: 'COUNT',
      });
      expect(page.Items).toBeUndefined();
      expect(page.Count).toBe(5);
      expect(page.ScannedCount).toBe(5);
    });

    it('applies ProjectionExpression', async () => {
      const page = await query({
        KeyConditionExpression: 'pk = :pk AND sk = :sk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' }, ':sk': { S: 'order#001' } },
        ProjectionExpression: 'color',
      });
      expect(page.Items).toEqual([{ color: { S: 'blue' } }]);
    });

    it('validates key conditions against the schema', async () => {
      await expect(query({
        KeyConditionExpression: 'color = :c',
        ExpressionAttributeValues: { ':c': { S: 'blue' } },
      })).rejects.toMatchObject({
        code: 'ValidationException',
        message: 'Query condition missed key schema element: pk',
      });
      await expect(query({})).rejects.toMatchObject({
        code: 'ValidationException',
        message: 'Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.',
      });
      await expect(query({
        IndexName: 'nope',
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
      })).rejects.toMatchObject({
        code: 'ValidationException',
        message: 'The table does not have the specified index: nope',
      });
      await expect(query({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { N: '7' } },
      })).rejects.toMatchObject({
        code: 'ValidationException',
        message: 'One or more parameter values were invalid: Condition parameter type does not match schema type',
      });
      let invalidStart: unknown;
      try {
        await query({
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': { S: 'user#1' } },
          ExclusiveStartKey: { pk: { S: 'user#1' } },
        });
      } catch (err) {
        invalidStart = err;
      }
      expect(invalidStart).toBeInstanceOf(AwsError);
      expect((invalidStart as AwsError).message).toBe('The provided starting key is invalid');
    });
  });

  describe('Query on a GSI (answered by base-table scan)', () => {
    it('sees only non-sparse items, sorted by the index sort key, stripped to KEYS_ONLY', async () => {
      const page = await query({
        IndexName: 'byStatus',
        KeyConditionExpression: '#s = :open',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':open': { S: 'OPEN' } },
      });
      // order#002 has no status attribute → invisible (sparse index).
      // Sorted by total (N): 10, 15, 30, 40 — numeric, not lexicographic.
      expect(page.Items!.map((i) => i.total!.N)).toEqual(['10', '15', '30', '40']);
      // KEYS_ONLY: index keys + table keys, nothing else (no color).
      expect(page.Items![0]).toEqual({
        status: { S: 'OPEN' }, total: { N: '10' }, pk: { S: 'user#1' }, sk: { S: 'order#001' },
      });
    });

    it('index LEK carries BOTH table keys and index keys and round-trips', async () => {
      const first = await query({
        IndexName: 'byStatus',
        KeyConditionExpression: '#s = :open',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':open': { S: 'OPEN' } },
        Limit: 2,
      });
      expect(first.LastEvaluatedKey).toEqual({
        status: { S: 'OPEN' }, total: { N: '15' }, pk: { S: 'user#2' }, sk: { S: 'order#001' },
      });
      const second = await query({
        IndexName: 'byStatus',
        KeyConditionExpression: '#s = :open',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':open': { S: 'OPEN' } },
        ExclusiveStartKey: first.LastEvaluatedKey,
      });
      expect(second.Items!.map((i) => i.total!.N)).toEqual(['30', '40']);
    });

    it('supports index sort-key ranges', async () => {
      const page = await query({
        IndexName: 'byStatus',
        KeyConditionExpression: '#s = :open AND total >= :min',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':open': { S: 'OPEN' }, ':min': { N: '20' } },
      });
      expect(page.Items!.map((i) => i.total!.N)).toEqual(['30', '40']);
    });
  });

  describe('Scan', () => {
    it('scans the full table with filter and honors Limit-before-filter', async () => {
      const all = await scan({});
      expect(all.Count).toBe(6);
      expect(all.ScannedCount).toBe(6);

      const filtered = await scan({
        FilterExpression: 'color = :c',
        ExpressionAttributeValues: { ':c': { S: 'red' } },
      });
      expect(filtered.Count).toBe(3);
      expect(filtered.ScannedCount).toBe(6);

      // Insertion order: first two items are red, blue → Limit 2 examines both
      // and the filter keeps one.
      const limited = await scan({
        FilterExpression: 'color = :c',
        ExpressionAttributeValues: { ':c': { S: 'red' } },
        Limit: 2,
      });
      expect(limited.ScannedCount).toBe(2);
      expect(limited.Count).toBe(1);
      expect(limited.LastEvaluatedKey).toBeDefined();
    });

    it('paginates with LEK/ESK until exhausted', async () => {
      const seen: string[] = [];
      let esk: AttributeMap | undefined;
      do {
        const page = await scan({ Limit: 4, ExclusiveStartKey: esk });
        seen.push(...page.Items!.map((i) => `${i.pk!.S}/${i.sk!.S}`));
        esk = page.LastEvaluatedKey;
      } while (esk);
      expect(seen.sort()).toEqual([
        'user#1/order#001', 'user#1/order#002', 'user#1/order#003',
        'user#1/order#004', 'user#1/order#005', 'user#2/order#001',
      ]);
      expect(seen).toHaveLength(6); // no duplicates across pages
    });

    it('accepts and ignores Segment/TotalSegments, supports ProjectionExpression and COUNT', async () => {
      const page = await scan({ Segment: 1, TotalSegments: 4, ProjectionExpression: 'pk' });
      expect(page.Count).toBe(6);
      expect(page.Items!.every((i) => Object.keys(i).length === 1 && i.pk !== undefined)).toBe(true);

      const counted = await scan({ Select: 'COUNT' });
      expect(counted.Items).toBeUndefined();
      expect(counted.Count).toBe(6);
    });

    it('scans a GSI applying sparse + projection semantics', async () => {
      const page = await scan({ IndexName: 'byStatus' });
      expect(page.Count).toBe(5); // order#002 is sparse-invisible
      expect(page.Items!.every((i) => i.color === undefined)).toBe(true);
      // Ordered by index tuple: DONE < OPEN, then total ascending.
      expect(page.Items![0].status).toEqual({ S: 'DONE' });
    });
  });
});
