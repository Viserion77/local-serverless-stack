// Graph model v2 — the additions the stack map needs, on top of the v1 payload
// `service-graph.test.ts` pins: edge access derived from IAM actions and from
// the edge kind, card facts per node kind, the `api` node kind, third-party
// HTTP hosts as externals, SSM parameters, and group membership. Same harness
// as v1: hand-written templates through the REAL parser, handed to
// buildServiceGraph the way the route does.
import {
  buildServiceGraph,
  classifyIamAccess,
  externalTarget,
  parseResourceArn,
  physicalName,
  summarisePattern,
  IAM_ACCESS_TABLE,
  STRUCTURAL_ACCESS,
  BuildServiceGraphInput,
  GraphEdge,
  GraphNode,
  ServiceGraph,
} from '../../../src/server/services/service-graph';
import { CloudFormationParser, Resource } from '../../../src/server/services/cloudformation-parser';
import { RegisteredFunction, HttpRoute } from '../../../src/server/services/serverless-state-parser';

const parser = new CloudFormationParser();

function graphOf(template: Record<string, unknown>, extra: Partial<BuildServiceGraphInput> = {}): ServiceGraph {
  return buildServiceGraph({
    serviceName: 'orders',
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

function fn(name: string, fullName: string, environment: Record<string, string> = {}): RegisteredFunction {
  return {
    name, fullName, handler: 'h.handler', runtime: 'nodejs20.x', memorySize: 1024, timeout: 6, environment, triggers: [],
  };
}

function route(method: string, path: string, functionName: string, overrides: Partial<HttpRoute> = {}): HttpRoute {
  return { functionName, method, path, eventType: 'httpApi', cors: false, ...overrides };
}

const LAMBDA = (name: string, extra: Record<string, unknown> = {}) => ({
  Type: 'AWS::Lambda::Function',
  Properties: { FunctionName: name, Handler: 'h.handler', ...extra },
});

describe('IAM access classification', () => {
  // The table row by row: every verb it lists classifies to its own column,
  // except the deliberate double listing of `aoss:APIAccessAll`.
  const rows = Object.entries(IAM_ACCESS_TABLE).flatMap(([prefix, row]) =>
    Object.entries(row).flatMap(([category, verbs]) => verbs!.map(verb => [prefix, category, verb] as const)));

  it.each(rows)('%s:%s — %s', (prefix, category, verb) => {
    const expected = prefix === 'aoss' ? 'readwrite' : category;
    expect(classifyIamAccess([`${prefix}:${verb}`])).toBe(expected);
  });

  it('is case-insensitive on both halves of the action', () => {
    expect(classifyIamAccess(['DynamoDB:getitem'])).toBe('read');
  });

  it('expands wildcards against the table vocabulary', () => {
    expect(classifyIamAccess(['dynamodb:Get*'])).toBe('read');
    expect(classifyIamAccess(['dynamodb:*'])).toBe('readwrite');
    expect(classifyIamAccess(['s3:PutObject*'])).toBe('write');
    expect(classifyIamAccess(['sqs:*'])).toBe('readwrite');
    expect(classifyIamAccess(['sns:*'])).toBe('publish');
    expect(classifyIamAccess(['lambda:Invoke?unction'])).toBe('invoke');
    // A literal dot in an action must not act as a regex wildcard.
    expect(classifyIamAccess(['dynamodb:Get.tem'])).toBeUndefined();
  });

  it('combines several actions: one category stays, several become readwrite', () => {
    expect(classifyIamAccess(['dynamodb:GetItem', 'dynamodb:Query'])).toBe('read');
    expect(classifyIamAccess(['dynamodb:GetItem', 'dynamodb:PutItem'])).toBe('readwrite');
    expect(classifyIamAccess(['sqs:SendMessage', 'sqs:GetQueueAttributes'])).toBe('publish');
  });

  it('answers undefined for plumbing, unknown prefixes and malformed actions', () => {
    expect(classifyIamAccess(['sqs:GetQueueAttributes', 'sqs:GetQueueUrl'])).toBeUndefined();
    expect(classifyIamAccess(['kinesis:PutRecord'])).toBeUndefined();
    expect(classifyIamAccess(['noColon', ':GetItem'])).toBeUndefined();
    expect(classifyIamAccess([])).toBeUndefined();
  });

  it('gives every structural edge kind its access, and none to iam/env', () => {
    expect(STRUCTURAL_ACCESS).toEqual({
      'http-route': 'invoke',
      authorizer: 'invoke',
      'event-source': 'trigger',
      's3-notification': 'trigger',
      'event-rule-target': 'trigger',
      'event-bus-rule': 'trigger',
      'sns-subscription': 'trigger',
      redrive: 'publish',
    });
  });
});

describe('access on edges', () => {
  const template = {
    Resources: {
      IamRoleLambdaExecution: {
        Type: 'AWS::IAM::Role',
        Properties: {
          Policies: [{
            PolicyDocument: {
              Statement: [
                { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Query'], Resource: { 'Fn::GetAtt': ['OrdersTable', 'Arn'] } },
                { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: { 'Fn::GetAtt': ['JobsQueue', 'Arn'] } },
                { Effect: 'Allow', Action: 'sqs:GetQueueUrl', Resource: { 'Fn::GetAtt': ['OtherQueue', 'Arn'] } },
              ],
            },
          }],
        },
      },
      WorkerLambdaFunction: LAMBDA('orders-dev-worker', { Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } }),
      OrdersTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'orders-Orders' } },
      JobsQueue: {
        Type: 'AWS::SQS::Queue',
        Properties: { QueueName: 'orders-jobs', RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['JobsDlq', 'Arn'] }, maxReceiveCount: 3 } },
      },
      JobsDlq: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'orders-jobs-dlq' } },
      OtherQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'orders-other' } },
    },
  };

  it('classifies a direct IAM grant from its actions, and leaves plumbing-only grants without access', () => {
    const graph = graphOf(template);
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'dynamodb:OrdersTable')!.access).toBe('read');
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'sqs:JobsQueue')!.access).toBe('publish');
    const plumbing = edge(graph, 'lambda:WorkerLambdaFunction', 'sqs:OtherQueue')!;
    expect(plumbing.kind).toBe('iam');
    expect('access' in plumbing).toBe(false);
  });

  it('derives a structural edge’s access from its kind', () => {
    const graph = graphOf(template);
    expect(edge(graph, 'sqs:JobsQueue', 'sqs:JobsDlq')!.access).toBe('publish');
  });

  it('classifies role-hub grants and leaves the function → role spokes without access', () => {
    const shared = JSON.parse(JSON.stringify(template));
    shared.Resources.ReaderLambdaFunction = LAMBDA('orders-dev-reader', { Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } });
    const graph = graphOf(shared);
    expect(edge(graph, 'iam-role:IamRoleLambdaExecution', 'dynamodb:OrdersTable')!.access).toBe('read');
    expect(edge(graph, 'lambda:ReaderLambdaFunction', 'iam-role:IamRoleLambdaExecution')!.access).toBeUndefined();
  });

  it('suppresses an env edge that restates a grant the SHARED role already makes', () => {
    const shared = JSON.parse(JSON.stringify(template));
    shared.Resources.ReaderLambdaFunction = LAMBDA('orders-dev-reader', { Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } });
    const environment = { ORDERS_TABLE: 'orders-Orders', DLQ: 'orders-jobs-dlq' };
    const graph = graphOf(shared, {
      functions: [fn('worker', 'orders-dev-worker', environment), fn('reader', 'orders-dev-reader', environment)],
    });
    // Granted through the hub → no env restatement…
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'dynamodb:OrdersTable')).toBeUndefined();
    // …while a resource the role does NOT grant still gets its inferred edge.
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'sqs:JobsDlq')).toMatchObject({ kind: 'env', confidence: 'inferred' });
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'sqs:JobsDlq')!.access).toBeUndefined();
  });
});

