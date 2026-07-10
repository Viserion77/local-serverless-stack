const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { SQSClient } = require('@aws-sdk/client-sqs');

const config = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

module.exports = {
  doc: DynamoDBDocumentClient.from(new DynamoDBClient(config)),
  sqs: new SQSClient(config),
};
