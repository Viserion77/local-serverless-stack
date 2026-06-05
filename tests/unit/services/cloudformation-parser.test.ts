// Unit tests for CloudFormationParser. Pure parser: no I/O, no mocking. We drive
// every AWS resource type plus the Ref/Fn::GetAtt resolution helpers and the
// defensive fallback branches by crafting templates with missing/odd fields,
// and exercise the real-world fixtures end-to-end.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  CloudFormationParser,
  LambdaResource,
  DynamoDBResource,
  SQSResource,
  SNSResource,
  S3Resource,
  EventSourceMapping,
} from '../../../src/server/services/cloudformation-parser';

const FIXTURE = path.resolve(__dirname, '../../fixtures/sample-cloudformation.json');
const SAMPLE = path.resolve(
  __dirname,
  '../../../examples/sample-microservice/.serverless/cloudformation-template-update-stack.json',
);

let parser: CloudFormationParser;

beforeEach(() => {
  parser = new CloudFormationParser();
});

describe('parse', () => {
  it('returns an empty array when the template has no Resources', () => {
    expect(parser.parse({} as never)).toEqual([]);
  });

  it('skips resources of unknown types (default switch arm returns null)', () => {
    const resources = parser.parse({
      Resources: {
        SomeRole: { Type: 'AWS::IAM::Role', Properties: {} },
        SomeLog: { Type: 'AWS::Logs::LogGroup', Properties: {} },
      },
    } as never);
    expect(resources).toEqual([]);
  });
});

describe('parseLambda', () => {
  it('parses an explicit lambda with all properties', () => {
    const [res] = parser.parse({
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: 'my-fn',
            Handler: 'index.handler',
            Runtime: 'nodejs18.x',
            Environment: { Variables: { A: '1' } },
            MemorySize: 512,
            Timeout: 15,
          },
        },
      },
    } as never) as LambdaResource[];
    expect(res).toEqual({
      type: 'lambda',
      logicalId: 'Fn',
      name: 'my-fn',
      handler: 'index.handler',
      runtime: 'nodejs18.x',
      environment: { A: '1' },
      memorySize: 512,
      timeout: 15,
    });
  });

  it('applies defaults when properties are missing', () => {
    const [res] = parser.parse({
      Resources: { Fn: { Type: 'AWS::Lambda::Function' } },
    } as never) as LambdaResource[];
    expect(res).toEqual({
      type: 'lambda',
      logicalId: 'Fn',
      name: 'Fn',
      handler: '',
      runtime: 'nodejs20.x',
      environment: {},
      memorySize: 128,
      timeout: 30,
    });
  });

  it('falls back to {} when Environment has no Variables', () => {
    const [res] = parser.parse({
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { Environment: {} } },
      },
    } as never) as LambdaResource[];
    expect(res.environment).toEqual({});
  });
});

describe('parseDynamoDB', () => {
  it('parses a table with GSI, LSI, billing and stream view type', () => {
    const [res] = parser.parse({
      Resources: {
        T: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {
            TableName: 'Orders',
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
            GlobalSecondaryIndexes: [
              {
                IndexName: 'gsi1',
                KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
                Projection: { ProjectionType: 'ALL' },
              },
            ],
            LocalSecondaryIndexes: [
              {
                IndexName: 'lsi1',
                KeySchema: [{ AttributeName: 'lk', KeyType: 'RANGE' }],
                Projection: { ProjectionType: 'KEYS_ONLY' },
              },
            ],
            StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
          },
        },
      },
    } as never) as DynamoDBResource[];
    expect(res.name).toBe('Orders');
    expect(res.billingMode).toBe('PAY_PER_REQUEST');
    expect(res.streamEnabled).toBe(true);
    expect(res.globalSecondaryIndexes).toHaveLength(1);
    expect(res.localSecondaryIndexes).toHaveLength(1);
  });

  it('treats StreamSpecification with only StreamEnabled as enabled', () => {
    const [res] = parser.parse({
      Resources: {
        T: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { StreamSpecification: { StreamEnabled: true } },
        },
      },
    } as never) as DynamoDBResource[];
    expect(res.streamEnabled).toBe(true);
  });

  it('treats StreamSpecification with neither field as disabled', () => {
    const [res] = parser.parse({
      Resources: {
        T: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { StreamSpecification: {} },
        },
      },
    } as never) as DynamoDBResource[];
    expect(res.streamEnabled).toBe(false);
  });

  it('applies defaults and disables streams when properties are missing', () => {
    const [res] = parser.parse({
      Resources: { T: { Type: 'AWS::DynamoDB::Table' } },
    } as never) as DynamoDBResource[];
    expect(res).toEqual({
      type: 'dynamodb',
      logicalId: 'T',
      name: 'T',
      keySchema: [],
      attributeDefinitions: [],
      billingMode: undefined,
      streamEnabled: false,
      globalSecondaryIndexes: undefined,
      localSecondaryIndexes: undefined,
    });
  });
});

