const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// GET /orders — protected by the same cross-service authorizer as createOrder.
exports.handler = async () => {
  const res = await doc.send(new ScanCommand({ TableName: process.env.ORDERS_TABLE }));
  const items = res.Items || [];
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: items.length, items }),
  };
};
