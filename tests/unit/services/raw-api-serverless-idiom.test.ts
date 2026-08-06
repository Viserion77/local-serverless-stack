// Regression suite for the shape the **Serverless Framework actually emits**
// when a service keeps its normal `httpApi:` events AND hand-writes extra
// AWS::ApiGatewayV2::* resources under `resources:` that hang off the
// framework's OWN ::Api (`ApiId: !Ref HttpApi`).
//
// It is driven from tests/fixtures/apigw-serverless-idiom-template.json — a
// committed `serverless package` snapshot of examples/localstack-free/
// users-service, NOT a hand-written approximation. That distinction is the
// whole point of this file: LSS 0.16.0 shipped raw-route support that passed a
// hand-authored fixture (literal `Target`, its own `::Api`) and then skipped
// every real route in a downstream project with
//   Raw route "...": no ::Integration for Target "(none)"; route skipped.
//
// The four intrinsics the framework emits, each covered below:
//   A  Target:        { "Fn::Sub": "integrations/${LogicalId}" }
//   B  AuthorizerUri: { "Fn::Sub": "arn:aws:apigateway:${AWS::Region}:lambda:
//                       path/2015-03-31/functions/${LogicalId.Arn}/invocations" }
//      (and the same apigateway invocation-URI wrapper on IntegrationUri)
//   C  Permission FunctionName: { "Ref": LogicalId }  → a NAME, never an ARN
//   D  SourceArn:     { "Fn::Sub": "...:${AWS::AccountId}:${HttpApi}/*" }
//
// Plus the de-dup guarantee: this single template carries BOTH the framework's
// compiled ::Route mirrors of the httpApi events and the genuinely-raw routes,
// so double-registration is a live risk here, not a theoretical one.
import fs from 'fs';
import path from 'path';
import { CloudFormationParser } from '../../../src/server/services/cloudformation-parser';
import { assembleRawApiResources } from '../../../src/server/services/raw-api-assembler';
import type { HttpRoute, RegisteredFunction } from '../../../src/server/services/serverless-state-parser';

const FIXTURE = path.resolve(__dirname, '../../fixtures/apigw-serverless-idiom-template.json');

const LIST_USERS_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-listUsers';
const CREATE_USER_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-createUser';

function fn(name: string, fullName: string): RegisteredFunction {
  return { name, fullName, handler: `src/handlers/${name}.handler`, runtime: 'nodejs20.x', memorySize: 1024, timeout: 6, environment: {}, triggers: [] };
}

// users-service's functions, exactly as serverless-state registers them.
const LOCAL_FUNCTIONS = [
  fn('sessionAuthorizerV2Local', 'users-service-dev-sessionAuthorizerV2Local'),
  fn('listUsers', 'users-service-dev-listUsers'),
  fn('createUser', 'users-service-dev-createUser'),
  fn('getUser', 'users-service-dev-getUser'),
];

// ...and the routes serverless-state yields for its three `httpApi:` events.
// The template ALSO holds the framework's compiled ::Route mirrors of these.
const STATE_ROUTES: HttpRoute[] = [
  { functionName: 'listUsers', method: 'GET', path: '/users', eventType: 'httpApi', cors: true, authorizerName: 'sessionAuthorizerV2' },
  { functionName: 'createUser', method: 'POST', path: '/users', eventType: 'httpApi', cors: true, authorizerName: 'sessionAuthorizerV2' },
  { functionName: 'getUser', method: 'GET', path: '/users/{id}', eventType: 'httpApi', cors: true, authorizerName: 'sessionAuthorizerV2' },
];

let parser: CloudFormationParser;

beforeEach(() => {
  parser = new CloudFormationParser();
});

function assembleUsersService(over: { stateRoutes?: HttpRoute[] } = {}) {
  const warnings: string[] = [];
  const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const resources = parser.parse(template, warnings);
  const result = assembleRawApiResources(parser, {
    resources,
    region: 'sa-east-1',
    localFunctions: LOCAL_FUNCTIONS,
    stateRoutes: over.stateRoutes ?? STATE_ROUTES,
    warnings,
  });
  return { ...result, warnings, resources };
}