describe('parseSQS', () => {
  it('parses a FIFO queue with all attributes', () => {
    const [res] = parser.parse({
      Resources: {
        Q: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: 'q.fifo',
            VisibilityTimeout: 60,
            MessageRetentionPeriod: 345600,
            FifoQueue: true,
            ContentBasedDeduplication: true,
          },
        },
      },
    } as never) as SQSResource[];
    expect(res).toEqual({
      type: 'sqs',
      logicalId: 'Q',
      name: 'q.fifo',
      visibilityTimeout: 60,
      messageRetentionPeriod: 345600,
      fifoQueue: true,
      contentBasedDeduplication: true,
    });
  });

  it('falls back to the logical id when QueueName is missing', () => {
    const [res] = parser.parse({
      Resources: { Q: { Type: 'AWS::SQS::Queue' } },
    } as never) as SQSResource[];
    expect(res.name).toBe('Q');
    expect(res.visibilityTimeout).toBeUndefined();
  });
});

describe('parseSNS', () => {
  it('parses a topic with a name', () => {
    const [res] = parser.parse({
      Resources: { T: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'evts' } } },
    } as never) as SNSResource[];
    expect(res).toEqual({ type: 'sns', logicalId: 'T', name: 'evts' });
  });

  it('falls back to the logical id when TopicName is missing', () => {
    const [res] = parser.parse({
      Resources: { T: { Type: 'AWS::SNS::Topic' } },
    } as never) as SNSResource[];
    expect(res.name).toBe('T');
  });
});

describe('parseS3', () => {
  it('skips the Serverless deployment bucket', () => {
    const resources = parser.parse({
      Resources: {
        ServerlessDeploymentBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    } as never);
    expect(resources).toEqual([]);
  });

  it('parses a bucket with versioning and a GetAtt notification with prefix/suffix', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: 'uploads',
            VersioningConfiguration: { Status: 'Enabled' },
            NotificationConfiguration: {
              LambdaConfigurations: [
                {
                  Event: 's3:ObjectCreated:*',
                  Function: { 'Fn::GetAtt': ['OnUploadLambdaFunction', 'Arn'] },
                  Filter: {
                    S3Key: {
                      Rules: [
                        { Name: 'Prefix', Value: 'incoming/' },
                        { Name: 'SUFFIX', Value: '.jpg' },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.name).toBe('uploads');
    expect(res.versioningEnabled).toBe(true);
    expect(res.notifications).toEqual([
      {
        functionRef: 'OnUploadLambdaFunction',
        events: ['s3:ObjectCreated:*'],
        filterPrefix: 'incoming/',
        filterSuffix: '.jpg',
      },
    ]);
  });

  it('handles an array Events field and a string Ref function', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            NotificationConfiguration: {
              LambdaConfigurations: [
                {
                  Events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
                  Function: { Ref: 'MyFn' },
                },
              ],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.name).toBe('B');
    expect(res.versioningEnabled).toBe(false);
    expect(res.notifications[0].functionRef).toBe('MyFn');
    expect(res.notifications[0].events).toEqual([
      's3:ObjectCreated:*',
      's3:ObjectRemoved:*',
    ]);
    expect(res.notifications[0].filterPrefix).toBeUndefined();
    expect(res.notifications[0].filterSuffix).toBeUndefined();
  });

  it('defaults the event when neither Event nor Events is present and Function is a plain string', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            NotificationConfiguration: {
              LambdaConfigurations: [{ Function: 'arn:aws:lambda:::function:fn' }],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.notifications[0].functionRef).toBe('arn:aws:lambda:::function:fn');
    expect(res.notifications[0].events).toEqual(['s3:ObjectCreated:*']);
  });

  it('skips notifications whose Function does not resolve to a name', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            NotificationConfiguration: {
              LambdaConfigurations: [
                { Event: 's3:ObjectCreated:*', Function: { Unknown: 'x' } },
                { Event: 's3:ObjectCreated:*' },
              ],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.notifications).toEqual([]);
  });

  it('ignores unrelated filter rule names', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            NotificationConfiguration: {
              LambdaConfigurations: [
                {
                  Function: { Ref: 'Fn' },
                  Filter: { S3Key: { Rules: [{ Value: 'x' }, { Name: 'other', Value: 'y' }] } },
                },
              ],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.notifications[0].filterPrefix).toBeUndefined();
    expect(res.notifications[0].filterSuffix).toBeUndefined();
  });

  it('handles a bucket with no Properties and no notifications', () => {
    const [res] = parser.parse({
      Resources: { B: { Type: 'AWS::S3::Bucket' } },
    } as never) as S3Resource[];
    expect(res).toEqual({
      type: 's3',
      logicalId: 'B',
      name: 'B',
      versioningEnabled: false,
      notifications: [],
    });
  });

  it('reports versioning disabled when Status is not Enabled', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: { VersioningConfiguration: { Status: 'Suspended' } },
        },
      },
    } as never) as S3Resource[];
    expect(res.versioningEnabled).toBe(false);
  });
});

