const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { s3 } = require('./aws');
const respond = require('./respond');

// GET /uploads?prefix=incoming/
exports.handler = async (event) => {
  const prefix = (event.queryStringParameters && event.queryStringParameters.prefix) || undefined;

  const response = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.UPLOADS_BUCKET,
    Prefix: prefix,
    MaxKeys: 100,
  }));

  const objects = (response.Contents || []).map(o => ({
    key: o.Key,
    size: o.Size,
    lastModified: o.LastModified,
  }));

  return respond(200, { bucket: process.env.UPLOADS_BUCKET, count: objects.length, objects });
};
