// EngineDispatcher: function resolution order (registry → INVOKE_URL fallback
// → unresolvable), async fire-and-forget, S3 notification matching/payload/
// retries and EventBridge rule-matched target delivery.

import http from 'http';
import type { AddressInfo } from 'net';

// The real LambdaRuntimeManager forks workers and uses import.meta, which
// cannot load under ts-jest — both runtime modules are mocked at module level.
jest.mock('../../../../src/server/services/function-registry', () => {
  const instance = { resolve: jest.fn() };
  return { FunctionRegistry: { getInstance: () => instance } };
});
jest.mock('../../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { EngineDispatcher } from '../../../../src/server/engine/dispatch/dispatcher.js';
import { FunctionRegistry } from '../../../../src/server/services/function-registry.js';
import { LambdaRuntimeManager } from '../../../../src/server/services/lambda-runtime-manager.js';
import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb/index.js';
import { SqsEmulator } from '../../../../src/server/engine/emulators/sqs/index.js';
import { S3Emulator } from '../../../../src/server/engine/emulators/s3/index.js';
import { EventsEmulator } from '../../../../src/server/engine/emulators/events/index.js';
import { LambdaCtlEmulator } from '../../../../src/server/engine/emulators/lambda-ctl/index.js';
import type { EventRuleTarget, S3ObjectEvent } from '../../../../src/server/engine/types.js';
import { awsReq, jsonReq, makeCtx, waitFor } from './helpers.js';
import type { TestEngineContext } from './helpers.js';

const REGION = 'us-east-1';

const registry = FunctionRegistry.getInstance() as unknown as { resolve: jest.Mock };
const runtime = LambdaRuntimeManager.getInstance() as unknown as { invoke: jest.Mock };

interface Harness {
  tc: TestEngineContext;
  dispatcher: EngineDispatcher;
  s3: S3Emulator;
  sqs: SqsEmulator;
  lambdaCtl: LambdaCtlEmulator;
}

function makeHarness(tuning?: { s3RetryDelaysMs?: number[] }): Harness {
  const tc = makeCtx();
  const dynamo = new DynamoDbEmulator(tc.ctx);
  const sqs = new SqsEmulator(tc.ctx);
  const s3 = new S3Emulator(tc.ctx);
  const events = new EventsEmulator(tc.ctx);
  const lambdaCtl = new LambdaCtlEmulator(tc.ctx);
  const dispatcher = new EngineDispatcher({ ctx: tc.ctx, sqs, dynamo, s3, events, lambdaCtl, tuning });
  tc.ctx.dispatcher = dispatcher;
  return { tc, dispatcher, s3, sqs, lambdaCtl };
}

describe('EngineDispatcher.invokeFunction', () => {
  let h: Harness;

  beforeEach(() => {
    registry.resolve.mockReset();
    runtime.invoke.mockReset();
    registry.resolve.mockReturnValue(undefined);
    h = makeHarness();
  });

  afterEach(async () => {
    h.dispatcher.stop();
    await h.tc.cleanup();
  });

  test('registry hit invokes the LSS runtime in-process and maps the result', async () => {
    const fn = { name: 'orders', fullName: 'svc-dev-orders' };
    registry.resolve.mockReturnValue({ service: { name: 'svc' }, fn });
    runtime.invoke.mockResolvedValue({ ok: true, payload: { done: 1 }, logs: [], durationMs: 3 });

    const result = await h.dispatcher.invokeFunction('svc-dev-orders', { a: 1 });
    expect(result).toEqual({ ok: true, payload: { done: 1 } });
    expect(registry.resolve).toHaveBeenCalledWith('svc-dev-orders');
    expect(runtime.invoke).toHaveBeenCalledWith('svc', fn, { a: 1 });
  });

  test('registry hit maps handler failures (RuntimeUnavailable stays visible to callers)', async () => {
    registry.resolve.mockReturnValue({ service: { name: 'svc' }, fn: { name: 'f' } });
    runtime.invoke.mockResolvedValue({
      ok: false,
      errorType: 'RuntimeUnavailable',
      errorMessage: 'worker gone',
      logs: [],
      durationMs: 0,
    });
    const result = await h.dispatcher.invokeFunction('f', {});
    expect(result).toEqual({ ok: false, errorType: 'RuntimeUnavailable', errorMessage: 'worker gone' });
  });

  test('async invocations resolve ok immediately and log execution failures', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    registry.resolve.mockReturnValue({ service: { name: 'svc' }, fn: { name: 'f' } });
    let release: (value: unknown) => void = () => undefined;
    runtime.invoke.mockReturnValue(new Promise(resolve => (release = resolve)));

    const result = await h.dispatcher.invokeFunction('f', {}, { async: true });
    expect(result).toEqual({ ok: true }); // resolved before the handler finished
    release({ ok: false, errorType: 'Unhandled', errorMessage: 'later-boom', logs: [], durationMs: 1 });
    await waitFor(() => warn.mock.calls.some(c => String(c[0]).includes('later-boom')), 1000, 'async failure log');
    warn.mockRestore();
  });

  test('falls back to the stored INVOKE_URL over HTTP (serverless-offline holdout)', async () => {
    const seen: Array<{ path: string; body: string }> = [];
    const stub = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"proxied":true}');
      });
    });
    await new Promise<void>(resolve => stub.listen(0, resolve));
    const port = (stub.address() as AddressInfo).port;

    try {
      await h.lambdaCtl.handle(jsonReq(REGION, 'POST', '/2015-03-31/functions', {
        FunctionName: 'svc-dev-legacy',
        Environment: { Variables: { INVOKE_URL: `http://127.0.0.1:${port}/`, FUNCTION_NAME: 'legacy' } },
      }));

      const result = await h.dispatcher.invokeFunction('svc-dev-legacy', { via: 'http' });
      expect(result).toEqual({ ok: true, payload: { proxied: true } });
      expect(seen).toHaveLength(1);
      // FUNCTION_NAME (the short serverless-offline key) wins; trailing slash trimmed.
      expect(seen[0].path).toBe('/2015-03-31/functions/legacy/invocations');
      expect(JSON.parse(seen[0].body)).toEqual({ via: 'http' });

      // An ARN ref resolves through the same record.
      const viaArn = await h.dispatcher.invokeFunction(
        'arn:aws:lambda:us-east-1:000000000000:function:svc-dev-legacy',
        {},
      );
      expect(viaArn.ok).toBe(true);
    } finally {
      await new Promise<void>(resolve => stub.close(() => resolve()));
    }
  });

  test('INVOKE_URL non-2xx and connection failures produce failed results', async () => {
    const stub = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('busted');
    });
    await new Promise<void>(resolve => stub.listen(0, resolve));
    const port = (stub.address() as AddressInfo).port;
    try {
      await h.lambdaCtl.handle(jsonReq(REGION, 'POST', '/2015-03-31/functions', {
        FunctionName: 'broken',
        Environment: { Variables: { INVOKE_URL: `http://127.0.0.1:${port}` } },
      }));
      const result = await h.dispatcher.invokeFunction('broken', {});
      expect(result.ok).toBe(false);
      expect(result.errorType).toBe('InvocationFailed');
      expect(result.errorMessage).toContain('500');
    } finally {
      await new Promise<void>(resolve => stub.close(() => resolve()));
    }

    await h.lambdaCtl.handle(jsonReq(REGION, 'POST', '/2015-03-31/functions', {
      FunctionName: 'unreachable',
      Environment: { Variables: { INVOKE_URL: `http://127.0.0.1:${port}` } }, // now closed
    }));
    const dead = await h.dispatcher.invokeFunction('unreachable', {});
    expect(dead.ok).toBe(false);
    expect(dead.errorType).toBe('InvocationFailed');
  });

  test('unresolvable refs fail with FunctionNotResolvable and warn once per name', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await h.dispatcher.invokeFunction('ghost', {});
    const second = await h.dispatcher.invokeFunction('ghost', {});
    const other = await h.dispatcher.invokeFunction('other-ghost', {});
    expect(first.ok).toBe(false);
    expect(first.errorType).toBe('FunctionNotResolvable');
    expect(second.errorType).toBe('FunctionNotResolvable');
    expect(other.errorType).toBe('FunctionNotResolvable');
    const ghostWarnings = warn.mock.calls.filter(c => String(c[0]).includes('"ghost"'));
    expect(ghostWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  test('a function with metadata but no INVOKE_URL is unresolvable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await h.lambdaCtl.handle(jsonReq(REGION, 'POST', '/2015-03-31/functions', {
      FunctionName: 'metadata-only',
      Environment: { Variables: { OTHER: 'x' } },
    }));
    const result = await h.dispatcher.invokeFunction('metadata-only', {});
    expect(result.errorType).toBe('FunctionNotResolvable');
    warn.mockRestore();
  });
});

