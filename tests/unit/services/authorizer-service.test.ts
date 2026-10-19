// Unit tests for AuthorizerService. The LambdaRuntimeManager is jest.mocked
// (module factory — the real module forks worker processes and uses
// import.meta); the FunctionRegistry is the real one, reset per test, so
// local-function and cross-service ARN resolution run for real.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { AuthorizerService, evaluatePolicy } from '../../../src/server/services/authorizer-service';
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
  policyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: '*' }] },
  context: { plan: 'pro' },
};

// A policy for exactly one resource ARN (what `Resource: event.methodArn` yields).
function policyFor(resource: string | string[], effect = 'Allow') {
  return {
    principalId: 'user-1',
    policyDocument: { Statement: [{ Effect: effect, Action: 'execute-api:Invoke', Resource: resource }] },
  };
}

function answer(payload: unknown) {
  invokeMock.mockResolvedValue({ ok: true, payload, logs: [], durationMs: 1 });
}

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
    expect(decision).toEqual({ denial: 'UNAUTHORIZED' });
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
    expect(missing.denial).toBe('UNAUTHORIZED');
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
    expect(decision.denial).toBe('UNAUTHORIZED');
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
      methodArn: 'arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/GET/x',
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
        methodArn: 'arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/GET/x',
        resource: '/x',
        path: '/x',
        httpMethod: 'GET',
        headers: { authorization: 'tok', 'x-multi': 'm1,m2' },
        multiValueHeaders: { authorization: ['tok'], 'x-multi': ['m1', 'm2'] },
        queryStringParameters: { a: '1' },
        multiValueQueryStringParameters: { a: ['1'] },
        pathParameters: {},
        stageVariables: {},
      }),
    );
    expect(event.requestContext).toEqual(
      expect.objectContaining({
        stage: 'dev',
        identity: { sourceIp: '127.0.0.1', userAgent: null },
        resourcePath: '/x',
        domainName: 'localhost',
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
        routeArn: 'arn:aws:execute-api:us-east-1:000000000000:lss-local/offline/GET/x',
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

describe('authorizer event context', () => {
  const ctx = { region: 'eu-west-1', accountId: '111122223333', pathParameters: { id: '42' }, requestId: 'req-1' };
  const paramRoute: HttpRoute = { ...route, path: '/users/{id}' };

  it('REST TOKEN: methodArn carries the configured region and account', async () => {
    await service.authorize(
      'svc', 'dev', paramRoute,
      config({ eventType: 'http', type: 'token', payloadVersion: '1.0', identitySource: ['method.request.header.Authorization'] }),
      req({ path: '/users/42' }),
      ctx,
    );
    expect(invokeMock.mock.calls[0][2].methodArn).toBe('arn:aws:execute-api:eu-west-1:111122223333:lss-local/dev/GET/users/42');
  });

  it('REST REQUEST: path parameters, the shared requestId and request facts reach the event', async () => {
    service.now = () => 1_700_000_000_000;
    await service.authorize(
      'svc', 'dev', paramRoute,
      config({ eventType: 'http', type: 'request', payloadVersion: '1.0' }),
      req({ path: '/users/42', rawQueryString: 'a=1&a=2', headers: { authorization: 'tok', host: 'api.local', 'user-agent': 'jest', gone: undefined } }),
      ctx,
    );
    const event = invokeMock.mock.calls[0][2];
    expect(event.methodArn).toBe('arn:aws:execute-api:eu-west-1:111122223333:lss-local/dev/GET/users/42');
    expect(event.pathParameters).toEqual({ id: '42' });
    expect(event.multiValueQueryStringParameters).toEqual({ a: ['1', '2'] });
    expect(event.requestContext).toEqual(expect.objectContaining({
      accountId: '111122223333',
      requestId: 'req-1',
      requestTimeEpoch: 1_700_000_000_000,
      domainName: 'api.local',
      identity: { sourceIp: '127.0.0.1', userAgent: 'jest' },
      resourcePath: '/users/{id}',
    }));
  });

  it('HTTP API 2.0: pathParameters, stageVariables, cookies, raw path and the shared requestId', async () => {
    service.now = () => 1_700_000_000_000;
    await service.authorize(
      'svc', 'dev', { ...paramRoute, eventType: 'httpApi' },
      config(),
      req({ path: '/users/a b', rawPath: '/users/a%20b', headers: { authorization: 'tok', cookie: 's=1; t=2' } }),
      ctx,
    );
    const event = invokeMock.mock.calls[0][2];
    expect(event.routeArn).toBe('arn:aws:execute-api:eu-west-1:111122223333:lss-local/dev/GET/users/a b');
    expect(event.rawPath).toBe('/users/a%20b');
    expect(event.cookies).toEqual(['s=1', 't=2']);
    expect(event.pathParameters).toEqual({ id: '42' });
    expect(event.stageVariables).toEqual({});
    expect(event.requestContext).toEqual(expect.objectContaining({
      accountId: '111122223333',
      requestId: 'req-1',
      time: new Date(1_700_000_000_000).toISOString(),
      timeEpoch: 1_700_000_000_000,
    }));
  });

  it('defaults: us-east-1, the local account, a fresh requestId, empty path parameters, no cookies', async () => {
    await service.authorize('svc', 'dev', route, config(), req(), { pathParameters: null });
    const event = invokeMock.mock.calls[0][2];
    expect(event.routeArn).toBe('arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/GET/x');
    expect(event.rawPath).toBe('/x');
    expect(event.cookies).toBeUndefined();
    expect(event.pathParameters).toEqual({});
    expect(event.requestContext.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('policy evaluation against the methodArn', () => {
  const rest = config({ eventType: 'http', type: 'token', payloadVersion: '1.0', identitySource: ['method.request.header.Authorization'] });
  const arn = (method: string, p: string) => `arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/${method}${p}`;

  it('allows when an Allow statement covers the methodArn, with principalId and context', async () => {
    answer({ ...policyFor(arn('GET', '/x')), context: { plan: 'pro' } });
    const decision = await service.authorize('svc', 'dev', route, rest, req());
    expect(decision).toEqual({ authorizer: { principalId: 'user-1', context: { plan: 'pro' } } });
  });

  it('an Allow for another resource is an implicit deny (403, not an explicit deny)', async () => {
    answer(policyFor(arn('GET', '/other')));
    const decision = await service.authorize('svc', 'dev', route, rest, req());
    expect(decision).toEqual({ denial: 'ACCESS_DENIED', explicitDeny: false });
  });

  it('an applying Deny wins over an Allow', async () => {
    answer({
      principalId: 'u',
      policyDocument: {
        Statement: [
          { Effect: 'Allow', Action: 'execute-api:Invoke', Resource: '*' },
          { Effect: 'Deny', Action: ['execute-api:Invoke'], Resource: [arn('GET', '/x')] },
        ],
      },
    });
    const decision = await service.authorize('svc', 'dev', route, rest, req());
    expect(decision).toEqual({ denial: 'ACCESS_DENIED', explicitDeny: true });
  });

  it('accepts a single Statement object and defaults a non-string principalId / missing context', async () => {
    answer({ principalId: 42, policyDocument: { Statement: { Effect: 'ALLOW', Action: 'execute-api:*', Resource: arn('*', '/*') } } });
    const decision = await service.authorize('svc', 'dev', route, rest, req());
    expect(decision).toEqual({ authorizer: { principalId: undefined, context: {} } });
  });

  it('responds 500 (AuthorizerConfigurationException) on a malformed policy response', async () => {
    for (const payload of ['nonsense', null, [1], {}, { principalId: 'u' }, { policyDocument: 'x' }, { policyDocument: {} }, { policyDocument: { Statement: 'x' } }]) {
      invokeMock.mockResolvedValue({ ok: true, payload, logs: [], durationMs: 1 });
      const decision = await service.authorize('svc', 'dev', route, rest, req());
      expect(decision).toEqual({ denial: 'AUTHORIZER_CONFIGURATION_ERROR' });
    }
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('malformed response (keys: principalId)'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('malformed response (nonsense)'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('malformed response (keys: none)'));
  });

  it('HTTP API IAM-policy responses are evaluated against the routeArn too', async () => {
    answer(policyFor(arn('POST', '/x')));
    const decision = await service.authorize('svc', 'dev', route, config(), req());
    expect(decision).toEqual({ denial: 'ACCESS_DENIED', explicitDeny: false });
  });
});

describe('evaluatePolicy', () => {
  const methodArn = 'arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/GET/users/42';

  it('matches `*` across segments and `?` as one character', () => {
    const stmt = (Resource: unknown, Action: unknown = 'execute-api:Invoke', Effect: unknown = 'Allow') => [{ Effect, Action, Resource }];
    expect(evaluatePolicy(stmt('arn:aws:execute-api:*:*:lss-local/dev/*'), methodArn)).toBe('allow');
    expect(evaluatePolicy(stmt('arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/GET/users/4?'), methodArn)).toBe('allow');
    expect(evaluatePolicy(stmt('arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/GET/users/?'), methodArn)).toBe('implicit-deny');
    // Regex metacharacters in the pattern are literal.
    expect(evaluatePolicy(stmt('arn.aws.execute-api.*'), methodArn)).toBe('implicit-deny');
    // Resource is case-sensitive, Action is not.
    expect(evaluatePolicy(stmt(methodArn.replace('GET', 'get')), methodArn)).toBe('implicit-deny');
    expect(evaluatePolicy(stmt(methodArn, 'EXECUTE-API:invoke'), methodArn)).toBe('allow');
    expect(evaluatePolicy(stmt(methodArn, '*'), methodArn)).toBe('allow');
  });

  it('ignores statements with another action, no action/resource, a non-string entry or an unknown Effect', () => {
    expect(evaluatePolicy([{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }], methodArn)).toBe('implicit-deny');
    expect(evaluatePolicy([{ Effect: 'Allow', Resource: '*' }], methodArn)).toBe('implicit-deny');
    expect(evaluatePolicy([{ Effect: 'Allow', Action: 'execute-api:Invoke' }], methodArn)).toBe('implicit-deny');
    expect(evaluatePolicy([{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: [7, '*'] }], methodArn)).toBe('allow');
    expect(evaluatePolicy([{ Effect: 'Maybe', Action: '*', Resource: '*' }, {}], methodArn)).toBe('implicit-deny');
    expect(evaluatePolicy([null as never, 'x' as never], methodArn)).toBe('implicit-deny');
    expect(evaluatePolicy([], methodArn)).toBe('implicit-deny');
  });

  it('a Deny that does not apply leaves the Allow standing', () => {
    expect(evaluatePolicy([
      { Effect: 'Deny', Action: '*', Resource: '*/POST/*' },
      { Effect: 'Allow', Action: '*', Resource: '*' },
    ], methodArn)).toBe('allow');
  });
});

describe('simple responses (HTTP API)', () => {
  it('isAuthorized true passes the context through', async () => {
    answer({ isAuthorized: true, context: { k: 'v' } });
    const decision = await service.authorize('svc', 'dev', route, config({ enableSimpleResponses: true }), req());
    expect(decision).toEqual({ authorizer: { context: { k: 'v' } } });
  });

  it('missing or non-object context defaults to {}', async () => {
    answer({ isAuthorized: true, context: ['x'] });
    const decision = await service.authorize('svc', 'dev', route, config({ enableSimpleResponses: true }), req());
    expect(decision).toEqual({ authorizer: { context: {} } });
  });

  it('anything but isAuthorized === true is ACCESS_DENIED', async () => {
    answer({ isAuthorized: 'yes' });
    const decision = await service.authorize('svc', 'dev', route, config({ enableSimpleResponses: true }), req());
    expect(decision).toEqual({ denial: 'ACCESS_DENIED' });
  });

  it('a non-object payload is malformed (500)', async () => {
    answer(undefined);
    const decision = await service.authorize('svc', 'dev', route, config({ enableSimpleResponses: true }), req());
    expect(decision).toEqual({ denial: 'AUTHORIZER_CONFIGURATION_ERROR' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('expected {isAuthorized, context}'));
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
    expect(decision).toEqual({ denial: 'AUTHORIZER_CONFIGURATION_ERROR' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found in service "svc"'));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('responds 500 with a registration hint when an ARN is unregistered', async () => {
    const decision = await service.authorize(
      'svc', 'dev', route,
      config({ functionName: undefined, arn: 'arn:aws:lambda:us-east-1:000000000000:function:ghost' }),
      req(),
    );
    expect(decision.denial).toBe('AUTHORIZER_CONFIGURATION_ERROR');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('register the owning service'));
  });

  it('responds 500 when the config has neither functionName nor arn', async () => {
    const decision = await service.authorize('svc', 'dev', route, config({ functionName: undefined, arn: undefined }), req());
    expect(decision.denial).toBe('AUTHORIZER_CONFIGURATION_ERROR');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('REST: a failure with exactly "Unauthorized" is a 401; anything else a 500', async () => {
    const rest = config({ eventType: 'http', payloadVersion: '1.0' });
    invokeMock.mockResolvedValue({ ok: false, errorType: 'Error', errorMessage: 'Unauthorized', logs: [], durationMs: 1 });
    expect(await service.authorize('svc', 'dev', route, rest, req())).toEqual({ denial: 'UNAUTHORIZED' });

    invokeMock.mockResolvedValue({ ok: false, errorType: 'Error', errorMessage: 'unauthorized', logs: [], durationMs: 1 });
    expect(await service.authorize('svc', 'dev', route, rest, req())).toEqual({ denial: 'AUTHORIZER_CONFIGURATION_ERROR' });
  });

  it('HTTP API: every authorizer failure is a 500, "Unauthorized" included', async () => {
    invokeMock.mockResolvedValue({ ok: false, errorType: 'Error', errorMessage: 'Unauthorized', logs: [], durationMs: 1 });
    expect(await service.authorize('svc', 'dev', route, config(), req())).toEqual({ denial: 'AUTHORIZER_CONFIGURATION_ERROR' });
  });
});

describe('result caching', () => {
  const rest = (overrides: Partial<AuthorizerConfig> = {}) => config({
    eventType: 'http', type: 'token', payloadVersion: '1.0',
    identitySource: ['method.request.header.Authorization'], resultTtlInSeconds: 300, ...overrides,
  });
  let clock: number;
  beforeEach(() => {
    clock = 1_000_000;
    service.now = () => clock;
  });

  it('caches for resultTtlInSeconds and counts hits and misses', async () => {
    const cfg = rest();
    const first = await service.authorize('svc', 'dev', route, cfg, req());
    const second = await service.authorize('svc', 'dev', route, cfg, req());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(service.getCacheStats()).toEqual({ entries: 1, hits: 1, misses: 1 });
  });

  it('re-invokes once the TTL has elapsed (injected clock)', async () => {
    const cfg = rest();
    await service.authorize('svc', 'dev', route, cfg, req());
    clock += 299_999;
    await service.authorize('svc', 'dev', route, cfg, req());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(service.getCacheStats().entries).toBe(0); // expired entries are not live
    await service.authorize('svc', 'dev', route, cfg, req());
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(service.getCacheStats()).toEqual({ entries: 1, hits: 1, misses: 2 });
  });

  it('caches the POLICY: a cached Allow for one methodArn denies another route (as AWS does)', async () => {
    answer(policyFor('arn:aws:execute-api:us-east-1:000000000000:lss-local/dev/GET/x'));
    const cfg = rest();
    expect((await service.authorize('svc', 'dev', route, cfg, req())).authorizer).toBeDefined();
    const other = await service.authorize('svc', 'dev', { ...route, path: '/y' }, cfg, req({ path: '/y' }));
    expect(other).toEqual({ denial: 'ACCESS_DENIED', explicitDeny: false });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('one cache per authorizer: routes registering the same authorizer under per-route names share it', async () => {
    await service.authorize('svc', 'dev', route, rest({ name: 'fnA:auth' }), req());
    await service.authorize('svc', 'dev', { ...route, functionName: 'fnB' }, rest({ name: 'fnB:auth' }), req());
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // …but another API (service) or another identity source is its own cache.
    await service.authorize('svc-2', 'dev', route, rest({ name: 'fnA:auth' }), req());
    await service.authorize('svc', 'dev', route, rest({ identitySource: ['method.request.header.X-Token'] }), req({ headers: { 'x-token': 'tok' } }));
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it('different identity values get their own cache entries', async () => {
    await service.authorize('svc', 'dev', route, rest(), req({ headers: { authorization: 'a' } }));
    await service.authorize('svc', 'dev', route, rest(), req({ headers: { authorization: 'b' } }));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('never caches failures or malformed answers', async () => {
    invokeMock.mockResolvedValue({ ok: false, errorType: 'Error', errorMessage: 'Unauthorized', logs: [], durationMs: 1 });
    await service.authorize('svc', 'dev', route, rest(), req());
    answer('garbage');
    await service.authorize('svc', 'dev', route, rest(), req());
    expect(service.getCacheStats().entries).toBe(0);
  });

  it('resultTtlInSeconds 0 disables caching and counts neither hits nor misses', async () => {
    const cfg = rest({ resultTtlInSeconds: 0 });
    await service.authorize('svc', 'dev', route, cfg, req());
    await service.authorize('svc', 'dev', route, cfg, req());
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(service.clearCache()).toBe(0);
    expect(service.getCacheStats()).toEqual({ entries: 0, hits: 0, misses: 0 });
  });
});

describe('clearCache', () => {
  // Seed one cached answer per (service, authorizer) pair; distinct targets
  // keep the two authorizers of svc-1 apart.
  async function seed() {
    FunctionRegistry.getInstance().registerService({
      name: 'svc-1', root: '/abs/svc-1', templateHash: 'h', lastUpdated: 1, status: 'registered',
      functions: [fn('authFn', 'svc-1-dev-authFn'), fn('authFn2', 'svc-1-dev-authFn2')],
    });
    FunctionRegistry.getInstance().registerService({
      name: 'svc-2', root: '/abs/svc-2', templateHash: 'h', lastUpdated: 1, status: 'registered',
      functions: [fn('authFn', 'svc-2-dev-authFn')],
    });
    await service.authorize('svc-1', 'dev', route, config({ name: 'users:auth-a', resultTtlInSeconds: 60 }), req());
    await service.authorize('svc-1', 'dev', route, config({ name: 'auth-b', functionName: 'authFn2', resultTtlInSeconds: 60 }), req());
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

  it('clears by authorizer name across services — full or bare per-route name', async () => {
    await seed();
    expect(service.clearCache({ authorizer: 'auth-a' })).toBe(2);
    expect(service.clearCache()).toBe(1); // svc-1/auth-b remains
  });

  it('clears by service + authorizer, matching a name learned on a cache hit', async () => {
    await seed();
    // A second route hits svc-1's auth-a cache under its own per-route name.
    await service.authorize('svc-1', 'dev', route, config({ name: 'orders:auth-a', resultTtlInSeconds: 60 }), req());
    expect(service.clearCache({ service: 'svc-1', authorizer: 'orders:auth-a' })).toBe(1);
    expect(service.clearCache({ service: 'svc-1', authorizer: 'nope' })).toBe(0);
    expect(service.clearCache()).toBe(2);
  });
});

describe('usageIdentifierKey (AUTHORIZER-sourced API keys)', () => {
  const rest = config({
    eventType: 'http', type: 'token', payloadVersion: '1.0',
    identitySource: ['method.request.header.Authorization'], resultTtlInSeconds: 300,
  });

  it('hands the key back with the authorizer output and caches it together with the policy', async () => {
    answer({ ...ALLOW_POLICY, usageIdentifierKey: 'key-value-1' });
    const first = await service.authorize('svc', 'dev', route, rest, req());
    const cached = await service.authorize('svc', 'dev', route, rest, req());
    expect(first.authorizer).toEqual({ principalId: 'user-1', context: { plan: 'pro' }, usageIdentifierKey: 'key-value-1' });
    expect(cached).toEqual(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty or non-string usageIdentifierKey', async () => {
    for (const usageIdentifierKey of ['', 42]) {
      service.clearCache();
      answer({ ...ALLOW_POLICY, usageIdentifierKey });
      const decision = await service.authorize('svc', 'dev', route, rest, req());
      expect(decision.authorizer).toEqual({ principalId: 'user-1', context: { plan: 'pro' } });
    }
  });
});
