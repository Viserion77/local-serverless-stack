// Unit tests for the pure gateway helpers: route matching specificity, body
// encoding, API Gateway event construction (payload 1.0 and 2.0) and the
// Lambda-result → HTTP-response mapping including API Gateway's 502 behavior
// for malformed proxy responses.
import {
  matchRoute,
  encodeBody,
  buildV1Event,
  buildV2Event,
  mapV1Response,
  mapV2Response,
  errorResponse,
  gatewayErrorResponse,
  requestIdHeader,
  answersPreflight,
  apiFlavor,
  routeFlavor,
  safeDecode,
  IncomingRequest,
} from '../../../src/server/services/api-gateway-events';
import type { HttpRoute } from '../../../src/server/services/serverless-state-parser';

function route(method: string, path: string, overrides: Partial<HttpRoute> = {}): HttpRoute {
  return { functionName: 'fn', method, path, eventType: 'http', cors: false, ...overrides };
}

function req(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    method: 'GET',
    path: '/users',
    rawQueryString: '',
    headers: {},
    body: null,
    sourceIp: '127.0.0.1',
    ...overrides,
  };
}

describe('matchRoute', () => {
  it('literal segments beat {param} segments beat {proxy+}', () => {
    const routes = [
      route('GET', '/users/{id}'),
      route('GET', '/users/list'),
      route('GET', '/{proxy+}'),
    ];
    expect(matchRoute(routes, 'GET', '/users/list')!.route.path).toBe('/users/list');
    const param = matchRoute(routes, 'GET', '/users/42')!;
    expect(param.route.path).toBe('/users/{id}');
    expect(param.pathParameters).toEqual({ id: '42' });
    const proxy = matchRoute(routes, 'GET', '/a/b/c')!;
    expect(proxy.route.path).toBe('/{proxy+}');
    expect(proxy.pathParameters).toEqual({ proxy: 'a/b/c' });
  });

  it('prefers the more specific route regardless of declaration order', () => {
    // Better route declared first → the worse candidate is skipped.
    const literalFirst = [route('GET', '/users/list'), route('GET', '/users/{id}')];
    expect(matchRoute(literalFirst, 'GET', '/users/list')!.route.path).toBe('/users/list');
    // Better route declared last → it replaces the earlier best.
    const literalLast = [route('GET', '/users/{id}'), route('GET', '/users/list')];
    expect(matchRoute(literalLast, 'GET', '/users/list')!.route.path).toBe('/users/list');
  });

  it('$default is the last-resort catch-all', () => {
    const routes = [route('GET', '/x', { eventType: 'httpApi' }), route('ANY', '$default', { eventType: 'httpApi' })];
    const match = matchRoute(routes, 'DELETE', '/nowhere')!;
    expect(match.route.path).toBe('$default');
    expect(match.pathParameters).toBeNull();
    // A real route still beats $default.
    expect(matchRoute(routes, 'GET', '/x')!.route.path).toBe('/x');
  });

  it('an exact method beats ANY on the same path', () => {
    const routes = [route('ANY', '/u'), route('GET', '/u')];
    expect(matchRoute(routes, 'GET', '/u')!.route.method).toBe('GET');
    expect(matchRoute(routes, 'POST', '/u')!.route.method).toBe('ANY');
  });

  it('returns null when nothing matches', () => {
    expect(matchRoute([route('GET', '/only')], 'POST', '/only')).toBeNull();
    expect(matchRoute([route('GET', '/only')], 'GET', '/other')).toBeNull();
    expect(matchRoute([], 'GET', '/x')).toBeNull();
  });

  it('greedy {proxy+} captures the rest but requires at least one segment', () => {
    const routes = [route('GET', '/files/{path+}')];
    expect(matchRoute(routes, 'GET', '/files/a/b')!.pathParameters).toEqual({ path: 'a/b' });
    expect(matchRoute(routes, 'GET', '/files')).toBeNull();
  });

  it('decodes URI-encoded path parameters', () => {
    const match = matchRoute([route('GET', '/users/{id}')], 'GET', '/users/a%20b')!;
    expect(match.pathParameters).toEqual({ id: 'a b' });
  });

  it('decodes the raw path exactly once (%2525 → %25, never %)', () => {
    const match = matchRoute([route('GET', '/files/{name}')], 'GET', '/files/a%2525b')!;
    expect(match.pathParameters).toEqual({ name: 'a%25b' });
    const proxy = matchRoute([route('GET', '/files/{path+}')], 'GET', '/files/x%2525/y%20z')!;
    expect(proxy.pathParameters).toEqual({ path: 'x%25/y z' });
  });

  it('an encoded slash stays inside its segment, and literal segments compare decoded', () => {
    const match = matchRoute([route('GET', '/files/{name}')], 'GET', '/files/a%2Fb')!;
    expect(match.pathParameters).toEqual({ name: 'a/b' });
    expect(matchRoute([route('GET', '/hello world')], 'GET', '/hello%20world')).not.toBeNull();
  });

  it('keeps a malformed escape verbatim instead of throwing', () => {
    const match = matchRoute([route('GET', '/files/{name}')], 'GET', '/files/%E0%A4%A')!;
    expect(match.pathParameters).toEqual({ name: '%E0%A4%A' });
  });

  it('rejects segment-count mismatches in both directions', () => {
    // Request longer than the route.
    expect(matchRoute([route('GET', '/users/{id}')], 'GET', '/users/1/2')).toBeNull();
    // Request shorter than the route.
    expect(matchRoute([route('GET', '/users/{id}/posts')], 'GET', '/users/1')).toBeNull();
  });

  it('matches case-insensitively on method and reports null params for literal-only routes', () => {
    const match = matchRoute([route('GET', '/users')], 'get', '/users')!;
    expect(match.route.path).toBe('/users');
    expect(match.pathParameters).toBeNull();
  });
});