describe('EngineDispatcher S3 notifications', () => {
  let h: Harness;
  let invoked: jest.SpyInstance;

  async function seedBucketNotifications(bucket: string, lambda: unknown[]): Promise<void> {
    const catalog = h.tc.ctx.store.catalog<Record<string, unknown>>('s3/buckets');
    await catalog.load();
    catalog.set(bucket, {
      region: REGION,
      creationDate: new Date().toISOString(),
      notifications: { lambda, queue: [], topic: [] },
    });
  }

  function emitObjectEvent(partial: Partial<S3ObjectEvent>): void {
    h.tc.ctx.bus.emit('s3:object-event', {
      region: REGION,
      bucket: 'uploads',
      eventName: 's3:ObjectCreated:Put',
      key: 'incoming/file.csv',
      size: 42,
      eTag: 'abc123',
      sequencer: '0000000000000001',
      ...partial,
    });
  }

  beforeEach(async () => {
    registry.resolve.mockReset();
    registry.resolve.mockReturnValue(undefined);
    runtime.invoke.mockReset();
    h = makeHarness({ s3RetryDelaysMs: [10, 20] });
    invoked = jest.spyOn(h.dispatcher, 'invokeFunction').mockResolvedValue({ ok: true });
    await h.dispatcher.start(REGION);
  });

  afterEach(async () => {
    h.dispatcher.stop();
    await h.tc.cleanup();
  });

  test('glob event + prefix/suffix filters match and build the AWS payload', async () => {
    await seedBucketNotifications('uploads', [
      {
        id: 'on-upload',
        lambdaFunctionArn: 'arn:aws:lambda:us-east-1:000000000000:function:onUpload',
        events: ['s3:ObjectCreated:*'],
        filterRules: [
          { name: 'prefix', value: 'incoming/' },
          { name: 'suffix', value: '.csv' },
        ],
      },
    ]);
    emitObjectEvent({ key: 'incoming/reports/q3 summary.csv' });
    await waitFor(() => invoked.mock.calls.length >= 1, 2000, 'notification delivery');

    const [ref, payload] = invoked.mock.calls[0];
    expect(ref).toBe('arn:aws:lambda:us-east-1:000000000000:function:onUpload');
    const record = (payload as { Records: Array<Record<string, unknown>> }).Records[0];
    expect(record.eventVersion).toBe('2.1');
    expect(record.eventSource).toBe('aws:s3');
    expect(record.awsRegion).toBe(REGION);
    expect(record.eventName).toBe('ObjectCreated:Put'); // no "s3:" prefix
    expect(record.userIdentity).toEqual({ principalId: 'AWS:SELFENGINE' });
    expect(record.requestParameters).toEqual({ sourceIPAddress: '127.0.0.1' });
    const s3Part = record.s3 as Record<string, unknown>;
    expect(s3Part.s3SchemaVersion).toBe('1.0');
    expect(s3Part.configurationId).toBe('on-upload');
    expect(s3Part.bucket).toEqual({
      name: 'uploads',
      ownerIdentity: { principalId: 'SELFENGINE' },
      arn: 'arn:aws:s3:::uploads',
    });
    const object = s3Part.object as Record<string, unknown>;
    // URL-encoded key with '/' preserved.
    expect(object.key).toBe('incoming/reports/q3%20summary.csv');
    expect(object.size).toBe(42);
    expect(object.eTag).toBe('abc123');
    expect(object.sequencer).toBe('0000000000000001');
  });

  test('exact event names match exactly; mismatched events and filters are skipped', async () => {
    await seedBucketNotifications('uploads', [
      {
        id: 'removed-only',
        lambdaFunctionArn: 'arn:removed',
        events: ['s3:ObjectRemoved:Delete'],
        filterRules: [],
      },
      {
        id: 'wrong-prefix',
        lambdaFunctionArn: 'arn:prefix',
        events: ['s3:ObjectCreated:*'],
        filterRules: [{ name: 'prefix', value: 'exports/' }],
      },
      {
        id: 'wrong-suffix',
        lambdaFunctionArn: 'arn:suffix',
        events: ['s3:ObjectCreated:*'],
        filterRules: [{ name: 'suffix', value: '.jpg' }],
      },
    ]);
    emitObjectEvent({ key: 'incoming/file.csv', eventName: 's3:ObjectCreated:Put' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(invoked).not.toHaveBeenCalled();

    emitObjectEvent({ eventName: 's3:ObjectRemoved:Delete', key: 'anything' });
    await waitFor(() => invoked.mock.calls.length >= 1, 2000, 'exact-name delivery');
    expect(invoked.mock.calls[0][0]).toBe('arn:removed');
  });

  test('failed deliveries retry twice, then drop with a warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    invoked.mockResolvedValue({ ok: false, errorType: 'Unhandled', errorMessage: 'nope' });
    await seedBucketNotifications('uploads', [
      { id: 'flaky', lambdaFunctionArn: 'arn:flaky', events: ['s3:ObjectCreated:*'], filterRules: [] },
    ]);
    emitObjectEvent({});
    await waitFor(() => invoked.mock.calls.length >= 3, 2000, 'retries');
    await waitFor(
      () => warn.mock.calls.some(c => String(c[0]).includes('dropped')),
      2000,
      'drop warning',
    );
    expect(invoked.mock.calls.length).toBe(3); // initial + 2 retries
    warn.mockRestore();
  });

  test('a transient failure recovers on retry', async () => {
    invoked
      .mockResolvedValueOnce({ ok: false, errorType: 'RuntimeUnavailable', errorMessage: 'starting' })
      .mockResolvedValue({ ok: true });
    await seedBucketNotifications('uploads', [
      { id: 'recovers', lambdaFunctionArn: 'arn:recovers', events: ['s3:ObjectCreated:*'], filterRules: [] },
    ]);
    emitObjectEvent({});
    await waitFor(() => invoked.mock.calls.length >= 2, 2000, 'successful retry');
    expect(invoked.mock.calls.length).toBe(2);
  });
});

describe('EngineDispatcher EventBridge targets', () => {
  let h: Harness;
  let invoked: jest.SpyInstance;

  const envelope = {
    version: '0',
    id: 'evt-1',
    'detail-type': 'UserSignedUp',
    source: 'app.users',
    account: '000000000000',
    time: '2026-07-10T12:00:00Z',
    region: REGION,
    resources: [],
    detail: { userId: 'u-1', plan: { tier: 'pro' } },
  };

  function emitRuleMatched(targets: EventRuleTarget[]): void {
    h.tc.ctx.bus.emit('events:rule-matched', {
      region: REGION,
      busName: 'app-bus',
      ruleName: 'on-signup',
      targets,
      event: envelope,
    });
  }

  beforeEach(async () => {
    registry.resolve.mockReset();
    registry.resolve.mockReturnValue(undefined);
    runtime.invoke.mockReset();
    h = makeHarness();
    invoked = jest.spyOn(h.dispatcher, 'invokeFunction').mockResolvedValue({ ok: true });
    await h.dispatcher.start(REGION);
  });

  afterEach(async () => {
    h.dispatcher.stop();
    await h.tc.cleanup();
  });

  test('targets receive the full envelope asynchronously (no Records wrapper)', async () => {
    emitRuleMatched([{ id: 't1', arn: 'arn:consumer' }]);
    await waitFor(() => invoked.mock.calls.length >= 1, 2000, 'target delivery');
    const [ref, payload, opts] = invoked.mock.calls[0];
    expect(ref).toBe('arn:consumer');
    expect(payload).toEqual(envelope);
    expect(opts).toEqual({ async: true });
  });

  test('Input override and InputPath extraction per target', async () => {
    emitRuleMatched([
      { id: 'literal', arn: 'arn:literal', input: '{"fixed":true}' },
      { id: 'detail', arn: 'arn:detail', inputPath: '$.detail' },
      { id: 'deep', arn: 'arn:deep', inputPath: '$.detail.plan.tier' },
      { id: 'source', arn: 'arn:source', inputPath: '$.source' },
      { id: 'missing', arn: 'arn:missing', inputPath: '$.detail.nope.x' },
    ]);
    await waitFor(() => invoked.mock.calls.length >= 5, 2000, 'all target deliveries');

    const byRef = new Map(invoked.mock.calls.map(call => [call[0], call[1]]));
    expect(byRef.get('arn:literal')).toEqual({ fixed: true });
    expect(byRef.get('arn:detail')).toEqual(envelope.detail);
    expect(byRef.get('arn:deep')).toBe('pro');
    expect(byRef.get('arn:source')).toBe('app.users');
    expect(byRef.get('arn:missing')).toBeNull();
  });

  test('failed target invocations are logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    invoked.mockResolvedValue({ ok: false, errorType: 'FunctionNotResolvable', errorMessage: 'ghost' });
    emitRuleMatched([{ id: 't', arn: 'arn:ghost' }]);
    await waitFor(
      () => warn.mock.calls.some(c => String(c[0]).includes('target t (arn:ghost) failed')),
      2000,
      'failure log',
    );
    warn.mockRestore();
  });

  test('delivers to an SQS target as a message (not a Lambda invoke)', async () => {
    await h.sqs.handle('CreateQueue', { QueueName: 'proof-queue' }, awsReq(REGION));
    emitRuleMatched([{ id: 'q', arn: `arn:aws:sqs:${REGION}:000000000000:proof-queue` }]);
    await waitFor(() => h.sqs.hasVisibleMessages(REGION, 'proof-queue'), 2000, 'message enqueued');

    // The event envelope is the message body; no Lambda invoke happened.
    expect(invoked).not.toHaveBeenCalled();
    const [message] = h.sqs.receiveForDelivery(REGION, 'proof-queue', 10);
    expect(JSON.parse(message.body)).toEqual(envelope);
  });

  test('SQS target body is JSON — a string Input stays quoted (AWS-verbatim)', async () => {
    await h.sqs.handle('CreateQueue', { QueueName: 'str-queue' }, awsReq(REGION));
    emitRuleMatched([
      { id: 'q', arn: `arn:aws:sqs:${REGION}:000000000000:str-queue`, input: '"widget"' },
    ]);
    await waitFor(() => h.sqs.hasVisibleMessages(REGION, 'str-queue'), 2000, 'message enqueued');
    const [message] = h.sqs.receiveForDelivery(REGION, 'str-queue', 10);
    // The body is valid JSON that parses back to the string (not the raw chars).
    expect(message.body).toBe('"widget"');
    expect(JSON.parse(message.body)).toBe('widget');
  });

  test('SQS target honors the queue default DelaySeconds', async () => {
    await h.sqs.handle('CreateQueue', {
      QueueName: 'delayed-queue',
      Attributes: { DelaySeconds: '60' },
    }, awsReq(REGION));
    const deliverSpy = jest.spyOn(h.sqs, 'deliverMessage');
    emitRuleMatched([{ id: 'q', arn: `arn:aws:sqs:${REGION}:000000000000:delayed-queue` }]);
    // Wait until the message is actually enqueued (the delivery promise resolves
    // true), then assert it is NOT visible — it was parked by the 60s delay,
    // matching a direct SendMessage to a delay queue (delayMs:0 would show true).
    await waitFor(() => deliverSpy.mock.calls.length >= 1, 2000, 'deliverMessage called');
    expect(await deliverSpy.mock.results[0].value).toBe(true);
    expect(h.sqs.hasVisibleMessages(REGION, 'delayed-queue')).toBe(false);
    deliverSpy.mockRestore();
  });

  test('honors SqsParameters.MessageGroupId for a FIFO SQS target', async () => {
    await h.sqs.handle('CreateQueue', {
      QueueName: 'proof.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
    }, awsReq(REGION));
    emitRuleMatched([
      { id: 'q', arn: `arn:aws:sqs:${REGION}:000000000000:proof.fifo`, sqsMessageGroupId: 'g1' },
    ]);
    await waitFor(() => h.sqs.hasVisibleMessages(REGION, 'proof.fifo'), 2000, 'fifo message enqueued');
    const [message] = h.sqs.receiveForDelivery(REGION, 'proof.fifo', 10);
    expect(message.messageGroupId).toBe('g1');
  });

  test('warns when an SQS target queue does not exist', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    emitRuleMatched([{ id: 'q', arn: `arn:aws:sqs:${REGION}:000000000000:ghost-queue` }]);
    await waitFor(
      () => warn.mock.calls.some(c => String(c[0]).includes('queue "ghost-queue" not found')),
      2000,
      'missing-queue warning',
    );
    expect(invoked).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
