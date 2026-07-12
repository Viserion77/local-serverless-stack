const { ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { dynamo } = require('./aws');
const respond = require('./respond');

// GET /audit — makes the bus → rule → auditEvents flow observable: whatever
// the eventBridge trigger stored shows up here, newest first.
exports.handler = async () => {
  const res = await dynamo.send(new ScanCommand({ TableName: process.env.AUDIT_TABLE }));
  const entries = (res.Items || [])
    .map((i) => unmarshall(i))
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .slice(0, 50);
  return respond(200, { count: entries.length, entries });
};
