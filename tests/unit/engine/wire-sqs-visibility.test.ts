// End-to-end against the REAL SelfEngineBackend front door, through the AWS
// SDK: receipt-handle and visibility semantics a consumer depends on.
//
//   - A consumer that finishes just AFTER its visibility timeout still deletes
//     the message with the handle it was given (until someone receives it
//     again) — it must not get a 200 while the message silently survives and
//     redelivers.
//   - ReceiveMessage with VisibilityTimeout: 0 is a "peek": an immediate second
//     receive sees the message again, with no wait for the queue timer.
//   - The dead-letter move happens on the receive that would exceed
//     maxReceiveCount, not the instant the visibility lapses — so the message is
//     still in its source queue (and still deletable) in between.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke: jest.fn() }) },
}));

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-east-1';
const ACCOUNT = '000000000000';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: ACCOUNT, region: REGION,
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

describe('wire: SQS receipt handles and visibility (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let sqs: SQSClient;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-sqs-vis-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    sqs = new SQSClient({
      region: REGION,
      endpoint: backend.getEndpoint(),
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  afterEach(async () => {
    sqs.destroy();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const counts = async (QueueUrl: string) => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return {
      visible: Number(Attributes?.ApproximateNumberOfMessages),
      inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible),
    };
  };

  test('the latest handle deletes the message even after its visibility timeout lapsed', async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'orders' }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'slow-consumer' }));

    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 1 }));
    const handle = received.Messages![0].ReceiptHandle!;
    await sleep(1_200); // the consumer overran its timeout
    expect(await counts(QueueUrl!)).toEqual({ visible: 1, inFlight: 0 });

    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: handle }));
    expect(await counts(QueueUrl!)).toEqual({ visible: 0, inFlight: 0 });
    const after = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    expect(after.Messages).toBeUndefined();
  });

  test('VisibilityTimeout 0 peeks: an immediate receive sees the message again, every time', async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'orders-dlq' }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'inspect-me' }));

    for (let attempt = 1; attempt <= 25; attempt += 1) {
      const peek = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 0, MessageSystemAttributeNames: ['All'] }),
      );
      expect(peek.Messages).toHaveLength(1);
      expect(peek.Messages![0].Attributes?.ApproximateReceiveCount).toBe(String(attempt));
    }
    expect(await counts(QueueUrl!)).toEqual({ visible: 1, inFlight: 0 });
  });

  test('a lapsed message stays in its queue until the receive that exceeds maxReceiveCount', async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: 'billing-dlq' }));
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: 'billing',
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:billing-dlq`,
            maxReceiveCount: 1,
          }),
        },
      }),
    );
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'charge-42' }));

    const first = await sqs.send(new ReceiveMessageCommand({ QueueUrl, VisibilityTimeout: 1 }));
    await sleep(1_200);
    // Not dead-lettered yet: nobody has tried to receive it a second time.
    expect(await counts(QueueUrl!)).toEqual({ visible: 1, inFlight: 0 });
    expect(await counts(dlq.QueueUrl!)).toEqual({ visible: 0, inFlight: 0 });

    // The second receive would exceed maxReceiveCount: it moves the message.
    const second = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    expect(second.Messages).toBeUndefined();
    expect(await counts(dlq.QueueUrl!)).toEqual({ visible: 1, inFlight: 0 });
    // The first handle died with the move — deleting with it is a no-op.
    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: first.Messages![0].ReceiptHandle! }));
    expect(await counts(dlq.QueueUrl!)).toEqual({ visible: 1, inFlight: 0 });
  });
});
