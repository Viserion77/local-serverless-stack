const { ScanCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const { PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { dynamo, eventBridge } = require('./aws');

// schedule: rate(2 minutes) — compiled to an EventBridge rule on the default
// bus and fired by LocalStack through the LSS proxy. Deletes Sessions rows
// whose expiresAt (epoch seconds) is in the past — the poor man's TTL; the
// Settings tab in the UI can enable real DynamoDB TTL on the same attribute.
exports.handler = async () => {
  const res = await dynamo.send(new ScanCommand({ TableName: process.env.SESSIONS_TABLE }));
  const sessions = (res.Items || []).map((i) => unmarshall(i));
  const nowSeconds = Math.floor(Date.now() / 1000);

  const expired = sessions.filter((s) => Number(s.expiresAt) > 0 && Number(s.expiresAt) < nowSeconds);

  for (const session of expired) {
    await dynamo.send(new DeleteItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: marshall({ sessionId: session.sessionId }),
    }));
  }

  // Leave a trace on the custom bus so every run shows up in GET /audit via
  // the auditEvents rule (source: ultimate.scheduler).
  await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: process.env.ORDER_EVENTS_BUS,
      Source: 'ultimate.scheduler',
      DetailType: 'sessions.purged',
      Detail: JSON.stringify({
        scanned: sessions.length,
        purged: expired.length,
        purgedIds: expired.map((s) => s.sessionId),
      }),
    }],
  }));

  console.log(`[purgeSessions] purged ${expired.length} of ${sessions.length} session(s)`);
  return { scanned: sessions.length, purged: expired.length };
};
