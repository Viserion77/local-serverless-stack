// Unit tests for QueueInspector. Exemplar for the AWS-SDK-mock + fake-timers
// pattern: mockClient() patches the SDK client prototype so the calls the
// singleton makes through its cached clients are intercepted. Singleton state
// (metrics/held/client caches) is reset between tests.
import { mockClient } from 'aws-sdk-client-mock';
import {
  SQSClient,
  ListQueuesCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import {
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import { QueueInspector } from '../../../src/server/services/queue-inspector';

const sqsMock = mockClient(SQSClient);
const lambdaMock = mockClient(LambdaClient);

// `getCaptured`/`releaseQueue` answer a SENTINEL ('not-found' | 'not-held') or
// the real thing. The tests below are about the real thing, and `!` only strips
// null/undefined — it never excluded the sentinels, so `captured!.some(...)`
// and `res!.dispatched` were reaching into a union that does not have them.
// Narrowing here fails loudly if a call takes a sentinel path, which is a
// better outcome than an assertion that cannot even be typed.
function messagesOf(result: Awaited<ReturnType<QueueInspector['getCaptured']>>) {
  if (!Array.isArray(result)) throw new Error(`expected captured messages, got "${result}"`);
  return result;
}

function releasedOf(result: Awaited<ReturnType<QueueInspector['releaseQueue']>>) {
  if (typeof result === 'string') throw new Error(`expected a release result, got "${result}"`);
  return result;
}

const URL_Q = 'http://localhost:4566/000000000000/q';
const URL_FIFO = 'http://localhost:4566/000000000000/q.fifo';
const ARN_Q = 'arn:aws:sqs:us-east-1:000000000000:q';

let inspector: QueueInspector;

beforeEach(() => {
  sqsMock.reset();
  lambdaMock.reset();
  inspector = QueueInspector.getInstance();
  const i = inspector as any;
  i.metrics.clear();
  i.held.clear();
  i.sqsClients.clear();
  i.lambdaClients.clear();
  i.defaultRegion = 'us-east-1';
});

afterAll(() => {
  sqsMock.restore();
  lambdaMock.restore();
});

describe('getInstance / setDefaultRegion', () => {
  it('is a singleton', () => {
    expect(QueueInspector.getInstance()).toBe(inspector);
  });
  it('setDefaultRegion ignores empty, accepts a value', () => {
    inspector.setDefaultRegion('');
    expect((inspector as any).defaultRegion).toBe('us-east-1');
    inspector.setDefaultRegion('eu-west-1');
    expect((inspector as any).defaultRegion).toBe('eu-west-1');
  });
});

describe('getQueue / buildSnapshot', () => {
  it('returns null when the queue url cannot be resolved', async () => {
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('not found'));
    expect(await inspector.getQueue('missing')).toBeNull();
  });

  it('builds a snapshot with metrics and attached consumers', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: {
        ApproximateNumberOfMessages: '2',
        ApproximateNumberOfMessagesNotVisible: '1',
        ApproximateNumberOfMessagesDelayed: '0',
        QueueArn: ARN_Q,
        VisibilityTimeout: '30',
        MessageRetentionPeriod: '345600',
        CreatedTimestamp: '1700000000',
        LastModifiedTimestamp: '1700000001',
      },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({
      EventSourceMappings: [
        { EventSourceArn: ARN_Q, FunctionArn: 'arn:aws:lambda:us-east-1:000:function:consumer', UUID: 'u1', State: 'Enabled', BatchSize: 10 },
      ],
    });

    const snap = await inspector.getQueue('q');
    expect(snap).toMatchObject({
      name: 'q',
      url: URL_Q,
      available: 2,
      inFlight: 1,
      total: 3,
      fifo: false,
      visibilityTimeout: 30,
      consumers: [{ functionName: 'consumer', uuid: 'u1', enabled: true }],
    });
  });

  it('returns null when GetQueueAttributes fails (buildSnapshot catch)', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).rejects(new Error('boom'));
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    expect(await inspector.getQueue('q')).toBeNull();
  });
});