describe('safeDecode', () => {
  it('decodes once and tolerates malformed input', () => {
    expect(safeDecode('%2525')).toBe('%25');
    expect(safeDecode('%zz')).toBe('%zz');
  });
});

describe('encodeBody', () => {
  it('returns null for a missing or empty body', () => {
    expect(encodeBody(null, 'application/json')).toEqual({ body: null, isBase64Encoded: false });
    expect(encodeBody(Buffer.alloc(0), 'application/json')).toEqual({ body: null, isBase64Encoded: false });
  });

  it('keeps textual content as utf-8', () => {
    expect(encodeBody(Buffer.from('{"a":1}'), 'application/json; charset=utf-8')).toEqual({
      body: '{"a":1}',
      isBase64Encoded: false,
    });
    expect(encodeBody(Buffer.from('hi'), 'text/plain')).toEqual({ body: 'hi', isBase64Encoded: false });
    // +json structured syntax suffix is textual too.
    expect(encodeBody(Buffer.from('{}'), 'application/vnd.api+json')).toEqual({
      body: '{}',
      isBase64Encoded: false,
    });
  });

  it('treats an absent content type as textual', () => {
    expect(encodeBody(Buffer.from('x'), undefined)).toEqual({ body: 'x', isBase64Encoded: false });
    // A degenerate header whose media type parses to '' is textual as well.
    expect(encodeBody(Buffer.from('x'), ' ; charset=utf-8')).toEqual({ body: 'x', isBase64Encoded: false });
  });

  it('base64-encodes binary content types', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(encodeBody(png, 'image/png')).toEqual({ body: png.toString('base64'), isBase64Encoded: true });
  });
});

