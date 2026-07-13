// Schedule expression parsing, next-fire computation, Input/InputPath target
// payload resolution, and the EngineScheduler timer lifecycle (single unref'd
// timer, zero timers with no rules, rate() firing under fake timers).

import { EventsEmulator } from '../../../../src/server/engine/emulators/events/index.js';
import {
  EngineScheduler,
  nextFireAt,
  parseScheduleExpression,
  resolveTargetInput,
} from '../../../../src/server/engine/dispatch/scheduler.js';
import type { ParsedSchedule } from '../../../../src/server/engine/dispatch/scheduler.js';
import { awsReq, makeCtx, makeDeliverStub } from './helpers.js';
import type { AwsRequest } from '../../../../src/server/engine/types.js';
import type { TestEngineContext } from './helpers.js';

const REGION = 'us-east-1';

function cron(expression: string): ParsedSchedule {
  const parsed = parseScheduleExpression(expression);
  if (!parsed) throw new Error(`expected ${expression} to parse`);
  return parsed;
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('parseScheduleExpression', () => {
  test('rate() minutes/hours/days with singular-plural agreement', () => {
    expect(parseScheduleExpression('rate(1 minute)')).toEqual({ kind: 'rate', intervalMs: 60_000 });
    expect(parseScheduleExpression('rate(5 minutes)')).toEqual({ kind: 'rate', intervalMs: 300_000 });
    expect(parseScheduleExpression('rate(2 hours)')).toEqual({ kind: 'rate', intervalMs: 7_200_000 });
    expect(parseScheduleExpression('rate(1 day)')).toEqual({ kind: 'rate', intervalMs: 86_400_000 });
    expect(parseScheduleExpression('rate(1 minutes)')).toBeUndefined();
    expect(parseScheduleExpression('rate(5 minute)')).toBeUndefined();
    expect(parseScheduleExpression('rate(0 minutes)')).toBeUndefined();
    expect(parseScheduleExpression('rate(fast)')).toBeUndefined();
  });

  test('cron() parses fields, names, lists, ranges and steps', () => {
    expect(parseScheduleExpression('cron(0 12 * * ? *)')).toMatchObject({ kind: 'cron' });
    expect(parseScheduleExpression('cron(0/15 8-17 ? JAN,JUL SUN-SAT 2026)')).toMatchObject({ kind: 'cron' });
    expect(parseScheduleExpression('cron(*/5 * * * ? *)')).toMatchObject({ kind: 'cron' });
  });

  test('cron() rejects L/W/#, wrong field counts and bad values', () => {
    expect(parseScheduleExpression('cron(0 12 ? * 2#1 *)')).toBeUndefined();
    expect(parseScheduleExpression('cron(0 12 L * ? *)')).toBeUndefined();
    expect(parseScheduleExpression('cron(0 12 15W * ? *)')).toBeUndefined();
    expect(parseScheduleExpression('cron(0 12 * * ?)')).toBeUndefined(); // 5 fields
    expect(parseScheduleExpression('cron(0 25 * * ? *)')).toBeUndefined(); // hour out of range
    expect(parseScheduleExpression('cron(0 12 * FOO ? *)')).toBeUndefined();
    expect(parseScheduleExpression('not-a-schedule')).toBeUndefined();
  });
});

describe('nextFireAt', () => {
  test('rate is now + interval', () => {
    const from = Date.UTC(2026, 6, 10, 8, 0, 30);
    expect(nextFireAt({ kind: 'rate', intervalMs: 60_000 }, from)).toBe(from + 60_000);
  });

  test('cron(0 12 * * ? *) computes a sane next fire', () => {
    const spec = cron('cron(0 12 * * ? *)');
    // Before noon → today at 12:00 UTC.
    expect(nextFireAt(spec, Date.UTC(2026, 6, 10, 8, 0))).toBe(Date.UTC(2026, 6, 10, 12, 0));
    // After noon → tomorrow at 12:00 UTC.
    expect(nextFireAt(spec, Date.UTC(2026, 6, 10, 13, 0))).toBe(Date.UTC(2026, 6, 11, 12, 0));
    // Exactly at noon → strictly after, so tomorrow.
    expect(nextFireAt(spec, Date.UTC(2026, 6, 10, 12, 0))).toBe(Date.UTC(2026, 6, 11, 12, 0));
  });

  test('cron day-of-week uses AWS numbering (1=SUN..7=SAT)', () => {
    // 2026-07-10 is a Friday (AWS dow 6). Next Monday (dow 2) is 2026-07-13.
    const spec = cron('cron(30 9 ? * MON *)');
    expect(nextFireAt(spec, Date.UTC(2026, 6, 10, 0, 0))).toBe(Date.UTC(2026, 6, 13, 9, 30));
  });

  test('cron day-of-month with ? day-of-week', () => {
    const spec = cron('cron(0 0 1 * ? *)');
    expect(nextFireAt(spec, Date.UTC(2026, 6, 10, 0, 0))).toBe(Date.UTC(2026, 7, 1, 0, 0));
  });

  test('cron year restriction can push past the window', () => {
    const spec = cron('cron(0 12 * * ? 2199)');
    expect(nextFireAt(spec, Date.UTC(2026, 6, 10))).toBeUndefined();
  });

  test('cron step minutes', () => {
    const spec = cron('cron(0/20 * * * ? *)');
    expect(nextFireAt(spec, Date.UTC(2026, 6, 10, 8, 5))).toBe(Date.UTC(2026, 6, 10, 8, 20));
  });
});

describe('resolveTargetInput', () => {
  const envelope = {
    version: '0',
    source: 'app.orders',
    'detail-type': 'OrderPlaced',
    detail: { orderId: 'o-1', nested: { deep: 42 } },
  };

  test('Input literal wins and is parsed', () => {
    expect(resolveTargetInput({ id: 't', arn: 'a', input: '{"x":1}' }, envelope)).toEqual({ x: 1 });
  });

  test('invalid Input JSON delivers null with a warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveTargetInput({ id: 't', arn: 'a', input: '{nope' }, envelope)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('InputPath dot-path extraction', () => {
    expect(resolveTargetInput({ id: 't', arn: 'a', inputPath: '$' }, envelope)).toBe(envelope);
    expect(resolveTargetInput({ id: 't', arn: 'a', inputPath: '$.detail' }, envelope)).toEqual(envelope.detail);
    expect(resolveTargetInput({ id: 't', arn: 'a', inputPath: '$.detail.nested.deep' }, envelope)).toBe(42);
    expect(resolveTargetInput({ id: 't', arn: 'a', inputPath: '$.source' }, envelope)).toBe('app.orders');
    expect(resolveTargetInput({ id: 't', arn: 'a', inputPath: '$.detail-type' }, envelope)).toBe('OrderPlaced');
    expect(resolveTargetInput({ id: 't', arn: 'a', inputPath: '$.missing.x' }, envelope)).toBeNull();
    expect(resolveTargetInput({ id: 't', arn: 'a', inputPath: 'detail' }, envelope)).toBeNull();
  });

  test('no Input/InputPath delivers the full envelope', () => {
    expect(resolveTargetInput({ id: 't', arn: 'a' }, envelope)).toBe(envelope);
  });
});

describe('EngineScheduler', () => {
  let tc: TestEngineContext;
  let events: EventsEmulator;

  beforeEach(() => {
    tc = makeCtx();
    events = new EventsEmulator(tc.ctx);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await tc.cleanup();
  });

  async function putScheduleRule(name: string, expression: string, target: Record<string, unknown>): Promise<void> {
    await events.handle('PutRule', { Name: name, ScheduleExpression: expression }, req());
    await events.handle('PutTargets', { Rule: name, Targets: [target] }, req());
  }

  function req(): AwsRequest {
    return awsReq(REGION);
  }

  test('rate(1 minute) fires under fake timers with the Scheduled Event envelope', async () => {
    await putScheduleRule('every-minute', 'rate(1 minute)', {
      Id: 't1',
      Arn: 'arn:aws:lambda:us-east-1:000000000000:function:cleanup',
    });
    const stub = makeDeliverStub();
    jest.useFakeTimers();
    const scheduler = new EngineScheduler({ ctx: tc.ctx, events, deliverToTarget: stub.deliverToTarget });
    await scheduler.resync(REGION);

    expect(stub.calls).toHaveLength(0);
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(stub.calls).toHaveLength(1);

    const { arn, event, sourceLabel } = stub.calls[0];
    expect(arn).toBe('arn:aws:lambda:us-east-1:000000000000:function:cleanup');
    expect(sourceLabel).toBe('schedule every-minute');
    const envelope = event as Record<string, unknown>;
    expect(envelope['detail-type']).toBe('Scheduled Event');
    expect(envelope.source).toBe('aws.events');
    expect(envelope.account).toBe('000000000000');
    expect(envelope.region).toBe(REGION);
    expect(envelope.detail).toEqual({});
    expect(envelope.resources).toEqual(['arn:aws:events:us-east-1:000000000000:rule/every-minute']);

    // Re-arms: fires again a minute later.
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(stub.calls).toHaveLength(2);
    scheduler.stop();
  });

  test('schedule targets honor Input and InputPath', async () => {
    await events.handle('PutRule', { Name: 'r-input', ScheduleExpression: 'rate(1 minute)' }, req());
    await events.handle('PutTargets', {
      Rule: 'r-input',
      Targets: [
        { Id: 'literal', Arn: 'arn:literal', Input: '{"custom":true}' },
        { Id: 'path', Arn: 'arn:path', InputPath: '$.detail' },
      ],
    }, req());
    const stub = makeDeliverStub();
    jest.useFakeTimers();
    const scheduler = new EngineScheduler({ ctx: tc.ctx, events, deliverToTarget: stub.deliverToTarget });
    await scheduler.resync(REGION);
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.find(c => c.arn === 'arn:literal')?.event).toEqual({ custom: true });
    expect(stub.calls.find(c => c.arn === 'arn:path')?.event).toEqual({});
    scheduler.stop();
  });

  test('zero timers when there are no schedule rules', async () => {
    jest.useFakeTimers();
    const stub = makeDeliverStub();
    const scheduler = new EngineScheduler({ ctx: tc.ctx, events, deliverToTarget: stub.deliverToTarget });
    await scheduler.resync(REGION);
    expect(scheduler.scheduleCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    scheduler.stop();
  });

  test('unsupported cron (L/W/#) warns once and skips the rule', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await putScheduleRule('unsupported', 'cron(0 12 ? * 2#1 *)', { Id: 't', Arn: 'arn:t' });
    jest.useFakeTimers();
    const stub = makeDeliverStub();
    const scheduler = new EngineScheduler({ ctx: tc.ctx, events, deliverToTarget: stub.deliverToTarget });
    await scheduler.resync(REGION);
    await scheduler.resync(REGION);
    expect(scheduler.scheduleCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('unsupported schedule expression'))).toHaveLength(1);
    warn.mockRestore();
    scheduler.stop();
  });

  test('DISABLED rules are skipped and rule changes resync via onRulesChanged', async () => {
    const stub = makeDeliverStub();
    const scheduler = new EngineScheduler({ ctx: tc.ctx, events, deliverToTarget: stub.deliverToTarget });
    await scheduler.resync(REGION);
    expect(scheduler.scheduleCount()).toBe(0);

    // PutRule fires onRulesChanged → the scheduler picks the rule up itself.
    await putScheduleRule('toggling', 'rate(1 minute)', { Id: 't', Arn: 'arn:t' });
    await scheduler.resync(REGION); // deterministic barrier for the async hook
    expect(scheduler.scheduleCount()).toBe(1);

    await events.handle('DisableRule', { Name: 'toggling' }, req());
    await scheduler.resync(REGION);
    expect(scheduler.scheduleCount()).toBe(0);
    scheduler.stop();
  });

  test('stop() clears the armed timer', async () => {
    await putScheduleRule('to-stop', 'rate(1 minute)', { Id: 't', Arn: 'arn:t' });
    jest.useFakeTimers();
    const stub = makeDeliverStub();
    const scheduler = new EngineScheduler({ ctx: tc.ctx, events, deliverToTarget: stub.deliverToTarget });
    await scheduler.resync(REGION);
    expect(jest.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(120_000);
    await flushMicrotasks();
    expect(stub.calls).toHaveLength(0);
  });

  test('delegates each target delivery to deliverToTarget (incl. SQS targets)', async () => {
    // Delivery is delegated to deliverToTarget (which dispatches by ARN service
    // — Lambda invoke vs SQS enqueue); the scheduler just fires it per target.
    // Failure handling lives in that dep, covered by the dispatcher test.
    await putScheduleRule('to-queue', 'rate(1 minute)', {
      Id: 't', Arn: 'arn:aws:sqs:us-east-1:000000000000:proof-queue',
    });
    const stub = makeDeliverStub();
    jest.useFakeTimers();
    const scheduler = new EngineScheduler({ ctx: tc.ctx, events, deliverToTarget: stub.deliverToTarget });
    await scheduler.resync(REGION);
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].arn).toBe('arn:aws:sqs:us-east-1:000000000000:proof-queue');
    expect(stub.calls[0].sourceLabel).toBe('schedule to-queue');
    scheduler.stop();
  });
});
