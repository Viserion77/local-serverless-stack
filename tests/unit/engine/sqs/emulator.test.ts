import { SqsEmulator, queueNameFromArn } from '../../../../src/server/engine/emulators/sqs/index.js';
import { md5OfMessageAttributes } from '../../../../src/server/engine/emulators/sqs/md5.js';
import { EngineBus } from '../../../../src/server/engine/bus.js';
import type { AwsRequest, EngineContext } from '../../../../src/server/engine/types.js';
import type { CatalogStore, EngineStore, ItemTable } from '../../../../src/server/engine/store/store-types.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class FakeCatalog<T> implements CatalogStore<T> {
  private map = new Map<string, T>();
  async load(): Promise<void> {}
  get(key: string): T | undefined {
    return this.map.get(key);
  }
  set(key: string, value: T): void {
    this.map.set(key, value);
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
  values(): T[] {
    return [...this.map.values()];
  }
  async flush(): Promise<void> {}
}

class FakeStore implements EngineStore {
  private catalogs = new Map<string, CatalogStore<unknown>>();
  dir(...segments: string[]): string {
    return ['/fake', ...segments].join('/');
  }
  catalog<T>(relPath: string): CatalogStore<T> {
    let existing = this.catalogs.get(relPath);
    if (!existing) {
      existing = new FakeCatalog<T>() as CatalogStore<unknown>;
      this.catalogs.set(relPath, existing);
    }
    return existing as CatalogStore<T>;
  }
  table(): ItemTable {
    throw new Error('ItemTable is not used by the SQS emulator');
  }
  async writeBlob(): Promise<string> {
    throw new Error('blobs are not used by the SQS emulator');
  }
  async readBlob(): Promise<Buffer> {
    throw new Error('blobs are not used by the SQS emulator');
  }
  async deleteBlob(): Promise<void> {}
  startSweeper(): void {}
  stopSweeper(): void {}
  async flushAll(): Promise<void> {}
}

function makeCtx(store: EngineStore = new FakeStore()): EngineContext {
  return {
    config: {
      port: 14566,
      dataDir: '/fake',
      account: '000000000000',
      region: 'us-east-1',
      idleUnloadMs: 300_000,
      memoryBudgetMb: 128,
      fsync: false,
      fallbackEndpoint: null,
      persistence: true,
    },
    store,
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://localhost:14566',
  };
}

function makeReq(region = 'us-east-1'): AwsRequest {
  return {
    method: 'POST',
    rawPath: '/',
    query: {},
    headers: {},
    body: Buffer.alloc(0),
    service: 'sqs',
    region,
    requestId: 'test-request',
  };
}

const URL_PREFIX = 'http://localhost:14566/000000000000';

