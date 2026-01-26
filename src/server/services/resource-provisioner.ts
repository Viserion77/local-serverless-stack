import { DynamoDBClient, CreateTableCommand, ListTablesCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, CreateQueueCommand, ListQueuesCommand, GetQueueAttributesCommand, DeleteQueueCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { SNSClient, CreateTopicCommand, ListTopicsCommand, DeleteTopicCommand } from '@aws-sdk/client-sns';
import { LambdaClient, CreateFunctionCommand, GetFunctionCommand, DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import { CreateEventSourceMappingCommand, ListEventSourceMappingsCommand, DeleteEventSourceMappingCommand } from '@aws-sdk/client-lambda';
import { LocalStackManager } from './localstack-manager.js';
import type {
  Resource,
  DynamoDBResource,
  SQSResource,
  SNSResource,
  EventSourceMapping,
} from './cloudformation-parser.js';
import AdmZip from 'adm-zip';

export class ResourceProvisioner {
  private dynamoClient: DynamoDBClient;
  private sqsClient: SQSClient;
  private snsClient: SNSClient;
  private lambdaClient: LambdaClient;
  private provisionedResources = new Map<string, Set<string>>();
  private serviceMetadata = new Map<string, { invokePort: number; invokeUrl: string }>();

  constructor() {
    const config = LocalStackManager.getInstance().getConfig();
    this.dynamoClient = new DynamoDBClient(config);
    this.sqsClient = new SQSClient(config);
    this.snsClient = new SNSClient(config);
    this.lambdaClient = new LambdaClient(config);
  }

  async provisionResources(
    serviceName: string,
    resources: Resource[],
    metadata?: { invokePort?: number; invokeUrl?: string },
  ): Promise<void> {
    const provisioned = new Set<string>();

    // Store service metadata for Lambda proxy creation
    if (metadata?.invokePort) {
      this.serviceMetadata.set(serviceName, {
        invokePort: metadata.invokePort,
        invokeUrl: metadata.invokeUrl || `http://host.docker.internal:${metadata.invokePort}`,
      });
    }

    // First pass: Create infrastructure resources (DynamoDB, SQS, SNS)
    // Lambda functions are handled by Serverless Offline, not LocalStack
    for (const resource of resources) {
      try {
        switch (resource.type) {
          case 'dynamodb':
            await this.createDynamoDBTable(resource);
            provisioned.add(`dynamodb:${resource.name}`);
            break;
          case 'sqs':
            await this.createSQSQueue(resource);
            provisioned.add(`sqs:${resource.name}`);
            break;
          case 'sns':
            await this.createSNSTopic(resource);
            provisioned.add(`sns:${resource.name}`);
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
        await this.createEventSourceMapping(serviceName, eventSource);
        provisioned.add(`event-source:${eventSource.functionName}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorName = error instanceof Error && 'name' in error ? (error as {name: string}).name : '';
        if (!errorMessage.includes('already exists') && errorName !== 'ResourceConflictException') {
          console.error(`Failed to provision event-source for ${eventSource.functionName}:`, errorMessage);
        }
      }
    }

    this.provisionedResources.set(serviceName, provisioned);
    console.log(`✅ Provisioned ${provisioned.size} resources for ${serviceName}`);
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

  private generateProxyLambdaCode(functionName: string, invokeUrl: string): string {
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
      path: '/2015-03-31/functions/${functionName}/invocations',
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

  private async createEventSourceMapping(serviceName: string, mapping: EventSourceMapping): Promise<void> {
    try {
      // Convert CloudFormation function name to Serverless naming convention
      // CloudFormation: ConsumerAppsQueueLambdaFunction -> Serverless: payment-reminder-api-consumerAppsQueue
      const actualFunctionName = this.resolveLambdaFunctionName(serviceName, mapping.functionName);

      // Resolve queue ARN from queue name
      const eventSourceArn = await this.resolveEventSourceArn(mapping.eventSourceArn);

      // Create Lambda proxy function if it doesn't exist
      await this.ensureLambdaProxyExists(serviceName, actualFunctionName);

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

  private async ensureLambdaProxyExists(serviceName: string, functionName: string): Promise<void> {
    try {
      // Check if function already exists
      await this.lambdaClient.send(
        new GetFunctionCommand({
          FunctionName: functionName,
        }),
      );
      // Function exists, no need to create
      return;
    } catch (error: any) {
      if (error.name !== 'ResourceNotFoundException') {
        throw error;
      }
    }

    // Function doesn't exist, create a Lambda proxy
    const metadata = this.serviceMetadata.get(serviceName);
    if (!metadata) {
      throw new Error(`Cannot create Lambda proxy for ${functionName}: no invoke port configured for ${serviceName}`);
    }

    const proxyCode = this.generateProxyLambdaCode(functionName, metadata.invokeUrl);
    const zip = new AdmZip();
    zip.addFile('index.mjs', Buffer.from(proxyCode, 'utf-8'));
    const zipBuffer = zip.toBuffer();

    await this.lambdaClient.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        Runtime: 'nodejs20.x',
        Role: 'arn:aws:iam::000000000000:role/lambda-role',
        Handler: 'index.handler',
        Code: {
          ZipFile: zipBuffer,
        },
        Environment: {
          Variables: {
            INVOKE_URL: metadata.invokeUrl,
            FUNCTION_NAME: functionName,
          },
        },
        MemorySize: 256,
        Timeout: 60,
      }),
    );
    console.log(`  ✓ Created Lambda proxy: ${functionName} -> ${metadata.invokeUrl}`);
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

  async listAllResources(): Promise<{
    tables: string[];
    queues: string[];
    topics: string[];
  }> {
    const [tables, queues, topics] = await Promise.all([
      this.listDynamoDBTables(),
      this.listSQSQueues(),
      this.listSNSTopics(),
    ]);

    return { tables, queues, topics };
  }

  private async listDynamoDBTables(): Promise<string[]> {
    try {
      const response = await this.dynamoClient.send(new ListTablesCommand({}));
      return response.TableNames || [];
    } catch {
      return [];
    }
  }

  private async listSQSQueues(): Promise<string[]> {
    try {
      const response = await this.sqsClient.send(new ListQueuesCommand({}));
      return response.QueueUrls?.map(url => url.split('/').pop()!) || [];
    } catch {
      return [];
    }
  }

  private async listSNSTopics(): Promise<string[]> {
    try {
      const response = await this.snsClient.send(new ListTopicsCommand({}));
      return response.Topics?.map(t => {
        const arn = t.TopicArn?.split(':').pop();
        return arn || '';
      }).filter(arn => arn !== '') || [];
    } catch {
      return [];
    }
  }

  async cleanupResources(serviceName: string): Promise<void> {
    const resources = this.provisionedResources.get(serviceName);
    if (!resources) {
      console.log(`No resources found for service ${serviceName}`);
      return;
    }

    let cleaned = 0;
    for (const resource of resources) {
      try {
        const [type, name] = resource.split(':');
        
        switch (type) {
          case 'dynamodb':
            await this.deleteDynamoDBTable(name);
            cleaned++;
            break;
          case 'sqs':
            await this.deleteSQSQueue(name);
            cleaned++;
            break;
          case 'sns':
            await this.deleteSNSTopic(name);
            cleaned++;
            break;
          case 'event-source':
            await this.deleteEventSourceMapping(serviceName, name);
            cleaned++;
            break;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Failed to cleanup ${resource}:`, errorMessage);
      }
    }

    this.provisionedResources.delete(serviceName);
    this.serviceMetadata.delete(serviceName);
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
