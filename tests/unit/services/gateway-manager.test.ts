// Unit tests for GatewayManager's bind lifecycle, focused on EADDRINUSE
// recovery: a port conflict must flag 'port-conflict' (never fail), keep
// retrying on a short interval, flip to 'online' once the port frees up, and
// stop retrying the moment the service stops. Real localhost listeners on
// ephemeral ports keep this hermetic. The request-handling paths (the file is
// coverage-excluded: it binds real listeners) are driven at the end over real
// HTTP, for the AWS answers the gateway produces itself — REST vs HTTP API
// misses, preflights, the request id header, single path decoding and
// authorizer denials. The runtime manager is jest.mocked — the real module
// forks workers and uses import.meta.
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { GatewayManager } from '../../../src/server/services/gateway-manager';
import { getBindHost } from '../../../src/server/services/bind-host';
import { FunctionRegistry, type ServiceEntry } from '../../../src/server/services/function-registry';
import { AuthorizerService } from '../../../src/server/services/authorizer-service';
import { LambdaRuntimeManager } from '../../../src/server/services/lambda-runtime-manager';
import type { HttpRoute, AuthorizerConfig, RegisteredFunction } from '../../../src/server/services/serverless-state-parser';
import { LOCAL_API_ID, type ResolvedApiKey } from '../../../src/server/services/api-gateway-events';
import { EngineManager } from '../../../src/server/engine/engine-manager';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function entryFor(name: string, apiPort?: number, invokePort?: number): ServiceEntry {
  return {
    name,
    root: `/proj/${name}`,
    stage: 'dev',
    apiPort,
    invokePort,
    functions: invokePort
      ? [{ name: 'fn', fullName: `${name}-dev-fn`, handler: 'h.handler', runtime: 'nodejs20.x', memorySize: 128, timeout: 6, environment: {}, triggers: [] }]
      : [],
    routes: apiPort
      ? [{ functionName: 'fn', method: 'GET', path: '/ping', eventType: 'httpApi' as const, cors: false }]
      : [],
    authorizers: [],
  };
}

// Occupy an ephemeral port so the gateway's bind hits EADDRINUSE.
function occupy(): Promise<http.Server> {
  return new Promise(resolve => {
    const blocker = http.createServer((_req, res) => { res.statusCode = 503; res.end(); });
    blocker.listen(0, () => resolve(blocker));
  });
}

const portOf = (s: http.Server) => (s.address() as AddressInfo).port;
const closeServer = (s: http.Server) => new Promise<void>(r => s.close(() => r()));

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await sleep(10);
  }
}

// True when nothing is listening on the port (we can bind and release it).
function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

let gm: GatewayManager;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  gm = new GatewayManager();
  gm.rebindIntervalMs = 25;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await gm.stopAll();
  jest.restoreAllMocks();
});

it('binds immediately when the port is free and releases it on removeService', async () => {
  // Grab an ephemeral port number, then free it for the gateway.
  const placeholder = await occupy();
  const port = portOf(placeholder);
  await closeServer(placeholder);

  await gm.syncService(entryFor('svc-free', port), true);
  expect(gm.getInfo('svc-free').api.status).toBe('online');
  expect(await portIsFree(port)).toBe(false);

  await gm.removeService('svc-free');
  expect(await portIsFree(port)).toBe(true);
});

it('reports port-conflict on EADDRINUSE for both listeners and recovers once the ports free up', async () => {
  const apiBlocker = await occupy();
  const invokeBlocker = await occupy();
  const apiPort = portOf(apiBlocker);
  const invokePort = portOf(invokeBlocker);

  await gm.syncService(entryFor('svc-conflict', apiPort, invokePort), true);
  expect(gm.getInfo('svc-conflict')).toEqual({
    api: { port: apiPort, status: 'port-conflict' },
    invoke: { port: invokePort, status: 'port-conflict' },
  });
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`port ${apiPort} already in use — retrying every 25ms`));
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`port ${invokePort} already in use — retrying every 25ms`));

  // Stay conflicted for several retry windows — retries must keep going, not
  // give up after the first attempt.
  await sleep(100);
  expect(gm.getInfo('svc-conflict').api.status).toBe('port-conflict');
  expect(gm.getInfo('svc-conflict').invoke.status).toBe('port-conflict');

  await closeServer(apiBlocker);
  await closeServer(invokeBlocker);
  await waitFor(() =>
    gm.getInfo('svc-conflict').api.status === 'online'
    && gm.getInfo('svc-conflict').invoke.status === 'online');

  expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`recovered from port conflict — listening on http://localhost:${apiPort}`));
  // The gateway now actually owns the ports.
  expect(await portIsFree(apiPort)).toBe(false);
  expect(await portIsFree(invokePort)).toBe(false);
});

