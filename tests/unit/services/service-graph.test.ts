// Unit tests for the service graph. Pure module: no I/O, no mocking. Every case
// is a hand-written packaged template put through the REAL CloudFormationParser
// and handed to buildServiceGraph exactly the way GET /api/services/:name/graph
// does — raw template plus the parsed Resource[] — because the module reads BOTH
// (IAM roles and SNS subscriptions only exist in the raw one). The committed
// sample-microservice template closes the suite end-to-end.
import fs from 'fs';
import path from 'path';
import {
  buildServiceGraph,
  parseResourceArn,
  BuildServiceGraphInput,
  GraphEdge,
  GraphNode,
  ServiceGraph,
} from '../../../src/server/services/service-graph';
import { CloudFormationParser, LambdaResource } from '../../../src/server/services/cloudformation-parser';
import {
  RegisteredFunction,
  HttpRoute,
  AuthorizerConfig,
} from '../../../src/server/services/serverless-state-parser';

// The same committed snapshot the parser suite uses: 9 lambdas on ONE role with
// dynamodb-stream + sqs statements, 2 event-source mappings, an S3 notification
// and 3 tables — i.e. every rendering this module has, in one real template.
const SAMPLE = path.resolve(__dirname, '../../fixtures/sample-microservice-template.json');

let parser: CloudFormationParser;

beforeEach(() => {
  parser = new CloudFormationParser();
});

// Builds the graph the way the route does. `extra` comes last so a test can
// substitute a hand-built Resource[] for the parsed one when it needs a shape
// the parser cannot produce.
function graphOf(template: Record<string, unknown>, extra: Partial<BuildServiceGraphInput> = {}): ServiceGraph {
  return buildServiceGraph({
    serviceName: 'svc',
    template,
    resources: parser.parse(template as never),
    ...extra,
  });
}

function node(graph: ServiceGraph, id: string): GraphNode | undefined {
  return graph.nodes.find(n => n.id === id);
}

function edge(graph: ServiceGraph, from: string, to: string): GraphEdge | undefined {
  return graph.edges.find(e => e.from === from && e.to === to);
}

function edgesOfKind(graph: ServiceGraph, kind: GraphEdge['kind']): GraphEdge[] {
  return graph.edges.filter(e => e.kind === kind);
}

function registeredFunction(
  name: string,
  fullName: string,
  environment: Record<string, string> = {},
): RegisteredFunction {
  return {
    name,
    fullName,
    handler: 'src/handlers/x.handler',
    runtime: 'nodejs20.x',
    memorySize: 1024,
    timeout: 6,
    environment,
    triggers: [],
  };
}

function httpRoute(method: string, routePath: string, functionName: string, overrides: Partial<HttpRoute> = {}): HttpRoute {
  return { functionName, method, path: routePath, eventType: 'httpApi', cors: false, ...overrides };
}

function authorizerConfig(name: string, overrides: Partial<AuthorizerConfig> = {}): AuthorizerConfig {
  return {
    name,
    type: 'request',
    eventType: 'httpApi',
    payloadVersion: '2.0',
    enableSimpleResponses: true,
    identitySource: ['$request.header.authorization'],
    resultTtlInSeconds: 0,
    ...overrides,
  };
}

// The Serverless Framework's own shape: ONE AWS::IAM::Role carrying a single
// PolicyDocument, with every AWS::Lambda::Function bound to it by Fn::GetAtt.
function roleTemplate(
  statements: unknown[],
  extra: Record<string, unknown> = {},
  lambdaIds: string[] = ['WorkerLambdaFunction'],
): Record<string, unknown> {
  const lambdas: Record<string, unknown> = {};
  for (const logicalId of lambdaIds) {
    lambdas[logicalId] = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `svc-dev-${logicalId}`,
        Handler: 'src/handlers/x.handler',
        Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] },
      },
    };
  }
  return {
    Resources: {
      IamRoleLambdaExecution: {
        Type: 'AWS::IAM::Role',
        Properties: { Policies: [{ PolicyDocument: { Statement: statements } }] },
      },
      ...lambdas,
      ...extra,
    },
  };
}

const ORDERS_TABLE = { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'svc-Orders' } };
const JOBS_QUEUE = { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'svc-jobs' } };

describe('nodes', () => {
  it('creates one node per declared resource and none for the API Gateway plumbing', () => {
    const graph = graphOf({
      Resources: {
        WorkerLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-dev-worker', Handler: 'src/handlers/worker.handler' },
        },
        OrdersTable: ORDERS_TABLE,
        JobsQueue: JOBS_QUEUE,
        EventsTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'svc-events' } },
        UploadsBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'svc-uploads' } },
        DbSecret: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: 'svc/dev/db' } },
        DomainBus: { Type: 'AWS::Events::EventBus', Properties: { Name: 'svc-domain' } },
        NightlyRule: { Type: 'AWS::Events::Rule', Properties: { Name: 'svc-nightly' } },
        SearchCollection: {
          Type: 'AWS::OpenSearchServerless::Collection',
          Properties: { Name: 'svc-search' },
        },
        // Everything below is how a route is WIRED, not something a developer
        // reasons about: the graph must drop it rather than bury the nine real
        // nodes under framework boxes.
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'svc-api' } },
        HttpApiIntegration: { Type: 'AWS::ApiGatewayV2::Integration', Properties: {} },
        HttpApiRoute: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: 'GET /x' } },
        HttpApiAuthorizer: { Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { Name: 'auth' } },
        WorkerPermission: { Type: 'AWS::Lambda::Permission', Properties: {} },
      },
    });

    expect(graph.service).toBe('svc');
    expect(graph.nodes.map(n => n.id).sort()).toEqual([
      'dynamodb:OrdersTable',
      'event-rule:NightlyRule',
      'eventbus:DomainBus',
      'lambda:WorkerLambdaFunction',
      'opensearch:SearchCollection',
      's3:UploadsBucket',
      'secret:DbSecret',
      'sns:EventsTopic',
      'sqs:JobsQueue',
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.edgeKinds).toEqual([]);
    expect(graph.warnings).toEqual([]);
  });

  it('labels a node by its declared name, falling back to the logical id when the name is not a string', () => {
    // A `TableName: {Fn::Sub: …}` reaches the parser as an object cast to
    // string — rendering it would print "[object Object]" on the canvas.
    const graph = graphOf({
      Resources: {
        OrdersTable: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { TableName: { 'Fn::Sub': '${AWS::StackName}-orders' } },
        },
        JobsQueue: JOBS_QUEUE,
      },
    });
    expect(node(graph, 'dynamodb:OrdersTable')).toMatchObject({ label: 'OrdersTable', logicalId: 'OrdersTable' });
    expect(node(graph, 'sqs:JobsQueue')).toMatchObject({ label: 'svc-jobs' });
  });

  it('carries fullName/handler on a Lambda node and relabels it with the serverless-state short name', () => {
    const template = {
      Resources: {
        CreateUserLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-dev-createUser', Handler: 'src/handlers/users.create' },
        },
      },
    };

    // No serverless-state at all: the template's FULL name is the only label.
    expect(node(graphOf(template), 'lambda:CreateUserLambdaFunction')).toEqual({
      id: 'lambda:CreateUserLambdaFunction',
      kind: 'lambda',
      label: 'svc-dev-createUser',
      logicalId: 'CreateUserLambdaFunction',
      fullName: 'svc-dev-createUser',
      handler: 'src/handlers/users.create',
    });

    // With it, the SHORT name — the key the dashboard's Lambda screen uses.
    const matched = graphOf(template, { functions: [registeredFunction('createUser', 'svc-dev-createUser')] });
    expect(node(matched, 'lambda:CreateUserLambdaFunction')!.label).toBe('createUser');

    // A function list that names something else leaves the label alone.
    const unmatched = graphOf(template, { functions: [registeredFunction('other', 'svc-dev-other')] });
    expect(node(unmatched, 'lambda:CreateUserLambdaFunction')!.label).toBe('svc-dev-createUser');
  });
});