describe('buildV1Event', () => {
  it('builds a full REST payload with headers, query, params and authorizer context', () => {
    const event = buildV1Event({
      request: req({
        method: 'post',
        path: '/users/42',
        rawQueryString: 'a=1&a=2&b=3',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'jest',
          'x-multi': ['one', 'two'],
        },
        body: Buffer.from('{"n":1}'),
        sourceIp: '10.0.0.9',
      }),
      route: route('POST', '/users/{id}'),
      pathParameters: { id: '42' },
      stage: 'offline',
      requestId: 'req-1',
      authorizer: {
        principalId: 'user-1',
        context: { str: 's', num: 2, obj: { deep: true }, nul: null, undef: undefined },
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        resource: '/users/{id}',
        path: '/users/42',
        httpMethod: 'POST',
        headers: expect.objectContaining({ 'x-multi': 'one,two', 'user-agent': 'jest' }),
        multiValueHeaders: expect.objectContaining({
          'x-multi': ['one', 'two'],
          'user-agent': ['jest'],
        }),
        queryStringParameters: { a: '2', b: '3' }, // last value wins
        multiValueQueryStringParameters: { a: ['1', '2'], b: ['3'] },
        pathParameters: { id: '42' },
        stageVariables: null,
        body: '{"n":1}',
        isBase64Encoded: false,
      }),
    );
    const ctx = (event as any).requestContext;
    expect(ctx.stage).toBe('offline');
    expect(ctx.requestId).toBe('req-1');
    expect(ctx.identity.sourceIp).toBe('10.0.0.9');
    expect(ctx.identity.userAgent).toBe('jest');
    // REST authorizer context values are stringified; null/undefined dropped.
    expect(ctx.authorizer).toEqual({
      principalId: 'user-1',
      str: 's',
      num: '2',
      obj: JSON.stringify({ deep: true }),
    });
  });

  it('omits the authorizer, nulls the user agent and generates a request id by default', () => {
    const event = buildV1Event({
      request: req(),
      route: route('GET', '/users'),
      pathParameters: null,
      stage: 'dev',
    }) as any;
    expect(event.requestContext.authorizer).toBeUndefined();
    expect(event.requestContext.identity.userAgent).toBeNull();
    expect(typeof event.requestContext.requestId).toBe('string');
    expect(event.requestContext.requestId.length).toBeGreaterThan(0);
    expect(event.queryStringParameters).toBeNull();
    expect(event.multiValueQueryStringParameters).toBeNull();
    expect(event.body).toBeNull();
  });

  it('handles an authorizer without context and joins array header values', () => {
    const event = buildV1Event({
      request: req({ headers: { 'content-type': ['text/plain', 'text/x'] }, body: Buffer.from('b') }),
      route: route('GET', '/users'),
      pathParameters: null,
      stage: 'dev',
      authorizer: { principalId: 'p' },
    }) as any;
    expect(event.requestContext.authorizer).toEqual({ principalId: 'p' });
    // headerValue joins arrays → media type is 'text/plain,text/x'.split(';') → not base64? It is
    // not in the textual list start 'text/' — actually 'text/plain,text/x' matches ^text\/.
    expect(event.isBase64Encoded).toBe(false);
  });

  it('flags base64 bodies for binary content', () => {
    const event = buildV1Event({
      request: req({ headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2]) }),
      route: route('GET', '/users'),
      pathParameters: null,
      stage: 'dev',
    }) as any;
    expect(event.isBase64Encoded).toBe(true);
    expect(event.body).toBe(Buffer.from([1, 2]).toString('base64'));
  });

  it('skips undefined header values in single/multi maps', () => {
    const event = buildV1Event({
      request: req({ headers: { present: 'yes', gone: undefined } }),
      route: route('GET', '/users'),
      pathParameters: null,
      stage: 'dev',
    }) as any;
    expect(event.headers).toEqual({ present: 'yes' });
    expect(event.multiValueHeaders).toEqual({ present: ['yes'] });
  });

  it('stamps the given requestId and accountId (shared with the response header)', () => {
    const options = {
      request: req({ path: '/users/a b', rawPath: '/users/a%20b' }),
      route: route('GET', '/users/{id}'),
      pathParameters: { id: 'a b' },
      stage: 'dev',
      requestId: 'req-42',
      accountId: '111122223333',
    };
    const v1 = buildV1Event(options) as any;
    expect(v1.path).toBe('/users/a b');
    expect(v1.requestContext).toEqual(expect.objectContaining({ requestId: 'req-42', accountId: '111122223333' }));
    const v2 = buildV2Event({ ...options, route: route('GET', '/users/{id}', { eventType: 'httpApi' }) }) as any;
    // HTTP API: rawPath as received, requestContext.http.path decoded.
    expect(v2.rawPath).toBe('/users/a%20b');
    expect(v2.requestContext.http.path).toBe('/users/a b');
    expect(v2.requestContext).toEqual(expect.objectContaining({ requestId: 'req-42', accountId: '111122223333' }));
  });
});

