import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';

const baseConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:4572',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

export const dynamo = new DynamoDBClient(baseConfig);
export const doc = DynamoDBDocumentClient.from(dynamo);
export const eventBridge = new EventBridgeClient(baseConfig);