describe('SqsEmulator', () => {
  let ctx: EngineContext;
  let emulator: SqsEmulator;

  const call = (operation: string, input: Record<string, unknown> = {}, region?: string) =>
    emulator.handle(operation, input, makeReq(region)) as Promise<Record<string, any>>;

  const createQueue = async (name: string, attributes?: Record<string, string>) => {
    const res = await call('CreateQueue', { QueueName: name, Attributes: attributes });
    return res.QueueUrl as string;
  };

  beforeEach(() => {
    ctx = makeCtx();
    emulator = new SqsEmulator(ctx);
  });

  test('emulator identity matches the router contract', () => {
    expect(emulator.service).toBe('sqs');
    expect(emulator.targetPrefix).toBe('AmazonSQS');
    expect(emulator.jsonVersion).toBe('1.0');
  });

  describe('CreateQueue / GetQueueUrl / ListQueues / DeleteQueue', () => {
    test('creates a queue and returns the endpoint-based QueueUrl', async () => {
      const url = await createQueue('orders');
      expect(url).toBe(`${URL_PREFIX}/orders`);
      const got = await call('GetQueueUrl', { QueueName: 'orders' });
      expect(got.QueueUrl).toBe(url);
    });

    test('re-creating with IDENTICAL attributes is an idempotent success', async () => {
      const first = await createQueue('idem', { VisibilityTimeout: '45' });
      const second = await createQueue('idem', { VisibilityTimeout: '45' });
      expect(second).toBe(first);
    });

    test('omitted attributes compare as their defaults', async () => {
      await createQueue('defaulted');
      // Explicit default value on re-create still matches.
      await expect(createQueue('defaulted', { VisibilityTimeout: '30' })).resolves.toBe(
        `${URL_PREFIX}/defaulted`,
      );
    });

    test('re-creating with DIFFERENT attributes throws the QueueAlreadyExists/QueueNameExists duality', async () => {
      await createQueue('conflict', { VisibilityTimeout: '45' });
      await expect(createQueue('conflict', { VisibilityTimeout: '60' })).rejects.toMatchObject({
        code: 'QueueAlreadyExists',
        typeName: 'com.amazonaws.sqs#QueueNameExists',
        status: 400,
        fault: 'Sender',
        message: 'A queue already exists with the same name and a different value for attribute VisibilityTimeout',
      });
    });

    test('rejects invalid queue names', async () => {
      const expected = {
        code: 'InvalidParameterValue',
        message: 'Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length',
      };
      await expect(createQueue('bad name!')).rejects.toMatchObject(expected);
      await expect(createQueue('')).rejects.toMatchObject(expected);
      await expect(createQueue('x'.repeat(81))).rejects.toMatchObject(expected);
      // FifoQueue=true requires the .fifo suffix.
      await expect(createQueue('nofifosuffix', { FifoQueue: 'true' })).rejects.toMatchObject(expected);
      // .fifo suffix without FifoQueue=true means a dot in a standard name.
      await expect(createQueue('plain.fifo')).rejects.toMatchObject(expected);
    });

    test('creates FIFO queues when the name and attribute agree', async () => {
      const url = await createQueue('tasks.fifo', { FifoQueue: 'true' });
      expect(url).toBe(`${URL_PREFIX}/tasks.fifo`);
      const attrs = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
      expect(attrs.Attributes.FifoQueue).toBe('true');
      expect(attrs.Attributes.ContentBasedDeduplication).toBe('false');
    });

    test('GetQueueUrl for a missing queue throws the legacy NonExistentQueue shape', async () => {
      await expect(call('GetQueueUrl', { QueueName: 'missing' })).rejects.toMatchObject({
        code: 'AWS.SimpleQueueService.NonExistentQueue',
        typeName: 'com.amazonaws.sqs#QueueDoesNotExist',
        message: 'The specified queue does not exist for this wsdl version.',
        status: 400,
      });
    });

    test('ListQueues filters by QueueNamePrefix and omits QueueUrls when empty', async () => {
      expect(await call('ListQueues')).toEqual({});
      await createQueue('svc-a');
      await createQueue('svc-b');
      await createQueue('other');
      const all = await call('ListQueues');
      expect(all.QueueUrls).toHaveLength(3);
      const filtered = await call('ListQueues', { QueueNamePrefix: 'svc-' });
      expect(filtered.QueueUrls).toEqual([`${URL_PREFIX}/svc-a`, `${URL_PREFIX}/svc-b`]);
    });

    test('regions are isolated', async () => {
      await createQueue('regional');
      const other = await call('ListQueues', {}, 'eu-west-1');
      expect(other).toEqual({});
    });

    test('DeleteQueue removes the queue; deleting again throws NonExistentQueue', async () => {
      const url = await createQueue('short-lived');
      expect(await call('DeleteQueue', { QueueUrl: url })).toEqual({});
      await expect(call('GetQueueUrl', { QueueName: 'short-lived' })).rejects.toMatchObject({
        code: 'AWS.SimpleQueueService.NonExistentQueue',
      });
      await expect(call('DeleteQueue', { QueueUrl: url })).rejects.toMatchObject({
        code: 'AWS.SimpleQueueService.NonExistentQueue',
      });
    });

    test('DeleteQueue wakes a parked long-poll, which returns empty', async () => {
      const url = await createQueue('parked');
      const start = Date.now();
      const receiving = call('ReceiveMessage', { QueueUrl: url, WaitTimeSeconds: 5 });
      await sleep(50);
      await call('DeleteQueue', { QueueUrl: url });
      expect(await receiving).toEqual({});
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  describe('GetQueueAttributes / SetQueueAttributes', () => {
    test('returns live counters, ARN, timestamps and defaults for All', async () => {
      const url = await createQueue('attrs');
      const res = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
      expect(res.Attributes).toMatchObject({
        QueueArn: 'arn:aws:sqs:us-east-1:000000000000:attrs',
        ApproximateNumberOfMessages: '0',
        ApproximateNumberOfMessagesNotVisible: '0',
        ApproximateNumberOfMessagesDelayed: '0',
        VisibilityTimeout: '30',
        DelaySeconds: '0',
        MessageRetentionPeriod: '345600',
        ReceiveMessageWaitTimeSeconds: '0',
      });
      expect(Number(res.Attributes.CreatedTimestamp)).toBeGreaterThan(0);
      expect(res.Attributes.LastModifiedTimestamp).toBe(res.Attributes.CreatedTimestamp);
      expect(res.Attributes.FifoQueue).toBeUndefined();
    });

    test('named subset returns only the requested attributes', async () => {
      const url = await createQueue('subset');
      const res = await call('GetQueueAttributes', {
        QueueUrl: url,
        AttributeNames: ['QueueArn', 'ApproximateNumberOfMessages'],
      });
      expect(Object.keys(res.Attributes).sort()).toEqual([
        'ApproximateNumberOfMessages',
        'QueueArn',
      ]);
    });

    test('no AttributeNames returns no Attributes', async () => {
      const url = await createQueue('unqueried');
      expect(await call('GetQueueAttributes', { QueueUrl: url })).toEqual({});
    });

    test('counters track the send → delay → receive → delete lifecycle', async () => {
      const url = await createQueue('lifecycle');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'now' });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'later', DelaySeconds: 900 });

      const counters = async () => {
        const res = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
        return {
          available: res.Attributes.ApproximateNumberOfMessages,
          inFlight: res.Attributes.ApproximateNumberOfMessagesNotVisible,
          delayed: res.Attributes.ApproximateNumberOfMessagesDelayed,
        };
      };
      expect(await counters()).toEqual({ available: '1', inFlight: '0', delayed: '1' });

      const received = await call('ReceiveMessage', { QueueUrl: url });
      expect(await counters()).toEqual({ available: '0', inFlight: '1', delayed: '1' });

      await call('DeleteMessage', { QueueUrl: url, ReceiptHandle: received.Messages[0].ReceiptHandle });
      expect(await counters()).toEqual({ available: '0', inFlight: '0', delayed: '1' });
    });

    test('SetQueueAttributes merges attributes and bumps LastModifiedTimestamp', async () => {
      const url = await createQueue('mutable');
      const redrive = JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:dlq', maxReceiveCount: 3 });
      expect(
        await call('SetQueueAttributes', {
          QueueUrl: url,
          Attributes: { VisibilityTimeout: '2', RedrivePolicy: redrive },
        }),
      ).toEqual({});
      const res = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
      expect(res.Attributes.VisibilityTimeout).toBe('2');
      expect(res.Attributes.RedrivePolicy).toBe(redrive);
      expect(Number(res.Attributes.LastModifiedTimestamp)).toBeGreaterThanOrEqual(
        Number(res.Attributes.CreatedTimestamp),
      );
    });
  });

  describe('SendMessage', () => {
    test('returns MessageId + MD5OfMessageBody (+MD5OfMessageAttributes with attributes)', async () => {
      const url = await createQueue('send');
      const plain = await call('SendMessage', { QueueUrl: url, MessageBody: 'hello world' });
      expect(plain.MessageId).toBeTruthy();
      expect(plain.MD5OfMessageBody).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
      expect(plain.MD5OfMessageAttributes).toBeUndefined();
      expect(plain.SequenceNumber).toBeUndefined();

      const withAttrs = await call('SendMessage', {
        QueueUrl: url,
        MessageBody: 'hello world',
        MessageAttributes: {
          Population: { DataType: 'Number', StringValue: '1250800' },
          Color: { DataType: 'String', StringValue: 'gray' },
          Data: { DataType: 'Binary', BinaryValue: Buffer.from('hello').toString('base64') },
        },
      });
      // Pinned fixture from the documented digest algorithm (see md5.test.ts).
      expect(withAttrs.MD5OfMessageAttributes).toBe('40f7cbc2f05bf80157e9b2704d4d8d09');
    });

    test('validates DelaySeconds range', async () => {
      const url = await createQueue('delay-range');
      await expect(
        call('SendMessage', { QueueUrl: url, MessageBody: 'x', DelaySeconds: 901 }),
      ).rejects.toMatchObject({ code: 'InvalidParameterValue' });
    });

    test('requires MessageBody', async () => {
      const url = await createQueue('nobody');
      await expect(call('SendMessage', { QueueUrl: url })).rejects.toMatchObject({
        code: 'MissingParameter',
        message: 'The request must contain the parameter MessageBody.',
      });
    });

    test('unknown queue throws NonExistentQueue', async () => {
      await expect(
        call('SendMessage', { QueueUrl: `${URL_PREFIX}/ghost`, MessageBody: 'x' }),
      ).rejects.toMatchObject({ code: 'AWS.SimpleQueueService.NonExistentQueue' });
    });

    describe('FIFO', () => {
      test('returns SequenceNumber and enforces MessageGroupId', async () => {
        const url = await createQueue('fifo-send.fifo', { FifoQueue: 'true' });
        const sent = await call('SendMessage', {
          QueueUrl: url,
          MessageBody: 'x',
          MessageGroupId: 'g',
          MessageDeduplicationId: 'd-1',
        });
        expect(sent.SequenceNumber).toMatch(/^\d{20}$/);

        await expect(
          call('SendMessage', { QueueUrl: url, MessageBody: 'x', MessageDeduplicationId: 'd-2' }),
        ).rejects.toMatchObject({
          code: 'MissingParameter',
          message: 'The request must contain the parameter MessageGroupId.',
        });
      });

      test('requires a dedup id unless ContentBasedDeduplication is enabled', async () => {
        const url = await createQueue('fifo-dedup.fifo', { FifoQueue: 'true' });
        await expect(
          call('SendMessage', { QueueUrl: url, MessageBody: 'x', MessageGroupId: 'g' }),
        ).rejects.toMatchObject({
          code: 'InvalidParameterValue',
          message: 'The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly',
        });

        const cbd = await createQueue('fifo-cbd.fifo', { FifoQueue: 'true', ContentBasedDeduplication: 'true' });
        const first = await call('SendMessage', { QueueUrl: cbd, MessageBody: 'same', MessageGroupId: 'g' });
        const dup = await call('SendMessage', { QueueUrl: cbd, MessageBody: 'same', MessageGroupId: 'g' });
        expect(dup.MessageId).toBe(first.MessageId);
        expect(dup.SequenceNumber).toBe(first.SequenceNumber);
      });

      test('rejects per-message DelaySeconds', async () => {
        const url = await createQueue('fifo-delay.fifo', { FifoQueue: 'true' });
        await expect(
          call('SendMessage', {
            QueueUrl: url,
            MessageBody: 'x',
            MessageGroupId: 'g',
            MessageDeduplicationId: 'd',
            DelaySeconds: 5,
          }),
        ).rejects.toMatchObject({ code: 'InvalidParameterValue' });
      });

      test('the 5-minute dedup window returns the ORIGINAL MessageId and sequence', async () => {
        const url = await createQueue('fifo-window.fifo', { FifoQueue: 'true' });
        const send = () =>
          call('SendMessage', {
            QueueUrl: url,
            MessageBody: 'x',
            MessageGroupId: 'g',
            MessageDeduplicationId: 'stable-id',
          });
        const first = await send();
        const dup = await send();
        expect(dup.MessageId).toBe(first.MessageId);
        expect(dup.SequenceNumber).toBe(first.SequenceNumber);
        const attrs = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
        expect(attrs.Attributes.ApproximateNumberOfMessages).toBe('1');
      });
    });
  });

  describe('SendMessageBatch', () => {
    test('returns per-entry Successful/Failed', async () => {
      const url = await createQueue('batch');
      const res = await call('SendMessageBatch', {
        QueueUrl: url,
        Entries: [
          { Id: 'ok-1', MessageBody: 'hello world' },
          { Id: 'bad', MessageBody: 'x', DelaySeconds: 5000 },
          { Id: 'ok-2', MessageBody: 'second' },
        ],
      });
      expect(res.Successful.map((entry: any) => entry.Id)).toEqual(['ok-1', 'ok-2']);
      expect(res.Successful[0].MD5OfMessageBody).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
      expect(res.Successful[0].MessageId).toBeTruthy();
      expect(res.Failed).toEqual([
        {
          Id: 'bad',
          SenderFault: true,
          Code: 'InvalidParameterValue',
          Message: expect.stringContaining('DelaySeconds'),
        },
      ]);
    });

    test('enforces the 10-entry limit', async () => {
      const url = await createQueue('batch-limit');
      const entries = Array.from({ length: 11 }, (_, i) => ({ Id: `e${i}`, MessageBody: 'x' }));
      await expect(call('SendMessageBatch', { QueueUrl: url, Entries: entries })).rejects.toMatchObject({
        code: 'AWS.SimpleQueueService.TooManyEntriesInBatchRequest',
        typeName: 'com.amazonaws.sqs#TooManyEntriesInBatchRequest',
        message: 'Maximum number of entries per request are 10. You have sent 11.',
      });
    });

    test('rejects empty batches and duplicate ids', async () => {
      const url = await createQueue('batch-edge');
      await expect(call('SendMessageBatch', { QueueUrl: url, Entries: [] })).rejects.toMatchObject({
        code: 'AWS.SimpleQueueService.EmptyBatchRequest',
      });
      await expect(
        call('SendMessageBatch', {
          QueueUrl: url,
          Entries: [
            { Id: 'same', MessageBody: 'a' },
            { Id: 'same', MessageBody: 'b' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'AWS.SimpleQueueService.BatchEntryIdsNotDistinct' });
    });
  });

  describe('ReceiveMessage', () => {
    test('validates MaxNumberOfMessages', async () => {
      const url = await createQueue('recv-range');
      await expect(
        call('ReceiveMessage', { QueueUrl: url, MaxNumberOfMessages: 11 }),
      ).rejects.toMatchObject({ code: 'ReadCountOutOfRange' });
      await expect(
        call('ReceiveMessage', { QueueUrl: url, MaxNumberOfMessages: 0 }),
      ).rejects.toMatchObject({ code: 'ReadCountOutOfRange' });
    });

    test('returns {} when empty and omits Attributes unless requested', async () => {
      const url = await createQueue('recv-plain');
      expect(await call('ReceiveMessage', { QueueUrl: url })).toEqual({});

      await call('SendMessage', { QueueUrl: url, MessageBody: 'hello world' });
      const res = await call('ReceiveMessage', { QueueUrl: url });
      const message = res.Messages[0];
      expect(message.Body).toBe('hello world');
      expect(message.MD5OfBody).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
      expect(message.ReceiptHandle).toBeTruthy();
      expect(message.Attributes).toBeUndefined();
      expect(message.MessageAttributes).toBeUndefined();
    });

    test('AttributeNames All returns the system attribute set', async () => {
      const url = await createQueue('recv-attrs');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      const res = await call('ReceiveMessage', { QueueUrl: url, AttributeNames: ['All'] });
      const attrs = res.Messages[0].Attributes;
      expect(attrs.ApproximateReceiveCount).toBe('1');
      expect(attrs.SenderId).toBe('000000000000');
      expect(Number(attrs.SentTimestamp)).toBeGreaterThan(0);
      expect(Number(attrs.ApproximateFirstReceiveTimestamp)).toBeGreaterThanOrEqual(
        Number(attrs.SentTimestamp),
      );
    });

    test('AttributeNames filters to the named attributes (and the modern alias works)', async () => {
      const url = await createQueue('recv-filter');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      const res = await call('ReceiveMessage', { QueueUrl: url, AttributeNames: ['SentTimestamp'] });
      expect(Object.keys(res.Messages[0].Attributes)).toEqual(['SentTimestamp']);

      await call('ChangeMessageVisibility', {
        QueueUrl: url,
        ReceiptHandle: res.Messages[0].ReceiptHandle,
        VisibilityTimeout: 0,
      });
      await sleep(20);
      const modern = await call('ReceiveMessage', {
        QueueUrl: url,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      });
      expect(modern.Messages[0].Attributes).toEqual({ ApproximateReceiveCount: '2' });
    });

    test('MessageAttributeNames supports All, exact names and prefixes; MD5 covers the returned set', async () => {
      const url = await createQueue('recv-mattrs');
      const messageAttributes = {
        Color: { DataType: 'String', StringValue: 'gray' },
        Count: { DataType: 'Number', StringValue: '7' },
      };
      const send = () => call('SendMessage', { QueueUrl: url, MessageBody: 'x', MessageAttributes: messageAttributes });

      await send();
      const all = await call('ReceiveMessage', { QueueUrl: url, MessageAttributeNames: ['All'] });
      expect(Object.keys(all.Messages[0].MessageAttributes).sort()).toEqual(['Color', 'Count']);
      expect(all.Messages[0].MD5OfMessageAttributes).toBe(md5OfMessageAttributes(messageAttributes));

      await send();
      const exact = await call('ReceiveMessage', { QueueUrl: url, MessageAttributeNames: ['Color'] });
      expect(Object.keys(exact.Messages[0].MessageAttributes)).toEqual(['Color']);
      // AWS digests exactly the returned (filtered) attribute set.
      expect(exact.Messages[0].MD5OfMessageAttributes).toBe(
        md5OfMessageAttributes({ Color: messageAttributes.Color }),
      );

      await send();
      const prefixed = await call('ReceiveMessage', { QueueUrl: url, MessageAttributeNames: ['Co.*'] });
      expect(Object.keys(prefixed.Messages[0].MessageAttributes).sort()).toEqual(['Color', 'Count']);
    });

    test('FIFO messages expose group, dedup id and sequence number', async () => {
      const url = await createQueue('recv-fifo.fifo', { FifoQueue: 'true' });
      await call('SendMessage', {
        QueueUrl: url,
        MessageBody: 'x',
        MessageGroupId: 'group-1',
        MessageDeduplicationId: 'dedup-1',
      });
      const res = await call('ReceiveMessage', { QueueUrl: url, AttributeNames: ['All'] });
      expect(res.Messages[0].Attributes).toMatchObject({
        MessageGroupId: 'group-1',
        MessageDeduplicationId: 'dedup-1',
        SequenceNumber: expect.stringMatching(/^\d{20}$/),
      });
    });

    test('long poll parks and wakes when a message arrives', async () => {
      const url = await createQueue('longpoll');
      const start = Date.now();
      const receiving = call('ReceiveMessage', { QueueUrl: url, WaitTimeSeconds: 5 });
      setTimeout(() => {
        void call('SendMessage', { QueueUrl: url, MessageBody: 'wake up' });
      }, 80);
      const res = await receiving;
      expect(res.Messages).toHaveLength(1);
      expect(res.Messages[0].Body).toBe('wake up');
      expect(Date.now() - start).toBeLessThan(2000);
    });

    test('VisibilityTimeout override 0 makes the message immediately redeliverable', async () => {
      const url = await createQueue('vis-zero');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      const first = await call('ReceiveMessage', { QueueUrl: url, VisibilityTimeout: 0, AttributeNames: ['All'] });
      expect(first.Messages[0].Attributes.ApproximateReceiveCount).toBe('1');
      await sleep(30);
      const second = await call('ReceiveMessage', { QueueUrl: url, AttributeNames: ['All'] });
      expect(second.Messages[0].Attributes.ApproximateReceiveCount).toBe('2');
      expect(second.Messages[0].MessageId).toBe(first.Messages[0].MessageId);
    });

    test('validates the VisibilityTimeout override range', async () => {
      const url = await createQueue('vis-range');
      await expect(
        call('ReceiveMessage', { QueueUrl: url, VisibilityTimeout: 43201 }),
      ).rejects.toMatchObject({ code: 'InvalidParameterValue' });
    });
  });

  describe('DeleteMessage / DeleteMessageBatch / PurgeQueue / ChangeMessageVisibility', () => {
    test('DeleteMessage with an invalid handle throws ReceiptHandleIsInvalid', async () => {
      const url = await createQueue('del');
      await expect(
        call('DeleteMessage', { QueueUrl: url, ReceiptHandle: 'garbage' }),
      ).rejects.toMatchObject({
        code: 'ReceiptHandleIsInvalid',
        typeName: 'com.amazonaws.sqs#ReceiptHandleIsInvalid',
        message: 'The input receipt handle "garbage" is not a valid receipt handle.',
      });
    });

    test('DeleteMessageBatch reports per-entry results', async () => {
      const url = await createQueue('del-batch');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      const received = await call('ReceiveMessage', { QueueUrl: url });
      const res = await call('DeleteMessageBatch', {
        QueueUrl: url,
        Entries: [
          { Id: 'good', ReceiptHandle: received.Messages[0].ReceiptHandle },
          { Id: 'bad', ReceiptHandle: 'garbage' },
        ],
      });
      expect(res.Successful).toEqual([{ Id: 'good' }]);
      expect(res.Failed).toEqual([
        { Id: 'bad', SenderFault: true, Code: 'ReceiptHandleIsInvalid', Message: expect.any(String) },
      ]);
      expect(res.Failed[0].Message).toContain('not a valid receipt handle');
    });

    test('DeleteMessageBatch enforces batch envelope limits', async () => {
      const url = await createQueue('del-batch-limit');
      const entries = Array.from({ length: 11 }, (_, i) => ({ Id: `e${i}`, ReceiptHandle: 'h' }));
      await expect(
        call('DeleteMessageBatch', { QueueUrl: url, Entries: entries }),
      ).rejects.toMatchObject({ code: 'AWS.SimpleQueueService.TooManyEntriesInBatchRequest' });
    });

    test('PurgeQueue clears every counter bucket', async () => {
      const url = await createQueue('purge');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'a' });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'b', DelaySeconds: 900 });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'c' });
      await call('ReceiveMessage', { QueueUrl: url, MaxNumberOfMessages: 1 });

      expect(await call('PurgeQueue', { QueueUrl: url })).toEqual({});
      const res = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
      expect(res.Attributes.ApproximateNumberOfMessages).toBe('0');
      expect(res.Attributes.ApproximateNumberOfMessagesNotVisible).toBe('0');
      expect(res.Attributes.ApproximateNumberOfMessagesDelayed).toBe('0');
    });

    test('ChangeMessageVisibility errors: invalid handle, not in flight, bad timeout', async () => {
      const url = await createQueue('cmv');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      const received = await call('ReceiveMessage', { QueueUrl: url });
      const handle = received.Messages[0].ReceiptHandle as string;

      await expect(
        call('ChangeMessageVisibility', { QueueUrl: url, ReceiptHandle: handle }),
      ).rejects.toMatchObject({ code: 'InvalidParameterValue' });
      await expect(
        call('ChangeMessageVisibility', { QueueUrl: url, ReceiptHandle: 'garbage', VisibilityTimeout: 10 }),
      ).rejects.toMatchObject({ code: 'ReceiptHandleIsInvalid' });

      // Release, then the old handle is no longer in flight.
      await call('ChangeMessageVisibility', { QueueUrl: url, ReceiptHandle: handle, VisibilityTimeout: 0 });
      await expect(
        call('ChangeMessageVisibility', { QueueUrl: url, ReceiptHandle: handle, VisibilityTimeout: 10 }),
      ).rejects.toMatchObject({
        code: 'AWS.SimpleQueueService.MessageNotInflight',
        typeName: 'com.amazonaws.sqs#MessageNotInflight',
      });
    });
  });

  test('unknown operations throw NotImplemented (never silent success)', async () => {
    await expect(call('TagQueue', { QueueUrl: `${URL_PREFIX}/x` })).rejects.toMatchObject({
      code: 'NotImplemented',
    });
  });

  test('emits sqs:message-visible on the engine bus when a message arrives', async () => {
    const events: Array<{ region: string; queueName: string }> = [];
    ctx.bus.on('sqs:message-visible', payload => events.push(payload));
    const url = await createQueue('bus-queue');
    await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
    expect(events).toEqual([{ region: 'us-east-1', queueName: 'bus-queue' }]);
  });

  describe('dispatcher API', () => {
    test('queueNameFromArn extracts the queue name', () => {
      expect(queueNameFromArn('arn:aws:sqs:us-east-1:000000000000:my-queue')).toBe('my-queue');
      expect(queueNameFromArn('arn:aws:sqs:us-east-1:000000000000:tasks.fifo')).toBe('tasks.fifo');
    });

    test('queueExists / hasVisibleMessages reflect loaded state', async () => {
      expect(emulator.queueExists('us-east-1', 'dispatch')).toBe(false);
      // Regions never touched are simply unknown to the sync API.
      expect(emulator.queueExists('sa-east-1', 'dispatch')).toBe(false);
      expect(emulator.hasVisibleMessages('sa-east-1', 'dispatch')).toBe(false);

      const url = await createQueue('dispatch');
      expect(emulator.queueExists('us-east-1', 'dispatch')).toBe(true);
      expect(emulator.hasVisibleMessages('us-east-1', 'dispatch')).toBe(false);
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      expect(emulator.hasVisibleMessages('us-east-1', 'dispatch')).toBe(true);
    });

    test('ensureRegionLoaded makes an untouched region visible to the sync API', async () => {
      await emulator.ensureRegionLoaded('eu-central-1');
      expect(emulator.queueExists('eu-central-1', 'nothing')).toBe(false);
    });

    test('receiveForDelivery marks messages in flight and deleteDelivered settles them', async () => {
      const url = await createQueue('delivery', { VisibilityTimeout: '45' });
      await call('SendMessage', {
        QueueUrl: url,
        MessageBody: 'hello world',
        MessageAttributes: { Color: { DataType: 'String', StringValue: 'gray' } },
      });

      const delivered = emulator.receiveForDelivery('us-east-1', 'delivery', 10);
      expect(delivered).toHaveLength(1);
      const message = delivered[0];
      expect(message.messageId).toBeTruthy();
      expect(message.receiptHandle).toBeTruthy();
      expect(message.body).toBe('hello world');
      expect(message.md5OfBody).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
      expect(message.md5OfMessageAttributes).toBe('92cce3ef3a009c57dc8d0f28ecf36707');
      expect(message.approximateReceiveCount).toBe(1);
      expect(message.sentTimestamp).toBeGreaterThan(0);
      expect(message.attributes).toMatchObject({
        ApproximateReceiveCount: '1',
        SenderId: '000000000000',
      });
      expect(message.messageAttributes.Color.StringValue).toBe('gray');
      expect(message.messageGroupId).toBeUndefined();
      expect(message.sequenceNumber).toBeUndefined();

      const attrs = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
      expect(attrs.Attributes.ApproximateNumberOfMessagesNotVisible).toBe('1');
      expect(emulator.hasVisibleMessages('us-east-1', 'delivery')).toBe(false);

      emulator.deleteDelivered('us-east-1', 'delivery', [message.receiptHandle]);
      const after = await call('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] });
      expect(after.Attributes.ApproximateNumberOfMessagesNotVisible).toBe('0');
    });

    test('FIFO delivery carries group and sequence and locks the group', async () => {
      const url = await createQueue('delivery.fifo', { FifoQueue: 'true' });
      await call('SendMessage', {
        QueueUrl: url,
        MessageBody: 'a',
        MessageGroupId: 'g',
        MessageDeduplicationId: 'd1',
      });
      await call('SendMessage', {
        QueueUrl: url,
        MessageBody: 'b',
        MessageGroupId: 'g',
        MessageDeduplicationId: 'd2',
      });

      const batch = emulator.receiveForDelivery('us-east-1', 'delivery.fifo', 1);
      expect(batch[0].messageGroupId).toBe('g');
      expect(batch[0].sequenceNumber).toMatch(/^\d{20}$/);
      // Group locked: the second message is not deliverable yet.
      expect(emulator.receiveForDelivery('us-east-1', 'delivery.fifo', 10)).toEqual([]);
      emulator.deleteDelivered('us-east-1', 'delivery.fifo', [batch[0].receiptHandle]);
      expect(emulator.receiveForDelivery('us-east-1', 'delivery.fifo', 10)).toHaveLength(1);
    });

    test('unknown queues are safe no-ops', () => {
      expect(emulator.receiveForDelivery('us-east-1', 'ghost', 10)).toEqual([]);
      expect(() => emulator.deleteDelivered('us-east-1', 'ghost', ['h'])).not.toThrow();
      expect(emulator.hasVisibleMessages('us-east-1', 'ghost')).toBe(false);
    });
  });

  describe('RedrivePolicy → DLQ', () => {
    const policyFor = (queueName: string, maxReceiveCount: number) =>
      JSON.stringify({
        deadLetterTargetArn: `arn:aws:sqs:us-east-1:000000000000:${queueName}`,
        maxReceiveCount,
      });

    // VisibilityTimeout 0 makes every failed delivery expire on the next tick,
    // so a redrive is observable in milliseconds instead of seconds.
    const receiveOnce = async (url: string) => {
      const res = await call('ReceiveMessage', { QueueUrl: url, AttributeNames: ['All'] });
      await sleep(20); // let the visibility timer fire
      return res.Messages?.[0];
    };

    test('moves the message to the DLQ once ApproximateReceiveCount exceeds maxReceiveCount', async () => {
      const dlqUrl = await createQueue('orders-dlq');
      const url = await createQueue('orders', {
        VisibilityTimeout: '0',
        RedrivePolicy: policyFor('orders-dlq', 2),
      });
      const sent = await call('SendMessage', {
        QueueUrl: url,
        MessageBody: 'poison',
        MessageAttributes: { Color: { DataType: 'String', StringValue: 'gray' } },
      });

      const first = await receiveOnce(url);
      expect(first.Attributes.ApproximateReceiveCount).toBe('1');
      const second = await receiveOnce(url);
      expect(second.Attributes.ApproximateReceiveCount).toBe('2');

      // Delivered exactly twice: the source queue is now empty…
      expect(await receiveOnce(url)).toBeUndefined();
      // …and the message is on the DLQ with its identity intact.
      const moved = await call('ReceiveMessage', {
        QueueUrl: dlqUrl,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      });
      expect(moved.Messages).toHaveLength(1);
      expect(moved.Messages[0].MessageId).toBe(sent.MessageId);
      expect(moved.Messages[0].Body).toBe('poison');
      expect(moved.Messages[0].MD5OfBody).toBe(sent.MD5OfMessageBody);
      expect(moved.Messages[0].MD5OfMessageAttributes).toBe(sent.MD5OfMessageAttributes);
      expect(moved.Messages[0].MessageAttributes.Color.StringValue).toBe('gray');
      // The DLQ counts its own deliveries.
      expect(moved.Messages[0].Attributes.ApproximateReceiveCount).toBe('1');
    });

    test('the policy is re-read per redelivery: SetQueueAttributes wires a DLQ created later', async () => {
      const url = await createQueue('late', { VisibilityTimeout: '0' });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      expect(await receiveOnce(url)).toBeDefined();

      // Neither the DLQ nor the policy existed during the first delivery.
      const dlqUrl = await createQueue('late-dlq');
      await call('SetQueueAttributes', {
        QueueUrl: url,
        Attributes: { RedrivePolicy: policyFor('late-dlq', 1) },
      });

      // The next delivery exceeds the freshly-attached threshold and moves.
      expect((await receiveOnce(url)).Attributes.ApproximateReceiveCount).toBe('2');
      expect(await receiveOnce(url)).toBeUndefined();
      const moved = await call('ReceiveMessage', { QueueUrl: dlqUrl });
      expect(moved.Messages).toHaveLength(1);
      expect(moved.Messages[0].Body).toBe('x');
    });

    test('an unresolvable dead-letter target warns ONCE and keeps redelivering', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const url = await createQueue('orphan', {
        VisibilityTimeout: '0',
        RedrivePolicy: policyFor('missing-dlq', 1),
      });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });

      expect((await receiveOnce(url)).Attributes.ApproximateReceiveCount).toBe('1');
      expect((await receiveOnce(url)).Attributes.ApproximateReceiveCount).toBe('2');
      // Non-fatal: the queue keeps working, and the warning is not repeated on
      // every visibility timeout.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('missing-dlq');
      warn.mockRestore();
    });

    test('a malformed policy is ignored (the queue keeps redelivering)', async () => {
      const url = await createQueue('bad-policy', {
        VisibilityTimeout: '0',
        RedrivePolicy: 'not-json',
      });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      expect((await receiveOnce(url)).Attributes.ApproximateReceiveCount).toBe('1');
      expect((await receiveOnce(url)).Attributes.ApproximateReceiveCount).toBe('2');
    });

    test('a queue whose catalog record vanished mid-flight redelivers instead of redriving', async () => {
      const store = new FakeStore();
      ctx = makeCtx(store);
      emulator = new SqsEmulator(ctx);
      const dlqUrl = await createQueue('ghost-dlq');
      const url = await createQueue('ghost', {
        VisibilityTimeout: '0',
        RedrivePolicy: policyFor('ghost-dlq', 1),
      });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'x' });
      await call('ReceiveMessage', { QueueUrl: url });

      // Drop the record behind the emulator's back (DeleteQueue would also
      // dispose the runtime): the live runtime is now policy-less.
      store.catalog('sqs/us-east-1/queues').delete('ghost');
      await sleep(20);

      const dlq = await call('GetQueueAttributes', { QueueUrl: dlqUrl, AttributeNames: ['All'] });
      expect(dlq.Attributes.ApproximateNumberOfMessages).toBe('0');
      const state = emulator.serializeMessages().queues.find(q => q.queueName === 'ghost');
      expect(state?.state.messages).toHaveLength(1);
    });
  });

  describe('persistence seams', () => {
    test('queue attributes survive into a new emulator over the same store', async () => {
      const store = new FakeStore();
      ctx = makeCtx(store);
      emulator = new SqsEmulator(ctx);
      await createQueue('durable', { VisibilityTimeout: '45' });

      const rebooted = new SqsEmulator(makeCtx(store));
      const res = (await rebooted.handle(
        'GetQueueAttributes',
        { QueueUrl: `${URL_PREFIX}/durable`, AttributeNames: ['VisibilityTimeout'] },
        makeReq(),
      )) as Record<string, any>;
      expect(res.Attributes.VisibilityTimeout).toBe('45');
    });

    test('serializeMessages/restoreMessages round-trip; in-flight redelivers', async () => {
      const store = new FakeStore();
      ctx = makeCtx(store);
      emulator = new SqsEmulator(ctx);
      const url = await createQueue('snap');
      await call('SendMessage', { QueueUrl: url, MessageBody: 'inflight' });
      await call('SendMessage', { QueueUrl: url, MessageBody: 'kept' });
      // Receives the oldest message ('inflight') — in flight at "shutdown".
      await call('ReceiveMessage', { QueueUrl: url });

      const snapshot = emulator.serializeMessages();
      expect(snapshot.queues).toEqual([
        { region: 'us-east-1', queueName: 'snap', state: expect.any(Object) },
      ]);
      // The snapshot must survive JSON round-tripping (that is how the
      // backend will persist it on graceful shutdown).
      const revived = JSON.parse(JSON.stringify(snapshot));

      const rebooted = new SqsEmulator(makeCtx(store));
      rebooted.restoreMessages(revived);
      const res = (await rebooted.handle(
        'GetQueueAttributes',
        { QueueUrl: url, AttributeNames: ['All'] },
        makeReq(),
      )) as Record<string, any>;
      expect(res.Attributes.ApproximateNumberOfMessages).toBe('2');
      expect(res.Attributes.ApproximateNumberOfMessagesNotVisible).toBe('0');

      const redelivered = (await rebooted.handle(
        'ReceiveMessage',
        { QueueUrl: url, MaxNumberOfMessages: 10, AttributeNames: ['All'] },
        makeReq(),
      )) as Record<string, any>;
      const counts = redelivered.Messages.map(
        (m: any) => [m.Body, m.Attributes.ApproximateReceiveCount] as [string, string],
      );
      expect(counts).toContainEqual(['kept', '1']);
      // The formerly in-flight message keeps its receive history.
      expect(counts).toContainEqual(['inflight', '2']);
    });
  });
});
