// End-to-end against the REAL SelfEngineBackend front door: `POST /_lss/reset`
// wipes every emulator's state in place — no process restart, no port rebind —
// in persistent and in-memory mode, on the engine's own listener and embedded
// behind another server (the orchestrator's single-port mode). State is seeded
// and read back through the AWS SDKs, the way a service would see it.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { DynamoDBClient, CreateTableCommand, ListTablesCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, CreateQueueCommand, ListQueuesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client, CreateBucketCommand, ListBucketsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, CreateTopicCommand, ListTopicsCommand } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutRuleCommand, ListRulesCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, CreateSecretCommand, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';

// lambda-runtime-manager uses import.meta.url (ESM-only), which jest's CJS
// transform cannot load; nothing here invokes a function.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke: jest.fn() }) },
}));

import { SelfEngineBackend, wipeDataDir } from '../../../src/server/engine/backends/self-backend.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

function makeConfig(dataDir: string, persistence: boolean): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: REGION,
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence,
  };
}

function reset(endpoint: string, headers: Record<string, string> = { 'x-lss-confirm-reset': 'true' }) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const url = new URL(endpoint);
    const req = http.request(
      { hostname: '127.0.0.1', port: url.port, path: '/_lss/reset', method: 'POST', headers, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Every family of state the engine keeps: tables + items, queues + messages,
// buckets + objects, topics, rules, secrets.
async function seedEverything(endpoint: string): Promise<void> {
  const cfg = { endpoint, region: REGION, credentials: CREDS };
  const dynamo = new DynamoDBClient(cfg);
  await dynamo.send(new CreateTableCommand({
    TableName: 'acme-orders',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  }));
  await dynamo.send(new PutItemCommand({ TableName: 'acme-orders', Item: { pk: { S: 'o-1' } } }));
  const sqs = new SQSClient(cfg);
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'acme-jobs' }));
  await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'hello' }));
  const s3 = new S3Client({ ...cfg, forcePathStyle: true });
  await s3.send(new CreateBucketCommand({ Bucket: 'acme-assets' }));
  await s3.send(new PutObjectCommand({ Bucket: 'acme-assets', Key: 'a.txt', Body: 'x' }));
  await new SNSClient(cfg).send(new CreateTopicCommand({ Name: 'acme-events' }));
  await new EventBridgeClient(cfg).send(new PutRuleCommand({ Name: 'acme-rule', EventPattern: '{"source":["acme"]}' }));
  await new SecretsManagerClient(cfg).send(new CreateSecretCommand({ Name: 'acme/db', SecretString: 's3cr3t' }));
}

async function countEverything(endpoint: string): Promise<Record<string, number>> {
  const cfg = { endpoint, region: REGION, credentials: CREDS };
  const tables = await new DynamoDBClient(cfg).send(new ListTablesCommand({}));
  const queues = await new SQSClient(cfg).send(new ListQueuesCommand({}));
  const buckets = await new S3Client({ ...cfg, forcePathStyle: true }).send(new ListBucketsCommand({}));
  const topics = await new SNSClient(cfg).send(new ListTopicsCommand({}));
  const rules = await new EventBridgeClient(cfg).send(new ListRulesCommand({}));
  const secrets = await new SecretsManagerClient(cfg).send(new ListSecretsCommand({}));
  return {
    tables: tables.TableNames?.length ?? 0,
    queues: queues.QueueUrls?.length ?? 0,
    buckets: buckets.Buckets?.length ?? 0,
    topics: topics.Topics?.length ?? 0,
    rules: rules.Rules?.length ?? 0,
    secrets: secrets.SecretList?.length ?? 0,
  };
}

const EMPTY = { tables: 0, queues: 0, buckets: 0, topics: 0, rules: 0, secrets: 0 };
const SEEDED = { tables: 1, queues: 1, buckets: 1, topics: 1, rules: 1, secrets: 1 };

