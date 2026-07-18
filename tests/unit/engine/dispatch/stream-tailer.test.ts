// DynamoDB Streams → Lambda tailers: in-order INSERT/MODIFY delivery, LATEST
// vs TRIM_HORIZON starting positions, retry-then-advance on a poisoned batch
// and the OnFailure SQS destination envelope.

import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb/index.js';
import { SqsEmulator } from '../../../../src/server/engine/emulators/sqs/index.js';
import { LambdaCtlEmulator } from '../../../../src/server/engine/emulators/lambda-ctl/index.js';
import { StreamTailerSet } from '../../../../src/server/engine/dispatch/stream-tailer.js';
import type { EngineInvokeResult } from '../../../../src/server/engine/types.js';
import { awsReq, jsonReq, makeCtx, sleep, waitFor } from './helpers.js';
import type { InvokeCall, TestEngineContext } from './helpers.js';

const REGION = 'us-east-1';

interface WireStreamRecord {
  eventName: string;
  eventSourceARN: string;
  dynamodb: {
    Keys: Record<string, unknown>;
    NewImage?: Record<string, unknown>;
    OldImage?: Record<string, unknown>;
    SequenceNumber: string;
    ApproximateCreationDateTime: number;
  };
}

describe('StreamTailerSet', () => {
  let tc: TestEngineContext;
  let dynamo: DynamoDbEmulator;
  let sqs: SqsEmulator;
  let lambdaCtl: LambdaCtlEmulator;
  let tailers: StreamTailerSet | null;

  beforeEach(() => {
    tc = makeCtx();
    dynamo = new DynamoDbEmulator(tc.ctx);
    sqs = new SqsEmulator(tc.ctx);
    lambdaCtl = new LambdaCtlEmulator(tc.ctx);
    tailers = null;
  });

  afterEach(async () => {
    tailers?.stopAll();
    await tc.cleanup();
  });

  async function createStreamTable(tableName: string): Promise<string> {
    await dynamo.handle(
      'CreateTable',
      {
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
      },
      awsReq(REGION),
    );
    const described = (await dynamo.handle('DescribeTable', { TableName: tableName }, awsReq(REGION))) as {
      Table: { LatestStreamArn: string };
    };
    return described.Table.LatestStreamArn;
  }

  async function createEsm(body: Record<string, unknown>): Promise<{ UUID: string }> {
    const response = await lambdaCtl.handle(jsonReq(REGION, 'POST', '/2015-03-31/event-source-mappings', body));
    return JSON.parse(String(response.body)) as { UUID: string };
  }

  async function putItem(tableName: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
    await dynamo.handle('PutItem', { TableName: tableName, Item: { id: { S: id }, ...extra } }, awsReq(REGION));
  }

  function startTailers(plan: EngineInvokeResult[] | ((call: InvokeCall) => EngineInvokeResult)): InvokeCall[] {
    const calls: InvokeCall[] = [];
    tailers = new StreamTailerSet({
      ctx: tc.ctx,
      dynamo,
      sqs,
      lambdaCtl,
      invoke: async (ref, event, opts) => {
        const call = { ref, event, opts };
        const result = typeof plan === 'function' ? plan(call) : plan[Math.min(calls.length, plan.length - 1)];
        calls.push(call);
        return result;
      },
      retryBackoffMs: 5,
    });
    lambdaCtl.onEsmChanged(region => (tailers as StreamTailerSet).sync(region));
    tailers.sync(REGION);
    return calls;
  }

  function records(call: InvokeCall): WireStreamRecord[] {
    return (call.event as { Records: WireStreamRecord[] }).Records;
  }

  function ids(call: InvokeCall): string[] {
    return records(call).map(r => (r.dynamodb.Keys.id as { S: string }).S);
  }

  async function createDlq(name: string): Promise<string> {
    return ((await sqs.handle('CreateQueue', { QueueName: name }, awsReq(REGION))) as { QueueUrl: string }).QueueUrl;
  }

  function dlqArn(name: string): string {
    return `arn:aws:sqs:us-east-1:000000000000:${name}`;
  }

  test('delivers INSERT then MODIFY in order with AWS-shaped records', async () => {
    const streamArn = await createStreamTable('orders');
    await createEsm({
      FunctionName: 'projector',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
    });
    const calls = startTailers([{ ok: true }]);

    await putItem('orders', 'o-1', { status: { S: 'new' } });
    await putItem('orders', 'o-1', { status: { S: 'paid' } });
    await waitFor(() => calls.reduce((n, c) => n + records(c).length, 0) >= 2, 3000, 'both stream records');

    const all = calls.flatMap(call => records(call));
    expect(all[0].eventName).toBe('INSERT');
    expect(all[0].dynamodb.Keys).toEqual({ id: { S: 'o-1' } });
    expect(all[0].dynamodb.NewImage).toEqual({ id: { S: 'o-1' }, status: { S: 'new' } });
    expect(all[0].eventSourceARN).toBe(streamArn);
    expect(all[1].eventName).toBe('MODIFY');
    expect(all[1].dynamodb.OldImage).toEqual({ id: { S: 'o-1' }, status: { S: 'new' } });
    expect(all[1].dynamodb.NewImage).toEqual({ id: { S: 'o-1' }, status: { S: 'paid' } });
    expect(BigInt(all[1].dynamodb.SequenceNumber)).toBeGreaterThan(BigInt(all[0].dynamodb.SequenceNumber));
    expect(calls[0].ref).toBe('projector');
  });

  test('TRIM_HORIZON replays existing records; LATEST starts after them', async () => {
    const streamArn = await createStreamTable('events');
    await putItem('events', 'pre-existing');

    await createEsm({
      FunctionName: 'latest-consumer',
      EventSourceArn: streamArn,
      StartingPosition: 'LATEST',
      BatchSize: 10,
    });
    const calls = startTailers([{ ok: true }]);
    await sleep(100);
    expect(calls).toHaveLength(0); // LATEST skips the backlog

    await putItem('events', 'fresh');
    await waitFor(() => calls.length >= 1, 3000, 'fresh record via LATEST');
    expect(records(calls[0])).toHaveLength(1);
    expect(records(calls[0])[0].dynamodb.Keys).toEqual({ id: { S: 'fresh' } });

    // A second, TRIM_HORIZON consumer sees the whole ring from the start.
    await createEsm({
      FunctionName: 'horizon-consumer',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
    });
    await waitFor(
      () => calls.some(c => c.ref === 'horizon-consumer' && records(c).length === 2),
      3000,
      'TRIM_HORIZON replay',
    );
  });

  test('a failing batch retries maximumRetryAttempts times, then the tailer advances', async () => {
    const streamArn = await createStreamTable('poison');
    await createEsm({
      FunctionName: 'fragile',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: 1,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = startTailers(call => {
      const poisoned = records(call).some(r => r.dynamodb.Keys.id && JSON.stringify(r.dynamodb.Keys).includes('bad'));
      return poisoned ? { ok: false, errorType: 'Unhandled', errorMessage: 'kaboom' } : { ok: true };
    });

    await putItem('poison', 'bad');
    // Initial attempt + 1 retry for the poisoned batch.
    await waitFor(() => calls.length >= 2, 3000, 'poisoned batch retries');
    await sleep(50);
    expect(calls).toHaveLength(2);

    // The tailer advanced: the next record is delivered on its own.
    await putItem('poison', 'good');
    await waitFor(() => calls.length >= 3, 3000, 'post-poison delivery');
    expect(records(calls[2])).toHaveLength(1);
    expect(records(calls[2])[0].dynamodb.Keys).toEqual({ id: { S: 'good' } });
    expect(warn.mock.calls.some(c => String(c[0]).includes('advancing past it'))).toBe(true);
    warn.mockRestore();
  });

  test('exhausted retries send the AWS OnFailure envelope to the SQS destination', async () => {
    const streamArn = await createStreamTable('audited');
    const dlqUrl = ((await sqs.handle('CreateQueue', { QueueName: 'stream-dlq' }, awsReq(REGION))) as {
      QueueUrl: string;
    }).QueueUrl;
    // Both records exist before the tailer starts, so they form one batch.
    await putItem('audited', 'x1');
    await putItem('audited', 'x2');
    await createEsm({
      FunctionName: 'always-fails',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: 'arn:aws:sqs:us-east-1:000000000000:stream-dlq' } },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = startTailers([{ ok: false, errorType: 'Unhandled', errorMessage: 'kaboom' }]);
    await waitFor(() => calls.length >= 3, 3000, 'retry exhaustion');

    // Long-poll the DLQ: the envelope is sent right after the last retry.
    const received = (await sqs.handle(
      'ReceiveMessage',
      { QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 },
      awsReq(REGION),
    )) as { Messages?: Array<{ Body: string }> };
    const body = received.Messages?.[0]?.Body;
    expect(body).toBeDefined();

    const envelope = JSON.parse(body as string);
    expect(envelope.version).toBe('1.0');
    expect(envelope.requestContext.condition).toBe('RetryAttemptsExhausted');
    expect(envelope.requestContext.functionArn).toBe('arn:aws:lambda:us-east-1:000000000000:function:always-fails');
    expect(envelope.requestContext.approximateInvokeCount).toBe(3); // initial + 2 retries
    expect(envelope.responseContext).toEqual({ statusCode: 200, functionError: 'Unhandled' });
    expect(typeof envelope.timestamp).toBe('string');
    const info = envelope.DDBStreamBatchInfo;
    expect(info.shardId).toBe('shardId-000000000000');
    expect(info.batchSize).toBe(2);
    expect(info.streamArn).toBe(streamArn);
    expect(BigInt(info.endSequenceNumber)).toBeGreaterThan(BigInt(info.startSequenceNumber) - 1n);
    expect(typeof info.approximateArrivalOfFirstRecord).toBe('string');
    expect(typeof info.approximateArrivalOfLastRecord).toBe('string');
    warn.mockRestore();
  });

  // --- LSS-STREAM-ESM-RETRY-01: AWS-faithful maximumRetryAttempts -----------

  test('no MaximumRetryAttempts (AWS default -1) retries far past the old cap of 5 and never drops the batch', async () => {
    const streamArn = await createStreamTable('infinite');
    await createEsm({
      FunctionName: 'never-gives-up',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = startTailers([{ ok: false, errorType: 'Unhandled', errorMessage: 'kaboom' }]);

    await putItem('infinite', 'poison');
    // The old code capped at 5 retries (6 attempts) then advanced. Prove we go
    // well past that and keep climbing while the record is still in the ring.
    await waitFor(() => calls.length > 8, 3000, 'retries past the old cap of 5');
    const seen = calls.length;
    await sleep(40);
    expect(calls.length).toBeGreaterThan(seen);
    expect(warn.mock.calls.some(c => String(c[0]).includes('advancing past it'))).toBe(false);
    warn.mockRestore();
  });

  test('explicit MaximumRetryAttempts: -1 still invokes at least once (regression: never a zero-invocation drop)', async () => {
    const streamArn = await createStreamTable('minus-one');
    await createEsm({
      FunctionName: 'stubborn',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: -1,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = startTailers([{ ok: false, errorType: 'Unhandled' }]);

    await putItem('minus-one', 'poison');
    await waitFor(() => calls.length >= 1, 3000, 'at least one invoke');
    const seen = calls.length;
    await sleep(40);
    expect(calls.length).toBeGreaterThan(seen); // keeps retrying, never dropped
    warn.mockRestore();
  });

  test('a positive MaximumRetryAttempts is honored with no cap at 5 (N=8 → 9 attempts)', async () => {
    const streamArn = await createStreamTable('bignum');
    await createEsm({
      FunctionName: 'fragile8',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: 8,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = startTailers([{ ok: false, errorType: 'Unhandled' }]);

    await putItem('bignum', 'poison');
    await waitFor(() => calls.length >= 9, 3000, 'nine attempts');
    await sleep(60);
    expect(calls).toHaveLength(9); // 1 initial + 8 retries, not truncated to 6
    expect(warn.mock.calls.some(c => String(c[0]).includes('advancing past it'))).toBe(true);
    warn.mockRestore();
  });

  test('disabling an ESM mid-infinite-retry halts invokes and sends no OnFailure envelope', async () => {
    const streamArn = await createStreamTable('haltable');
    const dlqUrl = await createDlq('halt-dlq');
    const esm = await createEsm({
      FunctionName: 'stuck',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      DestinationConfig: { OnFailure: { Destination: dlqArn('halt-dlq') } },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls = startTailers([{ ok: false, errorType: 'Unhandled' }]);

    await putItem('haltable', 'poison');
    await waitFor(() => calls.length >= 3, 3000, 'infinite retries running');

    await lambdaCtl.handle(jsonReq(REGION, 'PUT', `/2015-03-31/event-source-mappings/${esm.UUID}`, { Enabled: false }));
    const frozen = calls.length;
    await sleep(60);
    expect(calls.length).toBeLessThanOrEqual(frozen + 1); // halted promptly

    const received = (await sqs.handle('ReceiveMessage', { QueueUrl: dlqUrl, WaitTimeSeconds: 0 }, awsReq(REGION))) as {
      Messages?: unknown[];
    };
    expect(received.Messages ?? []).toHaveLength(0);
    warn.mockRestore();
  });

  // --- LSS-DDBSTREAM-RBIF-01: ReportBatchItemFailures partial batches --------

  test('ReportBatchItemFailures checkpoints before the earliest failure and DLQs only the failing suffix', async () => {
    const streamArn = await createStreamTable('projected');
    const dlqUrl = await createDlq('proj-dlq');
    // All three exist before the tailer starts → one batch [r1,r2,r3].
    await putItem('projected', 'r1');
    await putItem('projected', 'r2');
    await putItem('projected', 'r3');
    await createEsm({
      FunctionName: 'projector',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: 2,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: dlqArn('proj-dlq') } },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The handler always reports r2 as the failing record.
    const calls = startTailers(call => {
      const r2 = records(call).find(r => (r.dynamodb.Keys.id as { S: string }).S === 'r2');
      return { ok: true, payload: { batchItemFailures: r2 ? [{ itemIdentifier: r2.dynamodb.SequenceNumber }] : [] } };
    });

    await waitFor(() => calls.length >= 3, 3000, 'initial + 2 retries');
    await sleep(40);

    // First invoke saw all three; every retry saw exactly [r2, r3].
    expect(ids(calls[0])).toEqual(['r1', 'r2', 'r3']);
    for (const call of calls.slice(1)) expect(ids(call)).toEqual(['r2', 'r3']);
    expect(calls).toHaveLength(3); // r1 committed, never re-delivered

    const received = (await sqs.handle(
      'ReceiveMessage',
      { QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 },
      awsReq(REGION),
    )) as { Messages?: Array<{ Body: string }> };
    const envelope = JSON.parse(received.Messages![0].Body);
    const s2 = records(calls[1])[0].dynamodb.SequenceNumber;
    const s3 = records(calls[1])[1].dynamodb.SequenceNumber;
    expect(envelope.DDBStreamBatchInfo.startSequenceNumber).toBe(s2);
    expect(envelope.DDBStreamBatchInfo.endSequenceNumber).toBe(s3);
    expect(envelope.DDBStreamBatchInfo.batchSize).toBe(2); // the suffix, not 3
    expect(envelope.requestContext.condition).toBe('RetryAttemptsExhausted');
    expect(envelope.requestContext.approximateInvokeCount).toBe(3);

    // After exhaustion the cursor advanced past the whole batch: r4 on its own.
    await putItem('projected', 'r4');
    await waitFor(() => calls.some(c => ids(c).includes('r4')), 3000, 'r4 delivered');
    expect(ids(calls.find(c => ids(c).includes('r4'))!)).toEqual(['r4']);
    warn.mockRestore();
  });

  test('ReportBatchItemFailures: an empty failure list commits the whole batch (no re-delivery, no DLQ)', async () => {
    const streamArn = await createStreamTable('allgood');
    const dlqUrl = await createDlq('allgood-dlq');
    await putItem('allgood', 'g1');
    await putItem('allgood', 'g2');
    await createEsm({
      FunctionName: 'acker',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: 2,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: dlqArn('allgood-dlq') } },
    });
    const calls = startTailers([{ ok: true, payload: { batchItemFailures: [] } }]);

    await waitFor(() => calls.length >= 1, 3000, 'first delivery');
    await sleep(60);
    expect(calls).toHaveLength(1); // committed once, never re-delivered

    const received = (await sqs.handle('ReceiveMessage', { QueueUrl: dlqUrl, WaitTimeSeconds: 0 }, awsReq(REGION))) as {
      Messages?: unknown[];
    };
    expect(received.Messages ?? []).toHaveLength(0);
  });

  test('ReportBatchItemFailures: a malformed response retries the whole batch then DLQs all of it', async () => {
    const streamArn = await createStreamTable('malformed');
    const dlqUrl = await createDlq('malformed-dlq');
    await putItem('malformed', 'r1');
    await putItem('malformed', 'r2');
    await putItem('malformed', 'r3');
    await createEsm({
      FunctionName: 'confused',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      MaximumRetryAttempts: 2,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: dlqArn('malformed-dlq') } },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // itemIdentifier does not match any SequenceNumber in the batch → malformed.
    const calls = startTailers([{ ok: true, payload: { batchItemFailures: [{ itemIdentifier: 'does-not-exist' }] } }]);

    await waitFor(() => calls.length >= 3, 3000, 'whole-batch retries');
    await sleep(40);
    for (const call of calls) expect(ids(call)).toEqual(['r1', 'r2', 'r3']);
    expect(calls).toHaveLength(3);

    const received = (await sqs.handle(
      'ReceiveMessage',
      { QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 },
      awsReq(REGION),
    )) as { Messages?: Array<{ Body: string }> };
    const envelope = JSON.parse(received.Messages![0].Body);
    expect(envelope.DDBStreamBatchInfo.batchSize).toBe(3); // the whole batch
    warn.mockRestore();
  });

  // --- LSS-ESM-FILTER-CRITERIA: stream leg ----------------------------------

  test('FilterCriteria drops non-matching stream records while advancing the cursor', async () => {
    const streamArn = await createStreamTable('filtered');
    const dlqUrl = await createDlq('filtered-dlq');
    await createEsm({
      FunctionName: 'insert-only',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
      FilterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
      DestinationConfig: { OnFailure: { Destination: dlqArn('filtered-dlq') } },
    });
    const calls = startTailers([{ ok: true }]);

    await putItem('filtered', 'a'); // INSERT (match)
    await putItem('filtered', 'a', { v: { S: 'x' } }); // MODIFY (filtered out)
    await putItem('filtered', 'b'); // INSERT (match)
    await waitFor(() => calls.flatMap(records).length >= 2, 3000, 'two INSERTs delivered');
    await sleep(60);

    let delivered = calls.flatMap(records);
    expect(delivered.map(r => r.eventName)).toEqual(['INSERT', 'INSERT']);
    expect(delivered.map(r => (r.dynamodb.Keys.id as { S: string }).S)).toEqual(['a', 'b']);

    // The cursor advanced past the dropped MODIFY: a later MODIFY is also
    // dropped and a subsequent INSERT is still delivered exactly once.
    await putItem('filtered', 'b', { v: { S: 'y' } }); // MODIFY (filtered out)
    await putItem('filtered', 'c'); // INSERT (match)
    await waitFor(() => calls.flatMap(records).some(r => (r.dynamodb.Keys.id as { S: string }).S === 'c'), 3000, 'c delivered');
    await sleep(40);

    delivered = calls.flatMap(records);
    expect(delivered.filter(r => r.eventName === 'MODIFY')).toHaveLength(0);
    expect(delivered.map(r => (r.dynamodb.Keys.id as { S: string }).S)).toEqual(['a', 'b', 'c']);

    // A fully-filtered window never reaches the OnFailure destination.
    const received = (await sqs.handle('ReceiveMessage', { QueueUrl: dlqUrl, WaitTimeSeconds: 0 }, awsReq(REGION))) as {
      Messages?: unknown[];
    };
    expect(received.Messages ?? []).toHaveLength(0);
  });

  test('disabled stream ESMs stop tailing', async () => {
    const streamArn = await createStreamTable('toggle');
    const esm = await createEsm({
      FunctionName: 'consumer',
      EventSourceArn: streamArn,
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
    });
    const calls = startTailers([{ ok: true }]);
    expect((tailers as StreamTailerSet).tailerCount()).toBe(1);

    await lambdaCtl.handle(jsonReq(REGION, 'PUT', `/2015-03-31/event-source-mappings/${esm.UUID}`, { Enabled: false }));
    expect((tailers as StreamTailerSet).tailerCount()).toBe(0);
    await putItem('toggle', 'ignored');
    await sleep(150);
    expect(calls).toHaveLength(0);
  });
});
