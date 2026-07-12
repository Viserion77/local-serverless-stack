const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// GET /orders
exports.handler = async () => {
  const result = await doc.send(new ScanCommand({ TableName: process.env.ORDERS_TABLE }));
  return {
    statusCode: 200,
    body: JSON.stringify({ count: result.Count ?? 0, orders: result.Items ?? [] }),
  };
};
