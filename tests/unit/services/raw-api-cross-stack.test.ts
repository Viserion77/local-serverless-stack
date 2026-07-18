// Data-plane proof for raw cross-stack ApiGatewayV2 routes, driven from the
// EXACT CloudFormation shape examples/localstack-free/gateway-stack compiles to:
// a gateway service that owns no Lambdas at all, whose ::Route/::Integration/
// ::Authorizer point by ARN at users-service's functions.
//
// Everything here is the real thing — CloudFormationParser, the assembler,
// FunctionRegistry, matchRoute and AuthorizerService — except
// LambdaRuntimeManager, which is jest.mocked because the real module forks
// worker processes. That means the cross-stack ARN → function resolution and
// the authorizer decisions run for real, in-process, with no Docker.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { CloudFormationParser } from '../../../src/server/services/cloudformation-parser';
import { assembleRawApiResources } from '../../../src/server/services/raw-api-assembler';
import { FunctionRegistry } from '../../../src/server/services/function-registry';
import { AuthorizerService } from '../../../src/server/services/authorizer-service';
import { LambdaRuntimeManager } from '../../../src/server/services/lambda-runtime-manager';
import { matchRoute } from '../../../src/server/services/api-gateway-events';
import type { HttpRoute, RegisteredFunction, AuthorizerConfig } from '../../../src/server/services/serverless-state-parser';
import type { IncomingRequest } from '../../../src/server/services/api-gateway-events';

const invokeMock = LambdaRuntimeManager.getInstance().invoke as jest.Mock;

const LIST_USERS_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-listUsers';
const AUTHORIZER_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-sessionAuthorizerV2Local';

