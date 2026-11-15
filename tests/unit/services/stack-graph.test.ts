// The stack graph: every service's graph joined into one, externals resolved
// into cross-service edges, and collapsed services folded into single nodes.
// Pure module — the per-service graphs are built for real from hand-written
// templates (the shape the route feeds it), so resolution is exercised against
// the exact external stubs `buildServiceGraph` emits.
import {
  buildStackGraph,
  resolveExpansion,
  COLLAPSE_THRESHOLD,
  StackGraph,
} from '../../../src/server/services/stack-graph';
import { buildServiceGraph, GraphEdge, GraphNode, ServiceGraph } from '../../../src/server/services/service-graph';
import { CloudFormationParser } from '../../../src/server/services/cloudformation-parser';
import { RegisteredFunction, HttpRoute } from '../../../src/server/services/serverless-state-parser';

const parser = new CloudFormationParser();

function graphOf(
  service: string,
  resources: Record<string, unknown>,
  functions: RegisteredFunction[] = [],
  routes: HttpRoute[] = [],
): ServiceGraph {
  const template = { Resources: resources };
  return buildServiceGraph({ serviceName: service, template, resources: parser.parse(template as never), functions, routes });
}

function fn(name: string, fullName: string, environment: Record<string, string> = {}): RegisteredFunction {
  return { name, fullName, handler: 'h.handler', runtime: 'nodejs20.x', memorySize: 1024, timeout: 6, environment, triggers: [] };
}

const LAMBDA = (name: string, role = true) => ({
  Type: 'AWS::Lambda::Function',
  Properties: { FunctionName: name, Handler: 'h.handler', ...(role ? { Role: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] } } : {}) },
});

const ROLE = (statements: unknown[]) => ({
  Type: 'AWS::IAM::Role',
  Properties: { Policies: [{ PolicyDocument: { Statement: statements } }] },
});

const ARN = 'arn:aws:sqs:us-west-2:000000000000';

// The bundled demo's shape, reduced: orders owns a queue + DLQ, billing
// consumes the queue by ARN and owns a bus, notifications listens on that bus
// by ARN, and a secret is granted across services by its random-suffixed ARN.
function demo(): ServiceGraph[] {
  const orders = graphOf('orders', {
    CreateLambdaFunction: LAMBDA('orders-dev-create'),
    IamRoleLambdaExecution: ROLE([{ Effect: 'Allow', Action: 'sqs:SendMessage', Resource: { 'Fn::GetAtt': ['Jobs', 'Arn'] } }]),
    Jobs: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'orders-jobs', RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Dlq', 'Arn'] }, maxReceiveCount: 2 } } },
    Dlq: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'orders-jobs-dlq' } },
  }, [fn('create', 'orders-dev-create', { PAYMENTS: 'https://api.payments.example.com/v1' })], [
    { functionName: 'create', method: 'POST', path: '/orders', eventType: 'httpApi', cors: false },
  ]);
  const billing = graphOf('billing', {
    ProcessLambdaFunction: LAMBDA('billing-dev-process'),
    IamRoleLambdaExecution: ROLE([
      { Effect: 'Allow', Action: 'events:PutEvents', Resource: { 'Fn::GetAtt': ['Bus', 'Arn'] } },
      { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: 'arn:aws:secretsmanager:us-west-2:000000000000:secret:shared/hmac-AbCdEf' },
      // Two ARNs that both name the orders DLQ (the queue and a wildcard
      // suffix): they resolve to the same node and must land as ONE edge.
      { Effect: 'Allow', Action: 'sqs:ReceiveMessage', Resource: [`${ARN}:orders-jobs-dlq`, `${ARN}:orders-jobs-dlq/x`] },
      { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: `${ARN}:unregistered-queue` },
    ]),
    Mapping: {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: { FunctionName: { Ref: 'ProcessLambdaFunction' }, EventSourceArn: `${ARN}:orders-jobs`, BatchSize: 5 },
    },
    Bus: { Type: 'AWS::Events::EventBus', Properties: { Name: 'billing-events' } },
  }, [fn('process', 'billing-dev-process', { PAYMENTS: 'https://api.payments.example.com/v1' })]);
  const notifications = graphOf('notifications', {
    NotifyLambdaFunction: LAMBDA('notifications-dev-notify', false),
    Rule: {
      Type: 'AWS::Events::Rule',
      Properties: {
        Name: 'billed',
        EventBusName: 'arn:aws:events:us-west-2:000000000000:event-bus/billing-events',
        EventPattern: { source: ['billing'] },
        Targets: [{ Id: 't', Arn: { 'Fn::GetAtt': ['NotifyLambdaFunction', 'Arn'] } }],
      },
    },
  });
  const shared = graphOf('shared', {
    Hmac: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: 'shared/hmac' } },
    Other: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: 'shared/other' } },
  });
  return [orders, billing, notifications, shared];
}

