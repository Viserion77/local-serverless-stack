// SQS → Lambda delivery loops: event shape, delete-on-success,
// leave-to-visibility on failure, RuntimeUnavailable backoff, Enabled=false
// hold semantics, batching-window accumulation and FIFO per-group ordering.

import { SqsEmulator } from '../../../../src/server/engine/emulators/sqs/index.js';
import { LambdaCtlEmulator } from '../../../../src/server/engine/emulators/lambda-ctl/index.js';
import { SqsPollerSet, buildSqsLambdaEvent } from '../../../../src/server/engine/dispatch/sqs-poller.js';
import type { EngineInvokeResult } from '../../../../src/server/engine/types.js';
import { awsReq, jsonReq, makeCtx, sleep, waitFor } from './helpers.js';
import type { InvokeCall, TestEngineContext } from './helpers.js';

const REGION = 'us-east-1';
const QUEUE_ARN = (name: string): string => `arn:aws:sqs:us-east-1:000000000000:${name}`;

describe('SqsPollerSet', () => {
  let tc: TestEngineContext;
  let sqs: SqsEmulator;
  let lambdaCtl: LambdaCtlEmulator;
  let pollers: SqsPollerSet | null;

  beforeEach(() => {
    tc = makeCtx();
    sqs = new SqsEmulator(tc.ctx);
    lambdaCtl = new LambdaCtlEmulator(tc.ctx);
    pollers = null;
  });

  afterEach(async () => {
    pollers?.stopAll();
    await tc.cleanup();
  });

  async function createQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
    const result = (await sqs.handle('CreateQueue', { QueueName: name, Attributes: attributes }, awsReq(REGION))) as {
      QueueUrl: string;
    };
    return result.QueueUrl;
  }

  async function createEsm(body: Record<string, unknown>): Promise<{ UUID: string }> {
    const response = await lambdaCtl.handle(jsonReq(REGION, 'POST', '/2015-03-31/event-source-mappings', body));
    return JSON.parse(String(response.body)) as { UUID: string };
  }

  async function counters(queueUrl: string): Promise<Record<string, string>> {
    const result = (await sqs.handle(
      'GetQueueAttributes',
      { QueueUrl: queueUrl, AttributeNames: ['All'] },
      awsReq(REGION),
    )) as { Attributes: Record<string, string> };
    return result.Attributes;
  }

  function startPollers(
    plan: EngineInvokeResult[] | ((call: InvokeCall) => EngineInvokeResult),
    backoffs?: number[],
  ): InvokeCall[] {
    const calls: InvokeCall[] = [];
    pollers = new SqsPollerSet({
      ctx: tc.ctx,
      sqs,
      lambdaCtl,
      invoke: async (ref, event, opts) => {
        const call = { ref, event, opts };
        const result = typeof plan === 'function' ? plan(call) : plan[Math.min(calls.length, plan.length - 1)];
        calls.push(call);
        return result;
      },
      runtimeRetryBackoffMs: backoffs ?? [10, 20, 30],
    });
    // Mirror the dispatcher wiring: re-sync loops on every ESM change.
    lambdaCtl.onEsmChanged(region => (pollers as SqsPollerSet).sync(region));
    pollers.sync(REGION);
    return calls;
  }

  function records(call: InvokeCall): Array<Record<string, unknown>> {
    return (call.event as { Records: Array<Record<string, unknown>> }).Records;
  }

  test('delivers a faithful SQS event and deletes the batch on success', async () => {
    const queueUrl = await createQueue('orders');
    await createEsm({ FunctionName: 'consumer', EventSourceArn: QUEUE_ARN('orders'), BatchSize: 10 });
    const calls = startPollers([{ ok: true }]);

    await sqs.handle(
      'SendMessage',
      {
        QueueUrl: queueUrl,
        MessageBody: 'hello',
        MessageAttributes: { Color: { DataType: 'String', StringValue: 'gray' } },
      },
      awsReq(REGION),
    );
    await waitFor(() => calls.length >= 1, 3000, 'first delivery');

    expect(calls[0].ref).toBe('consumer');
    const [record] = records(calls[0]);
    expect(record.body).toBe('hello');
    expect(record.eventSource).toBe('aws:sqs');
    expect(record.eventSourceARN).toBe(QUEUE_ARN('orders'));
    expect(record.awsRegion).toBe(REGION);
    expect(typeof record.messageId).toBe('string');
    expect(typeof record.receiptHandle).toBe('string');
    expect(typeof record.md5OfBody).toBe('string');
    const attributes = record.attributes as Record<string, string>;
    expect(attributes.ApproximateReceiveCount).toBe('1');
    expect(attributes.SenderId).toBe('AIDASELFENGINE');
    expect(attributes.SentTimestamp).toMatch(/^\d+$/);
    expect(attributes.ApproximateFirstReceiveTimestamp).toMatch(/^\d+$/);
    expect(record.messageAttributes).toEqual({
      Color: { stringValue: 'gray', stringListValues: [], binaryListValues: [], dataType: 'String' },
    });

    await waitFor(async () => true, 10);
    const attrs = await counters(queueUrl);
    expect(attrs.ApproximateNumberOfMessages).toBe('0');
    expect(attrs.ApproximateNumberOfMessagesNotVisible).toBe('0');
  });

  test('failure leaves the batch to visibility expiry and redelivers', async () => {
    const queueUrl = await createQueue('flaky', { VisibilityTimeout: '1' });
    await createEsm({ FunctionName: 'consumer', EventSourceArn: QUEUE_ARN('flaky'), BatchSize: 10 });
    const calls = startPollers([{ ok: false, errorType: 'Unhandled', errorMessage: 'boom' }, { ok: true }]);

    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'retry-me' }, awsReq(REGION));
    await waitFor(() => calls.length >= 1, 3000, 'first (failing) delivery');

    // Not deleted: still in flight until the 1 s visibility timeout expires.
    let attrs = await counters(queueUrl);
    expect(attrs.ApproximateNumberOfMessagesNotVisible).toBe('1');

    await waitFor(() => calls.length >= 2, 4000, 'redelivery after visibility expiry');
    const [record] = records(calls[1]);
    expect(record.body).toBe('retry-me');
    expect((record.attributes as Record<string, string>).ApproximateReceiveCount).toBe('2');

    await waitFor(async () => {
      attrs = await counters(queueUrl);
      return attrs.ApproximateNumberOfMessages === '0' && attrs.ApproximateNumberOfMessagesNotVisible === '0';
    }, 2000, 'batch deleted after successful redelivery');
  });

  test('RuntimeUnavailable retries the same batch with backoff, then succeeds', async () => {
    const queueUrl = await createQueue('starting-up');
    await createEsm({ FunctionName: 'consumer', EventSourceArn: QUEUE_ARN('starting-up'), BatchSize: 10 });
    const calls = startPollers([
      { ok: false, errorType: 'RuntimeUnavailable', errorMessage: 'worker restarting' },
      { ok: false, errorType: 'RuntimeUnavailable', errorMessage: 'worker restarting' },
      { ok: true },
    ]);

    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'patience' }, awsReq(REGION));
    await waitFor(() => calls.length >= 3, 3000, 'retry sequence');

    // Same batch each time: the receive count never moved.
    for (const call of calls.slice(0, 3)) {
      expect((records(call)[0].attributes as Record<string, string>).ApproximateReceiveCount).toBe('1');
    }
    const attrs = await counters(queueUrl);
    expect(attrs.ApproximateNumberOfMessages).toBe('0');
    expect(attrs.ApproximateNumberOfMessagesNotVisible).toBe('0');
  });

  test('Enabled=false stops delivery promptly (QueueInspector hold semantics)', async () => {
    const queueUrl = await createQueue('held');
    const esm = await createEsm({ FunctionName: 'consumer', EventSourceArn: QUEUE_ARN('held'), BatchSize: 10 });
    const calls = startPollers([{ ok: true }]);

    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'one' }, awsReq(REGION));
    await waitFor(() => calls.length >= 1, 3000, 'delivery while enabled');

    await lambdaCtl.handle(jsonReq(REGION, 'PUT', `/2015-03-31/event-source-mappings/${esm.UUID}`, { Enabled: false }));
    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'two' }, awsReq(REGION));
    await sleep(300);
    expect(calls).toHaveLength(1);
    // The message is untouched, waiting for release.
    expect((await counters(queueUrl)).ApproximateNumberOfMessages).toBe('1');

    // Release: Enabled=true resumes delivery of the backlog.
    await lambdaCtl.handle(jsonReq(REGION, 'PUT', `/2015-03-31/event-source-mappings/${esm.UUID}`, { Enabled: true }));
    await waitFor(() => calls.length >= 2, 3000, 'delivery after release');
    expect(records(calls[1])[0].body).toBe('two');
  });

  test('maximumBatchingWindowInSeconds accumulates short batches', async () => {
    const queueUrl = await createQueue('batchy');
    await createEsm({
      FunctionName: 'consumer',
      EventSourceArn: QUEUE_ARN('batchy'),
      BatchSize: 5,
      MaximumBatchingWindowInSeconds: 1,
    });
    // Both messages visible before the loops first wake.
    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'a' }, awsReq(REGION));
    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'b' }, awsReq(REGION));
    const calls = startPollers([{ ok: true }]);

    await sleep(300);
    expect(calls).toHaveLength(0); // still inside the window
    await waitFor(() => calls.length >= 1, 3000, 'window flush');
    expect(records(calls[0]).map(r => r.body).sort()).toEqual(['a', 'b']);
  });

  test('a full batch is never delayed by the batching window', async () => {
    const queueUrl = await createQueue('fullbatch');
    await createEsm({
      FunctionName: 'consumer',
      EventSourceArn: QUEUE_ARN('fullbatch'),
      BatchSize: 3,
      MaximumBatchingWindowInSeconds: 30,
    });
    for (const body of ['1', '2', '3']) {
      await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: body }, awsReq(REGION));
    }
    const calls = startPollers([{ ok: true }]);
    await waitFor(() => calls.length >= 1, 500, 'immediate full-batch delivery');
    expect(records(calls[0])).toHaveLength(3);
  });

  test('FIFO order is preserved per message group', async () => {
    const queueUrl = await createQueue('jobs.fifo', {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'true',
      VisibilityTimeout: '5',
    });
    await createEsm({ FunctionName: 'consumer', EventSourceArn: QUEUE_ARN('jobs.fifo'), BatchSize: 1 });
    const calls = startPollers([{ ok: true }]);

    for (const body of ['first', 'second', 'third']) {
      await sqs.handle(
        'SendMessage',
        { QueueUrl: queueUrl, MessageBody: body, MessageGroupId: 'g1' },
        awsReq(REGION),
      );
    }
    await waitFor(() => calls.length >= 3, 3000, 'all three FIFO deliveries');

    const bodies = calls.map(call => records(call)[0].body);
    expect(bodies).toEqual(['first', 'second', 'third']);
    const attributes = records(calls[0])[0].attributes as Record<string, string>;
    expect(attributes.MessageGroupId).toBe('g1');
    expect(attributes.SequenceNumber).toMatch(/^\d+$/);
    expect(attributes.MessageDeduplicationId).toBeDefined();
  });

  // --- LSS-SQS-ESM-REDRIVE (partial-batch half): ReportBatchItemFailures ----

  test('ReportBatchItemFailures deletes only the succeeded messages; the failed one redelivers', async () => {
    const queueUrl = await createQueue('bus', { VisibilityTimeout: '1' });
    await createEsm({
      FunctionName: 'relay',
      EventSourceArn: QUEUE_ARN('bus'),
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
    // The handler reports the 'fail2' message as failed on every invoke.
    const calls = startPollers(call => {
      const failing = records(call).find(r => r.body === 'fail2');
      return { ok: true, payload: { batchItemFailures: failing ? [{ itemIdentifier: failing.messageId }] : [] } };
    });

    for (const body of ['keep1', 'fail2', 'keep3']) {
      await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: body }, awsReq(REGION));
    }
    await waitFor(() => calls.length >= 1, 3000, 'first delivery');

    // keep1 and keep3 are deleted; only fail2 stays in flight.
    await waitFor(async () => {
      const a = await counters(queueUrl);
      return a.ApproximateNumberOfMessagesNotVisible === '1' && a.ApproximateNumberOfMessages === '0';
    }, 2000, 'only the failed message remains in flight');

    // After the 1s visibility timeout, fail2 redelivers with an incremented
    // ApproximateReceiveCount (batching order of the initial sends is irrelevant).
    await waitFor(
      () => calls.some(c => records(c).some(r =>
        r.body === 'fail2' && (r.attributes as Record<string, string>).ApproximateReceiveCount === '2')),
      4000,
      'redelivery of the failed message',
    );
    const bodyCount = (body: string): number => calls.flatMap(records).filter(r => r.body === body).length;
    expect(bodyCount('keep1')).toBe(1); // deleted after its first (successful) delivery
    expect(bodyCount('keep3')).toBe(1);
    expect(bodyCount('fail2')).toBeGreaterThanOrEqual(2); // stayed in flight and redelivered
  });

  test('without ReportBatchItemFailures a successful invoke still deletes the whole batch (no regression)', async () => {
    const queueUrl = await createQueue('legacy');
    await createEsm({ FunctionName: 'relay', EventSourceArn: QUEUE_ARN('legacy'), BatchSize: 10 });
    // Handler returns a batchItemFailures body, but the ESM did not opt in.
    const calls = startPollers([{ ok: true, payload: { batchItemFailures: [{ itemIdentifier: 'ignored' }] } }]);

    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'x' }, awsReq(REGION));
    await waitFor(() => calls.length >= 1, 3000, 'delivery');
    await waitFor(async () => {
      const a = await counters(queueUrl);
      return a.ApproximateNumberOfMessages === '0' && a.ApproximateNumberOfMessagesNotVisible === '0';
    }, 2000, 'whole batch deleted regardless of the response body');
  });

  // --- LSS-ESM-FILTER-CRITERIA: SQS leg -------------------------------------

  test('FilterCriteria delivers only matching messages and auto-deletes the rest', async () => {
    const queueUrl = await createQueue('orders-bus', { VisibilityTimeout: '1' });
    await createEsm({
      FunctionName: 'order-relay',
      EventSourceArn: QUEUE_ARN('orders-bus'),
      BatchSize: 10,
      FilterCriteria: { Filters: [{ Pattern: '{"body":{"status":["completed"]}}' }] },
    });
    const calls = startPollers([{ ok: true }]);

    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: '{"status":"completed"}' }, awsReq(REGION));
    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: '{"status":"pending"}' }, awsReq(REGION));
    await sqs.handle('SendMessage', { QueueUrl: queueUrl, MessageBody: 'PING' }, awsReq(REGION));

    await waitFor(() => calls.length >= 1, 3000, 'matching delivery');
    const delivered = calls.flatMap(records);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].body).toBe('{"status":"completed"}');

    // Non-matching messages are auto-deleted and never redeliver: queue drains.
    await waitFor(async () => {
      const a = await counters(queueUrl);
      return a.ApproximateNumberOfMessages === '0' && a.ApproximateNumberOfMessagesNotVisible === '0';
    }, 4000, 'queue fully drained without redelivery');
    await sleep(200); // past what a visibility redelivery would need
    expect(calls.flatMap(records)).toHaveLength(1);
  });

  test('non-SQS event sources and deleted ESMs are ignored', async () => {
    await createQueue('plain');
    await createEsm({
      FunctionName: 'consumer',
      EventSourceArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/t/stream/2026',
      StartingPosition: 'LATEST',
    });
    const esm = await createEsm({ FunctionName: 'consumer', EventSourceArn: QUEUE_ARN('plain'), BatchSize: 10 });
    startPollers([{ ok: true }]);
    expect((pollers as SqsPollerSet).loopCount()).toBe(1);

    await lambdaCtl.handle(jsonReq(REGION, 'DELETE', `/2015-03-31/event-source-mappings/${esm.UUID}`));
    expect((pollers as SqsPollerSet).loopCount()).toBe(0);
  });
});

describe('buildSqsLambdaEvent', () => {
  test('binary message attributes keep their base64 payload', () => {
    const event = buildSqsLambdaEvent(
      [
        {
          messageId: 'm-1',
          receiptHandle: 'rh-1',
          body: 'x',
          attributes: { ApproximateFirstReceiveTimestamp: '100' },
          messageAttributes: { Data: { DataType: 'Binary', BinaryValue: 'aGVsbG8=' } },
          md5OfBody: 'd41d8cd98f00b204e9800998ecf8427e',
          sentTimestamp: 99,
          approximateReceiveCount: 4,
        },
      ],
      'arn:aws:sqs:us-east-1:000000000000:q',
      'us-east-1',
    );
    const record = event.Records[0];
    expect(record.messageAttributes).toEqual({
      Data: { binaryValue: 'aGVsbG8=', stringListValues: [], binaryListValues: [], dataType: 'Binary' },
    });
    expect((record.attributes as Record<string, string>).ApproximateReceiveCount).toBe('4');
    expect((record.attributes as Record<string, string>).ApproximateFirstReceiveTimestamp).toBe('100');
  });
});
