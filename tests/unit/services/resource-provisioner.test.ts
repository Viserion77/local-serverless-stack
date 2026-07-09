// Unit tests for ResourceProvisioner. Exemplar pattern: mockClient() patches each
// AWS SDK client prototype so the singleton's cached clients are intercepted.
// Singleton state (resourcesByLogicalId, currentRegion) is reset between tests.
// AdmZip runs for real when proxies are created.
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import {
  SQSClient,
  CreateQueueCommand,
  ListQueuesCommand,
  GetQueueAttributesCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';
import {
  SNSClient,
  CreateTopicCommand,
  ListTopicsCommand,
  DeleteTopicCommand,
} from '@aws-sdk/client-sns';
import {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
  DeleteBucketCommand,
  PutBucketVersioningCommand,
  PutBucketNotificationConfigurationCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  DeleteFunctionCommand,
  AddPermissionCommand,
  CreateEventSourceMappingCommand,
  ListEventSourceMappingsCommand,
  DeleteEventSourceMappingCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner';
import { ConfigManager } from '../../../src/server/services/config-manager';
import type {
  DynamoDBResource,
  SQSResource,
  SNSResource,
  S3Resource,
  EventSourceMapping,
  LambdaResource,
} from '../../../src/server/services/cloudformation-parser';

const dynamoMock = mockClient(DynamoDBClient);
const sqsMock = mockClient(SQSClient);
const snsMock = mockClient(SNSClient);
const s3Mock = mockClient(S3Client);
const lambdaMock = mockClient(LambdaClient);

let provisioner: ResourceProvisioner;

// Helper to build a named error with an SDK-style `.name`.
function namedError(name: string, message = name): Error {
  const e = new Error(message);
  (e as any).name = name;
  return e;
}

beforeEach(() => {
  dynamoMock.reset();
  sqsMock.reset();
  snsMock.reset();
  s3Mock.reset();
  lambdaMock.reset();
  provisioner = ResourceProvisioner.getInstance();
  (provisioner as any).resourcesByLogicalId.clear();
  (provisioner as any).currentRegion = 'us-east-1';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  dynamoMock.restore();
  sqsMock.restore();
  snsMock.restore();
  s3Mock.restore();
  lambdaMock.restore();
});

const dynamoResource = (over: Partial<DynamoDBResource> = {}): DynamoDBResource => ({
  type: 'dynamodb',
  logicalId: 'Orders',
  name: 'orders-table',
  keySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  attributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  billingMode: 'PAY_PER_REQUEST',
  ...over,
});

const sqsResource = (over: Partial<SQSResource> = {}): SQSResource => ({
  type: 'sqs',
  logicalId: 'OrderQueue',
  name: 'order-queue',
  ...over,
});

const snsResource = (over: Partial<SNSResource> = {}): SNSResource => ({
  type: 'sns',
  logicalId: 'OrderTopic',
  name: 'order-topic',
  ...over,
});

const s3Resource = (over: Partial<S3Resource> = {}): S3Resource => ({
  type: 's3',
  logicalId: 'Uploads',
  name: 'uploads-bucket',
  notifications: [],
  ...over,
});

const lambdaResource = (over: Partial<LambdaResource> = {}): LambdaResource => ({
  type: 'lambda',
  logicalId: 'ProcessOrderLambdaFunction',
  name: 'svc-dev-processOrder',
  handler: 'index.handler',
  runtime: 'nodejs20.x',
  environment: {},
  memorySize: 128,
  timeout: 30,
  ...over,
});

const eventSource = (over: Partial<EventSourceMapping> = {}): EventSourceMapping => ({
  type: 'event-source',
  functionName: 'ProcessOrderLambdaFunction',
  eventSourceArn: 'OrderQueue',
  enabled: true,
  ...over,
});

describe('getInstance / getters', () => {
  it('is a singleton', () => {
    expect(ResourceProvisioner.getInstance()).toBe(provisioner);
  });
  it('exposes the s3 client and current region', () => {
    expect(provisioner.getS3Client()).toBeDefined();
    expect(provisioner.getCurrentRegion()).toBe('us-east-1');
  });
});

describe('createDynamoDBTable (via provisionResources)', () => {
  it('creates a table, collecting GSI/LSI keys and adding missing attribute defs, with stream enabled', async () => {
    dynamoMock.on(CreateTableCommand).resolves({});
    const resource = dynamoResource({
      attributeDefinitions: undefined as any, // exercise `|| []` fallback
      streamEnabled: true,
      streamViewType: 'KEYS_ONLY',
      globalSecondaryIndexes: [
        { IndexName: 'gsi1', KeySchema: [{ AttributeName: 'gsiKey', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } },
      ],
      localSecondaryIndexes: [
        { IndexName: 'lsi1', KeySchema: [{ AttributeName: 'lsiKey', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
      ],
    });
    await provisioner.provisionResources('svc', [resource]);
    const input = dynamoMock.commandCalls(CreateTableCommand)[0].args[0].input as any;
    const attrNames = input.AttributeDefinitions.map((a: any) => a.AttributeName).sort();
    expect(attrNames).toEqual(['gsiKey', 'lsiKey', 'pk']);
    expect(input.StreamSpecification.StreamEnabled).toBe(true);
    expect(input.StreamSpecification.StreamViewType).toBe('KEYS_ONLY');
    expect(input.GlobalSecondaryIndexes).toBeDefined();
    expect(input.LocalSecondaryIndexes).toBeDefined();
  });

  it('defaults stream view type and applies enabled TTL after table creation', async () => {
    dynamoMock.on(CreateTableCommand).resolves({});
    dynamoMock.on(UpdateTimeToLiveCommand).resolves({});
    await provisioner.provisionResources('svc', [dynamoResource({
      streamEnabled: true,
      ttl: { attributeName: 'expiresAt', enabled: true },
    })]);
    const createInput = dynamoMock.commandCalls(CreateTableCommand)[0].args[0].input as any;
    const ttlInput = dynamoMock.commandCalls(UpdateTimeToLiveCommand)[0].args[0].input as any;
    expect(createInput.StreamSpecification.StreamViewType).toBe('NEW_AND_OLD_IMAGES');
    expect(ttlInput.TableName).toBe('orders-table');
    expect(ttlInput.TimeToLiveSpecification).toEqual({ AttributeName: 'expiresAt', Enabled: true });
  });

  it('applies disabled TTL to an existing table and treats already-disabled as steady state', async () => {
    dynamoMock.on(CreateTableCommand).rejects(namedError('ResourceInUseException'));
    dynamoMock.on(UpdateTimeToLiveCommand).rejects(new Error('TimeToLive is already disabled'));
    await provisioner.provisionResources('svc', [dynamoResource({
      ttl: { attributeName: 'ttl', enabled: false },
    })]);
    const ttlInput = dynamoMock.commandCalls(UpdateTimeToLiveCommand)[0].args[0].input as any;
    expect(ttlInput.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: false });
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Failed to update TTL'));
  });

  it('warns when applying TTL fails for a non-steady-state reason', async () => {
    dynamoMock.on(CreateTableCommand).resolves({});
    dynamoMock.on(UpdateTimeToLiveCommand).rejects(new Error('ttl down'));
    await provisioner.provisionResources('svc', [dynamoResource({
      ttl: { attributeName: 'ttl', enabled: true },
    })]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to update TTL'));
  });

  it('omits GSI/LSI/stream when none provided', async () => {
    dynamoMock.on(CreateTableCommand).resolves({});
    await provisioner.provisionResources('svc', [dynamoResource({ globalSecondaryIndexes: [], localSecondaryIndexes: [] })]);
    const input = dynamoMock.commandCalls(CreateTableCommand)[0].args[0].input as any;
    expect(input.GlobalSecondaryIndexes).toBeUndefined();
    expect(input.LocalSecondaryIndexes).toBeUndefined();
    expect(input.StreamSpecification).toBeUndefined();
  });

  it('handles index lists with no KeySchema field', async () => {
    dynamoMock.on(CreateTableCommand).resolves({});
    await provisioner.provisionResources('svc', [dynamoResource({
      globalSecondaryIndexes: [{ IndexName: 'gsi1', Projection: { ProjectionType: 'ALL' } } as any],
    })]);
    expect(dynamoMock.commandCalls(CreateTableCommand)).toHaveLength(1);
  });

  it('swallows ResourceInUseException (table already exists)', async () => {
    dynamoMock.on(CreateTableCommand).rejects(namedError('ResourceInUseException'));
    await provisioner.provisionResources('svc', [dynamoResource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('rethrows non-conflict errors and the outer catch logs them', async () => {
    dynamoMock.on(CreateTableCommand).rejects(new Error('boom'));
    await provisioner.provisionResources('svc', [dynamoResource()]);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to provision dynamodb:orders-table:',
      'boom',
    );
  });
});

describe('createSQSQueue (via provisionResources)', () => {
  it('creates a queue with all attributes (fifo + content dedup)', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    await provisioner.provisionResources('svc', [sqsResource({
      visibilityTimeout: 30,
      messageRetentionPeriod: 345600,
      fifoQueue: true,
      contentBasedDeduplication: true,
    })]);
    const input = sqsMock.commandCalls(CreateQueueCommand)[0].args[0].input as any;
    expect(input.Attributes).toMatchObject({
      VisibilityTimeout: '30',
      MessageRetentionPeriod: '345600',
      FifoQueue: 'true',
      ContentBasedDeduplication: 'true',
    });
  });

  it('creates a fifo queue without content dedup', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    await provisioner.provisionResources('svc', [sqsResource({ fifoQueue: true })]);
    const input = sqsMock.commandCalls(CreateQueueCommand)[0].args[0].input as any;
    expect(input.Attributes.ContentBasedDeduplication).toBeUndefined();
  });

  it('creates a queue with no attributes (undefined Attributes)', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    await provisioner.provisionResources('svc', [sqsResource()]);
    const input = sqsMock.commandCalls(CreateQueueCommand)[0].args[0].input as any;
    expect(input.Attributes).toBeUndefined();
  });

  it('swallows QueueAlreadyExists', async () => {
    sqsMock.on(CreateQueueCommand).rejects(namedError('QueueAlreadyExists'));
    await provisioner.provisionResources('svc', [sqsResource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('rethrows other SQS errors', async () => {
    sqsMock.on(CreateQueueCommand).rejects(new Error('sqs down'));
    await provisioner.provisionResources('svc', [sqsResource()]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('createSNSTopic (via provisionResources)', () => {
  it('creates a topic', async () => {
    snsMock.on(CreateTopicCommand).resolves({});
    await provisioner.provisionResources('svc', [snsResource()]);
    expect(snsMock.commandCalls(CreateTopicCommand)).toHaveLength(1);
  });

  it('swallows already-exists errors', async () => {
    snsMock.on(CreateTopicCommand).rejects(new Error('Topic already exists'));
    await provisioner.provisionResources('svc', [snsResource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('rethrows other SNS errors', async () => {
    snsMock.on(CreateTopicCommand).rejects(new Error('sns down'));
    await provisioner.provisionResources('svc', [snsResource()]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('createS3Bucket (via provisionResources)', () => {
  it('creates a bucket and enables versioning', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).resolves({});
    await provisioner.provisionResources('svc', [s3Resource({ versioningEnabled: true })]);
    expect(s3Mock.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
  });

  it('warns (but does not throw) when versioning fails', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketVersioningCommand).rejects(new Error('versioning failed'));
    await provisioner.provisionResources('svc', [s3Resource({ versioningEnabled: true })]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to enable versioning'));
  });

  it('warns with Unknown error fallback when versioning rejects a non-Error', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    // The SDK mock wraps thrown values in Error, so throw a genuine non-Error
    // straight from the client instance to hit the `: 'Unknown error'` arm.
    jest.spyOn((provisioner as any).s3Client, 'send').mockImplementation((cmd: any) => {
      if (cmd instanceof CreateBucketCommand) return Promise.resolve({});
      return Promise.reject('not-an-error');
    });
    await provisioner.provisionResources('svc', [s3Resource({ versioningEnabled: true })]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Unknown error'));
  });

  it('swallows BucketAlreadyOwnedByYou', async () => {
    s3Mock.on(CreateBucketCommand).rejects(namedError('BucketAlreadyOwnedByYou'));
    await provisioner.provisionResources('svc', [s3Resource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('swallows BucketAlreadyExists', async () => {
    s3Mock.on(CreateBucketCommand).rejects(namedError('BucketAlreadyExists'));
    await provisioner.provisionResources('svc', [s3Resource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('rethrows other S3 errors (and tolerates an error with no name)', async () => {
    s3Mock.on(CreateBucketCommand).rejects({ message: 'no name field' } as any);
    await provisioner.provisionResources('svc', [s3Resource()]);
    expect(console.error).toHaveBeenCalled();
  });

  it('rethrows when the error name is falsy (`error?.name || \'\'` fallback)', async () => {
    // Empty .name makes `error?.name` falsy → the `|| ''` fallback is taken.
    s3Mock.on(CreateBucketCommand).rejects(namedError('', 'boom'));
    await provisioner.provisionResources('svc', [s3Resource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to provision s3:uploads-bucket:', 'boom');
  });
});

describe('provisionResources orchestration', () => {
  it('reinitializes clients when region changes and resolves invokeUrl from invokePort', async () => {
    dynamoMock.on(CreateTableCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).rejects(namedError('ResourceNotFoundException'));
    lambdaMock.on(CreateFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: 'http://localhost:4566/000/order-queue' });
    sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000:order-queue' } });
    sqsMock.on(CreateQueueCommand).resolves({});

    await provisioner.provisionResources(
      'svc',
      [sqsResource({ logicalId: 'OrderQueue' }), lambdaResource(), eventSource()],
      { invokePort: 3002, region: 'eu-west-1' },
    );
    expect(provisioner.getCurrentRegion()).toBe('eu-west-1');
    const createFn = lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input as any;
    expect(createFn.Environment.Variables.INVOKE_URL).toBe('http://host.docker.internal:3002');
  });

  it('uses lambdaRuntime.invokeHost when deriving the default invokeUrl from invokePort', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getInvokeHost').mockReturnValue('172.19.0.1');
    lambdaMock.on(GetFunctionCommand).rejects(namedError('ResourceNotFoundException'));
    lambdaMock.on(CreateFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});

    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokePort: 13010 },
    );

    const createFn = lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input as any;
    expect(createFn.Environment.Variables.INVOKE_URL).toBe('http://172.19.0.1:13010');
  });

  it('does not reinitialize when region matches current', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    await provisioner.provisionResources('svc', [sqsResource()], { region: 'us-east-1' });
    expect(sqsMock.commandCalls(CreateQueueCommand)).toHaveLength(1);
  });

  it('skips resources without a logicalId when building the map', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    // event-source has no logicalId property
    await provisioner.provisionResources('svc', [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:x' })] as any);
    expect((provisioner as any).resourcesByLogicalId.size).toBe(0);
  });

  it('swallows ResourceConflictException in the event-source pass', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).rejects(namedError('ResourceConflictException'));
    await provisioner.provisionResources(
      'svc',
      [sqsResource(), eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:order-queue' })],
      { invokeUrl: 'http://host:3000' },
    );
    // No console.error for the event-source conflict
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to provision event-source'),
      expect.anything(),
    );
  });

  it('logs other event-source failures', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).rejects(new Error('list down'));
    await provisioner.provisionResources(
      'svc',
      [sqsResource(), eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:order-queue' })],
      { invokeUrl: 'http://host:3000' },
    );
    expect(console.error).toHaveBeenCalledWith(
      'Failed to provision event-source for ProcessOrderLambdaFunction:',
      'list down',
    );
  });

  it('logs event-source failures that are non-Error values (Unknown error)', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    // Throw a genuine non-Error from the lambda client so `error instanceof
    // Error` is false and the catch falls back to 'Unknown error'.
    jest.spyOn((provisioner as any).lambdaClient, 'send').mockImplementation((cmd: any) => {
      if (cmd instanceof GetFunctionCommand) return Promise.resolve({});
      return Promise.reject('weird-non-error');
    });
    await provisioner.provisionResources(
      'svc',
      [sqsResource(), eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:order-queue' })],
      { invokeUrl: 'http://host:3000' },
    );
    expect(console.error).toHaveBeenCalledWith(
      'Failed to provision event-source for ProcessOrderLambdaFunction:',
      'Unknown error',
    );
  });

  it('skips buckets without notifications and configures those that have them', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketNotificationConfigurationCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).resolves({});
    const withNotif = s3Resource({
      logicalId: 'Uploads',
      name: 'uploads-bucket',
      notifications: [{ functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'] }],
    });
    const without = s3Resource({ logicalId: 'Other', name: 'other-bucket', notifications: [] });
    await provisioner.provisionResources('svc', [withNotif, without, lambdaResource()], { invokeUrl: 'http://host:3000' });
    expect(s3Mock.commandCalls(PutBucketNotificationConfigurationCommand)).toHaveLength(1);
  });

  it('logs when S3 notification configuration throws', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).resolves({});
    s3Mock.on(PutBucketNotificationConfigurationCommand).rejects(new Error('notif down'));
    const withNotif = s3Resource({
      notifications: [{ functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'] }],
    });
    await provisioner.provisionResources('svc', [withNotif, lambdaResource()], { invokeUrl: 'http://host:3000' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to configure S3 notifications'),
      'notif down',
    );
  });

  it('logs S3 notification failures that are non-Error values (Unknown error)', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).resolves({});
    jest.spyOn((provisioner as any).s3Client, 'send').mockImplementation((cmd: any) => {
      if (cmd instanceof PutBucketNotificationConfigurationCommand) {
        return Promise.reject('not-an-error');
      }
      return Promise.resolve({});
    });
    const withNotif = s3Resource({
      notifications: [{ functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'] }],
    });
    await provisioner.provisionResources('svc', [withNotif, lambdaResource()], { invokeUrl: 'http://host:3000' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to configure S3 notifications'),
      'Unknown error',
    );
  });

  it('logs failure using functionName when the failing resource has no name', async () => {
    // Drive a non-conflict failure on an unknown resource shape — covered by
    // event-source not having `name`; reuse the dynamo path with a stripped name.
    dynamoMock.on(CreateTableCommand).rejects(new Error('boom'));
    const res = dynamoResource();
    delete (res as any).name;
    (res as any).functionName = 'fnFallback';
    await provisioner.provisionResources('svc', [res]);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to provision dynamodb:fnFallback:',
      'boom',
    );
  });
});

describe('configureS3Notifications filter rules and permission handling', () => {
  it('adds prefix and suffix filter rules', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketNotificationConfigurationCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).resolves({});
    const bucket = s3Resource({
      notifications: [
        { functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'], filterPrefix: 'in/', filterSuffix: '.jpg' },
      ],
    });
    await provisioner.provisionResources('svc', [bucket, lambdaResource()], { invokeUrl: 'http://host:3000' });
    const input = s3Mock.commandCalls(PutBucketNotificationConfigurationCommand)[0].args[0].input as any;
    const rules = input.NotificationConfiguration.LambdaFunctionConfigurations[0].Filter.Key.FilterRules;
    expect(rules).toEqual([
      { Name: 'prefix', Value: 'in/' },
      { Name: 'suffix', Value: '.jpg' },
    ]);
  });

  it('omits the Filter when there are no prefix/suffix rules', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketNotificationConfigurationCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).resolves({});
    const bucket = s3Resource({
      notifications: [{ functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'] }],
    });
    await provisioner.provisionResources('svc', [bucket, lambdaResource()], { invokeUrl: 'http://host:3000' });
    const input = s3Mock.commandCalls(PutBucketNotificationConfigurationCommand)[0].args[0].input as any;
    expect(input.NotificationConfiguration.LambdaFunctionConfigurations[0].Filter).toBeUndefined();
  });

  it('swallows AddPermission ResourceConflictException', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketNotificationConfigurationCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).rejects(namedError('ResourceConflictException'));
    const bucket = s3Resource({
      notifications: [{ functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'] }],
    });
    await provisioner.provisionResources('svc', [bucket, lambdaResource()], { invokeUrl: 'http://host:3000' });
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Could not add S3 invoke permission'));
  });

  it('warns when AddPermission fails for another reason', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketNotificationConfigurationCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).rejects(new Error('perm boom'));
    const bucket = s3Resource({
      notifications: [{ functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'] }],
    });
    await provisioner.provisionResources('svc', [bucket, lambdaResource()], { invokeUrl: 'http://host:3000' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not add S3 invoke permission'));
  });

  it('warns with the raw error when AddPermission rejects an object with no message', async () => {
    s3Mock.on(CreateBucketCommand).resolves({});
    s3Mock.on(PutBucketNotificationConfigurationCommand).resolves({});
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(AddPermissionCommand).rejects({ name: 'SomethingElse' } as any);
    const bucket = s3Resource({
      notifications: [{ functionRef: 'ProcessOrderLambdaFunction', events: ['s3:ObjectCreated:*'] }],
    });
    await provisioner.provisionResources('svc', [bucket, lambdaResource()], { invokeUrl: 'http://host:3000' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not add S3 invoke permission'));
  });
});

describe('resolveLambdaName / shortFunctionName (via createEventSourceMapping)', () => {
  it('uses the parsed lambda name when found in the logical-id map', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [
        lambdaResource({ logicalId: 'ProcessOrderLambdaFunction', name: 'svc-dev-processOrder' }),
        eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' }),
      ],
      { invokeUrl: 'http://host:3000' },
    );
    const input = lambdaMock.commandCalls(CreateEventSourceMappingCommand)[0].args[0].input as any;
    expect(input.FunctionName).toBe('svc-dev-processOrder');
  });

  it('falls back to ${service}-api-${shortName} when no lambda is parsed (LambdaFunction suffix stripped)', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({ functionName: 'ProcessOrderLambdaFunction', eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    const input = lambdaMock.commandCalls(CreateEventSourceMappingCommand)[0].args[0].input as any;
    expect(input.FunctionName).toBe('svc-api-processOrder');
  });

  it('falls back without stripping when the logical id lacks the LambdaFunction suffix', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({ functionName: 'PlainHandler', eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    const input = lambdaMock.commandCalls(CreateEventSourceMappingCommand)[0].args[0].input as any;
    expect(input.FunctionName).toBe('svc-api-plainHandler');
  });
});

describe('createEventSourceMapping', () => {
  it('returns early when a matching mapping already exists', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({
      EventSourceMappings: [{ EventSourceArn: 'arn:aws:sqs:us-east-1:000:OrderQueue', UUID: 'u1' }],
    });
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:OrderQueue' })],
      { invokeUrl: 'http://host:3000' },
    );
    expect(lambdaMock.commandCalls(CreateEventSourceMappingCommand)).toHaveLength(0);
  });

  it('sets StartingPosition for stream sources (dynamodb stream arn)', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({
        eventSourceArn: 'arn:aws:dynamodb:us-east-1:000:table/orders/stream/2024',
        batchSize: 50,
      })],
      { invokeUrl: 'http://host:3000' },
    );
    const input = lambdaMock.commandCalls(CreateEventSourceMappingCommand)[0].args[0].input as any;
    expect(input.StartingPosition).toBe('TRIM_HORIZON');
    expect(input.BatchSize).toBe(50);
  });

  it('applies CFN stream mapping fidelity fields and resolves OnFailure destinations', async () => {
    sqsMock.on(CreateQueueCommand).resolves({});
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: 'http://localhost:4566/000/relay-dlq' });
    sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000:relay-dlq' } });
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: { Environment: { Variables: { INVOKE_URL: 'http://host:3000' } } } });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});

    await provisioner.provisionResources(
      'svc',
      [
        sqsResource({ logicalId: 'RelayDlq', name: 'relay-dlq' }),
        eventSource({
          eventSourceArn: 'arn:aws:dynamodb:us-east-1:000:table/orders/stream/2024',
          startingPosition: 'LATEST',
          maximumRetryAttempts: 2,
          onFailureDestination: 'RelayDlq::Arn',
          maximumBatchingWindowInSeconds: 3,
          functionResponseTypes: ['ReportBatchItemFailures'],
          filterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
        }),
      ],
      { invokeUrl: 'http://host:3000' },
    );

    const input = lambdaMock.commandCalls(CreateEventSourceMappingCommand)[0].args[0].input as any;
    expect(input.StartingPosition).toBe('LATEST');
    expect(input.MaximumRetryAttempts).toBe(2);
    expect(input.DestinationConfig).toEqual({ OnFailure: { Destination: 'arn:aws:sqs:us-east-1:000:relay-dlq' } });
    expect(input.MaximumBatchingWindowInSeconds).toBe(3);
    expect(input.FunctionResponseTypes).toEqual(['ReportBatchItemFailures']);
    expect(input.FilterCriteria).toEqual({ Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] });
  });

  it('warns and continues when an OnFailure destination cannot be resolved', async () => {
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
    dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    lambdaMock.on(GetFunctionCommand).resolves({ Configuration: { Environment: { Variables: { INVOKE_URL: 'http://host:3000' } } } });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});

    await provisioner.provisionResources(
      'svc',
      [eventSource({
        eventSourceArn: 'arn:aws:dynamodb:us-east-1:000:table/orders/stream/2024',
        onFailureDestination: 'MissingDlq::Arn',
      })],
      { invokeUrl: 'http://host:3000' },
    );

    const input = lambdaMock.commandCalls(CreateEventSourceMappingCommand)[0].args[0].input as any;
    expect(input.DestinationConfig).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not resolve OnFailure destination'));
  });

  it('does not set StartingPosition for SQS sources and defaults batch size to 10', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    const input = lambdaMock.commandCalls(CreateEventSourceMappingCommand)[0].args[0].input as any;
    expect(input.StartingPosition).toBeUndefined();
    expect(input.BatchSize).toBe(10);
  });

  it('handles mappings list with undefined EventSourceMappings (optional chaining)', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({});
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    expect(lambdaMock.commandCalls(CreateEventSourceMappingCommand)).toHaveLength(1);
  });

  it('swallows ResourceConflictException thrown by CreateEventSourceMapping', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).rejects(namedError('ResourceConflictException'));
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    // swallowed inside createEventSourceMapping; no rethrow to outer
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Event source mapping already exists'));
  });
});

describe('ensureLambdaProxyExists', () => {
  it('short-circuits when the proxy function already exists with the expected invoke URL', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({
      Configuration: { Environment: { Variables: { INVOKE_URL: 'http://host:3000' } } },
    });
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    expect(lambdaMock.commandCalls(CreateFunctionCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)).toHaveLength(0);
  });

  it('updates a stale proxy INVOKE_URL without recreating the function', async () => {
    lambdaMock.on(GetFunctionCommand).resolves({
      Configuration: { Environment: { Variables: { INVOKE_URL: 'http://old-host:13010' } } },
    });
    lambdaMock.on(UpdateFunctionConfigurationCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://new-host:13010' },
    );
    expect(lambdaMock.commandCalls(CreateFunctionCommand)).toHaveLength(0);
    const input = lambdaMock.commandCalls(UpdateFunctionConfigurationCommand)[0].args[0].input as any;
    expect(input).toEqual({
      FunctionName: 'svc-api-processOrder',
      Environment: {
        Variables: {
          INVOKE_URL: 'http://new-host:13010',
          FUNCTION_NAME: 'svc-api-processOrder',
        },
      },
    });
  });

  it('creates the proxy (AdmZip runs) when GetFunction returns ResourceNotFoundException', async () => {
    lambdaMock.on(GetFunctionCommand).rejects(namedError('ResourceNotFoundException'));
    lambdaMock.on(CreateFunctionCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [] });
    lambdaMock.on(CreateEventSourceMappingCommand).resolves({});
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    const input = lambdaMock.commandCalls(CreateFunctionCommand)[0].args[0].input as any;
    expect(input.Code.ZipFile).toBeInstanceOf(Buffer);
    expect(input.Environment.Variables.INVOKE_URL).toBe('http://host:3000');
  });

  it('rethrows non-NotFound GetFunction errors (logged by event-source catch)', async () => {
    lambdaMock.on(GetFunctionCommand).rejects(namedError('AccessDenied', 'access denied'));
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      { invokeUrl: 'http://host:3000' },
    );
    expect(console.error).toHaveBeenCalledWith(
      'Failed to provision event-source for ProcessOrderLambdaFunction:',
      'access denied',
    );
  });

  it('throws when no invoke URL is configured (no invokePort/invokeUrl in metadata)', async () => {
    lambdaMock.on(GetFunctionCommand).rejects(namedError('ResourceNotFoundException'));
    await provisioner.provisionResources(
      'svc',
      [eventSource({ eventSourceArn: 'arn:aws:sqs:us-east-1:000:q' })],
      // no metadata → invokeUrl undefined
    );
    expect(console.error).toHaveBeenCalledWith(
      'Failed to provision event-source for ProcessOrderLambdaFunction:',
      expect.stringContaining('no invoke URL configured'),
    );
  });
});

describe('resolveEventSourceArn', () => {
  const callResolve = (arnRef: string) => (provisioner as any).resolveEventSourceArn(arnRef);

  it('returns full ARNs unchanged', async () => {
    await expect(callResolve('arn:aws:sqs:us-east-1:000:q')).resolves.toBe('arn:aws:sqs:us-east-1:000:q');
  });

  it('resolves a direct SQS resource via GetQueueUrl + attributes', async () => {
    (provisioner as any).resourcesByLogicalId.set('OrderQueue', sqsResource({ name: 'order-queue' }));
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: 'http://localhost:4566/000/order-queue' });
    sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000:order-queue' } });
    await expect(callResolve('OrderQueue::Arn')).resolves.toBe('arn:aws:sqs:us-east-1:000:order-queue');
  });

  it('falls through to legacy resolver when direct SQS has no QueueUrl', async () => {
    (provisioner as any).resourcesByLogicalId.set('OrderQueue', sqsResource({ name: 'order-queue' }));
    sqsMock.on(GetQueueUrlCommand).resolves({}); // no QueueUrl
    // legacy: ListQueues finds nothing, ListTables nothing, ListTopics nothing → throw
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
    dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    await expect(callResolve('OrderQueue')).rejects.toThrow('Event source not found');
  });

  it('falls through when direct SQS attributes have no QueueArn', async () => {
    (provisioner as any).resourcesByLogicalId.set('OrderQueue', sqsResource({ name: 'order-queue' }));
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: 'http://localhost:4566/000/order-queue' });
    // First call (direct path) has no QueueArn → fall through; legacy path's
    // GetQueueAttributes then returns the arn.
    sqsMock
      .on(GetQueueAttributesCommand)
      .resolvesOnce({ Attributes: {} })
      .resolves({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000:order-queue' } });
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: ['http://localhost:4566/000/order-queue'] });
    await expect(callResolve('OrderQueue')).resolves.toBe('arn:aws:sqs:us-east-1:000:order-queue');
  });

  it('catches direct SQS errors and falls through to the legacy resolver', async () => {
    (provisioner as any).resourcesByLogicalId.set('OrderQueue', sqsResource({ name: 'order-queue' }));
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('sqs down'));
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
    dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    await expect(callResolve('OrderQueue')).rejects.toThrow('Event source not found');
  });

  it('resolves a direct SNS resource to a crafted ARN', async () => {
    (provisioner as any).resourcesByLogicalId.set('OrderTopic', snsResource({ name: 'order-topic' }));
    await expect(callResolve('OrderTopic::Arn')).resolves.toBe('arn:aws:sns:us-east-1:000000000000:order-topic');
  });

  describe('direct DynamoDB stream (with fake timers for the 300ms retries)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('returns LatestStreamArn on the first describe', async () => {
      (provisioner as any).resourcesByLogicalId.set('Orders', dynamoResource({ name: 'orders-table' }));
      dynamoMock.on(DescribeTableCommand).resolves({ Table: { LatestStreamArn: 'arn:aws:dynamodb:us-east-1:000:table/orders/stream/2024' } });
      const p = callResolve('Orders::StreamArn');
      await jest.advanceTimersByTimeAsync(0);
      await expect(p).resolves.toBe('arn:aws:dynamodb:us-east-1:000:table/orders/stream/2024');
    });

    it('retries through the 300ms sleeps and resolves once the stream appears', async () => {
      (provisioner as any).resourcesByLogicalId.set('Orders', dynamoResource({ name: 'orders-table' }));
      dynamoMock
        .on(DescribeTableCommand)
        .resolvesOnce({ Table: {} }) // no stream arn yet
        .resolves({ Table: { LatestStreamArn: 'arn:aws:dynamodb:us-east-1:000:table/orders/stream/late' } });
      const p = callResolve('Orders');
      await jest.advanceTimersByTimeAsync(300);
      await expect(p).resolves.toBe('arn:aws:dynamodb:us-east-1:000:table/orders/stream/late');
    });

    it('retries when DescribeTable throws, then exhausts retries and hits the legacy throw', async () => {
      (provisioner as any).resourcesByLogicalId.set('Orders', dynamoResource({ name: 'orders-table' }));
      dynamoMock.on(DescribeTableCommand).rejects(new Error('still creating'));
      // legacy resolver finds nothing
      sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
      dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
      snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
      const p = callResolve('Orders').catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(5 * 300);
      const result = await p;
      expect((result as Error).message).toContain('Event source not found');
    });
  });

  describe('legacy fuzzy resolver', () => {
    it('matches a queue by kebab-cased logical id', async () => {
      sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: ['http://localhost:4566/000/order-queue'] });
      sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000:order-queue' } });
      await expect(callResolve('OrderQueue')).resolves.toBe('arn:aws:sqs:us-east-1:000:order-queue');
    });

    it('continues past a queue match with no QueueArn / undefined QueueUrls', async () => {
      sqsMock.on(ListQueuesCommand).resolves({}); // QueueUrls undefined → optional chain
      dynamoMock.on(ListTablesCommand).resolves({ TableNames: ['order-queue'] });
      dynamoMock.on(DescribeTableCommand).resolves({ Table: { LatestStreamArn: 'arn:aws:dynamodb:us-east-1:000:table/order-queue/stream/x' } });
      await expect(callResolve('OrderQueue')).resolves.toBe('arn:aws:dynamodb:us-east-1:000:table/order-queue/stream/x');
    });

    it('continues when a matching queue has empty QueueArn attribute', async () => {
      sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: ['http://localhost:4566/000/order-queue'] });
      sqsMock.on(GetQueueAttributesCommand).resolves({ Attributes: {} }); // no QueueArn
      dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
      snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
      await expect(callResolve('OrderQueue')).rejects.toThrow('Event source not found');
    });

    it('swallows a ListQueues error and continues to tables', async () => {
      sqsMock.on(ListQueuesCommand).rejects(new Error('sqs list down'));
      dynamoMock.on(ListTablesCommand).resolves({ TableNames: ['order-queue'] });
      dynamoMock.on(DescribeTableCommand).resolves({ Table: { LatestStreamArn: 'arn:aws:dynamodb:us-east-1:000:table/order-queue/stream/y' } });
      await expect(callResolve('OrderQueue')).resolves.toBe('arn:aws:dynamodb:us-east-1:000:table/order-queue/stream/y');
    });

    it('continues when a matched table has no stream arn', async () => {
      sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
      dynamoMock.on(ListTablesCommand).resolves({ TableNames: ['order-queue'] });
      dynamoMock.on(DescribeTableCommand).resolves({ Table: {} }); // no stream arn
      snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
      await expect(callResolve('OrderQueue')).rejects.toThrow('Event source not found');
    });

    it('handles undefined TableNames and swallows a ListTables error, then resolves via SNS', async () => {
      sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
      dynamoMock.on(ListTablesCommand).rejects(new Error('dynamo list down'));
      snsMock.on(ListTopicsCommand).resolves({
        Topics: [
          // No TopicArn comes first so the .find() callback evaluates the
          // `topic.TopicArn?.split(':').pop() || ''` nullish branch before the match.
          { /* no TopicArn → topicName fallback '' */ } as any,
          { TopicArn: 'arn:aws:sns:us-east-1:000:order-topic' },
        ],
      });
      await expect(callResolve('OrderTopic')).resolves.toBe('arn:aws:sns:us-east-1:000:order-topic');
    });

    it('swallows a ListTopics error and throws the terminal not-found', async () => {
      sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
      dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
      snsMock.on(ListTopicsCommand).rejects(new Error('sns list down'));
      await expect(callResolve('OrderQueue')).rejects.toThrow('Event source not found: OrderQueue (resolved as: order-queue)');
    });

    it('handles a topic whose arn has no matching kebab name (undefined Topics)', async () => {
      sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
      dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
      snsMock.on(ListTopicsCommand).resolves({}); // Topics undefined → optional chain
      await expect(callResolve('OrderQueue')).rejects.toThrow('Event source not found');
    });
  });
});

