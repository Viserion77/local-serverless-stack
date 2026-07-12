import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { doc } from './aws';

// GET /users/{id} — demonstrates v2 path parameters.
export const handler = async (event: any) => {
  const id = event.pathParameters?.id;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id path parameter is required' }) };
  }

  const res = await doc.send(new GetCommand({
    TableName: process.env.USERS_TABLE,
    Key: { id },
  }));

  if (!res.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: `user ${id} not found` }) };
  }

  return { statusCode: 200, body: JSON.stringify(res.Item) };
};