describe('http routes', () => {
  const template = {
    Resources: {
      CreateUserLambdaFunction: {
        Type: 'AWS::Lambda::Function',
        Properties: { FunctionName: 'svc-dev-createUser' },
      },
    },
  };
  const functions = [registeredFunction('createUser', 'svc-dev-createUser')];

  it('draws a route node per declared route and an edge to the function that serves it', () => {
    const graph = graphOf(template, {
      functions,
      routes: [
        httpRoute('POST', '/users', 'createUser'),
        httpRoute('GET', '/users', 'createUser', { eventType: 'http' }),
      ],
    });

    expect(node(graph, 'route:POST /users')).toEqual({
      id: 'route:POST /users',
      kind: 'route',
      label: 'POST /users',
      method: 'POST',
      path: '/users',
    });
    expect(edge(graph, 'route:POST /users', 'lambda:CreateUserLambdaFunction')).toMatchObject({
      kind: 'http-route',
      detail: 'HTTP API',
      confidence: 'declared',
    });
    expect(edge(graph, 'route:GET /users', 'lambda:CreateUserLambdaFunction')!.detail).toBe('REST');
    expect(graph.edgeKinds).toEqual(['http-route']);
  });

  it('points a route at an external node when the target function is not declared here', () => {
    const graph = graphOf(template, {
      functions: [
        ...functions,
        // Known to serverless-state but with no AWS::Lambda::Function in this
        // template — the short-name join finds the function and still no node.
        registeredFunction('ghost', 'svc-dev-ghost'),
      ],
      routes: [
        httpRoute('GET', '/orders', 'listOrders', {
          eventType: 'http',
          functionArn: 'arn:aws:lambda:us-east-1:000000000000:function:orders-service-dev-listOrders',
        }),
        httpRoute('GET', '/ghost', 'ghost', { functionArn: 'legacy-handler' }),
      ],
    });

    const externalArn = 'external:arn:aws:lambda:us-east-1:000000000000:function:orders-service-dev-listOrders';
    expect(node(graph, externalArn)).toMatchObject({
      kind: 'external',
      // A Lambda ARN delimits its `function` discriminator with a COLON;
      // parseResourceArn strips both that and the slash form, so the label is
      // the function name and not the discriminator. See the parseResourceArn
      // suite.
      label: 'orders-service-dev-listOrders',
      service: 'lambda',
    });
    expect(edge(graph, 'route:GET /orders', externalArn)!.detail).toBe('REST');
    // A target that is not even an ARN keeps its raw string as the label, and
    // the caller's fallback kind supplies the service.
    expect(node(graph, 'external:legacy-handler')).toMatchObject({ label: 'legacy-handler', service: 'lambda' });
    expect(edge(graph, 'route:GET /ghost', 'external:legacy-handler')!.detail).toBe('HTTP API');
  });

  it('warns about a route naming a function this service does not declare', () => {
    const graph = graphOf(template, {
      functions,
      routes: [httpRoute('DELETE', '/orders/{id}', 'deleteOrder')],
    });
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      'Route DELETE /orders/{id} names function "deleteOrder", which this service does not declare',
    ]);
  });
});

describe('authorizers', () => {
  const template = {
    Resources: {
      ListUsersLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-listUsers' } },
      AuthorizerLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-sessionAuthorizer' } },
    },
  };
  const functions = [
    registeredFunction('listUsers', 'svc-dev-listUsers'),
    registeredFunction('sessionAuthorizer', 'svc-dev-sessionAuthorizer'),
  ];

  it('draws the authorizer function → route edge, labelled with the authorizer type', () => {
    const graph = graphOf(template, {
      functions,
      routes: [
        httpRoute('GET', '/users', 'listUsers', { authorizerName: 'sessionAuthorizer' }),
        // An unguarded route on the same API must not grow an authorizer edge.
        httpRoute('GET', '/health', 'listUsers'),
      ],
      authorizers: [authorizerConfig('sessionAuthorizer', { functionName: 'sessionAuthorizer' })],
    });
    expect(edge(graph, 'lambda:AuthorizerLambdaFunction', 'route:GET /users')).toMatchObject({
      kind: 'authorizer',
      detail: 'request',
      confidence: 'declared',
    });
    expect(edgesOfKind(graph, 'authorizer')).toHaveLength(1);
  });

  it('falls back to the authorizer ARN when the guard lives in another service', () => {
    const arn = 'arn:aws:lambda:us-east-1:000000000000:function:identity-service-dev-authorize';
    const graph = graphOf(template, {
      functions,
      routes: [
        httpRoute('GET', '/users', 'listUsers', { authorizerName: 'sharedAuthorizer' }),
        httpRoute('GET', '/orders', 'listUsers', { authorizerName: 'movedAuthorizer' }),
      ],
      authorizers: [
        authorizerConfig('sharedAuthorizer', { arn }),
        // A short name serverless-state kept but whose function is gone: the
        // ARN is what still resolves.
        authorizerConfig('movedAuthorizer', { functionName: 'gone', arn }),
      ],
    });
    expect(edge(graph, `external:${arn}`, 'route:GET /users')!.kind).toBe('authorizer');
    expect(edge(graph, `external:${arn}`, 'route:GET /orders')!.kind).toBe('authorizer');
    // Both routes point at the SAME external node — it is created once.
    expect(graph.nodes.filter(n => n.kind === 'external')).toHaveLength(1);
  });

  it('warns about an undeclared authorizer and about one that resolves to nothing', () => {
    const graph = graphOf(template, {
      functions,
      routes: [
        httpRoute('GET', '/users', 'listUsers', { authorizerName: 'ghostAuthorizer' }),
        httpRoute('GET', '/orders', 'listUsers', { authorizerName: 'emptyAuthorizer' }),
      ],
      authorizers: [authorizerConfig('emptyAuthorizer')],
    });
    expect(edgesOfKind(graph, 'authorizer')).toEqual([]);
    expect(graph.warnings).toEqual([
      'Route GET /users names authorizer "ghostAuthorizer", which this service does not declare',
      'Authorizer "emptyAuthorizer" resolves to neither a local function nor an ARN',
    ]);
  });
});

