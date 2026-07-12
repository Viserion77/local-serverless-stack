const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const dynamo = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-west-2',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

module.exports = { doc: DynamoDBDocumentClient.from(dynamo) };
