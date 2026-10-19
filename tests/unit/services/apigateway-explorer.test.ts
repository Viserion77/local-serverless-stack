// Unit tests for ApiGatewayExplorer. There is no SDK client to mock — the
// explorer speaks rest-json over global fetch — so fetch is stubbed with
// jest.spyOn (restored after every test) and answers real Response objects
// from a tiny path router. Covers `position` pagination, plan membership, the
// value-stripping of list reads, the reveal path, NotFoundException → null,
// error mapping and region routing through the credential scope.
import {
  ApiGatewayExplorer,
  ApiGatewayControlPlaneError,
} from '../../../src/server/services/apigateway-explorer';
import { ConfigManager } from '../../../src/server/services/config-manager';

let explorer: ApiGatewayExplorer;
let fetchSpy: jest.SpyInstance;

type Route = (url: URL) => Response;

function json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Answers by pathname + `position`; anything unrouted fails loudly.
function serve(routes: Record<string, Route>): void {
  fetchSpy.mockImplementation(async (input: unknown) => {
    const url = new URL(String(input));
    const route = routes[`${url.pathname}#${url.searchParams.get('position') ?? ''}`] ?? routes[url.pathname];
    if (!route) throw new Error(`unrouted fetch: ${url.pathname}${url.search}`);
    return route(url);
  });
}

function fetchedUrls(): URL[] {
  return fetchSpy.mock.calls.map(call => new URL(String(call[0])));
}

function authOf(call = 0): string {
  return ((fetchSpy.mock.calls[call][1] as RequestInit).headers as Record<string, string>).authorization;
}

async function rejection(promise: Promise<unknown>): Promise<ApiGatewayControlPlaneError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiGatewayControlPlaneError;
  }
  throw new Error('expected the control-plane call to reject, but it resolved');
}

beforeEach(() => {
  explorer = ApiGatewayExplorer.getInstance();
  (explorer as any).defaultRegion = 'us-east-1';
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getInstance / setDefaultRegion', () => {
  it('is a singleton', () => {
    expect(ApiGatewayExplorer.getInstance()).toBe(explorer);
  });

  it('setDefaultRegion ignores empty, accepts a value', () => {
    explorer.setDefaultRegion('');
    expect((explorer as any).defaultRegion).toBe('us-east-1');
    explorer.setDefaultRegion('eu-west-1');
    expect((explorer as any).defaultRegion).toBe('eu-west-1');
  });

  it('seeds the default region from the engine config on first construction', () => {
    const saved = (ApiGatewayExplorer as any).instance;
    try {
      jest.spyOn(ConfigManager.getInstance(), 'getRegion').mockReturnValue('ap-south-1');
      (ApiGatewayExplorer as any).instance = undefined;
      expect((ApiGatewayExplorer.getInstance() as any).defaultRegion).toBe('ap-south-1');
      jest.spyOn(ConfigManager.getInstance(), 'getRegion').mockReturnValue('');
      (ApiGatewayExplorer as any).instance = undefined;
      expect((ApiGatewayExplorer.getInstance() as any).defaultRegion).toBe('us-east-1');
    } finally {
      (ApiGatewayExplorer as any).instance = saved;
    }
  });
});