describe('event-source mappings', () => {
  it('draws SQS → Lambda and DynamoDB stream → Lambda, with the batch size on the label', () => {
    const graph = graphOf({
      Resources: {
        ProcessJobLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-processJob' } },
        OnOrderStreamLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-onOrderStream' } },
        JobsQueue: JOBS_QUEUE,
        OrdersTable: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { TableName: 'svc-Orders', StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } },
        },
        JobsMapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            BatchSize: 5,
            EventSourceArn: { 'Fn::GetAtt': ['JobsQueue', 'Arn'] },
            FunctionName: { 'Fn::GetAtt': ['ProcessJobLambdaFunction', 'Arn'] },
          },
        },
        StreamMapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            BatchSize: 10,
            EventSourceArn: { 'Fn::GetAtt': ['OrdersTable', 'StreamArn'] },
            FunctionName: { 'Fn::GetAtt': ['OnOrderStreamLambdaFunction', 'Arn'] },
          },
        },
      },
    });

    expect(edge(graph, 'sqs:JobsQueue', 'lambda:ProcessJobLambdaFunction')).toMatchObject({
      kind: 'event-source',
      detail: 'poll ×5',
      confidence: 'declared',
    });
    // A DynamoDB source is the table's STREAM, not the table's data plane.
    expect(edge(graph, 'dynamodb:OrdersTable', 'lambda:OnOrderStreamLambdaFunction')!.detail).toBe('stream ×10');
  });

  it('resolves a literal stream ARN to the declared table and omits an absent batch size', () => {
    // The stream ARN carries a creation timestamp nobody can predict at synth
    // time, so only the `table/<name>` head is matched.
    const graph = graphOf({
      Resources: {
        OnOrderStreamLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-onOrderStream' } },
        OrdersTable: ORDERS_TABLE,
        StreamMapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            EventSourceArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/svc-Orders/stream/2026-08-09T00:00:00.000',
            FunctionName: { 'Fn::GetAtt': ['OnOrderStreamLambdaFunction', 'Arn'] },
          },
        },
      },
    });
    expect(edge(graph, 'dynamodb:OrdersTable', 'lambda:OnOrderStreamLambdaFunction')!.detail).toBe('stream');
  });

  it('points a mapping on another service’s queue at an external node', () => {
    const arn = 'arn:aws:sqs:us-east-1:000000000000:orders-service-dev-events';
    const graph = graphOf({
      Resources: {
        ProcessJobLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-processJob' } },
        JobsMapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: { EventSourceArn: arn, FunctionName: { Ref: 'ProcessJobLambdaFunction' } },
        },
      },
    });
    expect(node(graph, `external:${arn}`)).toMatchObject({ label: 'orders-service-dev-events', service: 'sqs' });
    expect(edge(graph, `external:${arn}`, 'lambda:ProcessJobLambdaFunction')!.kind).toBe('event-source');
  });

  it('warns about a mapping whose ends do not resolve', () => {
    const graph = graphOf({
      Resources: {
        JobsQueue: JOBS_QUEUE,
        GhostMapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            EventSourceArn: { 'Fn::GetAtt': ['JobsQueue', 'Arn'] },
            FunctionName: { Ref: 'GhostLambdaFunction' },
          },
        },
        BareMapping: { Type: 'AWS::Lambda::EventSourceMapping' },
      },
    });
    expect(edgesOfKind(graph, 'event-source')).toEqual([]);
    expect(graph.warnings).toEqual([
      'Event-source mapping JobsQueue::Arn → GhostLambdaFunction could not be resolved to a declared resource',
      'Event-source mapping (unnamed) → (unnamed) could not be resolved to a declared resource',
    ]);
  });
});

describe('S3 notifications', () => {
  it('draws bucket → lambda once with the subscribed S3 events', () => {
    const graph = graphOf({
      Resources: {
        OnUploadLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-onUpload' } },
        UploadsBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: 'svc-uploads',
            NotificationConfiguration: {
              LambdaConfigurations: [
                {
                  Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
                  Function: { 'Fn::GetAtt': ['OnUploadLambdaFunction', 'Arn'] },
                },
                // The same function subscribed a second time (a separate
                // configuration per event is how CFN writes a filtered
                // subscription) is ONE arrow, keyed by (from, to, kind).
                {
                  Event: 's3:ObjectRestore:*',
                  Function: { 'Fn::GetAtt': ['OnUploadLambdaFunction', 'Arn'] },
                },
              ],
            },
          },
        },
      },
    });
    expect(graph.edges).toHaveLength(1);
    expect(edge(graph, 's3:UploadsBucket', 'lambda:OnUploadLambdaFunction')).toMatchObject({
      kind: 's3-notification',
      detail: 's3:ObjectCreated:*, s3:ObjectRemoved:*',
      confidence: 'declared',
    });
  });

  it('warns about a notification whose target is not declared here', () => {
    const graph = graphOf({
      Resources: {
        UploadsBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: 'svc-uploads',
            NotificationConfiguration: {
              LambdaConfigurations: [{ Event: 's3:ObjectCreated:*', Function: { Ref: 'GhostLambdaFunction' } }],
            },
          },
        },
      },
    });
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      'S3 notification on svc-uploads → GhostLambdaFunction could not be resolved to a declared resource',
    ]);
  });
});

describe('EventBridge rules', () => {
  it('draws bus → rule and rule → target, carrying the schedule expression', () => {
    const graph = graphOf({
      Resources: {
        DomainBus: { Type: 'AWS::Events::EventBus', Properties: { Name: 'svc-domain' } },
        NightlyLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-nightly' } },
        NightlyRule: {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: 'svc-nightly',
            EventBusName: { Ref: 'DomainBus' },
            ScheduleExpression: 'rate(1 day)',
            Targets: [{ Id: 'nightly', Arn: { 'Fn::GetAtt': ['NightlyLambdaFunction', 'Arn'] } }],
          },
        },
      },
    });
    expect(edge(graph, 'eventbus:DomainBus', 'event-rule:NightlyRule')).toMatchObject({
      kind: 'event-bus-rule',
      detail: 'rate(1 day)',
    });
    expect(edge(graph, 'event-rule:NightlyRule', 'lambda:NightlyLambdaFunction')).toMatchObject({
      kind: 'event-rule-target',
      detail: 'rate(1 day)',
    });
  });

  it('leaves a default-bus rule without a bus edge and a pattern rule without a detail', () => {
    // No EventBusName means the default bus, which no template declares —
    // inventing a node for a bus this service does not own would be worse.
    const graph = graphOf({
      Resources: {
        RelayLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-relay' } },
        RelayRule: {
          Type: 'AWS::Events::Rule',
          Properties: {
            EventPattern: { source: ['svc'] },
            Targets: [{ Id: 'relay', Arn: { 'Fn::GetAtt': ['RelayLambdaFunction', 'Arn'] } }],
          },
        },
      },
    });
    expect(edgesOfKind(graph, 'event-bus-rule')).toEqual([]);
    expect(edge(graph, 'event-rule:RelayRule', 'lambda:RelayLambdaFunction')!.detail).toBeUndefined();
  });

  it('resolves a plain bus name to another service, and locally when this service declares it', () => {
    // `EventBusName: billing-events` is the bundled demo's own pipeline: the
    // notifications rule listens on the bus the billing service declares.
    const crossService = graphOf({
      Resources: {
        FirstRule: { Type: 'AWS::Events::Rule', Properties: { EventBusName: 'billing-events', EventPattern: { source: ['billing'] } } },
        SecondRule: { Type: 'AWS::Events::Rule', Properties: { EventBusName: 'billing-events', EventPattern: { source: ['billing'] } } },
      },
    });
    expect(node(crossService, 'external:billing-events')).toEqual({
      id: 'external:billing-events',
      kind: 'external',
      label: 'billing-events',
      service: 'eventbus',
    });
    // One node, two rules hanging off it.
    expect(crossService.nodes.filter(n => n.kind === 'external')).toHaveLength(1);
    expect(edgesOfKind(crossService, 'event-bus-rule')).toHaveLength(2);

    const local = graphOf({
      Resources: {
        BillingBus: { Type: 'AWS::Events::EventBus', Properties: { Name: 'billing-events' } },
        FirstRule: { Type: 'AWS::Events::Rule', Properties: { EventBusName: 'billing-events', EventPattern: { source: ['billing'] } } },
      },
    });
    expect(local.nodes.filter(n => n.kind === 'external')).toEqual([]);
    expect(edge(local, 'eventbus:BillingBus', 'event-rule:FirstRule')!.kind).toBe('event-bus-rule');
  });

  it('warns about a bus name and a target it cannot resolve', () => {
    const graph = graphOf({
      Resources: {
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'svc-api' } },
        BrokenRule: {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: 'svc-broken',
            // A packager token that reduces to nothing: there is no logical id
            // in front of the dot, so neither a local nor a named bus resolves.
            EventBusName: '.billing-events',
            Targets: [
              { Id: 'ghost', Arn: { Ref: 'GhostLambdaFunction' } },
              // A logical id this template DOES declare, but as API Gateway
              // plumbing the graph has no node kind for.
              { Id: 'plumbing', Arn: { Ref: 'HttpApi' } },
            ],
          },
        },
      },
    });
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      'EventBridge rule svc-broken names bus ".billing-events" could not be resolved to a declared resource',
      'EventBridge rule svc-broken targets GhostLambdaFunction could not be resolved to a declared resource',
      'EventBridge rule svc-broken targets HttpApi could not be resolved to a declared resource',
    ]);
  });
});

