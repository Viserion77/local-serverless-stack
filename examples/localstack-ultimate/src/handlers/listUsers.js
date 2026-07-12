const { ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { dynamo } = require('./aws');
const respond = require('./respond');

exports.handler = async () => {
  const res = await dynamo.send(new ScanCommand({ TableName: process.env.USERS_TABLE }));
  const users = (res.Items || []).map((i) => unmarshall(i));
  return respond(200, { count: users.length, users });
};
