// Unit tests for the raw AWS::ApiGatewayV2 assembler: turning hand-authored
// ::Api/::Route/::Integration/::Authorizer (+ AWS::Lambda::Permission) resources
// into the SAME HttpRoute/AuthorizerConfig shapes serverless-state produces.
// Pure module — the only collaborator is the (pure) CloudFormationParser, used
// for intrinsic → ARN reduction. Covers cross-stack targets, local short-name
// resolution, dedup against state routes, the advisory invoke grant, every
// AuthorizationType path and the cross-stack export map.
import {
  CloudFormationParser,
  ApiResource,
  ApiIntegrationResource,
  ApiRouteResource,
  ApiAuthorizerResource,
  LambdaPermissionResource,
  LambdaResource,
  Resource,
} from '../../../src/server/services/cloudformation-parser';
import { assembleRawApiResources, collectStackExports } from '../../../src/server/services/raw-api-assembler';
import type { HttpRoute, RegisteredFunction } from '../../../src/server/services/serverless-state-parser';

const LIST_USERS_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-listUsers';
const AUTHORIZER_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-sessionAuthorizerV2Local';
const SOURCE_ARN = 'arn:aws:execute-api:sa-east-1:000000000000:gw123/*';

let parser: CloudFormationParser;

beforeEach(() => {
  parser = new CloudFormationParser();
});

// --- resource builders ------------------------------------------------------

function api(logicalId: string, cors = false): ApiResource {
  return { type: 'apigw-api', logicalId, name: logicalId, protocolType: 'HTTP', cors };
}

function integration(logicalId: string, over: Partial<ApiIntegrationResource> = {}): ApiIntegrationResource {
  return {
    type: 'apigw-integration',
    logicalId,
    name: logicalId,
    apiRef: 'HttpApi',
    integrationType: 'AWS_PROXY',
    integrationUri: LIST_USERS_ARN,
    payloadFormatVersion: '2.0',
    ...over,
  };
}

function route(logicalId: string, over: Partial<ApiRouteResource> = {}): ApiRouteResource {
  return {
    type: 'apigw-route',
    logicalId,
    name: logicalId,
    apiRef: 'HttpApi',
    routeKey: 'GET /gw/users',
    method: 'GET',
    path: '/gw/users',
    integrationRef: 'Int',
    authorizationType: 'NONE',
    ...over,
  };
}

function authorizer(logicalId: string, over: Partial<ApiAuthorizerResource> = {}): ApiAuthorizerResource {
  return {
    type: 'apigw-authorizer',
    logicalId,
    name: 'sessionAuthorizerV2',
    apiRef: 'HttpApi',
    authorizerType: 'REQUEST',
    identitySource: ['$request.header.authorization'],
    authorizerUri: AUTHORIZER_ARN,
    enableSimpleResponses: true,
    authorizerPayloadFormatVersion: '2.0',
    resultTtlInSeconds: 3600,
    ...over,
  };
}

function permission(logicalId: string, over: Partial<LambdaPermissionResource> = {}): LambdaPermissionResource {
  return {
    type: 'lambda-permission',
    logicalId,
    name: logicalId,
    action: 'lambda:InvokeFunction',
    functionRef: LIST_USERS_ARN,
    principal: 'apigateway.amazonaws.com',
    sourceArn: SOURCE_ARN,
    ...over,
  };
}

function lambdaResource(logicalId: string, name: string): LambdaResource {
  return { type: 'lambda', logicalId, name, handler: '', runtime: 'nodejs20.x', environment: {}, memorySize: 128, timeout: 30 };
}

function fn(name: string, fullName: string): RegisteredFunction {
  return { name, fullName, handler: `src/${name}.handler`, runtime: 'nodejs20.x', memorySize: 128, timeout: 6, environment: {}, triggers: [] };
}

function assemble(resources: Resource[], over: Partial<Parameters<typeof assembleRawApiResources>[1]> = {}) {
  const warnings: string[] = [];
  const result = assembleRawApiResources(parser, {
    resources,
    region: 'sa-east-1',
    localFunctions: [],
    stateRoutes: [],
    warnings,
    ...over,
  });
  return { ...result, warnings };
}

// --- tests ------------------------------------------------------------------

