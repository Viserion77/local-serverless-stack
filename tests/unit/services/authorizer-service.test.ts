// Unit tests for AuthorizerService. The LambdaRuntimeManager is jest.mocked
// (module factory — the real module forks worker processes and uses
// import.meta); the FunctionRegistry is the real one, reset per test, so
// local-function and cross-service ARN resolution run for real.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { AuthorizerService } from '../../../src/server/services/authorizer-service';
import { FunctionRegistry } from '../../../src/server/services/function-registry';
import { LambdaRuntimeManager } from '../../../src/server/services/lambda-runtime-manager';
import type { AuthorizerConfig, HttpRoute, RegisteredFunction } from '../../../src/server/services/serverless-state-parser';
import type { IncomingRequest } from '../../../src/server/services/api-gateway-events';

const invokeMock = LambdaRuntimeManager.getInstance().invoke as jest.Mock;

function fn(name: string, fullName: string): RegisteredFunction {
  return { name, fullName, handler: 'h', runtime: 'nodejs20.x', memorySize: 128, timeout: 6, environment: {}, triggers: [] };
}

function config(overrides: Partial<AuthorizerConfig> = {}): AuthorizerConfig {
  return {
    name: 'auth',
    type: 'request',
    eventType: 'httpApi',
    payloadVersion: '2.0',
    enableSimpleResponses: false,
    identitySource: ['$request.header.authorization'],
    resultTtlInSeconds: 0,
    functionName: 'authFn',
    ...overrides,
  };
}

function req(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    method: 'get',
    path: '/x',
    rawQueryString: '',
    headers: { authorization: 'tok' },
    body: null,
    sourceIp: '127.0.0.1',
    ...overrides,
  };
}

const route: HttpRoute = { functionName: 'fn', method: 'GET', path: '/x', eventType: 'httpApi', cors: false };

const ALLOW_POLICY = {
  principalId: 'user-1',
  policyDocument: { Statement: [{ Effect: 'Allow' }] },
  context: { plan: 'pro' },
};

let service: AuthorizerService;

beforeEach(() => {
  (AuthorizerService as any).instance = undefined;
  (FunctionRegistry as any).instance = undefined;
  service = AuthorizerService.getInstance();

  const registry = FunctionRegistry.getInstance();
  registry.registerService({
    name: 'svc',
    root: '/abs/svc',
    templateHash: 'h',
    lastUpdated: 1,
    status: 'registered',
    functions: [fn('authFn', 'svc-dev-authFn')],
  });
  registry.registerService({
    name: 'other',
    root: '/abs/other',
    templateHash: 'h',
    lastUpdated: 1,
    status: 'registered',
    functions: [fn('auth', 'other-dev-auth')],
  });

  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ ok: true, payload: ALLOW_POLICY, logs: [], durationMs: 1 });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getInstance', () => {
  it('returns the same instance on repeated calls (singleton)', () => {
    expect(AuthorizerService.getInstance()).toBe(service);
  });
});

