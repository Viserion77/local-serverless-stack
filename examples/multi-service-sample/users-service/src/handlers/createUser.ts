import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { doc } from './aws';

// POST /users — explicit v2 response shape ({statusCode, body}) to contrast
// with listUsers' inferred response.
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

  return { statusCode: 201, body: JSON.stringify(item) };
};