describe('no raw routes', () => {
  it('returns empty lists without touching anything else', () => {
    const { routes, authorizers, warnings } = assemble([api('HttpApi', true), integration('Int')]);
    expect(routes).toEqual([]);
    expect(authorizers).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('cross-stack raw route (the gateway-stack shape)', () => {
  it('registers a CUSTOM route pointing at ANOTHER service\'s Lambda, with authorizer + recorded SourceArn', () => {
    const { routes, authorizers, warnings } = assemble([
      api('HttpApi', true),
      integration('Int'),
      route('R', { authorizationType: 'CUSTOM', authorizerRef: 'Auth' }),
      authorizer('Auth'),
      permission('Perm'),
    ]);

    expect(warnings).toEqual([]);
    expect(routes).toEqual([
      {
        functionName: 'users-service-dev-listUsers',
        method: 'GET',
        path: '/gw/users',
        eventType: 'httpApi',
        cors: true,
        raw: true,
        payloadVersion: '2.0',
        authorizerName: 'sessionAuthorizerV2',
        functionArn: LIST_USERS_ARN,
        sourceArn: SOURCE_ARN,
      },
    ]);
    // The authorizer is cross-service too → carried by ARN, resolved at request time.
    expect(authorizers).toEqual([
      {
        name: 'sessionAuthorizerV2',
        type: 'request',
        eventType: 'httpApi',
        payloadVersion: '2.0',
        enableSimpleResponses: true,
        identitySource: ['$request.header.authorization'],
        resultTtlInSeconds: 3600,
        arn: AUTHORIZER_ARN,
      },
    ]);
  });

  it('reduces a same-template Fn::GetAtt IntegrationUri to a concrete ARN using the service region', () => {
    const { routes } = assemble([
      lambdaResource('FnLambdaFunction', 'gw-dev-handler'),
      integration('Int', { integrationUri: { 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] } }),
      route('R'),
    ]);
    // No local function owns it → carried as a cross-service ARN.
    expect(routes[0].functionArn).toBe('arn:aws:lambda:sa-east-1:000000000000:function:gw-dev-handler');
  });

  // AWS addresses a Lambda integration/authorizer target through an apigateway
  // "invocation URI" that wraps the ARN — NOT a bare Lambda ARN. Both the
  // Serverless-compiled Fn::Join and the hand-written !Sub reduce to it.
  it('unwraps an apigateway invocation-URI IntegrationUri down to the inner Lambda ARN', () => {
    const { routes, warnings } = assemble([
      integration('Int', {
        integrationUri: { 'Fn::Sub': `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/${LIST_USERS_ARN}/invocations` },
      }),
      route('R'),
      permission('Perm'),
    ]);
    expect(routes[0].functionName).toBe('users-service-dev-listUsers');
    expect(routes[0].functionArn).toBe(LIST_USERS_ARN);
    expect(warnings).toEqual([]);
  });

  it('unwraps an apigateway invocation-URI AuthorizerUri down to the inner Lambda ARN', () => {
    const { authorizers } = assemble([
      integration('Int'),
      route('R', { authorizationType: 'CUSTOM', authorizerRef: 'Auth' }),
      authorizer('Auth', {
        // The exact Fn::Join the framework compiles for a REQUEST authorizer.
        authorizerUri: {
          'Fn::Join': ['', [
            'arn:', { Ref: 'AWS::Partition' }, ':apigateway:', { Ref: 'AWS::Region' },
            ':lambda:path/2015-03-31/functions/', AUTHORIZER_ARN, '/invocations',
          ]],
        },
      }),
      permission('Perm'),
    ]);
    expect(authorizers[0].arn).toBe(AUTHORIZER_ARN);
  });

  it('resolves an Fn::ImportValue IntegrationUri against the cross-stack export map', () => {
    const exports = new Map([['users-service-dev-listUsers-arn', LIST_USERS_ARN]]);
    const { routes } = assemble(
      [integration('Int', { integrationUri: { 'Fn::ImportValue': 'users-service-dev-listUsers-arn' } }), route('R')],
      { exports },
    );
    expect(routes[0].functionArn).toBe(LIST_USERS_ARN);
  });
});

describe('local (same-service) raw route', () => {
  it('resolves the target to a local short name, defaults payloadVersion, and warns on a missing invoke grant', () => {
    const { routes, warnings } = assemble(
      [
        // No ::Api ref at all → cors false.
        integration('Int', { payloadFormatVersion: undefined }),
        route('R', { apiRef: undefined }),
      ],
      { localFunctions: [fn('listUsers', 'users-service-dev-listUsers')] },
    );

    expect(routes).toEqual([
      {
        functionName: 'listUsers',
        method: 'GET',
        path: '/gw/users',
        eventType: 'httpApi',
        cors: false,
        raw: true,
        // No PayloadFormatVersion on the integration → HTTP API default '2.0'.
        payloadVersion: '2.0',
      },
    ]);
    // Local target → no functionArn/sourceArn/authorizerName keys.
    expect(routes[0].functionArn).toBeUndefined();
    expect(routes[0].sourceArn).toBeUndefined();
    expect(routes[0].authorizerName).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no AWS::Lambda::Permission');
    expect(warnings[0]).toContain('apigateway.amazonaws.com');
  });

  it('matches a local function by short name when the ARN carries a bare name', () => {
    const { routes } = assemble(
      [integration('Int', { integrationUri: 'shortfn' }), route('R')],
      { localFunctions: [fn('other', 'svc-dev-other'), fn('shortfn', 'svc-dev-shortfn')] },
    );
    expect(routes[0].functionName).toBe('shortfn');
    expect(routes[0].functionArn).toBeUndefined();
  });

  it('builds a LOCAL authorizer by function name rather than ARN', () => {
    const { authorizers } = assemble(
      [
        integration('Int'),
        route('R', { authorizationType: 'CUSTOM', authorizerRef: 'Auth' }),
        authorizer('Auth', { authorizerUri: 'users-service-dev-sessionAuthorizerV2Local' }),
        permission('Perm'),
      ],
      { localFunctions: [fn('sessionAuthorizerV2Local', 'users-service-dev-sessionAuthorizerV2Local')] },
    );
    expect(authorizers[0].functionName).toBe('sessionAuthorizerV2Local');
    expect(authorizers[0].arn).toBeUndefined();
  });
});

describe('de-duplication against serverless-state routes', () => {
  const stateRoutes: HttpRoute[] = [
    { functionName: 'listUsers', method: 'GET', path: '/users', eventType: 'httpApi', cors: true },
  ];

  it('skips a raw ::Route that mirrors a state httpApi event, keeping only genuinely-raw routes', () => {
    const { routes, warnings } = assemble(
      [
        integration('Int'),
        // Mirror of the state route (what Serverless compiles for every httpApi event).
        route('Mirror', { routeKey: 'GET /users', method: 'GET', path: '/users' }),
        // Genuinely raw — no state event covers it.
        route('Raw', { routeKey: 'GET /gw/users' }),
        permission('Perm'),
      ],
      { stateRoutes },
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/gw/users', raw: true });
    // The skipped mirror produced no warning noise.
    expect(warnings).toEqual([]);
  });

  it('also collapses two raw routes that share a RouteKey', () => {
    const { routes } = assemble([
      integration('Int'),
      route('A'),
      route('B'),
      permission('Perm'),
    ]);
    expect(routes).toHaveLength(1);
  });

  it('matches state routes case-insensitively on the method', () => {
    const { routes } = assemble(
      [integration('Int'), route('R', { method: 'GET', path: '/users' })],
      { stateRoutes: [{ ...stateRoutes[0], method: 'get' }] },
    );
    expect(routes).toEqual([]);
  });
});

describe('unusable integrations (warn, never throw)', () => {
  it('skips a route whose Target named no integration', () => {
    const { routes, warnings } = assemble([route('R', { integrationRef: undefined })]);
    expect(routes).toEqual([]);
    expect(warnings[0]).toContain('no ::Integration for Target "(none)"');
  });

  it('skips a route whose integration logical id is absent from the template', () => {
    const { routes, warnings } = assemble([route('R', { integrationRef: 'Ghost' })]);
    expect(routes).toEqual([]);
    expect(warnings[0]).toContain('no ::Integration for Target "Ghost"');
  });

  it('skips a non-AWS_PROXY integration with a warning', () => {
    const { routes, warnings } = assemble([integration('Int', { integrationType: 'HTTP_PROXY' }), route('R')]);
    expect(routes).toEqual([]);
    expect(warnings[0]).toContain('unsupported IntegrationType "HTTP_PROXY"');
  });

  it('defaults a missing IntegrationType to AWS_PROXY (AWS requires it, templates sometimes omit it)', () => {
    const { routes } = assemble([integration('Int', { integrationType: undefined }), route('R'), permission('Perm')]);
    expect(routes).toHaveLength(1);
  });

  it('skips a route whose IntegrationUri does not reduce to anything', () => {
    const { routes, warnings } = assemble([integration('Int', { integrationUri: { Nonsense: true } }), route('R')]);
    expect(routes).toEqual([]);
    expect(warnings[0]).toContain('IntegrationUri did not reduce to a Lambda ARN');
  });
});

describe('AuthorizationType handling', () => {
  it('registers a route unauthorized when CUSTOM names no authorizer', () => {
    const { routes, warnings } = assemble([
      integration('Int'),
      route('R', { authorizationType: 'CUSTOM', authorizerRef: undefined }),
      permission('Perm'),
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0].authorizerName).toBeUndefined();
    expect(warnings[0]).toContain('::Authorizer "(none)" was not found');
  });

  it('registers a route unauthorized when the referenced ::Authorizer is missing', () => {
    const { routes, warnings } = assemble([
      integration('Int'),
      route('R', { authorizationType: 'CUSTOM', authorizerRef: 'Ghost' }),
      permission('Perm'),
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0].authorizerName).toBeUndefined();
    expect(warnings[0]).toContain('::Authorizer "Ghost" was not found');
  });

  it('registers a route unauthorized for a non-REQUEST authorizer type', () => {
    const { routes, authorizers, warnings } = assemble([
      integration('Int'),
      route('R', { authorizationType: 'CUSTOM', authorizerRef: 'Auth' }),
      authorizer('Auth', { authorizerType: 'JWT' }),
      permission('Perm'),
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0].authorizerName).toBeUndefined();
    expect(authorizers).toEqual([]);
    expect(warnings[0]).toContain('is not supported locally (only REQUEST)');
  });

  it('treats a missing AuthorizerType as REQUEST (the only HTTP API custom flavor)', () => {
    const { authorizers } = assemble([
      integration('Int'),
      route('R', { authorizationType: 'CUSTOM', authorizerRef: 'Auth' }),
      authorizer('Auth', { authorizerType: undefined }),
      permission('Perm'),
    ]);
    expect(authorizers).toHaveLength(1);
  });

  it('warns and registers unauthorized for JWT / AWS_IAM routes', () => {
    for (const authorizationType of ['JWT', 'AWS_IAM']) {
      const { routes, warnings } = assemble([
        integration('Int'),
        route('R', { authorizationType }),
        permission('Perm'),
      ]);
      expect(routes).toHaveLength(1);
      expect(routes[0].authorizerName).toBeUndefined();
      expect(warnings[0]).toContain(`AuthorizationType "${authorizationType}" is not supported locally`);
    }
  });

  it('builds a shared authorizer once and reuses it across routes', () => {
    const { routes, authorizers } = assemble([
      integration('Int'),
      route('A', { routeKey: 'GET /a', path: '/a', authorizationType: 'CUSTOM', authorizerRef: 'Auth' }),
      route('B', { routeKey: 'POST /b', method: 'POST', path: '/b', authorizationType: 'CUSTOM', authorizerRef: 'Auth' }),
      authorizer('Auth'),
      permission('Perm'),
    ]);
    expect(routes.map(r => r.authorizerName)).toEqual(['sessionAuthorizerV2', 'sessionAuthorizerV2']);
    expect(authorizers).toHaveLength(1);
  });
});

describe('AWS::Lambda::Permission (advisory invoke grant)', () => {
  it('ignores permissions granted to a different principal', () => {
    const { routes, warnings } = assemble([
      integration('Int'),
      route('R'),
      permission('Perm', { principal: 's3.amazonaws.com' }),
    ]);
    expect(routes[0].sourceArn).toBeUndefined();
    expect(warnings[0]).toContain('no AWS::Lambda::Permission');
  });

  it('ignores an apigateway permission granted on a different function', () => {
    const { routes, warnings } = assemble([
      integration('Int'),
      route('R'),
      permission('Perm', { functionRef: 'arn:aws:lambda:sa-east-1:000000000000:function:some-other-fn' }),
    ]);
    expect(routes[0].sourceArn).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  // CloudFormation's `Ref` on a Lambda yields the function NAME, so a grant and
  // an integration target routinely arrive in different shapes (name vs ARN vs
  // local short name). Normalizing BOTH through resolveTarget is what stops the
  // false "no matching apigateway permission" warning.
  it('matches a {Ref: LogicalId} grant (a NAME) against an ARN integration target', () => {
    const { routes, warnings } = assemble([
      lambdaResource('ListUsersLambdaFunction', 'users-service-dev-listUsers'),
      integration('Int'), // IntegrationUri is the full ARN
      route('R'),
      permission('Perm', { functionRef: { Ref: 'ListUsersLambdaFunction' } }),
    ]);
    expect(routes[0].sourceArn).toBe(SOURCE_ARN);
    expect(warnings).toEqual([]);
  });

  it('matches a grant on the local SHORT name against a target resolved from the full name', () => {
    // The integration names the function by its short name while the grant Refs
    // the Lambda (→ full name): same function, two different spellings.
    const { routes, warnings } = assemble(
      [
        lambdaResource('ListUsersLambdaFunction', 'users-service-dev-listUsers'),
        integration('Int', { integrationUri: 'listUsers' }),
        route('R'),
        permission('Perm', { functionRef: { Ref: 'ListUsersLambdaFunction' } }),
      ],
      { localFunctions: [fn('listUsers', 'users-service-dev-listUsers')] },
    );
    expect(routes[0].sourceArn).toBe(SOURCE_ARN);
    expect(warnings).toEqual([]);
  });

  it('still warns when a {Ref} grant names a logical id the template does not declare', () => {
    const { routes, warnings } = assemble([
      integration('Int'),
      route('R'),
      permission('Perm', { functionRef: { Ref: 'GhostLambdaFunction' } }),
    ]);
    expect(routes[0].sourceArn).toBeUndefined();
    expect(warnings[0]).toContain('no AWS::Lambda::Permission');
  });

  it('records the SourceArn when the grant matches, resolving Fn::Sub pseudo-params', () => {
    const { routes, warnings } = assemble([
      integration('Int'),
      route('R'),
      permission('Perm', {
        sourceArn: { 'Fn::Sub': 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:gw123/*' },
      }),
    ]);
    expect(routes[0].sourceArn).toBe(SOURCE_ARN);
    expect(warnings).toEqual([]);
  });
});

describe('collectStackExports', () => {
  it('is a no-op when the template declares no Outputs', () => {
    const target = new Map<string, string>();
    collectStackExports(parser, [], undefined, 'sa-east-1', target);
    expect(target.size).toBe(0);
  });

  it('records resolvable exported values and skips everything else', () => {
    const target = new Map<string, string>();
    collectStackExports(
      parser,
      [lambdaResource('FnLambdaFunction', 'users-service-dev-listUsers')],
      {
        // Resolves to a concrete Lambda ARN → recorded.
        Qualified: { Value: { 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] }, Export: { Name: 'users-arn' } },
        // Literal string value → recorded.
        Literal: { Value: 'plain-value', Export: { Name: 'literal' } },
        // Unresolvable value → skipped.
        Unresolved: { Value: { Ref: 'SomeBucket' }, Export: { Name: 'bucket' } },
        // No Export block → skipped.
        NotExported: { Value: 'x' },
        // Non-string Export.Name → skipped.
        BadName: { Value: 'x', Export: { Name: 42 } },
        // Non-object output → skipped.
        Nope: null,
      },
      'sa-east-1',
      target,
    );

    expect([...target.entries()].sort()).toEqual([
      ['literal', 'plain-value'],
      ['users-arn', 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-listUsers'],
    ]);
  });
});

describe('end-to-end via CloudFormationParser.parse', () => {
  it('assembles a parsed raw template and dedups it away when state already has the route', () => {
    const template = {
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'users-service-dev-listUsers' } },
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { ProtocolType: 'HTTP', CorsConfiguration: {} } },
        Int: {
          Type: 'AWS::ApiGatewayV2::Integration',
          Properties: {
            ApiId: { Ref: 'HttpApi' },
            IntegrationType: 'AWS_PROXY',
            IntegrationUri: { 'Fn::GetAtt': ['Fn', 'Arn'] },
            PayloadFormatVersion: '2.0',
          },
        },
        R: {
          Type: 'AWS::ApiGatewayV2::Route',
          Properties: {
            ApiId: { Ref: 'HttpApi' },
            RouteKey: 'GET /users',
            Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Int' }]] },
          },
        },
      },
    };
    const resources = parser.parse(template as never);

    // With the matching state event present, the compiled mirror is dropped...
    const deduped = assemble(resources, {
      localFunctions: [fn('listUsers', 'users-service-dev-listUsers')],
      stateRoutes: [{ functionName: 'listUsers', method: 'GET', path: '/users', eventType: 'httpApi', cors: true }],
    });
    expect(deduped.routes).toEqual([]);

    // ...and registered as a genuine local raw route when no state event covers it.
    const raw = assemble(resources, { localFunctions: [fn('listUsers', 'users-service-dev-listUsers')] });
    expect(raw.routes).toHaveLength(1);
    expect(raw.routes[0]).toMatchObject({ functionName: 'listUsers', method: 'GET', path: '/users', cors: true, raw: true });
  });
});