describe('SQS redrive', () => {
  it('draws queue → dead-letter queue with the receive count', () => {
    const graph = graphOf({
      Resources: {
        JobsQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: 'svc-jobs',
            RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['JobsDlq', 'Arn'] }, maxReceiveCount: 3 },
          },
        },
        JobsDlq: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'svc-jobs-dlq' } },
      },
    });
    expect(edge(graph, 'sqs:JobsQueue', 'sqs:JobsDlq')).toMatchObject({
      kind: 'redrive',
      detail: 'after 3',
      confidence: 'declared',
    });
  });

  it('draws nothing for a queue without a redrive policy', () => {
    expect(graphOf({ Resources: { JobsQueue: JOBS_QUEUE } }).edges).toEqual([]);
  });

  it('warns when the dead-letter target is not declared here', () => {
    const graph = graphOf({
      Resources: {
        JobsQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: 'svc-jobs',
            RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['GhostDlq', 'Arn'] }, maxReceiveCount: 5 },
          },
        },
      },
    });
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      'Queue svc-jobs redrives to GhostDlq::Arn could not be resolved to a declared resource',
    ]);
  });
});

describe('SNS subscriptions', () => {
  it('reads AWS::SNS::Subscription from the RAW template (the parser has no arm for it)', () => {
    const graph = graphOf({
      Resources: {
        EventsTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'svc-events' } },
        NotifyLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-notify' } },
        JobsQueue: JOBS_QUEUE,
        LambdaSubscription: {
          Type: 'AWS::SNS::Subscription',
          Properties: {
            Protocol: 'lambda',
            TopicArn: { Ref: 'EventsTopic' },
            Endpoint: { 'Fn::GetAtt': ['NotifyLambdaFunction', 'Arn'] },
          },
        },
        QueueSubscription: {
          Type: 'AWS::SNS::Subscription',
          Properties: {
            // An intrinsic Protocol is not a label — better blank than "[object Object]".
            Protocol: { Ref: 'ProtocolParam' },
            TopicArn: { Ref: 'EventsTopic' },
            Endpoint: { 'Fn::GetAtt': ['JobsQueue', 'Arn'] },
          },
        },
      },
    });
    expect(edge(graph, 'sns:EventsTopic', 'lambda:NotifyLambdaFunction')).toMatchObject({
      kind: 'sns-subscription',
      detail: 'lambda',
      confidence: 'declared',
    });
    expect(edge(graph, 'sns:EventsTopic', 'sqs:JobsQueue')!.detail).toBeUndefined();
  });

  it('warns about a subscription with an unresolvable end', () => {
    const graph = graphOf({
      Resources: {
        EventsTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'svc-events' } },
        GhostSubscription: {
          Type: 'AWS::SNS::Subscription',
          Properties: { Protocol: 'lambda', TopicArn: { Ref: 'EventsTopic' }, Endpoint: { Ref: 'GhostLambdaFunction' } },
        },
        // Not legal CloudFormation, but a Properties-less resource must not
        // throw its way out of a whole graph.
        BareSubscription: { Type: 'AWS::SNS::Subscription' },
      },
    });
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      'SNS subscription with an unresolvable topic or endpoint could not be resolved to a declared resource',
      'SNS subscription with an unresolvable topic or endpoint could not be resolved to a declared resource',
    ]);
  });
});