function all(graphs: ServiceGraph[]): StackGraph {
  return buildStackGraph(graphs, new Set(graphs.map(g => g.service)));
}

function node(stack: StackGraph, id: string): GraphNode | undefined {
  return stack.nodes.find(n => n.id === id);
}

function edge(stack: StackGraph, from: string, to: string): GraphEdge | undefined {
  return stack.edges.find(e => e.from === from && e.to === to);
}

describe('resolveExpansion', () => {
  const few = ['a', 'b', 'c'];
  const many = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) => `svc-${i}`);

  it('expands everything by default up to the threshold, nothing past it', () => {
    expect([...resolveExpansion(few, undefined)]).toEqual(few);
    expect([...resolveExpansion(many.slice(0, COLLAPSE_THRESHOLD), undefined)]).toHaveLength(COLLAPSE_THRESHOLD);
    expect([...resolveExpansion(many, undefined)]).toEqual([]);
  });

  it('takes "*" as everything and an empty value as nothing', () => {
    expect([...resolveExpansion(many, '*')]).toEqual(many);
    expect([...resolveExpansion(many, ' * ')]).toEqual(many);
    expect([...resolveExpansion(few, '')]).toEqual([]);
  });

  it('takes an explicit list, trimmed, ignoring names that are not registered', () => {
    expect([...resolveExpansion(few, ' a, c ,ghost')]).toEqual(['a', 'c']);
  });
});

