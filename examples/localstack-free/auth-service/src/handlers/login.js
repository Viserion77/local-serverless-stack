const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// POST /login — body {user, password}. The demo password is "lss-demo": on a
// match we mint a deterministic session code and persist it so the REQUEST
// authorizer (and the seeded "code-admin") can validate it later.
exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { user, password } = payload;
  if (!user || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'user and password are required' }) };
  }

  if (password !== 'lss-demo') {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid credentials' }) };
  }

  const session = {
    code: `code-${user}`,
    user,
    createdAt: new Date().toISOString(),
  };

  await doc.send(new PutCommand({
    TableName: process.env.SESSIONS_TABLE,
    Item: session,
  }));

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: session.code }),
  };
};
