// End-to-end against the REAL SelfEngineBackend front door, through
// @aws-sdk/client-dynamodb: the read/expression semantics an SDK caller
// observes — reserved-word rejection, `<>` against a missing attribute, the
// 1 MB page cap driving the SDK paginator, ConsistentRead on a GSI — and the
// background TTL deleter wired into the backend lifecycle.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  UpdateTimeToLiveCommand,
  paginateScan,
} from '@aws-sdk/client-dynamodb';

// lambda-runtime-manager uses import.meta.url (ESM-only) which jest's CJS
// transform cannot load; nothing here invokes a function.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke: jest.fn() }) },
}));

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import type { DynamoDbEmulator } from '../../../src/server/engine/emulators/dynamodb/index.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };
const BIG = 'x'.repeat(300 * 1024);

describe('wire: DynamoDB read and expression parity (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let ddb: DynamoDBClient;

  // The backend's emulator instance (private): the TTL timer and an
  // on-demand pass, so the test needs no 30 s wait.
  type TtlProbe = Pick<DynamoDbEmulator, 'sweepExpired'> & { ttlTimer: unknown };
  const dynamoOf = (b: SelfEngineBackend) => (b as unknown as { dynamo: TtlProbe }).dynamo;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-ddb-'));
    const config: Partial<ResolvedSelfEngineConfig> = {
      port: 0, dataDir, account: '000000000000', region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    };
    backend = new SelfEngineBackend(config);
    await backend.start();
    ddb = new DynamoDBClient({ endpoint: backend.getEndpoint(), region: REGION, credentials: CREDS });
    await ddb.send(new CreateTableCommand({
      TableName: 'orders',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'customer', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [{
        IndexName: 'byCustomer',
        KeySchema: [{ AttributeName: 'customer', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      }],
      BillingMode: 'PAY_PER_REQUEST',
    }));
  });

  afterAll(async () => {
    ddb.destroy();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects a bare reserved word with the AWS ValidationException and accepts the placeholder', async () => {
    await ddb.send(new PutItemCommand({ TableName: 'orders', Item: { id: { S: 'o-1' }, status: { S: 'OPEN' } } }));
    await expect(ddb.send(new UpdateItemCommand({
      TableName: 'orders',
      Key: { id: { S: 'o-1' } },
      UpdateExpression: 'SET status = :s',
      ExpressionAttributeValues: { ':s': { S: 'PAID' } },
    }))).rejects.toMatchObject({
      name: 'ValidationException',
      message: 'Invalid UpdateExpression: Attribute name is a reserved keyword; reserved keyword: status',
    });
    const res = await ddb.send(new UpdateItemCommand({
      TableName: 'orders',
      Key: { id: { S: 'o-1' } },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': { S: 'PAID' } },
      ReturnValues: 'ALL_NEW',
    }));
    expect(res.Attributes?.status).toEqual({ S: 'PAID' });
  });

  it('passes a `<>` condition when the attribute is missing', async () => {
    await ddb.send(new PutItemCommand({ TableName: 'orders', Item: { id: { S: 'o-2' } } }));
    const res = await ddb.send(new UpdateItemCommand({
      TableName: 'orders',
      Key: { id: { S: 'o-2' } },
      UpdateExpression: 'SET revision = :r',
      ConditionExpression: 'revision <> :r',
      ExpressionAttributeValues: { ':r': { N: '1' } },
      ReturnValues: 'ALL_NEW',
    }));
    expect(res.Attributes?.revision).toEqual({ N: '1' });
    await expect(ddb.send(new UpdateItemCommand({
      TableName: 'orders',
      Key: { id: { S: 'o-2' } },
      UpdateExpression: 'SET revision = :r',
      ConditionExpression: 'revision <> :r',
      ExpressionAttributeValues: { ':r': { N: '1' } },
    }))).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('cuts Scan pages at 1 MB, and the SDK paginator still collects every item', async () => {
    for (let i = 1; i <= 5; i++) {
      await ddb.send(new PutItemCommand({
        TableName: 'orders', Item: { id: { S: `big-${i}` }, customer: { S: 'acme' }, blob: { S: BIG } },
      }));
    }
    const first = await ddb.send(new ScanCommand({ TableName: 'orders', IndexName: 'byCustomer' }));
    expect(first.Count).toBe(4);
    expect(first.LastEvaluatedKey).toBeDefined();

    const ids: string[] = [];
    let pages = 0;
    for await (const page of paginateScan({ client: ddb }, { TableName: 'orders', IndexName: 'byCustomer' })) {
      pages++;
      for (const item of page.Items ?? []) ids.push(item.id!.S!);
    }
    expect(pages).toBe(2);
    expect(ids.sort()).toEqual(['big-1', 'big-2', 'big-3', 'big-4', 'big-5']);
  });

  it('rejects ConsistentRead on a GSI', async () => {
    await expect(ddb.send(new QueryCommand({
      TableName: 'orders',
      IndexName: 'byCustomer',
      KeyConditionExpression: 'customer = :c',
      ExpressionAttributeValues: { ':c': { S: 'acme' } },
      ConsistentRead: true,
    }))).rejects.toMatchObject({
      name: 'ValidationException',
      message: 'Consistent reads are not supported on global secondary indexes',
    });
  });

  it('arms the TTL deleter with the backend and disarms it on stop', async () => {
    await ddb.send(new CreateTableCommand({
      TableName: 'sessions',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    }));
    await ddb.send(new UpdateTimeToLiveCommand({
      TableName: 'sessions', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }));
    const past = String(Math.floor(Date.now() / 1000) - 60);
    await ddb.send(new PutItemCommand({ TableName: 'sessions', Item: { id: { S: 'gone' }, expiresAt: { N: past } } }));
    await ddb.send(new PutItemCommand({ TableName: 'sessions', Item: { id: { S: 'kept' } } }));

    // ItemCount is the physical count — no read has purged anything yet.
    const describe = async () => (await ddb.send(new DescribeTableCommand({ TableName: 'sessions' }))).Table!.ItemCount;
    expect(await describe()).toBe(2);
    const dynamo = dynamoOf(backend);
    expect(dynamo.ttlTimer).not.toBeNull();
    expect(await dynamo.sweepExpired()).toBe(1);
    expect(await describe()).toBe(1);

    // A second backend shows stop() clears the timer (jest would otherwise
    // keep an interval alive — it is unref'd, but stop must still disarm it).
    const other = new SelfEngineBackend({
      port: 0, dataDir: path.join(dataDir, 'other'), account: '000000000000', region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    });
    await other.start();
    expect(dynamoOf(other).ttlTimer).not.toBeNull();
    await other.stop();
    expect(dynamoOf(other).ttlTimer).toBeNull();
  });
});
