import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';
import { doc, eventBridge } from './aws';

// POST /users — explicit v2 response shape ({statusCode, body}) to contrast
// with listUsers' inferred response. After the write it publishes a
// UserSignedUp event onto the shared domain-events bus (owned by
// events-stack) with a plain SDK PutEvents call; auth-service consumes it
// through an eventBridge trigger.
export const handler = async (event: any) => {
  let payload: any = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { name, email } = payload;
  if (!name || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name and email are required' }) };
  }

  const item = {
    id: randomUUID(),
    name,
    email,
    createdAt: new Date().toISOString(),
  };

  await doc.send(new PutCommand({
    TableName: process.env.USERS_TABLE,
    Item: item,
  }));

  const result = await eventBridge.send(new PutEventsCommand({
    Entries: [{
      EventBusName: process.env.EVENT_BUS_NAME,
      Source: 'users',
      DetailType: 'UserSignedUp',
      Detail: JSON.stringify({ userId: item.id, name: item.name, email: item.email }),
    }],
  }));

  const entry = result.Entries?.[0] || {};
  console.log(`[createUser] published UserSignedUp for ${item.id} (event ${entry.EventId})`);

  return { statusCode: 201, body: JSON.stringify(item) };
};