describe('buildStackGraph — resolution', () => {
  it('turns an external stub into a cross-service edge to the real node, keeping the evidence in `via`', () => {
    const stack = all(demo());
    const consume = edge(stack, 'orders/sqs:Jobs', 'billing/lambda:ProcessLambdaFunction')!;
    expect(consume).toMatchObject({ kind: 'cross-service', via: 'event-source', access: 'trigger', detail: 'poll ×5', confidence: 'declared' });
    expect(consume.id).toBe('orders/sqs:Jobs\u0000billing/lambda:ProcessLambdaFunction\u0000cross-service');
    // The bus is referenced by ARN in notifications and declared by billing.
    expect(edge(stack, 'billing/eventbus:Bus', 'notifications/event-rule:Rule')).toMatchObject({ kind: 'cross-service', via: 'event-bus-rule' });
    // No resolved stub survives as a node.
    expect(stack.nodes.filter(n => n.kind === 'external').map(n => n.id).sort()).toEqual([
      `external:${ARN}:unregistered-queue`,
      'external:http:api.payments.example.com',
    ]);
  });

  it('matches a secret by prefix (AWS appends six random characters to its ARN)', () => {
    const stack = all(demo());
    expect(edge(stack, 'billing/iam-role:IamRoleLambdaExecution', 'shared/secret:Hmac')).toBeUndefined();
    expect(edge(stack, 'billing/lambda:ProcessLambdaFunction', 'shared/secret:Hmac')).toMatchObject({ kind: 'cross-service', via: 'iam', access: 'read' });
  });

  it('leaves a secret no service declares as an external', () => {
    const reader = graphOf('reader', {
      FnLambdaFunction: LAMBDA('reader-dev-fn'),
      IamRoleLambdaExecution: ROLE([{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: 'arn:aws:secretsmanager:us-west-2:000000000000:secret:nobody/key-AbCdEf' }]),
    });
    const stack = all([reader, ...demo()]);
    expect(node(stack, 'external:arn:aws:secretsmanager:us-west-2:000000000000:secret:nobody/key-AbCdEf')).toMatchObject({ label: 'nobody/key-AbCdEf' });
  });

  it('lands two stubs that resolve to the same node as ONE edge', () => {
    const stack = all(demo());
    const toDlq = stack.edges.filter(e => e.to === 'orders/sqs:Dlq' && e.from === 'billing/lambda:ProcessLambdaFunction');
    expect(toDlq).toHaveLength(1);
    expect(toDlq[0].access).toBe('consume');
  });

  it('keeps intra-service edges as they were, ids prefixed with the service', () => {
    const stack = all(demo());
    expect(edge(stack, 'orders/sqs:Jobs', 'orders/sqs:Dlq')).toMatchObject({ kind: 'redrive', access: 'publish' });
    expect(edge(stack, 'orders/sqs:Jobs', 'orders/sqs:Dlq')!.via).toBeUndefined();
    // References INSIDE a node are re-pointed too: the route's API and the
    // DLQ's source queue.
    expect(node(stack, 'orders/route:POST /orders')!.api).toBe('orders/api:implicit-http');
    expect(node(stack, 'orders/sqs:Dlq')!.facts!.dlqOf).toBe('orders/sqs:Jobs');
  });

  it('shares one node for an external two services reference, edges to it keep their kind', () => {
    const stack = all(demo());
    const host = 'external:http:api.payments.example.com';
    expect(stack.nodes.filter(n => n.id === host)).toHaveLength(1);
    expect(edge(stack, 'orders/lambda:CreateLambdaFunction', host)).toMatchObject({ kind: 'env', confidence: 'inferred' });
    expect(edge(stack, 'billing/lambda:ProcessLambdaFunction', host)).toMatchObject({ kind: 'env' });
  });

  it('resolves to the first declaration (service name order) when two services claim one name', () => {
    const consumer = graphOf('a-consumer', {
      Fn1LambdaFunction: LAMBDA('a-dev-fn', false),
      Mapping: { Type: 'AWS::Lambda::EventSourceMapping', Properties: { FunctionName: { Ref: 'Fn1LambdaFunction' }, EventSourceArn: `${ARN}:dup` } },
    });
    const first = graphOf('b-owner', { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'dup' } } });
    const second = graphOf('c-owner', { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'dup' } } });
    const stack = all([second, consumer, first]);
    expect(edge(stack, 'b-owner/sqs:Q', 'a-consumer/lambda:Fn1LambdaFunction')).toBeDefined();
    expect(edge(stack, 'c-owner/sqs:Q', 'a-consumer/lambda:Fn1LambdaFunction')).toBeUndefined();
  });

  it('resolves an external back into its own service as a plain (non cross-service) edge', () => {
    // A secret grant this service could not match locally (prefix matching is
    // done at stack level only for secrets of OTHER services' shape) — here the
    // stub names a secret the same service declares under a longer name.
    const self = graphOf('solo', {
      WorkerLambdaFunction: LAMBDA('solo-dev-worker'),
      IamRoleLambdaExecution: ROLE([{ Effect: 'Allow', Action: 'sqs:SendMessage', Resource: `${ARN}:solo-q` }]),
    });
    // Inject a declared node that owns the name the stub points at.
    self.nodes.push({ id: 'sqs:Q', kind: 'sqs', label: 'solo-q', group: 'solo' });
    const stack = all([self]);
    expect(edge(stack, 'solo/lambda:WorkerLambdaFunction', 'solo/sqs:Q')).toMatchObject({ kind: 'iam' });
  });

  it('collects every service’s warnings, prefixed, and summarises each service', () => {
    const broken = graphOf('broken', {
      Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q', RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['Missing', 'Arn'] }, maxReceiveCount: 1 } } },
    });
    const stack = all([broken, ...demo()]);
    expect(stack.warnings).toEqual([expect.stringMatching(/^\[broken\] Queue q redrives to Missing/)]);
    expect(stack.services.map(s => s.name)).toEqual(['billing', 'broken', 'notifications', 'orders', 'shared']);
    expect(stack.services.find(s => s.name === 'orders')).toEqual({
      name: 'orders', expanded: true, counts: { lambda: 1, sqs: 2, api: 1 }, warnings: 0,
    });
    expect(stack.services.find(s => s.name === 'broken')!.warnings).toBe(1);
    expect(stack.expanded).toEqual(['billing', 'broken', 'notifications', 'orders', 'shared']);
    expect(stack.edgeKinds).toEqual(expect.arrayContaining(['cross-service', 'redrive', 'iam', 'env']));
  });
});

