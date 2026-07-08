import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { doc } from './aws';

// GET /users — returns a bare object on purpose: HTTP API payload v2 infers a
// 200 JSON response from any non-{statusCode,...} return value.
export const handler = async () => {
  const res = await doc.send(new ScanCommand({ TableName: process.env.USERS_TABLE }));
  return { items: res.Items ?? [] };
};
