// OpenSearch Serverless control plane (AWS JSON 1.0 via X-Amz-Target):
// collection lifecycle, the exact error names the provisioner's idempotency
// branches on (ConflictException / ResourceNotFoundException), and the
// collectionEndpoint contract the data plane serves under.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenSearchEmulator } from '../../../../src/server/engine/emulators/opensearch';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AwsRequest, AwsResponse, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-east-1';
const ACCOUNT = '000000000000';
const ENDPOINT = 'http://127.0.0.1:14566';

function makeCtx(): { ctx: EngineContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-aoss-emulator-'));
  const ctx: EngineContext = {
    config: {
      port: 14566, dataDir: dir, account: ACCOUNT, region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => ENDPOINT,
  };
  return { ctx, dir };
}

function controlReq(operation: string, input: unknown, body?: Buffer): AwsRequest {
  return {
    method: 'POST',
    rawPath: '/',
    query: {},
    headers: { 'x-amz-target': `OpenSearchServerless.${operation}` },
    body: body ?? Buffer.from(JSON.stringify(input), 'utf8'),
    service: 'aoss',
    region: REGION,
    requestId: 'test-request',
  };
}

function parseBody(response: AwsResponse): any {
  return JSON.parse(String(response.body));
}

async function expectAwsError(promise: Promise<unknown>, code: string, message: RegExp): Promise<AwsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  const error = caught as AwsError;
  expect(error.code).toBe(code);
  expect(error.message).toMatch(message);
  return error;
}

