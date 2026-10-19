// API Gateway (REST v1) control-plane emulator: API keys (create with the AWS
// enabled=false default, generated/provided values, includeValue(s), `name`
// (nameQuery) / customerId filters, JSON Patch updates), usage plans (throttle, quota,
// apiStages, patch paths), usage-plan keys, tagging, GetUsage, pagination and
// the in-process resolveApiKeyByValue contract. Error names and statuses are
// the ones @aws-sdk/client-api-gateway maps.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ApiGatewayEmulator } from '../../../../src/server/engine/emulators/apigateway';
import { newResourceId } from '../../../../src/server/engine/emulators/apigateway/wire';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AwsRequest, AwsResponse, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-west-2';

function makeCtx(dir: string): EngineContext {
  return {
    config: {
      port: 14566, dataDir: dir, account: '000000000000', region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
}

interface CallOptions {
  body?: unknown;
  rawBody?: string;
  query?: Record<string, string>;
  rawQuery?: string;
  region?: string;
  rawPath?: boolean;
}

interface Result {
  status: number;
  json: Record<string, unknown>;
}

type Json = Record<string, unknown>;

async function expectAwsError(promise: Promise<unknown>, code: string, status: number): Promise<AwsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  const error = caught as AwsError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  return error;
}

describe('ApiGatewayEmulator', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: ApiGatewayEmulator;

  const send = (method: string, rawPath: string, options: CallOptions = {}): Promise<AwsResponse> => {
    const body = options.rawBody !== undefined
      ? Buffer.from(options.rawBody)
      : options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body));
    const req: AwsRequest = {
      method, rawPath, query: options.query ?? {}, rawQuery: options.rawQuery, headers: {}, body,
      service: 'apigateway', region: options.region ?? REGION, requestId: 'test-request',
    };
    return emulator.handle(req);
  };
  const call = async (method: string, rawPath: string, options: CallOptions = {}): Promise<Result> => {
    const res = await send(method, rawPath, options);
    const text = res.body === undefined ? '' : res.body.toString();
    return { status: res.status, json: text ? JSON.parse(text) as Json : {} };
  };
  const createKey = async (body: Json = {}): Promise<Json> => (await call('POST', '/apikeys', { body })).json;
  const createPlan = async (body: Json = {}): Promise<Json> =>
    (await call('POST', '/usageplans', { body: { name: 'basic', ...body } })).json;
  const patch = (rawPath: string, ...patchOperations: Json[]) => call('PATCH', rawPath, { body: { patchOperations } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-apigw-'));
    ctx = makeCtx(dir);
    emulator = new ApiGatewayEmulator(ctx);
  });

  afterEach(() => {
    ctx.store.stopSweeper();
    ctx.bus.removeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('identifies as the apigateway rest emulator', () => {
    expect(emulator.service).toBe('apigateway');
  });

  describe('API keys', () => {
    it('creates a key disabled by default with a generated 40-char value and 10-char id', async () => {
      const res = await call('POST', '/apikeys', { body: { name: 'acme-partner' } });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ name: 'acme-partner', enabled: false, stageKeys: [], tags: {} });
      expect(res.json.id).toMatch(/^[a-z0-9]{10}$/);
      expect(res.json.value).toMatch(/^[A-Za-z0-9]{40}$/);
      expect(typeof res.json.createdDate).toBe('number');
      expect(res.json.createdDate).toBe(res.json.lastUpdatedDate);
      expect(res.json.createdDate as number).toBeLessThan(Date.now() / 100);
    });

    it('creates a key with every member provided', async () => {
      const key = await createKey({
        name: 'orders', description: 'orders key', enabled: true, generateDistinctId: true,
        value: 'acme-orders-key-value-0001', customerId: 'cust-1', tags: { team: 'orders' },
        stageKeys: [{ restApiId: 'api1', stageName: 'dev' }],
      });
      expect(key).toMatchObject({
        name: 'orders', description: 'orders key', enabled: true, value: 'acme-orders-key-value-0001',
        customerId: 'cust-1', tags: { team: 'orders' }, stageKeys: ['api1/dev'],
      });
    });

    it('validates create input', async () => {
      await expectAwsError(send('POST', '/apikeys', { body: { value: 'short' } }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { body: { name: 7 } }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { body: { stageKeys: 'x' } }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { body: { stageKeys: [null] } }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { body: { stageKeys: [{ restApiId: 'a', stageName: '' }] } }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { body: { tags: [] } }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { body: { tags: { a: 1 } } }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { rawBody: '{nope' }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { rawBody: '[1]' }), 'BadRequestException', 400);
      await expectAwsError(send('POST', '/apikeys', { rawBody: 'null' }), 'BadRequestException', 400);
      // Explicit nulls read as absent.
      const key = await createKey({ name: null, stageKeys: null, tags: null });
      expect(key.name).toBeUndefined();
    });

    it('rejects a duplicate value with ConflictException', async () => {
      await createKey({ value: 'acme-duplicate-value-000' });
      const err = await expectAwsError(
        send('POST', '/apikeys', { body: { value: 'acme-duplicate-value-000' } }), 'ConflictException', 409,
      );
      expect(err.message).toContain('already exists');
    });

    it('reads a key with the value only when includeValue=true', async () => {
      const key = await createKey({ name: 'reader' });
      const hidden = await call('GET', `/apikeys/${key.id}`);
      expect(hidden.status).toBe(200);
      expect(hidden.json.value).toBeUndefined();
      const shown = await call('GET', `/apikeys/${key.id}`, { query: { includeValue: 'true' } });
      expect(shown.json.value).toBe(key.value);
      await expectAwsError(send('GET', '/apikeys/missing000'), 'NotFoundException', 404);
    });

    it('lists keys with nameQuery prefix, customerId, includeValues and pagination', async () => {
      await createKey({ name: 'orders-a', customerId: 'c1' });
      await createKey({ name: 'orders-b', customerId: 'c2' });
      await createKey({ name: 'partners' });
      await createKey({});

      const all = await call('GET', '/apikeys');
      expect((all.json.item as Json[]).length).toBe(4);
      expect(all.json.position).toBeUndefined();
      expect((all.json.item as Json[])[0].value).toBeUndefined();

      const prefixed = await call('GET', '/apikeys', { query: { name: 'orders', includeValues: 'true' } });
      expect((prefixed.json.item as Json[]).map(k => k.name).sort()).toEqual(['orders-a', 'orders-b']);
      expect((prefixed.json.item as Json[])[0].value).toMatch(/^[A-Za-z0-9]{40}$/);

      const byCustomer = await call('GET', '/apikeys', { query: { customerId: 'c2' } });
      expect((byCustomer.json.item as Json[]).map(k => k.name)).toEqual(['orders-b']);

      const first = await call('GET', '/apikeys', { query: { limit: '3' } });
      expect((first.json.item as Json[]).length).toBe(3);
      expect(typeof first.json.position).toBe('string');
      const second = await call('GET', '/apikeys', { query: { limit: '3', position: first.json.position as string } });
      expect((second.json.item as Json[]).length).toBe(1);
      expect(second.json.position).toBeUndefined();

      for (const limit of ['0', '501', 'x', '1.5']) {
        await expectAwsError(send('GET', '/apikeys', { query: { limit } }), 'BadRequestException', 400);
      }
      await expectAwsError(send('GET', '/apikeys', { query: { position: '!!!' } }), 'BadRequestException', 400);
    });

    it('updates a key through patch operations', async () => {
      const key = await createKey({ name: 'old', stageKeys: [{ restApiId: 'api1', stageName: 'dev' }] });
      const res = await patch(`/apikeys/${key.id}`,
        { op: 'replace', path: '/name', value: 'new' },
        { op: 'replace', path: '/description', value: 'desc' },
        { op: 'replace', path: '/enabled', value: 'true' },
        { op: 'replace', path: '/customerId', value: 'cust' },
        { op: 'add', path: '/stages', value: 'api2/prod' },
        { op: 'add', path: '/stages', value: 'api2/prod' },
        { op: 'remove', path: '/stages', value: 'api1/dev' },
      );
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        name: 'new', description: 'desc', enabled: true, customerId: 'cust', stageKeys: ['api2/prod'],
      });
      expect(res.json.value).toBeUndefined();

      const cleared = await patch(`/apikeys/${key.id}`,
        { op: 'replace', path: '/description' },
        { op: 'replace', path: '/customerId', value: null },
        { op: 'replace', path: '/enabled', value: false },
      );
      expect(cleared.json).toMatchObject({ description: '', customerId: '', enabled: false });

      // No patchOperations at all is a no-op update.
      expect((await call('PATCH', `/apikeys/${key.id}`)).status).toBe(200);
    });

    it('rejects invalid key patches', async () => {
      const key = await createKey();
      const bad = (...ops: Json[]) => expectAwsError(
        send('PATCH', `/apikeys/${key.id}`, { body: { patchOperations: ops } }), 'BadRequestException', 400,
      );
      await bad({ op: 'replace', path: '/enabled', value: 'yes' });
      await bad({ op: 'replace', path: '/name' });
      await bad({ op: 'add', path: '/stages', value: 'no-slash' });
      const unknownPath = await bad({ op: 'replace', path: '/value', value: 'x' });
      expect(unknownPath.message).toContain("Invalid patch path '/value' specified for op 'replace'");
      await bad({ op: 'explode', path: '/name' });
      await bad(null as unknown as Json);
      await bad({ op: 'replace', path: 3 });
      await expectAwsError(
        send('PATCH', `/apikeys/${key.id}`, { body: { patchOperations: {} } }), 'BadRequestException', 400,
      );
      await expectAwsError(send('PATCH', '/apikeys/missing000', { body: {} }), 'NotFoundException', 404);
    });

    it('deletes a key with 202 and prunes it from usage plans', async () => {
      const key = await createKey();
      const other = await createKey();
      const plan = await createPlan();
      const untouched = await createPlan({ name: 'untouched' });
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: other.id, keyType: 'API_KEY' } });

      const res = await send('DELETE', `/apikeys/${key.id}`);
      expect(res.status).toBe(202);
      expect(res.body).toBeUndefined();
      await expectAwsError(send('GET', `/apikeys/${key.id}`), 'NotFoundException', 404);
      const members = await call('GET', `/usageplans/${plan.id}/keys`);
      expect((members.json.item as Json[]).map(k => k.id)).toEqual([other.id]);
      expect((await call('GET', `/usageplans/${untouched.id}/keys`)).json.item).toEqual([]);
      await expectAwsError(send('DELETE', `/apikeys/${key.id}`), 'NotFoundException', 404);
    });

    it('answers ImportApiKeys with NotImplemented', async () => {
      const err = await expectAwsError(
        send('POST', '/apikeys', { query: { mode: 'import', format: 'csv' } }), 'NotImplemented', 501,
      );
      expect(err.message).toContain('apigateway.ImportApiKeys');
    });
  });

  describe('usage plans', () => {
    it('creates a plan with stages, throttle, quota and tags', async () => {
      const res = await call('POST', '/usageplans', {
        body: {
          name: 'gold', description: 'gold tier', productCode: 'prod-1', tags: { tier: 'gold' },
          apiStages: [
            { apiId: 'api1', stage: 'dev', throttle: { '/orders/GET': { burstLimit: 5, rateLimit: 1.5 }, '/x/POST': null } },
            { apiId: 'api1', stage: 'dev' },
            { apiId: 'api2', stage: 'prod', throttle: null },
          ],
          throttle: { burstLimit: 100, rateLimit: 50.5 },
          quota: { limit: 1000, period: 'MONTH', offset: 2 },
        },
      });
      expect(res.status).toBe(201);
      expect(res.json.id).toMatch(/^[a-z0-9]{6}$/);
      expect(res.json).toMatchObject({
        name: 'gold', description: 'gold tier', productCode: 'prod-1', tags: { tier: 'gold' },
        apiStages: [
          { apiId: 'api1', stage: 'dev', throttle: { '/orders/GET': { burstLimit: 5, rateLimit: 1.5 } } },
          { apiId: 'api2', stage: 'prod' },
        ],
        throttle: { burstLimit: 100, rateLimit: 50.5 },
        quota: { limit: 1000, period: 'MONTH', offset: 2 },
      });

      const minimal = await createPlan({ quota: { limit: 10, period: 'DAY' }, throttle: { rateLimit: 1 } });
      expect(minimal.quota).toEqual({ limit: 10, period: 'DAY', offset: 0 });
      expect(minimal.throttle).toEqual({ rateLimit: 1 });
      expect(minimal.apiStages).toEqual([]);
    });

    it('validates create input', async () => {
      const bad = (body: Json) => expectAwsError(send('POST', '/usageplans', { body }), 'BadRequestException', 400);
      await bad({});
      await bad({ name: '' });
      await bad({ name: 'p', apiStages: 'x' });
      await bad({ name: 'p', apiStages: [null] });
      await bad({ name: 'p', apiStages: [{ apiId: 'a' }] });
      await bad({ name: 'p', apiStages: [{ apiId: 'a', stage: 's', throttle: [] }] });
      await bad({ name: 'p', apiStages: [{ apiId: 'a', stage: 's', throttle: 'x' }] });
      await bad({ name: 'p', throttle: [] });
      await bad({ name: 'p', throttle: { burstLimit: 1.5 } });
      await bad({ name: 'p', throttle: { rateLimit: -1 } });
      await bad({ name: 'p', throttle: { rateLimit: '1' } });
      await bad({ name: 'p', quota: 'x' });
      await bad({ name: 'p', quota: { limit: 1 } });
      await bad({ name: 'p', quota: { limit: 1, period: 'YEAR' } });
      const ok = await createPlan({ throttle: null, quota: null, apiStages: null });
      expect(ok.throttle).toBeUndefined();
    });

    it('reads, lists (keyId filter + pagination) and deletes plans', async () => {
      const key = await createKey();
      const a = await createPlan({ name: 'a' });
      const b = await createPlan({ name: 'b' });
      await createPlan({ name: 'c' });
      await call('POST', `/usageplans/${b.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });

      expect((await call('GET', `/usageplans/${a.id}`)).json).toMatchObject({ id: a.id, name: 'a' });
      await expectAwsError(send('GET', '/usageplans/missing000'), 'NotFoundException', 404);

      const all = await call('GET', '/usageplans');
      expect((all.json.item as Json[]).map(p => p.name).sort()).toEqual(['a', 'b', 'c']);
      const filtered = await call('GET', '/usageplans', { query: { keyId: key.id as string } });
      expect((filtered.json.item as Json[]).map(p => p.id)).toEqual([b.id]);
      expect((await call('GET', '/usageplans', { query: { keyId: 'ghost' } })).json.item).toEqual([]);

      const page1 = await call('GET', '/usageplans', { query: { limit: '2' } });
      const page2 = await call('GET', '/usageplans', { query: { limit: '2', position: page1.json.position as string } });
      expect([...(page1.json.item as Json[]), ...(page2.json.item as Json[])].map(p => p.name).sort()).toEqual(['a', 'b', 'c']);

      const deleted = await send('DELETE', `/usageplans/${a.id}`);
      expect(deleted.status).toBe(202);
      await expectAwsError(send('DELETE', `/usageplans/${a.id}`), 'NotFoundException', 404);
    });

    it('updates a plan through every supported patch path', async () => {
      const plan = await createPlan({ apiStages: [{ apiId: 'api1', stage: 'dev' }] });
      const res = await patch(`/usageplans/${plan.id}`,
        { op: 'replace', path: '/name', value: 'renamed' },
        { op: 'replace', path: '/description', value: 'd' },
        { op: 'replace', path: '/productCode', value: 'pc' },
        { op: 'replace', path: '/throttle/burstLimit', value: '20' },
        { op: 'replace', path: '/throttle/rateLimit', value: '2.5' },
        { op: 'replace', path: '/quota/limit', value: '500' },
        { op: 'replace', path: '/quota/offset', value: '1' },
        { op: 'replace', path: '/quota/period', value: 'WEEK' },
        { op: 'add', path: '/apiStages', value: 'api2:prod' },
        { op: 'add', path: '/apiStages', value: 'api2:prod' },
        { op: 'remove', path: '/apiStages', value: 'api1:dev' },
      );
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        name: 'renamed', description: 'd', productCode: 'pc',
        throttle: { burstLimit: 20, rateLimit: 2.5 },
        quota: { limit: 500, offset: 1, period: 'WEEK' },
        apiStages: [{ apiId: 'api2', stage: 'prod' }],
      });

      const cleared = await patch(`/usageplans/${plan.id}`,
        { op: 'replace', path: '/description' },
        { op: 'replace', path: '/productCode' },
        { op: 'remove', path: '/throttle' },
        { op: 'remove', path: '/quota' },
      );
      expect(cleared.json).toMatchObject({ description: '', productCode: '' });
      expect(cleared.json.throttle).toBeUndefined();
      expect(cleared.json.quota).toBeUndefined();
    });

    it('rejects invalid plan patches', async () => {
      const plan = await createPlan();
      const bad = (op: Json) => expectAwsError(
        send('PATCH', `/usageplans/${plan.id}`, { body: { patchOperations: [op] } }), 'BadRequestException', 400,
      );
      await bad({ op: 'replace', path: '/name' });
      await bad({ op: 'replace', path: '/throttle/burstLimit', value: '1.5' });
      await bad({ op: 'replace', path: '/throttle/rateLimit', value: '-1' });
      await bad({ op: 'replace', path: '/throttle/rateLimit', value: 'abc' });
      await bad({ op: 'replace', path: '/quota/limit', value: ' ' });
      await bad({ op: 'replace', path: '/quota/limit' });
      await bad({ op: 'replace', path: '/quota/period', value: 'YEAR' });
      await bad({ op: 'add', path: '/apiStages', value: 'no-colon' });
      await bad({ op: 'add', path: '/apiStages' });
      await bad({ op: 'replace', path: '/apiStages', value: 'a:b' });
      await bad({ op: 'remove', path: '/name' });
      await bad({ op: 'add', path: '/throttle' });
      await expectAwsError(send('PATCH', '/usageplans/missing000', { body: {} }), 'NotFoundException', 404);
    });
  });

  describe('usage plan keys', () => {
    it('adds, lists, reads and removes keys', async () => {
      const plan = await createPlan();
      const key = await createKey({ name: 'orders-key' });
      const other = await createKey({ name: 'partners-key' });

      const added = await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      expect(added.status).toBe(201);
      expect(added.json).toEqual({ id: key.id, type: 'API_KEY', name: 'orders-key', value: key.value });
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: other.id, keyType: 'API_KEY' } });

      const listed = await call('GET', `/usageplans/${plan.id}/keys`);
      expect((listed.json.item as Json[]).map(k => k.name).sort()).toEqual(['orders-key', 'partners-key']);
      const named = await call('GET', `/usageplans/${plan.id}/keys`, { query: { name: 'partners' } });
      expect((named.json.item as Json[]).map(k => k.id)).toEqual([other.id]);
      const paged = await call('GET', `/usageplans/${plan.id}/keys`, { query: { limit: '1' } });
      expect((paged.json.item as Json[]).length).toBe(1);
      expect(paged.json.position).toBeDefined();

      const one = await call('GET', `/usageplans/${plan.id}/keys/${key.id}`);
      expect(one.json).toMatchObject({ id: key.id, type: 'API_KEY', value: key.value });

      expect((await send('DELETE', `/usageplans/${plan.id}/keys/${key.id}`)).status).toBe(202);
      await expectAwsError(send('GET', `/usageplans/${plan.id}/keys/${key.id}`), 'NotFoundException', 404);
      await expectAwsError(send('DELETE', `/usageplans/${plan.id}/keys/${key.id}`), 'NotFoundException', 404);
      await expectAwsError(send('GET', `/usageplans/${plan.id}/keys/ghost00000`), 'NotFoundException', 404);
    });

    it('lists unnamed keys and matches nameQuery against an empty name', async () => {
      const plan = await createPlan();
      const key = await createKey();
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      expect((await call('GET', `/usageplans/${plan.id}/keys`, { query: { name: 'x' } })).json.item).toEqual([]);
      expect((await call('GET', '/apikeys', { query: { name: '' } })).json.item).toHaveLength(1);
    });

    it('rejects bad usage-plan-key requests with 400/404/409', async () => {
      const plan = await createPlan();
      const key = await createKey();
      const body = { keyId: key.id, keyType: 'API_KEY' };
      await expectAwsError(send('POST', '/usageplans/missing000/keys', { body }), 'NotFoundException', 404);
      await expectAwsError(send('GET', '/usageplans/missing000/keys'), 'NotFoundException', 404);
      await expectAwsError(
        send('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: 'ghost00000', keyType: 'API_KEY' } }),
        'NotFoundException', 404,
      );
      await expectAwsError(
        send('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'OTHER' } }),
        'BadRequestException', 400,
      );
      await expectAwsError(send('POST', `/usageplans/${plan.id}/keys`, { body: { keyType: 'API_KEY' } }), 'BadRequestException', 400);
      await call('POST', `/usageplans/${plan.id}/keys`, { body });
      await expectAwsError(send('POST', `/usageplans/${plan.id}/keys`, { body }), 'ConflictException', 409);
    });
  });

  describe('usage', () => {
    it('answers a well-shaped empty usage report', async () => {
      const plan = await createPlan();
      const res = await call('GET', `/usageplans/${plan.id}/usage`, {
        query: { startDate: '2026-10-01', endDate: '2026-10-18' },
      });
      expect(res.json).toEqual({ usagePlanId: plan.id, startDate: '2026-10-01', endDate: '2026-10-18', items: {} });
      await expectAwsError(send('GET', `/usageplans/${plan.id}/usage`, { query: { startDate: 'x' } }), 'BadRequestException', 400);
      await expectAwsError(send('GET', '/usageplans/missing000/usage'), 'NotFoundException', 404);
    });
  });

  describe('tags', () => {
    it('gets, adds and removes tags on keys and plans', async () => {
      const key = await createKey({ tags: { a: '1' } });
      const plan = await createPlan();
      const keyArn = encodeURIComponent(`arn:aws:apigateway:${REGION}::/apikeys/${key.id}`);
      const planArn = `arn:aws:apigateway:${REGION}::/usageplans/${plan.id}`;

      expect((await call('GET', `/tags/${keyArn}`)).json).toEqual({ tags: { a: '1' } });
      expect((await send('PUT', `/tags/${keyArn}`, { body: { tags: { b: '2', c: '3' } } })).status).toBe(204);
      expect((await send('DELETE', `/tags/${keyArn}`, { rawQuery: 'tagKeys=a&tagKeys=b' })).status).toBe(204);
      expect((await call('GET', `/tags/${keyArn}`)).json).toEqual({ tags: { c: '3' } });

      // Raw (unencoded) slashes in the ARN label split into several segments.
      await send('PUT', `/tags/${planArn}`, { body: { tags: { x: '1', y: '2' } } });
      await send('DELETE', `/tags/${planArn}`, { query: { tagKeys: 'x' } });
      expect((await call('GET', `/tags/${planArn}`)).json).toEqual({ tags: { y: '2' } });
      await send('DELETE', `/tags/${planArn}`);
      await send('PUT', `/tags/${planArn}`, {});
      expect((await call('GET', `/tags/${planArn}`)).json).toEqual({ tags: { y: '2' } });

      // An empty region segment falls back to the request region.
      expect((await call('GET', `/tags/arn:aws:apigateway:::/apikeys/${key.id}`)).json.tags).toEqual({ c: '3' });
    });

    it('answers NotFoundException for unknown or foreign resources', async () => {
      await expectAwsError(send('GET', `/tags/arn:aws:apigateway:${REGION}::/apikeys/ghost00000`), 'NotFoundException', 404);
      await expectAwsError(send('GET', `/tags/arn:aws:apigateway:${REGION}::/usageplans/ghost00000`), 'NotFoundException', 404);
      await expectAwsError(send('GET', `/tags/arn:aws:apigateway:${REGION}::/restapis/abc`), 'NotFoundException', 404);
    });
  });

  describe('routing', () => {
    it('answers every other API Gateway resource with NotImplemented', async () => {
      for (const [method, rawPath] of [
        ['GET', '/restapis'], ['POST', '/restapis/abc/deployments'], ['PUT', '/apikeys'], ['POST', '/apikeys/x'],
        ['PUT', '/usageplans'], ['POST', '/usageplans/x'], ['PATCH', '/usageplans/x/keys'], ['PATCH', '/usageplans/x/keys/y'],
        ['PATCH', '/usageplans/x/keys/y/usage'], ['POST', '/usageplans/x/usage'], ['POST', '/tags/arn'], ['GET', '/tags'],
        ['GET', '/apikeys/x/y'], ['GET', '/usageplans/x/other'],
      ]) {
        const err = await expectAwsError(send(method, rawPath), 'NotImplemented', 501);
        expect(err.message).toContain(`apigateway.${method} ${rawPath}`);
      }
    });

    it('rejects a malformed percent-encoded path', async () => {
      await expectAwsError(send('GET', '/apikeys/%E0%A4%A'), 'BadRequestException', 400);
    });

    it('keeps regions apart', async () => {
      const key = await createKey();
      await expectAwsError(send('GET', `/apikeys/${key.id}`, { region: 'eu-west-1' }), 'NotFoundException', 404);
    });
  });

  describe('resolveApiKeyByValue', () => {
    it('resolves a value to the key and the plans (with stages) holding it', async () => {
      const key = await createKey({ name: 'orders', enabled: true, value: 'acme-orders-value-000000' });
      const plan = await createPlan({ name: 'gold', apiStages: [{ apiId: 'api1', stage: 'dev', throttle: { '/a/GET': { rateLimit: 1 } } }] });
      await createPlan({ name: 'other' });
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });

      expect(await emulator.resolveApiKeyByValue(REGION, 'acme-orders-value-000000')).toEqual({
        id: key.id, name: 'orders', enabled: true,
        usagePlans: [{ id: plan.id, name: 'gold', apiStages: [{ apiId: 'api1', stage: 'dev' }] }],
      });
      expect(await emulator.resolveApiKeyByValue(REGION, 'nope')).toBeUndefined();
      expect(await emulator.resolveApiKeyByValue('eu-west-1', 'acme-orders-value-000000')).toBeUndefined();
    });

    it('returns disabled and unnamed keys as such', async () => {
      await createKey({ value: 'acme-unnamed-value-00000' });
      expect(await emulator.resolveApiKeyByValue(REGION, 'acme-unnamed-value-00000')).toMatchObject({
        name: '', enabled: false, usagePlans: [],
      });
    });
  });

  describe('corrected wire contract', () => {
    it('keeps the position cursor stable while items are deleted between pages', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) ids.push((await createKey({ name: `k${i}` })).id as string);
      ids.sort();
      const seen: string[] = [];
      let position: string | undefined;
      do {
        const page = await call('GET', '/apikeys', { query: position ? { limit: '2', position } : { limit: '2' } });
        const pageIds = (page.json.item as Json[]).map(k => k.id as string);
        seen.push(...pageIds);
        // Revoke everything handed out so far: an offset cursor would now skip.
        for (const id of pageIds) await send('DELETE', `/apikeys/${id}`);
        position = page.json.position as string | undefined;
      } while (position);
      expect(seen).toEqual(ids);
      // A cursor past the last id yields an empty final page.
      const tail = await call('GET', '/apikeys', { query: { position: Buffer.from('zzzzzzzzzz').toString('base64url') } });
      expect(tail.json).toEqual({ item: [] });
    });

    it('accepts duplicate names and enforces engine-wide value uniqueness', async () => {
      await createKey({ name: 'same', value: 'acme-value-0000000000000' });
      await createKey({ name: 'same' });
      expect((await call('GET', '/apikeys', { query: { name: 'same' } })).json.item).toHaveLength(2);
      await expectAwsError(
        send('POST', '/apikeys', { body: { value: 'acme-value-0000000000000' }, region: 'eu-west-1' }),
        'ConflictException', 409,
      );
      // Stored byte for byte.
      const odd = await createKey({ value: 'key-0f_A-b64url_value-xyz' });
      expect((await call('GET', `/apikeys/${odd.id}`, { query: { includeValue: 'true' } })).json.value).toBe('key-0f_A-b64url_value-xyz');
    });

    it('keeps plan membership when a key is disabled, idempotently', async () => {
      const key = await createKey({ name: 'k', enabled: true, value: 'acme-disable-value-00000' });
      const plan = await createPlan();
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      for (let i = 0; i < 2; i += 1) {
        const res = await patch(`/apikeys/${key.id}`, { op: 'replace', path: '/enabled', value: 'false' });
        expect([res.status, res.json.enabled]).toEqual([200, false]);
      }
      expect(await emulator.resolveApiKeyByValue(REGION, 'acme-disable-value-00000')).toMatchObject({
        enabled: false, usagePlans: [{ id: plan.id }],
      });
    });

    it('deletes a plan with keys and stages attached, keeping the keys', async () => {
      const key = await createKey({ value: 'acme-plan-delete-value-0' });
      const plan = await createPlan({ apiStages: [{ apiId: 'api1', stage: 'dev' }] });
      const other = await createPlan({ name: 'other' });
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      await call('POST', `/usageplans/${other.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      expect((await send('DELETE', `/usageplans/${plan.id}`)).status).toBe(202);
      expect((await emulator.resolveApiKeyByValue(REGION, 'acme-plan-delete-value-0'))?.usagePlans).toEqual([
        { id: other.id, name: 'other', apiStages: [] },
      ]);
      await send('DELETE', `/usageplans/${other.id}`);
      expect((await call('GET', '/usageplans', { query: { keyId: key.id as string } })).json.item).toEqual([]);
      expect((await call('GET', `/apikeys/${key.id}`)).status).toBe(200);
    });

    it('wipes every region with resetState', async () => {
      await createKey({ value: 'acme-reset-value-0000000' });
      await call('POST', '/apikeys', { body: {}, region: 'eu-west-1' });
      const plan = await createPlan();
      await emulator.resetState();
      expect((await call('GET', '/apikeys')).json.item).toEqual([]);
      expect((await call('GET', '/apikeys', { region: 'eu-west-1' })).json.item).toEqual([]);
      await expectAwsError(send('GET', `/usageplans/${plan.id}`), 'NotFoundException', 404);
      expect(await emulator.resolveApiKeyByValue(REGION, 'acme-reset-value-0000000')).toBeUndefined();
      // The value is free again.
      expect((await call('POST', '/apikeys', { body: { value: 'acme-reset-value-0000000' } })).status).toBe(201);
    });

    it('rebuilds the indexes of every known region after a restart', async () => {
      const key = await createKey({ value: 'acme-reopen-value-000000' });
      const plan = await createPlan();
      await call('POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      await call('POST', '/apikeys', { body: { value: 'acme-reopen-eu-value-000' }, region: 'eu-west-1' });
      await ctx.store.flushAll();

      const store = createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false });
      const reopened = new ApiGatewayEmulator({ ...ctx, store });
      // A value from a region not touched since the restart still conflicts.
      await expectAwsError(reopened.handle({
        method: 'POST', rawPath: '/apikeys', query: {}, headers: {}, service: 'apigateway', region: REGION,
        requestId: 'r', body: Buffer.from(JSON.stringify({ value: 'acme-reopen-eu-value-000' })),
      }), 'ConflictException', 409);
      expect((await reopened.resolveApiKeyByValue(REGION, 'acme-reopen-value-000000'))?.usagePlans).toEqual([
        { id: plan.id, name: 'basic', apiStages: [] },
      ]);
      store.stopSweeper();
    });

    it('shares one region open between concurrent first requests', async () => {
      const [a, b] = await Promise.all([
        call('POST', '/apikeys', { body: { value: 'acme-concurrent-value-01' } }),
        call('POST', '/apikeys', { body: { value: 'acme-concurrent-value-02' } }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(await emulator.resolveApiKeyByValue(REGION, 'acme-concurrent-value-01')).toBeDefined();
      expect(await emulator.resolveApiKeyByValue(REGION, 'acme-concurrent-value-02')).toBeDefined();
    });
  });

  it('draws a fresh id when the first one is taken', () => {
    let checks = 0;
    const id = newResourceId(6, () => checks++ === 0);
    expect(id).toMatch(/^[a-z0-9]{6}$/);
    expect(checks).toBe(2);
  });

  it('persists catalogs across emulator instances', async () => {
    const key = await createKey({ name: 'kept' });
    await ctx.store.flushAll();
    const reopened = new ApiGatewayEmulator({ ...ctx, store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }) });
    const res = await reopened.handle({
      method: 'GET', rawPath: `/apikeys/${key.id}`, query: {}, headers: {}, body: Buffer.alloc(0),
      service: 'apigateway', region: REGION, requestId: 'r',
    });
    expect(JSON.parse(String(res.body)).name).toBe('kept');
  });
});
