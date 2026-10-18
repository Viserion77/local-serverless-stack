// Unit tests for cfn-physical-values.ts — what Ref / Fn::GetAtt on a resource
// return locally, and the function-environment pass built on it. Pure module:
// resources are hand-built the way the parser emits them and the runtime-only
// attributes (queue URL, stream ARN, secret ARN, collection) are injected.
import {
  physicalValue,
  createPhysicalResolver,
  emptyRuntimeAttributes,
  EnvironmentResolver,
  RuntimeAttributes,
} from '../../../src/server/services/cfn-physical-values';
import type { Resource, EventRuleResource } from '../../../src/server/services/cloudformation-parser';

const REGION = 'sa-east-1';

function runtime(): RuntimeAttributes {
  const attrs = emptyRuntimeAttributes();
  attrs.queueUrls.set('orders-jobs', 'http://localhost:14566/000000000000/orders-jobs');
  attrs.streamArns.set('orders', 'arn:aws:dynamodb:sa-east-1:000000000000:table/orders/stream/2026-01-01T00:00:00.000');
  attrs.secretArns.set('orders/db', 'arn:aws:secretsmanager:sa-east-1:000000000000:secret:orders/db-AbCdEf');
  attrs.collections.set('products', { id: 'col-1', arn: 'arn:aws:aoss:sa-east-1:000000000000:collection/col-1', endpoint: 'http://localhost:14566/_aoss/products' });
  return attrs;
}

const rule = (over: Partial<EventRuleResource>): EventRuleResource => ({
  type: 'event-rule', logicalId: 'Rule', name: 'on-order', enabled: true, targets: [], ...over,
});

const RESOURCES: Resource[] = [
  { type: 'lambda', logicalId: 'WorkerLambdaFunction', name: 'orders-dev-worker', handler: 'h', runtime: 'nodejs20.x', environment: {}, memorySize: 128, timeout: 6 },
  { type: 'dynamodb', logicalId: 'OrdersTable', name: 'orders', keySchema: [], attributeDefinitions: [], streamEnabled: true },
  { type: 'sqs', logicalId: 'JobsQueue', name: 'orders-jobs' },
  { type: 'sns', logicalId: 'Topic', name: 'orders-events' },
  { type: 's3', logicalId: 'Bucket', name: 'orders-uploads', notifications: [] },
  { type: 'secret', logicalId: 'DbSecret', name: 'orders/db', tags: [] },
  { type: 'eventbus', logicalId: 'Bus', name: 'orders-bus' },
  rule({ logicalId: 'Rule', eventBusRef: 'Bus' }),
  { type: 'opensearch', logicalId: 'Search', name: 'products' },
  { type: 'apigw-api', logicalId: 'HttpApi', name: 'api', cors: false },
  { type: 'ssm-parameter', logicalId: 'FlagParam', name: '/acme/orders/flag', parameterType: 'String', value: 'on', tags: [] },
];

