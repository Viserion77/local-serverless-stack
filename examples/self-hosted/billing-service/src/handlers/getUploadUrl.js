const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const { s3 } = require('./aws');

// GET /attachments/upload-url?filename=receipt.pdf
// Hands the browser a presigned POST so it can upload a receipt attachment
// straight to S3 (multipart/form-data) without the bytes passing through this
// Lambda. The self engine serves the resulting `POST /<bucket>` form upload
// natively — no LocalStack needed.
exports.handler = async (event) => {
  const filename = (event.queryStringParameters && event.queryStringParameters.filename) || 'attachment.bin';
  const key = `attachments/${filename}`;

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: process.env.RECEIPTS_BUCKET,
    Key: key,
    // Cap uploads at 10 MB; the policy is signed but the self engine does not
    // verify it (it never verifies SigV4 either) — real AWS enforces it.
    Conditions: [['content-length-range', 0, 10 * 1024 * 1024]],
    Expires: 600,
  });

  console.log(`[getUploadUrl] presigned POST for ${key}`);
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      upload: { url, fields },
      // A ready-to-run curl the console/README shows for a quick demo.
      hint: `curl -F key=${key} ${Object.entries(fields).map(([k, v]) => `-F ${k}=${v}`).join(' ')} -F file=@./${filename} ${url}`,
    }),
  };
};