describe('OpenSearchEmulator control plane', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: OpenSearchEmulator;
  const call = (operation: string, input: unknown = {}) => emulator.handle(controlReq(operation, input));

  beforeEach(() => {
    ({ ctx, dir } = makeCtx());
    emulator = new OpenSearchEmulator(ctx);
  });

  afterEach(async () => {
    ctx.store.stopSweeper();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('router contract: the service name is the aoss SigV4 scope', () => {
    expect(emulator.service).toBe('aoss');
  });

  test('CreateCollection answers ACTIVE immediately with a deterministic id and aoss ARN', async () => {
    const response = await call('CreateCollection', { name: 'products', type: 'SEARCH', description: 'catalog' });
    expect(response.status).toBe(200);
    expect(response.headers?.['content-type']).toBe('application/x-amz-json-1.0');
    const detail = parseBody(response).createCollectionDetail;
    expect(detail.name).toBe('products');
    expect(detail.type).toBe('SEARCH');
    expect(detail.description).toBe('catalog');
    expect(detail.status).toBe('ACTIVE');
    expect(detail.id).toMatch(/^[0-9a-f]{20}$/);
    expect(detail.arn).toBe(`arn:aws:aoss:${REGION}:${ACCOUNT}:collection/${detail.id}`);

    // Deterministic: a second emulator over the same config derives the same id.
    const again = parseBody(await call('BatchGetCollection', { names: ['products'] }));
    expect(again.collectionDetails[0].id).toBe(detail.id);
  });

  test('CreateCollection defaults the type to TIMESERIES', async () => {
    const response = parseBody(await call('CreateCollection', { name: 'metrics' }));
    expect(response.createCollectionDetail.type).toBe('TIMESERIES');
    expect(response.createCollectionDetail.description).toBeUndefined();
  });

  test('CreateCollection validates the AOSS naming rule', async () => {
    await expectAwsError(call('CreateCollection', { name: 'Bad_Name' }), 'ValidationException', /Collection name/);
    await expectAwsError(call('CreateCollection', { name: 'ab' }), 'ValidationException', /Collection name/);
    await expectAwsError(call('CreateCollection', {}), 'ValidationException', /Collection name/);
  });

  test('CreateCollection rejects unknown types', async () => {
    await expectAwsError(
      call('CreateCollection', { name: 'products', type: 'FULLTEXT' }),
      'ValidationException',
      /SEARCH, TIMESERIES, VECTORSEARCH/,
    );
  });

  test('duplicate CreateCollection fails with the ConflictException the provisioner swallows', async () => {
    await call('CreateCollection', { name: 'products' });
    const error = await expectAwsError(
      call('CreateCollection', { name: 'products' }),
      'ConflictException',
      /already exists/,
    );
    expect(error.status).toBe(409);
  });

  test('BatchGetCollection by names returns endpoints and NOT_FOUND error details', async () => {
    await call('CreateCollection', { name: 'products' });
    const body = parseBody(await call('BatchGetCollection', { names: ['products', 'ghost'] }));
    expect(body.collectionDetails).toHaveLength(1);
    expect(body.collectionDetails[0].collectionEndpoint).toBe(`${ENDPOINT}/_aoss/products`);
    expect(body.collectionDetails[0].dashboardEndpoint).toBe(`${ENDPOINT}/_aoss/products/_dashboards`);
    expect(body.collectionErrorDetails).toEqual([
      { name: 'ghost', errorCode: 'NOT_FOUND', errorMessage: 'Collection ghost not found.' },
    ]);
  });

  test('BatchGetCollection by ids resolves the same records', async () => {
    const created = parseBody(await call('CreateCollection', { name: 'products' })).createCollectionDetail;
    const body = parseBody(await call('BatchGetCollection', { ids: [created.id, 'nope'] }));
    expect(body.collectionDetails[0].name).toBe('products');
    expect(body.collectionErrorDetails).toEqual([
      { id: 'nope', errorCode: 'NOT_FOUND', errorMessage: 'Collection nope not found.' },
    ]);
  });

  test('BatchGetCollection requires exactly one of names or ids', async () => {
    await expectAwsError(call('BatchGetCollection', {}), 'ValidationException', /names or ids/);
    await expectAwsError(
      call('BatchGetCollection', { names: ['a'], ids: ['b'] }),
      'ValidationException',
      /names or ids/,
    );
  });

  test('ListCollections returns ACTIVE summaries', async () => {
    await call('CreateCollection', { name: 'products' });
    await call('CreateCollection', { name: 'metrics' });
    const body = parseBody(await call('ListCollections'));
    expect(body.collectionSummaries.map((s: any) => s.name).sort()).toEqual(['metrics', 'products']);
    expect(body.collectionSummaries[0].status).toBe('ACTIVE');
  });

  test('DeleteCollection accepts the id (AOSS contract) and the name (cleanup convenience)', async () => {
    const created = parseBody(await call('CreateCollection', { name: 'products' })).createCollectionDetail;
    const byId = parseBody(await call('DeleteCollection', { id: created.id }));
    expect(byId.deleteCollectionDetail).toEqual({ id: created.id, name: 'products', status: 'DELETING' });

    await call('CreateCollection', { name: 'metrics' });
    const byName = parseBody(await call('DeleteCollection', { id: 'metrics' }));
    expect(byName.deleteCollectionDetail.name).toBe('metrics');
    expect(parseBody(await call('ListCollections')).collectionSummaries).toEqual([]);
  });

  test('DeleteCollection on an unknown id is a 404 ResourceNotFoundException', async () => {
    const error = await expectAwsError(call('DeleteCollection', { id: 'ghost' }), 'ResourceNotFoundException', /ghost/);
    expect(error.status).toBe(404);
  });

  test('DeleteCollection drops the collection indices and their documents', async () => {
    await call('CreateCollection', { name: 'products' });
    const put = await emulator.handle({
      ...controlReq('ignored', {}),
      headers: {},
      method: 'PUT',
      rawPath: '/_aoss/products/items/_doc/1',
      body: Buffer.from('{"a":1}', 'utf8'),
    });
    expect(put.status).toBe(201);

    await call('DeleteCollection', { id: 'products' });
    await call('CreateCollection', { name: 'products' });
    const search = await emulator.handle({
      ...controlReq('ignored', {}),
      headers: {},
      method: 'GET',
      rawPath: '/_aoss/products/_search',
      body: Buffer.alloc(0),
    });
    expect(JSON.parse(String(search.body)).hits.total.value).toBe(0);
  });

  test('unknown control-plane operations fail loudly with NotImplemented', async () => {
    await expectAwsError(call('UpdateCollection', { id: 'x' }), 'NotImplemented', /aoss\.UpdateCollection/);
  });

  test('a malformed JSON body is a SerializationException', async () => {
    await expectAwsError(
      emulator.handle(controlReq('ListCollections', {}, Buffer.from('{nope', 'utf8'))),
      'SerializationException',
      /JSON/,
    );
  });
});