describe('IAM grants', () => {
  it('draws a direct lambda → resource edge when ONE function is bound to the role', () => {
    const graph = graphOf(roleTemplate(
      [{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: [{ Ref: 'OrdersTable' }] }],
      { OrdersTable: ORDERS_TABLE },
    ));
    // A fan-out of one needs no hub: the direct arrow is what a developer means.
    expect(node(graph, 'iam-role:IamRoleLambdaExecution')).toBeUndefined();
    expect(graph.edges).toEqual([{
      id: 'lambda:WorkerLambdaFunction\u0000dynamodb:OrdersTable\u0000iam',
      from: 'lambda:WorkerLambdaFunction',
      to: 'dynamodb:OrdersTable',
      kind: 'iam',
      detail: 'dynamodb:GetItem, dynamodb:PutItem',
      confidence: 'declared',
    }]);
  });

  it('promotes the role to a hub node when MORE than one function shares it', () => {
    // N + M edges instead of N × M: at LSS's target sizes the product form is
    // hundreds of arrows of pure noise.
    const graph = graphOf(
      roleTemplate(
        [
          { Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: [{ Ref: 'OrdersTable' }] },
          { Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: [{ 'Fn::GetAtt': ['JobsQueue', 'Arn'] }] },
        ],
        { OrdersTable: ORDERS_TABLE, JobsQueue: JOBS_QUEUE },
        ['ALambdaFunction', 'BLambdaFunction', 'CLambdaFunction'],
      ),
    );
    expect(node(graph, 'iam-role:IamRoleLambdaExecution')).toEqual({
      id: 'iam-role:IamRoleLambdaExecution',
      kind: 'iam-role',
      label: 'IamRoleLambdaExecution',
      logicalId: 'IamRoleLambdaExecution',
    });
    expect(graph.edges.map(e => `${e.from} → ${e.to}`)).toEqual([
      'lambda:ALambdaFunction → iam-role:IamRoleLambdaExecution',
      'lambda:BLambdaFunction → iam-role:IamRoleLambdaExecution',
      'lambda:CLambdaFunction → iam-role:IamRoleLambdaExecution',
      'iam-role:IamRoleLambdaExecution → dynamodb:OrdersTable',
      'iam-role:IamRoleLambdaExecution → sqs:JobsQueue',
    ]);
    // The function → role edges carry no actions: the role is the grant holder.
    expect(edge(graph, 'lambda:ALambdaFunction', 'iam-role:IamRoleLambdaExecution')!.detail).toBeUndefined();
  });

  it('skips Deny, NotResource, NotAction and a blanket Resource "*"', () => {
    const graph = graphOf(roleTemplate(
      [
        // Emitted by osls for `disableLogs` — not evidence of anything.
        { Effect: 'Deny', Action: ['dynamodb:GetItem'], Resource: [{ Ref: 'OrdersTable' }] },
        { Effect: 'Allow', Action: ['dynamodb:GetItem'], NotResource: [{ Ref: 'OrdersTable' }] },
        { Effect: 'Allow', NotAction: ['dynamodb:GetItem'], Resource: [{ Ref: 'OrdersTable' }] },
        // True of everything, therefore evidence of nothing.
        { Effect: 'Allow', Action: ['dynamodb:DescribeTable'], Resource: '*' },
      ],
      { OrdersTable: ORDERS_TABLE },
    ));
    expect(graph.edges).toEqual([]);
  });

  it('skips logs/xray/sts actions and the durable-execution self-grants', () => {
    const graph = graphOf(roleTemplate(
      [
        {
          Effect: 'Allow',
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: [{ 'Fn::Sub': 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/svc-dev*:*' }],
        },
        { Effect: 'Allow', Action: ['xray:PutTraceSegments'], Resource: '*' },
        { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: [{ Ref: 'OrdersTable' }] },
        // An osls self-grant pointing the function at itself: drawing it would
        // put a self-loop on every Lambda of a durable-execution service.
        {
          Effect: 'Allow',
          Action: ['lambda:CheckpointDurableExecution', 'lambda:GetDurableExecutionState'],
          Resource: [{ 'Fn::GetAtt': ['WorkerLambdaFunction', 'Arn'] }],
        },
      ],
      { OrdersTable: ORDERS_TABLE },
    ));
    expect(graph.edges).toEqual([]);
  });

  it('skips the framework custom-resources role by logical id', () => {
    // Its statements are about a helper Lambda osls generates for existing-bucket
    // S3 events, so walking it grows a bogus lambda → bucket edge.
    const graph = graphOf({
      Resources: {
        IamRoleCustomResourcesLambdaExecution: {
          Type: 'AWS::IAM::Role',
          Properties: {
            Policies: [{
              PolicyDocument: {
                Statement: [{
                  Effect: 'Allow',
                  Action: ['s3:PutBucketNotification'],
                  Resource: [{ 'Fn::GetAtt': ['UploadsBucket', 'Arn'] }],
                }],
              },
            }],
          },
        },
        CustomDashresourceDashexistingDashs3LambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'svc-dev-custom-resource-existing-s3',
            Role: { 'Fn::GetAtt': ['IamRoleCustomResourcesLambdaExecution', 'Arn'] },
          },
        },
        UploadsBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'svc-uploads' } },
      },
    });
    expect(graph.edges).toEqual([]);
  });

  it('resolves every Resource spelling: Ref, both Fn::GetAtt forms, Fn::Sub and Fn::Join', () => {
    const graph = graphOf(roleTemplate(
      [
        { Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: [{ Ref: 'OrdersTable' }] },
        { Effect: 'Allow', Action: ['dynamodb:Query'], Resource: [{ 'Fn::GetAtt': ['SessionsTable', 'Arn'] }] },
        // The dotted string spelling of Fn::GetAtt, which the parser's own
        // private helpers mishandle — hence the module's own refLogicalId.
        { Effect: 'Allow', Action: ['dynamodb:PutItem'], Resource: [{ 'Fn::GetAtt': 'UsersTable.Arn' }] },
        {
          Effect: 'Allow',
          Action: ['sqs:SendMessage'],
          Resource: [{ 'Fn::Sub': 'arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:svc-jobs' }],
        },
        {
          Effect: 'Allow',
          Action: ['s3:PutObject'],
          Resource: [{ 'Fn::Join': [':', ['arn', 'aws', 's3', '', '', 'svc-uploads/*']] }],
        },
      ],
      {
        OrdersTable: ORDERS_TABLE,
        SessionsTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'svc-Sessions' } },
        UsersTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'svc-Users' } },
        JobsQueue: JOBS_QUEUE,
        UploadsBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'svc-uploads' } },
      },
    ), { region: 'sa-east-1' });

    expect(graph.edges.map(e => e.to)).toEqual([
      'dynamodb:OrdersTable',
      'dynamodb:SessionsTable',
      'dynamodb:UsersTable',
      // Reduced against the graph's own account/partition and the service region.
      'sqs:JobsQueue',
      // `…/bucket/*` is about the BUCKET: the sub-resource suffix is dropped.
      's3:UploadsBucket',
    ]);
  });

  it('turns a literal cross-service ARN into an external node', () => {
    const arn = 'arn:aws:sqs:us-east-1:000000000000:billing-service-dev-invoices';
    const graph = graphOf(roleTemplate([
      { Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: [arn] },
    ]));
    expect(node(graph, `external:${arn}`)).toMatchObject({
      kind: 'external',
      label: 'billing-service-dev-invoices',
      arn,
      service: 'sqs',
    });
    expect(edge(graph, 'lambda:WorkerLambdaFunction', `external:${arn}`)!.kind).toBe('iam');
  });

  it('resolves a bucket grant written as Fn::Join over a {Ref} to the declared bucket', () => {
    // The classic osls S3 statement, and the reason the grant resolver falls
    // back to the LOGICAL ID: `resolveArnLike` only turns Lambda and API refs
    // into real values, so `{Ref: UploadsBucket}` survives the join as the
    // logical id and the reduced ARN reads `arn:aws:s3:::UploadsBucket/*`. The
    // bucket is declared three lines below in the same template — drawing an
    // external node for it would be a lie about where it lives.
    const graph = graphOf(roleTemplate(
      [{
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: [{ 'Fn::Join': ['', ['arn:aws:s3:::', { Ref: 'UploadsBucket' }, '/*']] }],
      }],
      { UploadsBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'svc-uploads' } } },
    ));
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 's3:UploadsBucket')).toMatchObject({
      kind: 'iam',
      detail: 's3:GetObject',
    });
    expect(node(graph, 'external:arn:aws:s3:::UploadsBucket/*')).toBeUndefined();
  });

  it('still externalises a joined ARN whose logical id is NOT declared here', () => {
    // Same shape, different truth: the id belongs to another stack, so the
    // logical-id fallback must not invent a local node for it.
    const graph = graphOf(roleTemplate(
      [{
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: [{ 'Fn::Join': ['', ['arn:aws:s3:::', { Ref: 'SomeoneElsesBucket' }, '/*']] }],
      }],
      { UploadsBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'svc-uploads' } } },
    ));
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'external:arn:aws:s3:::SomeoneElsesBucket/*')).toBeDefined();
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 's3:UploadsBucket')).toBeUndefined();
  });

  it('matches a Secrets Manager grant by prefix, in the spelling AWS actually emits', () => {
    // AWS appends six random characters at create time, so a policy ARN never
    // equals the declared name — the match has to be by prefix. The spelling is
    // `…:secret:<name>-<suffix>`, a COLON-delimited discriminator, and the
    // engine's own Secrets Manager emits exactly this shape.
    const awsSpelling = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:svc-db-AbCdEf';
    const matchedAwsSpelling = graphOf(roleTemplate(
      [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [awsSpelling] }],
      { DbSecret: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: 'svc-db' } } },
    ));
    expect(node(matchedAwsSpelling, `external:${awsSpelling}`)).toBeUndefined();
    expect(edge(matchedAwsSpelling, 'lambda:WorkerLambdaFunction', 'secret:DbSecret')).toMatchObject({
      kind: 'iam',
    });

    // And equally when the discriminator is absent.
    const matched = graphOf(roleTemplate(
      [{
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: ['arn:aws:secretsmanager:us-east-1:000000000000:svc-db-AbCdEf'],
      }],
      {
        JobsQueue: JOBS_QUEUE,
        DbSecret: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: 'svc-db' } },
      },
    ));
    expect(edge(matched, 'lambda:WorkerLambdaFunction', 'secret:DbSecret')!.detail)
      .toBe('secretsmanager:GetSecretValue');
  });

  it('externalises a secret grant when no declared secret is a prefix of it', () => {
    // The other side of the prefix match, and a real case in a monorepo: the
    // shared-infra stack owns the secret and this service is only allowed to
    // read it. Prefix matching must not claim it — `svc-db` is not a prefix of
    // `platform-oauth`, and pretending otherwise would move someone else's
    // resource inside this service's picture.
    const foreign = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:platform-oauth-ZyXwVu';
    const graph = graphOf(roleTemplate(
      [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [foreign] }],
      { DbSecret: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: 'svc-db' } } },
    ));
    expect(node(graph, `external:${foreign}`)).toMatchObject({
      kind: 'external',
      label: 'platform-oauth-ZyXwVu',
      service: 'secretsmanager',
    });
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'secret:DbSecret')).toBeUndefined();
  });

  it('draws nothing when the ARN service and the action list disagree', () => {
    // A reduction that went wrong: the actions say DynamoDB, the ARN says SQS.
    const graph = graphOf(roleTemplate(
      [{
        Effect: 'Allow',
        Action: ['dynamodb:GetItem'],
        Resource: ['arn:aws:sqs:us-east-1:000000000000:svc-jobs'],
      }],
      { OrdersTable: ORDERS_TABLE, JobsQueue: JOBS_QUEUE },
    ));
    expect(graph.edges).toEqual([]);
  });

  it('does not restate a structural edge that already carries more information', () => {
    // osls pushes an sqs:ReceiveMessage statement onto the role for every
    // event-source mapping it compiles, aimed at the very same queue.
    const graph = graphOf(roleTemplate(
      [{
        Effect: 'Allow',
        Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'],
        Resource: [{ 'Fn::GetAtt': ['JobsQueue', 'Arn'] }],
      }],
      {
        JobsQueue: JOBS_QUEUE,
        JobsMapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            BatchSize: 5,
            EventSourceArn: { 'Fn::GetAtt': ['JobsQueue', 'Arn'] },
            FunctionName: { 'Fn::GetAtt': ['WorkerLambdaFunction', 'Arn'] },
          },
        },
      },
    ));
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ kind: 'event-source', detail: 'poll ×5' });
  });

  it('merges the actions of two statements aimed at the same resource', () => {
    const graph = graphOf(roleTemplate(
      [
        { Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: [{ Ref: 'OrdersTable' }] },
        { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], Resource: { Ref: 'OrdersTable' } },
      ],
      { OrdersTable: ORDERS_TABLE },
    ));
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].detail).toBe('dynamodb:GetItem, dynamodb:UpdateItem');
  });

  it('ignores a role nothing is bound to, a role with only noise, and a function whose role is external', () => {
    const graph = graphOf({
      Resources: {
        // Never referenced by a Properties.Role, so it grants nothing here.
        UnusedRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            Policies: [{ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: [{ Ref: 'OrdersTable' }] }] } }],
          },
        },
        IamRoleLambdaExecution: {
          Type: 'AWS::IAM::Role',
          Properties: {
            Policies: [{ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: ['logs:PutLogEvents'], Resource: '*' }] } }],
          },
        },
        WorkerLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-dev-worker', Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } },
        },
        // A role outside the stack carries no statements we can read.
        SharedRoleLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-dev-shared', Role: 'arn:aws:iam::000000000000:role/shared-execution' },
        },
        BareLambdaFunction: { Type: 'AWS::Lambda::Function' },
        OrdersTable: ORDERS_TABLE,
      },
    });
    expect(graph.edges).toEqual([]);
    expect(node(graph, 'iam-role:IamRoleLambdaExecution')).toBeUndefined();
  });

  it('ignores a template Lambda the caller’s Resource[] does not carry', () => {
    // The node map is the authority, not the raw template: an endpoint with no
    // node would be an arrow into nothing.
    const template = roleTemplate(
      [{ Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: [{ Ref: 'OrdersTable' }] }],
      { OrdersTable: ORDERS_TABLE },
    );
    const graph = graphOf(template, {
      resources: parser.parse(template as never).filter(r => r.type !== 'lambda'),
    });
    expect(graph.edges).toEqual([]);
  });

  it('tolerates malformed policy shapes and unresolvable Resource entries', () => {
    const graph = graphOf({
      Resources: {
        IamRoleLambdaExecution: {
          Type: 'AWS::IAM::Role',
          Properties: {
            // A lone policy object rather than a list, as CFN allows everywhere.
            Policies: {
              PolicyDocument: {
                // A lone statement, likewise.
                Statement: {
                  Effect: 'Allow',
                  // Non-string actions are dropped before the kinds are derived.
                  Action: [{ Ref: 'SomeAction' }, 'dynamodb:GetItem', 'sqs:SendMessage'],
                  Resource: [
                    null,
                    42,
                    // A Fn::GetAtt with nothing in front of the attribute: no
                    // logical id to read, and nothing for the reducer either.
                    { 'Fn::GetAtt': '' },
                    { 'Fn::Sub': 'not-an-arn-at-all' },
                    // An ARN too short to carry a resource name.
                    { 'Fn::Sub': 'arn:aws:dynamodb:us-east-1' },
                    // A service the graph has no node kind for.
                    'arn:aws:kms:us-east-1:000000000000:key/abcd',
                    // A logical id that is not in this template.
                    { Ref: 'GhostTable' },
                    // A logical id that is not a graph node.
                    { Ref: 'HttpApi' },
                  ],
                },
              },
            },
          },
        },
        WorkerLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-dev-worker', Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } },
        },
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'svc-api' } },
      },
    });
    expect(graph.edges).toEqual([]);
  });

  it('tolerates a null policy and a policy with no document', () => {
    const graph = graphOf({
      Resources: {
        IamRoleLambdaExecution: {
          Type: 'AWS::IAM::Role',
          Properties: { Policies: [null, {}] },
        },
        WorkerLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: { FunctionName: 'svc-dev-worker', Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } },
        },
      },
    });
    expect(graph.edges).toEqual([]);
  });
});

