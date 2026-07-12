const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// GET /signups — makes the async cross-service flow observable: whatever the
// eventBridge trigger (onUserSignedUp) stored shows up here.
exports.handler = async () => {
  const res = await doc.send(new ScanCommand({ TableName: process.env.SIGNUP_AUDIT_TABLE }));
  const items = res.Items || [];
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: items.length, signups: items }),
  };
};
