// OpenSearch data plane under /_aoss/<collection>: index lifecycle, document
// CRUD (_doc/_create/_update), _bulk NDJSON, _mapping, _refresh, _cat/indices,
// endpoint-level _search/_count plumbing (pagination, q=, _source, aggs) and
// the OpenSearch-shaped error contract ({"error": {...}, "status": N}).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenSearchEmulator } from '../../../../src/server/engine/emulators/opensearch';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AwsRequest, AwsResponse, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-east-1';

function makeCtx(): { ctx: EngineContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-aoss-data-'));
  const ctx: EngineContext = {
    config: {
      port: 14566, dataDir: dir, account: '000000000000', region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
  return { ctx, dir };
}

describe('OpenSearchEmulator data plane', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: OpenSearchEmulator;

  const rest = (method: string, rawPath: string, body?: unknown, query: Record<string, string> = {}) =>
    emulator.handle({
      method,
      rawPath,
      query,
      headers: {},
      body: body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
      service: 'aoss',
      region: REGION,
      requestId: 'test-request',
    } satisfies AwsRequest);

  const json = (response: AwsResponse): any => JSON.parse(String(response.body));

  const createCollection = (name: string) =>
    emulator.handle({
      method: 'POST', rawPath: '/', query: {},
      headers: { 'x-amz-target': 'OpenSearchServerless.CreateCollection' },
      body: Buffer.from(JSON.stringify({ name }), 'utf8'),
      service: 'aoss', region: REGION, requestId: 'test-request',
    });

  beforeEach(async () => {
    ({ ctx, dir } = makeCtx());
    emulator = new OpenSearchEmulator(ctx);
    await createCollection('products');
  });

  afterEach(() => {
    ctx.store.stopSweeper();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('routing boundaries', () => {
    test('requests outside /_aoss fail with guidance toward the collection endpoint', async () => {
      await expect(rest('POST', '/items/_search', {})).rejects.toMatchObject({
        code: 'ValidationException',
        status: 404,
        message: expect.stringContaining('/_aoss/<collection>'),
      });
      await expect(rest('GET', '/_aoss')).rejects.toBeInstanceOf(AwsError);
    });

    test('an unknown collection is an OpenSearch-shaped 404', async () => {
      const response = await rest('GET', '/_aoss/ghost/_search');
      expect(response.status).toBe(404);
      const body = json(response);
      expect(body.status).toBe(404);
      expect(body.error.type).toBe('collection_not_found_exception');
      expect(body.error.root_cause[0].type).toBe('collection_not_found_exception');
    });

    test('the collection root answers the OpenSearch info handshake', async () => {
      expect((await rest('HEAD', '/_aoss/products')).status).toBe(200);
      const info = json(await rest('GET', '/_aoss/products'));
      expect(info.version.distribution).toBe('opensearch');
      expect(info.cluster_name).toBe('products');
    });

    test('unsupported routes fail loudly, naming the request', async () => {
      const response = await rest('POST', '/_aoss/products/items/_close');
      expect(response.status).toBe(400);
      expect(json(response).error.reason).toContain('POST /_aoss/products/items/_close');
      const rootPatch = await rest('PATCH', '/_aoss/products');
      expect(json(rootPatch).error.type).toBe('illegal_argument_exception');
      const underscore = await rest('POST', '/_aoss/products/_snapshot');
      expect(json(underscore).error.type).toBe('illegal_argument_exception');
      const badIndexMethod = await rest('PATCH', '/_aoss/products/items');
      expect(badIndexMethod.status).toBe(400);
      const badDocMethod = await rest('PATCH', '/_aoss/products/items/_doc/1');
      expect(badDocMethod.status).toBe(400);
      const badMappingMethod = await rest('DELETE', '/_aoss/products/items/_mapping');
      expect(badMappingMethod.status).toBe(400);
    });
  });

  describe('index lifecycle', () => {
    test('PUT creates an index storing mappings and settings verbatim', async () => {
      const mappings = { properties: { name: { type: 'text' } } };
      const created = await rest('PUT', '/_aoss/products/items', { mappings, settings: { 'index.knn': false } });
      expect(created.status).toBe(200);
      expect(json(created)).toEqual({ acknowledged: true, shards_acknowledged: true, index: 'items' });

      const got = json(await rest('GET', '/_aoss/products/items'));
      expect(got.items.mappings).toEqual(mappings);
      expect(got.items.settings).toEqual({ 'index.knn': false });
      expect((await rest('HEAD', '/_aoss/products/items')).status).toBe(200);
    });

    test('duplicate index creation is a 400 resource_already_exists_exception', async () => {
      await rest('PUT', '/_aoss/products/items');
      const dup = await rest('PUT', '/_aoss/products/items');
      expect(dup.status).toBe(400);
      expect(json(dup).error.type).toBe('resource_already_exists_exception');
    });

    test('invalid index names are rejected', async () => {
      for (const bad of ['Bad', '.hidden', 'has space', '_all']) {
        const response = await rest('PUT', `/_aoss/products/${encodeURIComponent(bad)}`);
        expect(response.status).toBe(400);
        expect(json(response).error.type).toBe('invalid_index_name_exception');
      }
      // Underscore-prefixed segments are the collection-API namespace, so they
      // never reach index creation.
      const api = await rest('PUT', '/_aoss/products/_internal');
      expect(json(api).error.type).toBe('illegal_argument_exception');
    });

    test('DELETE removes the index and its documents; missing index is a 404', async () => {
      await rest('PUT', '/_aoss/products/items/_doc/1', { a: 1 });
      expect(json(await rest('DELETE', '/_aoss/products/items'))).toEqual({ acknowledged: true });
      expect((await rest('HEAD', '/_aoss/products/items')).status).toBe(404);
      const missing = await rest('DELETE', '/_aoss/products/items');
      expect(missing.status).toBe(404);
      expect(json(missing).error.type).toBe('index_not_found_exception');
      const getMissing = await rest('GET', '/_aoss/products/items');
      expect(getMissing.status).toBe(404);
      // The documents were destroyed with the index — recreating the same
      // index must NOT resurrect them from a leftover table file.
      await rest('PUT', '/_aoss/products/items');
      expect(json(await rest('GET', '/_aoss/products/items/_doc/1'))).toMatchObject({ found: false });
    });

    test('_mapping GET returns and PUT merges properties', async () => {
      await rest('PUT', '/_aoss/products/items', { mappings: { properties: { name: { type: 'text' } } } });
      await rest('PUT', '/_aoss/products/items/_mapping', { properties: { price: { type: 'float' } } });
      const mapping = json(await rest('GET', '/_aoss/products/items/_mapping'));
      expect(mapping.items.mappings.properties).toEqual({
        name: { type: 'text' },
        price: { type: 'float' },
      });
      const missing = await rest('GET', '/_aoss/products/ghost/_mapping');
      expect(missing.status).toBe(404);
      const putMissing = await rest('PUT', '/_aoss/products/ghost/_mapping', { properties: {} });
      expect(putMissing.status).toBe(404);
    });

    test('_cat/indices lists per-index document counts', async () => {
      await rest('PUT', '/_aoss/products/items/_doc/1', { a: 1 });
      await rest('PUT', '/_aoss/products/reviews/_doc/1', { b: 2 });
      const rows = json(await rest('GET', '/_aoss/products/_cat/indices'));
      expect(rows.map((row: any) => [row.index, row['docs.count']])).toEqual([
        ['items', '1'],
        ['reviews', '1'],
      ]);
    });

    test('_refresh is acknowledged at both collection and index level', async () => {
      await rest('PUT', '/_aoss/products/items');
      expect(json(await rest('POST', '/_aoss/products/_refresh'))._shards.successful).toBe(1);
      expect(json(await rest('POST', '/_aoss/products/items/_refresh'))._shards.successful).toBe(1);
    });
  });

  describe('document CRUD', () => {
    test('PUT _doc creates (201) then updates (200) bumping the version', async () => {
      const created = await rest('PUT', '/_aoss/products/items/_doc/1', { name: 'mouse' });
      expect(created.status).toBe(201);
      expect(json(created)).toMatchObject({ _index: 'items', _id: '1', _version: 1, result: 'created' });

      const updated = await rest('PUT', '/_aoss/products/items/_doc/1', { name: 'keyboard' });
      expect(updated.status).toBe(200);
      expect(json(updated)).toMatchObject({ _version: 2, result: 'updated' });

      const got = json(await rest('GET', '/_aoss/products/items/_doc/1'));
      expect(got).toMatchObject({ found: true, _version: 2, _source: { name: 'keyboard' } });
    });

    test('indexing auto-creates the index, like OpenSearch defaults', async () => {
      const created = await rest('POST', '/_aoss/products/fresh/_doc', { any: true });
      expect(created.status).toBe(201);
      expect(json(created)._id).toMatch(/[0-9a-f-]{36}/);
      expect((await rest('HEAD', '/_aoss/products/fresh')).status).toBe(200);
    });

    test('malformed, non-object and empty bodies are mapper_parsing_exception', async () => {
      const bad = await rest('PUT', '/_aoss/products/items/_doc/1', '{nope');
      expect(bad.status).toBe(400);
      expect(json(bad).error.type).toBe('mapper_parsing_exception');
      const array = await rest('PUT', '/_aoss/products/items/_doc/1', '[1]');
      expect(array.status).toBe(400);
      const empty = await rest('PUT', '/_aoss/products/items/_doc/1');
      expect(empty.status).toBe(400);
      expect(json(empty).error.reason).toContain('request body is required');
    });

    test('GET/HEAD/DELETE distinguish missing docs from missing indexes', async () => {
      await rest('PUT', '/_aoss/products/items/_doc/1', { a: 1 });
      const missingDoc = await rest('GET', '/_aoss/products/items/_doc/2');
      expect(missingDoc.status).toBe(404);
      expect(json(missingDoc)).toEqual({ _index: 'items', _id: '2', found: false });
      expect((await rest('HEAD', '/_aoss/products/items/_doc/1')).status).toBe(200);
      expect((await rest('HEAD', '/_aoss/products/items/_doc/2')).status).toBe(404);
      expect((await rest('HEAD', '/_aoss/products/ghost/_doc/1')).status).toBe(404);

      const missingIndex = await rest('GET', '/_aoss/products/ghost/_doc/1');
      expect(missingIndex.status).toBe(404);
      expect(json(missingIndex).error.type).toBe('index_not_found_exception');
      const deleteMissingIndex = await rest('DELETE', '/_aoss/products/ghost/_doc/1');
      expect(json(deleteMissingIndex).error.type).toBe('index_not_found_exception');

      const deleted = await rest('DELETE', '/_aoss/products/items/_doc/1');
      expect(json(deleted)).toMatchObject({ result: 'deleted' });
      const again = await rest('DELETE', '/_aoss/products/items/_doc/1');
      expect(again.status).toBe(404);
      expect(json(again)).toMatchObject({ result: 'not_found' });
    });

    test('_create is create-only: a second write is a 409 version conflict', async () => {
      expect((await rest('PUT', '/_aoss/products/items/_create/1', { a: 1 })).status).toBe(201);
      const conflict = await rest('POST', '/_aoss/products/items/_create/1', { a: 2 });
      expect(conflict.status).toBe(409);
      expect(json(conflict).error.type).toBe('version_conflict_engine_exception');
    });

    test('_update deep-merges objects and replaces scalars/arrays', async () => {
      await rest('PUT', '/_aoss/products/items/_doc/1', {
        name: 'mouse', specs: { dpi: 800, wireless: false }, tags: ['a'],
      });
      const updated = await rest('POST', '/_aoss/products/items/_update/1', {
        doc: { specs: { dpi: 1600 }, tags: ['b', 'c'] },
      });
      expect(json(updated)).toMatchObject({ _version: 2, result: 'updated' });
      const got = json(await rest('GET', '/_aoss/products/items/_doc/1'));
      expect(got._source).toEqual({
        name: 'mouse', specs: { dpi: 1600, wireless: false }, tags: ['b', 'c'],
      });
    });

    test('_update honors doc_as_upsert and upsert; otherwise a missing doc is a 404', async () => {
      await rest('PUT', '/_aoss/products/items');
      const missing = await rest('POST', '/_aoss/products/items/_update/1', { doc: { a: 1 } });
      expect(missing.status).toBe(404);
      expect(json(missing).error.type).toBe('document_missing_exception');

      const upserted = await rest('POST', '/_aoss/products/items/_update/1', {
        doc: { a: 1 }, doc_as_upsert: true,
      });
      expect(upserted.status).toBe(201);

      const viaUpsert = await rest('POST', '/_aoss/products/items/_update/2', {
        doc: { ignored: true }, upsert: { b: 2 },
      });
      expect(json(viaUpsert)).toMatchObject({ result: 'created' });
      expect(json(await rest('GET', '/_aoss/products/items/_doc/2'))._source).toEqual({ b: 2 });
    });

    test('_update rejects scripts and bodies without doc; missing index is a 404', async () => {
      await rest('PUT', '/_aoss/products/items/_doc/1', { a: 1 });
      const scripted = await rest('POST', '/_aoss/products/items/_update/1', {
        script: { source: 'ctx._source.a++' },
      });
      expect(scripted.status).toBe(400);
      expect(json(scripted).error.reason).toContain('scripted updates');
      const noDoc = await rest('POST', '/_aoss/products/items/_update/1', {});
      expect(json(noDoc).error.type).toBe('x_content_parse_exception');
      const noIndex = await rest('POST', '/_aoss/products/ghost/_update/1', { doc: {} });
      expect(json(noIndex).error.type).toBe('index_not_found_exception');
    });
  });

  describe('_bulk', () => {
    const ndjson = (...lines: unknown[]) => lines.map(line => JSON.stringify(line)).join('\n') + '\n';

    test('mixed index/create/update/delete actions report per-item results', async () => {
      await rest('PUT', '/_aoss/products/items/_doc/existing', { keep: true });
      const response = await rest('POST', '/_aoss/products/_bulk', ndjson(
        { index: { _index: 'items', _id: '1' } }, { name: 'mouse' },
        { create: { _index: 'items', _id: '2' } }, { name: 'keyboard' },
        { update: { _index: 'items', _id: 'existing' } }, { doc: { keep: false } },
        { delete: { _index: 'items', _id: 'ghost' } },
      ));
      const body = json(response);
      // A delete of a missing doc reports 404 in its slot but is NOT an error.
      expect(body.errors).toBe(false);
      expect(body.items).toHaveLength(4);
      expect(body.items[0].index).toMatchObject({ _id: '1', status: 201, result: 'created' });
      expect(body.items[1].create).toMatchObject({ _id: '2', status: 201 });
      expect(body.items[2].update).toMatchObject({ _id: 'existing', status: 200, result: 'updated' });
      expect(body.items[3].delete).toMatchObject({ _id: 'ghost', status: 404, result: 'not_found' });
    });

    test('numeric _ids are coerced to strings; update/delete without _id are rejected', async () => {
      const body = json(await rest('POST', '/_aoss/products/items/_bulk', ndjson(
        { index: { _id: 123 } }, { name: 'mouse' },
      )));
      expect(body.items[0].index).toMatchObject({ _id: '123', status: 201 });
      expect(json(await rest('GET', '/_aoss/products/items/_doc/123'))).toMatchObject({ found: true });

      const noIdUpdate = await rest('POST', '/_aoss/products/items/_bulk', ndjson({ update: {} }, { doc: {} }));
      expect(noIdUpdate.status).toBe(400);
      expect(json(noIdUpdate).error.reason).toContain('requires an _id');
      const noIdDelete = await rest('POST', '/_aoss/products/items/_bulk', ndjson({ delete: {} }));
      expect(noIdDelete.status).toBe(400);
    });

    test('the index-scoped _bulk uses the path index as the default and errors flag stays false on success', async () => {
      const response = await rest('POST', '/_aoss/products/items/_bulk', ndjson(
        { index: { _id: '1' } }, { name: 'mouse' },
        { create: {} }, { name: 'auto-id' },
      ));
      const body = json(response);
      expect(body.errors).toBe(false);
      expect(body.items[0].index._index).toBe('items');
      expect(body.items[1].create.status).toBe(201);
    });

    test('collection-level actions without _index are per-item errors', async () => {
      const body = json(await rest('POST', '/_aoss/products/_bulk', ndjson(
        { index: { _id: '1' } }, { a: 1 },
      )));
      expect(body.errors).toBe(true);
      expect(body.items[0].index.status).toBe(400);
      expect(body.items[0].index.error.reason).toContain('no index specified');
    });

    test('per-item OsErrors (create conflict) land in the item, not the request', async () => {
      await rest('PUT', '/_aoss/products/items/_doc/1', { a: 1 });
      const body = json(await rest('POST', '/_aoss/products/items/_bulk', ndjson(
        { create: { _id: '1' } }, { a: 2 },
      )));
      expect(body.errors).toBe(true);
      expect(body.items[0].create.status).toBe(409);
      expect(body.items[0].create.error.type).toBe('version_conflict_engine_exception');
    });

    test('malformed payloads are request-level 400s', async () => {
      const badJson = await rest('POST', '/_aoss/products/items/_bulk', '{nope\n');
      expect(badJson.status).toBe(400);
      const badOp = await rest('POST', '/_aoss/products/items/_bulk', ndjson({ upsert: {} }, {}));
      expect(json(badOp).error.reason).toContain('expected index, create, update or delete');
      const missingDoc = await rest('POST', '/_aoss/products/items/_bulk', ndjson({ index: { _id: '1' } }));
      expect(json(missingDoc).error.reason).toContain('missing its document line');
      const empty = await rest('POST', '/_aoss/products/items/_bulk', '\n');
      expect(json(empty).error.reason).toContain('at least one action');
    });
  });

  describe('_search and _count plumbing', () => {
    beforeEach(async () => {
      await rest('POST', '/_aoss/products/items/_bulk', [
        JSON.stringify({ index: { _id: '1' } }), JSON.stringify({ name: 'wireless mouse', price: 25, category: 'peripherals' }),
        JSON.stringify({ index: { _id: '2' } }), JSON.stringify({ name: 'mechanical keyboard', price: 90, category: 'peripherals' }),
        JSON.stringify({ index: { _id: '3' } }), JSON.stringify({ name: 'usb hub', price: 15, category: 'accessories' }),
      ].join('\n') + '\n');
      await rest('PUT', '/_aoss/products/reviews/_doc/r1', { stars: 5, name: 'great mouse' });
    });

    test('an empty search is match_all with size 10 and constant scores', async () => {
      const body = json(await rest('GET', '/_aoss/products/items/_search'));
      expect(body.hits.total).toEqual({ value: 3, relation: 'eq' });
      expect(body.hits.max_score).toBe(1);
      expect(body.hits.hits.map((h: any) => h._id)).toEqual(['1', '2', '3']);
      expect(body.hits.hits[0]._index).toBe('items');
    });

    test('query + sort + from/size + _source filtering compose', async () => {
      const body = json(await rest('POST', '/_aoss/products/items/_search', {
        query: { match: { category: 'peripherals' } },
        sort: [{ price: 'desc' }],
        from: 0,
        size: 1,
        _source: ['name'],
      }));
      expect(body.hits.total.value).toBe(2);
      expect(body.hits.hits).toHaveLength(1);
      expect(body.hits.hits[0]._source).toEqual({ name: 'mechanical keyboard' });
    });

    test('aggregations run over all matches, not the page', async () => {
      const body = json(await rest('POST', '/_aoss/products/items/_search', {
        size: 1,
        aggs: {
          by_category: { terms: { field: 'category' } },
          avg_price: { avg: { field: 'price' } },
        },
      }));
      expect(body.aggregations.by_category.buckets).toEqual([
        { key: 'peripherals', doc_count: 2 },
        { key: 'accessories', doc_count: 1 },
      ]);
      expect(body.aggregations.avg_price.value).toBeCloseTo((25 + 90 + 15) / 3);
    });

    test('collection-level _search spans all indices; comma and wildcard patterns resolve', async () => {
      const all = json(await rest('GET', '/_aoss/products/_search'));
      expect(all.hits.total.value).toBe(4);

      const both = json(await rest('GET', '/_aoss/products/items,reviews/_search'));
      expect(both.hits.total.value).toBe(4);

      const wildcard = json(await rest('GET', '/_aoss/products/rev*/_search'));
      expect(wildcard.hits.total.value).toBe(1);

      const catchAll = json(await rest('GET', '/_aoss/products/_all/_search'));
      expect(catchAll.hits.total.value).toBe(4);

      const noMatchWildcard = json(await rest('GET', '/_aoss/products/zzz*/_search'));
      expect(noMatchWildcard.hits.total.value).toBe(0);
    });

    test('a concrete missing index in the pattern is a 404', async () => {
      const response = await rest('GET', '/_aoss/products/ghost/_search');
      expect(response.status).toBe(404);
      expect(json(response).error.type).toBe('index_not_found_exception');
    });

    test('"?" in index expressions is a literal, never a regex quantifier', async () => {
      // A leading '?' with a wildcard must not crash regex compilation.
      const leading = json(await rest('GET', `/_aoss/products/${encodeURIComponent('?*')}/_search`));
      expect(leading.hits.total.value).toBe(0);
      // An embedded '?' does not act as an optional quantifier ("it?ems*"
      // would otherwise match "items").
      const embedded = json(await rest('GET', `/_aoss/products/${encodeURIComponent('it?ems')}*/_search`));
      expect(embedded.hits.total.value).toBe(0);
    });

    test('scroll and PIT requests are rejected loudly instead of silently truncating', async () => {
      const byParam = await rest('POST', '/_aoss/products/items/_search', {}, { scroll: '1m' });
      expect(byParam.status).toBe(400);
      expect(json(byParam).error.reason).toContain('scroll');
      const byBody = await rest('POST', '/_aoss/products/items/_search', { pit: { id: 'x' } });
      expect(byBody.status).toBe(400);
    });

    test('null range bounds are ignored, not coerced to 0', async () => {
      const body = json(await rest('POST', '/_aoss/products/items/_search', {
        query: { range: { price: { lte: null, gte: 20 } } },
      }));
      expect(body.hits.total.value).toBe(2); // 25 and 90 — lte:null ignored
    });

    test('?q= supports bare text and field:value; combining q with a body query is rejected', async () => {
      const text = json(await rest('GET', '/_aoss/products/items/_search', undefined, { q: 'mouse' }));
      expect(text.hits.total.value).toBe(1);

      const pair = json(await rest('GET', '/_aoss/products/items/_search', undefined, { q: 'category:accessories' }));
      expect(pair.hits.hits[0]._id).toBe('3');

      const both = await rest('POST', '/_aoss/products/items/_search', { query: { match_all: {} } }, { q: 'x' });
      expect(both.status).toBe(400);
    });

    test('size/from also come from the query string; junk values fall back', async () => {
      const sized = json(await rest('GET', '/_aoss/products/items/_search', undefined, { size: '1', from: '1' }));
      expect(sized.hits.hits.map((h: any) => h._id)).toEqual(['2']);
      const junk = json(await rest('GET', '/_aoss/products/items/_search', undefined, { size: '-2', from: 'NaN' }));
      expect(junk.hits.hits).toHaveLength(3);
    });

    test('unsupported query operators are loud 400s', async () => {
      const response = await rest('POST', '/_aoss/products/items/_search', {
        query: { fuzzy: { name: 'mouse' } },
      });
      expect(response.status).toBe(400);
      expect(json(response).error.type).toBe('search_phase_execution_exception');
      expect(json(response).error.reason).toContain('"fuzzy" query is not supported');
    });

    test('_source: false omits sources; invalid _source specs are 400', async () => {
      const none = json(await rest('POST', '/_aoss/products/items/_search', { _source: false, size: 1 }));
      expect(none.hits.hits[0]._source).toBeUndefined();
      const bad = await rest('POST', '/_aoss/products/items/_search', { _source: 42 });
      expect(bad.status).toBe(400);
    });

    test('_count applies the same query semantics at index and collection level', async () => {
      const all = json(await rest('GET', '/_aoss/products/_count'));
      expect(all.count).toBe(4);
      const filtered = json(await rest('POST', '/_aoss/products/items/_count', {
        query: { range: { price: { gte: 20 } } },
      }));
      expect(filtered.count).toBe(2);
      const badQuery = await rest('POST', '/_aoss/products/items/_count', { query: { fuzzy: { a: 'b' } } });
      expect(badQuery.status).toBe(400);
      const byQ = json(await rest('GET', '/_aoss/products/items/_count', undefined, { q: 'name:mouse' }));
      expect(byQ.count).toBe(1);
    });

    test('a malformed search body is an x_content_parse_exception', async () => {
      const response = await rest('POST', '/_aoss/products/items/_search', '{nope');
      expect(response.status).toBe(400);
      expect(json(response).error.type).toBe('x_content_parse_exception');
    });
  });
});
