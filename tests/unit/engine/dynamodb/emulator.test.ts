// DynamoDB emulator core: table lifecycle, CRUD, condition failures,
// ReturnValues, TTL laziness, batch ops, stream record shapes and the
// AWS error-name/message contract (PRD RF2.4/RF3).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap, AwsRequest, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-east-1';
const ACCOUNT = '000000000000';

function makeCtx(): { ctx: EngineContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ddb-emulator-'));
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

function makeReq(region = REGION): AwsRequest {
  return {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'dynamodb', region, requestId: 'test-request',
  };
}

async function expectAwsError(promise: Promise<unknown>, code: string, message: RegExp | string): Promise<AwsError> {
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

describe('DynamoDbEmulator', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: DynamoDbEmulator;
  const req = makeReq();
  const call = (op: string, input: Record<string, unknown>) => emulator.handle(op, input, req);

  beforeEach(() => {
    ({ ctx, dir } = makeCtx());
    emulator = new DynamoDbEmulator(ctx);
  });

  afterEach(async () => {
    ctx.store.stopSweeper();
    ctx.bus.removeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const createUsers = (extra: Record<string, unknown> = {}) => call('CreateTable', {
    TableName: 'users',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    ...extra,
  });

  const streamSpec = { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' };

  describe('table lifecycle', () => {
    it('CreateTable returns an ACTIVE description with stream fields on try 1', async () => {
      const res = await createUsers({ StreamSpecification: streamSpec }) as {
        TableDescription: Record<string, unknown>;
      };
      const desc = res.TableDescription;
      expect(desc.TableStatus).toBe('ACTIVE');
      expect(desc.TableArn).toBe(`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/users`);
      expect(desc.LatestStreamLabel).toEqual(expect.any(String));
      expect(desc.LatestStreamArn).toBe(`${desc.TableArn}/stream/${desc.LatestStreamLabel}`);
      expect(desc.StreamSpecification).toEqual(streamSpec);
      expect(emulator.getStreamArn(REGION, 'users')).toBe(desc.LatestStreamArn);
    });

    it('CreateTable on an existing table throws ResourceInUseException', async () => {
      await createUsers();
      await expectAwsError(createUsers(), 'ResourceInUseException', 'Table already exists: users');
    });

    it('DescribeTable exposes the full ORM introspection shape', async () => {
      await createUsers({
        StreamSpecification: streamSpec,
        GlobalSecondaryIndexes: [{
          IndexName: 'byEmail',
          KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'email', AttributeType: 'S' },
        ],
      });
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'profile' }, email: { S: 'a@b.c' } } });
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#2' }, sk: { S: 'profile' } } });
      const res = await call('DescribeTable', { TableName: 'users' }) as { Table: Record<string, unknown> };
      const table = res.Table;
      expect(table.TableStatus).toBe('ACTIVE');
      expect(table.CreationDateTime).toEqual(expect.any(Number));
      expect(table.ProvisionedThroughput).toEqual({ NumberOfDecreasesToday: 0, ReadCapacityUnits: 0, WriteCapacityUnits: 0 });
      expect(table.BillingModeSummary).toMatchObject({ BillingMode: 'PAY_PER_REQUEST' });
      expect(table.ItemCount).toBe(2);
      expect(table.TableSizeBytes).toBeGreaterThan(0);
      expect(table.TableId).toMatch(/^[0-9a-f-]{36}$/);
      expect(table.DeletionProtectionEnabled).toBe(false);
      const gsis = table.GlobalSecondaryIndexes as Array<Record<string, unknown>>;
      expect(gsis).toHaveLength(1);
      expect(gsis[0]).toMatchObject({
        IndexName: 'byEmail',
        IndexStatus: 'ACTIVE',
        IndexArn: `${table.TableArn}/index/byEmail`,
        ItemCount: 1, // sparse: the second item has no email attribute
      });
      expect(table.LatestStreamArn).toBe(`${table.TableArn}/stream/${table.LatestStreamLabel}`);
    });

    it('DescribeTable of a missing table uses the named not-found message', async () => {
      await expectAwsError(
        call('DescribeTable', { TableName: 'ghost' }),
        'ResourceNotFoundException',
        'Requested resource not found: Table: ghost not found',
      );
    });

    it('DeleteTable removes the table and its items', async () => {
      await createUsers();
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'a' } } });
      const res = await call('DeleteTable', { TableName: 'users' }) as { TableDescription: Record<string, unknown> };
      expect(res.TableDescription.TableStatus).toBe('DELETING');
      await expectAwsError(call('DescribeTable', { TableName: 'users' }), 'ResourceNotFoundException', /users not found/);
      // Recreating starts empty.
      await createUsers();
      const scan = await call('Scan', { TableName: 'users' }) as { Count: number };
      expect(scan.Count).toBe(0);
    });

    it('ListTables sorts and paginates with ExclusiveStartTableName/Limit', async () => {
      for (const name of ['zeta', 'alpha', 'mid1', 'mid2']) {
        await call('CreateTable', {
          TableName: name,
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
        });
      }
      const page1 = await call('ListTables', { Limit: 2 }) as Record<string, unknown>;
      expect(page1.TableNames).toEqual(['alpha', 'mid1']);
      expect(page1.LastEvaluatedTableName).toBe('mid1');
      const page2 = await call('ListTables', { Limit: 2, ExclusiveStartTableName: 'mid1' }) as Record<string, unknown>;
      expect(page2.TableNames).toEqual(['mid2', 'zeta']);
      expect(page2.LastEvaluatedTableName).toBeUndefined();
      const beyond = await call('ListTables', { ExclusiveStartTableName: 'zeta' }) as Record<string, unknown>;
      expect(beyond.TableNames).toEqual([]);
    });

    it('unknown operations throw NotImplemented', async () => {
      await expectAwsError(call('TransactWriteItems', {}), 'NotImplemented', /dynamodb\.TransactWriteItems is not implemented/);
    });
  });

  describe('TTL configuration', () => {
    it('persists TTL and rejects re-enable/re-disable with the regex the provisioner swallows', async () => {
      await createUsers();
      await call('UpdateTimeToLive', { TableName: 'users', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } });
      const described = await call('DescribeTimeToLive', { TableName: 'users' }) as { TimeToLiveDescription: Record<string, unknown> };
      expect(described.TimeToLiveDescription).toEqual({ TimeToLiveStatus: 'ENABLED', AttributeName: 'expiresAt' });

      const again = await expectAwsError(
        call('UpdateTimeToLive', { TableName: 'users', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }),
        'ValidationException',
        /TimeToLive is already enabled/,
      );
      expect(again.message).toMatch(/already (enabled|disabled)/i);

      await call('UpdateTimeToLive', { TableName: 'users', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: false } });
      await expectAwsError(
        call('UpdateTimeToLive', { TableName: 'users', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: false } }),
        'ValidationException',
        /TimeToLive is already disabled/,
      );
      const disabled = await call('DescribeTimeToLive', { TableName: 'users' }) as { TimeToLiveDescription: Record<string, unknown> };
      expect(disabled.TimeToLiveDescription).toEqual({ TimeToLiveStatus: 'DISABLED' });
    });
  });

  describe('item CRUD', () => {
    beforeEach(async () => {
      await createUsers();
    });

    it('PutItem/GetItem round-trips wire values losslessly', async () => {
      const item: AttributeMap = {
        pk: { S: 'u#1' }, sk: { S: 'profile' },
        balance: { N: '10.500' },
        blob: { B: Buffer.from('bytes').toString('base64') },
        tags: { SS: ['a', 'b'] },
      };
      await call('PutItem', { TableName: 'users', Item: item });
      const res = await call('GetItem', { TableName: 'users', Key: { pk: { S: 'u#1' }, sk: { S: 'profile' } } }) as { Item?: AttributeMap };
      expect(res.Item).toEqual(item);
    });

    it('canonical keys are numeric for N ("01" reads back "1")', async () => {
      await call('CreateTable', {
        TableName: 'nums',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'N' }],
        BillingMode: 'PAY_PER_REQUEST',
      });
      await call('PutItem', { TableName: 'nums', Item: { id: { N: '01' }, v: { S: 'x' } } });
      const res = await call('GetItem', { TableName: 'nums', Key: { id: { N: '1.0' } } }) as { Item?: AttributeMap };
      expect(res.Item?.v).toEqual({ S: 'x' });
    });

    it('missing key attribute / wrong key shape throw the pinned messages', async () => {
      await expectAwsError(
        call('GetItem', { TableName: 'users', Key: { pk: { S: 'u#1' } } }),
        'ValidationException',
        'One of the required keys was not given a value',
      );
      await expectAwsError(
        call('GetItem', { TableName: 'users', Key: { pk: { S: 'u#1' }, sk: { N: '1' } } }),
        'ValidationException',
        'The provided key element does not match the schema',
      );
      await expectAwsError(
        call('GetItem', { TableName: 'users', Key: { pk: { S: 'u#1' }, sk: { S: 'a' }, extra: { S: 'nope' } } }),
        'ValidationException',
        'The provided key element does not match the schema',
      );
      await expectAwsError(
        call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' } } }),
        'ValidationException',
        'One or more parameter values were invalid: Missing the key sk in the item',
      );
      await expectAwsError(
        call('GetItem', { TableName: 'missing', Key: { pk: { S: 'x' }, sk: { S: 'y' } } }),
        'ResourceNotFoundException',
        'Requested resource not found',
      );
    });

    it('ConditionExpression failure throws ConditionalCheckFailedException with optional old item', async () => {
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '1' } } });
      await expectAwsError(
        call('PutItem', {
          TableName: 'users',
          Item: { pk: { S: 'u#1' }, sk: { S: 'a' } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
        'ConditionalCheckFailedException',
        'The conditional request failed',
      );
      const withItem = await expectAwsError(
        call('DeleteItem', {
          TableName: 'users',
          Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
          ConditionExpression: 'v > :min',
          ExpressionAttributeValues: { ':min': { N: '5' } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
        'ConditionalCheckFailedException',
        'The conditional request failed',
      );
      expect(withItem.extra).toEqual({ Item: { pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '1' } } });
      // Untouched by the failed writes.
      const res = await call('GetItem', { TableName: 'users', Key: { pk: { S: 'u#1' }, sk: { S: 'a' } } }) as { Item?: AttributeMap };
      expect(res.Item?.v).toEqual({ N: '1' });
    });

    it('honors ReturnValues across Put/Delete/Update', async () => {
      const v1: AttributeMap = { pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '1' }, keep: { S: 'yes' } };
      await call('PutItem', { TableName: 'users', Item: v1 });
      const putOld = await call('PutItem', {
        TableName: 'users',
        Item: { pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '2' } },
        ReturnValues: 'ALL_OLD',
      }) as { Attributes?: AttributeMap };
      expect(putOld.Attributes).toEqual(v1);

      const updated = await call('UpdateItem', {
        TableName: 'users',
        Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
        UpdateExpression: 'SET v = v + :one',
        ExpressionAttributeValues: { ':one': { N: '1' } },
        ReturnValues: 'UPDATED_NEW',
      }) as { Attributes?: AttributeMap };
      expect(updated.Attributes).toEqual({ v: { N: '3' } });

      const updatedOld = await call('UpdateItem', {
        TableName: 'users',
        Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
        UpdateExpression: 'SET v = :ten',
        ExpressionAttributeValues: { ':ten': { N: '10' } },
        ReturnValues: 'UPDATED_OLD',
      }) as { Attributes?: AttributeMap };
      expect(updatedOld.Attributes).toEqual({ v: { N: '3' } });

      const allNew = await call('UpdateItem', {
        TableName: 'users',
        Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
        UpdateExpression: 'REMOVE keep',
        ReturnValues: 'ALL_NEW',
      }) as { Attributes?: AttributeMap };
      expect(allNew.Attributes).toEqual({ pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '10' } });

      const deleted = await call('DeleteItem', {
        TableName: 'users',
        Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
        ReturnValues: 'ALL_OLD',
      }) as { Attributes?: AttributeMap };
      expect(deleted.Attributes).toEqual({ pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '10' } });

      await expectAwsError(
        call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'a' } }, ReturnValues: 'ALL_NEW' }),
        'ValidationException',
        'Return values set to invalid value',
      );
    });

    it('UpdateItem on a missing item creates it with the key merged in', async () => {
      const res = await call('UpdateItem', {
        TableName: 'users',
        Key: { pk: { S: 'u#9' }, sk: { S: 'new' } },
        UpdateExpression: 'SET greeting = :g',
        ExpressionAttributeValues: { ':g': { S: 'hello' } },
        ReturnValues: 'ALL_NEW',
      }) as { Attributes?: AttributeMap };
      expect(res.Attributes).toEqual({ pk: { S: 'u#9' }, sk: { S: 'new' }, greeting: { S: 'hello' } });
      const got = await call('GetItem', { TableName: 'users', Key: { pk: { S: 'u#9' }, sk: { S: 'new' } } }) as { Item?: AttributeMap };
      expect(got.Item).toEqual(res.Attributes);
    });

    it('UpdateItem cannot modify key attributes', async () => {
      await expectAwsError(
        call('UpdateItem', {
          TableName: 'users',
          Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
          UpdateExpression: 'SET sk = :x',
          ExpressionAttributeValues: { ':x': { S: 'other' } },
        }),
        'ValidationException',
        /Cannot update attribute sk\. This attribute is part of the key/,
      );
    });

    it('enforces the 400KB item size limit', async () => {
      await expectAwsError(
        call('PutItem', {
          TableName: 'users',
          Item: { pk: { S: 'u#big' }, sk: { S: 'a' }, blob: { S: 'x'.repeat(400 * 1024) } },
        }),
        'ValidationException',
        'Item size has exceeded the maximum allowed size',
      );
    });

    it('rejects legacy parameters with a pointer to the expression equivalent', async () => {
      await expectAwsError(
        call('UpdateItem', {
          TableName: 'users',
          Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
          AttributeUpdates: { v: { Action: 'PUT', Value: { N: '1' } } },
        }),
        'ValidationException',
        /legacy parameter AttributeUpdates.*UpdateExpression/,
      );
      await expectAwsError(
        call('Query', { TableName: 'users', KeyConditions: {} }),
        'ValidationException',
        /legacy parameter KeyConditions.*KeyConditionExpression/,
      );
    });

    it('unused ExpressionAttributeValues throw the AWS request-level error', async () => {
      await expectAwsError(
        call('PutItem', {
          TableName: 'users',
          Item: { pk: { S: 'u#1' }, sk: { S: 'a' } },
          ExpressionAttributeValues: { ':orphan': { S: 'x' } },
        }),
        'ValidationException',
        /ExpressionAttributeValues unused in expressions: keys: \{:orphan\}/,
      );
    });

    it('returns zeroed ConsumedCapacity only when requested', async () => {
      const withCapacity = await call('PutItem', {
        TableName: 'users',
        Item: { pk: { S: 'u#1' }, sk: { S: 'a' } },
        ReturnConsumedCapacity: 'TOTAL',
      }) as Record<string, unknown>;
      expect(withCapacity.ConsumedCapacity).toEqual({ TableName: 'users', CapacityUnits: 0 });
      const without = await call('GetItem', {
        TableName: 'users',
        Key: { pk: { S: 'u#1' }, sk: { S: 'a' } },
        ConsistentRead: true,
      }) as Record<string, unknown>;
      expect(without.ConsumedCapacity).toBeUndefined();
    });
  });

  describe('batch operations', () => {
    beforeEach(async () => {
      await createUsers();
    });

    it('BatchWriteItem applies puts and deletes; BatchGetItem reads them back', async () => {
      await call('BatchWriteItem', {
        RequestItems: {
          users: [
            { PutRequest: { Item: { pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '1' } } } },
            { PutRequest: { Item: { pk: { S: 'u#2' }, sk: { S: 'b' }, v: { N: '2' } } } },
          ],
        },
      });
      const removed = await call('BatchWriteItem', {
        RequestItems: { users: [{ DeleteRequest: { Key: { pk: { S: 'u#2' }, sk: { S: 'b' } } } }] },
      }) as Record<string, unknown>;
      expect(removed.UnprocessedItems).toEqual({});

      const got = await call('BatchGetItem', {
        RequestItems: {
          users: {
            Keys: [
              { pk: { S: 'u#1' }, sk: { S: 'a' } },
              { pk: { S: 'u#2' }, sk: { S: 'b' } },
            ],
            ProjectionExpression: 'pk, v',
          },
        },
      }) as { Responses: Record<string, AttributeMap[]>; UnprocessedKeys: object };
      expect(got.UnprocessedKeys).toEqual({});
      expect(got.Responses.users).toEqual([{ pk: { S: 'u#1' }, v: { N: '1' } }]);
    });

    it('rejects oversized batches with the AWS message', async () => {
      const entries = Array.from({ length: 26 }, (_, i) => ({
        PutRequest: { Item: { pk: { S: `u#${i}` }, sk: { S: 'a' } } },
      }));
      await expectAwsError(
        call('BatchWriteItem', { RequestItems: { users: entries } }),
        'ValidationException',
        'Too many items requested for the BatchWriteItem call',
      );
      const keys = Array.from({ length: 101 }, (_, i) => ({ pk: { S: `u#${i}` }, sk: { S: 'a' } }));
      await expectAwsError(
        call('BatchGetItem', { RequestItems: { users: { Keys: keys } } }),
        'ValidationException',
        'Too many items requested for the BatchGetItem call',
      );
    });
  });

  describe('TTL laziness and streams', () => {
    it('filters expired items on read, removes them and emits a Service REMOVE', async () => {
      await createUsers({ StreamSpecification: streamSpec });
      await call('UpdateTimeToLive', { TableName: 'users', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } });
      const past = Math.floor(Date.now() / 1000) - 60;
      const future = Math.floor(Date.now() / 1000) + 3600;
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'dead' }, expiresAt: { N: String(past) } } });
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'alive' }, expiresAt: { N: String(future) } } });
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'no-ttl-attr' } } });

      const query = await call('Query', {
        TableName: 'users',
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: 'u#1' } },
      }) as { Items: AttributeMap[]; Count: number };
      expect(query.Items.map((i) => i.sk!.S)).toEqual(['alive', 'no-ttl-attr']);

      // Physically removed: visible in the stream as a Service-initiated REMOVE.
      const { records } = emulator.readStream(REGION, 'users', undefined, 100);
      const remove = (records as Array<Record<string, any>>).find((r) => r.eventName === 'REMOVE');
      expect(remove).toBeDefined();
      expect(remove!.userIdentity).toEqual({ type: 'Service', principalId: 'dynamodb.amazonaws.com' });
      expect(remove!.dynamodb.Keys).toEqual({ pk: { S: 'u#1' }, sk: { S: 'dead' } });
      expect(remove!.dynamodb.OldImage.expiresAt).toEqual({ N: String(past) });

      // GetItem path also expires lazily.
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#2' }, sk: { S: 'dead' }, expiresAt: { N: String(past) } } });
      const got = await call('GetItem', { TableName: 'users', Key: { pk: { S: 'u#2' }, sk: { S: 'dead' } } }) as { Item?: AttributeMap };
      expect(got.Item).toBeUndefined();
    });

    it('emits INSERT/MODIFY/REMOVE records with NEW_AND_OLD_IMAGES and bus events', async () => {
      await createUsers({ StreamSpecification: streamSpec });
      const busEvents: Array<{ region: string; tableName: string }> = [];
      ctx.bus.on('dynamo:stream-appended', (payload) => busEvents.push(payload));

      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '1' } } });
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'a' }, v: { N: '2' } } });
      await call('DeleteItem', { TableName: 'users', Key: { pk: { S: 'u#1' }, sk: { S: 'a' } } });

      expect(busEvents).toEqual([
        { region: REGION, tableName: 'users' },
        { region: REGION, tableName: 'users' },
        { region: REGION, tableName: 'users' },
      ]);

      const arn = emulator.getStreamArn(REGION, 'users')!;
      const { records, lastSeq } = emulator.readStream(REGION, 'users', undefined, 100);
      expect(records).toHaveLength(3);
      const [insert, modify, remove] = records as Array<Record<string, any>>;

      expect(insert).toMatchObject({
        eventName: 'INSERT', eventVersion: '1.1', eventSource: 'aws:dynamodb', awsRegion: REGION, eventSourceARN: arn,
      });
      expect(insert.eventID).toMatch(/^[0-9a-f-]{36}$/);
      expect(insert.dynamodb.ApproximateCreationDateTime).toEqual(expect.any(Number));
      expect(insert.dynamodb.StreamViewType).toBe('NEW_AND_OLD_IMAGES');
      expect(insert.dynamodb.SequenceNumber).toMatch(/^0+1$/);
      expect(insert.dynamodb.SizeBytes).toBeGreaterThan(0);
      expect(insert.dynamodb.Keys).toEqual({ pk: { S: 'u#1' }, sk: { S: 'a' } });
      expect(insert.dynamodb.NewImage.v).toEqual({ N: '1' });
      expect(insert.dynamodb.OldImage).toBeUndefined();

      expect(modify.eventName).toBe('MODIFY');
      expect(modify.dynamodb.OldImage.v).toEqual({ N: '1' });
      expect(modify.dynamodb.NewImage.v).toEqual({ N: '2' });

      expect(remove.eventName).toBe('REMOVE');
      expect(remove.dynamodb.OldImage.v).toEqual({ N: '2' });
      expect(remove.dynamodb.NewImage).toBeUndefined();
      expect(lastSeq).toBe(remove.dynamodb.SequenceNumber);

      // Cursor semantics: afterSeq resumes strictly after; empty read keeps cursor.
      const afterFirst = emulator.readStream(REGION, 'users', insert.dynamodb.SequenceNumber, 1);
      expect((afterFirst.records[0] as Record<string, any>).eventName).toBe('MODIFY');
      expect(afterFirst.lastSeq).toBe(modify.dynamodb.SequenceNumber);
      const drained = emulator.readStream(REGION, 'users', lastSeq, 10);
      expect(drained.records).toEqual([]);
      expect(drained.lastSeq).toBeUndefined();
    });

    it('tables without streams produce no records and no ARN', async () => {
      await createUsers();
      await call('PutItem', { TableName: 'users', Item: { pk: { S: 'u#1' }, sk: { S: 'a' } } });
      expect(emulator.getStreamArn(REGION, 'users')).toBeUndefined();
      expect(emulator.readStream(REGION, 'users', undefined, 10)).toEqual({ records: [], lastSeq: undefined });
    });

    it('primeRegion re-registers stream ARNs from the persisted catalog', async () => {
      await createUsers({ StreamSpecification: streamSpec });
      const arn = emulator.getStreamArn(REGION, 'users');
      await ctx.store.flushAll();
      // A fresh emulator over the same store simulates an engine restart.
      const reborn = new DynamoDbEmulator({ ...ctx });
      expect(reborn.getStreamArn(REGION, 'users')).toBeUndefined();
      await reborn.primeRegion(REGION);
      expect(reborn.getStreamArn(REGION, 'users')).toBe(arn);
    });
  });
});
