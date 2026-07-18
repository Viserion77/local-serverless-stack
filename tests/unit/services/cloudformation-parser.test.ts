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
  SecretsManagerResource,
  EventBusResource,
  EventRuleResource,
  OpenSearchCollectionResource,
  EventSourceMapping,
  ApiResource,
  ApiIntegrationResource,
  ApiRouteResource,
  ApiAuthorizerResource,
  LambdaPermissionResource,
  ArnResolutionContext,
} from '../../../src/server/services/cloudformation-parser';

const APIGW_RAW = path.resolve(__dirname, '../../fixtures/apigw-raw-template.json');

// A resolver context whose same-template Lambda map + region drive resolveArnLike.
function ctxWith(overrides: Partial<ArnResolutionContext> = {}): ArnResolutionContext {
  return {
    region: 'sa-east-1',
    accountId: '000000000000',
    partition: 'aws',
    lambdas: new Map(),
    ...overrides,
  };
}

function lambdaResource(logicalId: string, name: string): LambdaResource {
  return { type: 'lambda', logicalId, name, handler: '', runtime: 'nodejs20.x', environment: {}, memorySize: 128, timeout: 30 };
}

const FIXTURE = path.resolve(__dirname, '../../fixtures/sample-cloudformation.json');
// A committed snapshot of the sample-microservice deploy template. We do NOT read
// tests/integration/fixtures/sample-microservice/.serverless/ directly because that
// dir is gitignored and absent on a fresh CI checkout.
const SAMPLE = path.resolve(__dirname, '../../fixtures/sample-microservice-template.json');

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
    expect(res.streamViewType).toBe('NEW_AND_OLD_IMAGES');
    expect(res.globalSecondaryIndexes).toHaveLength(1);
    expect(res.localSecondaryIndexes).toHaveLength(1);
  });

  it('parses TimeToLiveSpecification enabled and disabled variants', () => {
    const resources = parser.parse({
      Resources: {
        EnabledTtl: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } },
        },
        DisabledTtl: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: false } },
        },
      },
    } as never) as DynamoDBResource[];
    expect(resources[0].ttl).toEqual({ attributeName: 'expiresAt', enabled: true });
    expect(resources[1].ttl).toEqual({ attributeName: 'ttl', enabled: false });
  });

  it('ignores TimeToLiveSpecification without an AttributeName', () => {
    const [res] = parser.parse({
      Resources: {
        T: {
          Type: 'AWS::DynamoDB::Table',
          Properties: { TimeToLiveSpecification: { Enabled: true } },
        },
      },
    } as never) as DynamoDBResource[];
    expect(res.ttl).toBeUndefined();
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
    expect(res.redrivePolicy).toBeUndefined();
  });

  const withRedrive = (RedrivePolicy: unknown): SQSResource =>
    (parser.parse({
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q', RedrivePolicy } } },
    } as never) as SQSResource[])[0];

  it('carries RedrivePolicy with an Fn::GetAtt dead-letter target', () => {
    expect(
      withRedrive({ deadLetterTargetArn: { 'Fn::GetAtt': ['OrdersDlq', 'Arn'] }, maxReceiveCount: 3 })
        .redrivePolicy,
    ).toEqual({ deadLetterTargetRef: 'OrdersDlq::Arn', maxReceiveCount: 3 });
  });

  it('carries RedrivePolicy with a literal ARN and a stringified maxReceiveCount', () => {
    expect(
      withRedrive({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:dlq', maxReceiveCount: '2' })
        .redrivePolicy,
    ).toEqual({ deadLetterTargetRef: 'arn:aws:sqs:us-east-1:000000000000:dlq', maxReceiveCount: 2 });
  });

  it('drops a RedrivePolicy it cannot make sense of', () => {
    expect(withRedrive(undefined).redrivePolicy).toBeUndefined();
    expect(withRedrive('a string').redrivePolicy).toBeUndefined();
    expect(withRedrive({ maxReceiveCount: 3 }).redrivePolicy).toBeUndefined();
    // Ref on a queue yields its URL, not an ARN — extractArn refuses it.
    expect(withRedrive({ deadLetterTargetArn: { Ref: 'Dlq' }, maxReceiveCount: 3 }).redrivePolicy)
      .toBeUndefined();
    expect(withRedrive({ deadLetterTargetArn: 'arn:x' }).redrivePolicy).toBeUndefined();
    expect(withRedrive({ deadLetterTargetArn: 'arn:x', maxReceiveCount: 0 }).redrivePolicy)
      .toBeUndefined();
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

  it('lifts CorsConfiguration.CorsRules into corsRules with mapped SDK member names', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            CorsConfiguration: {
              CorsRules: [
                {
                  Id: 'receipts-cors',
                  AllowedOrigins: ['https://receipts.example.com'],
                  AllowedMethods: ['GET', 'PUT', 'POST'],
                  AllowedHeaders: ['*'],
                  ExposedHeaders: ['ETag'],
                  MaxAge: 600,
                },
              ],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.corsRules).toEqual([
      {
        id: 'receipts-cors',
        allowedOrigins: ['https://receipts.example.com'],
        allowedMethods: ['GET', 'PUT', 'POST'],
        allowedHeaders: ['*'],
        exposeHeaders: ['ETag'],
        maxAgeSeconds: 600,
      },
    ]);
  });

  it('accepts ExposeHeaders and MaxAgeSeconds (SDK spellings) equivalently and preserves MaxAge:0', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            CorsConfiguration: {
              CorsRules: [
                {
                  AllowedOrigins: ['*'],
                  AllowedMethods: ['GET'],
                  ExposeHeaders: ['x-amz-request-id'],
                  MaxAgeSeconds: 0,
                },
              ],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.corsRules).toEqual([
      {
        allowedOrigins: ['*'],
        allowedMethods: ['GET'],
        allowedHeaders: [],
        exposeHeaders: ['x-amz-request-id'],
        maxAgeSeconds: 0,
      },
    ]);
  });

  it('defaults allowedHeaders/exposeHeaders to [] and leaves maxAgeSeconds undefined when absent', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            CorsConfiguration: {
              CorsRules: [{ AllowedOrigins: ['https://a.example.com'], AllowedMethods: ['PUT'] }],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.corsRules).toEqual([
      {
        allowedOrigins: ['https://a.example.com'],
        allowedMethods: ['PUT'],
        allowedHeaders: [],
        exposeHeaders: [],
      },
    ]);
    expect(res.corsRules![0].maxAgeSeconds).toBeUndefined();
  });

  it('skips CorsRules missing AllowedMethods or AllowedOrigins (both AWS-required)', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            CorsConfiguration: {
              CorsRules: [
                { AllowedOrigins: ['*'] }, // no methods → dropped
                { AllowedMethods: ['GET'] }, // no origins → dropped
                { AllowedOrigins: ['*'], AllowedMethods: ['GET'] }, // valid
              ],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.corsRules).toHaveLength(1);
    expect(res.corsRules![0].allowedMethods).toEqual(['GET']);
  });

  it('coerces a bare-string AllowedMethods/AllowedOrigins into single-element arrays', () => {
    const [res] = parser.parse({
      Resources: {
        B: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            CorsConfiguration: {
              CorsRules: [{ AllowedOrigins: 'https://x.example.com', AllowedMethods: 'GET' }],
            },
          },
        },
      },
    } as never) as S3Resource[];
    expect(res.corsRules).toEqual([
      {
        allowedOrigins: ['https://x.example.com'],
        allowedMethods: ['GET'],
        allowedHeaders: [],
        exposeHeaders: [],
      },
    ]);
  });

  it('assigns NO corsRules key for a bucket with no CorsConfiguration', () => {
    const [res] = parser.parse({
      Resources: {
        B: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'plain' } },
      },
    } as never) as S3Resource[];
    expect(res).not.toHaveProperty('corsRules');
  });
});