describe('card facts', () => {
  it('lambda: runtime, timeout and memory from the template', () => {
    const graph = graphOf({
      Resources: { WorkerLambdaFunction: LAMBDA('orders-dev-worker', { Runtime: 'nodejs22.x', Timeout: 10, MemorySize: 512 }) },
    });
    expect(node(graph, 'lambda:WorkerLambdaFunction')!.facts).toEqual({ runtime: 'nodejs22.x', timeout: 10, memory: 512 });
  });

  it('lambda: omits values a hand-built resource leaves empty', () => {
    const resources = [{
      type: 'lambda', logicalId: 'W', name: 'w', handler: '', runtime: '', environment: {}, memorySize: 0, timeout: 0,
    }] as Resource[];
    const graph = graphOf({ Resources: {} }, { resources });
    expect(node(graph, 'lambda:W')!.facts).toBeUndefined();
  });

  it('dynamodb: key schema, index counts, stream, TTL and the RAW vector-index count', () => {
    const graph = graphOf({
      Resources: {
        Orders: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {
            TableName: 'orders-Orders',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
            GlobalSecondaryIndexes: [{ IndexName: 'g1', KeySchema: [], Projection: {} }, { IndexName: 'g2', KeySchema: [], Projection: {} }],
            LocalSecondaryIndexes: [{ IndexName: 'l1', KeySchema: [], Projection: {} }],
            StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
            TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
            VectorIndexes: [{ IndexName: 'embedding' }],
          },
        },
        Plain: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {
            TableName: 'orders-Plain',
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            StreamSpecification: { StreamEnabled: true },
            TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: false },
            VectorIndexes: [],
          },
        },
        Bare: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'orders-Bare', VectorIndexes: 'not-a-list' } },
      },
    });
    expect(node(graph, 'dynamodb:Orders')!.facts).toEqual({
      pk: 'pk', sk: 'sk', gsis: 2, lsis: 1, stream: 'NEW_IMAGE', ttl: 'expiresAt', vectorIndexes: 1,
    });
    // StreamEnabled with no view type still says "streamed"; a disabled TTL and
    // an empty vector list say nothing.
    expect(node(graph, 'dynamodb:Plain')!.facts).toEqual({ pk: 'id', stream: true });
    expect(node(graph, 'dynamodb:Bare')!.facts).toBeUndefined();
  });

  it('dynamodb: tolerates a resource with no raw counterpart and a raw entry with no Properties', () => {
    const table = {
      type: 'dynamodb', logicalId: 'Ghost', name: 'ghost', keySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], attributeDefinitions: [],
    } as Resource;
    expect(node(graphOf({ Resources: {} }, { resources: [table] }), 'dynamodb:Ghost')!.facts).toEqual({ pk: 'id' });
    expect(node(graphOf({ Resources: { Ghost: { Type: 'AWS::DynamoDB::Table' } } }, { resources: [table] }), 'dynamodb:Ghost')!.facts)
      .toEqual({ pk: 'id' });
  });

  it('sqs: FIFO, visibility timeout, maxReceiveCount — and dlqOf on the dead-letter queue', () => {
    const graph = graphOf({
      Resources: {
        Jobs: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: 'jobs.fifo', FifoQueue: true, VisibilityTimeout: 5,
            RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Dlq', 'Arn'] }, maxReceiveCount: 2 },
          },
        },
        Dlq: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'jobs-dlq.fifo', VisibilityTimeout: 30 } },
        Plain: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'plain' } },
      },
    });
    expect(node(graph, 'sqs:Jobs')!.facts).toEqual({ fifo: true, visibilityTimeout: 5, maxReceiveCount: 2 });
    // The DLQ keeps its own facts and learns which queue it serves.
    expect(node(graph, 'sqs:Dlq')!.facts).toEqual({ visibilityTimeout: 30, dlqOf: 'sqs:Jobs' });
    expect(node(graph, 'sqs:Plain')!.facts).toBeUndefined();
  });

  it('sqs: a DLQ with no facts of its own gets dlqOf alone; an external DLQ is never annotated', () => {
    const graph = graphOf({
      Resources: {
        Jobs: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'jobs', RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Dlq', 'Arn'] }, maxReceiveCount: 2 } } },
        Dlq: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'jobs-dlq' } },
        Shared: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'shared', RedrivePolicy: { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:central-dlq', maxReceiveCount: 5 } } },
      },
    });
    expect(node(graph, 'sqs:Dlq')!.facts).toEqual({ dlqOf: 'sqs:Jobs' });
    const external = node(graph, 'external:arn:aws:sqs:us-east-1:000000000000:central-dlq')!;
    expect(external.facts).toBeUndefined();
  });

  it('s3: the subscribed event names, de-duplicated', () => {
    const graph = graphOf({
      Resources: {
        WorkerLambdaFunction: LAMBDA('orders-dev-worker'),
        Uploads: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: 'uploads',
            NotificationConfiguration: {
              LambdaConfigurations: [
                { Event: 's3:ObjectCreated:*', Function: { 'Fn::GetAtt': ['WorkerLambdaFunction', 'Arn'] } },
                { Event: 's3:ObjectCreated:*', Function: { 'Fn::GetAtt': ['WorkerLambdaFunction', 'Arn'] } },
                { Event: 's3:ObjectRemoved:*', Function: { 'Fn::GetAtt': ['WorkerLambdaFunction', 'Arn'] } },
              ],
            },
          },
        },
        Quiet: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'quiet' } },
      },
    });
    expect(node(graph, 's3:Uploads')!.facts).toEqual({ events: 's3:ObjectCreated:*, s3:ObjectRemoved:*' });
    expect(node(graph, 's3:Quiet')!.facts).toBeUndefined();
  });

  it('event-rule: the schedule, or a one-line pattern summary', () => {
    const graph = graphOf({
      Resources: {
        Nightly: { Type: 'AWS::Events::Rule', Properties: { Name: 'nightly', ScheduleExpression: 'rate(1 day)' } },
        Billed: {
          Type: 'AWS::Events::Rule',
          Properties: { Name: 'billed', EventPattern: { source: ['billing'], 'detail-type': ['OrderBilled', 'OrderRefunded'] } },
        },
        Empty: { Type: 'AWS::Events::Rule', Properties: { Name: 'empty' } },
      },
    });
    expect(node(graph, 'event-rule:Nightly')!.facts).toEqual({ schedule: 'rate(1 day)' });
    expect(node(graph, 'event-rule:Billed')!.facts).toEqual({ pattern: 'source=billing · detail-type=OrderBilled|OrderRefunded' });
    expect(node(graph, 'event-rule:Empty')!.facts).toBeUndefined();
  });

  it('summarisePattern folds nested objects and keeps scalars', () => {
    expect(summarisePattern({ source: ['billing'], detail: { status: ['PAID'] }, account: '000000000000', mixed: [{ prefix: 'a' }, 'b'] }))
      .toBe('source=billing · detail={…} · account=000000000000 · mixed={…}|b');
  });

  it('opensearch and ssm carry their type; secrets, topics and buses carry nothing', () => {
    const graph = graphOf({
      Resources: {
        Search: { Type: 'AWS::OpenSearchServerless::Collection', Properties: { Name: 'products', Type: 'SEARCH' } },
        DbUrl: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/acme/orders/db-url', Type: 'String', Value: 'x' } },
        Secret: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: 'orders/key' } },
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'orders-events' } },
        Bus: { Type: 'AWS::Events::EventBus', Properties: { Name: 'orders-bus' } },
      },
    });
    expect(node(graph, 'opensearch:Search')!.facts).toEqual({ type: 'SEARCH' });
    expect(node(graph, 'ssm:DbUrl')).toMatchObject({ kind: 'ssm', label: '/acme/orders/db-url', facts: { type: 'String' } });
    expect(node(graph, 'secret:Secret')!.facts).toBeUndefined();
    expect(node(graph, 'sns:Topic')!.facts).toBeUndefined();
    expect(node(graph, 'eventbus:Bus')!.facts).toBeUndefined();
  });
});

