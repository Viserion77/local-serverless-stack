// End-to-end against the REAL SelfEngineBackend front door (s7 pattern):
// queue-level redrive. A queue carrying a RedrivePolicy feeds an SQS→Lambda ESM
// whose handler ALWAYS fails; the message is redelivered until its
// ApproximateReceiveCount exceeds maxReceiveCount and then moves to the DLQ with
// its identity intact. The consumer is a real HTTP relay invoked over the
// engine's INVOKE_URL fallback (no mocked runtime), so the whole path runs
// through production code: send → poller → invoke → failure → visibility expiry
// → redrive → DLQ.
//
// The FIFO case pins the failure mode that silently stalls a partition: moving
// the poison message must release its MessageGroupId so the rest of the group
// flows again.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
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
const ACCOUNT = '000000000000';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: ACCOUNT, region: REGION,
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

interface SqsWireRecord { messageId: string; body: string }

const redrivePolicy = (dlqName: string, maxReceiveCount: number) =>
  JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:${dlqName}`, maxReceiveCount });

describe('wire: SQS queue-level redrive (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  let relay: http.Server;
  let relayUrl: string;
  let sqs: SQSClient;
  let lambda: LambdaClient;
  const seen: SqsWireRecord[][] = [];

  beforeEach(async () => {
    seen.length = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // A real consumer: throws (HTTP 500) for any batch containing a "poison"
    // body, succeeds otherwise.
    relay = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { Records?: SqsWireRecord[] };
        const records = event.Records ?? [];
        seen.push(records);
        if (records.some(record => record.body.includes('poison'))) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errorType: 'Error', errorMessage: 'poison order' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
    relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-redrive-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
    sqs = new SQSClient({ endpoint, region: REGION, credentials: CREDS });
    lambda = new LambdaClient({ endpoint, region: REGION, credentials: CREDS });

    await lambda.send(new CreateFunctionCommand({
      FunctionName: 'consumer',
      Role: `arn:aws:iam::${ACCOUNT}:role/consumer`,
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: Buffer.from('x') },
      Environment: { Variables: { INVOKE_URL: relayUrl, FUNCTION_NAME: 'consumer' } },
    }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    await new Promise<void>(resolve => relay.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const queueUrl = (name: string) => `${endpoint}/${ACCOUNT}/${name}`;

  // Long-poll a queue until a message shows up (or the deadline passes).
  const awaitMessage = async (name: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const received = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl(name),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['All'],
      }));
      if (received.Messages?.[0]) return received.Messages[0];
    }
    return undefined;
  };

  it('delivers a poison message exactly maxReceiveCount times, then moves it to the DLQ', async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: 'orders-dlq' }));
    await sqs.send(new CreateQueueCommand({
      QueueName: 'orders',
      // 1 s visibility keeps the redelivery loop observable in a unit test.
      Attributes: { VisibilityTimeout: '1', RedrivePolicy: redrivePolicy('orders-dlq', 2) },
    }));
    await lambda.send(new CreateEventSourceMappingCommand({
      FunctionName: 'consumer',
      EventSourceArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:orders`,
      BatchSize: 10,
    }));

    const sent = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl('orders'),
      MessageBody: JSON.stringify({ id: 'o-1', kind: 'poison' }),
      MessageAttributes: { trace: { DataType: 'String', StringValue: 'abc' } },
    }));

    const dead = await awaitMessage('orders-dlq');
    expect(dead).toBeDefined();

    // Identity survives the move.
    expect(dead?.MessageId).toBe(sent.MessageId);
    expect(dead?.Body).toBe(JSON.stringify({ id: 'o-1', kind: 'poison' }));
    expect(dead?.MD5OfBody).toBe(sent.MD5OfMessageBody);
    // Counters restart on the DLQ; this is its first delivery there.
    expect(dead?.Attributes?.ApproximateReceiveCount).toBe('1');

    // The off-by-one: maxReceiveCount 2 means the consumer saw it TWICE — the
    // third delivery attempt went to the DLQ instead of back to the consumer.
    const deliveries = seen.filter(batch => batch.some(record => record.messageId === sent.MessageId));
    expect(deliveries).toHaveLength(2);

    // …and the source queue drained: nothing visible, nothing in flight.
    const attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl('orders'),
      AttributeNames: ['All'],
    }));
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('0');
    expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
  }, 40_000);

  it('FIFO: redriving the poison message unblocks the rest of its MessageGroupId', async () => {
    await sqs.send(new CreateQueueCommand({
      QueueName: 'orders-dlq.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
    }));
    await sqs.send(new CreateQueueCommand({
      QueueName: 'orders.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
        VisibilityTimeout: '1',
        RedrivePolicy: redrivePolicy('orders-dlq.fifo', 1),
      },
    }));
    // BatchSize 1 keeps the group serialized: the follower cannot ride along in
    // the same (failing) batch, so it is genuinely stuck behind the poison one.
    await lambda.send(new CreateEventSourceMappingCommand({
      FunctionName: 'consumer',
      EventSourceArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:orders.fifo`,
      BatchSize: 1,
    }));

    const poison = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl('orders.fifo'),
      MessageBody: JSON.stringify({ id: 'f-1', kind: 'poison' }),
      MessageGroupId: 'customer-1',
    }));
    const follower = await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl('orders.fifo'),
      MessageBody: JSON.stringify({ id: 'f-2', kind: 'ok' }),
      MessageGroupId: 'customer-1',
    }));

    const dead = await awaitMessage('orders-dlq.fifo');
    expect(dead?.MessageId).toBe(poison.MessageId);

    // The follower — blocked behind the poison message for as long as it held
    // the group lock — is delivered once the poison one leaves for the DLQ.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !seen.some(batch => batch.some(r => r.messageId === follower.MessageId))) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(seen.some(batch => batch.some(r => r.messageId === follower.MessageId))).toBe(true);

    // It succeeded, so it was deleted: the group is fully drained.
    const attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl('orders.fifo'),
      AttributeNames: ['All'],
    }));
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('0');
    expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
  }, 40_000);
});