describe('listAllResources', () => {
  it('lists across all services using the cached clients for the current region', async () => {
    dynamoMock.on(ListTablesCommand).resolves({ TableNames: ['t1'] });
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: ['http://localhost:4566/000/q1'] });
    snsMock.on(ListTopicsCommand).resolves({ Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:000:topic1' }] });
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'b1' }] });
    const result = await provisioner.listAllResources();
    expect(result).toEqual({ tables: ['t1'], queues: ['q1'], topics: ['topic1'], buckets: ['b1'] });
  });

  it('builds fresh clients for a different region', async () => {
    dynamoMock.on(ListTablesCommand).resolves({ TableNames: [] });
    sqsMock.on(ListQueuesCommand).resolves({ QueueUrls: [] });
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] });
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [] });
    const result = await provisioner.listAllResources('eu-west-1');
    expect(result).toEqual({ tables: [], queues: [], topics: [], buckets: [] });
  });

  it('returns empty arrays for each list when the SDK calls fail or fields are missing', async () => {
    dynamoMock.on(ListTablesCommand).rejects(new Error('x'));
    sqsMock.on(ListQueuesCommand).rejects(new Error('x'));
    snsMock.on(ListTopicsCommand).rejects(new Error('x'));
    s3Mock.on(ListBucketsCommand).rejects(new Error('x'));
    expect(await provisioner.listAllResources()).toEqual({ tables: [], queues: [], topics: [], buckets: [] });
  });

  it('handles missing list fields (defensive || [] and filters)', async () => {
    dynamoMock.on(ListTablesCommand).resolves({}); // no TableNames
    sqsMock.on(ListQueuesCommand).resolves({}); // no QueueUrls
    snsMock.on(ListTopicsCommand).resolves({ Topics: [{ TopicArn: undefined }, { TopicArn: 'arn:aws:sns:us-east-1:000:keep' }] });
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: undefined }, { Name: 'keep' }] });
    const result = await provisioner.listAllResources();
    expect(result).toEqual({ tables: [], queues: [], topics: ['keep'], buckets: ['keep'] });
  });

  // Calling the private listers with no argument exercises the
  // `client = this.<client>` default-parameter branch and the `|| []`
  // fallback when the response omits the list field.
  it('list helpers default to the cached clients and fall back to [] for absent fields', async () => {
    dynamoMock.on(ListTablesCommand).resolves({});
    sqsMock.on(ListQueuesCommand).resolves({});
    snsMock.on(ListTopicsCommand).resolves({}); // no Topics → `|| []`
    s3Mock.on(ListBucketsCommand).resolves({}); // no Buckets → `|| []`
    const p = provisioner as any;
    expect(await p.listDynamoDBTables()).toEqual([]);
    expect(await p.listSQSQueues()).toEqual([]);
    expect(await p.listSNSTopics()).toEqual([]);
    expect(await p.listS3Buckets()).toEqual([]);
  });
});

