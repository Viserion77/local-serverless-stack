// EventsEmulator: bus/rule/target lifecycle (incl. the exact error names the
// provisioner's idempotency and cleanup paths branch on), PutEvents per-entry
// results + 'events:rule-matched' emission payload, schedule rule listing.
import { EventsEmulator } from '../../../../src/server/engine/emulators/events/index';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AwsRequest, EngineContext, EventRuleMatchedEvent } from '../../../../src/server/engine/types';
import type { CatalogStore, EngineStore } from '../../../../src/server/engine/store/store-types';

class FakeCatalog<T> implements CatalogStore<T> {
  private map = new Map<string, T>();
  async load(): Promise<void> {}
  get(key: string): T | undefined { return this.map.get(key); }
  set(key: string, value: T): void { this.map.set(key, value); }
  delete(key: string): boolean { return this.map.delete(key); }
  keys(): string[] { return [...this.map.keys()]; }
  values(): T[] { return [...this.map.values()]; }
  async flush(): Promise<void> {}
}

function makeContext(): EngineContext {
  const catalogs = new Map<string, FakeCatalog<unknown>>();
  const store = {
    dir: (...segments: string[]) => segments.join('/'),
    catalog<T>(relPath: string): CatalogStore<T> {
      if (!catalogs.has(relPath)) catalogs.set(relPath, new FakeCatalog());
      return catalogs.get(relPath) as CatalogStore<T>;
    },
    table: () => { throw new Error('not used'); },
    writeBlob: async () => { throw new Error('not used'); },
    readBlob: async () => { throw new Error('not used'); },
    deleteBlob: async () => { throw new Error('not used'); },
    startSweeper: () => {},
    stopSweeper: () => {},
    flushAll: async () => {},
  } as unknown as EngineStore;
  return {
    config: {
      port: 14566, dataDir: '/unused', account: '000000000000', region: 'us-east-1',
      idleUnloadMs: 60000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store,
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
}

function request(region = 'us-east-1'): AwsRequest {
  return {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'events', region, requestId: 'test-request',
  };
}

const PATTERN = JSON.stringify({ source: ['app.users'], 'detail-type': ['UserSignedUp'] });
const TARGET = { Id: 't1', Arn: 'arn:aws:lambda:us-east-1:000000000000:function:onUserSignedUp' };

let ctx: EngineContext;
let emulator: EventsEmulator;

beforeEach(() => {
  ctx = makeContext();
  emulator = new EventsEmulator(ctx);
});

async function handle(operation: string, input: Record<string, unknown> = {}): Promise<any> {
  return emulator.handle(operation, input, request());
}

describe('event buses', () => {
  test('CreateEventBus returns the bus ARN and duplicates fail with the provisioner-matched error', async () => {
    await expect(handle('CreateEventBus', { Name: 'domain-events' })).resolves.toEqual({
      EventBusArn: 'arn:aws:events:us-east-1:000000000000:event-bus/domain-events',
    });
    await expect(handle('CreateEventBus', { Name: 'domain-events' })).rejects.toMatchObject({
      code: 'ResourceAlreadyExistsException',
      message: 'Event bus domain-events already exists.',
    });
  });

  test('the default bus always exists: CreateEventBus default collides, DescribeEventBus resolves it', async () => {
    await expect(handle('CreateEventBus', { Name: 'default' })).rejects.toMatchObject({
      code: 'ResourceAlreadyExistsException',
    });
    await expect(handle('DescribeEventBus', {})).resolves.toEqual({
      Name: 'default',
      Arn: 'arn:aws:events:us-east-1:000000000000:event-bus/default',
    });
  });

  test('DescribeEventBus on an unknown bus throws ResourceNotFoundException', async () => {
    await expect(handle('DescribeEventBus', { Name: 'nope' })).rejects.toMatchObject({
      code: 'ResourceNotFoundException',
      message: 'Event bus nope does not exist.',
    });
  });

  test('ListEventBuses includes default plus created buses and honors NamePrefix', async () => {
    await handle('CreateEventBus', { Name: 'domain-events' });
    await handle('CreateEventBus', { Name: 'audit-events' });
    const all = await handle('ListEventBuses', {});
    expect(all.EventBuses.map((bus: any) => bus.Name)).toEqual(['audit-events', 'default', 'domain-events']);
    const filtered = await handle('ListEventBuses', { NamePrefix: 'domain' });
    expect(filtered.EventBuses).toEqual([
      { Name: 'domain-events', Arn: 'arn:aws:events:us-east-1:000000000000:event-bus/domain-events' },
    ]);
  });

  test('DeleteEventBus removes the bus and its rules; deleting default is rejected', async () => {
    await handle('CreateEventBus', { Name: 'domain-events' });
    await handle('PutRule', { Name: 'r1', EventBusName: 'domain-events', EventPattern: PATTERN });
    await handle('DeleteEventBus', { Name: 'domain-events' });
    await expect(handle('DescribeEventBus', { Name: 'domain-events' })).rejects.toMatchObject({
      code: 'ResourceNotFoundException',
    });
    expect(ctx.store.catalog('events/us-east-1/rules').keys()).toEqual([]);
    // Idempotent on an absent bus, like AWS.
    await expect(handle('DeleteEventBus', { Name: 'domain-events' })).resolves.toEqual({});
    await expect(handle('DeleteEventBus', { Name: 'default' })).rejects.toMatchObject({
      code: 'ValidationException',
    });
  });
});

describe('rules', () => {
  test('PutRule returns rule ARNs with and without the bus segment', async () => {
    await handle('CreateEventBus', { Name: 'domain-events' });
    await expect(handle('PutRule', { Name: 'on-default', EventPattern: PATTERN })).resolves.toEqual({
      RuleArn: 'arn:aws:events:us-east-1:000000000000:rule/on-default',
    });
    await expect(
      handle('PutRule', { Name: 'user-signed-up', EventBusName: 'domain-events', EventPattern: PATTERN }),
    ).resolves.toEqual({
      RuleArn: 'arn:aws:events:us-east-1:000000000000:rule/domain-events/user-signed-up',
    });
  });

  test('PutRule against a missing bus throws ResourceNotFoundException', async () => {
    await expect(handle('PutRule', { Name: 'r', EventBusName: 'nope', EventPattern: PATTERN }))
      .rejects.toMatchObject({ code: 'ResourceNotFoundException', message: 'Event bus nope does not exist.' });
  });

  test('PutRule validates the pattern: unsupported operators, invalid JSON, invalid structure', async () => {
    await expect(handle('PutRule', {
      Name: 'r',
      EventPattern: JSON.stringify({ detail: { plan: [{ 'anything-but': 'free' }] } }),
    })).rejects.toMatchObject({
      code: 'InvalidEventPatternException',
      message: expect.stringContaining('anything-but'),
    });
    await expect(handle('PutRule', { Name: 'r', EventPattern: '{not json' }))
      .rejects.toMatchObject({ code: 'InvalidEventPatternException' });
    await expect(handle('PutRule', { Name: 'r', EventPattern: JSON.stringify({ source: 'app.users' }) }))
      .rejects.toMatchObject({ code: 'InvalidEventPatternException' });
  });

  test('PutRule requires EventPattern or ScheduleExpression and a valid State', async () => {
    await expect(handle('PutRule', { Name: 'r' })).rejects.toMatchObject({
      code: 'ValidationException',
      message: 'Parameter(s) EventPattern or ScheduleExpression must be specified.',
    });
    await expect(handle('PutRule', { Name: 'r', EventPattern: PATTERN, State: 'SOMETIMES' }))
      .rejects.toMatchObject({ code: 'ValidationException' });
  });

  test('schedule rules: only on the default bus, only rate()/cron() syntax', async () => {
    await handle('CreateEventBus', { Name: 'domain-events' });
    await expect(handle('PutRule', { Name: 'tick', ScheduleExpression: 'rate(1 hour)' })).resolves.toMatchObject({
      RuleArn: expect.stringContaining(':rule/tick'),
    });
    await expect(handle('PutRule', { Name: 'tick2', ScheduleExpression: 'every hour' }))
      .rejects.toMatchObject({ code: 'ValidationException', message: 'Parameter ScheduleExpression is not valid.' });
    await expect(handle('PutRule', { Name: 'tick3', EventBusName: 'domain-events', ScheduleExpression: 'rate(1 hour)' }))
      .rejects.toMatchObject({ code: 'ValidationException' });
  });

  test('PutRule is an upsert that preserves targets and, when State is omitted, the current state', async () => {
    await handle('PutRule', { Name: 'r', EventPattern: PATTERN, State: 'DISABLED' });
    await handle('PutTargets', { Rule: 'r', Targets: [TARGET] });
    await handle('PutRule', { Name: 'r', EventPattern: PATTERN });
    const rules = await handle('ListRules', {});
    expect(rules.Rules).toEqual([{
      Name: 'r',
      Arn: 'arn:aws:events:us-east-1:000000000000:rule/r',
      EventBusName: 'default',
      State: 'DISABLED',
      EventPattern: PATTERN,
    }]);
    const targets = await handle('ListTargetsByRule', { Rule: 'r' });
    expect(targets.Targets).toHaveLength(1);
  });

  test('EnableRule/DisableRule toggle state and report missing rules with the bus-aware message', async () => {
    await handle('PutRule', { Name: 'r', EventPattern: PATTERN });
    await handle('DisableRule', { Name: 'r' });
    expect((await handle('ListRules', {})).Rules[0].State).toBe('DISABLED');
    await handle('EnableRule', { Name: 'r' });
    expect((await handle('ListRules', {})).Rules[0].State).toBe('ENABLED');
    await expect(handle('EnableRule', { Name: 'ghost' })).rejects.toMatchObject({
      code: 'ResourceNotFoundException',
      message: 'Rule ghost does not exist.',
    });
    await handle('CreateEventBus', { Name: 'domain-events' });
    await expect(handle('DisableRule', { Name: 'ghost', EventBusName: 'domain-events' })).rejects.toMatchObject({
      code: 'ResourceNotFoundException',
      message: 'Rule ghost does not exist on EventBus domain-events.',
    });
  });

  test('DeleteRule refuses while targets are attached, honors Force, and is idempotent — the provisioner contract', async () => {
    await handle('PutRule', { Name: 'r', EventPattern: PATTERN });
    await handle('PutTargets', { Rule: 'r', Targets: [TARGET] });
    await expect(handle('DeleteRule', { Name: 'r' })).rejects.toMatchObject({
      code: 'ValidationException',
      message: "Rule can't be deleted since it has targets.",
    });
    // The provisioner's cleanup path: RemoveTargets first, then DeleteRule.
    await handle('RemoveTargets', { Rule: 'r', Ids: ['t1'] });
    await expect(handle('DeleteRule', { Name: 'r' })).resolves.toEqual({});
    await expect(handle('DeleteRule', { Name: 'r' })).resolves.toEqual({});

    await handle('PutRule', { Name: 'forced', EventPattern: PATTERN });
    await handle('PutTargets', { Rule: 'forced', Targets: [TARGET] });
    await expect(handle('DeleteRule', { Name: 'forced', Force: true })).resolves.toEqual({});
  });

  test('ListRules requires an existing bus and filters by NamePrefix', async () => {
    await handle('PutRule', { Name: 'orders-cleanup', EventPattern: PATTERN });
    await handle('PutRule', { Name: 'users-signup', EventPattern: PATTERN });
    const filtered = await handle('ListRules', { NamePrefix: 'orders' });
    expect(filtered.Rules.map((rule: any) => rule.Name)).toEqual(['orders-cleanup']);
    await expect(handle('ListRules', { EventBusName: 'nope' })).rejects.toMatchObject({
      code: 'ResourceNotFoundException',
    });
  });
});

describe('targets', () => {
  test('PutTargets stores id/arn/input/inputPath, upserts by Id, and reports zero failures', async () => {
    await handle('PutRule', { Name: 'r', EventPattern: PATTERN });
    await expect(handle('PutTargets', {
      Rule: 'r',
      Targets: [
        { ...TARGET, Input: '{"static":true}' },
        { Id: 't2', Arn: 'arn:aws:lambda:us-east-1:000000000000:function:other', InputPath: '$.detail' },
      ],
    })).resolves.toEqual({ FailedEntryCount: 0, FailedEntries: [] });

    // Re-put t1 with different config: replaced, not duplicated.
    await handle('PutTargets', { Rule: 'r', Targets: [{ ...TARGET }] });
    const listed = await handle('ListTargetsByRule', { Rule: 'r' });
    expect(listed.Targets).toEqual([
      { Id: 't1', Arn: TARGET.Arn },
      { Id: 't2', Arn: 'arn:aws:lambda:us-east-1:000000000000:function:other', InputPath: '$.detail' },
    ]);
  });

  test('PutTargets/RemoveTargets/ListTargetsByRule on a missing rule throw ResourceNotFoundException', async () => {
    for (const [operation, input] of [
      ['PutTargets', { Rule: 'ghost', Targets: [TARGET] }],
      ['RemoveTargets', { Rule: 'ghost', Ids: ['t1'] }],
      ['ListTargetsByRule', { Rule: 'ghost' }],
    ] as const) {
      await expect(handle(operation, input as Record<string, unknown>)).rejects.toMatchObject({
        code: 'ResourceNotFoundException',
        message: 'Rule ghost does not exist.',
      });
    }
  });

  test('RemoveTargets removes only the given Ids', async () => {
    await handle('PutRule', { Name: 'r', EventPattern: PATTERN });
    await handle('PutTargets', { Rule: 'r', Targets: [TARGET, { Id: 't2', Arn: TARGET.Arn }] });
    await expect(handle('RemoveTargets', { Rule: 'r', Ids: ['t2', 'missing'] }))
      .resolves.toEqual({ FailedEntryCount: 0, FailedEntries: [] });
    const listed = await handle('ListTargetsByRule', { Rule: 'r' });
    expect(listed.Targets.map((target: any) => target.Id)).toEqual(['t1']);
  });
});

describe('PutEvents', () => {
  let matched: EventRuleMatchedEvent[];

  beforeEach(async () => {
    matched = [];
    ctx.bus.on('events:rule-matched', payload => matched.push(payload));
    await handle('CreateEventBus', { Name: 'domain-events' });
    await handle('PutRule', { Name: 'user-signed-up', EventBusName: 'domain-events', EventPattern: PATTERN });
    await handle('PutTargets', {
      Rule: 'user-signed-up',
      EventBusName: 'domain-events',
      Targets: [{ ...TARGET, InputPath: '$.detail' }],
    });
  });

  const entry = {
    Source: 'app.users',
    DetailType: 'UserSignedUp',
    Detail: JSON.stringify({ userId: 'u-1', plan: 'pro' }),
    EventBusName: 'domain-events',
  };

  test('a matching entry returns an EventId and emits the canonical envelope (no Records wrapper)', async () => {
    const response = await handle('PutEvents', { Entries: [entry] });
    expect(response.FailedEntryCount).toBe(0);
    expect(response.Entries).toHaveLength(1);
    const eventId = response.Entries[0].EventId;
    expect(eventId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));

    expect(matched).toHaveLength(1);
    expect(matched[0]).toEqual({
      region: 'us-east-1',
      busName: 'domain-events',
      ruleName: 'user-signed-up',
      targets: [{ id: 't1', arn: TARGET.Arn, inputPath: '$.detail' }],
      event: {
        version: '0',
        id: eventId,
        'detail-type': 'UserSignedUp',
        source: 'app.users',
        account: '000000000000',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        region: 'us-east-1',
        resources: [],
        detail: { userId: 'u-1', plan: 'pro' },
      },
    });
    expect(matched[0].event).not.toHaveProperty('Records');
  });

  test('an unknown bus fails per entry, not per request', async () => {
    const response = await handle('PutEvents', {
      Entries: [{ ...entry, EventBusName: 'nope' }, entry],
    });
    expect(response.FailedEntryCount).toBe(1);
    expect(response.Entries[0]).toEqual({
      ErrorCode: 'ResourceNotFoundException',
      ErrorMessage: 'Event bus nope does not exist.',
    });
    expect(response.Entries[1].EventId).toBeDefined();
    expect(matched).toHaveLength(1);
  });

  test('malformed or non-object Detail fails per entry with MalformedDetail', async () => {
    const response = await handle('PutEvents', {
      Entries: [{ ...entry, Detail: '{oops' }, { ...entry, Detail: '[1,2]' }],
    });
    expect(response.FailedEntryCount).toBe(2);
    expect(response.Entries.map((result: any) => result.ErrorCode)).toEqual(['MalformedDetail', 'MalformedDetail']);
    expect(matched).toHaveLength(0);
  });

  test('missing Source or DetailType fails per entry with InvalidArgument', async () => {
    const response = await handle('PutEvents', {
      Entries: [{ ...entry, Source: undefined }, { ...entry, DetailType: '' }],
    });
    expect(response.FailedEntryCount).toBe(2);
    expect(response.Entries.map((result: any) => result.ErrorCode)).toEqual(['InvalidArgument', 'InvalidArgument']);
  });

  test('omitted Detail defaults to {}, Time and Resources are honored, and the default bus works', async () => {
    await handle('PutRule', { Name: 'catch-all', EventPattern: JSON.stringify({ source: ['app.users'] }) });
    const response = await handle('PutEvents', {
      Entries: [{
        Source: 'app.users',
        DetailType: 'Ping',
        Time: 1767225600, // JSON-protocol timestamps arrive as epoch seconds
        Resources: ['arn:aws:events:us-east-1:000000000000:rule/x'],
      }],
    });
    expect(response.FailedEntryCount).toBe(0);
    expect(matched).toHaveLength(1);
    expect(matched[0].busName).toBe('default');
    expect(matched[0].event.time).toBe('2026-01-01T00:00:00Z');
    expect(matched[0].event.detail).toEqual({});
    expect(matched[0].event.resources).toEqual(['arn:aws:events:us-east-1:000000000000:rule/x']);
  });

  test('DISABLED rules and schedule-only rules never match', async () => {
    await handle('DisableRule', { Name: 'user-signed-up', EventBusName: 'domain-events' });
    await handle('PutRule', { Name: 'tick', ScheduleExpression: 'rate(5 minutes)' });
    const response = await handle('PutEvents', { Entries: [entry] });
    expect(response.FailedEntryCount).toBe(0);
    expect(matched).toHaveLength(0);
  });

  test('non-matching events return an EventId without emitting', async () => {
    const response = await handle('PutEvents', {
      Entries: [{ ...entry, DetailType: 'UserDeleted' }],
    });
    expect(response.FailedEntryCount).toBe(0);
    expect(response.Entries[0].EventId).toBeDefined();
    expect(matched).toHaveLength(0);
  });

  test('PutEvents without Entries throws ValidationException', async () => {
    await expect(handle('PutEvents', {})).rejects.toMatchObject({ code: 'ValidationException' });
  });
});

describe('scheduler accessor and unknown operations', () => {
  test('listScheduleRules returns only schedule rules, with targets and state', async () => {
    await handle('PutRule', { Name: 'match-rule', EventPattern: PATTERN });
    await handle('PutRule', { Name: 'cleanup', ScheduleExpression: 'rate(1 hour)', State: 'DISABLED' });
    await handle('PutTargets', { Rule: 'cleanup', Targets: [TARGET] });
    await expect(emulator.listScheduleRules('us-east-1')).resolves.toEqual([{
      busName: 'default',
      ruleName: 'cleanup',
      scheduleExpression: 'rate(1 hour)',
      state: 'DISABLED',
      targets: [{ id: 't1', arn: TARGET.Arn }],
    }]);
  });

  test('unknown operations throw NotImplemented', async () => {
    await expect(handle('TestEventPattern', {})).rejects.toMatchObject({ code: 'NotImplemented' });
    await expect(handle('TestEventPattern', {})).rejects.toBeInstanceOf(AwsError);
  });

  test('EventBusName parameters accept a full event-bus ARN', async () => {
    await handle('CreateEventBus', { Name: 'domain-events' });
    await handle('PutRule', {
      Name: 'r',
      EventBusName: 'arn:aws:events:us-east-1:000000000000:event-bus/domain-events',
      EventPattern: PATTERN,
    });
    const rules = await handle('ListRules', { EventBusName: 'domain-events' });
    expect(rules.Rules.map((rule: any) => rule.Name)).toEqual(['r']);
  });
});
