// SelfEngineBackend boot/shutdown: front door on an ephemeral port, health
// aliases, a real wire operation (DynamoDB CreateTable), EADDRINUSE fail-fast
// naming the port, SQS message snapshot persistence across restarts and
// event-source rearm from persisted metadata.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// The real LambdaRuntimeManager uses import.meta (cannot load under ts-jest);
// the dispatcher pulls it in, so it is mocked at module level.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// Plain node:http with no agent so no keep-alive socket outlives a test.
function request(
  endpoint: string,
  method: string,
  pathName: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: pathName,
        method,
        headers: { connection: 'close', ...headers },
        agent: false,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function target(endpoint: string, operation: string, payload: unknown): Promise<HttpResult> {
  return request(
    endpoint,
    'POST',
    '/',
    { 'x-amz-target': operation, 'content-type': 'application/x-amz-json-1.0' },
    JSON.stringify(payload),
  );
}

function makeConfig(dataDir: string, overrides: Partial<ResolvedSelfEngineConfig> = {}): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, // ephemeral for tests
    dataDir,
    account: '000000000000',
    region: 'us-east-1',
    idleUnloadMs: 300_000,
    memoryBudgetMb: 64,
    fsync: false,
    fallbackEndpoint: null,
    persistence: false,
    ...overrides,
  };
}

describe('SelfEngineBackend', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-self-backend-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  test('boots on an ephemeral port, serves health + a wire operation, stops cleanly', async () => {
    const backend = new SelfEngineBackend(makeConfig(dataDir));
    expect(backend.kind).toBe('self');
    expect(backend.isRunning()).toBe(false);

    const startedAt = Date.now();
    await backend.start();
    try {
      // No sleeps, no health polling: boot is fast even on a loaded CI box.
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(backend.isRunning()).toBe(true);
      const endpoint = backend.getEndpoint();
      expect(endpoint).toMatch(/^http:\/\/localhost:\d+$/);
      expect(endpoint.endsWith(':0')).toBe(false); // the real bound port

      const health = await request(endpoint, 'GET', '/_localstack/health');
      expect(health.status).toBe(200);
      const healthBody = JSON.parse(health.body);
      expect(healthBody.services.dynamodb).toBe('available');
      expect(healthBody.edition).toBe('self');

      const lssHealth = await request(endpoint, 'GET', '/_lss/health');
      expect(lssHealth.status).toBe(200);

      const created = await target(endpoint, 'DynamoDB_20120810.CreateTable', {
        TableName: 'boot-check',
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      });
      expect(created.status).toBe(200);
      expect(JSON.parse(created.body).TableDescription.TableStatus).toBe('ACTIVE');

      const config = backend.getConfig();
      expect(config).toEqual({
        endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      const detail = backend.healthDetail();
      expect(detail.port).toBe(Number(new URL(endpoint).port));
      expect(detail.services).toEqual(['dynamodb', 'sqs', 'sns', 's3', 'events', 'lambda', 'sts', 'aoss']);
      expect(detail.eventSourceLoops).toEqual({ sqs: 0, streams: 0 });
      expect(detail.scheduleRules).toBe(0);
    } finally {
      await backend.stop();
    }
    expect(backend.isRunning()).toBe(false);
    await expect(request(backend.getEndpoint(), 'GET', '/_lss/health')).rejects.toThrow();
    // Idempotent stop.
    await backend.stop();
  });

  test('EADDRINUSE fails fast naming the port and hinting at a real LocalStack', async () => {
    const squatter = http.createServer(() => undefined);
    await new Promise<void>(resolve => squatter.listen(0, resolve));
    const port = (squatter.address() as AddressInfo).port;
    const backend = new SelfEngineBackend(makeConfig(dataDir, { port }));
    try {
      await expect(backend.start()).rejects.toThrow(new RegExp(`port ${port}.*LocalStack`, 's'));
      expect(backend.isRunning()).toBe(false);
    } finally {
      await new Promise<void>(resolve => squatter.close(() => resolve()));
    }
  });

  test('persistence snapshots SQS messages on stop and restores them on the next boot', async () => {
    const first = new SelfEngineBackend(makeConfig(dataDir, { persistence: true }));
    await first.start();
    const endpoint1 = first.getEndpoint();
    const queueUrl = JSON.parse(
      (await target(endpoint1, 'AmazonSQS.CreateQueue', { QueueName: 'survivor' })).body,
    ).QueueUrl as string;
    const sent = await target(endpoint1, 'AmazonSQS.SendMessage', {
      QueueUrl: queueUrl,
      MessageBody: 'outlive-the-restart',
    });
    expect(sent.status).toBe(200);
    await first.stop();
    expect(fs.existsSync(path.join(dataDir, 'sqs-messages.snapshot.json'))).toBe(true);

    const second = new SelfEngineBackend(makeConfig(dataDir, { persistence: true }));
    await second.start();
    try {
      const endpoint2 = second.getEndpoint();
      const url2 = JSON.parse(
        (await target(endpoint2, 'AmazonSQS.GetQueueUrl', { QueueName: 'survivor' })).body,
      ).QueueUrl as string;
      const received = await target(endpoint2, 'AmazonSQS.ReceiveMessage', {
        QueueUrl: url2,
        MaxNumberOfMessages: 1,
      });
      expect(received.status).toBe(200);
      const messages = JSON.parse(received.body).Messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].Body).toBe('outlive-the-restart');
    } finally {
      await second.stop();
    }
  });

  test('persisted metadata rearms event delivery at boot (restart survival)', async () => {
    const first = new SelfEngineBackend(makeConfig(dataDir, { persistence: true }));
    await first.start();
    const endpoint1 = first.getEndpoint();
    await target(endpoint1, 'AmazonSQS.CreateQueue', { QueueName: 'jobs' });
    const esmCreate = await request(
      endpoint1,
      'POST',
      '/2015-03-31/event-source-mappings',
      { 'content-type': 'application/json' },
      JSON.stringify({
        FunctionName: 'worker',
        EventSourceArn: 'arn:aws:sqs:us-east-1:000000000000:jobs',
        BatchSize: 10,
      }),
    );
    expect(esmCreate.status).toBe(202);
    // A schedule rule persists too.
    const rule = await target(endpoint1, 'AWSEvents.PutRule', {
      Name: 'nightly',
      ScheduleExpression: 'rate(1 hour)',
    });
    expect(rule.status).toBe(200);
    await first.stop();

    const second = new SelfEngineBackend(makeConfig(dataDir, { persistence: true }));
    await second.start();
    try {
      const detail = second.healthDetail();
      expect(detail.eventSourceLoops).toEqual({ sqs: 1, streams: 0 });
      expect(detail.scheduleRules).toBe(1);
    } finally {
      await second.stop();
    }
  });

  test('unknown operations without a fallback endpoint answer an explicit error', async () => {
    const backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    try {
      const response = await target(backend.getEndpoint(), 'DynamoDB_20120810.TransactWriteItems', {});
      expect(response.status).toBe(400);
      expect(response.body).toContain('NotImplemented');
    } finally {
      await backend.stop();
    }
  });
});
