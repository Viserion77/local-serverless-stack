// OpenSearch Serverless emulator. One RestEmulator covers both planes, split
// by the request shape the way real AOSS splits them by host:
//
//   Control plane — AWS JSON 1.0 with X-Amz-Target "OpenSearchServerless.<Op>"
//   (CreateCollection, BatchGetCollection, ListCollections, DeleteCollection).
//   Errors are AwsError, serialized by the router with the JSON shape.
//
//   Data plane — the OpenSearch REST API served under the collection endpoint
//   the control plane hands out: <engine>/_aoss/<collection>/... (index and
//   document CRUD, _bulk, _search, _count, _mapping). Errors are
//   OpenSearch-shaped JSON ({"error": {...}, "status": N}), which is what
//   OpenSearch clients expect to parse.
//
// Collections and index metadata are catalog entries; documents live in one
// ItemTable per index (lazy hydration / idle unload for free). No SigV4
// verification and no policy enforcement, matching the engine-wide bar.

import { createHash, randomUUID } from 'crypto';
import type {
  AwsRequest,
  AwsResponse,
  EngineContext,
  EngineServiceName,
  RestEmulator,
} from '../../types.js';
import type { CatalogStore, ItemTable } from '../../store/store-types.js';
import { AwsError, notImplemented } from '../../http/errors.js';
import { jsonSuccessResponse } from '../../http/protocols/aws-json.js';
import {
  computeAggregations,
  filterSource,
  matchesQuery,
  normalizeSort,
  sortHits,
  type SearchHitDoc,
} from './search.js';

const TARGET_PREFIX = 'OpenSearchServerless';
// AOSS collection naming rule: 3-32 chars, lowercase letter first, then
// lowercase letters/digits/hyphens. Also keeps store paths safe.
const COLLECTION_NAME = /^[a-z][a-z0-9-]{2,31}$/;
// Index names: conservative subset of the OpenSearch rules that is also safe
// as a store path segment.
const INDEX_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/;
const COLLECTION_TYPES = ['SEARCH', 'TIMESERIES', 'VECTORSEARCH'];
const DEFAULT_SEARCH_SIZE = 10;

export interface CollectionRecord {
  id: string;
  name: string;
  type: string;
  description?: string;
  createdDate: number;
}

export interface OpenSearchIndexRecord {
  collection: string;
  index: string;
  mappings: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: string;
}

// Stored table value: the raw _source plus the per-document version counter.
interface DocRecord {
  source: Record<string, unknown>;
  version: number;
}

// Data-plane failure carrying the OpenSearch error type; converted to the
// {"error": {...}, "status": N} JSON shape at the route boundary.
export class OsError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, reason: string) {
    super(reason);
    this.name = 'OsError';
    this.status = status;
    this.type = type;
  }
}

function osErrorResponse(err: OsError): AwsResponse {
  const cause = { type: err.type, reason: err.message };
  return {
    status: err.status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { root_cause: [cause], ...cause }, status: err.status }),
  };
}