describe('listQueues', () => {
  it('returns [] when ListQueues fails (fetchQueueUrls catch)', async () => {
    sqsMock.on(ListQueuesCommand).rejects(new Error('down'));
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    expect(await inspector.listQueues()).toEqual([]);
  });

  // ListQueues answers at most 1000 URLs per page; a truncated list would drop
  // queues (and their consumers) from the dashboard and from await-idle.
  it('follows NextToken across pages', async () => {
    sqsMock
      .on(ListQueuesCommand, { NextToken: undefined })
      .resolves({ QueueUrls: [URL_Q], NextToken: 'page-2' })
      .on(ListQueuesCommand, { NextToken: 'page-2' })
      .resolves({ QueueUrls: [URL_FIFO] });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });

    const queues = await inspector.listQueues();
    expect(queues.map(q => q.name)).toEqual(['q', 'q.fifo']);
  });

  it('builds snapshots for each queue and drops the ones that fail', async () => {
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [URL_Q, URL_FIFO] });
    sqsMock.on(GetQueueAttributesCommand, { QueueUrl: URL_Q }).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    sqsMock.on(GetQueueAttributesCommand, { QueueUrl: URL_FIFO }).rejects(new Error('boom'));
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });

    const queues = await inspector.listQueues();
    expect(queues).toHaveLength(1);
    expect(queues[0].name).toBe('q');
  });

  it('ignores non-sqs and malformed event source mappings', async () => {
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [URL_Q] });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({
      EventSourceMappings: [
        { EventSourceArn: 'arn:aws:dynamodb:...:stream', FunctionArn: 'arn:...:fn' }, // not sqs
        { EventSourceArn: ARN_Q }, // missing FunctionArn
      ],
    });
    const queues = await inspector.listQueues();
    expect(queues[0].consumers).toEqual([]);
  });

  it('returns an empty consumer map when ListEventSourceMappings fails', async () => {
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [URL_Q] });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).rejects(new Error('no lambda'));
    const queues = await inspector.listQueues();
    expect(queues[0].consumers).toEqual([]);
  });
});

describe('awaitIdle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns null when the queue does not exist', async () => {
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('nope'));
    await expect(inspector.awaitIdle('missing', { timeoutMs: 1000 })).resolves.toBeNull();
  });

  it('resolves drained:true immediately when idle', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0' },
    });
    const p = inspector.awaitIdle('q', { timeoutMs: 5000, pollIntervalMs: 250 });
    await jest.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual({ name: 'q', available: 0, inFlight: 0, processed: 0, drained: true });
  });

  it('uses default timeout/poll when called with no options, and copes with missing attributes', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).resolves({}); // no Attributes → counts default to 0
    const p = inspector.awaitIdle('q');
    await jest.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toMatchObject({ drained: true, available: 0, inFlight: 0 });
  });

  it('falls back to zeros on timeout when no metrics were ever recorded', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).rejects(new Error('transient')); // never records metrics
    const p = inspector.awaitIdle('q', { timeoutMs: 500, pollIntervalMs: 250 });
    await jest.advanceTimersByTimeAsync(700);
    await expect(p).resolves.toEqual({ name: 'q', available: 0, inFlight: 0, processed: 0, drained: false });
  });

  it('times out with drained:false when the queue never drains', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '2', ApproximateNumberOfMessagesNotVisible: '0' },
    });
    const p = inspector.awaitIdle('q', { timeoutMs: 1000, pollIntervalMs: 250 });
    await jest.advanceTimersByTimeAsync(1200);
    const res = await p;
    expect(res).toMatchObject({ drained: false, available: 2 });
  });

  it('honors sinceProcessed (drains only once the processed threshold is met)', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0' },
    });
    (inspector as any).metrics.set(URL_Q, { lastAvailable: 0, lastInFlight: 0, processed: 5 });
    const ok = inspector.awaitIdle('q', { timeoutMs: 1000, sinceProcessed: 5 });
    await jest.advanceTimersByTimeAsync(0);
    expect((await ok)!.drained).toBe(true);

    (inspector as any).metrics.set(URL_Q, { lastAvailable: 0, lastInFlight: 0, processed: 5 });
    const fail = inspector.awaitIdle('q', { timeoutMs: 800, sinceProcessed: 10, pollIntervalMs: 250 });
    await jest.advanceTimersByTimeAsync(1000);
    expect((await fail)!.drained).toBe(false);
  });

  it('keeps polling on a transient metrics failure and falls back to last metrics on timeout', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).rejects(new Error('transient'));
    (inspector as any).metrics.set(URL_Q, { lastAvailable: 3, lastInFlight: 1, processed: 0 });
    const p = inspector.awaitIdle('q', { timeoutMs: 600, pollIntervalMs: 250 });
    await jest.advanceTimersByTimeAsync(800);
    const res = await p;
    expect(res).toMatchObject({ drained: false, available: 3, inFlight: 1 });
  });
});

