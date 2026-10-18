// Background TTL deleter: expired items are removed without any read, emit
// the Service-principal stream REMOVE, idle tables are left alone until an
// expiry is actually due, and the timer is unref'd, idempotent and stoppable.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_TTL_SWEEP_INTERVAL_MS, DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import type { AttributeMap, AwsRequest, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-east-1';
const TTL_IDENTITY = { type: 'Service', principalId: 'dynamodb.amazonaws.com' };

describe('DynamoDB TTL sweep', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: DynamoDbEmulator;
  const req: AwsRequest = {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'dynamodb', region: REGION, requestId: 'test-request',
  };
  const call = (op: string, input: Record<string, unknown>) => emulator.handle(op, input, req);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const itemsOf = (table: string) => ctx.store.table(`dynamodb/${REGION}/${table}/items`);

  const createTable = async (name: string, opts: { stream?: boolean; ttl?: boolean } = {}) => {
    await call('CreateTable', {
      TableName: name,
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
      ...(opts.stream ? { StreamSpecification: { StreamEnabled: true, StreamViewType: 'OLD_IMAGE' } } : {}),
    });
    if (opts.ttl !== false) {
      await call('UpdateTimeToLive', {
        TableName: name,
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      });
    }
  };
  const put = (table: string, id: string, expiresAt?: number) => call('PutItem', {
    TableName: table,
    Item: { id: { S: id }, ...(expiresAt === undefined ? {} : { expiresAt: { N: String(expiresAt) } }) },
  });
  const removes = (table: string) => (emulator.readStream(REGION, table, undefined, 100).records as Array<Record<string, any>>)
    .filter((r) => r.eventName === 'REMOVE');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ddb-ttl-'));
    ctx = {
      config: {
        port: 14566, dataDir: dir, account: '000000000000', region: REGION,
        idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
      },
      store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
      bus: new EngineBus(),
      dispatcher: { invokeFunction: async () => ({ ok: true }) },
      endpoint: () => 'http://127.0.0.1:14566',
    };
    emulator = new DynamoDbEmulator(ctx);
  });

  afterEach(() => {
    emulator.stopTtlSweeper();
    ctx.store.stopSweeper();
    jest.restoreAllMocks();
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes expired items without a read and emits the TTL-principal REMOVE', async () => {
    await createTable('sessions', { stream: true });
    await put('sessions', 'dead', nowSec() - 60);
    await put('sessions', 'alive', nowSec() + 3600);
    await put('sessions', 'forever');

    expect(await emulator.sweepExpired()).toBe(1);
    expect(itemsOf('sessions').size()).toBe(2);
    const [remove] = removes('sessions');
    expect(remove.userIdentity).toEqual(TTL_IDENTITY);
    expect(remove.dynamodb.Keys).toEqual({ id: { S: 'dead' } });
    expect(remove.dynamodb.OldImage.expiresAt).toEqual({ N: String(nowSec() - 60) });
  });

  it('skips tables without TTL enabled', async () => {
    await createTable('carts', { ttl: false });
    await put('carts', 'old', nowSec() - 60);
    expect(await emulator.sweepExpired()).toBe(0);
    expect(itemsOf('carts').size()).toBe(1);
  });

  it('never expires a TTL value that is not a finite epoch', async () => {
    await createTable('sessions');
    await call('PutItem', { TableName: 'sessions', Item: { id: { S: 'huge' }, expiresAt: { N: '1e400' } } });
    expect(await emulator.sweepExpired()).toBe(0);
    expect(itemsOf('sessions').size()).toBe(1);
  });

  it('leaves a table untouched until its next expiry is due, then removes the item', async () => {
    await createTable('sessions', { stream: true });
    const expiresAt = nowSec() + 120;
    await put('sessions', 'soon', expiresAt);
    expect(await emulator.sweepExpired()).toBe(0);

    // Nothing due and nothing written: the pass must not even touch the
    // table (so an idle table still dehydrates on schedule).
    const touched = itemsOf('sessions').lastTouchedAt();
    const entries = jest.spyOn(itemsOf('sessions'), 'entries');
    expect(await emulator.sweepExpired()).toBe(0);
    expect(entries).not.toHaveBeenCalled();
    expect(itemsOf('sessions').lastTouchedAt()).toBe(touched);

    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 130_000);
    expect(await emulator.sweepExpired()).toBe(1);
    expect(removes('sessions')).toHaveLength(1);
  });

  it('keeps skipping a table whose items carry no TTL, until a write lands', async () => {
    await createTable('sessions');
    await put('sessions', 'forever');
    expect(await emulator.sweepExpired()).toBe(0);
    const entries = jest.spyOn(itemsOf('sessions'), 'entries');
    expect(await emulator.sweepExpired()).toBe(0);
    expect(entries).not.toHaveBeenCalled();

    // Every write path drops the mark, so a just-written expired item is
    // found on the next pass.
    await put('sessions', 'put', nowSec() - 1);
    await call('UpdateItem', {
      TableName: 'sessions', Key: { id: { S: 'updated' } },
      UpdateExpression: 'SET expiresAt = :t', ExpressionAttributeValues: { ':t': { N: String(nowSec() - 1) } },
    });
    expect(await emulator.sweepExpired()).toBe(2);
    expect(await emulator.sweepExpired()).toBe(0);

    await call('BatchWriteItem', {
      RequestItems: { sessions: [{ PutRequest: { Item: { id: { S: 'batched' }, expiresAt: { N: String(nowSec() - 1) } } } }] },
    });
    expect(await emulator.sweepExpired()).toBe(1);

    await call('TransactWriteItems', {
      TransactItems: [{ Put: { TableName: 'sessions', Item: { id: { S: 'tx' }, expiresAt: { N: String(nowSec() - 1) } } } }],
    });
    expect(await emulator.sweepExpired()).toBe(1);
    expect(itemsOf('sessions').size()).toBe(1);
  });

  it('rescans after the TTL attribute changes or the table is recreated', async () => {
    await createTable('sessions');
    await put('sessions', 'a', nowSec() + 3600);
    expect(await emulator.sweepExpired()).toBe(0);

    // Disable, then re-enable on another attribute the item already carries
    // as expired: the stale mark must not hide it.
    await call('UpdateTimeToLive', { TableName: 'sessions', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: false } });
    await call('PutItem', {
      TableName: 'sessions',
      Item: { id: { S: 'a' }, expiresAt: { N: String(nowSec() + 3600) }, deadline: { N: String(nowSec() - 5) } },
    });
    expect(await emulator.sweepExpired()).toBe(0);
    await call('UpdateTimeToLive', { TableName: 'sessions', TimeToLiveSpecification: { AttributeName: 'deadline', Enabled: true } });
    expect(await emulator.sweepExpired()).toBe(1);

    await call('DeleteTable', { TableName: 'sessions' });
    expect(await emulator.sweepExpired()).toBe(0);
  });

  it('rehydrates an idle table only when a stream makes the expiry observable', async () => {
    await createTable('streamed', { stream: true });
    await createTable('plain');
    await put('streamed', 'dead', nowSec() - 60);
    await put('plain', 'dead', nowSec() - 60);
    await itemsOf('streamed').dehydrate();
    await itemsOf('plain').dehydrate();

    expect(await emulator.sweepExpired()).toBe(1);
    expect(itemsOf('streamed').isHydrated()).toBe(true);
    expect(removes('streamed')[0].userIdentity).toEqual(TTL_IDENTITY);
    expect(itemsOf('plain').isHydrated()).toBe(false);

    // The plain table's expired item stays invisible to readers regardless.
    const got = await call('GetItem', { TableName: 'plain', Key: { id: { S: 'dead' } } }) as { Item?: AttributeMap };
    expect(got.Item).toBeUndefined();
  });

  it('shares one in-flight pass between concurrent callers', async () => {
    await createTable('sessions');
    await put('sessions', 'dead', nowSec() - 60);
    const [a, b] = await Promise.all([emulator.sweepExpired(), emulator.sweepExpired()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(await emulator.sweepExpired()).toBe(0);
  });

  it('runs on an idempotent interval and stops cleanly', async () => {
    jest.useFakeTimers();
    const sweep = jest.spyOn(emulator, 'sweepExpired').mockResolvedValue(0);
    const timers = jest.spyOn(global, 'setInterval');
    emulator.startTtlSweeper(1_000);
    emulator.startTtlSweeper(1_000);
    expect(timers).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2_500);
    expect(sweep).toHaveBeenCalledTimes(2);
    emulator.stopTtlSweeper();
    emulator.stopTtlSweeper();
    jest.advanceTimersByTime(5_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('defaults to a 30 s interval and logs (never throws) a failed pass', async () => {
    expect(DEFAULT_TTL_SWEEP_INTERVAL_MS).toBe(30_000);
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(emulator, 'sweepExpired').mockRejectedValue(new Error('disk on fire'));
    emulator.startTtlSweeper();
    jest.advanceTimersByTime(DEFAULT_TTL_SWEEP_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith('[dynamodb] TTL sweep failed:', expect.any(Error));
  });
});