describe('parseSecret', () => {
  it('parses a SecretString secret with name/description/kmsKeyId/tags', () => {
    const [res] = parser.parse({
      Resources: {
        SigningKey: {
          Type: 'AWS::SecretsManager::Secret',
          Properties: {
            Name: 's7/identity/jwt-signing-key',
            Description: 'JWT signing key',
            KmsKeyId: 'alias/aws/secretsmanager',
            SecretString: '{"key":"dev-signing-secret"}',
            Tags: [{ Key: 'team', Value: 'identity' }],
          },
        },
      },
    } as never) as SecretsManagerResource[];
    expect(res).toEqual({
      type: 'secret',
      logicalId: 'SigningKey',
      name: 's7/identity/jwt-signing-key',
      description: 'JWT signing key',
      kmsKeyId: 'alias/aws/secretsmanager',
      secretString: '{"key":"dev-signing-secret"}',
      tags: [{ Key: 'team', Value: 'identity' }],
    });
  });

  it('coerces tag entries missing Key or Value to empty strings', () => {
    const [res] = parser.parse({
      Resources: {
        DbSecret: {
          Type: 'AWS::SecretsManager::Secret',
          Properties: { Tags: [{}, { Key: 'only-key' }, { Value: 'only-value' }] },
        },
      },
    } as never) as SecretsManagerResource[];
    expect(res.tags).toEqual([
      { Key: '', Value: '' },
      { Key: 'only-key', Value: '' },
      { Key: '', Value: 'only-value' },
    ]);
  });

  it('falls back to the logical id when Name is absent and defaults tags to []', () => {
    const [res] = parser.parse({
      Resources: {
        DbSecret: { Type: 'AWS::SecretsManager::Secret' },
      },
    } as never) as SecretsManagerResource[];
    expect(res.name).toBe('DbSecret');
    expect(res.tags).toEqual([]);
    expect(res.secretString).toBeUndefined();
    expect(res.generateSecretString).toBeUndefined();
  });

  it('coerces missing tag Key/Value to empty strings', () => {
    const [res] = parser.parse({
      Resources: {
        S: {
          Type: 'AWS::SecretsManager::Secret',
          Properties: { Tags: [{ Value: 'v-only' }, { Key: 'k-only' }] },
        },
      },
    } as never) as SecretsManagerResource[];
    expect(res.tags).toEqual([
      { Key: '', Value: 'v-only' },
      { Key: 'k-only', Value: '' },
    ]);
  });

  it('preserves GenerateSecretString fields verbatim (no password generated at parse time)', () => {
    const [res] = parser.parse({
      Resources: {
        DbSecret: {
          Type: 'AWS::SecretsManager::Secret',
          Properties: {
            GenerateSecretString: {
              SecretStringTemplate: '{"username":"admin"}',
              GenerateStringKey: 'password',
              PasswordLength: 24,
              ExcludeCharacters: '"@/\\',
              ExcludePunctuation: true,
            },
          },
        },
      },
    } as never) as SecretsManagerResource[];
    expect(res.secretString).toBeUndefined();
    expect(res.generateSecretString).toMatchObject({
      secretStringTemplate: '{"username":"admin"}',
      generateStringKey: 'password',
      passwordLength: 24,
      excludeCharacters: '"@/\\',
      excludePunctuation: true,
    });
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

  it('parses full EventSourceMapping fidelity fields', () => {
    const [res] = parser.parse({
      Resources: {
        M: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            FunctionName: { Ref: 'StreamRelayLambdaFunction' },
            EventSourceArn: { 'Fn::GetAtt': ['IdentityTable', 'StreamArn'] },
            BatchSize: 1,
            Enabled: true,
            StartingPosition: 'LATEST',
            MaximumRetryAttempts: 2,
            DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': ['RelayDlq', 'Arn'] } } },
            MaximumBatchingWindowInSeconds: 3,
            FunctionResponseTypes: ['ReportBatchItemFailures'],
            FilterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
          },
        },
      },
    } as never) as EventSourceMapping[];
    expect(res).toEqual({
      type: 'event-source',
      functionName: 'StreamRelayLambdaFunction',
      eventSourceArn: 'IdentityTable::StreamArn',
      batchSize: 1,
      enabled: true,
      startingPosition: 'LATEST',
      maximumRetryAttempts: 2,
      onFailureDestination: 'RelayDlq::Arn',
      maximumBatchingWindowInSeconds: 3,
      functionResponseTypes: ['ReportBatchItemFailures'],
      filterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
    });
  });

  it('omits optional EventSourceMapping fields that do not resolve', () => {
    const [res] = parser.parse({
      Resources: {
        M: {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            FunctionName: { Ref: 'Fn' },
            DestinationConfig: { OnFailure: { Destination: { Ref: 'UnsupportedRef' } } },
            FunctionResponseTypes: 'ReportBatchItemFailures',
          },
        },
      },
    } as never) as EventSourceMapping[];
    expect(res.onFailureDestination).toBeUndefined();
    expect(res.functionResponseTypes).toBeUndefined();
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

describe('parseEventBus', () => {
  it('parses an explicit bus name', () => {
    const [res] = parser.parse({
      Resources: {
        SharedBus: {
          Type: 'AWS::Events::EventBus',
          Properties: { Name: 'domain-events' },
        },
      },
    } as never) as EventBusResource[];
    expect(res).toEqual({ type: 'eventbus', logicalId: 'SharedBus', name: 'domain-events' });
  });

  it('falls back to the logical id when Name is missing', () => {
    const [res] = parser.parse({
      Resources: {
        SharedBus: { Type: 'AWS::Events::EventBus', Properties: {} },
      },
    } as never) as EventBusResource[];
    expect(res.name).toBe('SharedBus');
  });

  it('tolerates a bus with no Properties at all', () => {
    const [res] = parser.parse({
      Resources: {
        SharedBus: { Type: 'AWS::Events::EventBus' },
      },
    } as never) as EventBusResource[];
    expect(res).toEqual({ type: 'eventbus', logicalId: 'SharedBus', name: 'SharedBus' });
  });
});

describe('parseEventRule', () => {
  it('tolerates a rule with no Properties at all (no bus, no pattern, no targets)', () => {
    const [res] = parser.parse({
      Resources: {
        BareRule: { Type: 'AWS::Events::Rule' },
      },
    } as never) as EventRuleResource[];
    expect(res).toEqual({
      type: 'event-rule',
      logicalId: 'BareRule',
      name: 'BareRule',
      enabled: true,
      targets: [],
    });
  });

  it('parses pattern, bus Ref, state and lambda targets', () => {
    const [res] = parser.parse({
      Resources: {
        RelayRule: {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: 'relay-rule',
            EventBusName: { Ref: 'SharedBus' },
            EventPattern: { source: ['identity'], 'detail-type': ['UserCreated'] },
            State: 'ENABLED',
            Targets: [
              {
                Arn: { 'Fn::GetAtt': ['ConsumerLambdaFunction', 'Arn'] },
                Id: 'consumer-target',
                Input: '{"static":true}',
              },
            ],
          },
        },
      },
    } as never) as EventRuleResource[];

    expect(res.type).toBe('event-rule');
    expect(res.name).toBe('relay-rule');
    expect(res.eventBusRef).toBe('SharedBus');
    expect(res.eventBusUnresolved).toBeUndefined();
    expect(res.eventPattern).toEqual({ source: ['identity'], 'detail-type': ['UserCreated'] });
    expect(res.enabled).toBe(true);
    expect(res.targets).toEqual([
      { id: 'consumer-target', functionRef: 'ConsumerLambdaFunction', input: '{"static":true}', inputPath: undefined },
    ]);
  });

  it('handles schedule rules on the default bus, DISABLED state and name fallback', () => {
    const [res] = parser.parse({
      Resources: {
        CronRule: {
          Type: 'AWS::Events::Rule',
          Properties: {
            ScheduleExpression: 'rate(5 minutes)',
            State: 'DISABLED',
            Targets: [{ Arn: { 'Fn::GetAtt': ['JobLambdaFunction', 'Arn'] }, Id: 'job' }],
          },
        },
      },
    } as never) as EventRuleResource[];

    expect(res.name).toBe('CronRule');
    expect(res.eventBusRef).toBeUndefined();
    expect(res.scheduleExpression).toBe('rate(5 minutes)');
    expect(res.enabled).toBe(false);
  });

  it('flags an unresolvable EventBusName (Fn::ImportValue) instead of dropping it silently', () => {
    const [res] = parser.parse({
      Resources: {
        CrossStackRule: {
          Type: 'AWS::Events::Rule',
          Properties: {
            EventBusName: { 'Fn::ImportValue': 'shared-bus-name' },
            EventPattern: { source: ['x'] },
            Targets: [{ Arn: { 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] }, Id: 't' }],
          },
        },
      },
    } as never) as EventRuleResource[];
    expect(res.eventBusRef).toBeUndefined();
    expect(res.eventBusUnresolved).toBe(true);
  });

  it('keeps literal ARN targets, defaults missing Ids, skips unresolvable targets', () => {
    const [res] = parser.parse({
      Resources: {
        Rule: {
          Type: 'AWS::Events::Rule',
          Properties: {
            EventPattern: { source: ['x'] },
            Targets: [
              { Arn: 'arn:aws:lambda:us-east-1:000000000000:function:svc-dev-handler' },
              { Arn: { 'Fn::Sub': 'not-resolvable' }, Id: 'ignored' },
            ],
          },
        },
      },
    } as never) as EventRuleResource[];
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0].functionRef).toBe('arn:aws:lambda:us-east-1:000000000000:function:svc-dev-handler');
    expect(res.targets[0].id).toBe('arn:aws:lambda:us-east-1:000000000000:function:svc-dev-handler');
  });
});

