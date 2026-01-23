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
  name: string;
  handler: string;
  runtime: string;
  environment: Record<string, string>;
  memorySize: number;
  timeout: number;
}

export interface DynamoDBResource {
  type: 'dynamodb';
  name: string;
  keySchema: Array<{ AttributeName: string; KeyType: string }>;
  attributeDefinitions: Array<{ AttributeName: string; AttributeType: string }>;
  billingMode?: string;
  streamEnabled?: boolean;
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
  name: string;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  fifoQueue?: boolean;
  contentBasedDeduplication?: boolean;
}

export interface SNSResource {
  type: 'sns';
  name: string;
}

export interface EventSourceMapping {
  type: 'event-source';
  functionName: string;
  eventSourceArn: string;
  batchSize?: number;
  enabled: boolean;
}

export type Resource = LambdaResource | DynamoDBResource | SQSResource | SNSResource | EventSourceMapping;

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
    return {
      type: 'dynamodb',
      name: (props.TableName as string) || key,
      keySchema: (props.KeySchema as Array<{ AttributeName: string; KeyType: string }>) || [],
      attributeDefinitions: (props.AttributeDefinitions as Array<{ AttributeName: string; AttributeType: string }>) || [],
      billingMode: props.BillingMode as string | undefined,
      streamEnabled: ((props.StreamSpecification as { StreamEnabled?: boolean })?.StreamEnabled) || false,
      globalSecondaryIndexes: props.GlobalSecondaryIndexes as DynamoDBResource['globalSecondaryIndexes'] | undefined,
      localSecondaryIndexes: props.LocalSecondaryIndexes as DynamoDBResource['localSecondaryIndexes'] | undefined,
    };
  }

  private parseSQS(key: string, resource: CloudFormationResource): SQSResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'sqs',
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
      name: (props.TopicName as string) || key,
    };
  }

  private parseEventSource(_key: string, resource: CloudFormationResource): EventSourceMapping {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'event-source',
      functionName: this.extractFunctionName(props.FunctionName),
      eventSourceArn: this.extractArn(props.EventSourceArn),
      batchSize: props.BatchSize as number | undefined,
      enabled: props.Enabled !== false,
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