describe('serverless-emitted raw routes on the framework\'s own HttpApi', () => {
  it('registers both /api/identity/spaces routes — the exact shape that used to be skipped', () => {
    const { routes, warnings } = assembleUsersService();

    // The 0.16.0 symptom, gone.
    expect(warnings.filter(w => w.includes('no ::Integration for Target'))).toEqual([]);
    expect(warnings).toEqual([]);

    expect(routes.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /api/identity/spaces',
      'POST /api/identity/spaces',
    ]);
  });

  // --- A: Target via Fn::Sub -----------------------------------------------
  it('(A) resolves Target: !Sub "integrations/${LogicalId}" to the ::Integration', () => {
    const { resources } = assembleUsersService();
    const raw = resources.filter(r => r.type === 'apigw-route' && r.logicalId.startsWith('Spaces'));
    expect(raw.map(r => (r as { integrationRef?: string }).integrationRef)).toEqual([
      'SpacesIntegration',
      'SpacesWriteIntegration',
    ]);
  });

  it('(A) keeps resolving the framework\'s own Fn::Join targets (no regression)', () => {
    const { resources } = assembleUsersService();
    const mirror = resources.find(
      r => 'logicalId' in r && r.logicalId === 'HttpApiRouteGetUsers',
    ) as { integrationRef?: string };
    expect(mirror.integrationRef).toBe('HttpApiIntegrationListUsers');
  });

  // --- B: apigateway invocation-URI wrapper --------------------------------
  it('(B) unwraps the apigateway invocation-URI IntegrationUri down to the inner Lambda', () => {
    const { routes } = assembleUsersService();
    // Both targets are users-service's OWN functions → local short names, no ARN.
    expect(routes.map(r => r.functionName)).toEqual(['listUsers', 'createUser']);
    expect(routes.every(r => r.functionArn === undefined)).toBe(true);
  });

  it('(B) unwraps the apigateway invocation-URI AuthorizerUri down to the inner Lambda', () => {
    const { authorizers } = assembleUsersService();
    expect(authorizers).toEqual([
      {
        name: 'identitySpacesAuthorizer',
        type: 'request',
        eventType: 'httpApi',
        payloadVersion: '2.0',
        enableSimpleResponses: true,
        identitySource: ['$request.header.authorization'],
        resultTtlInSeconds: 3600,
        functionName: 'sessionAuthorizerV2Local',
      },
    ]);
    // Not the raw URI, and not a dangling ${...} token.
    expect(authorizers[0].functionName).not.toContain('invocations');
    expect(authorizers[0].arn).toBeUndefined();
  });

  it('(B) attaches the authorizer to every route that references it', () => {
    const { routes } = assembleUsersService();
    expect(routes.map(r => r.authorizerName)).toEqual(['identitySpacesAuthorizer', 'identitySpacesAuthorizer']);
  });

  // --- C: Permission FunctionName as {Ref} ---------------------------------
  it('(C) matches the invoke grant whose FunctionName is {Ref: LogicalId} (a NAME, not an ARN)', () => {
    const { routes, warnings } = assembleUsersService();
    // No FALSE "no matching apigateway permission" warning...
    expect(warnings.filter(w => w.includes('no AWS::Lambda::Permission'))).toEqual([]);
    // ...and the grant's SourceArn made it onto both routes.
    expect(routes.every(r => typeof r.sourceArn === 'string' && r.sourceArn.length > 0)).toBe(true);
  });

  // --- D: SourceArn via Fn::Sub with ${HttpApi} ----------------------------
  it('(D) reduces SourceArn: !Sub "...:${AWS::AccountId}:${HttpApi}/*" with no leftover tokens', () => {
    const { routes, warnings } = assembleUsersService();
    for (const route of routes) {
      expect(route.sourceArn).toBe('arn:aws:execute-api:sa-east-1:000000000000:dev-users-service/*');
      expect(route.sourceArn).not.toContain('${');
    }
    // Advisory only — resolving it must never add warning noise.
    expect(warnings).toEqual([]);
  });

  // --- de-dup: native httpApi events + raw routes in ONE template ----------
  it('drops the framework\'s compiled ::Route mirrors so httpApi events register exactly once', () => {
    const { routes } = assembleUsersService();
    const paths = routes.map(r => `${r.method} ${r.path}`);
    expect(paths).not.toContain('GET /users');
    expect(paths).not.toContain('POST /users');
    expect(paths).not.toContain('GET /users/{id}');
    expect(routes).toHaveLength(2);
  });

  it('registers the mirrors as raw routes only when serverless-state has none of them', () => {
    // A stateless registration (no serverless-state.json) must NOT lose the API:
    // every compiled mirror plus the raw routes come through exactly once.
    const { routes, warnings } = assembleUsersService({ stateRoutes: [] });
    expect(routes.map(r => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/identity/spaces',
      'GET /users',
      'GET /users/{id}',
      'POST /api/identity/spaces',
      'POST /users',
    ]);
    expect(warnings).toEqual([]);
    // The framework's own Fn::Join AuthorizerUri is the same apigateway
    // invocation-URI wrapper, so it must unwrap too.
    const compiled = routes.find(r => r.path === '/users' && r.method === 'GET')!;
    expect(compiled.functionName).toBe('listUsers');
    expect(compiled.authorizerName).toBe('sessionAuthorizerV2');
  });

  it('carries a cross-stack target by ARN when the Lambda is not local', () => {
    const warnings: string[] = [];
    const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const resources = parser.parse(template, warnings);
    // The same template registered by a service that owns none of these Lambdas.
    const { routes } = assembleRawApiResources(parser, {
      resources,
      region: 'sa-east-1',
      localFunctions: [],
      stateRoutes: [],
      warnings,
    });
    const get = routes.find(r => r.path === '/api/identity/spaces' && r.method === 'GET')!;
    const post = routes.find(r => r.path === '/api/identity/spaces' && r.method === 'POST')!;
    expect(get.functionArn).toBe(LIST_USERS_ARN);
    expect(post.functionArn).toBe(CREATE_USER_ARN);
    expect(warnings).toEqual([]);
  });
});
