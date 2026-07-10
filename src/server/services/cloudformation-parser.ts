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
  streamViewType?: 'KEYS_ONLY' | 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES';
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

export interface EventBusResource {
  type: 'eventbus';
  logicalId: string;
  name: string;
}

export interface EventRuleTarget {
  id: string;
  // CFN function reference (Fn::GetAtt logical id), literal Lambda ARN or name.
  functionRef: string;
  // Optional CFN Target passthroughs (Input is a JSON string in CFN).
  input?: string;
  inputPath?: string;
}

export interface EventRuleResource {
  type: 'event-rule';
  logicalId: string;
  name: string;
  // Logical id of a bus in the same template, or a literal bus name/ARN.
  // Absent → the default bus. `eventBusUnresolved` marks an EventBusName the
  // parser couldn't reduce to a string (e.g. Fn::ImportValue) — provisioning
  // must skip the rule rather than silently bind it to the default bus.
  eventBusRef?: string;
  eventBusUnresolved?: boolean;
  eventPattern?: Record<string, unknown>;
  scheduleExpression?: string;
  enabled: boolean;
  targets: EventRuleTarget[];
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

export type Resource =
  | LambdaResource
  | DynamoDBResource
  | SQSResource
  | SNSResource
  | S3Resource
  | EventBusResource
  | EventRuleResource
  | EventSourceMapping;

export class CloudFormationParser {
  // `warnings` collects non-fatal template findings (e.g. resource types LSS
  // deliberately skips) so callers can surface them to the registering client.
  parse(template: CloudFormationTemplate, warnings?: string[]): Resource[] {
    const resources: Resource[] = [];

    if (!template.Resources) {
      return resources;
    }

    for (const [key, resource] of Object.entries(template.Resources)) {
      const parsed = this.parseResource(key, resource, warnings);
      if (parsed) {
        resources.push(parsed);
      }
    }

    return resources;
  }

  private parseResource(key: string, resource: CloudFormationResource, warnings?: string[]): Resource | null {
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
      case 'AWS::Events::EventBus':
        return this.parseEventBus(key, resource);
      case 'AWS::Events::Rule':
        return this.parseEventRule(key, resource);
      case 'AWS::Events::Archive':
        // LocalStack mocks Archives: CFN reports CREATE_COMPLETE but ListArchives
        // stays empty, so provisioning one locally would only fake success.
        warnings?.push(`AWS::Events::Archive "${key}" is not provisioned locally — LocalStack mocks Archives (created but never listed/replayable).`);
        return null;
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

    const parsed: DynamoDBResource = {
      type: 'dynamodb',
      logicalId: key,
      name: (props.TableName as string) || key,
      keySchema: (props.KeySchema as Array<{ AttributeName: string; KeyType: string }>) || [],
      attributeDefinitions: (props.AttributeDefinitions as Array<{ AttributeName: string; AttributeType: string }>) || [],
      billingMode: props.BillingMode as string | undefined,
      streamEnabled,
      globalSecondaryIndexes: props.GlobalSecondaryIndexes as DynamoDBResource['globalSecondaryIndexes'] | undefined,
      localSecondaryIndexes: props.LocalSecondaryIndexes as DynamoDBResource['localSecondaryIndexes'] | undefined,
    };
    if (streamSpec?.StreamViewType) {
      parsed.streamViewType = streamSpec.StreamViewType as DynamoDBResource['streamViewType'];
    }
    if (ttlSpec?.AttributeName) {
      parsed.ttl = { attributeName: ttlSpec.AttributeName, enabled: ttlSpec.Enabled !== false };
    }
    return parsed;
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

  private parseEventBus(key: string, resource: CloudFormationResource): EventBusResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'eventbus',
      logicalId: key,
      name: (props.Name as string) || key,
    };
  }

  private parseEventRule(key: string, resource: CloudFormationResource): EventRuleResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;

    const parsed: EventRuleResource = {
      type: 'event-rule',
      logicalId: key,
      name: (props.Name as string) || key,
      enabled: props.State !== 'DISABLED',
      targets: [],
    };

    if (props.EventBusName !== undefined) {
      // Ref/Fn::GetAtt on an AWS::Events::EventBus both reduce to its logical id;
      // a plain string is a literal bus name or ARN (both accepted by PutRule).
      const busRef = this.extractFunctionName(props.EventBusName);
      if (busRef) parsed.eventBusRef = busRef;
      else parsed.eventBusUnresolved = true;
    }
    if (props.EventPattern !== undefined) {
      parsed.eventPattern = props.EventPattern as Record<string, unknown>;
    }
    if (props.ScheduleExpression !== undefined) {
      parsed.scheduleExpression = props.ScheduleExpression as string;
    }

    for (const raw of (props.Targets as unknown[]) || []) {
      const target = raw as Record<string, unknown>;
      const functionRef = this.extractFunctionName(target.Arn);
      if (!functionRef) continue;
      parsed.targets.push({
        id: (target.Id as string) || functionRef,
        functionRef,
        input: target.Input as string | undefined,
        inputPath: target.InputPath as string | undefined,
      });
    }

    return parsed;
  }

  private parseEventSource(_key: string, resource: CloudFormationResource): EventSourceMapping {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    const destination = (props.DestinationConfig as { OnFailure?: { Destination?: unknown } } | undefined)
      ?.OnFailure?.Destination;
    const parsed: EventSourceMapping = {
      type: 'event-source',
      functionName: this.extractFunctionName(props.FunctionName),
      eventSourceArn: this.extractArn(props.EventSourceArn),
      enabled: props.Enabled !== false,
    };
    if (props.BatchSize !== undefined) {
      parsed.batchSize = props.BatchSize as number;
    }
    if (props.StartingPosition !== undefined) {
      parsed.startingPosition = props.StartingPosition as string;
    }
    if (props.MaximumRetryAttempts !== undefined) {
      parsed.maximumRetryAttempts = props.MaximumRetryAttempts as number;
    }
    if (destination !== undefined) {
      const resolvedDestination = this.extractArn(destination);
      if (resolvedDestination) parsed.onFailureDestination = resolvedDestination;
    }
    if (props.MaximumBatchingWindowInSeconds !== undefined) {
      parsed.maximumBatchingWindowInSeconds = props.MaximumBatchingWindowInSeconds as number;
    }
    if (Array.isArray(props.FunctionResponseTypes)) {
      parsed.functionResponseTypes = props.FunctionResponseTypes as string[];
    }
    if (props.FilterCriteria !== undefined) {
      parsed.filterCriteria = props.FilterCriteria as EventSourceMapping['filterCriteria'];
    }
    return parsed;
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
