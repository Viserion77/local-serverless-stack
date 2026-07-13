// TransactWriteItems / TransactGetItems: all-or-nothing semantics, the
// TransactionCanceledException + CancellationReasons contract clients inspect
// to map condition failures to domain errors (e.g. "e-mail already exists"),
// stream records for committed writes only, ClientRequestToken idempotency
// and the wire-shape validations (PRD RF2.4/RF3).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap, AwsRequest, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-east-1';
const ACCOUNT = '000000000000';

function makeCtx(): { ctx: EngineContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ddb-transactions-'));
  const ctx: EngineContext = {
    config: {
      port: 14566, dataDir: dir, account: ACCOUNT, region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
  return { ctx, dir };
}

function makeReq(region = REGION): AwsRequest {
  return {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'dynamodb', region, requestId: 'test-request',
  };
}

async function expectAwsError(promise: Promise<unknown>, code: string, message: RegExp | string): Promise<AwsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  const error = caught as AwsError;
  expect(error.code).toBe(code);
  if (typeof message === 'string') expect(error.message).toBe(message);
  else expect(error.message).toMatch(message);
  return error;
}

interface CancellationReason {
  Code: string;
  Message: string | null;
  Item?: AttributeMap;
}

describe('DynamoDbEmulator transactions', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: DynamoDbEmulator;
  const req = makeReq();
  const call = (op: string, input: Record<string, unknown>) => emulator.handle(op, input, req);

  beforeEach(() => {
    ({ ctx, dir } = makeCtx());
    emulator = new DynamoDbEmulator(ctx);
  });

  afterEach(async () => {
    ctx.store.stopSweeper();
    ctx.bus.removeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const createUsers = (extra: Record<string, unknown> = {}) => call('CreateTable', {
    TableName: 'users',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    ...extra,
  });

  const streamSpec = { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' };

  const item = (pk: string, sk: string, extra: AttributeMap = {}): AttributeMap => ({
    pk: { S: pk }, sk: { S: sk }, ...extra,
  });
  const key = (pk: string, sk: string): AttributeMap => ({ pk: { S: pk }, sk: { S: sk } });

  const getItem = async (pk: string, sk: string): Promise<AttributeMap | undefined> => {
    const res = await call('GetItem', { TableName: 'users', Key: key(pk, sk) }) as { Item?: AttributeMap };
    return res.Item;
  };

  // The signup pattern that motivated the implementation: an e-mail
  // uniqueness marker and a profile written atomically.
  it('commits multiple conditional puts atomically', async () => {
    await createUsers();
    const response = await call('TransactWriteItems', {
      TransactItems: [
        { Put: { TableName: 'users', Item: item('email#a@b.c', 'unique'), ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: 'users', Item: item('u#1', 'profile', { email: { S: 'a@b.c' } }) } },
      ],
    });
    expect(response).toEqual({});
    expect(await getItem('email#a@b.c', 'unique')).toBeDefined();
    expect((await getItem('u#1', 'profile'))?.email).toEqual({ S: 'a@b.c' });
  });

  it('cancels the whole transaction with per-item CancellationReasons when a condition fails', async () => {
    await createUsers();
    await call('PutItem', { TableName: 'users', Item: item('email#a@b.c', 'unique', { owner: { S: 'u#0' } }) });

    const error = await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: 'users', Item: item('u#1', 'profile') } },
          {
            Put: {
              TableName: 'users',
              Item: item('email#a@b.c', 'unique'),
              ConditionExpression: 'attribute_not_exists(pk)',
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
        ],
      }),
      'TransactionCanceledException',
      'Transaction cancelled, please refer cancellation reasons for specific reasons [None, ConditionalCheckFailed]',
    );

    expect(error.status).toBe(400);
    expect(error.typeName).toBe('com.amazonaws.dynamodb.v20120810#TransactionCanceledException');
    const reasons = (error.extra as { CancellationReasons: CancellationReason[] }).CancellationReasons;
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toEqual({ Code: 'None', Message: null });
    expect(reasons[1].Code).toBe('ConditionalCheckFailed');
    expect(reasons[1].Message).toBe('The conditional request failed');
    expect(reasons[1].Item).toEqual(item('email#a@b.c', 'unique', { owner: { S: 'u#0' } }));

    // All-or-nothing: the unconditional put must not have been applied.
    expect(await getItem('u#1', 'profile')).toBeUndefined();
  });

  it('omits Item from the cancellation reason unless ReturnValuesOnConditionCheckFailure is ALL_OLD', async () => {
    await createUsers();
    await call('PutItem', { TableName: 'users', Item: item('email#a@b.c', 'unique') });
    const error = await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: 'users', Item: item('email#a@b.c', 'unique'), ConditionExpression: 'attribute_not_exists(pk)' } },
        ],
      }),
      'TransactionCanceledException',
      /Transaction cancelled/,
    );
    const reasons = (error.extra as { CancellationReasons: CancellationReason[] }).CancellationReasons;
    expect(reasons[0].Item).toBeUndefined();
  });

  it('supports Update, Delete and ConditionCheck actions', async () => {
    await createUsers();
    await call('PutItem', { TableName: 'users', Item: item('u#1', 'profile', { plan: { S: 'free' } }) });
    await call('PutItem', { TableName: 'users', Item: item('u#1', 'session') });

    const response = await call('TransactWriteItems', {
      TransactItems: [
        { ConditionCheck: { TableName: 'users', Key: key('u#1', 'profile'), ConditionExpression: 'attribute_exists(pk)' } },
        {
          Update: {
            TableName: 'users',
            Key: key('u#2', 'profile'),
            UpdateExpression: 'SET plan = :plan',
            ExpressionAttributeValues: { ':plan': { S: 'pro' } },
          },
        },
        { Delete: { TableName: 'users', Key: key('u#1', 'session') } },
      ],
      ReturnConsumedCapacity: 'TOTAL',
    }) as { ConsumedCapacity: Array<{ TableName: string; CapacityUnits: number }> };

    // Update on a missing item creates it (UpdateItem semantics).
    expect((await getItem('u#2', 'profile'))?.plan).toEqual({ S: 'pro' });
    expect(await getItem('u#1', 'session')).toBeUndefined();
    // ConditionCheck never writes.
    expect((await getItem('u#1', 'profile'))?.plan).toEqual({ S: 'free' });
    expect(response.ConsumedCapacity).toEqual([{ TableName: 'users', CapacityUnits: 0 }]);
  });

  it('rejects a transactional Update that rewrites a key attribute', async () => {
    await createUsers();
    await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: [
          {
            Update: {
              TableName: 'users',
              Key: key('u#1', 'profile'),
              UpdateExpression: 'SET sk = :sk',
              ExpressionAttributeValues: { ':sk': { S: 'other' } },
            },
          },
        ],
      }),
      'ValidationException',
      /Cannot update attribute sk/,
    );
  });

  it('emits stream records for committed writes only, in transaction order', async () => {
    await createUsers({ StreamSpecification: streamSpec });
    await call('PutItem', { TableName: 'users', Item: item('u#1', 'session') });
    await call('PutItem', { TableName: 'users', Item: item('u#0', 'anchor') });
    const before = emulator.readStream(REGION, 'users', undefined, 100).records.length;

    await call('TransactWriteItems', {
      TransactItems: [
        { Put: { TableName: 'users', Item: item('u#2', 'profile') } },
        { ConditionCheck: { TableName: 'users', Key: key('u#0', 'anchor'), ConditionExpression: 'attribute_exists(pk)' } },
        {
          Update: {
            TableName: 'users',
            Key: key('u#1', 'session'),
            UpdateExpression: 'SET touched = :t',
            ExpressionAttributeValues: { ':t': { BOOL: true } },
          },
        },
        { Delete: { TableName: 'users', Key: key('u#2', 'ghost') } },
      ],
    });

    const { records } = emulator.readStream(REGION, 'users', undefined, 100);
    const fresh = records.slice(before) as Array<{ eventName: string; dynamodb: { Keys: AttributeMap } }>;
    // ConditionCheck emits nothing; deleting a missing item emits nothing.
    expect(fresh.map((r) => r.eventName)).toEqual(['INSERT', 'MODIFY']);
    expect(fresh[0].dynamodb.Keys).toEqual(key('u#2', 'profile'));
    expect(fresh[1].dynamodb.Keys).toEqual(key('u#1', 'session'));

    // A cancelled transaction leaves the stream untouched.
    await expect(call('TransactWriteItems', {
      TransactItems: [
        { Put: { TableName: 'users', Item: item('u#3', 'profile') } },
        { ConditionCheck: { TableName: 'users', Key: key('nope', 'nope'), ConditionExpression: 'attribute_exists(pk)' } },
      ],
    })).rejects.toMatchObject({ code: 'TransactionCanceledException' });
    expect(emulator.readStream(REGION, 'users', undefined, 100).records.length).toBe(before + fresh.length);
  });

  // The all-or-nothing guarantee under a mid-transaction failure: an Update
  // whose apply blows up must cancel the whole request — nothing written, no
  // stream records, and the AWS-shaped ValidationError cancellation reason.
  it('cancels cleanly when an Update fails to apply — nothing is committed', async () => {
    await createUsers({ StreamSpecification: streamSpec });
    await call('PutItem', { TableName: 'users', Item: item('u#1', 'profile', { n: { S: 'not-a-number' } }) });
    const before = emulator.readStream(REGION, 'users', undefined, 100).records.length;

    const error = await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: 'users', Item: item('u#9', 'ghost') } },
          {
            Update: {
              TableName: 'users',
              Key: key('u#1', 'profile'),
              UpdateExpression: 'ADD n :one',
              ExpressionAttributeValues: { ':one': { N: '1' } },
            },
          },
        ],
      }),
      'TransactionCanceledException',
      /Transaction cancelled.*\[None, ValidationError\]/,
    );
    const reasons = (error.extra as { CancellationReasons: CancellationReason[] }).CancellationReasons;
    expect(reasons[0]).toEqual({ Code: 'None', Message: null });
    expect(reasons[1].Code).toBe('ValidationError');

    expect(await getItem('u#9', 'ghost')).toBeUndefined();
    expect(emulator.readStream(REGION, 'users', undefined, 100).records.length).toBe(before);
  });

  it('rejects an UpdateExpression syntax error up front without executing anything', async () => {
    await createUsers();
    await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: 'users', Item: item('u#9', 'ghost') } },
          { Update: { TableName: 'users', Key: key('u#1', 'profile'), UpdateExpression: 'FROB garbage' } },
        ],
      }),
      'ValidationException',
      /Syntax error|Invalid UpdateExpression/,
    );
    expect(await getItem('u#9', 'ghost')).toBeUndefined();
  });

  it('rejects two operations on the same item', async () => {
    await createUsers();
    await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: 'users', Item: item('u#1', 'profile') } },
          { Delete: { TableName: 'users', Key: key('u#1', 'profile') } },
        ],
      }),
      'ValidationException',
      'Transaction request cannot include multiple operations on one item',
    );
  });

  it('validates the wire shape of TransactWriteItems', async () => {
    await createUsers();
    await expectAwsError(call('TransactWriteItems', {}), 'ValidationException', /TransactItems must not be empty/);
    await expectAwsError(call('TransactWriteItems', { TransactItems: [] }), 'ValidationException', /TransactItems must not be empty/);
    await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: Array.from({ length: 101 }, (_, i) => ({ Put: { TableName: 'users', Item: item(`u#${i}`, 'x') } })),
      }),
      'ValidationException',
      /length less than or equal to 100/,
    );
    await expectAwsError(call('TransactWriteItems', { TransactItems: [{}] }), 'ValidationException', /exactly one of Put, Update, Delete or ConditionCheck/);
    await expectAwsError(
      call('TransactWriteItems', {
        TransactItems: [{
          Put: { TableName: 'users', Item: item('u#1', 'x') },
          Delete: { TableName: 'users', Key: key('u#2', 'x') },
        }],
      }),
      'ValidationException',
      /exactly one of Put, Update, Delete or ConditionCheck/,
    );
    await expectAwsError(
      call('TransactWriteItems', { TransactItems: [{ Update: { TableName: 'users', Key: key('u#1', 'x') } }] }),
      'ValidationException',
      /UpdateExpression is required for Update/,
    );
    await expectAwsError(
      call('TransactWriteItems', { TransactItems: [{ ConditionCheck: { TableName: 'users', Key: key('u#1', 'x') } }] }),
      'ValidationException',
      /ConditionExpression is required for ConditionCheck/,
    );
    await expectAwsError(
      call('TransactWriteItems', { TransactItems: [{ Put: { TableName: 'users' } }] }),
      'ValidationException',
      /Item is required for Put/,
    );
    await expectAwsError(
      call('TransactWriteItems', { TransactItems: [{ Delete: { TableName: 'users' } }] }),
      'ValidationException',
      /Key is required for Delete/,
    );
    await expectAwsError(
      call('TransactWriteItems', { TransactItems: [{ Put: { Item: item('u#1', 'x') } }] }),
      'ValidationException',
      /TableName is required for Put/,
    );
  });

  it('answers ResourceNotFoundException for a missing table', async () => {
    await expectAwsError(
      call('TransactWriteItems', { TransactItems: [{ Put: { TableName: 'ghost', Item: item('u#1', 'x') } }] }),
      'ResourceNotFoundException',
      'Requested resource not found',
    );
  });

  it('treats a TTL-expired item as absent when evaluating conditions', async () => {
    await createUsers();
    await call('UpdateTimeToLive', { TableName: 'users', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } });
    await call('PutItem', {
      TableName: 'users',
      Item: item('email#a@b.c', 'unique', { expiresAt: { N: String(Math.floor(Date.now() / 1000) - 60) } }),
    });
    // attribute_not_exists passes because the marker expired.
    await call('TransactWriteItems', {
      TransactItems: [
        { Put: { TableName: 'users', Item: item('email#a@b.c', 'unique'), ConditionExpression: 'attribute_not_exists(pk)' } },
      ],
    });
    expect((await getItem('email#a@b.c', 'unique'))?.expiresAt).toBeUndefined();
  });

  describe('ClientRequestToken idempotency', () => {
    const transactItems = () => [
      { Put: { TableName: 'users', Item: item('u#1', 'profile'), ConditionExpression: 'attribute_not_exists(pk)' } },
    ];

    it('replays a successful transaction without re-executing it', async () => {
      await createUsers();
      await call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-1' });
      await call('DeleteItem', { TableName: 'users', Key: key('u#1', 'profile') });

      // Same token + same request: replayed from the cache — the item is NOT
      // recreated (and the condition, which would now pass, is not evaluated).
      const replay = await call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-1' });
      expect(replay).toEqual({});
      expect(await getItem('u#1', 'profile')).toBeUndefined();
    });

    it('rejects reusing a token with different parameters', async () => {
      await createUsers();
      await call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-2' });
      await expectAwsError(
        call('TransactWriteItems', {
          TransactItems: [{ Put: { TableName: 'users', Item: item('u#9', 'other') } }],
          ClientRequestToken: 'token-2',
        }),
        'IdempotentParameterMismatchException',
        /same client token/,
      );
    });

    it('does not cache cancelled transactions — a retry re-executes', async () => {
      await createUsers();
      await call('PutItem', { TableName: 'users', Item: item('u#1', 'profile') });
      await expect(call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-3' }))
        .rejects.toMatchObject({ code: 'TransactionCanceledException' });

      await call('DeleteItem', { TableName: 'users', Key: key('u#1', 'profile') });
      await call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-3' });
      expect(await getItem('u#1', 'profile')).toBeDefined();
    });

    it('validates the token shape', async () => {
      await createUsers();
      await expectAwsError(
        call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'x'.repeat(37) }),
        'ValidationException',
        /ClientRequestToken/,
      );
    });

    it('answers TransactionInProgressException while the same token is still executing', async () => {
      await createUsers();
      const first = call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-4' });
      const second = call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-4' });
      const [a, b] = await Promise.allSettled([first, second]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('rejected');
      expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'TransactionInProgressException' });
      // Exactly one execution: the conditional put would have cancelled a second one.
      expect(await getItem('u#1', 'profile')).toBeDefined();
    });

    it('scopes idempotency per region — the same token executes in each region', async () => {
      await createUsers();
      const euReq = makeReq('eu-west-1');
      await emulator.handle('CreateTable', {
        TableName: 'users',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }, euReq);

      await call('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-5' });
      // Same token + same items in another region is a fresh transaction, not
      // a replay of the us-east-1 response.
      await emulator.handle('TransactWriteItems', { TransactItems: transactItems(), ClientRequestToken: 'token-5' }, euReq);
      const eu = await emulator.handle('GetItem', { TableName: 'users', Key: key('u#1', 'profile') }, euReq) as { Item?: AttributeMap };
      expect(eu.Item).toBeDefined();
    });
  });

  describe('TransactGetItems', () => {
    it('returns items in request order with {} placeholders for misses', async () => {
      await createUsers();
      await call('PutItem', { TableName: 'users', Item: item('u#1', 'profile', { email: { S: 'a@b.c' }, plan: { S: 'pro' } }) });
      const response = await call('TransactGetItems', {
        TransactItems: [
          { Get: { TableName: 'users', Key: key('u#1', 'profile'), ProjectionExpression: 'email' } },
          { Get: { TableName: 'users', Key: key('u#2', 'profile') } },
        ],
      }) as { Responses: Array<{ Item?: AttributeMap }> };
      expect(response.Responses).toEqual([
        { Item: { email: { S: 'a@b.c' } } },
        {},
      ]);
    });

    it('validates the wire shape and table existence', async () => {
      await createUsers();
      await expectAwsError(call('TransactGetItems', { TransactItems: [] }), 'ValidationException', /TransactItems must not be empty/);
      await expectAwsError(call('TransactGetItems', { TransactItems: [{}] }), 'ValidationException', /must carry a Get/);
      await expectAwsError(
        call('TransactGetItems', { TransactItems: [{ Get: { TableName: 'users' } }] }),
        'ValidationException',
        /Key is required for Get/,
      );
      await expectAwsError(
        call('TransactGetItems', { TransactItems: [{ Get: { TableName: 'ghost', Key: key('u#1', 'x') } }] }),
        'ResourceNotFoundException',
        'Requested resource not found',
      );
    });

    it('rejects duplicate gets on the same item', async () => {
      await createUsers();
      await expectAwsError(
        call('TransactGetItems', {
          TransactItems: [
            { Get: { TableName: 'users', Key: key('u#1', 'profile') } },
            { Get: { TableName: 'users', Key: key('u#1', 'profile') } },
          ],
        }),
        'ValidationException',
        'Transaction request cannot include multiple operations on one item',
      );
    });

    it('reports ConsumedCapacity when requested', async () => {
      await createUsers();
      const response = await call('TransactGetItems', {
        TransactItems: [
          { Get: { TableName: 'users', Key: key('u#1', 'profile') } },
          { Get: { TableName: 'users', Key: key('u#2', 'profile') } },
        ],
        ReturnConsumedCapacity: 'TOTAL',
      }) as { ConsumedCapacity: Array<{ TableName: string; CapacityUnits: number }> };
      expect(response.ConsumedCapacity).toEqual([{ TableName: 'users', CapacityUnits: 0 }]);
    });
  });
});