describe('physicalValue', () => {
  const resolve = createPhysicalResolver(RESOURCES, { region: REGION, runtime: runtime() });

  it('answers AWS\'s documented Ref / GetAtt values per type', () => {
    expect(resolve('WorkerLambdaFunction')).toBe('orders-dev-worker');
    expect(resolve('WorkerLambdaFunction', 'Arn')).toBe('arn:aws:lambda:sa-east-1:000000000000:function:orders-dev-worker');

    expect(resolve('OrdersTable')).toBe('orders');
    expect(resolve('OrdersTable', 'Arn')).toBe('arn:aws:dynamodb:sa-east-1:000000000000:table/orders');
    expect(resolve('OrdersTable', 'StreamArn')).toBe('arn:aws:dynamodb:sa-east-1:000000000000:table/orders/stream/2026-01-01T00:00:00.000');

    expect(resolve('JobsQueue')).toBe('http://localhost:14566/000000000000/orders-jobs');
    expect(resolve('JobsQueue', 'QueueUrl')).toBe('http://localhost:14566/000000000000/orders-jobs');
    expect(resolve('JobsQueue', 'Arn')).toBe('arn:aws:sqs:sa-east-1:000000000000:orders-jobs');
    expect(resolve('JobsQueue', 'QueueName')).toBe('orders-jobs');

    expect(resolve('Topic')).toBe('arn:aws:sns:sa-east-1:000000000000:orders-events');
    expect(resolve('Topic', 'TopicArn')).toBe('arn:aws:sns:sa-east-1:000000000000:orders-events');
    expect(resolve('Topic', 'TopicName')).toBe('orders-events');

    expect(resolve('Bucket')).toBe('orders-uploads');
    expect(resolve('Bucket', 'Arn')).toBe('arn:aws:s3:::orders-uploads');
    expect(resolve('Bucket', 'DomainName')).toBe('orders-uploads.s3.amazonaws.com');
    expect(resolve('Bucket', 'RegionalDomainName')).toBe('orders-uploads.s3.sa-east-1.amazonaws.com');

    expect(resolve('DbSecret')).toBe('arn:aws:secretsmanager:sa-east-1:000000000000:secret:orders/db-AbCdEf');
    expect(resolve('DbSecret', 'Id')).toBe('arn:aws:secretsmanager:sa-east-1:000000000000:secret:orders/db-AbCdEf');

    expect(resolve('Bus')).toBe('orders-bus');
    expect(resolve('Bus', 'Name')).toBe('orders-bus');
    expect(resolve('Bus', 'Arn')).toBe('arn:aws:events:sa-east-1:000000000000:event-bus/orders-bus');

    expect(resolve('Rule')).toBe('on-order');
    expect(resolve('Rule', 'Arn')).toBe('arn:aws:events:sa-east-1:000000000000:rule/orders-bus/on-order');

    expect(resolve('FlagParam')).toBe('/acme/orders/flag');
    expect(resolve('FlagParam', 'Type')).toBe('String');
    expect(resolve('FlagParam', 'Value')).toBe('on');

    expect(resolve('Search')).toBe('col-1');
    expect(resolve('Search', 'Id')).toBe('col-1');
    expect(resolve('Search', 'Arn')).toBe('arn:aws:aoss:sa-east-1:000000000000:collection/col-1');
    expect(resolve('Search', 'CollectionEndpoint')).toBe('http://localhost:14566/_aoss/products');
  });

  it('returns undefined for what it cannot know', () => {
    expect(resolve('Nope')).toBeUndefined();
    expect(resolve('HttpApi')).toBeUndefined();
    expect(resolve('WorkerLambdaFunction', 'SnapStartResponse')).toBeUndefined();
    expect(resolve('DbSecret', 'Arn')).toBeUndefined();
    // Runtime-only attributes without a lookup.
    const bare = createPhysicalResolver(RESOURCES, { region: REGION });
    expect(bare('JobsQueue')).toBeUndefined();
    expect(bare('OrdersTable', 'StreamArn')).toBeUndefined();
    expect(bare('DbSecret')).toBeUndefined();
    expect(bare('Search')).toBeUndefined();
    // Resources without a logical id (event-source mappings) are not indexed.
    expect(createPhysicalResolver([{ type: 'event-source', functionName: 'f', eventSourceArn: 'a', enabled: true }], { region: REGION })('f')).toBeUndefined();
  });

  it('builds rule ARNs for the default bus, a bus ARN and a literal bus name', () => {
    const ctx = { region: REGION, accountId: '111111111111', partition: 'aws-cn' };
    expect(physicalValue(rule({}), 'Arn', ctx)).toBe('arn:aws-cn:events:sa-east-1:111111111111:rule/on-order');
    expect(physicalValue(rule({ eventBusRef: 'default' }), 'Arn', ctx)).toBe('arn:aws-cn:events:sa-east-1:111111111111:rule/on-order');
    expect(physicalValue(rule({ eventBusRef: 'arn:aws:events:sa-east-1:111111111111:event-bus/billing' }), 'Arn', ctx))
      .toBe('arn:aws-cn:events:sa-east-1:111111111111:rule/billing/on-order');
    expect(physicalValue(rule({ eventBusRef: 'arn:aws:events:sa-east-1:111111111111:event-bus/default' }), 'Arn', ctx))
      .toBe('arn:aws-cn:events:sa-east-1:111111111111:rule/on-order');
    expect(physicalValue(rule({ eventBusRef: 'shared' }), 'Arn', ctx)).toBe('arn:aws-cn:events:sa-east-1:111111111111:rule/shared/on-order');
  });
});

