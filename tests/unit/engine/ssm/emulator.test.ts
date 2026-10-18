// SSM Parameter Store emulator: PutParameter with versioning, Overwrite,
// AllowedPattern, tiers and data types; the three read paths (GetParameter,
// GetParameters, GetParametersByPath) with version/label selectors, SecureString
// decryption semantics and pagination; DescribeParameters, history, labels,
// deletes and tagging. Error names match what @aws-sdk/client-ssm branches on.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SsmEmulator } from '../../../../src/server/engine/emulators/ssm';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AwsRequest, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-west-2';
const ACCOUNT = '000000000000';

function makeCtx(dir: string): EngineContext {
  return {
    config: {
      port: 14566, dataDir: dir, account: ACCOUNT, region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
}

function makeReq(region = REGION): AwsRequest {
  return {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'ssm', region, requestId: 'test-request',
  };
}

async function expectAwsError(promise: Promise<unknown>, code: string): Promise<AwsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  const error = caught as AwsError;
  expect(error.code).toBe(code);
  return error;
}

type Param = Record<string, unknown>;

describe('SsmEmulator', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: SsmEmulator;
  const req = makeReq();
  const call = (op: string, input: Record<string, unknown>) => emulator.handle(op, input, req) as Promise<Record<string, unknown>>;
  const put = (Name: string, Value: string, extra: Record<string, unknown> = {}) =>
    call('PutParameter', { Name, Value, Type: 'String', ...extra });
  const get = async (Name: string, extra: Record<string, unknown> = {}) =>
    (await call('GetParameter', { Name, ...extra })).Parameter as Param;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ssm-'));
    ctx = makeCtx(dir);
    emulator = new SsmEmulator(ctx);
  });

  afterEach(() => {
    ctx.store.stopSweeper();
    ctx.bus.removeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('identifies as the AmazonSSM JSON 1.1 target', () => {
    expect(emulator.service).toBe('ssm');
    expect(emulator.targetPrefix).toBe('AmazonSSM');
    expect(emulator.jsonVersion).toBe('1.1');
  });

  it('rejects unknown operations as NotImplemented', async () => {
    const err = await expectAwsError(call('PutComplianceItems', {}), 'NotImplemented');
    expect(err.message).toContain('ssm.PutComplianceItems');
  });

  describe('PutParameter / GetParameter', () => {
    it('creates version 1 and reads it back with the AWS shape', async () => {
      const before = Date.now() / 1000;
      expect(await put('/acme/orders/table-name', 'orders')).toEqual({ Version: 1, Tier: 'Standard' });
      const param = await get('/acme/orders/table-name');
      expect(param).toEqual({
        Name: '/acme/orders/table-name',
        Type: 'String',
        Value: 'orders',
        Version: 1,
        LastModifiedDate: expect.any(Number),
        ARN: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/acme/orders/table-name`,
        DataType: 'text',
      });
      expect(param.LastModifiedDate as number).toBeGreaterThanOrEqual(Math.floor(before));
    });

    it('builds the ARN of a flat name without doubling the slash', async () => {
      await put('feature-flag', 'on');
      expect((await get('feature-flag')).ARN).toBe(`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/feature-flag`);
    });

    it('resolves a parameter by its ARN', async () => {
      await put('/acme/orders/db-host', 'db.local');
      await put('flat', 'x');
      expect((await get(`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/acme/orders/db-host`)).Value).toBe('db.local');
      expect((await get(`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/flat`)).Value).toBe('x');
    });

    it('refuses to replace without Overwrite, and versions on Overwrite', async () => {
      await put('/acme/orders/db-password', 'v1');
      await expectAwsError(put('/acme/orders/db-password', 'v2'), 'ParameterAlreadyExists');
      expect(await put('/acme/orders/db-password', 'v2', { Overwrite: true })).toEqual({ Version: 2, Tier: 'Standard' });
      const current = await get('/acme/orders/db-password');
      expect(current.Value).toBe('v2');
      expect(current.Version).toBe(2);
    });

    it('keeps the current Type, Description and AllowedPattern on an overwrite that omits them', async () => {
      await call('PutParameter', {
        Name: '/acme/port', Value: '8080', Type: 'String', Description: 'listener', AllowedPattern: '^\\d+$',
      });
      await call('PutParameter', { Name: '/acme/port', Value: '9090', Overwrite: true });
      await expectAwsError(call('PutParameter', { Name: '/acme/port', Value: 'abc', Overwrite: true }), 'ParameterPatternMismatchException');
      const described = await call('DescribeParameters', {});
      expect((described.Parameters as Param[])[0]).toMatchObject({
        Type: 'String', Description: 'listener', AllowedPattern: '^\\d+$', Version: 2,
      });
      // Explicitly replacing them takes effect.
      await call('PutParameter', { Name: '/acme/port', Value: 'abc', Overwrite: true, Description: 'renamed', AllowedPattern: '.*' });
      const after = (await call('DescribeParameters', {})).Parameters as Param[];
      expect(after[0]).toMatchObject({ Description: 'renamed', AllowedPattern: '.*', Version: 3 });
    });

    it('requires a Type on create and validates it', async () => {
      await expectAwsError(call('PutParameter', { Name: '/acme/x', Value: 'v' }), 'ValidationException');
      await expectAwsError(call('PutParameter', { Name: '/acme/x', Value: 'v', Type: 'Number' }), 'UnsupportedParameterType');
    });

    it('requires Name and Value', async () => {
      await expectAwsError(call('PutParameter', { Value: 'v', Type: 'String' }), 'ValidationException');
      await expectAwsError(call('PutParameter', { Name: '/acme/x', Value: '', Type: 'String' }), 'ValidationException');
    });

    it('stores a StringList verbatim', async () => {
      await call('PutParameter', { Name: '/acme/hosts', Value: 'a,b,c', Type: 'StringList' });
      expect(await get('/acme/hosts')).toMatchObject({ Type: 'StringList', Value: 'a,b,c' });
    });

    it('rejects an invalid AllowedPattern regex', async () => {
      await expectAwsError(put('/acme/x', 'v', { AllowedPattern: '([' }), 'InvalidAllowedPatternException');
    });

    it('rejects create-time tags combined with Overwrite, and too many tags', async () => {
      await expectAwsError(put('/acme/x', 'v', { Overwrite: true, Tags: [{ Key: 'team', Value: 'acme' }] }), 'ValidationException');
      const tags = Array.from({ length: 51 }, (_, i) => ({ Key: `k${i}`, Value: 'v' }));
      await expectAwsError(put('/acme/x', 'v', { Tags: tags }), 'TooManyTagsError');
    });

    it('caps the region at the standard parameter limit', async () => {
      const catalog = ctx.store.catalog<Record<string, unknown>>(`ssm/${REGION}/parameters`);
      await catalog.load();
      for (let i = 0; i < 10_000; i++) catalog.set(`p${i}`, { name: `p${i}`, tags: [], versions: [] });
      await expectAwsError(put('one-too-many', 'v'), 'ParameterLimitExceeded');
    });

    it('keeps only the 100 most recent versions', async () => {
      await put('/acme/rolling', 'v1');
      for (let i = 2; i <= 101; i++) await put('/acme/rolling', `v${i}`, { Overwrite: true });
      await expectAwsError(get('/acme/rolling:1'), 'ParameterVersionNotFound');
      expect((await get('/acme/rolling:2')).Value).toBe('v2');
      expect((await get('/acme/rolling')).Version).toBe(101);
    });

    it('raises ParameterNotFound for a missing name', async () => {
      const err = await expectAwsError(get('/acme/ghost'), 'ParameterNotFound');
      expect(err.message).toContain('/acme/ghost');
    });

    it('isolates parameters per region', async () => {
      await put('/acme/x', 'west');
      await expectAwsError(emulator.handle('GetParameter', { Name: '/acme/x' }, makeReq('eu-west-1')), 'ParameterNotFound');
    });

    it('persists parameters across emulator instances', async () => {
      await put('/acme/persisted', 'kept');
      await ctx.store.flushAll();
      ctx.store.stopSweeper();
      ctx = makeCtx(dir);
      emulator = new SsmEmulator(ctx);
      expect((await get('/acme/persisted')).Value).toBe('kept');
    });
  });

  describe('name validation', () => {
    it.each([
      ['/acme//double', 'ValidationException'],
      ['/acme/trailing/', 'ValidationException'],
      ['relative/path', 'ValidationException'],
      ['has space', 'ValidationException'],
      ['aws-reserved', 'ValidationException'],
      ['/SSM/reserved', 'ValidationException'],
      ['x'.repeat(1012), 'ValidationException'],
      [`/${Array.from({ length: 16 }, (_, i) => `l${i}`).join('/')}`, 'HierarchyLevelLimitExceededException'],
    ])('rejects %s with %s', async (name, code) => {
      await expectAwsError(put(name, 'v'), code);
    });

    it('accepts exactly 15 hierarchy levels', async () => {
      const name = `/${Array.from({ length: 15 }, (_, i) => `l${i}`).join('/')}`;
      expect(await put(name, 'v')).toEqual({ Version: 1, Tier: 'Standard' });
    });
  });

  describe('SecureString', () => {
    it('returns the plaintext only WithDecryption, an opaque stable token otherwise', async () => {
      await call('PutParameter', { Name: '/acme/orders/db-password', Value: 's3cret', Type: 'SecureString' });
      const decrypted = await get('/acme/orders/db-password', { WithDecryption: true });
      expect(decrypted).toMatchObject({ Type: 'SecureString', Value: 's3cret' });

      const opaque = await get('/acme/orders/db-password');
      expect(opaque.Type).toBe('SecureString');
      expect(opaque.Value).not.toBe('s3cret');
      expect(Buffer.from(opaque.Value as string, 'base64').toString('latin1')).not.toContain('s3cret');
      expect(Buffer.from(opaque.Value as string, 'base64').toString('latin1')).toMatch(/^lss-ssm-securestring:/);
      expect((await get('/acme/orders/db-password')).Value).toBe(opaque.Value);

      await call('PutParameter', { Name: '/acme/orders/db-password', Value: 'rotated', Overwrite: true });
      expect((await get('/acme/orders/db-password')).Value).not.toBe(opaque.Value);
    });

    it('defaults KeyId to alias/aws/ssm, keeps a custom one, and refuses KeyId on other types', async () => {
      await call('PutParameter', { Name: '/acme/a', Value: 'x', Type: 'SecureString' });
      await call('PutParameter', { Name: '/acme/b', Value: 'x', Type: 'SecureString', KeyId: 'alias/acme' });
      await call('PutParameter', { Name: '/acme/b', Value: 'y', Overwrite: true });
      // Changing the type from String → SecureString picks the default key.
      await put('/acme/c', 'x');
      await call('PutParameter', { Name: '/acme/c', Value: 'y', Type: 'SecureString', Overwrite: true });
      const params = (await call('DescribeParameters', {})).Parameters as Param[];
      expect(params.map((p) => [p.Name, p.KeyId])).toEqual([
        ['/acme/a', 'alias/aws/ssm'], ['/acme/b', 'alias/acme'], ['/acme/c', 'alias/aws/ssm'],
      ]);
      await expectAwsError(put('/acme/d', 'x', { KeyId: 'alias/acme' }), 'ValidationException');
    });
  });

  describe('tiers and data types', () => {
    it('promotes Intelligent-Tiering and omitted tiers to Advanced only when the value needs it', async () => {
      expect(await put('/acme/small', 'x', { Tier: 'Intelligent-Tiering' })).toEqual({ Version: 1, Tier: 'Standard' });
      expect(await put('/acme/big', 'x'.repeat(5000))).toEqual({ Version: 1, Tier: 'Advanced' });
      expect(await put('/acme/adv', 'x', { Tier: 'Advanced' })).toEqual({ Version: 1, Tier: 'Advanced' });
      // An Advanced parameter stays Advanced on an overwrite that omits Tier…
      expect(await put('/acme/adv', 'y', { Overwrite: true })).toEqual({ Version: 2, Tier: 'Advanced' });
      // …and refuses an explicit downgrade.
      await expectAwsError(put('/acme/adv', 'z', { Overwrite: true, Tier: 'Standard' }), 'ValidationException');
    });

    it('rejects oversized values and invalid tiers', async () => {
      await expectAwsError(put('/acme/x', 'x'.repeat(4097), { Tier: 'Standard' }), 'ValidationException');
      await expectAwsError(put('/acme/x', 'x'.repeat(8193)), 'ValidationException');
      await expectAwsError(put('/acme/x', 'x', { Tier: 'Premium' }), 'ValidationException');
      expect(await put('/acme/x', 'x', { Tier: 'Standard' })).toEqual({ Version: 1, Tier: 'Standard' });
    });

    it('accepts the AWS data types and rejects others', async () => {
      await put('/acme/ami', 'ami-0123456789abcdef0', { DataType: 'aws:ec2:image' });
      expect((await get('/acme/ami')).DataType).toBe('aws:ec2:image');
      await put('/acme/ami', 'ami-1', { Overwrite: true });
      expect((await get('/acme/ami')).DataType).toBe('aws:ec2:image');
      await expectAwsError(put('/acme/y', 'x', { DataType: 'json' }), 'ValidationException');
    });
  });

  describe('selectors and labels', () => {
    beforeEach(async () => {
      await put('/acme/conn', 'v1');
      await put('/acme/conn', 'v2', { Overwrite: true });
      await put('/acme/conn', 'v3', { Overwrite: true });
    });

    it('reads a specific version with name:version', async () => {
      expect(await get('/acme/conn:1')).toMatchObject({ Value: 'v1', Version: 1, Selector: ':1', Name: '/acme/conn' });
      await expectAwsError(get('/acme/conn:9'), 'ParameterVersionNotFound');
    });

    it('labels a version, moves labels between versions and reads name:label', async () => {
      expect(await call('LabelParameterVersion', { Name: '/acme/conn', ParameterVersion: 1, Labels: ['stable', '1bad', 'awsx', 'ok'] }))
        .toEqual({ InvalidLabels: ['1bad', 'awsx'], ParameterVersion: 1 });
      expect(await get('/acme/conn:stable')).toMatchObject({ Value: 'v1', Selector: ':stable' });
      // Without ParameterVersion the label goes to the latest — and leaves v1.
      expect(await call('LabelParameterVersion', { Name: '/acme/conn', Labels: ['stable'] }))
        .toEqual({ InvalidLabels: [], ParameterVersion: 3 });
      expect((await get('/acme/conn:stable')).Value).toBe('v3');
      const history = (await call('GetParameterHistory', { Name: '/acme/conn' })).Parameters as Param[];
      expect(history.map((h) => h.Labels)).toEqual([['ok'], [], ['stable']]);
      await expectAwsError(get('/acme/conn:missing'), 'ParameterNotFound');
    });

    it('validates labels and versions', async () => {
      await expectAwsError(call('LabelParameterVersion', { Name: '/acme/conn', Labels: [] }), 'ValidationException');
      await expectAwsError(call('LabelParameterVersion', { Name: '/acme/conn' }), 'ValidationException');
      await expectAwsError(call('LabelParameterVersion', { Name: '/acme/conn', ParameterVersion: 7, Labels: ['x'] }), 'ParameterVersionNotFound');
      await expectAwsError(call('LabelParameterVersion', { Name: '/acme/ghost', Labels: ['x'] }), 'ParameterNotFound');
      const invalid = await call('LabelParameterVersion', { Name: '/acme/conn', Labels: ['', 'x'.repeat(101), 'bad label', 'ssm-x'] });
      expect(invalid.InvalidLabels).toEqual(['', 'x'.repeat(101), 'bad label', 'ssm-x']);
      const ten = Array.from({ length: 10 }, (_, i) => `l${i}`);
      await call('LabelParameterVersion', { Name: '/acme/conn', Labels: ten });
      await expectAwsError(call('LabelParameterVersion', { Name: '/acme/conn', Labels: ['eleventh'] }), 'ParameterVersionLabelLimitExceeded');
    });
  });

  describe('GetParameters', () => {
    it('returns found parameters and lists the rest as InvalidParameters', async () => {
      await put('/acme/a', '1');
      await call('PutParameter', { Name: '/acme/s', Value: 'secret', Type: 'SecureString' });
      const res = await call('GetParameters', { Names: ['/acme/a', '/acme/ghost', '/acme/a:4', '/acme/s'], WithDecryption: true });
      expect((res.Parameters as Param[]).map((p) => [p.Name, p.Value])).toEqual([['/acme/a', '1'], ['/acme/s', 'secret']]);
      expect(res.InvalidParameters).toEqual(['/acme/ghost', '/acme/a:4']);
    });

    it('requires between 1 and 10 string names', async () => {
      await expectAwsError(call('GetParameters', { Names: [] }), 'ValidationException');
      await expectAwsError(call('GetParameters', {}), 'ValidationException');
      await expectAwsError(call('GetParameters', { Names: Array.from({ length: 11 }, (_, i) => `n${i}`) }), 'ValidationException');
      await expectAwsError(call('GetParameters', { Names: [1] }), 'ValidationException');
    });
  });

  describe('GetParametersByPath', () => {
    beforeEach(async () => {
      await put('/acme/orders/table', 'orders');
      await call('PutParameter', { Name: '/acme/orders/db-password', Value: 'pw', Type: 'SecureString' });
      await put('/acme/orders/deep/nested', 'n');
      await put('/acme/ordersx/sibling', 's');
      await put('/acme/payments/table', 'payments');
      await put('flat', 'f');
    });

    const byPath = async (input: Record<string, unknown>) => call('GetParametersByPath', input);
    const names = (res: Record<string, unknown>) => (res.Parameters as Param[]).map((p) => p.Name);

    it('returns one level by default and everything below with Recursive', async () => {
      expect(names(await byPath({ Path: '/acme/orders' }))).toEqual(['/acme/orders/db-password', '/acme/orders/table']);
      expect(names(await byPath({ Path: '/acme/orders/', Recursive: true })))
        .toEqual(['/acme/orders/db-password', '/acme/orders/deep/nested', '/acme/orders/table']);
      expect(names(await byPath({ Path: '/', Recursive: true }))).toHaveLength(5);
      expect(names(await byPath({ Path: '/' }))).toEqual([]);
    });

    it('honours WithDecryption for SecureString', async () => {
      const plain = (await byPath({ Path: '/acme/orders', WithDecryption: true })).Parameters as Param[];
      expect(plain[0].Value).toBe('pw');
      const opaque = (await byPath({ Path: '/acme/orders' })).Parameters as Param[];
      expect(opaque[0].Value).not.toBe('pw');
    });

    it('paginates with MaxResults and an opaque NextToken', async () => {
      const first = await byPath({ Path: '/acme', Recursive: true, MaxResults: 2 });
      expect(names(first)).toEqual(['/acme/orders/db-password', '/acme/orders/deep/nested']);
      expect(first.NextToken).toEqual(expect.any(String));
      const second = await byPath({ Path: '/acme', Recursive: true, MaxResults: 2, NextToken: first.NextToken });
      expect(names(second)).toEqual(['/acme/orders/table', '/acme/ordersx/sibling']);
      const third = await byPath({ Path: '/acme', Recursive: true, MaxResults: 2, NextToken: second.NextToken });
      expect(names(third)).toEqual(['/acme/payments/table']);
      expect(third.NextToken).toBeUndefined();
      await expectAwsError(byPath({ Path: '/acme', NextToken: 'garbage' }), 'InvalidNextToken');
      await expectAwsError(byPath({ Path: '/acme', NextToken: 42 }), 'InvalidNextToken');
      await expectAwsError(byPath({ Path: '/acme', MaxResults: 11 }), 'ValidationException');
      await expectAwsError(byPath({ Path: '/acme', MaxResults: 0 }), 'ValidationException');
      await expectAwsError(byPath({ Path: '/acme', MaxResults: '5' }), 'ValidationException');
    });

    it('filters by Type, KeyId, DataType and Label', async () => {
      expect(names(await byPath({
        Path: '/acme/orders', ParameterFilters: [{ Key: 'Type', Values: ['SecureString'] }],
      }))).toEqual(['/acme/orders/db-password']);
      expect(names(await byPath({
        Path: '/acme/orders', ParameterFilters: [{ Key: 'KeyId', Option: 'Equals', Values: ['alias/aws/ssm'] }],
      }))).toEqual(['/acme/orders/db-password']);
      expect(names(await byPath({
        Path: '/acme/orders', ParameterFilters: [{ Key: 'DataType', Values: ['text'] }],
      }))).toHaveLength(2);

      await put('/acme/orders/table', 'orders-v2', { Overwrite: true });
      await call('LabelParameterVersion', { Name: '/acme/orders/table', ParameterVersion: 1, Labels: ['prod'] });
      const labeled = (await byPath({
        Path: '/acme/orders', ParameterFilters: [{ Key: 'Label', Values: ['prod'] }, { Key: 'Type', Values: ['String'] }],
      })).Parameters as Param[];
      expect(labeled.map((p) => [p.Name, p.Value, p.Version])).toEqual([['/acme/orders/table', 'orders', 1]]);
    });

    it('rejects filters, options and values GetParametersByPath does not accept', async () => {
      await expectAwsError(byPath({ Path: '/acme', ParameterFilters: [{ Key: 'Name', Values: ['x'] }] }), 'InvalidFilterKey');
      await expectAwsError(byPath({ Path: '/acme', ParameterFilters: [{ Key: 'tag:team', Values: ['x'] }] }), 'InvalidFilterKey');
      await expectAwsError(byPath({ Path: '/acme', ParameterFilters: [{ Values: ['x'] }] }), 'InvalidFilterKey');
      await expectAwsError(byPath({ Path: '/acme', ParameterFilters: [{ Key: 'Type', Option: 'BeginsWith', Values: ['S'] }] }), 'InvalidFilterOption');
      await expectAwsError(byPath({ Path: '/acme', ParameterFilters: [{ Key: 'Type' }] }), 'InvalidFilterValue');
      await expectAwsError(byPath({ Path: '/acme', ParameterFilters: { Key: 'Type' } }), 'ValidationException');
    });

    it('validates the path', async () => {
      await expectAwsError(byPath({ Path: 'acme' }), 'ValidationException');
      await expectAwsError(byPath({ Path: '/acme//x' }), 'ValidationException');
      await expectAwsError(byPath({ Path: '/acme x' }), 'ValidationException');
      await expectAwsError(byPath({}), 'ValidationException');
      await expectAwsError(byPath({ Path: `/${Array.from({ length: 16 }, (_, i) => `l${i}`).join('/')}` }), 'HierarchyLevelLimitExceededException');
    });
  });

  describe('DescribeParameters', () => {
    beforeEach(async () => {
      await put('/acme/orders/table', 'orders', { Description: 'table name', Tags: [{ Key: 'team', Value: 'orders' }] });
      await call('PutParameter', { Name: '/acme/orders/db-password', Value: 'pw', Type: 'SecureString', Tier: 'Advanced' });
      await put('/acme/orders/deep/nested', 'n', { Tags: [{ Key: 'team' }] });
      await put('flat', 'f');
    });

    const describeNames = async (input: Record<string, unknown>) =>
      ((await call('DescribeParameters', input)).Parameters as Param[]).map((p) => p.Name);

    it('describes metadata without values, sorted by name', async () => {
      const res = await call('DescribeParameters', {});
      const params = res.Parameters as Param[];
      expect(params.map((p) => p.Name)).toEqual(['/acme/orders/db-password', '/acme/orders/deep/nested', '/acme/orders/table', 'flat']);
      expect(params[2]).toEqual({
        Name: '/acme/orders/table',
        ARN: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/acme/orders/table`,
        Type: 'String',
        LastModifiedDate: expect.any(Number),
        LastModifiedUser: `arn:aws:iam::${ACCOUNT}:root`,
        Description: 'table name',
        Version: 1,
        Tier: 'Standard',
        Policies: [],
        DataType: 'text',
      });
      expect(params[2]).not.toHaveProperty('Value');
      expect(res.NextToken).toBeUndefined();
    });

    it('filters by Name (Equals/BeginsWith/Contains), Path, Type, Tier, KeyId and tags', async () => {
      expect(await describeNames({ ParameterFilters: [{ Key: 'Name', Values: ['/acme/orders/table'] }] })).toEqual(['/acme/orders/table']);
      // Name matches with or without the leading slash.
      expect(await describeNames({ ParameterFilters: [{ Key: 'Name', Values: ['acme/orders/table'] }] })).toEqual(['/acme/orders/table']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Name', Values: ['flat'] }] })).toEqual(['flat']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Name', Option: 'BeginsWith', Values: ['/acme/orders/d'] }] }))
        .toEqual(['/acme/orders/db-password', '/acme/orders/deep/nested']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Name', Option: 'Contains', Values: ['nest'] }] }))
        .toEqual(['/acme/orders/deep/nested']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Path', Values: ['/acme/orders'] }] }))
        .toEqual(['/acme/orders/db-password', '/acme/orders/table']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Path', Option: 'Recursive', Values: ['/acme/'] }] })).toHaveLength(3);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Path', Values: ['/payments'] }] })).toEqual([]);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Type', Values: ['SecureString'] }] })).toEqual(['/acme/orders/db-password']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'Tier', Values: ['Advanced'] }] })).toEqual(['/acme/orders/db-password']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'KeyId', Values: ['alias/aws/ssm'] }] })).toEqual(['/acme/orders/db-password']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'DataType', Values: ['text'] }] })).toHaveLength(4);
      expect(await describeNames({ ParameterFilters: [{ Key: 'tag:team', Values: ['orders'] }] })).toEqual(['/acme/orders/table']);
      expect(await describeNames({ ParameterFilters: [{ Key: 'tag:team' }] })).toEqual(['/acme/orders/deep/nested', '/acme/orders/table']);
    });

    it('rejects Label (by-path only) and unsupported options', async () => {
      await expectAwsError(call('DescribeParameters', { ParameterFilters: [{ Key: 'Label', Values: ['x'] }] }), 'InvalidFilterKey');
      await expectAwsError(call('DescribeParameters', { ParameterFilters: [{ Key: 'tag:', Values: ['x'] }] }), 'InvalidFilterKey');
      await expectAwsError(call('DescribeParameters', { ParameterFilters: [{ Key: 'Path', Option: 'Equals', Values: ['/a'] }] }), 'InvalidFilterOption');
    });

    it('paginates up to 50 per page', async () => {
      const first = await call('DescribeParameters', { MaxResults: 3 });
      expect((first.Parameters as Param[])).toHaveLength(3);
      const second = await call('DescribeParameters', { MaxResults: 3, NextToken: first.NextToken });
      expect((second.Parameters as Param[]).map((p) => p.Name)).toEqual(['flat']);
      await expectAwsError(call('DescribeParameters', { MaxResults: 51 }), 'ValidationException');
    });
  });

  describe('GetParameterHistory', () => {
    it('lists every version oldest first, with values and pagination', async () => {
      await call('PutParameter', { Name: '/acme/s', Value: 'one', Type: 'SecureString', Description: 'd' });
      await call('PutParameter', { Name: '/acme/s', Value: 'two', Overwrite: true });
      const plain = (await call('GetParameterHistory', { Name: '/acme/s', WithDecryption: true })).Parameters as Param[];
      expect(plain).toEqual([
        {
          Name: '/acme/s', Type: 'SecureString', KeyId: 'alias/aws/ssm', LastModifiedDate: expect.any(Number),
          LastModifiedUser: `arn:aws:iam::${ACCOUNT}:root`, Description: 'd', Value: 'one', Version: 1,
          Labels: [], Tier: 'Standard', Policies: [], DataType: 'text',
        },
        expect.objectContaining({ Value: 'two', Version: 2 }),
      ]);
      const opaque = (await call('GetParameterHistory', { Name: '/acme/s' })).Parameters as Param[];
      expect(opaque[0].Value).not.toBe('one');

      const page = await call('GetParameterHistory', { Name: '/acme/s', MaxResults: 1 });
      expect((page.Parameters as Param[])[0].Version).toBe(1);
      const next = await call('GetParameterHistory', { Name: '/acme/s', MaxResults: 1, NextToken: page.NextToken });
      expect((next.Parameters as Param[])[0].Version).toBe(2);
      expect(next.NextToken).toBeUndefined();
    });

    it('raises ParameterNotFound for a missing parameter', async () => {
      await expectAwsError(call('GetParameterHistory', { Name: '/acme/ghost' }), 'ParameterNotFound');
    });
  });

  describe('DeleteParameter / DeleteParameters', () => {
    it('deletes one parameter and refuses a missing one', async () => {
      await put('/acme/x', '1');
      expect(await call('DeleteParameter', { Name: '/acme/x' })).toEqual({});
      await expectAwsError(get('/acme/x'), 'ParameterNotFound');
      await expectAwsError(call('DeleteParameter', { Name: '/acme/x' }), 'ParameterNotFound');
      // The name is free again: a re-create starts over at version 1.
      expect(await put('/acme/x', '2')).toEqual({ Version: 1, Tier: 'Standard' });
    });

    it('deletes in batch, splitting deleted from invalid names', async () => {
      await put('/acme/a', '1');
      await put('/acme/b', '2');
      expect(await call('DeleteParameters', { Names: ['/acme/a', '/acme/ghost', `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/acme/b`] }))
        .toEqual({ DeletedParameters: ['/acme/a', `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/acme/b`], InvalidParameters: ['/acme/ghost'] });
      expect((await call('DescribeParameters', {})).Parameters).toEqual([]);
    });
  });

  describe('tagging', () => {
    const tagInput = (extra: Record<string, unknown> = {}) => ({ ResourceType: 'Parameter', ResourceId: '/acme/x', ...extra });

    it('adds, replaces, lists and removes tags', async () => {
      await put('/acme/x', '1', { Tags: [{ Key: 'team', Value: 'orders' }] });
      expect(await call('AddTagsToResource', tagInput({ Tags: [{ Key: 'team', Value: 'payments' }, { Key: 'env', Value: 'dev' }] }))).toEqual({});
      expect(await call('ListTagsForResource', tagInput())).toEqual({
        TagList: [{ Key: 'team', Value: 'payments' }, { Key: 'env', Value: 'dev' }],
      });
      expect(await call('RemoveTagsFromResource', tagInput({ TagKeys: ['team'] }))).toEqual({});
      expect(await call('ListTagsForResource', tagInput())).toEqual({ TagList: [{ Key: 'env', Value: 'dev' }] });
      await call('RemoveTagsFromResource', tagInput());
      expect(await call('ListTagsForResource', tagInput())).toEqual({ TagList: [{ Key: 'env', Value: 'dev' }] });
    });

    it('rejects other resource types, unknown ids, empty and excessive tag sets', async () => {
      await put('/acme/x', '1');
      await expectAwsError(call('ListTagsForResource', tagInput({ ResourceType: 'Document' })), 'InvalidResourceType');
      await expectAwsError(call('ListTagsForResource', tagInput({ ResourceId: '/acme/ghost' })), 'InvalidResourceId');
      await expectAwsError(call('AddTagsToResource', tagInput({ Tags: [] })), 'ValidationException');
      await expectAwsError(call('AddTagsToResource', tagInput({ Tags: [{ Value: 'orphan' }] })), 'ValidationException');
      const tags = Array.from({ length: 51 }, (_, i) => ({ Key: `k${i}`, Value: 'v' }));
      await expectAwsError(call('AddTagsToResource', tagInput({ Tags: tags })), 'TooManyTagsError');
    });
  });
});
