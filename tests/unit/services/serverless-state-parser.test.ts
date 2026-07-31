// Unit tests for ServerlessStateParser. Pure parser: no I/O, no mocking. We
// drive provider-default vs function-override resolution, every http/httpApi
// event shape (string shorthand, routeKey, object), REST inline and
// provider.httpApi authorizers, env sanitization (CFN intrinsics), and the
// warning paths for unsupported/unparseable inputs.
import {
  ServerlessStateParser,
  sanitizeEnvironmentValues,
} from '../../../src/server/services/serverless-state-parser';

let parser: ServerlessStateParser;

beforeEach(() => {
  parser = new ServerlessStateParser();
});

describe('sanitizeEnvironmentValues', () => {
  it('coerces strings, numbers, booleans and CFN intrinsics to strings', () => {
    expect(
      sanitizeEnvironmentValues({
        STR: 'plain',
        NUM: 42,
        BOOL: true,
        REF: { Ref: 'UsersTable' },
        GETATT: { 'Fn::GetAtt': ['UsersTable', 'Arn'] },
        OTHER: { 'Fn::Join': ['', ['a', 'b']] },
      }),
    ).toEqual({
      STR: 'plain',
      NUM: '42',
      BOOL: 'true',
      REF: 'UsersTable',
      GETATT: 'UsersTable.Arn',
      OTHER: JSON.stringify({ 'Fn::Join': ['', ['a', 'b']] }),
    });
  });

  it('drops null and undefined values', () => {
    expect(sanitizeEnvironmentValues({ A: null, B: undefined, C: 'keep' })).toEqual({ C: 'keep' });
  });
});