describe('parseEventSource', () => {
  it('parses a GetAtt-based mapping with batch size', () => {
    const [res] = parser.parse({
      Resources: {
        M: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] },
            EventSourceArn: { 'Fn::GetAtt': ['OrdersTable', 'StreamArn'] },
            BatchSize: 10,
            Enabled: true,
          },
        },
      },
    } as never) as EventSourceMapping[];
    expect(res).toEqual({
      type: 'event-source',
      functionName: 'Fn',
      eventSourceArn: 'OrdersTable::StreamArn',
      batchSize: 10,
      enabled: true,
    });
  });

  it('treats Enabled === false as disabled', () => {
    const [res] = parser.parse({
      Resources: {
        M: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: { FunctionName: { Ref: 'Fn' }, Enabled: false },
        },
      },
    } as never) as EventSourceMapping[];
    expect(res.enabled).toBe(false);
    expect(res.functionName).toBe('Fn');
    expect(res.batchSize).toBeUndefined();
  });

  it('defaults enabled to true and resolves string ARNs/names when Properties is missing', () => {
    const [res] = parser.parse({
      Resources: { M: { Type: 'AWS::Lambda::EventSourceMapping' } },
    } as never) as EventSourceMapping[];
    expect(res).toEqual({
      type: 'event-source',
      functionName: '',
      eventSourceArn: '',
      batchSize: undefined,
      enabled: true,
    });
  });

  it('resolves plain string FunctionName and EventSourceArn', () => {
    const [res] = parser.parse({
      Resources: {
        M: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            FunctionName: 'literal-fn',
            EventSourceArn: 'arn:aws:sqs:::q',
          },
        },
      },
    } as never) as EventSourceMapping[];
    expect(res.functionName).toBe('literal-fn');
    expect(res.eventSourceArn).toBe('arn:aws:sqs:::q');
  });

  it('returns empty strings when refs are non-string, non-GetAtt objects', () => {
    const [res] = parser.parse({
      Resources: {
        M: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            FunctionName: { Some: 'thing' },
            EventSourceArn: { Other: 'thing' },
          },
        },
      },
    } as never) as EventSourceMapping[];
    expect(res.functionName).toBe('');
    expect(res.eventSourceArn).toBe('');
  });
});

describe('calculateHash', () => {
  it('produces a deterministic sha256 of the template JSON', () => {
    const template = { Resources: {} };
    const expected = crypto
      .createHash('sha256')
      .update(JSON.stringify(template))
      .digest('hex');
    expect(parser.calculateHash(template as never)).toBe(expected);
  });

  it('changes when the template changes', () => {
    const a = parser.calculateHash({ Resources: {} } as never);
    const b = parser.calculateHash({ Resources: { X: { Type: 'AWS::SNS::Topic' } } } as never);
    expect(a).not.toBe(b);
  });
});

describe('fixtures (end-to-end)', () => {
  it('parses the integration fixture template', () => {
    const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const resources = parser.parse(template);
    const types = resources.map((r) => r.type).sort();
    expect(types).toEqual(['dynamodb', 'event-source', 'lambda', 'sns', 'sqs', 'sqs'].sort());

    const ddb = resources.find((r) => r.type === 'dynamodb') as DynamoDBResource;
    expect(ddb.name).toBe('Test.Users');
    expect(ddb.streamEnabled).toBe(true);

    const mapping = resources.find((r) => r.type === 'event-source') as EventSourceMapping;
    expect(mapping.functionName).toBe('TestLambdaFunction');
    expect(mapping.eventSourceArn).toBe('TestSQSQueue::Arn');
  });

  it('parses the sample-microservice deploy template and skips the deployment bucket', () => {
    const template = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    const resources = parser.parse(template);

    // The Serverless deployment bucket must be dropped.
    expect(resources.some((r) => r.logicalId === 'ServerlessDeploymentBucket')).toBe(false);

    const lambdas = resources.filter((r) => r.type === 'lambda') as LambdaResource[];
    expect(lambdas).toHaveLength(9);
    expect(lambdas[0].memorySize).toBe(1024);
    expect(lambdas[0].timeout).toBe(6);

    const orders = resources.find(
      (r) => r.type === 'dynamodb' && r.logicalId === 'OrdersTable',
    ) as DynamoDBResource;
    expect(orders.streamEnabled).toBe(true);
    expect(orders.globalSecondaryIndexes).toHaveLength(1);

    const bucket = resources.find((r) => r.type === 's3') as S3Resource;
    expect(bucket.name).toBe('sample-microservice-uploads');
    expect(bucket.notifications[0].functionRef).toBe('OnUploadLambdaFunction');
    expect(bucket.notifications[0].filterPrefix).toBe('incoming/');

    const streamMapping = resources.find(
      (r) => r.type === 'event-source' && (r as EventSourceMapping).eventSourceArn.includes('StreamArn'),
    ) as EventSourceMapping;
    expect(streamMapping.functionName).toBe('OnOrderStreamLambdaFunction');
  });
});