describe('environment variables', () => {
  const template = {
    Resources: {
      CreateUserLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-createUser' } },
      ListUsersLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'svc-dev-listUsers' } },
      UsersTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'svc-Users' } },
      JobsQueue: JOBS_QUEUE,
      EventsTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'svc-events' } },
      SearchCollection: { Type: 'AWS::OpenSearchServerless::Collection', Properties: { Name: 'products-catalog' } },
    },
  };

  it('matches a value that IS a declared name, and flags it serviceWide when every function carries it', () => {
    // `provider.environment` is copied onto EVERY function by the packager, so
    // the variable proves the SERVICE uses the table, not that this function does.
    const graph = graphOf(template, {
      functions: [
        registeredFunction('createUser', 'svc-dev-createUser', { USERS_TABLE: 'svc-Users', WRITER_ONLY: 'svc-jobs' }),
        registeredFunction('listUsers', 'svc-dev-listUsers', { USERS_TABLE: 'svc-Users' }),
      ],
    });
    expect(edge(graph, 'lambda:CreateUserLambdaFunction', 'dynamodb:UsersTable')).toMatchObject({
      kind: 'env',
      detail: 'USERS_TABLE',
      confidence: 'inferred',
      serviceWide: true,
    });
    expect(edge(graph, 'lambda:ListUsersLambdaFunction', 'dynamodb:UsersTable')!.serviceWide).toBe(true);
    // Declared on one function only: this one really is about that function.
    expect(edge(graph, 'lambda:CreateUserLambdaFunction', 'sqs:JobsQueue')!.serviceWide).toBe(false);
  });

  it('never flags a single-function service as serviceWide', () => {
    const graph = graphOf(template, {
      functions: [registeredFunction('createUser', 'svc-dev-createUser', { USERS_TABLE: 'svc-Users' })],
    });
    expect(edge(graph, 'lambda:CreateUserLambdaFunction', 'dynamodb:UsersTable')!.serviceWide).toBe(false);
  });

  it('matches an ARN value, an unresolved intrinsic and the last segment of a service URL', () => {
    const graph = graphOf(template, {
      functions: [registeredFunction('createUser', 'svc-dev-createUser', {
        TOPIC_ARN: 'arn:aws:sns:us-east-1:000000000000:svc-events',
        // What the packager leaves behind for an unreduced Fn::GetAtt, in both
        // encodings this codebase produces.
        TABLE_ARN: 'UsersTable.Arn',
        TABLE_STREAM: 'UsersTable::StreamArn',
        QUEUE_URL: 'http://localhost:14566/000000000000/svc-jobs',
        SEARCH_ENDPOINT: 'https://localhost:14566/_aoss/products-catalog?v=2',
      })],
    });
    expect(edge(graph, 'lambda:CreateUserLambdaFunction', 'sns:EventsTopic')!.detail).toBe('TOPIC_ARN');
    // Both intrinsic spellings land on the same table, so only the first one
    // becomes an edge (same pair, same kind).
    expect(edge(graph, 'lambda:CreateUserLambdaFunction', 'dynamodb:UsersTable')!.detail).toBe('TABLE_ARN');
    expect(edge(graph, 'lambda:CreateUserLambdaFunction', 'sqs:JobsQueue')!.detail).toBe('QUEUE_URL');
    expect(edge(graph, 'lambda:CreateUserLambdaFunction', 'opensearch:SearchCollection')!.detail).toBe('SEARCH_ENDPOINT');
  });

  it('never matches a substring: "products" is not the "products-catalog" collection', () => {
    const graph = graphOf(template, {
      functions: [registeredFunction('createUser', 'svc-dev-createUser', { PRODUCTS_INDEX: 'products' })],
    });
    expect(graph.edges).toEqual([]);
  });

  it('skips the infrastructure keys, so AWS_ENDPOINT never invents a resource called "14566"', () => {
    const graph = graphOf({
      Resources: {
        ...template.Resources,
        // A bucket named exactly like the port a path-style endpoint carries.
        PortBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: '14566' } },
      },
    }, {
      functions: [registeredFunction('createUser', 'svc-dev-createUser', {
        // A path-style endpoint whose last segment names a declared bucket.
        AWS_ENDPOINT: 'http://localhost:14566/14566',
        AWS_REGION: 'us-east-1',
        STAGE: 'dev',
        NODE_ENV: 'development',
      })],
    });
    expect(graph.edges).toEqual([]);
  });

  it('suppresses an env edge whose pair is already connected by a stronger edge', () => {
    const graph = graphOf({
      Resources: {
        ...template.Resources,
        JobsMapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            BatchSize: 5,
            EventSourceArn: { 'Fn::GetAtt': ['JobsQueue', 'Arn'] },
            FunctionName: { 'Fn::GetAtt': ['ListUsersLambdaFunction', 'Arn'] },
          },
        },
        IamRoleLambdaExecution: {
          Type: 'AWS::IAM::Role',
          Properties: {
            Policies: [{
              PolicyDocument: {
                Statement: [{ Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: [{ Ref: 'UsersTable' }] }],
              },
            }],
          },
        },
        CreateUserLambdaFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'svc-dev-createUser',
            Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] },
          },
        },
      },
    }, {
      functions: [
        registeredFunction('createUser', 'svc-dev-createUser', { USERS_TABLE: 'svc-Users' }),
        // The queue already reaches this function through the mapping, which
        // carries the batch size — the env var only restates it, backwards.
        registeredFunction('listUsers', 'svc-dev-listUsers', { QUEUE_NAME: 'svc-jobs' }),
      ],
    });
    expect(edgesOfKind(graph, 'env')).toEqual([]);
    expect(graph.edgeKinds).toEqual(['event-source', 'iam']);
  });

  it('ignores values that name nothing, and functions with no Lambda in the template', () => {
    const graph = graphOf(template, {
      functions: [
        registeredFunction('createUser', 'svc-dev-createUser', {
          EMPTY: '',
          PLAIN: 'not-a-resource',
          // A URL with no path at all: there is no last segment to match.
          BASE_URL: 'https://localhost:14566',
          // ARNs that name nothing this service declares.
          SHORT_ARN: 'arn:aws:sqs:us-east-1',
          UNKNOWN_SERVICE_ARN: 'arn:aws:kms:us-east-1:000000000000:key/abcd',
          OTHER_TABLE_ARN: 'arn:aws:dynamodb:us-east-1:000000000000:table/other-service-Orders',
          // Intrinsic-shaped values that resolve to nothing: no logical id in
          // front of the dot, a logical id this template lacks, and one whose
          // resource is not a graph node.
          DANGLING: '.Arn',
          GHOST: 'GhostTable.Arn',
          API: 'HttpApi.Arn',
          // Naming its own function would only draw a self-loop.
          SELF: 'svc-dev-createUser',
        }),
        // serverless-state knows it; the template has no such function.
        registeredFunction('ghost', 'svc-dev-ghost', { USERS_TABLE: 'svc-Users' }),
      ],
    });
    expect(graph.edges).toEqual([]);
  });

  it('tolerates a function with no environment block at all', () => {
    const graph = graphOf(template, {
      functions: [
        { ...registeredFunction('createUser', 'svc-dev-createUser'), environment: undefined } as never,
        registeredFunction('listUsers', 'svc-dev-listUsers', { USERS_TABLE: 'svc-Users' }),
      ],
    });
    expect(edge(graph, 'lambda:ListUsersLambdaFunction', 'dynamodb:UsersTable')!.serviceWide).toBe(false);
  });
});

