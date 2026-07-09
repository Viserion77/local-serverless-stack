import crypto from 'crypto';

interface CloudFormationTemplate {
  Resources: Record<string, CloudFormationResource>;
  [key: string]: unknown;
}

interface CloudFormationResource {
  Type: string;
  Properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LambdaResource {
  type: 'lambda';
  logicalId: string;
  name: string;
  handler: string;
  runtime: string;
  environment: Record<string, string>;
  memorySize: number;
  timeout: number;
}

export interface DynamoDBResource {
  type: 'dynamodb';
  logicalId: string;
  name: string;
  keySchema: Array<{ AttributeName: string; KeyType: string }>;
  attributeDefinitions: Array<{ AttributeName: string; AttributeType: string }>;
  billingMode?: string;
  streamEnabled?: boolean;
  // TimeToLiveSpecification — applied via UpdateTimeToLive after CreateTable.
  ttl?: { attributeName: string; enabled: boolean };
  globalSecondaryIndexes?: Array<{
    IndexName: string;
    KeySchema: Array<{ AttributeName: string; KeyType: string }>;
    Projection: { ProjectionType: string };
    [key: string]: unknown;
  }>;
  localSecondaryIndexes?: Array<{
    IndexName: string;
    KeySchema: Array<{ AttributeName: string; KeyType: string }>;
    Projection: { ProjectionType: string };
    [key: string]: unknown;
  }>;
}

export interface SQSResource {
  type: 'sqs';
  logicalId: string;
  name: string;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  fifoQueue?: boolean;
  contentBasedDeduplication?: boolean;
}

export interface SNSResource {
  type: 'sns';
  logicalId: string;
  name: string;
}

export interface S3NotificationConfig {
  // CloudFormation function reference (Fn::GetAtt logical id) or already-resolved name.
  functionRef: string;
  // S3 event types (e.g. "s3:ObjectCreated:*", "s3:ObjectRemoved:*").
  events: string[];
  // Optional prefix/suffix filters (only Key.FilterRules supported).
  filterPrefix?: string;
  filterSuffix?: string;
}

export interface S3Resource {
  type: 's3';
  logicalId: string;
  name: string;
  versioningEnabled?: boolean;
  notifications: S3NotificationConfig[];
}

export interface EventSourceMapping {
  type: 'event-source';
  functionName: string;
  eventSourceArn: string;
  batchSize?: number;
  enabled: boolean;
  // Stream-only settings (DynamoDB Streams / Kinesis).
  startingPosition?: string;
  maximumRetryAttempts?: number;
  // ARN reference ("Dlq::Arn") or literal ARN of the OnFailure destination.
  onFailureDestination?: string;
  // Valid for SQS and streams alike.
  maximumBatchingWindowInSeconds?: number;
  functionResponseTypes?: string[];
  filterCriteria?: { Filters?: Array<{ Pattern?: string }> };
}

export type Resource = LambdaResource | DynamoDBResource | SQSResource | SNSResource | S3Resource | EventSourceMapping;

export class CloudFormationParser {
  parse(template: CloudFormationTemplate): Resource[] {
    const resources: Resource[] = [];

    if (!template.Resources) {
      return resources;
    }

    for (const [key, resource] of Object.entries(template.Resources)) {
      const parsed = this.parseResource(key, resource);
      if (parsed) {
        resources.push(parsed);
      }
    }

    return resources;
  }

  private parseResource(key: string, resource: CloudFormationResource): Resource | null {
    switch (resource.Type) {
      case 'AWS::Lambda::Function':
        return this.parseLambda(key, resource);
      case 'AWS::DynamoDB::Table':
        return this.parseDynamoDB(key, resource);
      case 'AWS::SQS::Queue':
        return this.parseSQS(key, resource);
      case 'AWS::SNS::Topic':
        return this.parseSNS(key, resource);
      case 'AWS::S3::Bucket':
        // Skip the bucket Serverless Framework injects for its own deployment
        // artifacts — its name lives behind CloudFormation pseudo-parameters
        // that LSS doesn't resolve, and it isn't useful for local dev.
        if (key === 'ServerlessDeploymentBucket') return null;
        return this.parseS3(key, resource);
      case 'AWS::Lambda::EventSourceMapping':
        return this.parseEventSource(key, resource);
      default:
        return null;
    }
  }

