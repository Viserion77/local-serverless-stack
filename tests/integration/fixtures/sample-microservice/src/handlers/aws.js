const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SQSClient } = require('@aws-sdk/client-sqs');
const { SNSClient } = require('@aws-sdk/client-sns');
const { S3Client } = require('@aws-sdk/client-s3');

const baseConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

module.exports = {
  dynamo: new DynamoDBClient(baseConfig),
  sqs: new SQSClient(baseConfig),
  sns: new SNSClient(baseConfig),
  // forcePathStyle is required so LocalStack sees the bucket name in the URL path
  // rather than as a virtual-host subdomain.
  s3: new S3Client({ ...baseConfig, forcePathStyle: true }),
};