describe('identity source extraction', () => {
  it('responds 401 without invoking when the identity source is missing', async () => {
    const decision = await service.authorize('svc', 'dev', route, config(), req({ headers: {} }));
    expect(decision).toEqual({ deniedStatus: 401, message: 'Unauthorized' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('extracts $request.header values case-insensitively', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({ identitySource: ['$REQUEST.header.Authorization'] }),
      req({ headers: { authorization: 'abc' } }),
    );
    expect(decision.authorizer).toBeDefined();
    const event = invokeMock.mock.calls[0][2];
    expect(event.identitySource).toEqual(['abc']);
  });

  it('extracts $request.querystring values and 401s when absent', async () => {
    const ok = await service.authorize(
      'svc', 'dev', route,
      config({ identitySource: ['$request.querystring.token'] }),
      req({ rawQueryString: 'token=t1' }),
    );
    expect(ok.authorizer).toBeDefined();

    const missing = await service.authorize(
      'svc', 'dev', route,
      config({ identitySource: ['$request.querystring.token'] }),
      req({ rawQueryString: 'other=1' }),
    );
    expect(missing.deniedStatus).toBe(401);
  });

  it('extracts method.request.header and method.request.querystring values', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({
        payloadVersion: '1.0',
        identitySource: ['method.request.header.code', 'method.request.querystring.key'],
      }),
      req({ headers: { code: 'c1' }, rawQueryString: 'key=k1' }),
    );
    expect(decision.authorizer).toBeDefined();
    // v1 REQUEST event (payloadVersion 1.0) — identity values fed the cache key.
    expect(invokeMock.mock.calls[0][2].type).toBe('REQUEST');
  });

  it('missing method.request.querystring value → 401', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({ identitySource: ['method.request.querystring.key'] }),
      req({ rawQueryString: '' }),
    );
    expect(decision.deniedStatus).toBe(401);
  });

  it('falls back to a bare header name and picks the first array value', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({ identitySource: ['X-Api-Key'] }),
      req({ headers: { 'x-api-key': ['first', 'second'] } }),
    );
    expect(decision.authorizer).toBeDefined();
    expect(invokeMock.mock.calls[0][2].identitySource).toEqual(['first']);
  });
});

describe('authorizer event shapes', () => {
  it('builds a v1 TOKEN event for REST token authorizers', async () => {
    await service.authorize(
      'svc', 'dev', route,
      config({ eventType: 'http', type: 'token', payloadVersion: '1.0', identitySource: ['method.request.header.Authorization'] }),
      req(),
    );
    expect(invokeMock.mock.calls[0][2]).toEqual({
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:local:000000000000:lss-local/dev/GET/x',
      authorizationToken: 'tok',
    });
  });

  it('builds a v1 REQUEST event for REST request authorizers', async () => {
    await service.authorize(
      'svc', 'dev', route,
      config({ eventType: 'http', type: 'request', payloadVersion: '1.0' }),
      req({ rawQueryString: 'a=1', headers: { authorization: 'tok', 'x-multi': ['m1', 'm2'] } }),
    );
    const event = invokeMock.mock.calls[0][2];
    expect(event).toEqual(
      expect.objectContaining({
        type: 'REQUEST',
        methodArn: 'arn:aws:execute-api:local:000000000000:lss-local/dev/GET/x',
        resource: '/x',
        path: '/x',
        httpMethod: 'GET',
        headers: { authorization: 'tok', 'x-multi': 'm1,m2' },
        queryStringParameters: { a: '1' },
        pathParameters: {},
        stageVariables: {},
      }),
    );
    expect(event.requestContext).toEqual(
      expect.objectContaining({
        stage: 'dev',
        identity: { sourceIp: '127.0.0.1' },
        resourcePath: '/x',
      }),
    );
  });

  it('builds a v1 REQUEST event for httpApi authorizers declared with payload 1.0', async () => {
    await service.authorize('svc', 'dev', route, config({ payloadVersion: '1.0' }), req());
    expect(invokeMock.mock.calls[0][2].type).toBe('REQUEST');
    expect(invokeMock.mock.calls[0][2].version).toBeUndefined();
  });

  it('builds a v2 payload 2.0 event with identitySource and routeKey', async () => {
    await service.authorize(
      'svc', 'offline', route,
      config(),
      req({ rawQueryString: 'q=1', headers: { authorization: 'tok', host: 'api.local', 'user-agent': 'jest' } }),
    );
    const event = invokeMock.mock.calls[0][2];
    expect(event).toEqual(
      expect.objectContaining({
        version: '2.0',
        type: 'REQUEST',
        routeArn: 'arn:aws:execute-api:local:000000000000:lss-local/offline/GET/x',
        identitySource: ['tok'],
        routeKey: 'GET /x',
        rawPath: '/x',
        rawQueryString: 'q=1',
        queryStringParameters: { q: '1' },
      }),
    );
    expect(event.requestContext).toEqual(
      expect.objectContaining({
        domainName: 'api.local',
        http: expect.objectContaining({ method: 'GET', sourceIp: '127.0.0.1', userAgent: 'jest' }),
        routeKey: 'GET /x',
        stage: 'offline',
      }),
    );
  });

  it('uses $default as the routeKey and host/user-agent fallbacks', async () => {
    const defaultRoute: HttpRoute = { ...route, path: '$default', method: 'ANY' };
    await service.authorize('svc', 'dev', defaultRoute, config(), req({ headers: { authorization: 'tok', gone: undefined } }));
    const event = invokeMock.mock.calls[0][2];
    expect(event.routeKey).toBe('$default');
    expect(event.requestContext.domainName).toBe('localhost');
    expect(event.requestContext.http.userAgent).toBe('');
    expect(event.headers).toEqual({ authorization: 'tok' }); // undefined header skipped
  });
});