it('stopService cancels pending rebind attempts — a stopped service never grabs the port later', async () => {
  const blocker = await occupy();
  const port = portOf(blocker);

  await gm.syncService(entryFor('svc-stopped', port), true);
  expect(gm.getInfo('svc-stopped').api.status).toBe('port-conflict');

  await gm.stopService('svc-stopped');
  await closeServer(blocker);

  // Give would-be retries several intervals to (wrongly) fire.
  await sleep(150);
  expect(await portIsFree(port)).toBe(true);
  expect(gm.getInfo('svc-stopped').api.status).not.toBe('online');
});

// Regression: both listeners must bind the process-wide host resolved in
// services/bind-host.ts. They used to call `listen(port)` with no host at all,
// which binds `::` — the dual-stack wildcard — so every service's API port AND
// its invoke port answered on the LAN even while the orchestrator itself sat on
// loopback. The invoke port is the sharper edge of the two: it is a raw
// http.Server that never reaches Express (no CORS, no origin check) and its
// handler runs a registered Lambda with the request body as the event.
it('binds the API and invoke listeners to the process bind host, never the wildcard', async () => {
  const apiPlaceholder = await occupy();
  const invokePlaceholder = await occupy();
  const apiPort = portOf(apiPlaceholder);
  const invokePort = portOf(invokePlaceholder);
  await closeServer(apiPlaceholder);
  await closeServer(invokePlaceholder);

  // Capture the real servers as they are created: the bound address is the
  // only witness that says which interfaces actually answer.
  const bound: http.Server[] = [];
  const realCreateServer = http.createServer.bind(http);
  jest.spyOn(http, 'createServer').mockImplementation(((...args: Parameters<typeof http.createServer>) => {
    const server = realCreateServer(...args);
    bound.push(server);
    return server;
  }) as typeof http.createServer);

  await gm.syncService(entryFor('svc-bind', apiPort, invokePort), true);
  expect(gm.getInfo('svc-bind')).toEqual({
    api: { port: apiPort, status: 'online' },
    invoke: { port: invokePort, status: 'online' },
  });
  expect(bound).toHaveLength(2);
  for (const server of bound) {
    expect((server.address() as AddressInfo).address).toBe(getBindHost());
  }
  // …and with LSS_BIND_HOST unset that host is loopback, not '::'/'0.0.0.0'.
  expect(getBindHost()).toBe('127.0.0.1');
});

it('re-syncing a conflicted service replaces its retry timers with the new bind', async () => {
  const blocker = await occupy();
  const port = portOf(blocker);

  const entry = entryFor('svc-resync', port);
  await gm.syncService(entry, true);
  expect(gm.getInfo('svc-resync').api.status).toBe('port-conflict');

  // Re-register while still conflicted (e.g. a hot reload): the old timers are
  // cancelled with the old server, and the fresh bind conflicts again...
  await gm.syncService(entry, true);
  expect(gm.getInfo('svc-resync').api.status).toBe('port-conflict');

  // ...until the port frees up and the NEW listener takes over.
  await closeServer(blocker);
  await waitFor(() => gm.getInfo('svc-resync').api.status === 'online');
  expect(await portIsFree(port)).toBe(false);
});

