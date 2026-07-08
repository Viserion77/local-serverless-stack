const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { SQSClient } = require('@aws-sdk/client-sqs');

const baseConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:4572',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

const dynamo = new DynamoDBClient(baseConfig);

module.exports = {
  dynamo,
  doc: DynamoDBDocumentClient.from(dynamo),
  sqs: new SQSClient(baseConfig),
};