describe('SSM parameters', () => {
  it('parses a parameter ARN to the whole path, and refuses one with no name', () => {
    expect(parseResourceArn('arn:aws:ssm:us-east-1:000000000000:parameter/acme/orders/db-url'))
      .toEqual({ service: 'ssm', name: 'acme/orders/db-url' });
    expect(parseResourceArn('arn:aws:ssm:us-east-1:000000000000:parameter/')).toBeNull();
  });

  it('resolves a grant on the ARN to the declared parameter (leading slash and all), with read access', () => {
    const graph = graphOf({
      Resources: {
        IamRoleLambdaExecution: {
          Type: 'AWS::IAM::Role',
          Properties: {
            Policies: [{
              PolicyDocument: {
                Statement: [{
                  Effect: 'Allow',
                  Action: 'ssm:GetParameter',
                  Resource: 'arn:aws:ssm:us-east-1:000000000000:parameter/acme/orders/db-url',
                }],
              },
            }],
          },
        },
        WorkerLambdaFunction: LAMBDA('orders-dev-worker', { Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } }),
        DbUrl: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/acme/orders/db-url', Type: 'String', Value: 'x' } },
      },
    });
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'ssm:DbUrl')).toMatchObject({ kind: 'iam', access: 'read' });
  });

  it('matches an env var holding the parameter NAME', () => {
    const graph = graphOf({
      Resources: {
        WorkerLambdaFunction: LAMBDA('orders-dev-worker'),
        DbUrl: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/acme/orders/db-url', Type: 'String', Value: 'x' } },
      },
    }, { functions: [fn('worker', 'orders-dev-worker', { DB_URL_PARAM: '/acme/orders/db-url' })] });
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'ssm:DbUrl')).toMatchObject({ kind: 'env', detail: 'DB_URL_PARAM' });
  });
});

