const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { randomUUID } = require('crypto');
const { dynamo } = require('./aws');
const respond = require('./respond');

exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return respond(400, { error: 'invalid json' });
  }

  const { name, email } = payload;
  if (!name || !email) {
    return respond(400, { error: 'name and email are required' });
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

  return respond(201, user);
};