describe('sendMessage', () => {
  it('throws when the queue is not found', async () => {
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('nope'));
    await expect(inspector.sendMessage('q', { body: 'x' })).rejects.toThrow('Queue not found: q');
  });

  it('sends a standard message with delay and attributes', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1', MD5OfMessageBody: 'md5' });
    const res = await inspector.sendMessage('q', {
      body: 'hello',
      delaySeconds: 5,
      messageAttributes: [
        { name: 'k', value: 'v', type: 'String' },
        { name: 'noType', value: 'w' }, // no type → defaults to 'String'
        { name: '', value: 'skip' }, // filtered out (no name)
      ],
    });
    expect(res).toEqual({ messageId: 'm1', sequenceNumber: undefined, md5OfBody: 'md5' });
    const call = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input as any;
    expect(call.DelaySeconds).toBe(5);
    expect(call.MessageAttributes.k.StringValue).toBe('v');
    expect(call.MessageAttributes.noType.DataType).toBe('String');
  });

  it('sends a FIFO message with group/dedup ids', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_FIFO });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm2', SequenceNumber: '99' });
    const res = await inspector.sendMessage('q.fifo', { body: 'h', messageDeduplicationId: 'd1' });
    expect(res.sequenceNumber).toBe('99');
    const call = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input as any;
    expect(call.MessageGroupId).toBe('default');
    expect(call.MessageDeduplicationId).toBe('d1');
    expect(call.DelaySeconds).toBeUndefined();
  });
});

describe('receiveMessages / deleteMessage / purgeQueue', () => {
  it('receives and maps messages (attributes + message attributes)', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        {
          MessageId: 'm1',
          ReceiptHandle: 'r1',
          Body: 'b',
          MD5OfBody: 'x',
          Attributes: { SenderId: 's' },
          MessageAttributes: {
            str: { DataType: 'String', StringValue: 'v' },
            bin: { DataType: 'Binary', BinaryValue: Buffer.from('z') },
          },
        },
      ],
    });
    const msgs = await inspector.receiveMessages('q', { maxNumberOfMessages: 5, waitTimeSeconds: 1, visibilityTimeout: 10 });
    expect(msgs[0].messageId).toBe('m1');
    expect(msgs[0].messageAttributes!.str).toEqual({ type: 'String', value: 'v' });
    expect(msgs[0].messageAttributes!.bin.value).toBe('z');
  });

  it('returns [] when there are no messages', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(ReceiveMessageCommand).resolves({});
    expect(await inspector.receiveMessages('q', {})).toEqual([]);
  });

  it('receive/delete/purge throw when the queue is not found', async () => {
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('nope'));
    await expect(inspector.receiveMessages('q', {})).rejects.toThrow('Queue not found');
    await expect(inspector.deleteMessage('q', 'rh')).rejects.toThrow('Queue not found');
    await expect(inspector.purgeQueue('q')).rejects.toThrow('Queue not found');
  });

  it('deletes a message and purges a queue', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(DeleteMessageCommand).resolves({});
    sqsMock.on(PurgeQueueCommand).resolves({});
    await expect(inspector.deleteMessage('q', 'rh')).resolves.toBeUndefined();
    await expect(inspector.purgeQueue('q')).resolves.toBeUndefined();
  });
});

