const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// GET /events — makes the async flow observable: whatever the eventBridge
// trigger stored shows up here.
exports.handler = async () => {
  const result = await doc.send(new ScanCommand({ TableName: process.env.EVENTS_TABLE }));
  return {
    statusCode: 200,
    body: JSON.stringify({ count: result.Count || 0, events: result.Items || [] }),
  };
};