describe('listApiKeys', () => {
  it('follows position, strips values and attaches the plans holding each key', async () => {
    serve({
      '/apikeys#': () => json(200, {
        item: [
          {
            id: 'k2', name: 'acme-partner', description: 'partner key', enabled: true, customerId: 'acme',
            createdDate: 1_760_000_000, lastUpdatedDate: 1_760_000_060,
            stageKeys: ['orders-api/dev'], tags: { team: 'billing' },
            // The emulator never sends a value on a list without includeValues;
            // a stray one must still never leave the explorer.
            value: 'should-never-escape-the-explorer',
          },
        ],
        position: 'cA',
      }),
      '/apikeys#cA': () => json(200, { item: [{ id: 'k1', name: 'acme-internal' }, { id: 'k0' }] }),
      '/usageplans#': () => json(200, {
        item: [{ id: 'p2', name: 'Partners' }, { id: 'p1', name: 'Bronze' }, { id: 'p3' }],
      }),
      '/usageplans/p2/keys#': () => json(200, { item: [{ id: 'k2', value: 'v2' }], position: 'pB' }),
      '/usageplans/p2/keys#pB': () => json(200, { item: [{ id: 'k1', value: 'v1' }] }),
      '/usageplans/p1/keys': () => json(200, { item: [{ id: 'k2', value: 'v2' }] }),
      // An unnamed plan still shows up on its keys (with an empty name).
      '/usageplans/p3/keys': () => json(200, { item: [{ id: 'k0', value: 'v0' }] }),
    });

    const keys = await explorer.listApiKeys();

    expect(keys).toEqual([
      {
        id: 'k0', name: undefined, description: undefined, enabled: false, customerId: undefined,
        createdDate: undefined, lastUpdatedDate: undefined, stageKeys: [], tags: {},
        usagePlans: [{ id: 'p3', name: '' }],
      },
      {
        id: 'k1', name: 'acme-internal', description: undefined, enabled: false, customerId: undefined,
        createdDate: undefined, lastUpdatedDate: undefined, stageKeys: [], tags: {},
        usagePlans: [{ id: 'p2', name: 'Partners' }],
      },
      {
        id: 'k2', name: 'acme-partner', description: 'partner key', enabled: true, customerId: 'acme',
        createdDate: new Date(1_760_000_000_000).toISOString(),
        lastUpdatedDate: new Date(1_760_000_060_000).toISOString(),
        stageKeys: ['orders-api/dev'], tags: { team: 'billing' },
        usagePlans: [{ id: 'p1', name: 'Bronze' }, { id: 'p2', name: 'Partners' }],
      },
    ]);
    expect(JSON.stringify(keys)).not.toContain('should-never-escape');
    expect(JSON.stringify(keys)).not.toContain('"v1"');

    const urls = fetchedUrls();
    // Never asks for values, always pages at the 500 maximum.
    for (const url of urls) {
      expect(url.searchParams.get('includeValues')).toBeNull();
      expect(url.searchParams.get('limit')).toBe('500');
    }
    expect(urls.find(u => u.pathname === '/apikeys' && u.searchParams.get('position') === 'cA')).toBeDefined();
    expect(authOf()).toContain('/us-east-1/apigateway/aws4_request');
  });

  it('routes to the requested region through the credential scope', async () => {
    serve({
      '/apikeys': () => json(200, { item: [] }),
      '/usageplans': () => json(200, { item: [] }),
    });
    expect(await explorer.listApiKeys('sa-east-1')).toEqual([]);
    expect(authOf(0)).toContain('Credential=lss-dashboard/00000000/sa-east-1/apigateway/aws4_request');
    expect(authOf(1)).toContain('/sa-east-1/apigateway/');
  });

  it('targets the engine endpoint', async () => {
    serve({
      '/apikeys': () => json(200, { item: [] }),
      '/usageplans': () => json(200, { item: [] }),
    });
    await explorer.listApiKeys();
    const engine = new URL(ConfigManager.getInstance().getEngineEndpoint());
    expect(fetchedUrls()[0].host).toBe(engine.host);
  });
});

describe('listUsagePlans', () => {
  it('maps stages, throttle, quota and counts the keys of every plan', async () => {
    serve({
      '/usageplans#': () => json(200, {
        item: [
          {
            id: 'p1', name: 'partners', description: 'external', productCode: 'acme-pro',
            apiStages: [{ apiId: 'orders-api', stage: 'dev' }, {}],
            throttle: { burstLimit: 10, rateLimit: 5.5 },
            quota: { limit: 1000, offset: 0, period: 'DAY' },
            tags: { tier: 'gold' },
          },
        ],
        position: 'x',
      }),
      '/usageplans#x': () => json(200, { item: [{ id: 'p0' }] }),
      '/usageplans/p1/keys': () => json(200, { item: [{ id: 'k1', value: 'v1' }, { id: 'k2', value: 'v2' }] }),
      '/usageplans/p0/keys': () => json(200, { item: [] }),
    });

    const plans = await explorer.listUsagePlans();

    expect(plans).toEqual([
      {
        id: 'p0', name: '', description: undefined, apiStages: [], throttle: undefined, quota: undefined,
        productCode: undefined, tags: {}, keyCount: 0,
      },
      {
        id: 'p1', name: 'partners', description: 'external', productCode: 'acme-pro',
        apiStages: [{ apiId: 'orders-api', stage: 'dev' }, { apiId: '', stage: '' }],
        throttle: { burstLimit: 10, rateLimit: 5.5 },
        quota: { limit: 1000, offset: 0, period: 'DAY' },
        tags: { tier: 'gold' }, keyCount: 2,
      },
    ]);
    expect(JSON.stringify(plans)).not.toContain('"v1"');
  });

  it('breaks a name tie by id', async () => {
    serve({
      '/usageplans': () => json(200, { item: [{ id: 'pb', name: 'same' }, { id: 'pa', name: 'same' }] }),
      '/usageplans/pa/keys': () => json(200, { item: [] }),
      '/usageplans/pb/keys': () => json(200, { item: [] }),
    });
    expect((await explorer.listUsagePlans('eu-west-1')).map(p => p.id)).toEqual(['pa', 'pb']);
  });

  it('orders unnamed keys by id', async () => {
    serve({
      '/apikeys': () => json(200, { item: [{ id: 'kb' }, { id: 'ka' }, { id: 'kc', name: 'acme' }] }),
      '/usageplans': () => json(200, { item: [] }),
    });
    expect((await explorer.listApiKeys()).map(k => k.id)).toEqual(['ka', 'kb', 'kc']);
  });
});