describe('result interpretation', () => {
  it('authorizes on an Allow policy statement with principalId and context', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      payload: {
        principalId: 'user-1',
        policyDocument: { Statement: [{ Effect: 'Deny' }, { Effect: 'ALLOW' }] },
        context: { plan: 'pro' },
      },
      logs: [],
      durationMs: 1,
    });
    const decision = await service.authorize('svc', 'dev', route, config(), req());
    expect(decision).toEqual({ authorizer: { principalId: 'user-1', context: { plan: 'pro' } } });
  });

  it('defaults principalId/context when absent from an Allow response', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      payload: { principalId: 42, policyDocument: { Statement: [{ Effect: 'Allow' }] } },
      logs: [],
      durationMs: 1,
    });
    const decision = await service.authorize('svc', 'dev', route, config(), req());
    expect(decision).toEqual({ authorizer: { principalId: undefined, context: {} } });
  });

  it('denies with 403 on an explicit Deny / missing policyDocument / missing Statement', async () => {
    for (const payload of [
      { policyDocument: { Statement: [{ Effect: 'Deny' }] } },
      { principalId: 'u' }, // no policyDocument at all
      { policyDocument: {} }, // no Statement list
      { policyDocument: { Statement: [{}] } }, // statement without Effect
    ]) {
      invokeMock.mockResolvedValue({ ok: true, payload, logs: [], durationMs: 1 });
      const decision = await service.authorize('svc', 'dev', route, config(), req());
      expect(decision.deniedStatus).toBe(403);
      expect(decision.message).toContain('explicit deny');
    }
  });

  it('responds 500 when the payload is not an object', async () => {
    invokeMock.mockResolvedValue({ ok: true, payload: 'nonsense', logs: [], durationMs: 1 });
    const decision = await service.authorize('svc', 'dev', route, config(), req());
    expect(decision).toEqual({ deniedStatus: 500, message: 'Internal Server Error' });
  });

  it('simple responses: isAuthorized true passes the context through', async () => {
    invokeMock.mockResolvedValue({ ok: true, payload: { isAuthorized: true, context: { k: 'v' } }, logs: [], durationMs: 1 });
    const decision = await service.authorize('svc', 'dev', route, config({ enableSimpleResponses: true }), req());
    expect(decision).toEqual({ authorizer: { context: { k: 'v' } } });
  });

  it('simple responses: missing context defaults to {}', async () => {
    invokeMock.mockResolvedValue({ ok: true, payload: { isAuthorized: true }, logs: [], durationMs: 1 });
    const decision = await service.authorize('svc', 'dev', route, config({ enableSimpleResponses: true }), req());
    expect(decision).toEqual({ authorizer: { context: {} } });
  });

  it('simple responses: anything but isAuthorized === true is a 403', async () => {
    invokeMock.mockResolvedValue({ ok: true, payload: { isAuthorized: 'yes' }, logs: [], durationMs: 1 });
    const decision = await service.authorize('svc', 'dev', route, config({ enableSimpleResponses: true }), req());
    expect(decision).toEqual({ deniedStatus: 403, message: 'Forbidden' });
  });
});