describe('AWS::Events::Archive', () => {
  it('is skipped with a warning (LocalStack mocks Archives)', () => {
    const warnings: string[] = [];
    const resources = parser.parse({
      Resources: {
        BusArchive: {
          Type: 'AWS::Events::Archive',
          Properties: { ArchiveName: 'domain-events-archive' },
        },
      },
    } as never, warnings);
    expect(resources).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('BusArchive');
    expect(warnings[0]).toContain('Archive');
  });

  it('does not touch the warnings sink for supported or unknown types', () => {
    const warnings: string[] = [];
    parser.parse({
      Resources: {
        Bus: { Type: 'AWS::Events::EventBus', Properties: {} },
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
      },
    } as never, warnings);
    expect(warnings).toEqual([]);
  });
});

describe('parseOpenSearchCollection', () => {
  it('parses name, type and description', () => {
    const resources = parser.parse({
      Resources: {
        ProductsCollection: {
          Type: 'AWS::OpenSearchServerless::Collection',
          Properties: { Name: 'products', Type: 'SEARCH', Description: 'catalog search' },
        },
      },
    } as never) as OpenSearchCollectionResource[];
    expect(resources).toEqual([{
      type: 'opensearch',
      logicalId: 'ProductsCollection',
      name: 'products',
      collectionType: 'SEARCH',
      description: 'catalog search',
    }]);
  });

  it('falls back to the lowercased logical id when Name is absent (collection names must be lowercase)', () => {
    const resources = parser.parse({
      Resources: {
        ProductsCollection: { Type: 'AWS::OpenSearchServerless::Collection', Properties: {} },
      },
    } as never) as OpenSearchCollectionResource[];
    expect(resources[0].name).toBe('productscollection');
    expect(resources[0].collectionType).toBeUndefined();
  });

  it('handles a collection with no Properties block', () => {
    const resources = parser.parse({
      Resources: {
        Search: { Type: 'AWS::OpenSearchServerless::Collection' },
      },
    } as never) as OpenSearchCollectionResource[];
    expect(resources[0].name).toBe('search');
  });

  it('bends fallback names into the AOSS naming rule (charset, leading letter, length)', () => {
    const parse = (logicalId: string) =>
      (parser.parse({
        Resources: { [logicalId]: { Type: 'AWS::OpenSearchServerless::Collection', Properties: {} } },
      } as never) as OpenSearchCollectionResource[])[0].name;

    expect(parse('My_Search_Index')).toBe('my-search-index'); // underscores → hyphens
    expect(parse('2FastCollection')).toBe('fastcollection'); // leading digits stripped
    expect(parse('DB')).toBe('col-db'); // too short → prefixed
    expect(parse('A'.repeat(40))).toHaveLength(32); // capped at 32
  });

  it('skips SecurityPolicy/AccessPolicy/VpcEndpoint with a warning (nothing enforces them locally)', () => {
    const warnings: string[] = [];
    const resources = parser.parse({
      Resources: {
        Encryption: {
          Type: 'AWS::OpenSearchServerless::SecurityPolicy',
          Properties: { Name: 'products-encryption', Type: 'encryption', Policy: '{}' },
        },
        DataAccess: {
          Type: 'AWS::OpenSearchServerless::AccessPolicy',
          Properties: { Name: 'products-access', Type: 'data', Policy: '[]' },
        },
        Vpc: {
          Type: 'AWS::OpenSearchServerless::VpcEndpoint',
          Properties: { Name: 'products-vpce' },
        },
      },
    } as never, warnings);
    expect(resources).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('AWS::OpenSearchServerless::SecurityPolicy "Encryption"');
    expect(warnings[1]).toContain('AWS::OpenSearchServerless::AccessPolicy "DataAccess"');
    expect(warnings[2]).toContain('AWS::OpenSearchServerless::VpcEndpoint "Vpc"');
  });
});

