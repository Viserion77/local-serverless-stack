import { DynamoDBClient, CreateTableCommand, ListTablesCommand, DeleteTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, CreateQueueCommand, ListQueuesCommand, GetQueueAttributesCommand, DeleteQueueCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { SNSClient, CreateTopicCommand, ListTopicsCommand, DeleteTopicCommand } from '@aws-sdk/client-sns';
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
import { LambdaClient, CreateFunctionCommand, GetFunctionCommand, DeleteFunctionCommand, AddPermissionCommand, UpdateFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { CreateEventSourceMappingCommand, ListEventSourceMappingsCommand, DeleteEventSourceMappingCommand } from '@aws-sdk/client-lambda';
import {
  EventBridgeClient,
  CreateEventBusCommand,
  DeleteEventBusCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  DeleteRuleCommand,
} from '@aws-sdk/client-eventbridge';
import { LocalStackManager } from './localstack-manager.js';
import { ConfigManager } from './config-manager.js';
import { SeedManager } from './seed-manager.js';
import type {
  Resource,
  DynamoDBResource,
  SQSResource,
  SNSResource,
  S3Resource,
  EventBusResource,
  EventRuleResource,
  EventSourceMapping,
} from './cloudformation-parser.js';
import AdmZip from 'adm-zip';

export class ResourceProvisioner {
  private static instance: ResourceProvisioner;
  private dynamoClient!: DynamoDBClient;
  private sqsClient!: SQSClient;
  private snsClient!: SNSClient;
  private s3Client!: S3Client;
  private lambdaClient!: LambdaClient;
  private eventBridgeClient!: EventBridgeClient;
  private currentRegion: string = 'us-east-1';
  // CFN logical id → resource snapshot for the service currently being
  // provisioned. Lets resolveEventSourceArn map Fn::GetAtt references
  // (e.g. "OrderProcessingQueue") to the real resource name in LocalStack
  // (e.g. "pro-sample-microservice-OrderProcessing") even when the user
  // sets an explicit TableName/QueueName that doesn't match the logical id.
  private resourcesByLogicalId = new Map<string, Resource>();

  private constructor() {
    this.initializeClients(this.currentRegion);
  }

  static getInstance(): ResourceProvisioner {
    if (!ResourceProvisioner.instance) {
      ResourceProvisioner.instance = new ResourceProvisioner();
    }
    return ResourceProvisioner.instance;
  }

  private initializeClients(region: string): void {
    const baseConfig = LocalStackManager.getInstance().getConfig();
    const config = {
      ...baseConfig,
      region: region,
    };
    this.dynamoClient = new DynamoDBClient(config);
    this.sqsClient = new SQSClient(config);
    this.snsClient = new SNSClient(config);
    // forcePathStyle is required so LocalStack receives bucket name in the URL path
    // rather than as a virtual-host subdomain (which resolves to host.docker.internal).
    this.s3Client = new S3Client({ ...config, forcePathStyle: true });
    this.lambdaClient = new LambdaClient(config);
    this.eventBridgeClient = new EventBridgeClient(config);
  }

  getS3Client(): S3Client {
    return this.s3Client;
  }

  getCurrentRegion(): string {
    return this.currentRegion;
  }

  async provisionResources(
    serviceName: string,
    resources: Resource[],
    metadata?: { invokePort?: number; invokeUrl?: string; region?: string },
  ): Promise<void> {
    // Update clients if region has changed
    if (metadata?.region && metadata.region !== this.currentRegion) {
      this.currentRegion = metadata.region;
      this.initializeClients(this.currentRegion);
    }
    SeedManager.getInstance().setRegion(this.currentRegion);

    // The default callback host is overridable (lambdaRuntime.invokeHost /
    // LSS_INVOKE_HOST) for setups where "host.docker.internal" doesn't reach
    // the orchestrator — e.g. Docker-in-Docker devcontainers.
    const invokeUrl = metadata?.invokeUrl
      || (metadata?.invokePort ? `http://${ConfigManager.getInstance().getInvokeHost()}:${metadata.invokePort}` : undefined);

    // Rebuild the logical id map for this service so resolveEventSourceArn can
    // jump straight from "OrderProcessingQueue" to the actual queue name.
    this.resourcesByLogicalId.clear();
    for (const r of resources) {
      if ('logicalId' in r && r.logicalId) {
        this.resourcesByLogicalId.set(r.logicalId, r);
      }
    }

    let provisionedCount = 0;

    // First pass: Create infrastructure resources (DynamoDB, SQS, SNS, S3)
    // Lambda functions are handled by Serverless Offline, not LocalStack
    for (const resource of resources) {
      try {
        switch (resource.type) {
          case 'dynamodb':
            await this.createDynamoDBTable(resource);
            provisionedCount++;
            break;
          case 'sqs':
            await this.createSQSQueue(resource);
            provisionedCount++;
            break;
          case 'sns':
            await this.createSNSTopic(resource);
            provisionedCount++;
            break;
          case 's3':
            await this.createS3Bucket(resource);
            provisionedCount++;
            break;
          case 'eventbus':
            await this.createEventBus(resource);
            provisionedCount++;
            break;
        }
      } catch (error: any) {
        if (!error.message?.includes('already exists')) {
          const resourceName = 'name' in resource ? resource.name : resource.functionName;
          console.error(`Failed to provision ${resource.type}:${resourceName}:`, error.message);
        }
      }
    }

    // Second pass: Create event source mappings (which will create Lambda proxies if needed)
    const eventSources = resources.filter(r => r.type === 'event-source') as EventSourceMapping[];
    for (const eventSource of eventSources) {
      try {
        await this.createEventSourceMapping(serviceName, eventSource, invokeUrl);
        provisionedCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorName = error instanceof Error && 'name' in error ? (error as {name: string}).name : '';
        if (!errorMessage.includes('already exists') && errorName !== 'ResourceConflictException') {
          console.error(`Failed to provision event-source for ${eventSource.functionName}:`, errorMessage);
        }
      }
    }

    // EventBridge rules ride the same proxy model as event source mappings:
    // rule + pattern on the bus → Lambda proxy in LocalStack → LSS invoke API.
    const eventRules = resources.filter(r => r.type === 'event-rule') as EventRuleResource[];
    for (const rule of eventRules) {
      try {
        await this.createEventRule(serviceName, rule, invokeUrl);
        provisionedCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Failed to provision event-rule ${rule.name}:`, errorMessage);
      }
    }

    // Third pass: Wire S3 bucket notifications to Lambda proxies.
    // Done after event-source pass so proxies created there are available; the
    // wiring also creates a proxy on demand when only S3 (no SQS/Dynamo) triggers it.
    const s3Resources = resources.filter(r => r.type === 's3') as S3Resource[];
    for (const bucket of s3Resources) {
      if (!bucket.notifications || bucket.notifications.length === 0) continue;
      try {
        await this.configureS3Notifications(serviceName, bucket, invokeUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Failed to configure S3 notifications for ${bucket.name}:`, errorMessage);
      }
    }

    console.log(`✅ Provisioned ${provisionedCount} resources for ${serviceName}`);
  }

  private async createDynamoDBTable(resource: DynamoDBResource): Promise<void> {
    try {
      // Ensure attribute definitions include all attributes referenced by KeySchema and GSIs/LSIs
      const attributeDefinitions = [...(resource.attributeDefinitions || [])];
      const defined = new Set(attributeDefinitions.map(a => a.AttributeName));

      const required = new Set<string>();
      resource.keySchema.forEach(k => required.add(k.AttributeName));

// Look for GSI/LSI keys inside the resource
    const gsiList = resource.globalSecondaryIndexes || [];
    const lsiList = resource.localSecondaryIndexes || [];
    const collectIndexKeys = (indexes: DynamoDBResource['globalSecondaryIndexes']) => {
      /* istanbul ignore next: callers always pass `?? []` arrays, so `indexes` is never nullish */
      if (!indexes) return;
      indexes.forEach(idx => {
        (idx.KeySchema || []).forEach(k => required.add(k.AttributeName));
        });
      };
      collectIndexKeys(gsiList);
      collectIndexKeys(lsiList);

      for (const attr of required) {
        if (!defined.has(attr)) {
          attributeDefinitions.push({ AttributeName: attr, AttributeType: 'S' });
        }
      }

      await this.dynamoClient.send(
        new CreateTableCommand({
          TableName: resource.name,
          KeySchema: resource.keySchema as any,
          AttributeDefinitions: attributeDefinitions as any,
          BillingMode: resource.billingMode as any,
          GlobalSecondaryIndexes: (resource.globalSecondaryIndexes || []).length
            ? (resource.globalSecondaryIndexes as any)
            : undefined,
          LocalSecondaryIndexes: (resource.localSecondaryIndexes || []).length
            ? (resource.localSecondaryIndexes as any)
            : undefined,
          StreamSpecification: resource.streamEnabled
            ? {
                StreamEnabled: true,
                StreamViewType: resource.streamViewType || 'NEW_AND_OLD_IMAGES',
              }
            : undefined,
        }),
      );
      console.log(`  ✓ Created DynamoDB table: ${resource.name}`);
      SeedManager.getInstance().seedOnTableCreated(resource.name, this.currentRegion);
  } catch (error) {
    const errorName = error instanceof Error && 'name' in error ? (error as {name: string}).name : '';
    if (errorName === 'ResourceInUseException') {
        // Table already exists, ignore
      } else {
        throw error;
      }
    }
    // Applied to pre-existing tables too, so tables created before LSS knew
    // about TTL pick it up on re-registration.
    await this.applyTimeToLive(resource);
  }

  private async applyTimeToLive(resource: DynamoDBResource): Promise<void> {
    if (!resource.ttl) return;
    try {
      await this.dynamoClient.send(
        new UpdateTimeToLiveCommand({
          TableName: resource.name,
          TimeToLiveSpecification: { AttributeName: resource.ttl.attributeName, Enabled: resource.ttl.enabled },
        }),
      );
      const state = resource.ttl.enabled ? 'Enabled' : 'Disabled';
      console.log(`  ✓ ${state} TTL on ${resource.name} (attribute: ${resource.ttl.attributeName})`);
    } catch (error: any) {
      // Re-registering re-sends the same TTL state, which DynamoDB rejects with
      // "TimeToLive is already enabled/disabled" — that's the steady state, not
      // a failure.
      if (!/already (enabled|disabled)/i.test(String(error?.message || ''))) {
        console.warn(`  ⚠ Failed to update TTL on ${resource.name}: ${error?.message || error}`);
      }
    }
  }

  private async createSQSQueue(resource: SQSResource): Promise<void> {
    try {
      const attributes: Record<string, string> = {};

      if (resource.visibilityTimeout) {
        attributes.VisibilityTimeout = resource.visibilityTimeout.toString();
      }
      if (resource.messageRetentionPeriod) {
        attributes.MessageRetentionPeriod = resource.messageRetentionPeriod.toString();
      }
      if (resource.fifoQueue) {
        attributes.FifoQueue = 'true';
        if (resource.contentBasedDeduplication) {
          attributes.ContentBasedDeduplication = 'true';
        }
      }

      await this.sqsClient.send(
        new CreateQueueCommand({
          QueueName: resource.name,
          Attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        }),
      );
      console.log(`  ✓ Created SQS queue: ${resource.name}`);
    } catch (error: any) {
      if (error.name === 'QueueAlreadyExists') {
        console.log(`  ⚠ SQS queue already exists: ${resource.name}`);
      } else {
        throw error;
      }
    }
  }

  private async createSNSTopic(resource: SNSResource): Promise<void> {
    try {
      await this.snsClient.send(
        new CreateTopicCommand({
          Name: resource.name,
        }),
      );
      console.log(`  ✓ Created SNS topic: ${resource.name}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`  ⚠ SNS topic already exists: ${resource.name}`);
      } else {
        throw error;
      }
    }
  }

  private async createS3Bucket(resource: S3Resource): Promise<void> {
    try {
      await this.s3Client.send(new CreateBucketCommand({ Bucket: resource.name }));
      console.log(`  ✓ Created S3 bucket: ${resource.name}`);
    } catch (error: any) {
      const name = error?.name || '';
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
        console.log(`  ⚠ S3 bucket already exists: ${resource.name}`);
      } else {
        throw error;
      }
    }

    if (resource.versioningEnabled) {
      try {
        await this.s3Client.send(
          new PutBucketVersioningCommand({
            Bucket: resource.name,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.warn(`  ⚠ Failed to enable versioning on ${resource.name}: ${msg}`);
      }
    }
  }

  private async configureS3Notifications(
    serviceName: string,
    bucket: S3Resource,
    invokeUrl?: string,
  ): Promise<void> {
    const lambdaConfigurations = [];

    for (const notif of bucket.notifications) {
      // Both the LocalStack proxy and the offline invoke URL use the same
      // fully-qualified Lambda name pulled straight from the CFN template.
      const actualFunctionName = this.resolveLambdaName(serviceName, notif.functionRef);
      await this.ensureLambdaProxyExists(serviceName, actualFunctionName, actualFunctionName, invokeUrl);

      // Allow S3 to invoke the Lambda. LocalStack enforces this when the bucket fires.
      try {
        await this.lambdaClient.send(
          new AddPermissionCommand({
            FunctionName: actualFunctionName,
            StatementId: `s3-invoke-${bucket.name}`,
            Action: 'lambda:InvokeFunction',
            Principal: 's3.amazonaws.com',
            SourceArn: `arn:aws:s3:::${bucket.name}`,
          }),
        );
      } catch (error: any) {
        // ResourceConflictException = statement already exists, which is fine.
        if (error?.name !== 'ResourceConflictException') {
          console.warn(`  ⚠ Could not add S3 invoke permission for ${actualFunctionName}: ${error?.message || error}`);
        }
      }

      const lambdaArn = `arn:aws:lambda:${this.currentRegion}:000000000000:function:${actualFunctionName}`;
      const filterRules: Array<{ Name: 'prefix' | 'suffix'; Value: string }> = [];
      if (notif.filterPrefix) filterRules.push({ Name: 'prefix', Value: notif.filterPrefix });
      if (notif.filterSuffix) filterRules.push({ Name: 'suffix', Value: notif.filterSuffix });

      lambdaConfigurations.push({
        LambdaFunctionArn: lambdaArn,
        Events: notif.events as any,
        Filter: filterRules.length
          ? { Key: { FilterRules: filterRules } }
          : undefined,
      });
    }

    if (lambdaConfigurations.length === 0) return;

    await this.s3Client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket.name,
        NotificationConfiguration: { LambdaFunctionConfigurations: lambdaConfigurations as any },
        // LocalStack Pro performs the same test-invoke validation real S3 does,
        // and rejects the config with "Unable to validate the following
        // destination configurations" if the Lambda permission hasn't fully
        // propagated yet. The community image is lax about this, but Pro isn't.
        // We add the lambda:InvokeFunction permission above; this flag tells S3
        // to trust us rather than synchronously probe the destination.
        SkipDestinationValidation: true,
      }),
    );
    console.log(`  ✓ Wired ${lambdaConfigurations.length} S3 notification(s) on bucket: ${bucket.name}`);
  }

  // Strips Serverless's "LambdaFunction" CFN suffix and lowercases the first char.
  // Used only as a fallback when we can't find the lambda in the parsed CFN.
  private shortFunctionName(cfnName: string): string {
    let funcName = cfnName;
    if (funcName.endsWith('LambdaFunction')) {
      funcName = funcName.slice(0, -14);
    }
    return funcName.charAt(0).toLowerCase() + funcName.slice(1);
  }

  // The fully-qualified Lambda name `${service}-${stage}-${key}` is what
  // serverless-offline registers on its invoke port (lambdaPort). Anything
  // shorter (short key, or wrong stage) makes offline return 404 "Function not
  // found". The CFN template that `sls package` emits already sets this exact
  // name in each Lambda's FunctionName property — read it from there rather
  // than reconstructing it from pieces.
  private resolveLambdaName(serviceName: string, logicalId: string): string {
    const resource = this.resourcesByLogicalId.get(logicalId);
    if (resource && resource.type === 'lambda') {
      return resource.name;
    }
    // Fallback for templates whose Lambda block didn't reach the parser.
    // Old default assumed stage "api"; keep it as last resort.
    return `${serviceName}-api-${this.shortFunctionName(logicalId)}`;
  }

  // `proxyName` is the function name registered in LocalStack (the trigger target).
  // `invokeName` is the function key serverless-offline exposes — must be the short
  // form (without service/stage prefix) because that's what offline routes on.
  private generateProxyLambdaCode(_proxyName: string, invokeName: string, invokeUrl: string): string {
    return `
export const handler = async (event, context) => {
  const http = await import('http');
  const url = await import('url');

  const invokeUrl = process.env.INVOKE_URL || '${invokeUrl}';
  const parsedUrl = url.parse(invokeUrl);

  // SQS/DynamoDB/SNS deliver batches under Records; EventBridge delivers the
  // event object itself (source / detail-type / detail) with no wrapper — real
  // AWS Lambda targets read event.detail directly, so wrapping it would break
  // handlers written for production. Wrap only non-EventBridge-shaped events.
  let transformedEvent = event;
  const isEventBridgeEvent = Boolean(event && event['detail-type'] !== undefined && event.source !== undefined);
  if (!event.Records && !isEventBridgeEvent) {
    transformedEvent = {
      Records: [event]
    };
  }

  const payload = JSON.stringify(transformedEvent);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: '/2015-03-31/functions/${invokeName}/invocations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Amz-Invocation-Type': 'RequestResponse'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            // Try to parse as JSON
            const response = JSON.parse(data);
            resolve(response);
          } catch (e) {
            // If not JSON, return as string
            resolve(data);
          }
        } else {
          reject(new Error(\`Lambda invoke failed: \${res.statusCode} \${data}\`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('Request error:', err);
      reject(err);
    });
    
    req.write(payload);
    req.end();
  });
};
`;
  }

  private async createEventSourceMapping(serviceName: string, mapping: EventSourceMapping, invokeUrl?: string): Promise<void> {
    try {
      // Use the fully-qualified Lambda name straight from the CFN template
      // (e.g. "pro-sample-microservice-dev-processOrderQueue"). This is what
      // serverless-offline's invoke endpoint (lambdaPort) requires; shorter
      // forms return 404 "Function not found".
      const actualFunctionName = this.resolveLambdaName(serviceName, mapping.functionName);

      // Resolve queue ARN from queue name
      const eventSourceArn = await this.resolveEventSourceArn(mapping.eventSourceArn);

      // Create Lambda proxy function if it doesn't exist
      await this.ensureLambdaProxyExists(serviceName, actualFunctionName, actualFunctionName, invokeUrl);

      // Check if mapping already exists — compare against the RESOLVED arn:
      // `mapping.eventSourceArn` may still be a CFN ref ("IdentityTable::StreamArn")
      // that no live mapping's EventSourceArn would ever contain.
      const existingMappings = await this.lambdaClient.send(
        new ListEventSourceMappingsCommand({
          FunctionName: actualFunctionName,
        }),
      );

      if (existingMappings.EventSourceMappings?.some(m => m.EventSourceArn === eventSourceArn)) {
        console.log(`  ⚠ Event source mapping already exists: ${actualFunctionName} <- ${eventSourceArn}`);
        return;
      }

      // Stream-based sources (DynamoDB Streams, Kinesis) require StartingPosition;
      // SQS forbids it (as it does MaximumRetryAttempts/DestinationConfig).
      // Detect from the resolved ARN service segment.
      const isStreamSource = eventSourceArn.startsWith('arn:aws:dynamodb:')
        || eventSourceArn.startsWith('arn:aws:kinesis:');

      // The OnFailure destination may itself be a CFN ref to a DLQ/topic.
      let destinationConfig: { OnFailure: { Destination: string } } | undefined;
      if (isStreamSource && mapping.onFailureDestination) {
        try {
          destinationConfig = {
            OnFailure: { Destination: await this.resolveEventSourceArn(mapping.onFailureDestination) },
          };
        } catch (error: any) {
          console.warn(`  ⚠ Could not resolve OnFailure destination ${mapping.onFailureDestination}: ${error?.message || error}`);
        }
      }

      await this.lambdaClient.send(
        new CreateEventSourceMappingCommand({
          FunctionName: actualFunctionName,
          EventSourceArn: eventSourceArn,
          BatchSize: mapping.batchSize || 10,
          Enabled: mapping.enabled,
          StartingPosition: isStreamSource ? (mapping.startingPosition as any) || 'TRIM_HORIZON' : undefined,
          MaximumRetryAttempts: isStreamSource ? mapping.maximumRetryAttempts : undefined,
          DestinationConfig: destinationConfig,
          MaximumBatchingWindowInSeconds: mapping.maximumBatchingWindowInSeconds,
          FunctionResponseTypes: mapping.functionResponseTypes as any,
          FilterCriteria: mapping.filterCriteria as any,
        }),
      );
      console.log(`  ✓ Created event source mapping: ${actualFunctionName} <- ${mapping.eventSourceArn}`);
    } catch (error: any) {
      if (error.name === 'ResourceConflictException') {
        console.log(`  ⚠ Event source mapping already exists: ${mapping.functionName}`);
      } else {
        throw error;
      }
    }
  }

  private async createEventBus(resource: EventBusResource): Promise<void> {
    try {
      await this.eventBridgeClient.send(new CreateEventBusCommand({ Name: resource.name }));
      console.log(`  ✓ Created EventBridge bus: ${resource.name}`);
    } catch (error: any) {
      if (error?.name === 'ResourceAlreadyExistsException') {
        console.log(`  ⚠ EventBridge bus already exists: ${resource.name}`);
      } else {
        throw error;
      }
    }
  }

  // Resolve a rule's EventBusName: a logical id from the same template maps to
  // the provisioned bus name; anything else is a literal name/ARN, both of
  // which PutRule/PutTargets accept. Undefined targets the default bus.
  private resolveEventBusName(busRef?: string): string | undefined {
    if (!busRef) return undefined;
    const direct = this.resourcesByLogicalId.get(busRef);
    if (direct && direct.type === 'eventbus') {
      return direct.name;
    }
    return busRef;
  }

  private async createEventRule(serviceName: string, rule: EventRuleResource, invokeUrl?: string): Promise<void> {
    if (rule.eventBusUnresolved) {
      // Binding it to the default bus instead would "work" but never match the
      // producers' events — skipping with a warning is the honest failure.
      console.warn(`  ⚠ Skipped EventBridge rule ${rule.name}: EventBusName could not be resolved from the template (e.g. Fn::ImportValue).`);
      return;
    }

    const eventBusName = this.resolveEventBusName(rule.eventBusRef);

    // PutRule/PutTargets are upserts, so re-registration is naturally idempotent.
    await this.eventBridgeClient.send(
      new PutRuleCommand({
        Name: rule.name,
        EventBusName: eventBusName,
        EventPattern: rule.eventPattern ? JSON.stringify(rule.eventPattern) : undefined,
        ScheduleExpression: rule.scheduleExpression,
        State: rule.enabled ? 'ENABLED' : 'DISABLED',
      }),
    );
    console.log(`  ✓ Put EventBridge rule: ${rule.name}${eventBusName ? ` (bus: ${eventBusName})` : ''}`);

    const targets: Array<{ Id: string; Arn: string; Input?: string; InputPath?: string }> = [];
    for (const target of rule.targets) {
      // Targets arrive as logical ids (Fn::GetAtt) or literal Lambda ARNs.
      const actualFunctionName = target.functionRef.startsWith('arn:aws:')
        ? target.functionRef.split(':function:')[1]?.split(':')[0]
        : this.resolveLambdaName(serviceName, target.functionRef);
      if (!actualFunctionName) {
        console.warn(`  ⚠ Skipped EventBridge target ${target.id} on rule ${rule.name}: unsupported target ${target.functionRef}`);
        continue;
      }

      await this.ensureLambdaProxyExists(serviceName, actualFunctionName, actualFunctionName, invokeUrl);

      const ruleArn = `arn:aws:events:${this.currentRegion}:000000000000:rule/${eventBusName ? `${eventBusName}/` : ''}${rule.name}`;
      try {
        await this.lambdaClient.send(
          new AddPermissionCommand({
            FunctionName: actualFunctionName,
            StatementId: `events-invoke-${rule.name}`,
            Action: 'lambda:InvokeFunction',
            Principal: 'events.amazonaws.com',
            SourceArn: ruleArn,
          }),
        );
      } catch (error: any) {
        // ResourceConflictException = statement already exists, which is fine.
        if (error?.name !== 'ResourceConflictException') {
          console.warn(`  ⚠ Could not add EventBridge invoke permission for ${actualFunctionName}: ${error?.message || error}`);
        }
      }

      targets.push({
        Id: target.id,
        Arn: `arn:aws:lambda:${this.currentRegion}:000000000000:function:${actualFunctionName}`,
        Input: target.input,
        InputPath: target.inputPath,
      });
    }

    if (targets.length === 0) return;

    await this.eventBridgeClient.send(
      new PutTargetsCommand({
        Rule: rule.name,
        EventBusName: eventBusName,
        Targets: targets as any,
      }),
    );
    console.log(`  ✓ Wired ${targets.length} target(s) on EventBridge rule: ${rule.name}`);
  }

  private async ensureLambdaProxyExists(
    serviceName: string,
    proxyName: string,
    invokeName: string,
    invokeUrl?: string,
  ): Promise<void> {
    try {
      // Check if function already exists
      const existing = await this.lambdaClient.send(
        new GetFunctionCommand({
          FunctionName: proxyName,
        }),
      );
      // A proxy survives across registrations, but the orchestrator's ports may
      // not (project port renumbering, invokeHost change). Re-point a stale
      // proxy instead of leaving it calling the old URL forever.
      const currentUrl = existing.Configuration?.Environment?.Variables?.INVOKE_URL;
      if (invokeUrl && currentUrl !== invokeUrl) {
        await this.lambdaClient.send(
          new UpdateFunctionConfigurationCommand({
            FunctionName: proxyName,
            Environment: {
              Variables: {
                INVOKE_URL: invokeUrl,
                FUNCTION_NAME: invokeName,
              },
            },
          }),
        );
        console.log(`  ✓ Updated Lambda proxy INVOKE_URL: ${proxyName} -> ${invokeUrl}`);
      }
      return;
    } catch (error: any) {
      if (error.name !== 'ResourceNotFoundException') {
        throw error;
      }
    }

    if (!invokeUrl) {
      throw new Error(`Cannot create Lambda proxy for ${proxyName}: no invoke URL configured for ${serviceName}`);
    }

    const proxyCode = this.generateProxyLambdaCode(proxyName, invokeName, invokeUrl);
    const zip = new AdmZip();
    zip.addFile('index.mjs', Buffer.from(proxyCode, 'utf-8'));
    const zipBuffer = zip.toBuffer();

    await this.lambdaClient.send(
      new CreateFunctionCommand({
        FunctionName: proxyName,
        Runtime: 'nodejs20.x',
        Role: 'arn:aws:iam::000000000000:role/lambda-role',
        Handler: 'index.handler',
        Code: {
          ZipFile: zipBuffer,
        },
        Environment: {
          Variables: {
            INVOKE_URL: invokeUrl,
            FUNCTION_NAME: invokeName,
          },
        },
        MemorySize: 256,
        Timeout: 60,
      }),
    );
    console.log(`  ✓ Created Lambda proxy: ${proxyName} -> ${invokeUrl}/2015-03-31/functions/${invokeName}/invocations`);
  }

  private convertCamelCaseToKebab(camelCase: string): string {
    return camelCase
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');
  }

  private async resolveEventSourceArn(arnRef: string): Promise<string> {
    // If it's already a full ARN, return it
    if (arnRef.startsWith('arn:aws:')) {
      return arnRef;
    }

    // Extract logical id + attribute from Fn::GetAtt (e.g. "OrderProcessingQueue::Arn")
    const logicalId = arnRef.split('::')[0];

    // Direct lookup via the CFN logical id map — this works regardless of any
    // explicit QueueName/TableName/TopicName the user set, fixing the old bug
    // where we kebab-cased the logical id and tried to fuzzy-match.
    const direct = this.resourcesByLogicalId.get(logicalId);
    if (direct) {
      if (direct.type === 'sqs') {
        try {
          const urlResponse = await this.sqsClient.send(
            new GetQueueUrlCommand({ QueueName: direct.name }),
          );
          if (urlResponse.QueueUrl) {
            const attributes = await this.sqsClient.send(
              new GetQueueAttributesCommand({
                QueueUrl: urlResponse.QueueUrl,
                AttributeNames: ['QueueArn'],
              }),
            );
            const queueArn = attributes.Attributes?.QueueArn;
            if (queueArn) return queueArn;
          }
        } catch {
          // Fall through to the legacy fuzzy resolver below
        }
      } else if (direct.type === 'dynamodb') {
        // The real stream ARN includes a timestamp suffix, not the view type —
        // ask DynamoDB for LatestStreamArn rather than hand-crafting one.
        // CreateTable returns before the stream becomes available, so retry a
        // few times if the first describe comes back with no stream ARN.
        for (let i = 0; i < 5; i++) {
          try {
            const described = await this.dynamoClient.send(
              new DescribeTableCommand({ TableName: direct.name }),
            );
            const streamArn = described.Table?.LatestStreamArn;
            if (streamArn) return streamArn;
          } catch {
            // table may still be creating — fall through to retry
          }
          await new Promise(r => setTimeout(r, 300));
        }
      } else if (direct.type === 'sns') {
        return `arn:aws:sns:${this.currentRegion}:000000000000:${direct.name}`;
      }
    }

    // Legacy fallback: kebab-case match on actual resource lists. Kept for
    // templates whose logical ids weren't captured (e.g. handcrafted ARN refs).
    const resourceName = this.convertCamelCaseToKebab(logicalId);

    try {
      const queues = await this.sqsClient.send(new ListQueuesCommand({}));
      const queueUrl = queues.QueueUrls?.find(url => url.includes(resourceName));

      if (queueUrl) {
        const attributes = await this.sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ['QueueArn'],
          }),
        );

        const queueArn = attributes.Attributes?.QueueArn;
        if (queueArn) {
          return queueArn;
        }
      }
    } catch {
      // Continue to try other resource types
    }

    try {
      const tables = await this.dynamoClient.send(new ListTablesCommand({}));
      const tableMatch = tables.TableNames?.find(name =>
        this.convertCamelCaseToKebab(name) === resourceName
      );

      if (tableMatch) {
        const described = await this.dynamoClient.send(
          new DescribeTableCommand({ TableName: tableMatch }),
        );
        const streamArn = described.Table?.LatestStreamArn;
        if (streamArn) return streamArn;
      }
    } catch (_error) {
      // Continue to try other resource types
    }

    // Try to resolve as SNS topic
    try {
      const topics = await this.snsClient.send(new ListTopicsCommand({}));
      const topicMatch = topics.Topics?.find(topic => {
        const topicName = topic.TopicArn?.split(':').pop() || '';
        return this.convertCamelCaseToKebab(topicName) === resourceName;
      });

      if (topicMatch?.TopicArn) {
        return topicMatch.TopicArn;
      }
    } catch (_error) {
      // Continue
    }

    throw new Error(`Event source not found: ${arnRef} (resolved as: ${resourceName})`);
  }

  async listAllResources(region?: string): Promise<{
    tables: string[];
    queues: string[];
    topics: string[];
    buckets: string[];
  }> {
    const baseConfig = LocalStackManager.getInstance().getConfig();
    const config = region ? { ...baseConfig, region } : { ...baseConfig, region: this.currentRegion };
    const dynamo = region && region !== this.currentRegion ? new DynamoDBClient(config) : this.dynamoClient;
    const sqs = region && region !== this.currentRegion ? new SQSClient(config) : this.sqsClient;
    const sns = region && region !== this.currentRegion ? new SNSClient(config) : this.snsClient;
    const s3 = region && region !== this.currentRegion
      ? new S3Client({ ...config, forcePathStyle: true })
      : this.s3Client;

    const [tables, queues, topics, buckets] = await Promise.all([
      this.listDynamoDBTables(dynamo),
      this.listSQSQueues(sqs),
      this.listSNSTopics(sns),
      this.listS3Buckets(s3),
    ]);

    return { tables, queues, topics, buckets };
  }

  private async listDynamoDBTables(client: DynamoDBClient = this.dynamoClient): Promise<string[]> {
    try {
      const response = await client.send(new ListTablesCommand({}));
      return response.TableNames || [];
    } catch {
      return [];
    }
  }

  private async listSQSQueues(client: SQSClient = this.sqsClient): Promise<string[]> {
    try {
      const response = await client.send(new ListQueuesCommand({}));
      return response.QueueUrls?.map(url => url.split('/').pop()!) || [];
    } catch {
      return [];
    }
  }

  private async listSNSTopics(client: SNSClient = this.snsClient): Promise<string[]> {
    try {
      const response = await client.send(new ListTopicsCommand({}));
      return response.Topics?.map(t => {
        const arn = t.TopicArn?.split(':').pop();
        return arn || '';
      }).filter(arn => arn !== '') || [];
    } catch {
      return [];
    }
  }

  private async listS3Buckets(client: S3Client = this.s3Client): Promise<string[]> {
    try {
      const response = await client.send(new ListBucketsCommand({}));
      return response.Buckets?.map(b => b.Name || '').filter(n => n !== '') || [];
    } catch {
      return [];
    }
  }

  async cleanupResources(serviceName: string, resources: Resource[]): Promise<void> {
    if (!resources || resources.length === 0) {
      console.log(`No resources to clean up for ${serviceName}`);
      return;
    }

    // Rebuild the logical id map so event-rule cleanup can resolve which bus
    // each rule lives on (same lookup provisioning uses).
    this.resourcesByLogicalId.clear();
    for (const r of resources) {
      if ('logicalId' in r && r.logicalId) {
        this.resourcesByLogicalId.set(r.logicalId, r);
      }
    }

    let cleaned = 0;
    // Buses are deleted after the main loop: EventBridge refuses to delete a
    // bus that still has rules, and template order doesn't guarantee the rules
    // come first.
    const eventBuses: EventBusResource[] = [];
    for (const resource of resources) {
      try {
        switch (resource.type) {
          case 'dynamodb':
            await this.deleteDynamoDBTable(resource.name);
            cleaned++;
            break;
          case 'sqs':
            await this.deleteSQSQueue(resource.name);
            cleaned++;
            break;
          case 'sns':
            await this.deleteSNSTopic(resource.name);
            cleaned++;
            break;
          case 's3':
            await this.deleteS3Bucket(resource.name);
            cleaned++;
            break;
          case 'eventbus':
            eventBuses.push(resource);
            break;
          case 'event-rule':
            await this.deleteEventRule(resource);
            cleaned++;
            break;
          case 'event-source':
            await this.deleteEventSourceMapping(serviceName, resource.functionName);
            cleaned++;
            break;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const resourceName = 'name' in resource ? resource.name : resource.functionName;
        console.error(`Failed to cleanup ${resource.type}:${resourceName}:`, errorMessage);
      }
    }

    for (const bus of eventBuses) {
      try {
        await this.deleteEventBus(bus.name);
        cleaned++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Failed to cleanup eventbus:${bus.name}:`, errorMessage);
      }
    }

    console.log(`✅ Cleaned up ${cleaned} resources for ${serviceName}`);
  }

  private async deleteEventRule(rule: EventRuleResource): Promise<void> {
    const eventBusName = this.resolveEventBusName(rule.eventBusRef);
    try {
      if (rule.targets.length > 0) {
        await this.eventBridgeClient.send(
          new RemoveTargetsCommand({
            Rule: rule.name,
            EventBusName: eventBusName,
            Ids: rule.targets.map(t => t.id),
          }),
        );
      }
      await this.eventBridgeClient.send(
        new DeleteRuleCommand({ Name: rule.name, EventBusName: eventBusName }),
      );
      console.log(`Deleted EventBridge rule: ${rule.name}`);
    } catch (error: any) {
      if (error?.name !== 'ResourceNotFoundException') {
        throw error;
      }
    }
  }

  private async deleteEventBus(busName: string): Promise<void> {
    try {
      await this.eventBridgeClient.send(new DeleteEventBusCommand({ Name: busName }));
      console.log(`Deleted EventBridge bus: ${busName}`);
    } catch (error: any) {
      if (error?.name !== 'ResourceNotFoundException') {
        throw error;
      }
    }
  }

  private async deleteDynamoDBTable(tableName: string): Promise<void> {
    try {
      await this.dynamoClient.send(new DeleteTableCommand({ TableName: tableName }));
      console.log(`Deleted DynamoDB table: ${tableName}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('ResourceNotFoundException')) {
        throw error;
      }
    }
  }

  private async deleteSQSQueue(queueName: string): Promise<void> {
    try {
      const urlResponse = await this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: queueName })
      );
      if (urlResponse.QueueUrl) {
        await this.sqsClient.send(new DeleteQueueCommand({ QueueUrl: urlResponse.QueueUrl }));
        console.log(`Deleted SQS queue: ${queueName}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('NonExistentQueue')) {
        throw error;
      }
    }
  }

  private async deleteS3Bucket(bucketName: string): Promise<void> {
    try {
      // S3 buckets must be empty before deletion. Best-effort: drain a single page
      // of objects (this is cleanup for dev environments, not production data).
      const objects = await this.s3Client.send(
        new ListObjectsV2Command({ Bucket: bucketName }),
      );
      for (const obj of objects.Contents || []) {
        if (obj.Key) {
          await this.s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: obj.Key }));
        }
      }
      await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
      console.log(`Deleted S3 bucket: ${bucketName}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('NoSuchBucket')) {
        throw error;
      }
    }
  }

  private async deleteSNSTopic(topicName: string): Promise<void> {
    try {
      // Find the topic ARN from list
      const response = await this.snsClient.send(new ListTopicsCommand({}));
      const topic = response.Topics?.find(t => t.TopicArn?.endsWith(`:${topicName}`));
      
      if (topic?.TopicArn) {
        await this.snsClient.send(new DeleteTopicCommand({ TopicArn: topic.TopicArn }));
        console.log(`Deleted SNS topic: ${topicName}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('NotFound')) {
        throw error;
      }
    }
  }

  private async deleteEventSourceMapping(serviceName: string, functionName: string): Promise<void> {
    try {
      // List all event source mappings
      const response = await this.lambdaClient.send(
        new ListEventSourceMappingsCommand({ FunctionName: `${serviceName}-${functionName}-proxy` })
      );

      // Delete each mapping
      for (const mapping of response.EventSourceMappings || []) {
        if (mapping.UUID) {
          await this.lambdaClient.send(
            new DeleteEventSourceMappingCommand({ UUID: mapping.UUID })
          );
          console.log(`Deleted event source mapping: ${mapping.UUID}`);
        }
      }

      // Delete the Lambda proxy function
      await this.lambdaClient.send(
        new DeleteFunctionCommand({ FunctionName: `${serviceName}-${functionName}-proxy` })
      );
      console.log(`Deleted Lambda proxy: ${serviceName}-${functionName}-proxy`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('ResourceNotFoundException')) {
        throw error;
      }
    }
  }
}
