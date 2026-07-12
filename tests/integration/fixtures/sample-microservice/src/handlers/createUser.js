const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { randomUUID } = require('crypto');
const { dynamo } = require('./aws');

exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { name, email } = payload;
  if (!name || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name and email are required' }) };
  }

  const user = {
    userId: randomUUID(),
    name,
    email,
    createdAt: new Date().toISOString(),
    active: true,
  };

  await dynamo.send(new PutItemCommand({
    TableName: process.env.USERS_TABLE,
    Item: marshall(user),
  }));

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  };
};
