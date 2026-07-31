// Unit tests for OpenSearchExplorer. The control plane follows the
// AWS-SDK-mock singleton pattern (mockClient patches the
// OpenSearchServerlessClient prototype so calls made through the cached
// clients are intercepted). The data plane has no SDK client — it goes through
// global fetch, which is stubbed with jest.spyOn (restored after every test)
// and answers real Response objects.
import { mockClient } from 'aws-sdk-client-mock';
import {
  OpenSearchServerlessClient,
  ListCollectionsCommand,
} from '@aws-sdk/client-opensearchserverless';
import {
  OpenSearchExplorer,
  OpenSearchDataPlaneError,
} from '../../../src/server/services/opensearch-explorer';
import { ConfigManager } from '../../../src/server/services/config-manager';

const aossMock = mockClient(OpenSearchServerlessClient);

let explorer: OpenSearchExplorer;
let fetchSpy: jest.SpyInstance;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchedUrl(call = 0): URL {
  return new URL(String(fetchSpy.mock.calls[call][0]));
}

function fetchedInit(call = 0): RequestInit {
  return fetchSpy.mock.calls[call][1] as RequestInit;
}

beforeEach(() => {
  aossMock.reset();
  explorer = OpenSearchExplorer.getInstance();
  const e = explorer as any;
  e.clients.clear();
  e.defaultRegion = 'us-east-1';
  // Every data-plane call must opt in per test; anything unexpected fails loudly.
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
});

afterEach(() => {
  // Restores global fetch and any ConfigManager spies.
  jest.restoreAllMocks();
});

afterAll(() => {
  aossMock.restore();
});

describe('getInstance / setDefaultRegion', () => {
  it('is a singleton', () => {
    expect(OpenSearchExplorer.getInstance()).toBe(explorer);
  });

  it('setDefaultRegion ignores empty, accepts a value', () => {
    explorer.setDefaultRegion('');
    expect((explorer as any).defaultRegion).toBe('us-east-1');
    explorer.setDefaultRegion('eu-west-1');
    expect((explorer as any).defaultRegion).toBe('eu-west-1');
  });
});

describe('clientFor / endpoint selection', () => {
  it('caches one client per region and reuses it', async () => {
    aossMock.on(ListCollectionsCommand).resolves({ collectionSummaries: [] });
    await explorer.listCollections('us-west-2');
    await explorer.listCollections('us-west-2');
    expect((explorer as any).clients.size).toBe(1);
    expect((explorer as any).clients.has('us-west-2')).toBe(true);
  });

  it('falls back to the default region when none is given', async () => {
    aossMock.on(ListCollectionsCommand).resolves({ collectionSummaries: [] });
    await explorer.listCollections();
    expect((explorer as any).clients.has('us-east-1')).toBe(true);
  });

  // The engine serves the aoss control plane and the data plane on its own
  // endpoint — 0.x needed a separate sidecar only because no LocalStack edition
  // provides aoss at all.
  it('targets the engine endpoint', async () => {
    aossMock.on(ListCollectionsCommand).resolves({ collectionSummaries: [] });
    await explorer.listCollections();
    const engineUrl = new URL(ConfigManager.getInstance().getEngineEndpoint());
    const endpoint = await (explorer as any).clients.get('us-east-1').config.endpoint();
    expect(endpoint.hostname).toBe(engineUrl.hostname);
    expect(Number(endpoint.port)).toBe(Number(engineUrl.port));
  });
});

describe('listCollections', () => {
  it('maps collection names to their data-plane endpoints on the engine base', async () => {
    aossMock.on(ListCollectionsCommand).resolves({
      collectionSummaries: [
        { id: 'a1', name: 'products', status: 'ACTIVE' },
        { id: 'b2', name: 'orders', status: 'ACTIVE' },
      ],
    });
    const engine = ConfigManager.getInstance().getEngineEndpoint();
    expect(await explorer.listCollections()).toEqual([
      { name: 'products', endpoint: `${engine}/_aoss/products` },
      { name: 'orders', endpoint: `${engine}/_aoss/orders` },
    ]);
  });

  it('filters summaries without a usable name', async () => {
    aossMock.on(ListCollectionsCommand).resolves({
      collectionSummaries: [{ id: 'a1' }, { id: 'b2', name: '' }, { id: 'c3', name: 'ok' }],
    });
    expect(await explorer.listCollections()).toEqual([
      { name: 'ok', endpoint: 'http://localhost:14566/_aoss/ok' },
    ]);
  });

  it('treats missing collectionSummaries as an empty list', async () => {
    aossMock.on(ListCollectionsCommand).resolves({});
    expect(await explorer.listCollections()).toEqual([]);
  });

  it('propagates control-plane errors instead of swallowing them', async () => {
    aossMock.on(ListCollectionsCommand).rejects(new Error('control plane down'));
    await expect(explorer.listCollections()).rejects.toThrow('control plane down');
  });
});