describe('api nodes', () => {
  const functions = [fn('create', 'orders-dev-create'), fn('list', 'orders-dev-list')];
  const lambdas = {
    CreateLambdaFunction: LAMBDA('orders-dev-create'),
    ListLambdaFunction: LAMBDA('orders-dev-list'),
  };

  it('assigns httpApi routes to the API their compiled ::Route names, with route count and authorizers', () => {
    const graph = graphOf({
      Resources: {
        ...lambdas,
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'dev-orders' } },
        HttpApiRoutePostOrders: { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: { Ref: 'HttpApi' }, RouteKey: 'POST /orders' } },
      },
    }, {
      functions,
      routes: [
        route('POST', '/orders', 'create', { authorizerName: 'jwt' }),
        route('GET', '/orders', 'list', { authorizerName: 'jwt' }),
        route('GET', '/orders/{id}', 'list', { authorizerName: 'apiKey' }),
      ],
    });
    expect(node(graph, 'api:HttpApi')).toEqual({
      id: 'api:HttpApi',
      kind: 'api',
      label: 'dev-orders',
      logicalId: 'HttpApi',
      group: 'orders',
      facts: { protocol: 'HTTP', routes: 3, authorizers: 'apiKey, jwt' },
    });
    // The declared ::Route proves POST; the others fall back to the template's
    // only HTTP API — the same box either way.
    expect(node(graph, 'route:POST /orders')!.api).toBe('api:HttpApi');
    expect(node(graph, 'route:GET /orders')!.api).toBe('api:HttpApi');
  });

  it('folds each function’s routes onto its card, path first then verb', () => {
    const graph = graphOf({ Resources: lambdas }, {
      functions,
      routes: [route('GET', '/orders/{id}', 'list'), route('POST', '/orders', 'list'), route('GET', '/orders', 'list')],
    });
    expect(node(graph, 'lambda:ListLambdaFunction')!.routes).toEqual([
      { method: 'GET', path: '/orders' },
      { method: 'POST', path: '/orders' },
      { method: 'GET', path: '/orders/{id}' },
    ]);
    expect(node(graph, 'lambda:CreateLambdaFunction')!.routes).toBeUndefined();
  });

  it('serves REST routes from the RestApi, and falls back to implicit APIs per flavour', () => {
    const withRest = graphOf({
      Resources: { ...lambdas, ApiGatewayRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'dev-orders-rest' } } },
    }, { functions, routes: [route('GET', '/legacy', 'list', { eventType: 'http' }), route('GET', '/v2', 'list')] });
    expect(node(withRest, 'route:GET /legacy')!.api).toBe('api:ApiGatewayRestApi');
    expect(node(withRest, 'api:ApiGatewayRestApi')).toMatchObject({ label: 'dev-orders-rest', facts: { protocol: 'REST', routes: 1 } });
    // No HTTP API declared: the httpApi route gets the implicit one.
    expect(node(withRest, 'api:implicit-http')).toMatchObject({ label: 'HTTP API', facts: { protocol: 'HTTP', routes: 1 } });
    expect(node(withRest, 'api:implicit-http')!.logicalId).toBeUndefined();

    const bare = graphOf({ Resources: lambdas }, { functions, routes: [route('GET', '/legacy', 'list', { eventType: 'http' })] });
    expect(node(bare, 'api:implicit-rest')).toMatchObject({ label: 'REST API', facts: { protocol: 'REST', routes: 1 } });
    expect(node(bare, 'api:implicit-rest')!.facts!.authorizers).toBeUndefined();
  });

  it('ignores a declared ::Route whose ApiId is not an API this template declares', () => {
    const graph = graphOf({
      Resources: {
        ...lambdas,
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'dev-orders' } },
        ForeignRoute: { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: 'abc123', RouteKey: 'GET /orders' } },
        NoApiRoute: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: 'GET /orders' } },
      },
    }, { functions, routes: [route('GET', '/orders', 'list')] });
    expect(node(graph, 'route:GET /orders')!.api).toBe('api:HttpApi');
  });

  it('draws no API node for an API nothing is routed to', () => {
    const graph = graphOf({ Resources: { HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'dev-orders' } } } });
    expect(graph.nodes.filter(n => n.kind === 'api')).toEqual([]);
  });
});

