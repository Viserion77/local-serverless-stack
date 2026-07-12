const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');

const client = new EventBridgeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

// POST /signups — the whole "producer" story is one PutEvents call: LSS only
// had to make sure the bus exists in LocalStack.
exports.handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) };
  }

  if (!body.userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId is required' }) };
  }

  const result = await client.send(new PutEventsCommand({
    Entries: [{
      EventBusName: process.env.EVENT_BUS_NAME,
      Source: 'producer',
      DetailType: 'UserSignedUp',
      Detail: JSON.stringify({ userId: body.userId, email: body.email }),
    }],
  }));

  const entry = result.Entries?.[0] || {};
  console.log(`[signup] published UserSignedUp for ${body.userId} (event ${entry.EventId})`);

  return {
    statusCode: 202,
    body: JSON.stringify({ published: true, eventId: entry.EventId }),
  };
};