describe('parseApi (AWS::ApiGatewayV2::Api)', () => {
  it('parses name, protocolType and flags a present CorsConfiguration', () => {
    const [res] = parser.parse({
      Resources: {
        HttpApi: {
          Type: 'AWS::ApiGatewayV2::Api',
          Properties: { Name: 'gw', ProtocolType: 'HTTP', CorsConfiguration: { AllowedOrigins: ['*'] } },
        },
      },
    } as never) as ApiResource[];
    expect(res).toEqual({ type: 'apigw-api', logicalId: 'HttpApi', name: 'gw', protocolType: 'HTTP', cors: true });
  });

  it('falls back to the logical id and reports cors:false with no Properties', () => {
    const [res] = parser.parse({
      Resources: { HttpApi: { Type: 'AWS::ApiGatewayV2::Api' } },
    } as never) as ApiResource[];
    expect(res).toEqual({ type: 'apigw-api', logicalId: 'HttpApi', name: 'HttpApi', protocolType: undefined, cors: false });
  });
});

describe('parseApiIntegration (AWS::ApiGatewayV2::Integration)', () => {
  it('parses type, raw IntegrationUri, payload version, timeout and ApiId ref', () => {
    const [res] = parser.parse({
      Resources: {
        Int: {
          Type: 'AWS::ApiGatewayV2::Integration',
          Properties: {
            ApiId: { Ref: 'HttpApi' },
            IntegrationType: 'AWS_PROXY',
            IntegrationUri: { 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] },
            PayloadFormatVersion: '2.0',
            TimeoutInMillis: 30000,
          },
        },
      },
    } as never) as ApiIntegrationResource[];
    expect(res).toEqual({
      type: 'apigw-integration',
      logicalId: 'Int',
      name: 'Int',
      apiRef: 'HttpApi',
      integrationType: 'AWS_PROXY',
      integrationUri: { 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] },
      payloadFormatVersion: '2.0',
      timeoutInMillis: 30000,
    });
  });

  it('tolerates a bare integration with no Properties', () => {
    const [res] = parser.parse({
      Resources: { Int: { Type: 'AWS::ApiGatewayV2::Integration' } },
    } as never) as ApiIntegrationResource[];
    expect(res.apiRef).toBeUndefined();
    expect(res.integrationType).toBeUndefined();
    expect(res.integrationUri).toBeUndefined();
  });
});