describe('third-party HTTP dependencies', () => {
  const template = { Resources: { WorkerLambdaFunction: LAMBDA('orders-dev-worker'), OtherLambdaFunction: LAMBDA('orders-dev-other') } };

  it('turns an absolute URL to a foreign host into one external node per host', () => {
    const graph = graphOf(template, {
      functions: [
        fn('worker', 'orders-dev-worker', { PAYMENTS_URL: 'https://api.payments.example.com/v1/charges', WEBHOOK: 'https://hooks.example.org' }),
        fn('other', 'orders-dev-other', { PAYMENTS_URL: 'https://API.payments.example.com/v1/refunds' }),
      ],
    });
    expect(node(graph, 'external:http:api.payments.example.com')).toEqual({
      id: 'external:http:api.payments.example.com',
      kind: 'external',
      label: 'api.payments.example.com',
      service: 'http',
      group: 'external',
    });
    expect(edge(graph, 'lambda:WorkerLambdaFunction', 'external:http:api.payments.example.com'))
      .toMatchObject({ kind: 'env', confidence: 'inferred', detail: 'PAYMENTS_URL' });
    expect(edge(graph, 'lambda:OtherLambdaFunction', 'external:http:api.payments.example.com')).toBeDefined();
    expect(node(graph, 'external:http:hooks.example.org')).toBeDefined();
    expect(graph.nodes.filter(n => n.service === 'http')).toHaveLength(2);
  });

  it.each([
    ['loopback', 'http://localhost:9999/x'],
    ['loopback address', 'http://127.0.0.1/x'],
    ['any address', 'http://0.0.0.0/x'],
    ['IPv6 loopback', 'http://[::1]/x'],
    ['docker host alias', 'http://host.docker.internal/x'],
    ['.localhost subdomain', 'http://orders.localhost/x'],
    ['AWS endpoint', 'https://sqs.us-east-1.amazonaws.com/000000000000/undeclared'],
    ['an LSS API port', 'http://dev-box:3631/orders'],
    ['an LSS invoke port', 'http://dev-box:13631/'],
    ['a malformed URL', 'http://'],
    ['a non-URL value', 'just-a-name'],
  ])('ignores %s', (_label, value) => {
    const graph = graphOf(template, { functions: [fn('worker', 'orders-dev-worker', { TARGET: value })] });
    expect(graph.nodes.filter(n => n.kind === 'external')).toEqual([]);
  });

  it('keeps a foreign host on a port outside the LSS block', () => {
    const graph = graphOf(template, { functions: [fn('worker', 'orders-dev-worker', { TARGET: 'https://partner.example.com:8443/api' })] });
    expect(node(graph, 'external:http:partner.example.com')).toBeDefined();
  });
});

