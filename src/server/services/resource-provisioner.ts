import { DynamoDBClient, CreateTableCommand, ListTablesCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
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
import { LambdaClient, CreateFunctionCommand, GetFunctionCommand, DeleteFunctionCommand, AddPermissionCommand } from '@aws-sdk/client-lambda';
import { CreateEventSourceMappingCommand, ListEventSourceMappingsCommand, DeleteEventSourceMappingCommand } from '@aws-sdk/client-lambda';
import { LocalStackManager } from './localstack-manager.js';
import { SeedManager } from './seed-manager.js';
import type {
  Resource,
  DynamoDBResource,
  SQSResource,
  SNSResource,
  S3Resource,
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
  private currentRegion: string = 'us-east-1';

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

    const invokeUrl = metadata?.invokeUrl
      || (metadata?.invokePort ? `http://host.docker.internal:${metadata.invokePort}` : undefined);

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
                StreamViewType: 'NEW_AND_OLD_IMAGES',
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
      const actualFunctionName = this.resolveLambdaFunctionName(serviceName, notif.functionRef);
      const invokeName = this.shortFunctionName(notif.functionRef);
      await this.ensureLambdaProxyExists(serviceName, actualFunctionName, invokeName, invokeUrl);

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
      }),
    );
    console.log(`  ✓ Wired ${lambdaConfigurations.length} S3 notification(s) on bucket: ${bucket.name}`);
  }

  // Strips Serverless's "LambdaFunction" CFN suffix and lowercases the first char.
  // This is the short name that serverless-offline registers at /2015-03-31/functions/{name}/invocations.
  private shortFunctionName(cfnName: string): string {
    let funcName = cfnName;
    if (funcName.endsWith('LambdaFunction')) {
      funcName = funcName.slice(0, -14);
    }
    return funcName.charAt(0).toLowerCase() + funcName.slice(1);
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

  // Transform event based on source
  // LocalStack sends events through different sources (SQS, DynamoDB, SNS, etc.)
  // We need to pass them correctly to the Serverless Offline handler
  let transformedEvent = event;
  
  // If the event already has Records (SQS/DynamoDB/SNS event), use it as is
  // Otherwise wrap it in a Records array
  if (!event.Records) {
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
      // Convert CloudFormation function name to Serverless naming convention
      // CloudFormation: ConsumerAppsQueueLambdaFunction -> Serverless: payment-reminder-api-consumerAppsQueue
      const actualFunctionName = this.resolveLambdaFunctionName(serviceName, mapping.functionName);
      const invokeName = this.shortFunctionName(mapping.functionName);

      // Resolve queue ARN from queue name
      const eventSourceArn = await this.resolveEventSourceArn(mapping.eventSourceArn);

      // Create Lambda proxy function if it doesn't exist
      await this.ensureLambdaProxyExists(serviceName, actualFunctionName, invokeName, invokeUrl);

      // Check if mapping already exists
      const existingMappings = await this.lambdaClient.send(
        new ListEventSourceMappingsCommand({
          FunctionName: actualFunctionName,
        }),
      );

      if (existingMappings.EventSourceMappings?.some(m => m.EventSourceArn?.includes(mapping.eventSourceArn))) {
        console.log(`  ⚠ Event source mapping already exists: ${actualFunctionName} <- ${mapping.eventSourceArn}`);
        return;
      }

      await this.lambdaClient.send(
        new CreateEventSourceMappingCommand({
          FunctionName: actualFunctionName,
          EventSourceArn: eventSourceArn,
          BatchSize: mapping.batchSize || 10,
          Enabled: mapping.enabled,
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

  private async ensureLambdaProxyExists(
    serviceName: string,
    proxyName: string,
    invokeName: string,
    invokeUrl?: string,
  ): Promise<void> {
    try {
      // Check if function already exists
      await this.lambdaClient.send(
        new GetFunctionCommand({
          FunctionName: proxyName,
        }),
      );
      // Function exists, no need to create
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

  private resolveLambdaFunctionName(serviceName: string, cfnName: string): string {
    // CloudFormation names like "ConsumerAppsQueueLambdaFunction" are converted to Serverless naming
    // by removing the "LambdaFunction" suffix, converting to camelCase, then to the serverless pattern
    // Example: ConsumerAppsQueueLambdaFunction -> consumerAppsQueue -> payment-reminder-api-consumerAppsQueue

    // Remove "LambdaFunction" suffix if present
    let funcName = cfnName;
    if (funcName.endsWith('LambdaFunction')) {
      funcName = funcName.slice(0, -14); // Remove "LambdaFunction"
    }

    // Convert to camelCase (first letter lowercase)
    funcName = funcName.charAt(0).toLowerCase() + funcName.slice(1);

    // Serverless names follow pattern: {service}-{stage}-{functionName}
    // We need to extract service and stage from the created Lambda names
    // For now, assume standard naming: payment-reminder-api-{functionName}
    return `${serviceName}-api-${funcName}`;
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

    // Extract resource name from Fn::GetAtt reference (e.g., "paymentReminderApps::Arn")
    let resourceName = arnRef.split('::')[0];

    // Convert camelCase resource names to kebab-case (serverless convention)
    // e.g., "paymentReminderApps" -> "payment-reminder-apps"
    resourceName = this.convertCamelCaseToKebab(resourceName);

    // Try to resolve as SQS queue
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

    // Try to resolve as DynamoDB stream
    try {
      const tables = await this.dynamoClient.send(new ListTablesCommand({}));
      const tableMatch = tables.TableNames?.find(name => 
        this.convertCamelCaseToKebab(name) === resourceName
      );

      if (tableMatch) {
        // Return DynamoDB Streams ARN (format: arn:aws:dynamodb:region:account:table/name/stream/type)
        // For now, we'll construct a generic stream ARN
        return `arn:aws:dynamodb:us-east-1:000000000000:table/${tableMatch}/stream/NEW_AND_OLD_IMAGES`;
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

    let cleaned = 0;
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

    console.log(`✅ Cleaned up ${cleaned} resources for ${serviceName}`);
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