describe('EnvironmentResolver', () => {
  const template = {
    Parameters: { Stage: { Type: 'String', Default: 'dev' } },
    Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
  };

  function make(warnings: string[] = []) {
    return new EnvironmentResolver({
      template,
      region: REGION,
      stackName: 'orders-dev',
      resources: RESOURCES,
      runtime: runtime(),
      exports: new Map([['billing-dev-TableName', 'invoices']]),
      warnings,
    });
  }

  it('turns resource references into physical values', () => {
    const env = make().resolve({
      TABLE_NAME: { Ref: 'OrdersTable' },
      TABLE_ARN: { 'Fn::GetAtt': ['OrdersTable', 'Arn'] },
      STREAM_ARN: { 'Fn::GetAtt': 'OrdersTable.StreamArn' },
      QUEUE_URL: { Ref: 'JobsQueue' },
      QUEUE_ARN: { 'Fn::GetAtt': ['JobsQueue', 'Arn'] },
      TOPIC_ARN: { Ref: 'Topic' },
      SECRET_ARN: { Ref: 'DbSecret' },
      BUS: { Ref: 'Bus' },
      WORKER: { Ref: 'WorkerLambdaFunction' },
      JOINED: { 'Fn::Join': ['/', [{ Ref: 'AWS::Region' }, { Ref: 'Bucket' }]] },
      SUB: { 'Fn::Sub': '${JobsQueue.QueueName}-${Stage}' },
      BRANCH: { 'Fn::If': ['IsProd', 'prod-value', { Ref: 'OrdersTable' }] },
      IMPORTED: { 'Fn::ImportValue': 'billing-dev-TableName' },
      PLAIN: 'x',
      NUM: 3,
      BOOL: false,
      LIST: { 'Fn::Split': [',', 'a,b'] },
      NULLISH: null,
      GONE: { 'Fn::If': ['IsProd', 'x', { Ref: 'AWS::NoValue' }] },
    });
    expect(env).toEqual({
      TABLE_NAME: 'orders',
      TABLE_ARN: 'arn:aws:dynamodb:sa-east-1:000000000000:table/orders',
      STREAM_ARN: 'arn:aws:dynamodb:sa-east-1:000000000000:table/orders/stream/2026-01-01T00:00:00.000',
      QUEUE_URL: 'http://localhost:14566/000000000000/orders-jobs',
      QUEUE_ARN: 'arn:aws:sqs:sa-east-1:000000000000:orders-jobs',
      TOPIC_ARN: 'arn:aws:sns:sa-east-1:000000000000:orders-events',
      SECRET_ARN: 'arn:aws:secretsmanager:sa-east-1:000000000000:secret:orders/db-AbCdEf',
      BUS: 'orders-bus',
      WORKER: 'orders-dev-worker',
      JOINED: 'sa-east-1/orders-uploads',
      SUB: 'orders-jobs-dev',
      BRANCH: 'orders',
      IMPORTED: 'invoices',
      PLAIN: 'x',
      NUM: '3',
      BOOL: 'false',
      LIST: 'a,b',
    });
  });

  it('falls back to a recognizable string and warns once per distinct value', () => {
    const warnings: string[] = [];
    const resolver = make(warnings);
    const env = resolver.resolve({
      ROLE: { Ref: 'ExecRole' },
      ROLE_ARN: { 'Fn::GetAtt': ['ExecRole', 'Arn'] },
      DOTTED: { 'Fn::GetAtt': 'ExecRole.Arn' },
      OTHER: { 'Fn::ImportValue': 'unknown-export' },
      MIXED: [{ Ref: 'ExecRole' }],
    });
    // The same variable on another function adds no second warning.
    resolver.resolve({ ROLE: { Ref: 'ExecRole' } });
    expect(env).toEqual({
      ROLE: 'ExecRole',
      ROLE_ARN: 'ExecRole.Arn',
      DOTTED: 'ExecRole.Arn',
      OTHER: '{"Fn::ImportValue":"unknown-export"}',
      MIXED: '[{"Ref":"ExecRole"}]',
    });
    expect(warnings).toEqual([
      'Environment variable ROLE: {"Ref":"ExecRole"} could not be resolved to a physical value — set to "ExecRole".',
      'Environment variable ROLE_ARN: {"Fn::GetAtt":["ExecRole","Arn"]} could not be resolved to a physical value — set to "ExecRole.Arn".',
      'Environment variable DOTTED: {"Fn::GetAtt":"ExecRole.Arn"} could not be resolved to a physical value — set to "ExecRole.Arn".',
      'Environment variable OTHER: {"Fn::ImportValue":"unknown-export"} could not be resolved to a physical value — set to "{"Fn::ImportValue":"unknown-export"}".',
      'Environment variable MIXED: [{"Ref":"ExecRole"}] could not be resolved to a physical value — set to "[{"Ref":"ExecRole"}]".',
    ]);
  });

  it('resolveValue answers only fully concrete scalars', () => {
    const resolver = make();
    expect(resolver.resolveValue({ Ref: 'OrdersTable' })).toBe('orders');
    expect(resolver.resolveValue(5)).toBe('5');
    expect(resolver.resolveValue({ Ref: 'ExecRole' })).toBeUndefined();
    expect(resolver.resolveValue(['a'])).toBeUndefined();
  });

  it('defaults the region when none is given', () => {
    const resolver = new EnvironmentResolver({ template: {}, resources: RESOURCES, warnings: [] });
    expect(resolver.resolve({ ARN: { 'Fn::GetAtt': ['Topic', 'TopicArn'] } }))
      .toEqual({ ARN: 'arn:aws:sns:us-east-1:000000000000:orders-events' });
  });
});