describe('external targets and physical names (the stack-graph join)', () => {
  it('reduces an ARN-built external to its kind and name', () => {
    expect(externalTarget({ id: 'x', kind: 'external', label: 'q', arn: 'arn:aws:sqs:us-east-1:000000000000:orders-jobs', service: 'sqs' }))
      .toEqual({ kind: 'sqs', name: 'orders-jobs' });
    expect(externalTarget({ id: 'x', kind: 'external', label: 'f', arn: 'arn:aws:lambda:us-east-1:000000000000:function:orders-dev-worker', service: 'lambda' }))
      .toEqual({ kind: 'lambda', name: 'orders-dev-worker' });
  });

  it('reduces a name-built external through the graph kind it carries', () => {
    expect(externalTarget({ id: 'x', kind: 'external', label: 'billing-events', service: 'eventbus' }))
      .toEqual({ kind: 'eventbus', name: 'billing-events' });
  });

  it('falls back to the label when the ARN does not parse', () => {
    expect(externalTarget({ id: 'x', kind: 'external', label: 'odd', arn: 'arn:aws:sqs', service: 'sqs' }))
      .toEqual({ kind: 'sqs', name: 'odd' });
  });

  it('answers null for HTTP hosts, unknown services, missing services and non-externals', () => {
    expect(externalTarget({ id: 'x', kind: 'external', label: 'api.example.com', service: 'http' })).toBeNull();
    expect(externalTarget({ id: 'x', kind: 'external', label: 'k', arn: 'arn:aws:kinesis:us-east-1:0:stream/k', service: 'kinesis' })).toBeNull();
    expect(externalTarget({ id: 'x', kind: 'external', label: 'k' })).toBeNull();
    expect(externalTarget({ id: 'x', kind: 'sqs', label: 'k', service: 'sqs' })).toBeNull();
  });

  it('names a lambda by its full name, other resources by label, and nothing for structural kinds', () => {
    expect(physicalName({ id: 'x', kind: 'lambda', label: 'worker', fullName: 'orders-dev-worker' })).toBe('orders-dev-worker');
    expect(physicalName({ id: 'x', kind: 'lambda', label: 'worker' })).toBe('worker');
    expect(physicalName({ id: 'x', kind: 'sqs', label: 'orders-jobs' })).toBe('orders-jobs');
    expect(physicalName({ id: 'x', kind: 'route', label: 'GET /x' })).toBeNull();
    expect(physicalName({ id: 'x', kind: 'external', label: 'q' })).toBeNull();
  });
});

describe('group membership', () => {
  it('puts every declared node in the service’s group and externals in `external`', () => {
    const graph = graphOf({
      Resources: {
        WorkerLambdaFunction: LAMBDA('orders-dev-worker'),
        Mapping: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: { FunctionName: { Ref: 'WorkerLambdaFunction' }, EventSourceArn: 'arn:aws:sqs:us-east-1:000000000000:billing-jobs' },
        },
      },
    }, { functions: [fn('worker', 'orders-dev-worker')], routes: [route('GET', '/x', 'worker')] });
    const groups = Object.fromEntries(graph.nodes.map(n => [n.id, n.group]));
    expect(groups).toEqual({
      'lambda:WorkerLambdaFunction': 'orders',
      'route:GET /x': 'orders',
      'api:implicit-http': 'orders',
      'external:arn:aws:sqs:us-east-1:000000000000:billing-jobs': 'external',
    });
  });
});