describe('parseResourceArn', () => {
  it('returns null for anything that is not a complete ARN', () => {
    expect(parseResourceArn('svc-Orders')).toBeNull();
    expect(parseResourceArn('')).toBeNull();
    // Five segments: no resource part at all.
    expect(parseResourceArn('arn:aws:sqs:us-east-1:000000000000')).toBeNull();
    // Six segments, empty tail.
    expect(parseResourceArn('arn:aws:sqs:us-east-1:000000000000:')).toBeNull();
    // A tail that starts with the separator names nothing.
    expect(parseResourceArn('arn:aws:s3:::/svc-uploads')).toBeNull();
    expect(parseResourceArn('arn:aws:dynamodb:us-east-1:000000000000:table/')).toBeNull();
  });

  it('drops the type discriminator of every prefixed ARN form', () => {
    expect(parseResourceArn('arn:aws:dynamodb:us-east-1:000000000000:table/svc-Orders'))
      .toEqual({ service: 'dynamodb', name: 'svc-Orders' });
    expect(parseResourceArn('arn:aws:events:us-east-1:000000000000:event-bus/billing-events'))
      .toEqual({ service: 'events', name: 'billing-events' });
    expect(parseResourceArn('arn:aws:events:us-east-1:000000000000:rule/nightly'))
      .toEqual({ service: 'events', name: 'nightly' });
    expect(parseResourceArn('arn:aws:aoss:us-east-1:000000000000:collection/products-catalog'))
      .toEqual({ service: 'aoss', name: 'products-catalog' });
    expect(parseResourceArn('arn:aws:es:us-east-1:000000000000:domain/search'))
      .toEqual({ service: 'es', name: 'search' });
    expect(parseResourceArn('arn:aws:lambda:us-east-1:000000000000:function/svc-dev-worker'))
      .toEqual({ service: 'lambda', name: 'svc-dev-worker' });
    expect(parseResourceArn('arn:aws:kinesis:us-east-1:000000000000:stream/events'))
      .toEqual({ service: 'kinesis', name: 'events' });
  });

  it('strips the COLON-delimited discriminators AWS actually emits', () => {
    // Lambda and Secrets Manager delimit theirs with a colon rather than a
    // slash. Both spellings have to reduce to the bare name, or a grant on a
    // LOCAL function or secret misses the (kind, declared name) index and lands
    // on an external node sitting next to the real one.
    expect(parseResourceArn('arn:aws:lambda:us-east-1:000000000000:function:svc-dev-worker'))
      .toEqual({ service: 'lambda', name: 'svc-dev-worker' });
    expect(parseResourceArn('arn:aws:secretsmanager:us-east-1:000000000000:secret:svc-db-AbCdEf'))
      .toEqual({ service: 'secretsmanager', name: 'svc-db-AbCdEf' });
  });

  it('rejects an ARN that is nothing but a discriminator', () => {
    // `…:secret:` names no secret. Stripping the discriminator leaves an empty
    // tail, and an empty name would index as a resource called '' and match the
    // first nameless thing it met.
    expect(parseResourceArn('arn:aws:secretsmanager:us-east-1:000000000000:secret:')).toBeNull();
  });

  it('keeps the first segment of the unprefixed forms and drops sub-resources', () => {
    expect(parseResourceArn('arn:aws:sqs:us-east-1:000000000000:svc-jobs'))
      .toEqual({ service: 'sqs', name: 'svc-jobs' });
    expect(parseResourceArn('arn:aws:sns:us-east-1:000000000000:svc-events'))
      .toEqual({ service: 'sns', name: 'svc-events' });
    expect(parseResourceArn('arn:aws:s3:::svc-uploads/incoming/*'))
      .toEqual({ service: 's3', name: 'svc-uploads' });
    // A policy on a GSI is about the TABLE it belongs to.
    expect(parseResourceArn('arn:aws:dynamodb:us-east-1:000000000000:table/svc-Orders/index/byUser'))
      .toEqual({ service: 'dynamodb', name: 'svc-Orders' });
  });
});

