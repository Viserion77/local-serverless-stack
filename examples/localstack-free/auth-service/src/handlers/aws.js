const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const baseConfig = {
  region: process.env.AWS_REGION || 'sa-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:4572',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

const dynamo = new DynamoDBClient(baseConfig);

module.exports = {
  dynamo,
  doc: DynamoDBDocumentClient.from(dynamo),
};