describe('cleanupResources', () => {
  it('logs and returns early when there are no resources', async () => {
    await provisioner.cleanupResources('svc', []);
    expect(console.log).toHaveBeenCalledWith('No resources to clean up for svc');
    await provisioner.cleanupResources('svc', undefined as any);
    expect(console.log).toHaveBeenCalledWith('No resources to clean up for svc');
  });

  it('cleans up all resource types', async () => {
    dynamoMock.on(DeleteTableCommand).resolves({});
    sqsMock.on(GetQueueUrlCommand).resolves({ QueueUrl: 'http://localhost:4566/000/order-queue' });
    sqsMock.on(DeleteQueueCommand).resolves({});
    snsMock.on(ListTopicsCommand).resolves({ Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:000:order-topic' }] });
    snsMock.on(DeleteTopicCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'k1' }] });
    s3Mock.on(DeleteObjectCommand).resolves({});
    s3Mock.on(DeleteBucketCommand).resolves({});
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [{ UUID: 'u1' }] });
    lambdaMock.on(DeleteEventSourceMappingCommand).resolves({});
    lambdaMock.on(DeleteFunctionCommand).resolves({});

    await provisioner.cleanupResources('svc', [
      dynamoResource(),
      sqsResource(),
      snsResource(),
      s3Resource(),
      eventSource(),
    ]);
    expect(console.log).toHaveBeenCalledWith('✅ Cleaned up 5 resources for svc');
  });

  it('logs cleanup failures (using functionName for event-source and Unknown error for non-Error)', async () => {
    dynamoMock.on(DeleteTableCommand).rejects(new Error('delete failed'));
    // Genuine non-Error from the lambda client → 'Unknown error' fallback.
    jest.spyOn((provisioner as any).lambdaClient, 'send').mockRejectedValue('weird-non-error');
    await provisioner.cleanupResources('svc', [dynamoResource(), eventSource()]);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to cleanup dynamodb:orders-table:',
      'delete failed',
    );
    expect(console.error).toHaveBeenCalledWith(
      'Failed to cleanup event-source:ProcessOrderLambdaFunction:',
      'Unknown error',
    );
  });
});