describe('degenerate inputs', () => {
  it('returns an empty graph for a missing template', () => {
    for (const template of [undefined, null]) {
      expect(buildServiceGraph({ serviceName: 'svc', template, resources: [] })).toEqual({
        service: 'svc',
        nodes: [],
        edges: [],
        edgeKinds: [],
        warnings: [],
      });
    }
  });

  it('returns an empty graph for a template with no Resources and for an empty Resource[]', () => {
    expect(graphOf({}).nodes).toEqual([]);
    expect(graphOf({ Resources: {} }).nodes).toEqual([]);
    // A template full of resources the caller chose not to hand over.
    expect(graphOf({ Resources: { OrdersTable: ORDERS_TABLE } }, { resources: [] }).nodes).toEqual([]);
  });

  it('does not index a resource whose logical id is empty', () => {
    // The node still renders — it just cannot be the end of any reference,
    // because every carrier addresses a resource by logical id.
    const graph = buildServiceGraph({
      serviceName: 'svc',
      template: { Resources: {} },
      resources: [
        { type: 'dynamodb', logicalId: '', name: 'ghost-table', keySchema: [], attributeDefinitions: [] },
        { type: 'lambda', logicalId: 'WorkerLambdaFunction', name: 'svc-dev-worker', handler: 'x.handler', runtime: 'nodejs20.x', environment: {}, memorySize: 128, timeout: 30 },
      ],
      functions: [registeredFunction('worker', 'svc-dev-worker', { GHOST_TABLE: 'ghost-table' })],
    });
    expect(graph.nodes.map(n => n.id)).toEqual(['dynamodb:', 'lambda:WorkerLambdaFunction']);
    expect(graph.edges).toEqual([]);
  });
});

describe('fixtures (end-to-end)', () => {
  it('derives the sample-microservice wiring from the committed deploy template', () => {
    const template = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    const resources = parser.parse(template);
    // serverless-state as the registrar would have cached it: nine functions,
    // each carrying the same provider-level environment block.
    const functions = (resources.filter(r => r.type === 'lambda') as LambdaResource[]).map(lambda =>
      registeredFunction(lambda.name.replace('sample-microservice-dev-', ''), lambda.name, lambda.environment));

    const graph = buildServiceGraph({
      serviceName: 'sample-microservice',
      template,
      resources,
      functions,
    });

    // Nodes: nine lambdas, three tables, a queue, a topic, one bucket (the
    // Serverless deployment bucket is dropped by the parser) and the role hub.
    const byKind = graph.nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.kind] = (acc[n.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind).toEqual({ lambda: 9, dynamodb: 3, sqs: 1, sns: 1, s3: 1, 'iam-role': 1 });

    // Nine functions share IamRoleLambdaExecution → the hub rendering, with the
    // role's two real statements (the dynamodb-stream one and the sqs one) as
    // grants and the four logs statements dropped as noise.
    expect(edgesOfKind(graph, 'iam')).toHaveLength(9 + 2);
    expect(edge(graph, 'lambda:HealthLambdaFunction', 'iam-role:IamRoleLambdaExecution')).toBeDefined();
    expect(edge(graph, 'iam-role:IamRoleLambdaExecution', 'dynamodb:OrdersTable')!.detail)
      .toBe('dynamodb:GetRecords, dynamodb:GetShardIterator, dynamodb:DescribeStream, dynamodb:ListStreams');
    expect(edge(graph, 'iam-role:IamRoleLambdaExecution', 'sqs:OrderProcessingQueue')!.detail)
      .toBe('sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes');

    // The two event-source mappings and the bucket notification.
    expect(edge(graph, 'dynamodb:OrdersTable', 'lambda:OnOrderStreamLambdaFunction')!.detail).toBe('stream ×10');
    expect(edge(graph, 'sqs:OrderProcessingQueue', 'lambda:ProcessOrderQueueLambdaFunction')!.detail).toBe('poll ×5');
    expect(edge(graph, 's3:UploadsBucket', 'lambda:OnUploadLambdaFunction')!.detail).toBe('s3:ObjectCreated:*');

    // Six of the seven environment variables name a declared resource
    // (AWS_ENDPOINT is denylisted); all nine functions carry the same block, so
    // every one of them is serviceWide. Three are suppressed because a
    // structural edge already connects the pair.
    const env = edgesOfKind(graph, 'env');
    expect(env).toHaveLength(9 * 6 - 3);
    expect(env.every(e => e.serviceWide && e.confidence === 'inferred')).toBe(true);
    expect(edge(graph, 'lambda:HealthLambdaFunction', 'sqs:OrderProcessingQueue')!.detail).toBe('ORDER_QUEUE_URL');
    expect(edge(graph, 'lambda:HealthLambdaFunction', 'sns:OrderEventsTopic')!.detail).toBe('ORDER_EVENTS_TOPIC_ARN');
    expect(edge(graph, 'lambda:OnOrderStreamLambdaFunction', 'dynamodb:OrdersTable')).toBeUndefined();
    expect(edge(graph, 'lambda:ProcessOrderQueueLambdaFunction', 'sqs:OrderProcessingQueue')).toBeUndefined();
    expect(edge(graph, 'lambda:OnUploadLambdaFunction', 's3:UploadsBucket')).toBeUndefined();

    // Insertion order is the pass order, and nothing in this template is
    // ambiguous enough to warn about.
    expect(graph.edgeKinds).toEqual(['event-source', 's3-notification', 'iam', 'env']);
    expect(graph.warnings).toEqual([]);
  });
});
