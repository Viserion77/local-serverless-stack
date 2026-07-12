const { ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { dynamo } = require('./aws');

exports.handler = async () => {
  const res = await dynamo.send(new ScanCommand({ TableName: process.env.USERS_TABLE }));
  const users = (res.Items || []).map((i) => unmarshall(i));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: users.length, users }),
  };
};
