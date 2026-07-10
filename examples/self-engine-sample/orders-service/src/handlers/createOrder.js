const { randomUUID } = require('crypto');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { doc, sqs } = require('./aws');

// POST /orders — body: { "customerId": "...", "total": 12.5 }
exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { customerId, total } = payload;
  if (!customerId || typeof total !== 'number') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'customerId and numeric total are required' }),
    };
  }

  const order = {
    id: randomUUID(),
    customerId,
    total,
    status: 'PENDING_BILLING',
    createdAt: new Date().toISOString(),
  };

  await doc.send(new PutCommand({ TableName: process.env.ORDERS_TABLE, Item: order }));
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.ORDERS_QUEUE_URL,
    MessageBody: JSON.stringify(order),
  }));

  console.log(`[createOrder] ${order.id} stored and enqueued for billing`);
  return { statusCode: 201, body: JSON.stringify(order) };
};