describe('listIndices', () => {
  const rows = [
    {
      health: 'green',
      status: 'open',
      index: 'products-v1',
      uuid: 'x',
      pri: '1',
      rep: '0',
      'docs.count': '42',
      'docs.deleted': '0',
      'store.size': '10b',
      'pri.store.size': '10b',
    },
    { health: 'green', status: 'open', index: 'empty-v1', 'docs.count': '0' },
  ];

  it('maps _cat/indices rows, converting docs.count to a number', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, rows));
    expect(await explorer.listIndices('products')).toEqual([
      { index: 'products-v1', docsCount: 42, health: 'green', status: 'open' },
      { index: 'empty-v1', docsCount: 0, health: 'green', status: 'open' },
    ]);
    const url = fetchedUrl();
    expect(url.origin).toBe('http://localhost:14566');
    expect(url.pathname).toBe('/_aoss/products/_cat/indices');
    expect(url.searchParams.get('format')).toBe('json');
    expect(fetchedInit().method).toBe('GET');
    expect(fetchedInit().body).toBeUndefined();
  });

  it('pins the default region through the X-Amz-Credential scope trick', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, []));
    await explorer.listIndices('products');
    expect(fetchedUrl().searchParams.get('X-Amz-Credential')).toBe(
      'lss-dashboard/00000000/us-east-1/aoss/aws4_request',
    );
  });

  it('pins an explicit region through the X-Amz-Credential scope trick', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, []));
    await explorer.listIndices('products', 'eu-west-1');
    expect(fetchedUrl().searchParams.get('X-Amz-Credential')).toBe(
      'lss-dashboard/00000000/eu-west-1/aoss/aws4_request',
    );
  });

  it('throws an OpenSearchDataPlaneError carrying the upstream 404 and reason', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(404, {
        error: {
          root_cause: [{ type: 'collection_not_found_exception', reason: 'Collection ghost does not exist' }],
          type: 'collection_not_found_exception',
          reason: 'Collection ghost does not exist',
        },
        status: 404,
      }),
    );
    const err: OpenSearchDataPlaneError = await explorer.listIndices('ghost').catch(e => e);
    expect(err).toBeInstanceOf(OpenSearchDataPlaneError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('Collection ghost does not exist');
  });
});

describe('search', () => {
  const raw = {
    took: 0,
    timed_out: false,
    hits: { total: { value: 1, relation: 'eq' }, hits: [{ _index: 'products-v1', _id: '1', _source: { a: 1 } }] },
  };

  it('POSTs a body query with from/size to the collection _search and passes the response through', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, raw));
    const result = await explorer.search('products', { query: { match_all: {} }, from: 2, size: 5 });
    expect(result).toEqual(raw);
    const url = fetchedUrl();
    expect(url.pathname).toBe('/_aoss/products/_search');
    expect(url.searchParams.get('q')).toBeNull();
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'lss-dashboard/00000000/us-east-1/aoss/aws4_request',
    );
    const init = fetchedInit();
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ query: { match_all: {} }, from: 2, size: 5 });
  });

  it('scopes the search to an index when input.index is set', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, raw));
    await explorer.search('products', { index: 'products-v1', size: 1 }, 'eu-central-1');
    const url = fetchedUrl();
    expect(url.pathname).toBe('/_aoss/products/products-v1/_search');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'lss-dashboard/00000000/eu-central-1/aoss/aws4_request',
    );
    expect(JSON.parse(String(fetchedInit().body))).toEqual({ size: 1 });
  });

  it('forwards q as the ?q= shorthand the emulator derives a query from', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, raw));
    await explorer.search('products', { q: 'title:hello' });
    expect(fetchedUrl().searchParams.get('q')).toBe('title:hello');
    expect(JSON.parse(String(fetchedInit().body))).toEqual({});
  });

  it('throws an OpenSearchDataPlaneError with the upstream 400 reason', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(400, {
        error: { type: 'illegal_argument_exception', reason: 'unsupported query: [foo]' },
        status: 400,
      }),
    );
    const err: OpenSearchDataPlaneError = await explorer.search('products', {}).catch(e => e);
    expect(err).toBeInstanceOf(OpenSearchDataPlaneError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('unsupported query: [foo]');
  });

  it('falls back to a generic message for a non-JSON error body', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>oops</html>', { status: 500 }));
    const err: OpenSearchDataPlaneError = await explorer.search('products', {}).catch(e => e);
    expect(err).toBeInstanceOf(OpenSearchDataPlaneError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('OpenSearch data plane answered HTTP 500');
  });

  it('falls back to a generic message when the error payload is JSON null', async () => {
    fetchSpy.mockResolvedValue(new Response('null', { status: 502 }));
    const err: OpenSearchDataPlaneError = await explorer.search('products', {}).catch(e => e);
    expect(err.message).toBe('OpenSearch data plane answered HTTP 502');
  });

  it('falls back to a generic message when the payload has no error object', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(418, {}));
    const err: OpenSearchDataPlaneError = await explorer.search('products', {}).catch(e => e);
    expect(err.status).toBe(418);
    expect(err.message).toBe('OpenSearch data plane answered HTTP 418');
  });

  it('falls back to a generic message when error.reason is missing', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(400, { error: {}, status: 400 }));
    const err: OpenSearchDataPlaneError = await explorer.search('products', {}).catch(e => e);
    expect(err.message).toBe('OpenSearch data plane answered HTTP 400');
  });
});