describe('buildStackGraph — collapse', () => {
  it('folds a collapsed service into one node carrying its counts', () => {
    const stack = buildStackGraph(demo(), new Set(['billing']));
    expect(node(stack, 'service:orders')).toEqual({
      id: 'service:orders', kind: 'service', label: 'orders', group: 'orders', facts: { lambda: 1, sqs: 2, api: 1 },
    });
    expect(stack.nodes.some(n => n.id.startsWith('orders/'))).toBe(false);
    expect(stack.nodes.some(n => n.id.startsWith('billing/'))).toBe(true);
    expect(stack.expanded).toEqual(['billing']);
    expect(stack.services.find(s => s.name === 'orders')!.expanded).toBe(false);
  });

  it('re-points cross-service edges at the collapsed node and weights them', () => {
    const stack = buildStackGraph(demo(), new Set(['billing']));
    // orders → billing: the event-source mapping on the queue, plus the
    // consume grant on the DLQ — two different `via`s, mixed accesses.
    const inbound = edge(stack, 'service:orders', 'billing/lambda:ProcessLambdaFunction')!;
    expect(inbound).toMatchObject({ kind: 'cross-service', weight: 1, via: 'event-source', access: 'trigger', detail: 'poll ×5' });
    const outbound = edge(stack, 'billing/lambda:ProcessLambdaFunction', 'service:orders')!;
    expect(outbound).toMatchObject({ kind: 'cross-service', weight: 1, via: 'iam', access: 'consume' });
  });

  it('aggregates many edges between two collapsed services into one weighted arrow', () => {
    const stack = buildStackGraph(demo(), new Set());
    const billingToOrders = edge(stack, 'service:billing', 'service:orders')!;
    const ordersToBilling = edge(stack, 'service:orders', 'service:billing')!;
    expect(ordersToBilling).toMatchObject({ kind: 'cross-service', weight: 1, via: 'event-source' });
    expect(billingToOrders.weight).toBe(1);
    expect(edge(stack, 'service:billing', 'service:notifications')).toMatchObject({ via: 'event-bus-rule', weight: 1 });
    // Intra-service edges (the redrive, the role spokes) are gone.
    expect(stack.edges.some(e => e.from === e.to)).toBe(false);
    expect(stack.nodes.map(n => n.id)).toEqual([
      'service:billing',
      `external:${ARN}:unregistered-queue`,
      'external:http:api.payments.example.com',
      'service:notifications',
      'service:orders',
      'service:shared',
    ]);
  });

  it('merges kinds, vias, accesses and confidence across the members of an aggregated arrow', () => {
    const producer = graphOf('producer', {
      AFnLambdaFunction: LAMBDA('producer-dev-a'),
      BFnLambdaFunction: LAMBDA('producer-dev-b'),
      IamRoleLambdaExecution: ROLE([
        { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: 'arn:aws:dynamodb:us-west-2:000000000000:table/consumer-Read' },
        { Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: 'arn:aws:dynamodb:us-west-2:000000000000:table/consumer-Write' },
        { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: `${ARN}:consumer-q` },
      ]),
    }, [
      fn('a', 'producer-dev-a', { TABLE: 'consumer-Env' }),
      fn('b', 'producer-dev-b', { TABLE: 'consumer-Env' }),
    ]);
    const consumer = graphOf('consumer', {
      Read: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'consumer-Read' } },
      Write: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'consumer-Write' } },
      Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'consumer-q' } },
    });
    // The env value names a table only by a plain name the producer does not
    // declare — an inferred edge never resolves (no external stub), so add one
    // by hand to exercise the inferred-only aggregation.
    producer.nodes.push({ id: 'external:consumer-Env', kind: 'external', label: 'consumer-Env', service: 'dynamodb', group: 'external' });
    consumer.nodes.push({ id: 'dynamodb:Env', kind: 'dynamodb', label: 'consumer-Env', group: 'consumer' });
    producer.edges.push({ id: 'x', from: 'lambda:AFnLambdaFunction', to: 'external:consumer-Env', kind: 'env', confidence: 'inferred' });

    const collapsed = buildStackGraph([producer, consumer], new Set());
    const arrow = edge(collapsed, 'service:producer', 'service:consumer')!;
    // read + write + publish + an inferred env member: kinds agree
    // (cross-service), vias do not, data accesses mix → readwrite, and one
    // declared member makes the arrow declared.
    expect(arrow).toEqual({
      id: 'service:producer\u0000service:consumer\u0000cross-service',
      from: 'service:producer',
      to: 'service:consumer',
      kind: 'cross-service',
      confidence: 'declared',
      weight: 4,
      access: 'readwrite',
      detail: '4 links',
    });
  });

  it('keeps a member kind when every member shares it, and drops access when none moves data', () => {
    const a = graphOf('a', {
      OneLambdaFunction: LAMBDA('a-dev-one', false),
      TwoLambdaFunction: LAMBDA('a-dev-two', false),
    }, [
      fn('one', 'a-dev-one', { URL: 'https://x.example.com' }),
      fn('two', 'a-dev-two', { URL: 'https://x.example.com', OTHER: 'https://y.example.com' }),
    ]);
    const stack = buildStackGraph([a], new Set());
    // Both functions → the same host collapse into one env arrow of weight 2.
    expect(edge(stack, 'service:a', 'external:http:x.example.com')).toEqual({
      id: 'service:a\u0000external:http:x.example.com\u0000env',
      from: 'service:a',
      to: 'external:http:x.example.com',
      kind: 'env',
      confidence: 'inferred',
      weight: 2,
      detail: '2 links',
    });
    expect(edge(stack, 'service:a', 'external:http:y.example.com')).toMatchObject({ weight: 1, detail: 'OTHER' });
  });

  it('mixes control-only accesses into no access at all, and keeps an absent detail absent', () => {
    const a = graphOf('a', {
      OneLambdaFunction: LAMBDA('a-dev-one'),
      IamRoleLambdaExecution: ROLE([
        { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: `${ARN}:b-q` },
        { Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: 'arn:aws:lambda:us-west-2:000000000000:function:b-dev-fn' },
      ]),
    });
    const b = graphOf('b', {
      Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'b-q' } },
      FnLambdaFunction: LAMBDA('b-dev-fn', false),
    });
    const stack = buildStackGraph([a, b], new Set(['a']));
    const arrow = edge(stack, 'a/lambda:OneLambdaFunction', 'service:b')!;
    expect(arrow.weight).toBe(2);
    expect(arrow.access).toBeUndefined();
    expect(arrow.via).toBe('iam');

    const bare: ServiceGraph = {
      service: 'c', nodes: [{ id: 'lambda:F', kind: 'lambda', label: 'f', group: 'c' }, { id: 'external:z', kind: 'external', label: 'z', group: 'external' }],
      edges: [{ id: 'e', from: 'lambda:F', to: 'external:z', kind: 'iam', confidence: 'declared' }], edgeKinds: ['iam'], warnings: [],
    };
    const lone = edge(buildStackGraph([bare], new Set()), 'service:c', 'external:z')!;
    expect('detail' in lone).toBe(false);
    expect('access' in lone).toBe(false);

    // Two different kinds to one external from a collapsed service: no single
    // kind survives, so the arrow is `cross-service` with no `via`.
    bare.edges.push({ id: 'f', from: 'lambda:F', to: 'external:z', kind: 'event-source', confidence: 'declared', access: 'trigger' });
    const mixed = edge(buildStackGraph([bare], new Set()), 'service:c', 'external:z')!;
    expect(mixed).toMatchObject({ kind: 'cross-service', weight: 2 });
    expect(mixed.via).toBeUndefined();
  });

  it('resolves an SSM grant across services, leading slash and all', () => {
    const reader = graphOf('reader', {
      FnLambdaFunction: LAMBDA('reader-dev-fn'),
      IamRoleLambdaExecution: ROLE([{ Effect: 'Allow', Action: 'ssm:GetParameter', Resource: 'arn:aws:ssm:us-west-2:000000000000:parameter/acme/config' }]),
    });
    const owner = graphOf('owner', { Config: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/acme/config', Type: 'String', Value: 'x' } } });
    expect(edge(all([reader, owner]), 'reader/lambda:FnLambdaFunction', 'owner/ssm:Config')).toMatchObject({ kind: 'cross-service', access: 'read' });
  });

  it('still draws a box for a collapsed service that has no nodes at all', () => {
    const empty: ServiceGraph = { service: 'empty', nodes: [], edges: [], edgeKinds: [], warnings: ['No cached CloudFormation template for this service'] };
    const stack = buildStackGraph([empty, ...demo()], new Set());
    expect(node(stack, 'service:empty')).toEqual({ id: 'service:empty', kind: 'service', label: 'empty', group: 'empty', facts: {} });
  });

  it('is deterministic: the same graphs in any order give the same payload', () => {
    const forward = buildStackGraph(demo(), new Set(['orders']));
    const backward = buildStackGraph(demo().reverse(), new Set(['orders']));
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });
});