  private parseLambda(key: string, resource: CloudFormationResource): LambdaResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'lambda',
      logicalId: key,
      name: (props.FunctionName as string) || key,
      handler: (props.Handler as string) || '',
      runtime: (props.Runtime as string) || 'nodejs20.x',
      environment: ((props.Environment as { Variables?: Record<string, string> })?.Variables) || {},
      memorySize: (props.MemorySize as number) || 128,
      timeout: (props.Timeout as number) || 30,
    };
  }

  private parseDynamoDB(key: string, resource: CloudFormationResource): DynamoDBResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    // In CloudFormation, the mere presence of StreamSpecification.StreamViewType
    // turns streams on — there's no separate StreamEnabled boolean (AWS SDK has
    // one for UpdateTable, but the CFN resource doesn't).
    const streamSpec = props.StreamSpecification as { StreamEnabled?: boolean; StreamViewType?: string } | undefined;
    const streamEnabled = streamSpec ? Boolean(streamSpec.StreamViewType || streamSpec.StreamEnabled) : false;
    const ttlSpec = props.TimeToLiveSpecification as { AttributeName?: string; Enabled?: boolean } | undefined;

    return {
      type: 'dynamodb',
      logicalId: key,
      name: (props.TableName as string) || key,
      ttl: ttlSpec?.AttributeName
        ? { attributeName: ttlSpec.AttributeName, enabled: ttlSpec.Enabled !== false }
        : undefined,
      keySchema: (props.KeySchema as Array<{ AttributeName: string; KeyType: string }>) || [],
      attributeDefinitions: (props.AttributeDefinitions as Array<{ AttributeName: string; AttributeType: string }>) || [],
      billingMode: props.BillingMode as string | undefined,
      streamEnabled,
      globalSecondaryIndexes: props.GlobalSecondaryIndexes as DynamoDBResource['globalSecondaryIndexes'] | undefined,
      localSecondaryIndexes: props.LocalSecondaryIndexes as DynamoDBResource['localSecondaryIndexes'] | undefined,
    };
  }

  private parseSQS(key: string, resource: CloudFormationResource): SQSResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'sqs',
      logicalId: key,
      name: (props.QueueName as string) || key,
      visibilityTimeout: props.VisibilityTimeout as number | undefined,
      messageRetentionPeriod: props.MessageRetentionPeriod as number | undefined,
      fifoQueue: props.FifoQueue as boolean | undefined,
      contentBasedDeduplication: props.ContentBasedDeduplication as boolean | undefined,
    };
  }

  private parseSNS(key: string, resource: CloudFormationResource): SNSResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'sns',
      logicalId: key,
      name: (props.TopicName as string) || key,
    };
  }

  private parseS3(key: string, resource: CloudFormationResource): S3Resource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    const versioning = props.VersioningConfiguration as { Status?: string } | undefined;
    const notificationProp = props.NotificationConfiguration as
      | { LambdaConfigurations?: unknown[] }
      | undefined;

    const notifications: S3NotificationConfig[] = [];
    const lambdaConfigs = notificationProp?.LambdaConfigurations || [];
    for (const raw of lambdaConfigs) {
      const cfg = raw as Record<string, unknown>;
      const functionRef = this.extractFunctionName(cfg.Function);
      if (!functionRef) continue;

      const eventField = cfg.Event ?? cfg.Events;
      const events: string[] = Array.isArray(eventField)
        ? (eventField as string[])
        : eventField
          ? [eventField as string]
          : ['s3:ObjectCreated:*'];

      const filter = cfg.Filter as { S3Key?: { Rules?: Array<{ Name?: string; Value?: string }> } } | undefined;
      const rules = filter?.S3Key?.Rules || [];
      let filterPrefix: string | undefined;
      let filterSuffix: string | undefined;
      for (const rule of rules) {
        const name = (rule.Name || '').toLowerCase();
        if (name === 'prefix') filterPrefix = rule.Value;
        else if (name === 'suffix') filterSuffix = rule.Value;
      }

      notifications.push({ functionRef, events, filterPrefix, filterSuffix });
    }

    return {
      type: 's3',
      logicalId: key,
      name: (props.BucketName as string) || key,
      versioningEnabled: versioning?.Status === 'Enabled',
      notifications,
    };
  }

  private parseEventSource(_key: string, resource: CloudFormationResource): EventSourceMapping {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    const destination = (props.DestinationConfig as { OnFailure?: { Destination?: unknown } } | undefined)
      ?.OnFailure?.Destination;
    return {
      type: 'event-source',
      functionName: this.extractFunctionName(props.FunctionName),
      eventSourceArn: this.extractArn(props.EventSourceArn),
      batchSize: props.BatchSize as number | undefined,
      enabled: props.Enabled !== false,
      startingPosition: props.StartingPosition as string | undefined,
      maximumRetryAttempts: props.MaximumRetryAttempts as number | undefined,
      onFailureDestination: destination !== undefined ? this.extractArn(destination) || undefined : undefined,
      maximumBatchingWindowInSeconds: props.MaximumBatchingWindowInSeconds as number | undefined,
      functionResponseTypes: props.FunctionResponseTypes as string[] | undefined,
      filterCriteria: props.FilterCriteria as EventSourceMapping['filterCriteria'],
    };
  }

  private extractFunctionName(ref: unknown): string {
    if (typeof ref === 'string') return ref;
    if (ref && typeof ref === 'object') {
      const obj = ref as Record<string, unknown>;
      if ('Ref' in obj) return obj.Ref as string;
      if ('Fn::GetAtt' in obj) return (obj['Fn::GetAtt'] as string[])[0];
    }
    return '';
  }

  private extractArn(ref: unknown): string {
    if (typeof ref === 'string') return ref;
    if (ref && typeof ref === 'object') {
      const obj = ref as Record<string, unknown>;
      if ('Fn::GetAtt' in obj) return (obj['Fn::GetAtt'] as string[]).join('::');
    }
    return '';
  }

  calculateHash(template: CloudFormationTemplate): string {
    const content = JSON.stringify(template);
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