describe('delete helpers (via cleanupResources)', () => {
  it('deleteDynamoDBTable swallows ResourceNotFoundException', async () => {
    dynamoMock.on(DeleteTableCommand).rejects(new Error('ResourceNotFoundException: gone'));
    await provisioner.cleanupResources('svc', [dynamoResource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('deleteSQSQueue swallows NonExistentQueue and returns when no QueueUrl', async () => {
    sqsMock.on(GetQueueUrlCommand).resolves({}); // no QueueUrl → skip delete
    await provisioner.cleanupResources('svc', [sqsResource()]);
    expect(sqsMock.commandCalls(DeleteQueueCommand)).toHaveLength(0);

    sqsMock.reset();
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('NonExistentQueue'));
    await provisioner.cleanupResources('svc', [sqsResource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('deleteSQSQueue rethrows non-NonExistentQueue errors', async () => {
    sqsMock.on(GetQueueUrlCommand).rejects(new Error('some other failure'));
    await provisioner.cleanupResources('svc', [sqsResource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to cleanup sqs:order-queue:', 'some other failure');
  });

  it('deleteS3Bucket drains objects (skipping keyless), swallows NoSuchBucket', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'k1' }, { Key: undefined }] });
    s3Mock.on(DeleteObjectCommand).resolves({});
    s3Mock.on(DeleteBucketCommand).resolves({});
    await provisioner.cleanupResources('svc', [s3Resource()]);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);

    s3Mock.reset();
    s3Mock.on(ListObjectsV2Command).resolves({}); // no Contents → `|| []`
    s3Mock.on(DeleteBucketCommand).rejects(new Error('NoSuchBucket'));
    await provisioner.cleanupResources('svc', [s3Resource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('deleteS3Bucket rethrows other errors', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    s3Mock.on(DeleteBucketCommand).rejects(new Error('AccessDenied'));
    await provisioner.cleanupResources('svc', [s3Resource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to cleanup s3:uploads-bucket:', 'AccessDenied');
  });

  it('deleteSNSTopic finds and deletes the topic, swallows NotFound, and no-ops when missing', async () => {
    snsMock.on(ListTopicsCommand).resolves({ Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:000:order-topic' }] });
    snsMock.on(DeleteTopicCommand).resolves({});
    await provisioner.cleanupResources('svc', [snsResource()]);
    expect(snsMock.commandCalls(DeleteTopicCommand)).toHaveLength(1);

    snsMock.reset();
    snsMock.on(ListTopicsCommand).resolves({ Topics: [] }); // no match → no delete
    await provisioner.cleanupResources('svc', [snsResource()]);
    expect(snsMock.commandCalls(DeleteTopicCommand)).toHaveLength(0);

    snsMock.reset();
    snsMock.on(ListTopicsCommand).rejects(new Error('NotFound'));
    await provisioner.cleanupResources('svc', [snsResource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('deleteSNSTopic rethrows other errors', async () => {
    snsMock.on(ListTopicsCommand).rejects(new Error('Throttled'));
    await provisioner.cleanupResources('svc', [snsResource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to cleanup sns:order-topic:', 'Throttled');
  });

  it('deleteEventSourceMapping deletes mappings (skipping UUID-less ones) and the proxy, swallows ResourceNotFoundException', async () => {
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({ EventSourceMappings: [{ UUID: 'u1' }, { /* no UUID */ }] });
    lambdaMock.on(DeleteEventSourceMappingCommand).resolves({});
    lambdaMock.on(DeleteFunctionCommand).resolves({});
    await provisioner.cleanupResources('svc', [eventSource()]);
    expect(lambdaMock.commandCalls(DeleteEventSourceMappingCommand)).toHaveLength(1);

    lambdaMock.reset();
    lambdaMock.on(ListEventSourceMappingsCommand).resolves({}); // no mappings → `|| []`
    lambdaMock.on(DeleteFunctionCommand).rejects(new Error('ResourceNotFoundException'));
    await provisioner.cleanupResources('svc', [eventSource()]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('deleteEventSourceMapping rethrows other errors', async () => {
    lambdaMock.on(ListEventSourceMappingsCommand).rejects(new Error('Throttled'));
    await provisioner.cleanupResources('svc', [eventSource()]);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to cleanup event-source:ProcessOrderLambdaFunction:',
      'Throttled',
    );
  });
});

describe('defensive branches (non-Error rejections and crafted inputs)', () => {
  it('createDynamoDBTable: non-Error rejection skips the ResourceInUseException check and rethrows', async () => {
    // The SDK mock wraps thrown values; throw a genuine non-Error from the
    // client instance so `error instanceof Error` is false → errorName ''.
    jest.spyOn((provisioner as any).dynamoClient, 'send').mockRejectedValue('non-error');
    await provisioner.provisionResources('svc', [dynamoResource()]);
    // Rethrown to the outer provision catch; message?.includes guards on undefined.
    expect(console.error).toHaveBeenCalledWith('Failed to provision dynamodb:orders-table:', undefined);
  });

  it('configureS3Notifications returns early when no lambda configurations are produced', async () => {
    // Called directly with an empty notifications array → lambdaConfigurations
    // stays empty → early return before PutBucketNotificationConfiguration.
    await (provisioner as any).configureS3Notifications('svc', s3Resource({ notifications: [] }), 'http://host:3000');
    expect(s3Mock.commandCalls(PutBucketNotificationConfigurationCommand)).toHaveLength(0);
  });

  it('delete helpers fall back to \'Unknown error\' on non-Error rejections and rethrow', async () => {
    // DynamoDB
    jest.spyOn((provisioner as any).dynamoClient, 'send').mockRejectedValue('nope');
    await provisioner.cleanupResources('svc', [dynamoResource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to cleanup dynamodb:orders-table:', 'Unknown error');

    // SQS
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn((provisioner as any).sqsClient, 'send').mockRejectedValue('nope');
    await provisioner.cleanupResources('svc', [sqsResource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to cleanup sqs:order-queue:', 'Unknown error');

    // S3
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn((provisioner as any).s3Client, 'send').mockRejectedValue('nope');
    await provisioner.cleanupResources('svc', [s3Resource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to cleanup s3:uploads-bucket:', 'Unknown error');

    // SNS
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn((provisioner as any).snsClient, 'send').mockRejectedValue('nope');
    await provisioner.cleanupResources('svc', [snsResource()]);
    expect(console.error).toHaveBeenCalledWith('Failed to cleanup sns:order-topic:', 'Unknown error');
  });
});