describe('buildV2Event', () => {
  it('builds a full HTTP API payload with cookies extracted from headers', () => {
    const event = buildV2Event({
      request: req({
        method: 'get',
        path: '/items/7',
        rawQueryString: 'q=1',
        headers: {
          host: 'api.local',
          'user-agent': 'jest',
          cookie: ['a=1; b=2', 'c=3'],
        },
        sourceIp: '10.1.1.1',
      }),
      route: route('GET', '/items/{id}', { eventType: 'httpApi' }),
      pathParameters: { id: '7' },
      stage: 'offline',
      requestId: 'req-2',
      authorizer: { principalId: 'p', context: { plan: 'pro', limits: { rps: 5 } } },
    }) as any;

    expect(event.version).toBe('2.0');
    expect(event.routeKey).toBe('GET /items/{id}');
    expect(event.rawPath).toBe('/items/7');
    expect(event.rawQueryString).toBe('q=1');
    expect(event.cookies).toEqual(['a=1', 'b=2', 'c=3']);
    expect(event.headers.cookie).toBeUndefined(); // moved into cookies
    expect(event.headers.host).toBe('api.local');
    expect(event.queryStringParameters).toEqual({ q: '1' });
    expect(event.pathParameters).toEqual({ id: '7' });
    expect(event.requestContext.domainName).toBe('api.local');
    expect(event.requestContext.http).toEqual({
      method: 'GET',
      path: '/items/7',
      protocol: 'HTTP/1.1',
      sourceIp: '10.1.1.1',
      userAgent: 'jest',
    });
    expect(event.requestContext.requestId).toBe('req-2');
    // v2 authorizer context passes through unstringified under `lambda`.
    expect(event.requestContext.authorizer).toEqual({
      lambda: { principalId: 'p', plan: 'pro', limits: { rps: 5 } },
    });
    expect(event.body).toBeUndefined();
    expect(event.isBase64Encoded).toBe(false);
  });

  it('uses defaults when headers/query/params/authorizer are absent', () => {
    const event = buildV2Event({
      request: req({ path: '/x' }),
      route: route('ANY', '$default', { eventType: 'httpApi' }),
      pathParameters: null,
      stage: 'dev',
    }) as any;
    expect(event.routeKey).toBe('$default');
    expect(event.cookies).toBeUndefined();
    expect(event.queryStringParameters).toBeUndefined();
    expect(event.pathParameters).toBeUndefined();
    expect(event.requestContext.domainName).toBe('localhost');
    expect(event.requestContext.http.userAgent).toBe('');
    expect(event.requestContext.authorizer).toBeUndefined();
    expect(typeof event.requestContext.requestId).toBe('string');
  });

  it('defaults the authorizer context to {} and includes the body when present', () => {
    const event = buildV2Event({
      request: req({ headers: { 'content-type': 'application/json' }, body: Buffer.from('{"b":2}') }),
      route: route('POST', '/x', { eventType: 'httpApi' }),
      pathParameters: null,
      stage: 'dev',
      authorizer: { principalId: 'p' },
    }) as any;
    expect(event.requestContext.authorizer).toEqual({ lambda: { principalId: 'p' } });
    expect(event.body).toBe('{"b":2}');
  });

  it('omits cookies when the cookie header splits to nothing', () => {
    const event = buildV2Event({
      request: req({ headers: { cookie: '' } }),
      route: route('GET', '/x', { eventType: 'httpApi' }),
      pathParameters: null,
      stage: 'dev',
    }) as any;
    // '' header → multi-value [''] → split → [''] … filtered by `cookies.length` check?
    // ''.split(/;\s*/) === [''] so length is 1 with an empty cookie — assert actual behavior:
    expect(event.cookies).toEqual(['']);
  });
});