function jsonResponse(status: number, payload: unknown): AwsResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseBodyJson(req: AwsRequest, errorType: string): Record<string, unknown> {
  if (req.body.length === 0) return {};
  try {
    const parsed = JSON.parse(req.body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new OsError(400, errorType, 'Could not parse the request body as a JSON object');
  }
}

// Deep merge for _update: objects merge recursively, everything else (arrays
// included) replaces — OpenSearch partial-update semantics.
function mergeDoc(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      current !== null && typeof current === 'object' && !Array.isArray(current)
    ) {
      result[key] = mergeDoc(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class OpenSearchEmulator implements RestEmulator {
  readonly service: EngineServiceName = 'aoss';

  private readonly ctx: EngineContext;

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
  }

  async handle(req: AwsRequest): Promise<AwsResponse> {
    const target = req.headers['x-amz-target'];
    if (target !== undefined && target.startsWith(`${TARGET_PREFIX}.`)) {
      const operation = target.slice(TARGET_PREFIX.length + 1);
      return jsonSuccessResponse(await this.handleControlPlane(operation, req), '1.0');
    }
    return this.handleDataPlane(req);
  }

  // ---------------------------------------------------------------------------
  // Control plane (AWS JSON 1.0)
  // ---------------------------------------------------------------------------

  private async handleControlPlane(operation: string, req: AwsRequest): Promise<object> {
    let input: Record<string, unknown> = {};
    if (req.body.length > 0) {
      try {
        input = JSON.parse(req.body.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new AwsError('SerializationException', 'Could not parse the request body as JSON');
      }
    }
    const region = req.region;
    switch (operation) {
      case 'CreateCollection': return this.createCollection(region, input);
      case 'BatchGetCollection': return this.batchGetCollection(region, input);
      case 'ListCollections': return this.listCollections(region);
      case 'DeleteCollection': return this.deleteCollection(region, input);
      default: throw notImplemented('aoss', operation);
    }
  }

  private async createCollection(region: string, input: Record<string, unknown>): Promise<object> {
    const name = typeof input.name === 'string' ? input.name : '';
    if (!COLLECTION_NAME.test(name)) {
      throw new AwsError(
        'ValidationException',
        `Collection name must match ${COLLECTION_NAME} (3-32 chars, lowercase letters, digits and hyphens, starting with a letter).`,
      );
    }
    const type = typeof input.type === 'string' ? input.type : 'TIMESERIES';
    if (!COLLECTION_TYPES.includes(type)) {
      throw new AwsError('ValidationException', `Collection type must be one of ${COLLECTION_TYPES.join(', ')}.`);
    }
    const collections = await this.collections(region);
    if (collections.get(name)) {
      throw new AwsError('ConflictException', `A collection with the name ${name} already exists.`, { status: 409 });
    }
    const record: CollectionRecord = {
      id: this.collectionId(region, name),
      name,
      type,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      createdDate: Date.now(),
    };
    collections.set(name, record);
    return { createCollectionDetail: this.collectionDetail(region, record) };
  }

  private async batchGetCollection(region: string, input: Record<string, unknown>): Promise<object> {
    const collections = await this.collections(region);
    const names = Array.isArray(input.names) ? input.names.map(String) : undefined;
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : undefined;
    if ((names === undefined) === (ids === undefined)) {
      throw new AwsError('ValidationException', 'Specify exactly one of names or ids.');
    }

    const details: object[] = [];
    const errors: object[] = [];
    for (const ref of names ?? ids ?? []) {
      const record = names !== undefined
        ? collections.get(ref)
        : collections.values().find(candidate => candidate.id === ref);
      if (record) {
        details.push({
          ...this.collectionDetail(region, record),
          collectionEndpoint: this.collectionEndpoint(record.name),
          dashboardEndpoint: `${this.collectionEndpoint(record.name)}/_dashboards`,
        });
      } else {
        errors.push({
          ...(names !== undefined ? { name: ref } : { id: ref }),
          errorCode: 'NOT_FOUND',
          errorMessage: `Collection ${ref} not found.`,
        });
      }
    }
    return { collectionDetails: details, collectionErrorDetails: errors };
  }

  private async listCollections(region: string): Promise<object> {
    const collections = await this.collections(region);
    return {
      collectionSummaries: collections.values().map(record => ({
        arn: this.collectionArn(region, record.id),
        id: record.id,
        name: record.name,
        status: 'ACTIVE',
      })),
    };
  }

  private async deleteCollection(region: string, input: Record<string, unknown>): Promise<object> {
    const ref = typeof input.id === 'string' ? input.id : '';
    const collections = await this.collections(region);
    // AOSS deletes by id; the name is accepted too so cleanup flows can skip
    // the BatchGetCollection round trip.
    const record = collections.values().find(candidate => candidate.id === ref) ?? collections.get(ref);
    if (!record) {
      throw new AwsError('ResourceNotFoundException', `Collection with ID ${ref} cannot be found.`, { status: 404 });
    }

    const indices = await this.indices(region);
    for (const key of indices.keys()) {
      const entry = indices.get(key);
      if (entry?.collection === record.name) {
        await this.docsTable(region, record.name, entry.index).destroy();
        indices.delete(key);
      }
    }
    collections.delete(record.name);
    return { deleteCollectionDetail: { id: record.id, name: record.name, status: 'DELETING' } };
  }

  private collectionDetail(region: string, record: CollectionRecord): Record<string, unknown> {
    return {
      arn: this.collectionArn(region, record.id),
      createdDate: record.createdDate,
      ...(record.description !== undefined ? { description: record.description } : {}),
      id: record.id,
      kmsKeyArn: 'auto',
      lastModifiedDate: record.createdDate,
      name: record.name,
      standbyReplicas: 'DISABLED',
      status: 'ACTIVE',
      type: record.type,
    };
  }

  // ---------------------------------------------------------------------------
  // Data plane (OpenSearch REST under /_aoss/<collection>)
  // ---------------------------------------------------------------------------

  private async handleDataPlane(req: AwsRequest): Promise<AwsResponse> {
    const segments = req.rawPath.split('/').filter(part => part.length > 0).map(decodeSegment);
    if (segments[0] !== '_aoss' || segments.length < 2) {
      throw new AwsError(
        'ValidationException',
        `OpenSearch data-plane requests must target a collection endpoint: ${this.ctx.endpoint()}/_aoss/<collection>/... ` +
          '(the collectionEndpoint attribute LSS provisions). Unknown control-plane operations need an X-Amz-Target header.',
        { status: 404 },
      );
    }

    try {
      const region = req.region;
      const collectionName = segments[1];
      const collections = await this.collections(region);
      if (!collections.get(collectionName)) {
        throw new OsError(
          404,
          'collection_not_found_exception',
          `Collection ${collectionName} does not exist — declare it as AWS::OpenSearchServerless::Collection or call CreateCollection first.`,
        );
      }
      return await this.routeDataPlane(req, region, collectionName, segments.slice(2));
    } catch (err) {
      if (err instanceof OsError) return osErrorResponse(err);
      throw err;
    }
  }

  private async routeDataPlane(
    req: AwsRequest,
    region: string,
    collection: string,
    rest: string[],
  ): Promise<AwsResponse> {
    const method = req.method;

    if (rest.length === 0) {
      // The OpenSearch client's ping/info handshake.
      if (method === 'HEAD') return { status: 200 };
      if (method === 'GET') {
        return jsonResponse(200, {
          name: collection,
          cluster_name: collection,
          cluster_uuid: this.collectionId(region, collection),
          version: {
            distribution: 'opensearch',
            number: '2.11.0',
            build_type: 'lss-self-engine',
            minimum_wire_compatibility_version: '7.10.0',
            minimum_index_compatibility_version: '7.0.0',
          },
          tagline: 'The LSS self engine, serving the OpenSearch REST API locally',
        });
      }
    } else if (rest[0].startsWith('_') && rest[0] !== '_all') {
      // `_all` is an index expression, not a collection API.
      return this.routeCollectionApi(req, region, collection, rest);
    } else {
      return this.routeIndexApi(req, region, collection, rest);
    }
    throw this.unsupported(req);
  }

  // Collection-level _apis (no index in the path).
  private async routeCollectionApi(
    req: AwsRequest,
    region: string,
    collection: string,
    rest: string[],
  ): Promise<AwsResponse> {
    const method = req.method;
    const api = rest[0];

    if (api === '_search' && (method === 'GET' || method === 'POST') && rest.length === 1) {
      return this.search(req, region, collection, await this.indexNames(region, collection));
    }
    if (api === '_count' && (method === 'GET' || method === 'POST') && rest.length === 1) {
      return this.count(req, region, collection, await this.indexNames(region, collection));
    }
    if (api === '_bulk' && method === 'POST' && rest.length === 1) {
      return this.bulk(req, region, collection, undefined);
    }
    if (api === '_refresh' && method === 'POST' && rest.length === 1) {
      // Writes are visible immediately; acknowledged for client compatibility.
      return jsonResponse(200, { _shards: { total: 1, successful: 1, failed: 0 } });
    }
    if (api === '_cat' && rest[1] === 'indices' && method === 'GET' && rest.length === 2) {
      return this.catIndices(region, collection);
    }
    throw this.unsupported(req);
  }

  private async routeIndexApi(
    req: AwsRequest,
    region: string,
    collection: string,
    rest: string[],
  ): Promise<AwsResponse> {
    const method = req.method;
    const index = rest[0];

    if (rest.length === 1) {
      if (method === 'PUT') return this.createIndex(req, region, collection, index);
      if (method === 'DELETE') return this.deleteIndex(region, collection, index);
      if (method === 'GET') return this.getIndex(region, collection, index);
      if (method === 'HEAD') {
        return { status: (await this.indexRecord(region, collection, index)) ? 200 : 404 };
      }
      throw this.unsupported(req);
    }

    const sub = rest[1];
    if (sub === '_search' && (method === 'GET' || method === 'POST') && rest.length === 2) {
      return this.search(req, region, collection, await this.resolveIndexPatterns(region, collection, index));
    }
    if (sub === '_count' && (method === 'GET' || method === 'POST') && rest.length === 2) {
      return this.count(req, region, collection, await this.resolveIndexPatterns(region, collection, index));
    }
    if (sub === '_bulk' && method === 'POST' && rest.length === 2) {
      return this.bulk(req, region, collection, index);
    }
    if (sub === '_refresh' && method === 'POST' && rest.length === 2) {
      return jsonResponse(200, { _shards: { total: 1, successful: 1, failed: 0 } });
    }
    if (sub === '_mapping' && rest.length === 2) {
      if (method === 'GET') return this.getMapping(region, collection, index);
      if (method === 'PUT') return this.putMapping(req, region, collection, index);
      throw this.unsupported(req);
    }
    if (sub === '_doc') {
      if (rest.length === 2 && method === 'POST') {
        return this.indexDoc(req, region, collection, index, randomUUID(), false);
      }
      if (rest.length === 3) {
        const id = rest[2];
        if (method === 'PUT' || method === 'POST') return this.indexDoc(req, region, collection, index, id, false);
        if (method === 'GET') return this.getDoc(region, collection, index, id);
        if (method === 'HEAD') return this.docHead(region, collection, index, id);
        if (method === 'DELETE') return this.deleteDoc(region, collection, index, id);
      }
      throw this.unsupported(req);
    }
    if (sub === '_create' && rest.length === 3 && (method === 'PUT' || method === 'POST')) {
      return this.indexDoc(req, region, collection, index, rest[2], true);
    }
    if (sub === '_update' && rest.length === 3 && method === 'POST') {
      return this.updateDoc(req, region, collection, index, rest[2]);
    }
    throw this.unsupported(req);
  }

  private unsupported(req: AwsRequest): OsError {
    return new OsError(
      400,
      'illegal_argument_exception',
      `${req.method} ${req.rawPath} is not supported by the LSS self engine — see docs/SELF_ENGINE.md#coverage, ` +
        'or set selfEngine.fallbackEndpoint to forward unimplemented operations',
    );
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  private async createIndex(req: AwsRequest, region: string, collection: string, index: string): Promise<AwsResponse> {
    this.assertIndexName(index);
    const indices = await this.indices(region);
    if (indices.get(indexKey(collection, index))) {
      throw new OsError(400, 'resource_already_exists_exception', `index [${index}] already exists`);
    }
    const body = parseBodyJson(req, 'mapper_parsing_exception');
    this.putIndexRecord(indices, collection, index, body);
    return jsonResponse(200, { acknowledged: true, shards_acknowledged: true, index });
  }

  private putIndexRecord(
    indices: CatalogStore<OpenSearchIndexRecord>,
    collection: string,
    index: string,
    body: Record<string, unknown>,
  ): OpenSearchIndexRecord {
    const record: OpenSearchIndexRecord = {
      collection,
      index,
      mappings: (body.mappings as Record<string, unknown> | undefined) ?? {},
      settings: (body.settings as Record<string, unknown> | undefined) ?? {},
      createdAt: new Date().toISOString(),
    };
    indices.set(indexKey(collection, index), record);
    return record;
  }

  private async deleteIndex(region: string, collection: string, index: string): Promise<AwsResponse> {
    const indices = await this.indices(region);
    if (!indices.get(indexKey(collection, index))) throw this.indexNotFound(index);
    await this.docsTable(region, collection, index).destroy();
    indices.delete(indexKey(collection, index));
    return jsonResponse(200, { acknowledged: true });
  }

  private async getIndex(region: string, collection: string, index: string): Promise<AwsResponse> {
    const record = await this.indexRecord(region, collection, index);
    if (!record) throw this.indexNotFound(index);
    return jsonResponse(200, {
      [index]: { aliases: {}, mappings: record.mappings, settings: record.settings },
    });
  }

  private async getMapping(region: string, collection: string, index: string): Promise<AwsResponse> {
    const record = await this.indexRecord(region, collection, index);
    if (!record) throw this.indexNotFound(index);
    return jsonResponse(200, { [index]: { mappings: record.mappings } });
  }

  private async putMapping(req: AwsRequest, region: string, collection: string, index: string): Promise<AwsResponse> {
    const indices = await this.indices(region);
    const record = indices.get(indexKey(collection, index));
    if (!record) throw this.indexNotFound(index);
    const body = parseBodyJson(req, 'mapper_parsing_exception');
    const properties = {
      ...((record.mappings.properties as Record<string, unknown> | undefined) ?? {}),
      ...((body.properties as Record<string, unknown> | undefined) ?? {}),
    };
    indices.set(indexKey(collection, index), { ...record, mappings: { ...record.mappings, ...body, properties } });
    return jsonResponse(200, { acknowledged: true });
  }

  private async catIndices(region: string, collection: string): Promise<AwsResponse> {
    const names = await this.indexNames(region, collection);
    const rows = [];
    for (const index of names) {
      const docs = await this.docs(region, collection, index);
      rows.push({
        health: 'green',
        status: 'open',
        index,
        uuid: this.collectionId(region, `${collection}/${index}`),
        pri: '1',
        rep: '0',
        'docs.count': String(docs.size()),
        'docs.deleted': '0',
        'store.size': `${docs.approxBytes()}b`,
        'pri.store.size': `${docs.approxBytes()}b`,
      });
    }
    return jsonResponse(200, rows);
  }

  // ---------------------------------------------------------------------------
  // Document CRUD
  // ---------------------------------------------------------------------------

  private async indexDoc(
    req: AwsRequest,
    region: string,
    collection: string,
    index: string,
    id: string,
    createOnly: boolean,
  ): Promise<AwsResponse> {
    this.assertIndexName(index);
    if (req.body.length === 0) {
      throw new OsError(400, 'mapper_parsing_exception', 'request body is required for indexing a document');
    }
    const source = parseBodyJson(req, 'mapper_parsing_exception');
    const indices = await this.indices(region);
    // Indexing into an absent index creates it, like OpenSearch's default
    // auto-create behavior.
    if (!indices.get(indexKey(collection, index))) this.putIndexRecord(indices, collection, index, {});

    const docs = await this.docs(region, collection, index);
    const existing = docs.get(id) as DocRecord | undefined;
    if (existing && createOnly) {
      throw new OsError(
        409,
        'version_conflict_engine_exception',
        `[${id}]: version conflict, document already exists (current version [${existing.version}])`,
      );
    }
    const version = (existing?.version ?? 0) + 1;
    docs.put(id, structuredClone({ source, version }));
    return jsonResponse(existing ? 200 : 201, {
      _index: index,
      _id: id,
      _version: version,
      result: existing ? 'updated' : 'created',
      _shards: { total: 1, successful: 1, failed: 0 },
      _seq_no: version - 1,
      _primary_term: 1,
    });
  }

  private async getDoc(region: string, collection: string, index: string, id: string): Promise<AwsResponse> {
    if (!(await this.indexRecord(region, collection, index))) throw this.indexNotFound(index);
    const docs = await this.docs(region, collection, index);
    const record = docs.get(id) as DocRecord | undefined;
    if (!record) return jsonResponse(404, { _index: index, _id: id, found: false });
    return jsonResponse(200, {
      _index: index,
      _id: id,
      _version: record.version,
      _seq_no: record.version - 1,
      _primary_term: 1,
      found: true,
      _source: structuredClone(record.source),
    });
  }

  private async docHead(region: string, collection: string, index: string, id: string): Promise<AwsResponse> {
    if (!(await this.indexRecord(region, collection, index))) return { status: 404 };
    const docs = await this.docs(region, collection, index);
    return { status: docs.has(id) ? 200 : 404 };
  }

  private async deleteDoc(region: string, collection: string, index: string, id: string): Promise<AwsResponse> {
    if (!(await this.indexRecord(region, collection, index))) throw this.indexNotFound(index);
    const docs = await this.docs(region, collection, index);
    const record = docs.get(id) as DocRecord | undefined;
    const payload = {
      _index: index,
      _id: id,
      _version: (record?.version ?? 0) + 1,
      result: record ? 'deleted' : 'not_found',
      _shards: { total: 1, successful: 1, failed: 0 },
      _seq_no: record?.version ?? 0,
      _primary_term: 1,
    };
    if (!record) return jsonResponse(404, payload);
    docs.delete(id);
    return jsonResponse(200, payload);
  }

  private async updateDoc(req: AwsRequest, region: string, collection: string, index: string, id: string): Promise<AwsResponse> {
    if (!(await this.indexRecord(region, collection, index))) throw this.indexNotFound(index);
    const body = parseBodyJson(req, 'x_content_parse_exception');
    if (body.script !== undefined) {
      throw new OsError(400, 'illegal_argument_exception', 'scripted updates are not supported by the LSS self engine — send a partial "doc" instead');
    }
    const patch = body.doc;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new OsError(400, 'x_content_parse_exception', 'the _update body requires a "doc" object');
    }

    const docs = await this.docs(region, collection, index);
    const existing = docs.get(id) as DocRecord | undefined;
    if (!existing) {
      const upsert = body.doc_as_upsert === true ? (patch as Record<string, unknown>) : body.upsert;
      if (upsert === null || typeof upsert !== 'object' || Array.isArray(upsert)) {
        throw new OsError(404, 'document_missing_exception', `[${id}]: document missing`);
      }
      docs.put(id, structuredClone({ source: upsert as Record<string, unknown>, version: 1 }));
      return jsonResponse(201, {
        _index: index, _id: id, _version: 1, result: 'created',
        _shards: { total: 1, successful: 1, failed: 0 }, _seq_no: 0, _primary_term: 1,
      });
    }

    const merged = mergeDoc(existing.source, patch as Record<string, unknown>);
    const version = existing.version + 1;
    docs.put(id, structuredClone({ source: merged, version }));
    return jsonResponse(200, {
      _index: index, _id: id, _version: version, result: 'updated',
      _shards: { total: 1, successful: 1, failed: 0 }, _seq_no: version - 1, _primary_term: 1,
    });
  }

  // ---------------------------------------------------------------------------
  // _bulk (NDJSON)
  // ---------------------------------------------------------------------------

  private async bulk(req: AwsRequest, region: string, collection: string, defaultIndex: string | undefined): Promise<AwsResponse> {
    const lines = req.body.toString('utf8').split('\n').filter(line => line.trim().length > 0);
    const items: Record<string, unknown>[] = [];
    let errors = false;

    let cursor = 0;
    while (cursor < lines.length) {
      let action: Record<string, unknown>;
      try {
        action = JSON.parse(lines[cursor]) as Record<string, unknown>;
      } catch {
        throw new OsError(400, 'illegal_argument_exception', `Malformed bulk action at line ${cursor + 1}: not valid JSON`);
      }
      cursor++;
      const [op, rawMeta] = Object.entries(action)[0] ?? [];
      if (!op || !['index', 'create', 'update', 'delete'].includes(op)) {
        throw new OsError(400, 'illegal_argument_exception', `Malformed bulk action at line ${cursor}: expected index, create, update or delete`);
      }
      const meta = (rawMeta ?? {}) as Record<string, unknown>;
      const index = typeof meta._index === 'string' ? meta._index : defaultIndex;
      // Clients send numeric _ids too; OpenSearch coerces them to strings.
      // Auto-generation only applies to index/create — update/delete against
      // a random id would silently target nothing.
      const givenId = typeof meta._id === 'string' || typeof meta._id === 'number' ? String(meta._id) : undefined;
      if (givenId === undefined && (op === 'update' || op === 'delete')) {
        throw new OsError(400, 'illegal_argument_exception', `Bulk action "${op}" at line ${cursor} requires an _id`);
      }
      const id = givenId ?? randomUUID();

      let payload: Buffer = Buffer.alloc(0);
      if (op !== 'delete') {
        if (cursor >= lines.length) {
          throw new OsError(400, 'illegal_argument_exception', `Bulk action "${op}" at line ${cursor} is missing its document line`);
        }
        payload = Buffer.from(lines[cursor], 'utf8');
        cursor++;
      }

      if (!index) {
        errors = true;
        items.push(bulkItem(op, '_unknown', id, 400, { type: 'illegal_argument_exception', reason: 'no index specified for bulk action' }));
        continue;
      }

      try {
        const subReq: AwsRequest = { ...req, body: payload };
        const response =
          op === 'delete' ? await this.deleteDoc(region, collection, index, id)
          : op === 'update' ? await this.updateDoc(subReq, region, collection, index, id)
          : await this.indexDoc(subReq, region, collection, index, id, op === 'create');
        const body = JSON.parse(String(response.body)) as Record<string, unknown>;
        // A delete of a missing document reports status 404 in its slot but is
        // not an error, matching OpenSearch — the flag tracks failed writes.
        if (response.status >= 400 && body.result !== 'not_found') errors = true;
        items.push({ [op]: { ...body, status: response.status } });
      } catch (err) {
        if (!(err instanceof OsError)) throw err;
        errors = true;
        items.push(bulkItem(op, index, id, err.status, { type: err.type, reason: err.message }));
      }
    }

    if (items.length === 0) {
      throw new OsError(400, 'illegal_argument_exception', 'The bulk request must contain at least one action');
    }
    return jsonResponse(200, { took: 0, errors, items });
  }

  // ---------------------------------------------------------------------------
  // _search / _count
  // ---------------------------------------------------------------------------

  private async search(req: AwsRequest, region: string, collection: string, indexNames: string[]): Promise<AwsResponse> {
    const body = parseBodyJson(req, 'x_content_parse_exception');
    // Answering a scroll/PIT request without a _scroll_id would silently
    // truncate the client's pagination loop — fail loudly instead.
    if (req.query.scroll !== undefined || body.scroll !== undefined || body.pit !== undefined) {
      throw new OsError(
        400,
        'illegal_argument_exception',
        'scroll and point-in-time pagination are not supported by the LSS self engine — page with from/size',
      );
    }
    const query = this.effectiveQuery(req, body);

    let hits: SearchHitDoc[];
    let sortSpec: ReturnType<typeof normalizeSort>;
    let aggregations: Record<string, unknown> | undefined;
    try {
      const all = await this.gatherDocs(region, collection, indexNames);
      hits = all.filter(doc => matchesQuery(query, doc));
      sortSpec = normalizeSort(body.sort);
      // Aggregations run over every match, not just the returned page.
      aggregations = body.aggs !== undefined || body.aggregations !== undefined
        ? computeAggregations(body.aggs ?? body.aggregations, hits)
        : undefined;
    } catch (err) {
      if (err instanceof OsError) throw err;
      throw new OsError(400, 'search_phase_execution_exception', err instanceof Error ? err.message : String(err));
    }

    const total = hits.length;
    const sorted = sortHits(hits, sortSpec);
    const from = numberParam(req.query.from ?? body.from, 0);
    const size = numberParam(req.query.size ?? body.size, DEFAULT_SEARCH_SIZE);
    const page = sorted.slice(from, from + size);

    const sourceSpec = body._source;
    return jsonResponse(200, {
      took: 0,
      timed_out: false,
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: {
        total: { value: total, relation: 'eq' },
        max_score: page.length > 0 ? 1 : null,
        hits: page.map(doc => {
          let filtered: Record<string, unknown> | undefined;
          try {
            filtered = filterSource(doc.source, sourceSpec);
          } catch (err) {
            throw new OsError(400, 'x_content_parse_exception', err instanceof Error ? err.message : String(err));
          }
          return {
            _index: doc.index,
            _id: doc.id,
            _score: 1,
            ...(filtered !== undefined ? { _source: filtered } : {}),
          };
        }),
      },
      ...(aggregations !== undefined ? { aggregations } : {}),
    });
  }

  private async count(req: AwsRequest, region: string, collection: string, indexNames: string[]): Promise<AwsResponse> {
    const body = parseBodyJson(req, 'x_content_parse_exception');
    const query = this.effectiveQuery(req, body);
    let count: number;
    try {
      const all = await this.gatherDocs(region, collection, indexNames);
      count = all.filter(doc => matchesQuery(query, doc)).length;
    } catch (err) {
      if (err instanceof OsError) throw err;
      throw new OsError(400, 'search_phase_execution_exception', err instanceof Error ? err.message : String(err));
    }
    return jsonResponse(200, { count, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 } });
  }

  // `?q=` supports the two shapes people actually type into curl: bare text
  // (tokenized match over every top-level field) and a single field:value pair.
  private effectiveQuery(req: AwsRequest, body: Record<string, unknown>): unknown {
    const q = req.query.q;
    if (q === undefined) return body.query;
    if (body.query !== undefined) {
      throw new OsError(400, 'illegal_argument_exception', 'Specify either the q parameter or a request-body query, not both');
    }
    const colon = q.indexOf(':');
    if (colon > 0) {
      return { match: { [q.slice(0, colon)]: q.slice(colon + 1) } };
    }
    return { multi_match: { query: q, fields: ['*'] } };
  }

  private async gatherDocs(region: string, collection: string, indexNames: string[]): Promise<SearchHitDoc[]> {
    const result: SearchHitDoc[] = [];
    for (const index of indexNames) {
      const docs = await this.docs(region, collection, index);
      for (const [id, value] of docs.entries()) {
        const record = value as DocRecord;
        result.push({ index, id, source: structuredClone(record.source) });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private async collections(region: string): Promise<CatalogStore<CollectionRecord>> {
    const catalog = this.ctx.store.catalog<CollectionRecord>(`aoss/${region}/collections`);
    await catalog.load();
    return catalog;
  }

  private async indices(region: string): Promise<CatalogStore<OpenSearchIndexRecord>> {
    const catalog = this.ctx.store.catalog<OpenSearchIndexRecord>(`aoss/${region}/indices`);
    await catalog.load();
    return catalog;
  }

  private docsTable(region: string, collection: string, index: string): ItemTable {
    return this.ctx.store.table(`aoss/${region}/${collection}/${index}/docs`);
  }

  // The idle sweeper may dehydrate between requests — re-fetch and re-hydrate
  // on every access (hydrate() is a no-op when already resident).
  private async docs(region: string, collection: string, index: string): Promise<ItemTable> {
    const table = this.docsTable(region, collection, index);
    await table.hydrate();
    return table;
  }

  private async indexRecord(region: string, collection: string, index: string): Promise<OpenSearchIndexRecord | undefined> {
    const indices = await this.indices(region);
    return indices.get(indexKey(collection, index));
  }

  private async indexNames(region: string, collection: string): Promise<string[]> {
    const indices = await this.indices(region);
    return indices.values()
      .filter(record => record.collection === collection)
      .map(record => record.index)
      .sort();
  }

  // Search/count accept comma-separated names, `*` wildcards and `_all`.
  // A concrete (non-wildcard) name that doesn't exist is a 404, like
  // OpenSearch; wildcards matching nothing simply contribute no indices.
  private async resolveIndexPatterns(region: string, collection: string, expression: string): Promise<string[]> {
    const known = await this.indexNames(region, collection);
    const resolved = new Set<string>();
    for (const pattern of expression.split(',').filter(part => part.length > 0)) {
      if (pattern === '_all' || pattern === '*') {
        known.forEach(name => resolved.add(name));
      } else if (pattern.includes('*')) {
        // Everything except '*' is literal — '?' included, so a stray '?'
        // can't become a regex quantifier (or crash compilation).
        const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        known.filter(name => regex.test(name)).forEach(name => resolved.add(name));
      } else {
        if (!known.includes(pattern)) throw this.indexNotFound(pattern);
        resolved.add(pattern);
      }
    }
    return [...resolved].sort();
  }

  private assertIndexName(index: string): void {
    if (!INDEX_NAME.test(index) || index.startsWith('.')) {
      throw new OsError(
        400,
        'invalid_index_name_exception',
        `Invalid index name [${index}]: must be lowercase alphanumerics plus . _ - and must not start with _, - or .`,
      );
    }
  }

  private indexNotFound(index: string): OsError {
    return new OsError(404, 'index_not_found_exception', `no such index [${index}]`);
  }

  private collectionEndpoint(name: string): string {
    return `${this.ctx.endpoint()}/_aoss/${name}`;
  }

  private collectionArn(region: string, id: string): string {
    return `arn:aws:aoss:${region}:${this.ctx.config.account}:collection/${id}`;
  }

  // Deterministic id so BatchGetCollection/DeleteCollection round-trip by id
  // across engine restarts (real AOSS ids are random 20-char strings).
  private collectionId(region: string, name: string): string {
    return createHash('sha1').update(`${this.ctx.config.account}/${region}/${name}`).digest('hex').slice(0, 20);
  }
}

function indexKey(collection: string, index: string): string {
  return `${collection}|${index}`;
}

// from/size arrive as query-string strings or body numbers; anything not a
// non-negative integer falls back to the default rather than slicing weirdly.
function numberParam(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function bulkItem(
  op: string,
  index: string,
  id: string,
  status: number,
  error: { type: string; reason: string },
): Record<string, unknown> {
  return { [op]: { _index: index, _id: id, status, error } };
}