describe('wire: engine reset (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-engine-reset-'));
  });

  afterEach(async () => {
    await backend?.stop();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  test.each([true, false])('wipes every emulator in place (persistence: %s), on the same port', async persistence => {
    backend = new SelfEngineBackend(makeConfig(dataDir, persistence));
    await backend.start();
    const endpoint = backend.getEndpoint();
    await seedEverything(endpoint);
    expect(await countEverything(endpoint)).toEqual(SEEDED);

    const res = await reset(endpoint);
    expect(res).toEqual({ status: 200, body: { status: 'reset', engine: 'self', persistence } });
    expect(backend.getEndpoint()).toBe(endpoint);
    expect(backend.isRunning()).toBe(true);
    expect(await countEverything(endpoint)).toEqual(EMPTY);
    if (persistence) expect(fs.readdirSync(dataDir).some(e => e.startsWith('dynamodb'))).toBe(false);

    // The rebuilt engine is fully functional: the same names can be reused.
    await seedEverything(endpoint);
    expect(await countEverything(endpoint)).toEqual(SEEDED);
  });

  test('a persistent reset survives a restart: nothing comes back from disk', async () => {
    backend = new SelfEngineBackend(makeConfig(dataDir, true));
    await backend.start();
    await seedEverything(backend.getEndpoint());
    expect((await reset(backend.getEndpoint())).status).toBe(200);
    await backend.stop();

    backend = new SelfEngineBackend(makeConfig(dataDir, true));
    await backend.start();
    expect(await countEverything(backend.getEndpoint())).toEqual(EMPTY);
  });

  test('embedded behind another listener, the handler captured at boot keeps working across a reset', async () => {
    backend = new SelfEngineBackend(makeConfig(dataDir, false));
    const handler = await backend.startEmbedded();
    expect(backend.getRequestHandler()).toBe(handler);
    const server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await seedEverything(endpoint);
      // Two concurrent resets share one rebuild, and a request sent while it
      // runs is parked until the fresh engine is up rather than failing.
      const [a, b, counts] = await Promise.all([reset(endpoint), reset(endpoint), countEverything(endpoint)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(counts.tables === 0 || counts.tables === 1).toBe(true);
      expect(await countEverything(endpoint)).toEqual(EMPTY);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('refuses an unconfirmed reset and leaves the state alone', async () => {
    backend = new SelfEngineBackend(makeConfig(dataDir, false));
    await backend.start();
    await seedEverything(backend.getEndpoint());
    const res = await reset(backend.getEndpoint(), {});
    expect(res.status).toBe(400);
    expect(res.body.__type).toBe('MissingConfirmation');
    expect(await countEverything(backend.getEndpoint())).toEqual(SEEDED);
  });

  test('reset() before start() is an error, and getRequestHandler() is null', async () => {
    backend = new SelfEngineBackend(makeConfig(dataDir, false));
    expect(backend.getRequestHandler()).toBeNull();
    await expect(backend.reset()).rejects.toThrow('not running');
  });
});

describe('wipeDataDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wipe-'));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  test('deletes the contents and keeps the directory', async () => {
    fs.mkdirSync(path.join(dir, 'dynamodb', 'tables'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sqs-messages.snapshot.json'), '{}');
    await wipeDataDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('is a no-op for a data dir that does not exist yet', async () => {
    await expect(wipeDataDir(path.join(dir, 'never-created'))).resolves.toBeUndefined();
  });

  test('propagates other read errors (the path is a file)', async () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, '');
    await expect(wipeDataDir(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  // selfEngine.dataDir is user-configurable: a typo must not delete a project.
  test.each([
    ['a filesystem root', () => path.parse(process.cwd()).root],
    ['the home directory', () => os.homedir()],
    ['the working directory', () => process.cwd()],
  ])('refuses %s', async (_label, target) => {
    await expect(wipeDataDir(target())).rejects.toThrow('must be a dedicated engine directory');
  });

  test('refuses a directory that holds project files, deleting nothing', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    await expect(wipeDataDir(dir)).rejects.toThrow('it contains package.json');
    expect(fs.readdirSync(dir).sort()).toEqual(['keep.txt', 'package.json']);
  });
});