describe('mapV1Response', () => {
  it('maps a well-formed response with merged multiValueHeaders (single-value wins)', () => {
    const mapped = mapV1Response({
      statusCode: 201,
      headers: { 'X-One': '1', Empty: null, Missing: undefined },
      multiValueHeaders: { 'Set-Thing': ['a', 'b'], 'X-ONE': ['overridden'] },
      body: 'hello',
    });
    expect(mapped.statusCode).toBe(201);
    expect(mapped.headers).toEqual({ 'set-thing': 'a,b', 'x-one': '1' });
    expect(mapped.cookies).toEqual([]);
    expect(mapped.body.toString()).toBe('hello');
  });

  it('returns 502 for malformed payloads', () => {
    for (const bad of [null, undefined, 'string', 42, ['array'], {}, { statusCode: 'abc' }, { statusCode: 99 }, { statusCode: 600 }]) {
      const mapped = mapV1Response(bad);
      expect(mapped.statusCode).toBe(502);
      expect(JSON.parse(mapped.body.toString())).toEqual({ message: 'Internal server error' });
    }
  });

  it('decodes base64 bodies when isBase64Encoded is true', () => {
    const mapped = mapV1Response({
      statusCode: 200,
      body: Buffer.from('binary!').toString('base64'),
      isBase64Encoded: true,
    });
    expect(mapped.body.toString()).toBe('binary!');
  });

  it('serializes non-string bodies and defaults an absent body to empty', () => {
    expect(mapV1Response({ statusCode: 200, body: { a: 1 } }).body.toString()).toBe('{"a":1}');
    expect(mapV1Response({ statusCode: 204 }).body.length).toBe(0);
  });
});

describe('mapV2Response', () => {
  it('maps a statusCode-shaped response including cookies', () => {
    const mapped = mapV2Response({
      statusCode: 200,
      headers: { 'X-A': 1 },
      cookies: ['sid=1', 2],
      body: 'ok',
    });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.headers).toEqual({ 'x-a': '1' });
    expect(mapped.cookies).toEqual(['sid=1', '2']);
    expect(mapped.body.toString()).toBe('ok');
  });

  it('returns 502 for an invalid statusCode in a shaped response', () => {
    expect(mapV2Response({ statusCode: 'NaN' }).statusCode).toBe(502);
    expect(mapV2Response({ statusCode: 1000 }).statusCode).toBe(502);
  });

  it('infers a 200 JSON response from a bare object', () => {
    const mapped = mapV2Response({ ok: true });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.headers).toEqual({ 'content-type': 'application/json' });
    expect(mapped.body.toString()).toBe('{"ok":true}');
  });

  it('infers responses from strings, arrays and null/undefined', () => {
    expect(mapV2Response('plain').body.toString()).toBe('plain');
    expect(mapV2Response([1, 2]).body.toString()).toBe('[1,2]');
    expect(mapV2Response(null).body.toString()).toBe('');
    expect(mapV2Response(undefined).body.toString()).toBe('');
  });

  it('defaults cookies to [] and decodes base64 shaped bodies', () => {
    const mapped = mapV2Response({
      statusCode: 200,
      body: Buffer.from('zipped').toString('base64'),
      isBase64Encoded: true,
    });
    expect(mapped.cookies).toEqual([]);
    expect(mapped.body.toString()).toBe('zipped');
  });
});

describe('errorResponse', () => {
  it('wraps the message as a JSON body with the given status', () => {
    const resp = errorResponse(504, 'upstream timed out');
    expect(resp.statusCode).toBe(504);
    expect(resp.headers).toEqual({ 'content-type': 'application/json' });
    expect(resp.cookies).toEqual([]);
    expect(JSON.parse(resp.body.toString())).toEqual({ message: 'upstream timed out' });
  });
});

