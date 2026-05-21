const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { s3, dynamo } = require('./aws');

// Triggered by the S3 bucket notification when an object is created under
// "incoming/". This handler reads the object back, derives some metadata, and
// records it in the Orders table to prove the round-trip works end-to-end.
exports.handler = async (event) => {
  const records = event.Records || [];
  console.log(`[onUpload] received ${records.length} S3 event(s)`);

  for (const record of records) {
    const bucket = record.s3 && record.s3.bucket && record.s3.bucket.name;
    const key = record.s3 && record.s3.object && decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    if (!bucket || !key) {
      console.warn('[onUpload] skipping malformed record');
      continue;
    }

    let size = (record.s3.object && record.s3.object.size) || 0;
    let preview;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      size = body.length;
      preview = body.slice(0, 120).toString('utf-8');
    } catch (err) {
      console.warn(`[onUpload] could not read s3://${bucket}/${key}: ${err.message}`);
    }

    // Stash an entry in Orders so the trigger is observable from the UI's
    // DynamoDB explorer without adding a dedicated table.
    const item = {
      userId: 's3-upload',
      orderId: `${bucket}/${key}`,
      status: 'UPLOADED',
      total: size,
      items: preview ? [{ preview }] : [],
      processedAt: new Date().toISOString(),
    };

    await dynamo.send(new PutItemCommand({
      TableName: process.env.ORDERS_TABLE,
      Item: marshall(item, { removeUndefinedValues: true }),
    }));

    console.log(`[onUpload] indexed s3://${bucket}/${key} (${size} bytes)`);
  }

  return { batchItemFailures: [] };
};
