const { S3Client } = require('@aws-sdk/client-s3');
const { EventBridgeClient } = require('@aws-sdk/client-eventbridge');

const config = {
  region: process.env.AWS_REGION || 'us-west-2',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

module.exports = {
  s3: new S3Client({ ...config, forcePathStyle: true }),
  eventBridge: new EventBridgeClient(config),
};