describe('parseApiRoute (AWS::ApiGatewayV2::Route)', () => {
  it('parses a CUSTOM route: method/path from RouteKey, integration from Fn::Join Target, authorizer from AuthorizerId', () => {
    const [res] = parser.parse({
      Resources: {
        R: {
          Type: 'AWS::ApiGatewayV2::Route',
          Properties: {
            ApiId: { Ref: 'HttpApi' },
            RouteKey: 'GET /users',
            Target: { 'Fn::Join': ['/', ['integrations', { Ref: 'Int' }]] },
            AuthorizationType: 'CUSTOM',
            AuthorizerId: { Ref: 'Auth' },
          },
        },
      },
    } as never) as ApiRouteResource[];
    expect(res).toEqual({
      type: 'apigw-route',
      logicalId: 'R',
      name: 'R',
      apiRef: 'HttpApi',
      routeKey: 'GET /users',
      method: 'GET',
      path: '/users',
      integrationRef: 'Int',
      authorizationType: 'CUSTOM',
      authorizerRef: 'Auth',
    });
  });

  it('parses a literal "integrations/<id>" Target and defaults AuthorizationType to NONE', () => {
    const [res] = parser.parse({
      Resources: {
        R: {
          Type: 'AWS::ApiGatewayV2::Route',
          Properties: { RouteKey: 'post /items/', Target: 'integrations/Int9' },
        },
      },
    } as never) as ApiRouteResource[];
    expect(res.integrationRef).toBe('Int9');
    expect(res.authorizationType).toBe('NONE');
    expect(res.authorizerRef).toBeUndefined();
    expect(res.method).toBe('POST');
    // Trailing slash normalized away.
    expect(res.path).toBe('/items');
  });

  it('maps $default and "*" RouteKeys to an ANY catch-all', () => {
    const [def] = parser.parse({
      Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: '$default' } } },
    } as never) as ApiRouteResource[];
    expect(def).toMatchObject({ method: 'ANY', path: '$default' });

    const [star] = parser.parse({
      Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: '* /wild' } } },
    } as never) as ApiRouteResource[];
    expect(star).toMatchObject({ method: 'ANY', path: '/wild' });
  });

  it('normalizes a missing/blank path to "/" and defaults a missing method to ANY', () => {
    // No Properties block at all.
    const [bare] = parser.parse({
      Resources: { R: { Type: 'AWS::ApiGatewayV2::Route' } },
    } as never) as ApiRouteResource[];
    expect(bare.routeKey).toBe('');
    expect(bare.method).toBe('ANY');
    expect(bare.path).toBe('/');

    const [slash] = parser.parse({
      Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: 'GET /' } } },
    } as never) as ApiRouteResource[];
    expect(slash.path).toBe('/');
  });

  it('adds the leading slash to a RouteKey path that omits it', () => {
    const [res] = parser.parse({
      Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: 'GET users/{id}' } } },
    } as never) as ApiRouteResource[];
    expect(res.path).toBe('/users/{id}');
  });

  it('returns no integrationRef for a non-matching string Target, a non-join object, or a join without a ref part', () => {
    const parseTarget = (Target: unknown) =>
      (parser.parse({
        Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: 'GET /x', Target } } },
      } as never) as ApiRouteResource[])[0].integrationRef;

    expect(parseTarget('not-an-integration')).toBeUndefined();
    expect(parseTarget({ 'Fn::Sub': 'nope' })).toBeUndefined();
    expect(parseTarget({ 'Fn::Join': ['/', 'not-an-array'] })).toBeUndefined();
    // Fn::Join whose last part is a literal string id.
    expect(parseTarget({ 'Fn::Join': ['/', ['integrations', 'LiteralInt']] })).toBe('LiteralInt');
    // Fn::Join whose last part is neither a string nor a {Ref}.
    expect(parseTarget({ 'Fn::Join': ['/', ['integrations', { 'Fn::Sub': 'x' }]] })).toBeUndefined();
  });

  // The idiom a hand-written `resources:` block emits, and the one the
  // Serverless Framework passes straight through into the compiled template.
  // Before this was handled, integrationRef stayed undefined and the assembler
  // skipped the route with `no ::Integration for Target "(none)"`.
  it('parses the Fn::Sub Target idiom: !Sub "integrations/${LogicalId}"', () => {
    const parseTarget = (Target: unknown) =>
      (parser.parse({
        Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { RouteKey: 'GET /x', Target } } },
      } as never) as ApiRouteResource[])[0].integrationRef;

    expect(parseTarget({ 'Fn::Sub': 'integrations/${SpacesIntegration}' })).toBe('SpacesIntegration');
    // Whitespace inside the token and around the value is tolerated.
    expect(parseTarget({ 'Fn::Sub': ' integrations/${ SpacesIntegration } ' })).toBe('SpacesIntegration');
    // Fn::Sub's list form: [template, vars] — the template still comes first.
    expect(parseTarget({ 'Fn::Sub': ['integrations/${SpacesIntegration}', {}] })).toBe('SpacesIntegration');
    // An already-substituted literal under Fn::Sub works the same way.
    expect(parseTarget({ 'Fn::Sub': 'integrations/Int9' })).toBe('Int9');
    // A non-string template (or an empty list) names nothing.
    expect(parseTarget({ 'Fn::Sub': [] })).toBeUndefined();
    expect(parseTarget({ 'Fn::Sub': { bad: true } })).toBeUndefined();
  });
});

