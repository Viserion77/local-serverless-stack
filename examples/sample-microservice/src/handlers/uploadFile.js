const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const { s3 } = require('./aws');

// POST /uploads
// Body: { "filename": "report.txt", "content": "...", "encoding": "base64" | undefined }
exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { filename, content, encoding, contentType } = payload;
  if (!content) {
    return { statusCode: 400, body: JSON.stringify({ error: 'content is required' }) };
  }

  // Files land under "incoming/" so the S3 → Lambda notification fires.
  const safeName = (filename || `${randomUUID()}.txt`).replace(/[^a-zA-Z0-9._/-]/g, '_');
  const key = `incoming/${safeName}`;
  const body = encoding === 'base64' ? Buffer.from(content, 'base64') : content;

  await s3.send(new PutObjectCommand({
    Bucket: process.env.UPLOADS_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'text/plain',
  }));

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploaded: true, bucket: process.env.UPLOADS_BUCKET, key }),
  };
};