// What `sls package` emits for gateway-stack/serverless.yml (the ${self:...}
// interpolations are already resolved to literal ARNs at package time).
const GATEWAY_STACK_TEMPLATE = {
  Resources: {
    GatewayHttpApi: {
      Type: 'AWS::ApiGatewayV2::Api',
      Properties: {
        Name: 'gateway-stack-dev',
        ProtocolType: 'HTTP',
        CorsConfiguration: { AllowOrigins: ['*'], AllowMethods: ['*'], AllowHeaders: ['*'] },
      },
    },
    ListUsersIntegration: {
      Type: 'AWS::ApiGatewayV2::Integration',
      Properties: {
        ApiId: { Ref: 'GatewayHttpApi' },
        IntegrationType: 'AWS_PROXY',
        PayloadFormatVersion: '2.0',
        TimeoutInMillis: 30000,
        IntegrationUri: LIST_USERS_ARN,
      },
    },
    ListUsersRoute: {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: { Ref: 'GatewayHttpApi' },
        RouteKey: 'GET /gw/users',
        Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'ListUsersIntegration' }]] },
        AuthorizationType: 'CUSTOM',
        AuthorizerId: { Ref: 'SessionAuthorizer' },
      },
    },
    SessionAuthorizer: {
      Type: 'AWS::ApiGatewayV2::Authorizer',
      Properties: {
        ApiId: { Ref: 'GatewayHttpApi' },
        Name: 'gatewaySessionAuthorizer',
        AuthorizerType: 'REQUEST',
        AuthorizerPayloadFormatVersion: '2.0',
        EnableSimpleResponses: true,
        AuthorizerResultTtlInSeconds: 3600,
        IdentitySource: ['$request.header.authorization'],
        AuthorizerUri: AUTHORIZER_ARN,
      },
    },
    ListUsersInvokePermission: {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        Action: 'lambda:InvokeFunction',
        FunctionName: LIST_USERS_ARN,
        Principal: 'apigateway.amazonaws.com',
        SourceArn: { 'Fn::Sub': 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${GatewayHttpApi}/*' },
      },
    },
  },
};

function fn(name: string, fullName: string): RegisteredFunction {
  return { name, fullName, handler: `src/handlers/${name}.handler`, runtime: 'nodejs20.x', memorySize: 1024, timeout: 6, environment: {}, triggers: [] };
}

function req(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return { method: 'GET', path: '/gw/users', rawQueryString: '', headers: {}, body: null, sourceIp: '127.0.0.1', ...overrides };
}

// The gateway-stack side: parse its template and assemble the raw resources.
function assembleGatewayStack(warnings: string[] = []) {
  const parser = new CloudFormationParser();
  const resources = parser.parse(GATEWAY_STACK_TEMPLATE as never, warnings);
  return assembleRawApiResources(parser, {
    resources,
    region: 'sa-east-1',
    localFunctions: [], // gateway-stack owns no Lambdas
    stateRoutes: [],    // and declares no httpApi: events
    warnings,
  });
}

// The users-service side, as serverless-state produces it.
const USERS_FUNCTIONS = [
  fn('listUsers', 'users-service-dev-listUsers'),
  fn('sessionAuthorizerV2Local', 'users-service-dev-sessionAuthorizerV2Local'),
];
const USERS_ROUTES: HttpRoute[] = [
  { functionName: 'listUsers', method: 'GET', path: '/users', eventType: 'httpApi', cors: true, authorizerName: 'sessionAuthorizerV2' },
];

function registerUsersService() {
  FunctionRegistry.getInstance().registerService({
    name: 'users-service', root: '/abs/users-service', templateHash: 'h', lastUpdated: 1, status: 'registered',
    apiPort: 3610, invokePort: 13610, region: 'sa-east-1', stage: 'dev',
    functions: USERS_FUNCTIONS, routes: USERS_ROUTES, authorizers: [],
  });
}

function registerGatewayStack(routes: HttpRoute[], authorizers: AuthorizerConfig[]) {
  FunctionRegistry.getInstance().registerService({
    name: 'gateway-stack', root: '/abs/gateway-stack', templateHash: 'h', lastUpdated: 1, status: 'registered',
    apiPort: 3613, invokePort: 13613, region: 'sa-east-1', stage: 'dev',
    functions: [], routes, authorizers,
  });
}

let authService: AuthorizerService;

beforeEach(() => {
  (AuthorizerService as any).instance = undefined;
  (FunctionRegistry as any).instance = undefined;
  authService = AuthorizerService.getInstance();
  invokeMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('gateway-stack raw topology', () => {
  it('produces one authorized cross-stack route from resources: alone — no httpApi event, no catch-all', () => {
    const warnings: string[] = [];
    const { routes, authorizers } = assembleGatewayStack(warnings);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'GET',
      path: '/gw/users',
      eventType: 'httpApi',
      cors: true,
      raw: true,
      payloadVersion: '2.0',
      functionArn: LIST_USERS_ARN,
      authorizerName: 'gatewaySessionAuthorizer',
    });
    // The Lambda::Permission was matched, so the granting API is recorded.
    expect(routes[0].sourceArn).toContain('arn:aws:execute-api:sa-east-1:000000000000:');
    // A matched grant means no "ungranted function" warning.
    expect(warnings).toEqual([]);

    expect(authorizers).toEqual([
      {
        name: 'gatewaySessionAuthorizer',
        type: 'request',
        eventType: 'httpApi',
        payloadVersion: '2.0',
        enableSimpleResponses: true,
        identitySource: ['$request.header.authorization'],
        resultTtlInSeconds: 3600,
        arn: AUTHORIZER_ARN,
      },
    ]);

    // Nothing anywhere stands in for the raw topology.
    expect(routes.map(r => r.path)).not.toContain('/api/{proxy+}');
    expect(routes.map(r => r.path)).not.toContain('$default');
  });

  it('resolves the cross-stack target regardless of registration order', () => {
    const { routes, authorizers } = assembleGatewayStack();

    // Gateway registered FIRST, while users-service is still unknown.
    registerGatewayStack(routes, authorizers);
    expect(FunctionRegistry.getInstance().resolve(routes[0].functionArn!)).toBeUndefined();

    // users-service arrives later — the ARN now resolves, with no re-register.
    registerUsersService();
    const resolved = FunctionRegistry.getInstance().resolve(routes[0].functionArn!)!;
    expect(resolved.service.name).toBe('users-service');
    expect(resolved.fn.name).toBe('listUsers');
    expect(resolved.fn.fullName).toBe('users-service-dev-listUsers');
  });

  it('matches the raw route by literal precedence over a state {proxy+} route on the same registry', () => {
    const { routes } = assembleGatewayStack();
    // A catch-all from serverless-state coexisting with the literal raw route:
    // API Gateway prefers the literal segment, and so must LSS.
    const proxyRoute: HttpRoute = { functionName: 'fallback', method: 'ANY', path: '/gw/{proxy+}', eventType: 'httpApi', cors: false };
    const all = [proxyRoute, ...routes];

    const match = matchRoute(all, 'GET', '/gw/users')!;
    expect(match.route.functionArn).toBe(LIST_USERS_ARN);
    expect(match.route.raw).toBe(true);

    // A path the literal route does not cover still falls to the catch-all.
    expect(matchRoute(all, 'GET', '/gw/other/thing')!.route.functionName).toBe('fallback');
  });
});

describe('cross-stack authorizer enforcement (AuthorizerService, real resolution)', () => {
  function authorize(request: IncomingRequest) {
    const { routes, authorizers } = assembleGatewayStack();
    registerUsersService();
    registerGatewayStack(routes, authorizers);
    const config = FunctionRegistry.getInstance().getAuthorizer('gateway-stack', routes[0].authorizerName!)!;
    return authService.authorize('gateway-stack', 'dev', routes[0], config, request);
  }

  it('401s without invoking the authorizer when the identity source header is absent', async () => {
    const decision = await authorize(req({ headers: {} }));
    expect(decision.deniedStatus).toBe(401);
    // AWS never calls the authorizer when an identity source is missing.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('403s when the cross-stack authorizer denies (simple response isAuthorized:false)', async () => {
    invokeMock.mockResolvedValue({ ok: true, payload: { isAuthorized: false }, logs: [] });
    const decision = await authorize(req({ headers: { authorization: 'Bearer wrong' } }));
    expect(decision.deniedStatus).toBe(403);
  });

  it('allows with context, invoking the OWNING service\'s authorizer Lambda by ARN', async () => {
    invokeMock.mockResolvedValue({ ok: true, payload: { isAuthorized: true, context: { user: 'ts-user' } }, logs: [] });
    const decision = await authorize(req({ headers: { authorization: 'Bearer lss-secret' } }));

    expect(decision.deniedStatus).toBeUndefined();
    expect(decision.authorizer).toEqual({ context: { user: 'ts-user' } });

    // The invoke crossed the service boundary: users-service ran it, not gateway-stack.
    const [serviceName, invokedFn, event] = invokeMock.mock.calls[0];
    expect(serviceName).toBe('users-service');
    expect(invokedFn.fullName).toBe('users-service-dev-sessionAuthorizerV2Local');
    // Payload v2 REQUEST authorizer envelope carrying the raw route's key.
    expect(event).toMatchObject({ version: '2.0', type: 'REQUEST', routeKey: 'GET /gw/users' });
  });

  it('500s when the owning service is not registered at all', async () => {
    const { routes, authorizers } = assembleGatewayStack();
    registerGatewayStack(routes, authorizers); // users-service deliberately absent
    const config = FunctionRegistry.getInstance().getAuthorizer('gateway-stack', routes[0].authorizerName!)!;
    const decision = await authService.authorize('gateway-stack', 'dev', routes[0], config, req({ headers: { authorization: 'Bearer lss-secret' } }));
    expect(decision.deniedStatus).toBe(500);
  });
});
