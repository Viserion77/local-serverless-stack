// Unit tests for ServerlessStateParser. Pure parser: no I/O, no mocking. We
// drive provider-default vs function-override resolution, every http/httpApi
// event shape (string shorthand, routeKey, object), REST inline and
// provider.httpApi authorizers, env sanitization (CFN intrinsics), and the
// warning paths for unsupported/unparseable inputs.
import {
  ServerlessStateParser,
  sanitizeEnvironmentValues,
  derefStatePointer,
  lambdaLogicalIdFor,
  readStateIdentity,
  stageFromPackageArgs,
  stageMismatchWarnings,
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
      rawEnvironment: {},
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

  it('an intrinsic (Fn::GetAtt) arn resolves to the function it names, not to the authorizer name', () => {
    const { authorizers, warnings } = parser.parse({
      service: {
        service: 's',
        functions: {
          fn: { events: [{ http: { method: 'get', path: '/e', authorizer: { name: 'localAuth', arn: { 'Fn::GetAtt': ['AuthLambdaFunction', 'Arn'] } } } }] },
          auth: {},
        },
      },
    } as never);
    expect(authorizers[0].name).toBe('fn:localAuth');
    expect(authorizers[0].functionName).toBe('auth');
    expect(authorizers[0].arn).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('an unresolvable intrinsic arn falls back to `name` only when that is a declared function', () => {
    const { authorizers, warnings } = parseEvents([
      { http: { method: 'get', path: '/e1', authorizer: { name: 'fn', arn: { 'Fn::GetAtt': ['GoneLambdaFunction', 'Arn'] } } } },
      { http: { method: 'get', path: '/e2', authorizer: { name: 'nope', arn: { 'Fn::GetAtt': ['GoneLambdaFunction', 'Arn'] } } } },
    ]);
    expect(authorizers.map(a => a.functionName)).toEqual(['fn', undefined]);
    expect(warnings).toEqual([
      'Authorizer "nope": function reference {"Fn::GetAtt":["GoneLambdaFunction","Arn"]} does not resolve to a Lambda in this service — routes using it will answer 500.',
      'Authorizer "fn:nope" has no function to invoke (neither a function name nor a resolvable ARN) — routes using it will answer 500.',
    ]);
  });

  it('a string shorthand that is an ARN is carried as the arn, not as a function name', () => {
    const { authorizers, warnings } = parseEvents([
      { http: { method: 'get', path: '/arn', authorizer: 'arn:aws:lambda:us-east-1:000000000000:function:billing-dev-auth' } },
    ]);
    expect(authorizers[0].functionName).toBeUndefined();
    expect(authorizers[0].arn).toBe('arn:aws:lambda:us-east-1:000000000000:function:billing-dev-auth');
    expect(warnings).toEqual([]);
  });

  it('warns when a local authorizer names a function the service does not declare', () => {
    const { warnings } = parseEvents([
      { http: { method: 'get', path: '/a', authorizer: 'missingFn' } },
    ]);
    expect(warnings).toEqual([
      'Authorizer "fn:missingFn" targets function "missingFn", which this service does not declare — routes using it will answer 500.',
    ]);
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
        functions: { fn: { events }, authFn: {} },
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

// serverless-state.json is written cycle-safe: a repeated object becomes a
// `{"$ref": "$[...]"}` pointer, and a reader that does not follow them sees
// authorizers, events and env values that are just pointers.
describe('$ref pointers', () => {
  it('follows bracketed, dotted and chained pointers; leaves the rest alone', () => {
    const root = { a: { 'b"c': [10, { d: 'hit' }] }, e: { f: 'dotted' }, chain: { $ref: '$.e' } };
    expect(derefStatePointer({ $ref: '$["a"]["b\\"c"][1]["d"]' }, root)).toBe('hit');
    expect(derefStatePointer({ $ref: '$.e.f' }, root)).toBe('dotted');
    expect(derefStatePointer({ $ref: '$["chain"]' }, root)).toEqual({ f: 'dotted' });
    // Not pointers: kept verbatim.
    expect(derefStatePointer('x', root)).toBe('x');
    expect(derefStatePointer(['x'], root)).toEqual(['x']);
    expect(derefStatePointer(null, root)).toBeNull();
    expect(derefStatePointer({ $ref: 5 }, root)).toEqual({ $ref: 5 });
    expect(derefStatePointer({ $ref: '$.e', other: 1 }, root)).toEqual({ $ref: '$.e', other: 1 });
    expect(derefStatePointer({ $ref: '#/definitions/x' }, root)).toEqual({ $ref: '#/definitions/x' });
    // A dangling or malformed path keeps the pointer.
    expect(derefStatePointer({ $ref: '$["nope"]["deeper"]' }, root)).toEqual({ $ref: '$["nope"]["deeper"]' });
    expect(derefStatePointer({ $ref: '$!!' }, root)).toEqual({ $ref: '$!!' });
  });

  it('tolerates null function and authorizer definitions', () => {
    const parsed = parser.parse({
      service: { service: 's', provider: { httpApi: { authorizers: { empty: null } } }, functions: { a: null } },
    } as never);
    expect(parsed.functions.map(f => f.fullName)).toEqual(['s-dev-a']);
    expect(parsed.authorizers.map(a => a.name)).toEqual(['empty']);
  });

  it('stops on a pointer loop instead of spinning', () => {
    const root: Record<string, unknown> = {};
    root.loop = { $ref: '$.loop' };
    expect(derefStatePointer(root.loop, root)).toEqual({ $ref: '$.loop' });
  });

  // Dangling pointers (fnEnv, apiEvent, authFn are never defined) are skipped,
  // never read as data: no "$ref" env var, no "$ref" trigger.
  it('resolves pointered functions, events, authorizers and env values', () => {
    const shared = { method: 'get', path: '/shared', authorizer: { name: 'auth' } };
    const parsed = parser.parse({
      service: {
        service: 'orders',
        provider: {
          environment: { TABLE: { $ref: '$["service"]["custom"]["tableName"]' } },
          httpApi: { authorizers: { $ref: '$["service"]["custom"]["authorizers"]' } },
        },
        custom: {
          tableName: 'orders-dev',
          authorizers: { main: { $ref: '$["service"]["custom"]["mainAuthorizer"]' } },
          mainAuthorizer: { type: 'request', functionName: 'auth' },
          sharedEvent: shared,
        },
        functions: {
          a: { events: [{ http: { $ref: '$["service"]["custom"]["sharedEvent"]' } }, { $ref: '$["service"]["custom"]["apiEvent"]' }], environment: { $ref: '$["service"]["custom"]["fnEnv"]' } },
          auth: { $ref: '$["service"]["custom"]["authFn"]' },
        },
      },
    } as never);
    expect(parsed.routes.map(r => `${r.method} ${r.path} ${r.authorizerName}`)).toEqual(['GET /shared a:auth']);
    expect(parsed.authorizers.map(a => [a.name, a.functionName])).toEqual([['main', 'auth'], ['a:auth', 'auth']]);
    expect(parsed.functions.map(f => f.environment)).toEqual([{ TABLE: 'orders-dev' }, { TABLE: 'orders-dev' }]);
    expect(parsed.rawEnvironment).toEqual({ a: { TABLE: 'orders-dev' }, auth: { TABLE: 'orders-dev' } });
    expect(parsed.warnings).toEqual([]);
  });
});

describe('authorizer function references (template-aware)', () => {
  function parseWithArn(ref: unknown, context = {}, extraFunctions: Record<string, unknown> = {}) {
    return parser.parse({
      service: {
        service: 'orders',
        provider: { httpApi: { authorizers: { main: { functionArn: ref } } } },
        functions: { 'session-auth': {}, ...extraFunctions },
      },
    } as never, context);
  }

  it('resolves GetAtt (both spellings), Ref and a lone Fn::Sub by the framework naming convention', () => {
    for (const ref of [
      { 'Fn::GetAtt': ['SessionDashauthLambdaFunction', 'Arn'] },
      { 'Fn::GetAtt': 'SessionDashauthLambdaFunction.Arn' },
      { Ref: 'SessionDashauthLambdaFunction' },
      { 'Fn::Sub': '${SessionDashauthLambdaFunction.Arn}' },
      { 'Fn::Sub': ['${SessionDashauthLambdaFunction}', {}] },
    ]) {
      const { authorizers, warnings } = parseWithArn(ref);
      expect(authorizers[0].functionName).toBe('session-auth');
      expect(warnings).toEqual([]);
    }
  });

  it('prefers the template FunctionName, and hands a non-local name through as the arn', () => {
    const custom = parseWithArn(
      { 'Fn::GetAtt': ['CustomAuth', 'Arn'] },
      { lambdaNames: new Map([['CustomAuth', 'orders-dev-session-auth'], ['Elsewhere', 'billing-dev-auth']]) },
    );
    expect(custom.authorizers[0].functionName).toBe('session-auth');
    const elsewhere = parseWithArn({ 'Fn::GetAtt': ['Elsewhere', 'Arn'] }, {
      lambdaNames: new Map([['Elsewhere', 'billing-dev-auth']]),
    });
    expect(elsewhere.authorizers[0]).toEqual(expect.objectContaining({ functionName: undefined, arn: 'billing-dev-auth' }));
  });

  it('warns about references it cannot resolve', () => {
    for (const ref of [{ 'Fn::ImportValue': 'x' }, { 'Fn::Sub': 'arn:${AWS::Partition}:x' }, { 'Fn::Sub': 5 }, { 'Fn::GetAtt': [5] }, 'not-an-object'.length]) {
      const { authorizers, warnings } = parseWithArn(ref);
      expect(authorizers[0].functionName).toBeUndefined();
      expect(warnings[0]).toMatch(/^Authorizer "main": function reference .* does not resolve to a Lambda in this service/);
    }
  });

  it('names the function after the framework convention', () => {
    expect(lambdaLogicalIdFor('create-order')).toBe('CreateDashorderLambdaFunction');
    expect(lambdaLogicalIdFor('get_user')).toBe('GetUnderscoreuserLambdaFunction');
  });
});

describe('stage helpers', () => {
  it('readStateIdentity derives the stack name, honouring provider.stackName', () => {
    expect(readStateIdentity(null)).toEqual({ serviceName: undefined, stage: 'dev', region: undefined, stackName: undefined });
    expect(readStateIdentity({ service: { service: 'orders', provider: { stage: 'qa', region: 'eu-west-1' } } } as never))
      .toEqual({ serviceName: 'orders', stage: 'qa', region: 'eu-west-1', stackName: 'orders-qa' });
    expect(readStateIdentity({ service: { service: 'orders', provider: { stackName: 'custom-stack', region: '' } } } as never))
      .toEqual({ serviceName: 'orders', stage: 'dev', region: undefined, stackName: 'custom-stack' });
  });

  it('stageFromPackageArgs reads --stage X, --stage=X and -s X', () => {
    expect(stageFromPackageArgs(['package', '--stage', 'prod'])).toBe('prod');
    expect(stageFromPackageArgs(['package', '--stage=qa'])).toBe('qa');
    expect(stageFromPackageArgs(['package', '-s', 'local'])).toBe('local');
    expect(stageFromPackageArgs(['package', '--stage'])).toBeUndefined();
    expect(stageFromPackageArgs(['package', '--stage', '--verbose'])).toBeUndefined();
    expect(stageFromPackageArgs(['package'])).toBeUndefined();
  });

  it('stageMismatchWarnings speaks only for contradicting expectations', () => {
    expect(stageMismatchWarnings('prod', [
      { stage: 'dev', source: 'the packaging command (npx sls package --stage dev)' },
      { stage: 'prod', source: 'the previous registration of this service' },
      { stage: undefined, source: 'nothing' },
    ])).toEqual([
      'The packaged artifacts are for stage "prod", but the packaging command (npx sls package --stage dev) says "dev" — ' +
      'resource and function names follow the packaged stage. Re-package for the stage you mean (lss register --repackage).',
    ]);
  });
});

describe('API keys (private REST routes)', () => {
  const stateWith = (provider: Record<string, unknown>, events: unknown[]) => ({
    service: { service: 'catalog', provider: { stage: 'dev', ...provider }, functions: { list: { handler: 'h.list', events } } },
  });

  it('marks `private: true` http routes as key-protected, defaulting the source to HEADER', () => {
    const parsed = parser.parse(stateWith({}, [
      { http: { method: 'get', path: 'items', private: true } },
      { http: { method: 'post', path: 'items', private: false } },
      { http: 'GET public' },
    ]));
    expect(parsed.routes).toEqual([
      { functionName: 'list', method: 'GET', path: '/items', eventType: 'http', cors: false, authorizerName: undefined, apiKeyRequired: true, apiKeySourceType: 'HEADER' },
      { functionName: 'list', method: 'POST', path: '/items', eventType: 'http', cors: false, authorizerName: undefined },
      { functionName: 'list', method: 'GET', path: '/public', eventType: 'http', cors: false, authorizerName: undefined },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it('reads provider.apiGateway.apiKeySourceType case-insensitively, following $ref pointers', () => {
    const state = stateWith({ apiGateway: { apiKeySourceType: 'authorizer' } }, [{ http: { method: 'get', path: 'a', private: true } }]);
    expect(parser.parse(state).routes[0].apiKeySourceType).toBe('AUTHORIZER');

    const pointed = {
      service: {
        service: 'catalog',
        custom: { keySource: 'HEADER' },
        provider: { stage: 'dev', apiGateway: { apiKeySourceType: { $ref: '$["service"]["custom"]["keySource"]' } } },
        functions: { list: { handler: 'h.list', events: [{ http: { method: 'get', path: 'a', private: true } }] } },
      },
    };
    expect(parser.parse(pointed as never).routes[0].apiKeySourceType).toBe('HEADER');
  });

  it('falls back to HEADER with a warning on an unknown source, and when apiGateway is not an object', () => {
    const bad = parser.parse(stateWith({ apiGateway: { apiKeySourceType: 'COOKIE' } }, [{ http: { method: 'get', path: 'a', private: true } }]));
    expect(bad.routes[0].apiKeySourceType).toBe('HEADER');
    expect(bad.warnings).toEqual([expect.stringContaining('apiKeySourceType "COOKIE" is not HEADER or AUTHORIZER')]);

    const odd = parser.parse(stateWith({ apiGateway: 'shared' }, [{ http: { method: 'get', path: 'a', private: true } }]));
    expect(odd.routes[0].apiKeySourceType).toBe('HEADER');
    expect(odd.warnings).toEqual([]);
  });

  it('ignores `private` on httpApi events — HTTP APIs have no API keys', () => {
    const parsed = parser.parse(stateWith({}, [{ httpApi: { method: 'get', path: '/v2', private: true } }]));
    expect(parsed.routes[0].apiKeyRequired).toBeUndefined();
    expect(parsed.routes[0].apiKeySourceType).toBeUndefined();
  });
});