// The scale target the product is built for: 40 services × 60 functions × 10
// tables. The collapsed payload is what the stack page opens on, so it has to
// stay small; expanding one service must cost about what the service graph
// costs on its own.
describe('buildStackGraph — 40-service benchmark', () => {
  function synthetic(index: number): ServiceGraph {
    const service = `svc-${String(index).padStart(2, '0')}`;
    const upstream = `svc-${String((index + 39) % 40).padStart(2, '0')}`;
    const resources: Record<string, unknown> = {};
    const functions: RegisteredFunction[] = [];
    const routes: HttpRoute[] = [];
    const tableArns: unknown[] = [];
    for (let t = 0; t < 10; t += 1) {
      resources[`Table${t}`] = { Type: 'AWS::DynamoDB::Table', Properties: { TableName: `${service}-table-${t}`, KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] } };
      tableArns.push({ 'Fn::GetAtt': [`Table${t}`, 'Arn'] });
    }
    resources.Jobs = { Type: 'AWS::SQS::Queue', Properties: { QueueName: `${service}-jobs` } };
    for (let f = 0; f < 60; f += 1) {
      const fullName = `${service}-dev-fn${f}`;
      resources[`Fn${f}LambdaFunction`] = LAMBDA(fullName);
      functions.push(fn(`fn${f}`, fullName, { TABLE: `${service}-table-0`, PARTNER: 'https://api.partner.example.com' }));
      if (f < 20) routes.push({ functionName: `fn${f}`, method: 'GET', path: `/r${f}`, eventType: 'httpApi', cors: false });
    }
    // Every service consumes its upstream neighbour's queue and writes to its
    // jobs queue: a ring of 40 cross-service links.
    resources.Mapping = {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: { FunctionName: { Ref: 'Fn0LambdaFunction' }, EventSourceArn: `${ARN}:${upstream}-jobs` },
    };
    resources.IamRoleLambdaExecution = ROLE([
      { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: tableArns },
      { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: `${ARN}:${upstream}-jobs` },
    ]);
    return graphOf(service, resources, functions, routes);
  }

  it('collapsed: 40 boxes, small payload, well inside the time budget', () => {
    const started = Date.now();
    const graphs = Array.from({ length: 40 }, (_, i) => synthetic(i));
    const stack = buildStackGraph(graphs, resolveExpansion(graphs.map(g => g.service), undefined));
    const elapsed = Date.now() - started;

    expect(stack.expanded).toEqual([]);
    // 40 services + the one shared third-party host.
    expect(stack.nodes).toHaveLength(41);
    expect(stack.nodes.filter(n => n.kind === 'service')).toHaveLength(40);
    // Per service: two aggregated arrows to its upstream (the consume mapping
    // inbound, the publish grant outbound) collapse to one each way, plus one
    // to the partner host.
    expect(stack.edges).toHaveLength(40 * 3);
    expect(Buffer.byteLength(JSON.stringify(stack))).toBeLessThan(200 * 1024);
    // The budget is 300 ms on the reference machine for the whole route; this
    // bound is deliberately generous (shared CI runners, coverage
    // instrumentation) and still catches an accidental quadratic.
    expect(elapsed).toBeLessThan(5000);
  });

  it('one service expanded: its ~80 nodes in full, the other 39 collapsed', () => {
    const graphs = Array.from({ length: 40 }, (_, i) => synthetic(i));
    const stack = buildStackGraph(graphs, resolveExpansion(graphs.map(g => g.service), 'svc-07'));
    const own = stack.nodes.filter(n => n.group === 'svc-07');
    // 60 lambdas + 10 tables + 1 queue + 20 routes + 1 API + the role hub.
    expect(own).toHaveLength(60 + 10 + 1 + 20 + 1 + 1);
    expect(stack.nodes.filter(n => n.kind === 'service')).toHaveLength(39);
    expect(Buffer.byteLength(JSON.stringify(stack))).toBeLessThan(300 * 1024);
  });
});