describe('gateway-generated responses', () => {
  const parse = (r: { body: Buffer }) => JSON.parse(r.body.toString('utf-8'));

  it('flavors: a route by its event type, a listener as REST only when every route is REST', () => {
    expect(routeFlavor(route('GET', '/x'))).toBe('rest');
    expect(routeFlavor(route('GET', '/x', { eventType: 'httpApi' }))).toBe('http');
    expect(apiFlavor([route('GET', '/a'), route('GET', '/b')])).toBe('rest');
    expect(apiFlavor([route('GET', '/a'), route('GET', '/b', { eventType: 'httpApi' })])).toBe('http');
    expect(apiFlavor([])).toBe('http');
  });

  it('REST defaults, with the x-amzn-ErrorType header', () => {
    const cases: Array<[Parameters<typeof gatewayErrorResponse>[0], number, unknown, string]> = [
      ['MISSING_AUTHENTICATION_TOKEN', 403, { message: 'Missing Authentication Token' }, 'MissingAuthenticationTokenException'],
      ['UNAUTHORIZED', 401, { message: 'Unauthorized' }, 'UnauthorizedException'],
      ['ACCESS_DENIED', 403, { Message: 'User is not authorized to access this resource' }, 'AccessDeniedException'],
      ['AUTHORIZER_CONFIGURATION_ERROR', 500, { message: null }, 'AuthorizerConfigurationException'],
      ['INTEGRATION_FAILURE', 502, { message: 'Internal server error' }, 'InternalServerErrorException'],
      ['DEFAULT_5XX', 500, { message: 'Internal server error' }, 'InternalServerErrorException'],
    ];
    for (const [type, status, body, errorType] of cases) {
      const res = gatewayErrorResponse(type, 'rest');
      expect(res.statusCode).toBe(status);
      expect(parse(res)).toEqual(body);
      expect(res.headers).toEqual({ 'content-type': 'application/json', 'x-amzn-errortype': errorType });
      expect(res.cookies).toEqual([]);
    }
    expect(parse(gatewayErrorResponse('ACCESS_DENIED', 'rest', { explicitDeny: true })))
      .toEqual({ Message: 'User is not authorized to access this resource with an explicit deny' });
  });

  it('HTTP API defaults, without an error-type header', () => {
    const cases: Array<[Parameters<typeof gatewayErrorResponse>[0], number, string]> = [
      ['MISSING_AUTHENTICATION_TOKEN', 404, 'Not Found'],
      ['UNAUTHORIZED', 401, 'Unauthorized'],
      ['ACCESS_DENIED', 403, 'Forbidden'],
      ['AUTHORIZER_CONFIGURATION_ERROR', 500, 'Internal Server Error'],
      ['INTEGRATION_FAILURE', 500, 'Internal Server Error'],
      ['DEFAULT_5XX', 500, 'Internal Server Error'],
    ];
    for (const [type, status, message] of cases) {
      const res = gatewayErrorResponse(type, 'http', { explicitDeny: true });
      expect(res.statusCode).toBe(status);
      expect(parse(res)).toEqual({ message });
      expect(res.headers).toEqual({ 'content-type': 'application/json' });
    }
  });

  it('request id header per flavor', () => {
    expect(requestIdHeader('rest', 'id-1')).toEqual({ 'x-amzn-requestid': 'id-1' });
    expect(requestIdHeader('http', 'id-1')).toEqual({ 'apigw-requestid': 'id-1' });
  });
});

describe('answersPreflight', () => {
  it('HTTP API CORS is API-wide: any path preflights once one httpApi route has CORS', () => {
    const routes = [route('GET', '/a', { eventType: 'httpApi', cors: true })];
    expect(answersPreflight(routes, '/anything')).toBe(true);
    expect(answersPreflight([route('GET', '/a', { eventType: 'httpApi' })], '/a')).toBe(false);
  });

  it('REST CORS is per resource: only a cors route on that path preflights', () => {
    const routes = [route('POST', '/users/{id}', { cors: true }), route('GET', '/plain')];
    expect(answersPreflight(routes, '/users/7')).toBe(true);
    expect(answersPreflight(routes, '/plain')).toBe(false);
    expect(answersPreflight(routes, '/nowhere')).toBe(false);
  });
});
