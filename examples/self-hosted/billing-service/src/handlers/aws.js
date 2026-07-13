const { S3Client } = require('@aws-sdk/client-s3');
const { EventBridgeClient } = require('@aws-sdk/client-eventbridge');
const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');

const config = {
  region: process.env.AWS_REGION || 'us-west-2',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

module.exports = {
  config,
  // forcePathStyle keeps the bucket in the URL path (POST /<bucket>) — the
  // shape the self engine's presigned POST handler expects.
  s3: new S3Client({ ...config, forcePathStyle: true }),
  eventBridge: new EventBridgeClient(config),
  secrets: new SecretsManagerClient(config),
};