describe('parseApiAuthorizer (AWS::ApiGatewayV2::Authorizer)', () => {
  it('parses a REQUEST authorizer with all v2 fields', () => {
    const [res] = parser.parse({
      Resources: {
        Auth: {
          Type: 'AWS::ApiGatewayV2::Authorizer',
          Properties: {
            ApiId: { Ref: 'HttpApi' },
            Name: 'sessionAuthorizerV2',
            AuthorizerType: 'REQUEST',
            IdentitySource: ['$request.header.authorization'],
            EnableSimpleResponses: true,
            AuthorizerPayloadFormatVersion: '2.0',
            AuthorizerResultTtlInSeconds: 3600,
            AuthorizerUri: 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-sessionAuthorizerV2Local',
          },
        },
      },
    } as never) as ApiAuthorizerResource[];
    expect(res).toEqual({
      type: 'apigw-authorizer',
      logicalId: 'Auth',
      name: 'sessionAuthorizerV2',
      apiRef: 'HttpApi',
      authorizerType: 'REQUEST',
      identitySource: ['$request.header.authorization'],
      authorizerUri: 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-sessionAuthorizerV2Local',
      enableSimpleResponses: true,
      authorizerPayloadFormatVersion: '2.0',
      resultTtlInSeconds: 3600,
    });
  });

  it('applies AWS defaults (name=logicalId, payload 1.0, ttl 300, simple false, identitySource [])', () => {
    const [res] = parser.parse({
      Resources: { Auth: { Type: 'AWS::ApiGatewayV2::Authorizer' } },
    } as never) as ApiAuthorizerResource[];
    expect(res.name).toBe('Auth');
    expect(res.authorizerPayloadFormatVersion).toBe('1.0');
    expect(res.resultTtlInSeconds).toBe(300);
    expect(res.enableSimpleResponses).toBe(false);
    expect(res.identitySource).toEqual([]);
  });

  it('accepts a lone IdentitySource string as a one-element list', () => {
    const [res] = parser.parse({
      Resources: {
        Auth: {
          Type: 'AWS::ApiGatewayV2::Authorizer',
          Properties: { IdentitySource: '$request.header.authorization' },
        },
      },
    } as never) as ApiAuthorizerResource[];
    expect(res.identitySource).toEqual(['$request.header.authorization']);
  });

  it('preserves a literal 0 TTL (caching disabled) but rejects a non-numeric TTL back to 300', () => {
    const [zero] = parser.parse({
      Resources: { Auth: { Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { AuthorizerResultTtlInSeconds: 0 } } },
    } as never) as ApiAuthorizerResource[];
    expect(zero.resultTtlInSeconds).toBe(0);

    const [bad] = parser.parse({
      Resources: { Auth: { Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { AuthorizerResultTtlInSeconds: 'oops' } } },
    } as never) as ApiAuthorizerResource[];
    expect(bad.resultTtlInSeconds).toBe(300);
  });
});