describe('getApiKeyValue', () => {
  it('reveals one key with includeValue=true', async () => {
    serve({ '/apikeys/k1': () => json(200, { id: 'k1', name: 'acme-partner', value: 'abcdefghijklmnopqrstuvwxyz' }) });
    expect(await explorer.getApiKeyValue('k1', 'us-west-2')).toEqual({
      id: 'k1', name: 'acme-partner', value: 'abcdefghijklmnopqrstuvwxyz',
    });
    expect(fetchedUrls()[0].searchParams.get('includeValue')).toBe('true');
    expect(authOf()).toContain('/us-west-2/apigateway/');
  });

  it('answers an empty value when the control plane omits it', async () => {
    serve({ '/apikeys/k1': () => json(200, { id: 'k1' }) });
    expect(await explorer.getApiKeyValue('k1')).toEqual({ id: 'k1', name: undefined, value: '' });
  });

  it('URL-encodes the id', async () => {
    serve({ '/apikeys/a%2Fb': () => json(200, { id: 'a/b', value: 'v' }) });
    await explorer.getApiKeyValue('a/b');
    expect(fetchedUrls()[0].pathname).toBe('/apikeys/a%2Fb');
  });

  it('maps NotFoundException (with a namespace suffix) to null', async () => {
    serve({
      '/apikeys/ghost': () => json(404, { message: 'Invalid API Key identifier specified' }, {
        'x-amzn-errortype': 'NotFoundException:http://internal.amazon.com/coral/com.amazonaws.backplane.controlplane/',
      }),
    });
    expect(await explorer.getApiKeyValue('ghost')).toBeNull();
  });

  it('re-throws any other control-plane error with its type and message', async () => {
    serve({
      '/apikeys/k1': () => json(429, { message: 'slow down' }, { 'x-amzn-errortype': 'TooManyRequestsException' }),
    });
    const error = await rejection(explorer.getApiKeyValue('k1'));
    expect(error).toBeInstanceOf(ApiGatewayControlPlaneError);
    expect([error.name, error.message, error.status]).toEqual(['TooManyRequestsException', 'slow down', 429]);
  });

  it('re-throws a non-control-plane failure (network) untouched', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    await expect(explorer.getApiKeyValue('k1')).rejects.toThrow('fetch failed');
  });
});

describe('error mapping', () => {
  it('falls back to a generic type and message on a non-JSON body', async () => {
    serve({ '/usageplans': () => new Response('<html>bad gateway</html>', { status: 502 }) });
    const error = await rejection(explorer.listUsagePlans());
    expect([error.name, error.message]).toEqual(['ApiGatewayError', 'API Gateway control plane answered HTTP 502']);
  });

  it('keeps the generic message when the JSON body carries none', async () => {
    serve({
      '/apikeys': () => json(500, { message: '' }, { 'x-amzn-errortype': 'ServiceUnavailableException' }),
      '/usageplans': () => json(200, { item: [] }),
    });
    const error = await rejection(explorer.listApiKeys());
    expect([error.name, error.message]).toEqual(['ServiceUnavailableException', 'API Gateway control plane answered HTTP 500']);
  });

  it('treats a JSON null body as carrying no message', async () => {
    serve({ '/usageplans': () => json(500, null) });
    const error = await rejection(explorer.listUsagePlans());
    expect(error.message).toBe('API Gateway control plane answered HTTP 500');
  });

  it('treats an empty 2xx body as an empty page', async () => {
    serve({ '/usageplans': () => new Response('', { status: 200 }) });
    expect(await explorer.listUsagePlans()).toEqual([]);
  });
});