describe('API request handling', () => {
  const invokeMock = LambdaRuntimeManager.getInstance().invoke as jest.Mock;
  const fnDef = (name: string): RegisteredFunction => ({
    name, fullName: `svc-http-dev-${name}`, handler: 'h.handler', runtime: 'nodejs20.x', memorySize: 128, timeout: 6, environment: {}, triggers: [],
  });
  let port: number;

  // Register a service in the real registry and bind its API listener.
  async function serve(routes: HttpRoute[], authorizers: AuthorizerConfig[] = []): Promise<void> {
    const placeholder = await occupy();
    port = portOf(placeholder);
    await closeServer(placeholder);
    (FunctionRegistry as any).instance = undefined;
    const entry = FunctionRegistry.getInstance().registerService({
      name: 'svc-http', root: '/proj/svc-http', templateHash: 'h', lastUpdated: 1, status: 'registered',
      stage: 'dev', region: 'sa-east-1', apiPort: port,
      functions: [fnDef('fn'), fnDef('authFn')], routes, authorizers,
    });
    await gm.syncService(entry, true);
  }

  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers });

  const restRoute = (method: string, path: string, overrides: Partial<HttpRoute> = {}): HttpRoute =>
    ({ functionName: 'fn', method, path, eventType: 'http', cors: false, ...overrides });

  beforeEach(() => {
    (AuthorizerService as any).instance = undefined;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true, payload: { statusCode: 200, body: 'ok' }, logs: [], durationMs: 1 });
  });

  afterAll(() => {
    (FunctionRegistry as any).instance = undefined;
  });

  it('REST miss: 403 Missing Authentication Token with the REST error/request-id headers', async () => {
    await serve([restRoute('GET', '/users')]);
    for (const [method, path] of [['GET', '/nowhere'], ['POST', '/users']]) {
      const res = await call(method, path);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ message: 'Missing Authentication Token' });
      expect(res.headers.get('x-amzn-errortype')).toBe('MissingAuthenticationTokenException');
      expect(res.headers.get('x-amzn-requestid')).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('HTTP API miss: 404 Not Found with apigw-requestid', async () => {
    await serve([restRoute('GET', '/users', { eventType: 'httpApi' })]);
    const res = await call('GET', '/nowhere');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Not Found' });
    expect(res.headers.get('apigw-requestid')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('OPTIONS is only a gateway preflight when CORS is configured', async () => {
    await serve([restRoute('GET', '/open', { cors: true }), restRoute('GET', '/closed')]);
    const preflight = await call('OPTIONS', '/open', { origin: 'http://app.local' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://app.local');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('OPTIONS,GET');
    const plain = await call('OPTIONS', '/closed');
    expect(plain.status).toBe(403);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('without CORS an ANY route receives OPTIONS like any other method', async () => {
    await serve([restRoute('ANY', '/any')]);
    const res = await call('OPTIONS', '/any');
    expect(res.status).toBe(200);
    expect(invokeMock.mock.calls[0][2].httpMethod).toBe('OPTIONS');
  });

  it('decodes the path once and shares one request id between the event and the response header', async () => {
    await serve([restRoute('GET', '/files/{name}')]);
    const res = await call('GET', '/files/a%2525b');
    expect(res.status).toBe(200);
    const event = invokeMock.mock.calls[0][2];
    expect(event.pathParameters).toEqual({ name: 'a%25b' });
    expect(event.path).toBe('/files/a%25b');
    expect(event.requestContext.requestId).toBe(res.headers.get('x-amzn-requestid'));
  });

  it('integration failures: REST 502, HTTP API 500', async () => {
    invokeMock.mockResolvedValue({ ok: false, errorType: 'Error', errorMessage: 'boom', logs: [], durationMs: 1 });
    await serve([restRoute('GET', '/rest'), restRoute('GET', '/v2', { eventType: 'httpApi' })]);
    const rest = await call('GET', '/rest');
    expect(rest.status).toBe(502);
    expect(await rest.json()).toEqual({ message: 'Internal server error' });
    const v2 = await call('GET', '/v2');
    expect(v2.status).toBe(500);
    expect(await v2.json()).toEqual({ message: 'Internal Server Error' });
  });

  it('REST authorizer: policy checked against the methodArn (service region), throw "Unauthorized" → 401', async () => {
    const auth: AuthorizerConfig = {
      name: 'fn:auth', type: 'token', eventType: 'http', payloadVersion: '1.0', enableSimpleResponses: false,
      identitySource: ['method.request.header.Authorization'], resultTtlInSeconds: 0, functionName: 'authFn',
    };
    await serve([restRoute('GET', '/secure/{id}', { authorizerName: 'fn:auth' })], [auth]);

    invokeMock.mockImplementation(async (_svc: string, fn: RegisteredFunction, event: any) => {
      if (fn.name !== 'authFn') return { ok: true, payload: { statusCode: 200, body: 'in' }, logs: [], durationMs: 1 };
      if (event.authorizationToken === 'throw') return { ok: false, errorType: 'Error', errorMessage: 'Unauthorized', logs: [], durationMs: 1 };
      return {
        ok: true,
        payload: { principalId: 'u', policyDocument: { Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: '*/GET/secure/1' }] } },
        logs: [], durationMs: 1,
      };
    });

    const allowed = await call('GET', '/secure/1', { authorization: 'ok' });
    expect(allowed.status).toBe(200);
    const authEvent = invokeMock.mock.calls.find(c => c[1].name === 'authFn')![2];
    expect(authEvent.methodArn).toBe('arn:aws:execute-api:sa-east-1:000000000000:lss-local/dev/GET/secure/1');

    const denied = await call('GET', '/secure/2', { authorization: 'ok' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ Message: 'User is not authorized to access this resource' });

    const thrown = await call('GET', '/secure/1', { authorization: 'throw' });
    expect(thrown.status).toBe(401);
    expect(await thrown.json()).toEqual({ message: 'Unauthorized' });
  });
  describe('API keys (REST, private routes)', () => {
    const plan = (stage: string, apiId = LOCAL_API_ID) => ({ id: 'p1', name: 'basic', apiStages: [{ apiId, stage }] });
    const key = (overrides: Partial<ResolvedApiKey> = {}): ResolvedApiKey =>
      ({ id: 'k1abc', name: 'partner-acme', enabled: true, usagePlans: [plan('dev')], ...overrides });
    const keys: Record<string, ResolvedApiKey> = {
      'good-key': key(),
      'off-key': key({ id: 'k2', enabled: false }),
      'lonely-key': key({ id: 'k3', usagePlans: [] }),
      'empty-plan-key': key({ id: 'k4', usagePlans: [{ id: 'p0', name: 'nothing', apiStages: [] }] }),
      'prod-key': key({ id: 'k5', usagePlans: [plan('prod')] }),
      'other-api-key': key({ id: 'k6', usagePlans: [plan('dev', 'restapi-xyz')] }),
    };
    let lookup: jest.Mock;

    beforeEach(() => {
      lookup = jest.fn(async (_region: string, value: string) => keys[value]);
      gm.apiKeyLookup = lookup;
    });

    const expectForbidden = async (res: Response) => {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ message: 'Forbidden' });
      expect(res.headers.get('x-amzn-errortype')).toBe('ForbiddenException');
      expect(res.headers.get('x-amzn-requestid')).toMatch(/^[0-9a-f-]{36}$/);
    };

    it('HEADER: missing, unknown, disabled, plan-less and wrong-stage keys → 403; a covered key reaches the handler', async () => {
      await serve([restRoute('GET', '/items', { apiKeyRequired: true, apiKeySourceType: 'HEADER' }), restRoute('GET', '/open')]);

      await expectForbidden(await call('GET', '/items'));
      for (const value of ['nope', 'off-key', 'lonely-key', 'empty-plan-key', 'prod-key', 'other-api-key']) {
        await expectForbidden(await call('GET', '/items', { 'X-Api-Key': value }));
      }
      expect(invokeMock).not.toHaveBeenCalled();

      const ok = await call('GET', '/items', { 'X-API-KEY': 'good-key' });
      expect(ok.status).toBe(200);
      expect(lookup).toHaveBeenLastCalledWith('sa-east-1', 'good-key');
      const event = invokeMock.mock.calls[0][2];
      expect(event.requestContext.identity).toEqual(expect.objectContaining({ apiKey: 'good-key', apiKeyId: 'k1abc' }));

      // A public route on the same API never asks for a key.
      const open = await call('GET', '/open');
      expect(open.status).toBe(200);
      expect(invokeMock.mock.calls[1][2].requestContext.identity.apiKey).toBeNull();
    });

    it('AUTHORIZER: the key is the authorizer\'s usageIdentifierKey; an authorizer deny wins before any key check', async () => {
      const auth: AuthorizerConfig = {
        name: 'fn:auth', type: 'token', eventType: 'http', payloadVersion: '1.0', enableSimpleResponses: false,
        identitySource: ['method.request.header.Authorization'], resultTtlInSeconds: 0, functionName: 'authFn',
      };
      await serve([restRoute('GET', '/items', { authorizerName: 'fn:auth', apiKeyRequired: true, apiKeySourceType: 'AUTHORIZER' })], [auth]);
      invokeMock.mockImplementation(async (_svc: string, fn: RegisteredFunction, event: any) => {
        if (fn.name !== 'authFn') return { ok: true, payload: { statusCode: 200, body: 'in' }, logs: [], durationMs: 1 };
        const effect = event.authorizationToken === 'deny' ? 'Deny' : 'Allow';
        return {
          ok: true,
          payload: {
            principalId: 'u',
            policyDocument: { Statement: [{ Effect: effect, Action: 'execute-api:Invoke', Resource: '*' }] },
            ...(event.authorizationToken === 'nokey' ? {} : { usageIdentifierKey: event.authorizationToken }),
          },
          logs: [], durationMs: 1,
        };
      });

      // Deny first: 403 AccessDenied, the key is never looked up.
      const denied = await call('GET', '/items', { authorization: 'deny', 'x-api-key': 'good-key' });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ Message: 'User is not authorized to access this resource with an explicit deny' });
      expect(lookup).not.toHaveBeenCalled();

      // Allowed but no usageIdentifierKey: the x-api-key header does not count.
      await expectForbidden(await call('GET', '/items', { authorization: 'nokey', 'x-api-key': 'good-key' }));
      await expectForbidden(await call('GET', '/items', { authorization: 'off-key' }));

      const ok = await call('GET', '/items', { authorization: 'good-key' });
      expect(ok.status).toBe(200);
      const event = invokeMock.mock.calls.find(c => c[1].name === 'fn')?.[2];
      expect(event.requestContext.identity).toEqual(expect.objectContaining({ apiKey: 'good-key', apiKeyId: 'k1abc' }));
    });

    it('the key check is live on every request: disabling a key 403s the next call despite a warm authorizer cache', async () => {
      const auth: AuthorizerConfig = {
        name: 'fn:auth', type: 'token', eventType: 'http', payloadVersion: '1.0', enableSimpleResponses: false,
        identitySource: ['method.request.header.Authorization'], resultTtlInSeconds: 300, functionName: 'authFn',
      };
      await serve([restRoute('GET', '/items', { authorizerName: 'fn:auth', apiKeyRequired: true, apiKeySourceType: 'AUTHORIZER' })], [auth]);
      invokeMock.mockImplementation(async (_svc: string, fn: RegisteredFunction) => {
        if (fn.name !== 'authFn') return { ok: true, payload: { statusCode: 200, body: 'in' }, logs: [], durationMs: 1 };
        return {
          ok: true,
          payload: { principalId: 'u', usageIdentifierKey: 'toggled-key', policyDocument: { Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: '*' }] } },
          logs: [], durationMs: 1,
        };
      });
      const toggled = key({ id: 'k7' });
      keys['toggled-key'] = toggled;
      try {
        expect((await call('GET', '/items', { authorization: 'tok' })).status).toBe(200);
        toggled.enabled = false;
        await expectForbidden(await call('GET', '/items', { authorization: 'tok' }));
        // The authorizer ran once (cache warm); the key was looked up both times.
        expect(invokeMock.mock.calls.filter(c => c[1].name === 'authFn')).toHaveLength(1);
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(lookup).toHaveBeenLastCalledWith('sa-east-1', 'toggled-key');
      } finally {
        delete keys['toggled-key'];
      }
    });

    it('HTTP API routes are untouched — no key check even if a route claims one', async () => {
      await serve([restRoute('GET', '/v2', { eventType: 'httpApi', apiKeyRequired: true })]);
      const res = await call('GET', '/v2');
      expect(res.status).toBe(200);
      expect(lookup).not.toHaveBeenCalled();
    });

    it('default lookup: without the engine\'s API Gateway control plane every key is unknown (403), warned once', async () => {
      const fresh = new GatewayManager();
      expect(await fresh.apiKeyLookup('us-east-1', 'good-key')).toBeUndefined();
      expect(await fresh.apiKeyLookup('us-east-1', 'good-key')).toBeUndefined();
      const warnings = warnSpy.mock.calls.filter(c => String(c[0]).includes('API Gateway control plane is not available'));
      expect(warnings).toHaveLength(1);
    });

    it('default lookup: reaches the engine\'s API Gateway control plane through EngineManager.getApiGateway()', async () => {
      const resolveApiKeyByValue = jest.fn().mockResolvedValue(key());
      const spy = jest
        .spyOn(EngineManager.prototype, 'getApiGateway')
        .mockReturnValue({ resolveApiKeyByValue } as never);
      try {
        expect(await new GatewayManager().apiKeyLookup('eu-west-1', 'good-key')).toEqual(key());
        expect(resolveApiKeyByValue).toHaveBeenCalledWith('eu-west-1', 'good-key');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
