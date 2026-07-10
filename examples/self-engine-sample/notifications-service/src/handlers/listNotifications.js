const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// GET /notifications
exports.handler = async () => {
  const result = await doc.send(new ScanCommand({ TableName: process.env.NOTIFICATIONS_TABLE }));
  return {
    statusCode: 200,
    body: JSON.stringify({ count: result.Count ?? 0, notifications: result.Items ?? [] }),
  };
};
