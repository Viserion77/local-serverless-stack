// End-to-end against the REAL SelfEngineBackend front door (relay/bus/DLQ, s7
// pattern): a DynamoDB-stream ESM that declares ReportBatchItemFailures honors a
// real relay Lambda proxy's partial-batch report — committing the prefix,
// retrying the failing suffix, and DLQ-ing ONLY that suffix. The relay is a real
// HTTP proxy invoked over the engine's INVOKE_URL fallback (no mocked runtime),
// so the whole path (stream append → bus wake → tailer → handler response parse
// → checkpoint → OnFailure envelope) runs through production code.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { DynamoDBClient, CreateTableCommand, PutItemCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, CreateQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, CreateFunctionCommand, CreateEventSourceMappingCommand } from '@aws-sdk/client-lambda';

// lambda-runtime-manager uses import.meta.url (ESM-only) which jest's CJS
// transform cannot load; the relay is invoked over its INVOKE_URL fallback, so
// this mock is never actually called.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke: jest.fn() }) },
}));

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: REGION,
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

interface WireRecord { dynamodb: { Keys: { id: { S: string } }; SequenceNumber: string } }

describe('wire: stream ESM ReportBatchItemFailures partial batch (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  let relay: http.Server;
  let relayUrl: string;
  const seen: WireRecord[][] = [];

  beforeEach(async () => {
    seen.length = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // A real relay handler: reports the record whose Keys.id === 'r2' as failed.
    relay = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { Records?: WireRecord[] };
        const records = event.Records ?? [];
        seen.push(records);
        const failing = records.find(r => r.dynamodb?.Keys?.id?.S === 'r2');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ batchItemFailures: failing ? [{ itemIdentifier: failing.dynamodb.SequenceNumber }] : [] }));
      });
    });
    await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
    relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-rbif-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    await new Promise<void>(resolve => relay.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('commits the prefix, retries the failing suffix and DLQs only the suffix', async () => {
    const dynamo = new DynamoDBClient({ endpoint, region: REGION, credentials: CREDS });
    const sqs = new SQSClient({ endpoint, region: REGION, credentials: CREDS });
    const lambda = new LambdaClient({ endpoint, region: REGION, credentials: CREDS });

    await dynamo.send(new CreateTableCommand({
      TableName: 'orders',
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    }));
    const streamArn = (await dynamo.send(new DescribeTableCommand({ TableName: 'orders' }))).Table!.LatestStreamArn!;

    // Seed the stream backlog before the ESM exists so a TRIM_HORIZON tailer
    // reads all three as one batch [r1, r2, r3].
    for (const id of ['r1', 'r2', 'r3']) {
      await dynamo.send(new PutItemCommand({ TableName: 'orders', Item: { id: { S: id } } }));
    }

    await sqs.send(new CreateQueueCommand({ QueueName: 'stream-dlq' }));
    const dlqArn = `arn:aws:sqs:${REGION}:000000000000:stream-dlq`;

    // A relay proxy resolved via the engine's INVOKE_URL fallback (real HTTP).
    await lambda.send(new CreateFunctionCommand({
      FunctionName: 'relay',
      Role: 'arn:aws:iam::000000000000:role/relay',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: Buffer.from('x') },
      Environment: { Variables: { INVOKE_URL: relayUrl, FUNCTION_NAME: 'relay' } },
    }));

    // Creating the ESM starts the tailer, which drains the backlog.
    await lambda.send(new CreateEventSourceMappingCommand({
      FunctionName: 'relay',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: 2,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: dlqArn } },
    }));

    // Long-poll the DLQ until the suffix envelope arrives (3 attempts × 200ms).
    const deadline = Date.now() + 15_000;
    let body: string | undefined;
    while (body === undefined && Date.now() < deadline) {
      const received = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: `${endpoint}/000000000000/stream-dlq`,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }));
      body = received.Messages?.[0]?.Body;
    }
    expect(body).toBeDefined();
    const envelope = JSON.parse(body as string);

    // The first invoke saw all three records; every retry saw only [r2, r3].
    expect(seen[0].map(r => r.dynamodb.Keys.id.S)).toEqual(['r1', 'r2', 'r3']);
    for (const batch of seen.slice(1)) expect(batch.map(r => r.dynamodb.Keys.id.S)).toEqual(['r2', 'r3']);
    expect(seen).toHaveLength(3); // initial + 2 retries

    const s2 = seen[0][1].dynamodb.SequenceNumber;
    const s3 = seen[0][2].dynamodb.SequenceNumber;
    expect(envelope.requestContext.condition).toBe('RetryAttemptsExhausted');
    expect(envelope.requestContext.approximateInvokeCount).toBe(3);
    expect(envelope.DDBStreamBatchInfo.startSequenceNumber).toBe(s2); // r1 committed, not in the DLQ
    expect(envelope.DDBStreamBatchInfo.endSequenceNumber).toBe(s3);
    expect(envelope.DDBStreamBatchInfo.batchSize).toBe(2); // the failing suffix only
  }, 30_000);
});