describe('hold / captured / release', () => {
  function stubQueueWithConsumer() {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({
      EventSourceMappings: [{ EventSourceArn: ARN_Q, FunctionArn: 'arn:...:fn', UUID: 'u1', State: 'Enabled' }],
    });
  }

  it('holdQueue returns null when the queue does not exist', async () => {
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('nope'));
    expect(await inspector.holdQueue('missing')).toBeNull();
  });

  it('holdQueue disables the consumer mappings (and tolerates failures)', async () => {
    stubQueueWithConsumer();
    lambdaMock.on(UpdateEventSourceMappingCommand).rejects(new Error('localstack flaky'));
    const res = await inspector.holdQueue('q');
    expect(res).toEqual({ queue: 'q', disabledMappings: 1, held: true });
    expect(lambdaMock.commandCalls(UpdateEventSourceMappingCommand)[0].args[0].input).toMatchObject({ UUID: 'u1', Enabled: false });
  });

  it('getCaptured distinguishes not-held (queue exists) from not-found (unresolved)', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    expect(await inspector.getCaptured('q')).toBe('not-held'); // exists but not held
    sqsMock.reset();
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('nope'));
    expect(await inspector.getCaptured('q')).toBe('not-found'); // unresolved
  });

  it('captures messages while held (drains and deletes), bounded over multiple receive batches', async () => {
    stubQueueWithConsumer();
    lambdaMock.on(UpdateEventSourceMappingCommand).resolves({});
    await inspector.holdQueue('q');

    const full = Array.from({ length: 10 }, (_, n) => ({ MessageId: `f${n}`, ReceiptHandle: `r${n}`, Body: `b${n}` }));
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: full })
      .resolvesOnce({ Messages: [{ MessageId: 'last', Body: 'tail' }] }) // no receiptHandle → skip delete
      .resolves({ Messages: [] });
    sqsMock.on(DeleteMessageCommand).resolves({});

    const captured = await inspector.getCaptured('q');
    expect(captured).toHaveLength(11);
    expect(messagesOf(captured).some(m => m.body === 'tail')).toBe(true);
  });

  it('tolerates delete failures during capture', async () => {
    stubQueueWithConsumer();
    lambdaMock.on(UpdateEventSourceMappingCommand).resolves({});
    await inspector.holdQueue('q');
    sqsMock.on(ReceiveMessageCommand).resolvesOnce({ Messages: [{ MessageId: 'm', ReceiptHandle: 'r', Body: 'b' }] }).resolves({ Messages: [] });
    sqsMock.on(DeleteMessageCommand).rejects(new Error('delete failed'));
    const captured = await inspector.getCaptured('q');
    expect(captured).toHaveLength(1);
  });

  it("releaseQueue returns 'not-held' when the queue exists but isn't held", async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    expect(await inspector.releaseQueue('q')).toBe('not-held');
  });

  it('releaseQueue re-enables mappings and re-dispatches captured messages', async () => {
    stubQueueWithConsumer();
    lambdaMock.on(UpdateEventSourceMappingCommand).resolves({});
    await inspector.holdQueue('q');
    // seed captured buffer directly
    (inspector as any).held.get(URL_Q).captured = [
      { body: 'a', attributes: { MessageGroupId: 'g1' }, receivedAt: 1 },
      { body: 'b', receivedAt: 2 },
    ];
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] }); // nothing extra to drain
    sqsMock.on(SendMessageCommand).resolvesOnce({ MessageId: 's1' }).rejectsOnce(new Error('send failed'));

    const res = await inspector.releaseQueue('q');
    expect(res).toMatchObject({ queue: 'q', released: true });
    expect(releasedOf(res).dispatched).toBe(1); // one send ok, one failed (tolerated)
    expect(lambdaMock.commandCalls(UpdateEventSourceMappingCommand).some(c => (c.args[0].input as any).Enabled === true)).toBe(true);
    expect((inspector as any).held.has(URL_Q)).toBe(false);
  });

  it('re-dispatches FIFO messages with a fresh dedup id', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_FIFO });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(UpdateEventSourceMappingCommand).resolves({});
    await inspector.holdQueue('q.fifo');
    (inspector as any).held.get(URL_FIFO).captured = [{ messageId: 'orig', body: 'a', receivedAt: 1 }];
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 's1' });
    await inspector.releaseQueue('q.fifo');
    const sent = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input as any;
    expect(sent.MessageGroupId).toBe('default');
    expect(sent.MessageDeduplicationId).toContain('replay-orig');
  });
});

describe('polling + metrics internals', () => {
  it('startPolling installs an interval that refreshes metrics; stopPolling clears it', async () => {
    jest.useFakeTimers();
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [URL_Q] });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0' },
    });
    inspector.startPolling();
    inspector.startPolling(); // second call is a no-op (interval already set)
    await jest.advanceTimersByTimeAsync(5000);
    inspector.stopPolling();
    inspector.stopPolling(); // safe to call twice
    expect((inspector as any).pollInterval).toBeNull();
    jest.useRealTimers();
  });

  it('refreshMetrics swallows errors', async () => {
    sqsMock.on(ListQueuesCommand).rejects(new Error('down'));
    await expect((inspector as any).refreshMetrics()).resolves.toBeUndefined();
  });

  it('updateMetricsState tracks processed across observations', () => {
    const i = inspector as any;
    i.updateMetricsState(URL_Q, 5, 0); // first observation → init
    expect(i.metrics.get(URL_Q).processed).toBe(0);
    i.updateMetricsState(URL_Q, 5, 3); // 3 went in-flight (inFlightDelta < 0) → no processed
    expect(i.metrics.get(URL_Q).processed).toBe(0);
    i.updateMetricsState(URL_Q, 5, 0); // 3 left in-flight, no re-appear → processed += 3
    expect(i.metrics.get(URL_Q).processed).toBe(3);
    i.updateMetricsState(URL_Q, 0, 2); // seed inFlight 2
    i.updateMetricsState(URL_Q, 1, 0); // 2 left in-flight but 1 re-appeared → processed += 1
    expect(i.metrics.get(URL_Q).processed).toBe(4);
  });

  it('resetProcessedCount zeroes only matching queues', () => {
    const i = inspector as any;
    i.metrics.set(URL_Q, { lastAvailable: 0, lastInFlight: 0, processed: 7 });
    i.metrics.set('http://localhost:4566/000/other', { lastAvailable: 0, lastInFlight: 0, processed: 9 });
    inspector.resetProcessedCount('q');
    expect(i.metrics.get(URL_Q).processed).toBe(0);
    expect(i.metrics.get('http://localhost:4566/000/other').processed).toBe(9);
  });
});

