import crypto from 'crypto';
import type { GenerateSecretStringSpec } from './secret-value.js';

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
  // Queue-level redrive. `deadLetterTargetRef` is either a literal queue ARN or
  // a CFN reference (`Fn::GetAtt` reduced to "<LogicalId>::Arn") to another
  // AWS::SQS::Queue in the same template — the provisioner turns it into a real
  // ARN and serializes the pair into the RedrivePolicy queue attribute.
  redrivePolicy?: SQSRedrivePolicy;
}

export interface SQSRedrivePolicy {
  deadLetterTargetRef: string;
  maxReceiveCount: number;
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

// Normalized CORS rule, shaped to the AWS SDK CORSRule members the provisioner
// sends via PutBucketCors (which is also the engine's S3CorsRule shape).
export interface S3CorsRuleConfig {
  id?: string;
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds?: number;
}

export interface S3Resource {
  type: 's3';
  logicalId: string;
  name: string;
  versioningEnabled?: boolean;
  notifications: S3NotificationConfig[];
  // Set only when CorsConfiguration declares at least one valid rule — kept
  // conditional so a bucket without CORS has no corsRules key at all.
  corsRules?: S3CorsRuleConfig[];
}

export interface SecretsManagerResource {
  type: 'secret';
  logicalId: string;
  name: string;
  description?: string;
  kmsKeyId?: string;
  secretString?: string;
  // Raw (camelCased) GenerateSecretString spec — the value is synthesized at
  // provision time (parser stays pure), not here.
  generateSecretString?: GenerateSecretStringSpec;
  tags: Array<{ Key: string; Value: string }>;
}

export interface EventBusResource {
  type: 'eventbus';
  logicalId: string;
  name: string;
}

export interface OpenSearchCollectionResource {
  type: 'opensearch';
  logicalId: string;
  name: string;
  // SEARCH | TIMESERIES | VECTORSEARCH (CFN `Type`); provisioning passes it
  // through and defaults are left to the engine.
  collectionType?: string;
  description?: string;
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

// --- Raw AWS::ApiGatewayV2 + AWS::Lambda::Permission resources ---------------
// Hand-authored HTTP API v2 topologies declared under CFN `resources:` (an ::Api
// fronting ::Route/::Integration/::Authorizer wired to Lambdas that may live in
// OTHER stacks). The parser records the raw intrinsics; the assembler
// (raw-api-assembler.ts) reduces IntegrationUri/AuthorizerUri to concrete ARNs
// via resolveArnLike and folds them into the same route registry as
// serverless-state. Every member carries `name` so the shared Resource[]
// consumers (resource-provisioner's `'name' in resource` narrowing) still type.

export interface ApiResource {
  type: 'apigw-api';
  logicalId: string;
  // The ::Api Name property, else the logical id.
  name: string;
  protocolType?: string;
  // True when a CorsConfiguration block is present (drives HttpRoute.cors).
  cors: boolean;
}

export interface ApiIntegrationResource {
  type: 'apigw-integration';
  logicalId: string;
  name: string;
  // Logical id of the ::Api this integration belongs to (from ApiId).
  apiRef?: string;
  integrationType?: string;
  // Raw IntegrationUri intrinsic — reduced to a Lambda ARN by resolveArnLike.
  integrationUri: unknown;
  payloadFormatVersion?: string;
  timeoutInMillis?: number;
}

export interface ApiRouteResource {
  type: 'apigw-route';
  logicalId: string;
  name: string;
  apiRef?: string;
  // Verbatim RouteKey ('METHOD /path' or '$default').
  routeKey: string;
  // Uppercase method ('ANY' for $default / '*').
  method: string;
  // Normalized path (leading slash; '$default' kept verbatim).
  path: string;
  // Integration logical id parsed out of Target ("integrations/<id>").
  integrationRef?: string;
  // AuthorizationType (NONE default, CUSTOM → Lambda authorizer, JWT/AWS_IAM unsupported).
  authorizationType: string;
  // Authorizer logical id parsed out of AuthorizerId ({Ref}).
  authorizerRef?: string;
}

export interface ApiAuthorizerResource {
  type: 'apigw-authorizer';
  logicalId: string;
  // The ::Authorizer Name property, else the logical id (stable authorizer key).
  name: string;
  apiRef?: string;
  authorizerType?: string;
  identitySource: string[];
  // Raw AuthorizerUri intrinsic — reduced to a Lambda ARN by resolveArnLike.
  authorizerUri: unknown;
  enableSimpleResponses: boolean;
  // AWS default '1.0'; serverless emits '2.0'. Carried through verbatim.
  authorizerPayloadFormatVersion: string;
  // AWS default 300; 0 disables caching.
  resultTtlInSeconds: number;
}

export interface LambdaPermissionResource {
  type: 'lambda-permission';
  logicalId: string;
  name: string;
  // Raw FunctionName intrinsic — reduced to a Lambda ARN by resolveArnLike.
  functionRef: unknown;
  action?: string;
  principal?: string;
  // Raw SourceArn intrinsic (the granting execute-api ARN).
  sourceArn: unknown;
}

export type Resource =
  | LambdaResource
  | DynamoDBResource
  | SQSResource
  | SNSResource
  | S3Resource
  | SecretsManagerResource
  | EventBusResource
  | EventRuleResource
  | OpenSearchCollectionResource
  | EventSourceMapping
  | ApiResource
  | ApiIntegrationResource
  | ApiRouteResource
  | ApiAuthorizerResource
  | LambdaPermissionResource;

// Context threaded into resolveArnLike so cross-stack IntegrationUri/AuthorizerUri/
// Permission.FunctionName reduce to concrete Lambda ARNs. `region`/`accountId`/
// `partition` feed pseudo-params; `lambdas` maps same-template logical ids to
// their resolved Lambda; `exports` is the cross-service Fn::ImportValue map.
export interface ArnResolutionContext {
  region: string;
  accountId: string;
  partition: string;
  lambdas: Map<string, LambdaResource>;
  // Same-template ::Api logical ids, so a `{Ref: HttpApi}` / `${HttpApi}` inside
  // a Permission SourceArn reduces instead of leaking a raw token.
  apis?: Map<string, ApiResource>;
  exports?: Map<string, string>;
  warnings?: string[];
}

export interface ResolvedArn {
  // The reduced value: a concrete ARN when resolvable, else a best-effort token.
  value: string;
  // True when the value is a concrete ARN/string usable for request-time lookup.
  resolved: boolean;
}

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
      case 'AWS::SecretsManager::Secret':
        return this.parseSecret(key, resource);
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
      case 'AWS::OpenSearchServerless::Collection':
        return this.parseOpenSearchCollection(key, resource);
      case 'AWS::ApiGatewayV2::Api':
        return this.parseApi(key, resource);
      case 'AWS::ApiGatewayV2::Integration':
        return this.parseApiIntegration(key, resource);
      case 'AWS::ApiGatewayV2::Route':
        return this.parseApiRoute(key, resource);
      case 'AWS::ApiGatewayV2::Authorizer':
        return this.parseApiAuthorizer(key, resource);
      case 'AWS::Lambda::Permission':
        return this.parseLambdaPermission(key, resource);
      case 'AWS::OpenSearchServerless::SecurityPolicy':
      case 'AWS::OpenSearchServerless::AccessPolicy':
      case 'AWS::OpenSearchServerless::VpcEndpoint':
        // Nothing enforces encryption/network/data-access policies locally —
        // accepting them silently would fake a security posture.
        warnings?.push(`${resource.Type} "${key}" is a no-op locally — the local engines do not enforce OpenSearch Serverless policies.`);
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
      redrivePolicy: this.parseRedrivePolicy(props.RedrivePolicy),
    };
  }

  // AWS::SQS::Queue.RedrivePolicy is an OBJECT in CloudFormation (the SQS API
  // takes the same thing as a JSON *string* attribute — the provisioner does
  // that conversion). Its deadLetterTargetArn is almost always an intrinsic:
  // `Fn::GetAtt: [OrdersDlq, Arn]`, which extractArn reduces to "OrdersDlq::Arn"
  // for the provisioner's logical-id resolver. A policy we cannot make sense of
  // is dropped rather than half-carried — the queue is still provisioned, just
  // without redrive.
  private parseRedrivePolicy(raw: unknown): SQSRedrivePolicy | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const policy = raw as Record<string, unknown>;
    const deadLetterTargetRef = this.extractArn(policy.deadLetterTargetArn);
    const maxReceiveCount = Math.trunc(Number(policy.maxReceiveCount));
    if (!deadLetterTargetRef || !Number.isFinite(maxReceiveCount) || maxReceiveCount < 1) {
      return undefined;
    }
    return { deadLetterTargetRef, maxReceiveCount };
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

    const parsed: S3Resource = {
      type: 's3',
      logicalId: key,
      name: (props.BucketName as string) || key,
      versioningEnabled: versioning?.Status === 'Enabled',
      notifications,
    };

    const corsRules = this.parseCorsRules(props.CorsConfiguration);
    // Assign conditionally (like ttl/streamViewType) so a bucket with no
    // CorsConfiguration keeps NO corsRules key.
    if (corsRules.length > 0) {
      parsed.corsRules = corsRules;
    }

    return parsed;
  }

  private parseCorsRules(config: unknown): S3CorsRuleConfig[] {
    const corsConfig = config as { CorsRules?: unknown[] } | undefined;
    const rules: S3CorsRuleConfig[] = [];
    for (const raw of corsConfig?.CorsRules || []) {
      const rule = raw as Record<string, unknown>;
      const allowedMethods = toStringArray(rule.AllowedMethods);
      const allowedOrigins = toStringArray(rule.AllowedOrigins);
      // AllowedMethods and AllowedOrigins are both required by AWS — skip a rule
      // missing either.
      if (allowedMethods.length === 0 || allowedOrigins.length === 0) continue;

      const mapped: S3CorsRuleConfig = {
        allowedOrigins,
        allowedMethods,
        allowedHeaders: toStringArray(rule.AllowedHeaders),
        // CFN uses "ExposedHeaders"; the S3 wire/SDK member is "ExposeHeader(s)".
        exposeHeaders: toStringArray(rule.ExposedHeaders ?? rule.ExposeHeaders),
      };
      if (rule.Id !== undefined) mapped.id = String(rule.Id);
      // `!== undefined` guard so MaxAge:0 (a legal value) is preserved.
      const maxAge = rule.MaxAge ?? rule.MaxAgeSeconds;
      if (maxAge !== undefined) mapped.maxAgeSeconds = maxAge as number;
      rules.push(mapped);
    }
    return rules;
  }

  private parseSecret(key: string, resource: CloudFormationResource): SecretsManagerResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    const parsed: SecretsManagerResource = {
      type: 'secret',
      logicalId: key,
      // Name is optional in CFN — fall back to the logical id (like parseDynamoDB).
      name: (props.Name as string) || key,
      tags: Array.isArray(props.Tags)
        ? (props.Tags as Array<{ Key?: unknown; Value?: unknown }>).map(t => ({
            Key: String(t.Key ?? ''),
            Value: String(t.Value ?? ''),
          }))
        : [],
    };
    if (props.Description !== undefined) parsed.description = props.Description as string;
    if (props.KmsKeyId !== undefined) parsed.kmsKeyId = props.KmsKeyId as string;
    // SecretString and GenerateSecretString are mutually exclusive in AWS; copy
    // whichever is present verbatim (password synthesis happens at provision).
    if (props.SecretString !== undefined) parsed.secretString = props.SecretString as string;
    const gen = props.GenerateSecretString as Record<string, unknown> | undefined;
    if (gen && typeof gen === 'object') {
      parsed.generateSecretString = {
        secretStringTemplate: gen.SecretStringTemplate as string | undefined,
        generateStringKey: gen.GenerateStringKey as string | undefined,
        passwordLength: gen.PasswordLength as number | undefined,
        excludeCharacters: gen.ExcludeCharacters as string | undefined,
        excludeUppercase: gen.ExcludeUppercase as boolean | undefined,
        excludeLowercase: gen.ExcludeLowercase as boolean | undefined,
        excludeNumbers: gen.ExcludeNumbers as boolean | undefined,
        excludePunctuation: gen.ExcludePunctuation as boolean | undefined,
        includeSpace: gen.IncludeSpace as boolean | undefined,
        requireEachIncludedType: gen.RequireEachIncludedType as boolean | undefined,
      };
    }
    return parsed;
  }

  private parseOpenSearchCollection(key: string, resource: CloudFormationResource): OpenSearchCollectionResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'opensearch',
      logicalId: key,
      // An explicit Name is passed through untouched (CreateCollection
      // validates it); the logical-id fallback is bent into the AOSS naming
      // rule (3-32 chars, ^[a-z][a-z0-9-]*$) so it can actually provision.
      name: (props.Name as string) || this.collectionNameFromLogicalId(key),
      collectionType: props.Type as string | undefined,
      description: props.Description as string | undefined,
    };
  }

  private collectionNameFromLogicalId(key: string): string {
    let name = key.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
    if (name.length < 3) name = `col-${name}`.slice(0, 32);
    return name;
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

  private parseApi(key: string, resource: CloudFormationResource): ApiResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'apigw-api',
      logicalId: key,
      name: (props.Name as string) || key,
      protocolType: props.ProtocolType as string | undefined,
      cors: props.CorsConfiguration !== undefined,
    };
  }

  private parseApiIntegration(key: string, resource: CloudFormationResource): ApiIntegrationResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'apigw-integration',
      logicalId: key,
      name: key,
      apiRef: this.extractFunctionName(props.ApiId) || undefined,
      integrationType: props.IntegrationType as string | undefined,
      integrationUri: props.IntegrationUri,
      payloadFormatVersion: props.PayloadFormatVersion as string | undefined,
      timeoutInMillis: props.TimeoutInMillis as number | undefined,
    };
  }

  private parseApiRoute(key: string, resource: CloudFormationResource): ApiRouteResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    const routeKey = String(props.RouteKey ?? '');
    const { method, path } = this.parseRouteKey(routeKey);
    return {
      type: 'apigw-route',
      logicalId: key,
      name: key,
      apiRef: this.extractFunctionName(props.ApiId) || undefined,
      routeKey,
      method,
      path,
      integrationRef: this.parseIntegrationRef(props.Target),
      authorizationType: (props.AuthorizationType as string) || 'NONE',
      authorizerRef: this.extractFunctionName(props.AuthorizerId) || undefined,
    };
  }

  private parseApiAuthorizer(key: string, resource: CloudFormationResource): ApiAuthorizerResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    const ttl = Number(props.AuthorizerResultTtlInSeconds);
    return {
      type: 'apigw-authorizer',
      logicalId: key,
      name: (props.Name as string) || key,
      apiRef: this.extractFunctionName(props.ApiId) || undefined,
      authorizerType: props.AuthorizerType as string | undefined,
      identitySource: toStringArray(props.IdentitySource),
      authorizerUri: props.AuthorizerUri,
      enableSimpleResponses: Boolean(props.EnableSimpleResponses),
      // AWS default is '1.0' when omitted; serverless emits '2.0'.
      authorizerPayloadFormatVersion: (props.AuthorizerPayloadFormatVersion as string) || '1.0',
      // AWS default 300; a literal 0 (disable caching) is preserved.
      resultTtlInSeconds: Number.isFinite(ttl) && ttl >= 0 ? ttl : 300,
    };
  }

  private parseLambdaPermission(key: string, resource: CloudFormationResource): LambdaPermissionResource {
    const props = (resource.Properties || {}) as Record<string, unknown>;
    return {
      type: 'lambda-permission',
      logicalId: key,
      name: key,
      functionRef: props.FunctionName,
      action: props.Action as string | undefined,
      principal: props.Principal as string | undefined,
      sourceArn: props.SourceArn,
    };
  }

  // RouteKey → { method, path }. '$default' (and '*') become an ANY catch-all;
  // otherwise "METHOD /path" splits into an uppercase method + normalized path.
  private parseRouteKey(routeKey: string): { method: string; path: string } {
    const trimmed = routeKey.trim();
    if (trimmed === '$default') return { method: 'ANY', path: '$default' };
    const [rawMethod, rawPath] = trimmed.split(/\s+/);
    const method = (rawMethod || 'ANY').toUpperCase();
    return {
      method: method === '*' ? 'ANY' : method,
      path: this.normalizeRoutePath(rawPath || '/'),
    };
  }

  // Same normalization as ServerlessStateParser.normalizePath so raw routes and
  // state routes share one dedup key space. '$default' never reaches here —
  // parseRouteKey returns it before splitting a method off.
  private normalizeRoutePath(path: string): string {
    const trimmed = path.trim().replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '/') return '/';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  // Target names the ::Integration in one of three shapes:
  //   'integrations/<IntegrationLogicalId>'                        (literal)
  //   Fn::Join['/', ['integrations', {Ref: <IntegrationLogicalId>}]]
  //   Fn::Sub 'integrations/${<IntegrationLogicalId>}'
  // The Fn::Join form is what the Serverless Framework compiles for an
  // `httpApi:` event; the Fn::Sub form is what a hand-written `resources:`
  // block emits (`Target: !Sub 'integrations/${MyIntegration}'`) and is by far
  // the most common idiom in real serverless.yml files — missing it left
  // integrationRef undefined and silently skipped every such route.
  private parseIntegrationRef(target: unknown): string | undefined {
    if (typeof target === 'string') return this.integrationIdFromTarget(target);
    if (target && typeof target === 'object') {
      const sub = (target as Record<string, unknown>)['Fn::Sub'];
      if (sub !== undefined) {
        // Fn::Sub's list form is [template, vars] — the template comes first.
        const template = Array.isArray(sub) ? sub[0] : sub;
        return typeof template === 'string' ? this.integrationIdFromTarget(template) : undefined;
      }
      const join = (target as Record<string, unknown>)['Fn::Join'];
      if (Array.isArray(join) && Array.isArray(join[1])) {
        const parts = join[1] as unknown[];
        const last = parts[parts.length - 1];
        if (typeof last === 'string') return last;
        if (last && typeof last === 'object' && 'Ref' in (last as Record<string, unknown>)) {
          return String((last as Record<string, unknown>).Ref);
        }
      }
    }
    return undefined;
  }

  // 'integrations/<id>' → <id>, unwrapping a lone Fn::Sub token so
  // 'integrations/${MyIntegration}' yields 'MyIntegration' too.
  private integrationIdFromTarget(target: string): string | undefined {
    const match = /^integrations\/(.+)$/.exec(target.trim());
    if (!match) return undefined;
    const id = match[1].trim();
    const token = /^\$\{([^}]+)\}$/.exec(id);
    return token ? token[1].trim() : id;
  }

  // General intrinsic → ARN-like reducer for IntegrationUri/AuthorizerUri/
  // Permission.FunctionName. Extends the Ref/Fn::GetAtt handling with Fn::Sub,
  // Fn::ImportValue and Fn::Join, resolving same-template Lambda logical ids to
  // ARNs and substituting the AWS::Region/AccountId/Partition pseudo-params.
  resolveArnLike(ref: unknown, ctx: ArnResolutionContext): ResolvedArn {
    if (ref === undefined || ref === null) return { value: '', resolved: false };
    if (typeof ref === 'string') return { value: ref, resolved: ref.length > 0 };
    if (typeof ref !== 'object') return { value: '', resolved: false };
    const obj = ref as Record<string, unknown>;

    if ('Ref' in obj) {
      const id = String(obj.Ref);
      // {"Ref": "AWS::Region"} & friends: the Serverless Framework compiles
      // SourceArn/AuthorizerUri as an Fn::Join over pseudo-parameter Refs, so
      // these must reduce here too — not only inside Fn::Sub's ${} tokens.
      const pseudo = this.pseudoParam(id, ctx);
      if (pseudo !== undefined) return { value: pseudo, resolved: true };
      const lambda = ctx.lambdas.get(id);
      if (lambda) return { value: this.lambdaArn(lambda, ctx), resolved: true };
      // A Ref to an ::Api yields its API id in AWS; locally the closest stable
      // stand-in is the API's name (this only ever feeds the advisory SourceArn).
      const api = ctx.apis?.get(id);
      if (api) return { value: api.name, resolved: true };
      return { value: id, resolved: false };
    }

    if ('Fn::GetAtt' in obj) {
      const raw = obj['Fn::GetAtt'];
      const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split('.');
      const lambda = ctx.lambdas.get(parts[0]);
      if (lambda && parts[1] === 'Arn') return { value: this.lambdaArn(lambda, ctx), resolved: true };
      return { value: parts.filter(Boolean).join('.'), resolved: false };
    }

    if ('Fn::Sub' in obj) return this.resolveSub(obj['Fn::Sub'], ctx);

    if ('Fn::ImportValue' in obj) {
      const name = this.resolveArnLike(obj['Fn::ImportValue'], ctx).value;
      const exported = ctx.exports?.get(name);
      if (exported !== undefined) return { value: exported, resolved: true };
      ctx.warnings?.push(`Fn::ImportValue "${name}" is not among the known stack exports — keeping the literal token; register the exporting service with LSS.`);
      return { value: name, resolved: false };
    }

    if ('Fn::Join' in obj) {
      const join = obj['Fn::Join'];
      if (Array.isArray(join) && Array.isArray(join[1])) {
        const delim = String(join[0] ?? '');
        const parts = (join[1] as unknown[]).map(part => this.resolveArnLike(part, ctx));
        return { value: parts.map(p => p.value).join(delim), resolved: parts.every(p => p.resolved) };
      }
      return { value: '', resolved: false };
    }

    return { value: '', resolved: false };
  }

  private resolveSub(sub: unknown, ctx: ArnResolutionContext): ResolvedArn {
    let template: string;
    let vars: Record<string, unknown> = {};
    if (typeof sub === 'string') {
      template = sub;
    } else if (Array.isArray(sub)) {
      template = String(sub[0] ?? '');
      if (sub[1] && typeof sub[1] === 'object') vars = sub[1] as Record<string, unknown>;
    } else {
      return { value: '', resolved: false };
    }

    const value = template.replace(/\$\{([^}]+)\}/g, (_match, token: string) => {
      const key = token.trim();
      const pseudo = this.pseudoParam(key, ctx);
      if (pseudo !== undefined) return pseudo;
      if (key in vars) return this.resolveArnLike(vars[key], ctx).value;
      // Both `${LogicalId}` and the GetAtt-style `${LogicalId.Arn}` name the
      // same Lambda — the attribute suffix is dropped because a Lambda ARN is
      // the only attribute LSS resolves.
      const lambda = ctx.lambdas.get(key.split('.')[0]);
      if (lambda) return this.lambdaArn(lambda, ctx);
      // `${HttpApi}` in a Permission SourceArn refers to the framework's ::Api.
      const api = ctx.apis?.get(key.split('.')[0]);
      if (api) return api.name;
      return `\${${token}}`;
    });
    return { value, resolved: !value.includes('${') };
  }

  // The CloudFormation pseudo-parameters LSS can answer, shared by Ref and
  // Fn::Sub. `undefined` means "not a pseudo-parameter" (a real logical id).
  private pseudoParam(key: string, ctx: ArnResolutionContext): string | undefined {
    if (key === 'AWS::Region') return ctx.region;
    if (key === 'AWS::AccountId') return ctx.accountId;
    if (key === 'AWS::Partition') return ctx.partition;
    return undefined;
  }

  private lambdaArn(lambda: LambdaResource, ctx: ArnResolutionContext): string {
    return `arn:${ctx.partition}:lambda:${ctx.region}:${ctx.accountId}:function:${lambda.name}`;
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

// Coerce a CFN list (or a lone string) into a string[]; anything else → [].
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}