describe('target resolution and invocation failures', () => {
  it('resolves cross-service ARNs through the registry', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({ functionName: undefined, arn: 'arn:aws:lambda:us-east-1:000000000000:function:other-dev-auth' }),
      req(),
    );
    expect(decision.authorizer).toBeDefined();
    expect(invokeMock).toHaveBeenCalledWith('other', expect.objectContaining({ fullName: 'other-dev-auth' }), expect.anything());
  });

  it('responds 500 when the local authorizer function is missing', async () => {
    const decision = await service.authorize('svc', 'dev', route, config({ functionName: 'ghost' }), req());
    expect(decision).toEqual({ deniedStatus: 500, message: 'Internal Server Error' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found in service "svc"'));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('responds 500 with a registration hint when an ARN is unregistered', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({ functionName: undefined, arn: 'arn:aws:lambda:us-east-1:000000000000:function:ghost' }),
      req(),
    );
    expect(decision.deniedStatus).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('register the owning service'));
  });

  it('responds 500 when the config has neither functionName nor arn', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({ functionName: undefined, arn: undefined }),
      req(),
    );
    expect(decision.deniedStatus).toBe(500);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('responds 500 when the runtime invoke fails', async () => {
    invokeMock.mockResolvedValue({ ok: false, errorType: 'Handler', errorMessage: 'boom', logs: [], durationMs: 1 });
    const decision = await service.authorize('svc', 'dev', route, config(), req());
    expect(decision).toEqual({ deniedStatus: 500, message: 'Internal Server Error' });
  });
});

describe('result caching', () => {
  it('caches decisions for resultTtlInSeconds > 0 (second call skips the invoke)', async () => {
    const cfg = config({ resultTtlInSeconds: 300 });
    const first = await service.authorize('svc', 'dev', route, cfg, req());
    const second = await service.authorize('svc', 'dev', route, cfg, req());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('re-invokes when the cached entry has expired', async () => {
    const cfg = config({ resultTtlInSeconds: 300 });
    await service.authorize('svc', 'dev', route, cfg, req());
    for (const entry of (service as any).cache.values()) entry.expiresAt = Date.now() - 1;
    await service.authorize('svc', 'dev', route, cfg, req());
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('different identity values get their own cache entries', async () => {
    const cfg = config({ resultTtlInSeconds: 300 });
    await service.authorize('svc', 'dev', route, cfg, req({ headers: { authorization: 'a' } }));
    await service.authorize('svc', 'dev', route, cfg, req({ headers: { authorization: 'b' } }));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache when resultTtlInSeconds is 0', async () => {
    const cfg = config({ resultTtlInSeconds: 0 });
    await service.authorize('svc', 'dev', route, cfg, req());
    await service.authorize('svc', 'dev', route, cfg, req());
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(service.clearCache()).toBe(0);
  });
});

describe('clearCache', () => {
  // Seed one cached decision per (service, authorizer) pair.
  async function seed() {
    await service.authorize('svc-1', 'dev', route, config({ name: 'auth-a', resultTtlInSeconds: 60 }), req());
    await service.authorize('svc-1', 'dev', route, config({ name: 'auth-b', resultTtlInSeconds: 60 }), req());
    await service.authorize('svc-2', 'dev', route, config({ name: 'auth-a', resultTtlInSeconds: 60 }), req());
  }

  it('clears everything when called without a filter and reports the count', async () => {
    await seed();
    expect(service.clearCache()).toBe(3);
    expect(service.clearCache()).toBe(0);
  });

  it('treats an empty filter object as "clear all"', async () => {
    await seed();
    expect(service.clearCache({})).toBe(3);
  });

  it('clears by service', async () => {
    await seed();
    expect(service.clearCache({ service: 'svc-1' })).toBe(2);
    expect(service.clearCache()).toBe(1); // svc-2 entry remains
  });

  it('clears by authorizer name across services', async () => {
    await seed();
    expect(service.clearCache({ authorizer: 'auth-a' })).toBe(2);
    expect(service.clearCache()).toBe(1); // svc-1/auth-b remains
  });

  it('clears by service + authorizer', async () => {
    await seed();
    expect(service.clearCache({ service: 'svc-1', authorizer: 'auth-a' })).toBe(1);
    expect(service.clearCache()).toBe(2);
  });
});