describe('parseLambdaPermission (AWS::Lambda::Permission)', () => {
  it('captures the raw FunctionName/SourceArn plus action and principal', () => {
    const [res] = parser.parse({
      Resources: {
        Perm: {
          Type: 'AWS::Lambda::Permission',
          Properties: {
            Action: 'lambda:InvokeFunction',
            FunctionName: { 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] },
            Principal: 'apigateway.amazonaws.com',
            SourceArn: { 'Fn::Sub': 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:abc/*' },
          },
        },
      },
    } as never) as LambdaPermissionResource[];
    expect(res).toEqual({
      type: 'lambda-permission',
      logicalId: 'Perm',
      name: 'Perm',
      action: 'lambda:InvokeFunction',
      functionRef: { 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] },
      principal: 'apigateway.amazonaws.com',
      sourceArn: { 'Fn::Sub': 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:abc/*' },
    });
  });

  it('tolerates a permission with no Properties', () => {
    const [res] = parser.parse({
      Resources: { Perm: { Type: 'AWS::Lambda::Permission' } },
    } as never) as LambdaPermissionResource[];
    expect(res).toEqual({
      type: 'lambda-permission',
      logicalId: 'Perm',
      name: 'Perm',
      action: undefined,
      functionRef: undefined,
      principal: undefined,
      sourceArn: undefined,
    });
  });
});

describe('resolveArnLike (intrinsic → ARN reducer)', () => {
  const lambdas = new Map([['FnLambdaFunction', lambdaResource('FnLambdaFunction', 'svc-dev-fn')]]);
  const ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:svc-dev-fn';

  it('passes literal strings through (empty string is unresolved)', () => {
    expect(parser.resolveArnLike('literal', ctxWith())).toEqual({ value: 'literal', resolved: true });
    expect(parser.resolveArnLike('', ctxWith())).toEqual({ value: '', resolved: false });
  });

  it('treats null/undefined and non-object primitives as unresolved', () => {
    expect(parser.resolveArnLike(undefined, ctxWith())).toEqual({ value: '', resolved: false });
    expect(parser.resolveArnLike(null, ctxWith())).toEqual({ value: '', resolved: false });
    expect(parser.resolveArnLike(42, ctxWith())).toEqual({ value: '', resolved: false });
  });

  it('resolves Ref/Fn::GetAtt to a same-template Lambda ARN', () => {
    expect(parser.resolveArnLike({ Ref: 'FnLambdaFunction' }, ctxWith({ lambdas }))).toEqual({ value: ARN, resolved: true });
    expect(parser.resolveArnLike({ 'Fn::GetAtt': ['FnLambdaFunction', 'Arn'] }, ctxWith({ lambdas }))).toEqual({ value: ARN, resolved: true });
  });

  it('leaves a Ref/GetAtt to a non-Lambda (or non-Arn attribute) unresolved', () => {
    expect(parser.resolveArnLike({ Ref: 'HttpApi' }, ctxWith({ lambdas }))).toEqual({ value: 'HttpApi', resolved: false });
    expect(parser.resolveArnLike({ 'Fn::GetAtt': ['Table', 'StreamArn'] }, ctxWith({ lambdas }))).toEqual({ value: 'Table.StreamArn', resolved: false });
    // String short-form Fn::GetAtt.
    expect(parser.resolveArnLike({ 'Fn::GetAtt': 'Table.Arn' }, ctxWith({ lambdas }))).toEqual({ value: 'Table.Arn', resolved: false });
  });

  // The Serverless Framework compiles a Permission's SourceArn as an Fn::Join
  // over PSEUDO-PARAMETER Refs, not an Fn::Sub — so Ref has to reduce them too,
  // otherwise the recorded ARN reads "arn:AWS::Partition:execute-api:...".
  it('resolves Ref to the AWS pseudo-parameters', () => {
    expect(parser.resolveArnLike({ Ref: 'AWS::Region' }, ctxWith())).toEqual({ value: 'sa-east-1', resolved: true });
    expect(parser.resolveArnLike({ Ref: 'AWS::AccountId' }, ctxWith())).toEqual({ value: '000000000000', resolved: true });
    expect(parser.resolveArnLike({ Ref: 'AWS::Partition' }, ctxWith())).toEqual({ value: 'aws', resolved: true });
  });

  // `${HttpApi}` / `{Ref: HttpApi}` names the framework's ::Api. AWS substitutes
  // the generated API id; locally the API's name is the stable stand-in, and it
  // only ever feeds the advisory SourceArn.
  it('resolves Ref/Fn::Sub tokens naming a same-template ::Api to the API name', () => {
    const apis = new Map([['HttpApi', { type: 'apigw-api', logicalId: 'HttpApi', name: 'dev-users-service', cors: true } as ApiResource]]);
    expect(parser.resolveArnLike({ Ref: 'HttpApi' }, ctxWith({ lambdas, apis }))).toEqual({ value: 'dev-users-service', resolved: true });
    expect(parser.resolveArnLike(
      { 'Fn::Sub': 'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${HttpApi}/*' },
      ctxWith({ lambdas, apis }),
    )).toEqual({ value: 'arn:aws:execute-api:sa-east-1:000000000000:dev-users-service/*', resolved: true });
    // A logical id that is neither a Lambda nor an ::Api still falls through.
    expect(parser.resolveArnLike({ Ref: 'Ghost' }, ctxWith({ lambdas, apis }))).toEqual({ value: 'Ghost', resolved: false });
    expect(parser.resolveArnLike({ 'Fn::Sub': '${Ghost}' }, ctxWith({ lambdas, apis }))).toEqual({ value: '${Ghost}', resolved: false });
  });

  it('resolves Fn::Sub with AWS pseudo-params, a lambda token, and a vars map', () => {
    const sub = { 'Fn::Sub': 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:svc-dev-fn' };
    expect(parser.resolveArnLike(sub, ctxWith({ lambdas }))).toEqual({ value: ARN, resolved: true });

    // ${LogicalId.Arn} interpolates the same-template Lambda ARN.
    expect(parser.resolveArnLike({ 'Fn::Sub': '${FnLambdaFunction.Arn}' }, ctxWith({ lambdas }))).toEqual({ value: ARN, resolved: true });

    // Array form with an explicit variables map.
    expect(parser.resolveArnLike(
      { 'Fn::Sub': ['prefix-${Who}', { Who: 'you' }] },
      ctxWith(),
    )).toEqual({ value: 'prefix-you', resolved: true });
  });

  it('marks an Fn::Sub with an unknown token unresolved and rejects a non-string/array Sub', () => {
    expect(parser.resolveArnLike({ 'Fn::Sub': 'x-${Unknown}' }, ctxWith())).toEqual({ value: 'x-${Unknown}', resolved: false });
    expect(parser.resolveArnLike({ 'Fn::Sub': { bad: true } }, ctxWith())).toEqual({ value: '', resolved: false });
    // Array form whose second element is not a variables object → empty vars.
    expect(parser.resolveArnLike({ 'Fn::Sub': ['plain'] }, ctxWith())).toEqual({ value: 'plain', resolved: true });
  });

  it('resolves Fn::ImportValue against the export map and warns when missing', () => {
    const exports = new Map([['other-stack-fn-arn', ARN]]);
    expect(parser.resolveArnLike({ 'Fn::ImportValue': 'other-stack-fn-arn' }, ctxWith({ exports }))).toEqual({ value: ARN, resolved: true });

    const warnings: string[] = [];
    expect(parser.resolveArnLike({ 'Fn::ImportValue': 'ghost' }, ctxWith({ exports, warnings }))).toEqual({ value: 'ghost', resolved: false });
    expect(warnings[0]).toContain('Fn::ImportValue "ghost"');

    // Import name given as a nested intrinsic (Fn::Sub) with no export → still warns, no warnings sink.
    expect(parser.resolveArnLike({ 'Fn::ImportValue': { 'Fn::Sub': 'p-${AWS::Region}' } }, ctxWith({ exports }))).toEqual({ value: 'p-sa-east-1', resolved: false });
  });

  it('joins Fn::Join parts (resolved only when every part resolved) and rejects a malformed join', () => {
    expect(parser.resolveArnLike(
      { 'Fn::Join': [':', ['a', { Ref: 'FnLambdaFunction' }]] },
      ctxWith({ lambdas }),
    )).toEqual({ value: `a:${ARN}`, resolved: true });

    // A part that does not resolve makes the whole join unresolved.
    expect(parser.resolveArnLike(
      { 'Fn::Join': ['/', ['integrations', { Ref: 'HttpApi' }]] },
      ctxWith({ lambdas }),
    )).toEqual({ value: 'integrations/HttpApi', resolved: false });

    expect(parser.resolveArnLike({ 'Fn::Join': ['x'] }, ctxWith())).toEqual({ value: '', resolved: false });

    // A null delimiter degrades to an empty separator rather than "null".
    expect(parser.resolveArnLike({ 'Fn::Join': [null, ['a', 'b']] }, ctxWith())).toEqual({ value: 'ab', resolved: true });
  });

  it('treats a nullish Fn::Sub template as an empty string', () => {
    expect(parser.resolveArnLike({ 'Fn::Sub': [null, { Who: 'x' }] }, ctxWith())).toEqual({ value: '', resolved: true });
  });

  it('returns unresolved for an object with no recognized intrinsic key', () => {
    expect(parser.resolveArnLike({ Nonsense: true }, ctxWith())).toEqual({ value: '', resolved: false });
  });
});

describe('raw ApiGatewayV2 fixture (end-to-end parse)', () => {
  it('parses the committed serverless-compiled raw-API template into the five resource kinds', () => {
    const template = JSON.parse(fs.readFileSync(APIGW_RAW, 'utf8'));
    const resources = parser.parse(template);

    const route = resources.find(r => r.type === 'apigw-route') as ApiRouteResource;
    expect(route).toMatchObject({ method: 'GET', path: '/users', integrationRef: 'HttpApiIntegrationListUsers', authorizationType: 'CUSTOM', authorizerRef: 'HttpApiAuthorizerSessionV2' });

    const integration = resources.find(r => r.type === 'apigw-integration') as ApiIntegrationResource;
    expect(integration.integrationType).toBe('AWS_PROXY');
    expect(integration.payloadFormatVersion).toBe('2.0');

    const authorizer = resources.find(r => r.type === 'apigw-authorizer') as ApiAuthorizerResource;
    expect(authorizer).toMatchObject({ name: 'sessionAuthorizerV2', enableSimpleResponses: true, authorizerPayloadFormatVersion: '2.0', resultTtlInSeconds: 3600 });

    const api = resources.find(r => r.type === 'apigw-api') as ApiResource;
    expect(api.cors).toBe(true);

    const permission = resources.find(r => r.type === 'lambda-permission') as LambdaPermissionResource;
    expect(permission.principal).toBe('apigateway.amazonaws.com');

    // The same-template Fn::GetAtt IntegrationUri reduces to the Lambda ARN.
    const lambdas = new Map(
      resources.filter((r): r is LambdaResource => r.type === 'lambda').map(l => [l.logicalId, l] as const),
    );
    const resolved = parser.resolveArnLike(integration.integrationUri, ctxWith({ lambdas }));
    expect(resolved).toEqual({ value: 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-listUsers', resolved: true });
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