describe('defensive fallback branches', () => {
  it('resolveQueueUrl returns null when the response has no QueueUrl', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({}); // no QueueUrl → `|| null`
    expect(await inspector.getQueue('q')).toBeNull();
  });

  it('listQueues handles a ListQueues response without QueueUrls', async () => {
    sqsMock.on(ListQueuesCommand).resolves({}); // no QueueUrls → `|| []`
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({});
    expect(await inspector.listQueues()).toEqual([]);
  });

  it('builds a snapshot from an empty attributes payload (no arn, default counts, full-url name)', async () => {
    // GetQueueAttributes returns no Attributes → counts default to 0, arn undefined,
    // and a trailing-slash url makes split('/').pop() empty so name falls back to the url.
    const trailingUrl = 'http://localhost:4566/000000000000/q/';
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [trailingUrl] });
    sqsMock.on(GetQueueAttributesCommand).resolves({}); // no Attributes
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({}); // no EventSourceMappings → `|| []`
    const queues = await inspector.listQueues();
    expect(queues).toHaveLength(1);
    expect(queues[0]).toMatchObject({ name: trailingUrl, available: 0, inFlight: 0, arn: undefined, consumers: [] });
  });

  it('classifies consumer state (Creating/other) and tolerates a trailing-colon FunctionArn', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_Q });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({
      EventSourceMappings: [
        { EventSourceArn: ARN_Q, FunctionArn: 'arn:aws:lambda:us-east-1:000:function:creating', UUID: 'c1', State: 'Creating' },
        { EventSourceArn: ARN_Q, FunctionArn: 'arn:aws:lambda:us-east-1:000:function:disabled', UUID: 'd1', State: 'Disabled' },
        { EventSourceArn: ARN_Q, FunctionArn: 'arn:aws:lambda:us-east-1:000:function:', UUID: 'e1', State: 'Enabled' }, // trailing colon → split().pop() === ''
      ],
    });
    const snap = await inspector.getQueue('q');
    const byUuid = Object.fromEntries(snap!.consumers.map(c => [c.uuid, c]));
    expect(byUuid.c1.enabled).toBe(true); // Creating counts as enabled
    expect(byUuid.d1.enabled).toBe(false); // Disabled does not
    expect(byUuid.e1.functionName).toBe('arn:aws:lambda:us-east-1:000:function:'); // fell back to full arn
  });

  it("releaseQueue returns 'not-found' when the url cannot be resolved", async () => {
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('nope'));
    expect(await inspector.releaseQueue('q')).toBe('not-found');
  });

  it('re-dispatches captured messages with empty body fallback and group/dedup fallbacks', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: URL_FIFO });
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', QueueArn: ARN_Q },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({});
    lambdaMock.on(UpdateEventSourceMappingCommand).resolves({});
    await inspector.holdQueue('q.fifo');
    (inspector as any).held.get(URL_FIFO).captured = [
      { body: undefined, attributes: { MessageGroupId: 'gKept' }, receivedAt: 1 }, // body ?? '' + attributes.MessageGroupId
      { receivedAt: 2 }, // no messageId → `?? dispatched`
    ];
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 's' });
    const res = await inspector.releaseQueue('q.fifo');
    expect(releasedOf(res).dispatched).toBe(2);
    const sends = sqsMock.commandCalls(SendMessageCommand).map(c => c.args[0].input as any);
    expect(sends[0].MessageGroupId).toBe('gKept'); // reused original group id
    expect(sends[0].MessageBody).toBe(''); // body ?? ''
  });
});