describe('functions: provider defaults vs overrides', () => {
  const state = {
    service: {
      service: 'shop',
      provider: {
        stage: 'offline',
        runtime: 'nodejs18.x',
        memorySize: 512,
        timeout: 30,
        environment: { GLOBAL: 'g', SHARED: 'provider' },
      },
      functions: {
        plain: { handler: 'src/plain.handler', events: [] },
        custom: {
          name: 'explicit-full-name',
          handler: 'src/custom.handler',
          runtime: 'nodejs20.x',
          memorySize: 256,
          timeout: 10,
          environment: { LOCAL: 'l', SHARED: 'fn' },
          package: { artifact: '.serverless/custom.zip' },
        },
      },
    },
    package: { artifact: '.serverless/shop.zip' },
  };

  it('fills provider defaults and derives the full name for a plain function', () => {
    const { functions, warnings } = parser.parse(state as never);
    const plain = functions.find(f => f.name === 'plain');
    expect(plain).toEqual({
      name: 'plain',
      fullName: 'shop-offline-plain',
      handler: 'src/plain.handler',
      runtime: 'nodejs18.x',
      memorySize: 512,
      timeout: 30,
      environment: { GLOBAL: 'g', SHARED: 'provider' },
      triggers: [],
      artifact: '.serverless/shop.zip', // service-level artifact fallback
    });
    expect(warnings).toEqual([]);
  });

  it('function-level settings override provider defaults (name, runtime, sizes, env, artifact)', () => {
    const { functions } = parser.parse(state as never);
    const custom = functions.find(f => f.name === 'custom');
    expect(custom).toEqual({
      name: 'custom',
      fullName: 'explicit-full-name',
      handler: 'src/custom.handler',
      runtime: 'nodejs20.x',
      memorySize: 256,
      timeout: 10,
      // fn env merges over provider env.
      environment: { GLOBAL: 'g', LOCAL: 'l', SHARED: 'fn' },
      triggers: [],
      artifact: '.serverless/custom.zip',
    });
  });

  it('applies hard defaults when neither provider nor function specify values', () => {
    const { functions, stage, serviceName } = parser.parse({
      service: { functions: { bare: {} } },
    } as never);
    expect(serviceName).toBeUndefined();
    expect(stage).toBe('dev');
    expect(functions[0]).toEqual({
      name: 'bare',
      fullName: 'unknown-dev-bare', // no serviceName → 'unknown'
      handler: '',
      runtime: 'nodejs20.x',
      memorySize: 1024,
      timeout: 6,
      environment: {},
      triggers: [],
      artifact: undefined,
    });
  });

  it('parses an entirely empty state', () => {
    expect(parser.parse({} as never)).toEqual({
      serviceName: undefined,
      stage: 'dev',
      functions: [],
      routes: [],
      authorizers: [],
      warnings: [],
    });
  });

  it('sanitizes CFN intrinsics in the merged environment', () => {
    const { functions } = parser.parse({
      service: {
        service: 's',
        provider: { environment: { TABLE: { Ref: 'UsersTable' } } },
        functions: { f: { environment: { ARN: { 'Fn::GetAtt': ['Q', 'Arn'] } } } },
      },
    } as never);
    expect(functions[0].environment).toEqual({ TABLE: 'UsersTable', ARN: 'Q.Arn' });
  });

  it('collects trigger names (deduped) and normalizes stream', () => {
    const { functions, routes } = parser.parse({
      service: {
        service: 's',
        functions: {
          f: {
            events: [
              { sqs: { arn: 'arn:q' } },
              { sqs: { arn: 'arn:q2' } },
              { stream: { arn: 'arn:table' } },
              { schedule: 'rate(1 minute)' },
              { http: 'GET /users' },
            ],
          },
        },
      },
    } as never);
    expect(functions[0].triggers.sort()).toEqual(['http', 'schedule', 'sqs', 'stream']);
    expect(routes).toHaveLength(1);
  });

  it('skips malformed event entries (null, non-object, empty object)', () => {
    const { functions, routes, warnings } = parser.parse({
      service: {
        service: 's',
        functions: { f: { events: [null, 'bogus', {}, { http: 'GET /ok' }] } },
      },
    } as never);
    expect(functions[0].triggers).toEqual(['http']);
    expect(routes).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

describe('http/httpApi route parsing', () => {
  function routesOf(events: unknown[], provider: Record<string, unknown> = {}) {
    return parser.parse({
      service: { service: 's', provider, functions: { fn: { events } } },
    } as never);
  }

  it('parses REST string shorthand ("GET /users", "post users")', () => {
    const { routes } = routesOf([{ http: 'GET /users' }, { http: 'post users' }]);
    expect(routes).toEqual([
      expect.objectContaining({ functionName: 'fn', method: 'GET', path: '/users', eventType: 'http', cors: false }),
      expect.objectContaining({ method: 'POST', path: '/users', eventType: 'http' }),
    ]);
  });

  it('parses httpApi shorthand and "*" as ANY/$default', () => {
    const { routes } = routesOf([{ httpApi: '*' }, { httpApi: 'GET /items' }]);
    expect(routes[0]).toEqual(
      expect.objectContaining({ method: 'ANY', path: '$default', eventType: 'httpApi' }),
    );
    expect(routes[1]).toEqual(expect.objectContaining({ method: 'GET', path: '/items' }));
  });

  it('maps a "*" method token to ANY', () => {
    const { routes } = routesOf([{ httpApi: '* /misc' }]);
    expect(routes[0]).toEqual(expect.objectContaining({ method: 'ANY', path: '/misc' }));
  });

  it('parses object events with routeKey (including $default)', () => {
    const { routes } = routesOf([
      { httpApi: { routeKey: 'GET /via-key' } },
      { httpApi: { routeKey: '$default' } },
      { httpApi: { method: 'put', path: 'things' } },
    ]);
    expect(routes).toEqual([
      expect.objectContaining({ method: 'GET', path: '/via-key' }),
      expect.objectContaining({ method: 'ANY', path: '$default' }),
      expect.objectContaining({ method: 'PUT', path: '/things' }),
    ]);
  });

  it('inherits provider.httpApi.cors for httpApi routes only', () => {
    const { routes } = routesOf(
      [{ httpApi: 'GET /a' }, { http: 'GET /b' }],
      { httpApi: { cors: true } },
    );
    expect(routes[0].cors).toBe(true); // httpApi inherits
    expect(routes[1].cors).toBe(false); // REST does not
  });

  it('event-level cors overrides in both directions', () => {
    const { routes } = routesOf(
      [
        { http: { method: 'get', path: '/on', cors: true } },
        { httpApi: { method: 'get', path: '/off', cors: false } },
      ],
      { httpApi: { cors: true } },
    );
    expect(routes[0].cors).toBe(true);
    expect(routes[1].cors).toBe(false);
  });

  it('normalizes paths (trailing slash, missing leading slash, "/", "$default")', () => {
    const { routes } = routesOf([
      { http: 'GET /users/' },
      { http: 'GET users' },
      { http: { method: 'get', path: '/' } },
      { httpApi: { routeKey: '$default' } },
    ]);
    expect(routes.map(r => r.path)).toEqual(['/users', '/users', '/', '$default']);
  });

  it('warns and skips unparseable events', () => {
    const { routes, warnings } = routesOf([
      { http: {} }, // no method/path/routeKey
      { http: 123 }, // neither string nor object
      { http: { method: 'get' } }, // path missing
      { http: { path: '/x' } }, // method missing
    ]);
    expect(routes).toEqual([]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('could not parse http event');
  });
});

describe('REST inline authorizers', () => {
  function parseEvents(events: unknown[]) {
    return parser.parse({
      service: { service: 's', functions: { fn: { events } } },
    } as never);
  }

  it('string shorthand becomes a TOKEN authorizer with defaults', () => {
    const { routes, authorizers } = parseEvents([
      { http: { method: 'get', path: '/a', authorizer: 'authFn' } },
    ]);
    expect(routes[0].authorizerName).toBe('fn:authFn');
    expect(authorizers).toEqual([
      {
        name: 'fn:authFn',
        type: 'token',
        eventType: 'http',
        payloadVersion: '1.0',
        enableSimpleResponses: false,
        identitySource: ['method.request.header.Authorization'],
        resultTtlInSeconds: 300,
        functionName: 'authFn',
      },
    ]);
  });

  it('object with name + type request + comma-separated identitySource', () => {
    const { routes, authorizers } = parseEvents([
      {
        http: {
          method: 'get',
          path: '/b',
          authorizer: {
            name: 'reqAuth',
            type: 'REQUEST',
            identitySource: 'method.request.header.code, method.request.querystring.token',
            resultTtlInSeconds: 60,
          },
        },
      },
    ]);
    expect(routes[0].authorizerName).toBe('fn:reqAuth');
    expect(authorizers[0]).toEqual(
      expect.objectContaining({
        name: 'fn:reqAuth',
        type: 'request',
        identitySource: ['method.request.header.code', 'method.request.querystring.token'],
        resultTtlInSeconds: 60,
        functionName: 'reqAuth',
        arn: undefined,
      }),
    );
  });

  it('object with a string arn is a cross-service reference (no local function)', () => {
    const { authorizers } = parseEvents([
      {
        http: {
          method: 'get',
          path: '/c',
          authorizer: { arn: 'arn:aws:lambda:us-east-1:000000000000:function:other-dev-auth' },
        },
      },
    ]);
    // No name → display name falls back to `${functionName}-authorizer`.
    expect(authorizers[0]).toEqual(
      expect.objectContaining({
        name: 'fn:fn-authorizer',
        type: 'token',
        arn: 'arn:aws:lambda:us-east-1:000000000000:function:other-dev-auth',
        functionName: undefined,
      }),
    );
  });

  it('a name alongside an arn does not register a local function', () => {
    const { authorizers } = parseEvents([
      {
        http: {
          method: 'get',
          path: '/d',
          authorizer: { name: 'shared', arn: 'arn:aws:lambda:x:y:function:z' },
        },
      },
    ]);
    expect(authorizers[0].functionName).toBeUndefined();
    expect(authorizers[0].arn).toBe('arn:aws:lambda:x:y:function:z');
  });

  it('an intrinsic (Fn::GetAtt) arn means "local function" — name wins', () => {
    const { authorizers } = parseEvents([
      {
        http: {
          method: 'get',
          path: '/e',
          authorizer: { name: 'localAuth', arn: { 'Fn::GetAtt': ['AuthLambdaFunction', 'Arn'] } },
        },
      },
    ]);
    expect(authorizers[0].functionName).toBe('localAuth');
    expect(authorizers[0].arn).toBeUndefined();
  });

  it('unsupported type warns and marks the route unresolved', () => {
    const { routes, authorizers, warnings } = parseEvents([
      { http: { method: 'get', path: '/f', authorizer: { name: 'pool', type: 'COGNITO_USER_POOLS' } } },
    ]);
    expect(routes[0].authorizerName).toBe('__unresolved__:pool');
    expect(authorizers).toEqual([]);
    expect(warnings[0]).toContain('unsupported type "cognito_user_pools"');
  });

  it('an invalid resultTtlInSeconds falls back to 300 and 0 is preserved', () => {
    const { authorizers } = parseEvents([
      { http: { method: 'get', path: '/g', authorizer: { name: 'a1', resultTtlInSeconds: 'abc' } } },
      { http: { method: 'get', path: '/h', authorizer: { name: 'a2', resultTtlInSeconds: 0 } } },
      { http: { method: 'get', path: '/i', authorizer: { name: 'a3', resultTtlInSeconds: -5 } } },
    ]);
    expect(authorizers.map(a => a.resultTtlInSeconds)).toEqual([300, 0, 300]);
  });

  it('ignores an authorizer reference that is neither string nor object', () => {
    const { routes, authorizers } = parseEvents([
      { http: { method: 'get', path: '/j', authorizer: 42 } },
    ]);
    expect(routes[0].authorizerName).toBeUndefined();
    expect(authorizers).toEqual([]);
  });
});

describe('httpApi authorizers (provider.httpApi.authorizers)', () => {
  function parseWith(authorizers: Record<string, unknown>, events: unknown[] = []) {
    return parser.parse({
      service: {
        service: 's',
        provider: { httpApi: { authorizers } },
        functions: { fn: { events } },
      },
    } as never);
  }

  it('parses a request authorizer with payloadVersion/simpleResponses/ttl', () => {
    const { authorizers, warnings } = parseWith({
      main: {
        type: 'request',
        payloadVersion: '1.0',
        enableSimpleResponses: true,
        identitySource: ['$request.header.x', ''],
        resultTtlInSeconds: '45',
        functionName: 'authFn',
      },
    });
    expect(warnings).toEqual([]);
    expect(authorizers).toEqual([
      {
        name: 'main',
        type: 'request',
        eventType: 'httpApi',
        payloadVersion: '1.0',
        enableSimpleResponses: true,
        identitySource: ['$request.header.x'], // empty entries filtered
        resultTtlInSeconds: 45,
        functionName: 'authFn',
        arn: undefined,
      },
    ]);
  });

  it('defaults type/payloadVersion/ttl for a bare definition (invalid ttl → 300)', () => {
    const { authorizers } = parseWith({ bare: { resultTtlInSeconds: 'nope' } });
    expect(authorizers[0]).toEqual(
      expect.objectContaining({
        type: 'request',
        payloadVersion: '2.0',
        enableSimpleResponses: false,
        identitySource: [],
        resultTtlInSeconds: 300,
        functionName: undefined,
        arn: undefined,
      }),
    );
  });

  it('accepts arn or functionArn for external authorizers', () => {
    const { authorizers } = parseWith({
      viaArn: { arn: 'arn:aws:lambda:x:y:function:a' },
      viaFunctionArn: { functionArn: 'arn:aws:lambda:x:y:function:b' },
    });
    expect(authorizers.map(a => a.arn)).toEqual([
      'arn:aws:lambda:x:y:function:a',
      'arn:aws:lambda:x:y:function:b',
    ]);
  });

  it('skips jwt authorizers with a warning', () => {
    const { authorizers, warnings } = parseWith({ jwtAuth: { type: 'jwt' } });
    expect(authorizers).toEqual([]);
    expect(warnings[0]).toContain('JWT authorizer');
  });

  it('skips unsupported types with a warning', () => {
    const { authorizers, warnings } = parseWith({ weird: { type: 'basic' } });
    expect(authorizers).toEqual([]);
    expect(warnings[0]).toContain('unsupported type "basic"');
  });

  it('resolves event references by string and by {name}', () => {
    const { routes } = parseWith(
      { main: { type: 'request', functionName: 'authFn' } },
      [
        { httpApi: { method: 'get', path: '/str', authorizer: 'main' } },
        { httpApi: { method: 'get', path: '/obj', authorizer: { name: 'main' } } },
      ],
    );
    expect(routes.map(r => r.authorizerName)).toEqual(['main', 'main']);
  });

  it('warns on unsupported httpApi authorizer references', () => {
    const { routes, warnings } = parseWith({}, [
      { httpApi: { method: 'get', path: '/no-name', authorizer: { id: 'raw-id' } } },
      { httpApi: { method: 'get', path: '/not-obj', authorizer: 42 } },
    ]);
    expect(routes.map(r => r.authorizerName)).toEqual(['__unresolved__:fn', '__unresolved__:fn']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('unsupported httpApi authorizer reference');
  });
});

// Registration is self-serving in 1.0: what the retired plugin used to POST —
// provider.region and the custom.lss port hints — now comes out of the parsed
// state itself.
describe('region and custom.lss port hints', () => {
  it('extracts provider.region and custom.lss ports', () => {
    const parsed = parser.parse({
      service: {
        service: 'orders',
        provider: { region: 'us-west-2' },
        custom: { lss: { apiPort: 3631, invokePort: 13631 } },
        functions: {},
      },
    } as never);
    expect(parsed.region).toBe('us-west-2');
    expect(parsed.apiPort).toBe(3631);
    expect(parsed.invokePort).toBe(13631);
  });

  it('accepts string-typed ports (the state file is user-authored)', () => {
    const parsed = parser.parse({
      service: { service: 's', custom: { lss: { apiPort: '3631', invokePort: '13631' } }, functions: {} },
    } as never);
    expect(parsed.apiPort).toBe(3631);
    expect(parsed.invokePort).toBe(13631);
  });

  it('rejects garbage ports and blank regions rather than propagating them', () => {
    const parsed = parser.parse({
      service: {
        service: 's',
        provider: { region: '' },
        custom: { lss: { apiPort: 0, invokePort: 99999999 } },
        functions: {},
      },
    } as never);
    expect(parsed.region).toBeUndefined();
    expect(parsed.apiPort).toBeUndefined();
    expect(parsed.invokePort).toBeUndefined();
  });

  it('leaves every hint undefined when custom/provider are absent', () => {
    const parsed = parser.parse({ service: { service: 's', functions: {} } } as never);
    expect(parsed.region).toBeUndefined();
    expect(parsed.apiPort).toBeUndefined();
    expect(parsed.invokePort).toBeUndefined();
  });
});
