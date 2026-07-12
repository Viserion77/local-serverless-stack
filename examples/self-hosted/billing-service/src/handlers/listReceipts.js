const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('./aws');

// GET /receipts — lists receipt objects and inlines their JSON bodies.
exports.handler = async () => {
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.RECEIPTS_BUCKET,
    Prefix: 'receipts/',
  }));

  const receipts = [];
  for (const object of list.Contents || []) {
    const body = await s3.send(new GetObjectCommand({
      Bucket: process.env.RECEIPTS_BUCKET,
      Key: object.Key,
    }));
    receipts.push(JSON.parse(await body.Body.transformToString()));
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ count: receipts.length, receipts }),
  };
};
