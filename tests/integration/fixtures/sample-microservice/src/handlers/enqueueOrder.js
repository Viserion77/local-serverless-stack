const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { sqs } = require('./aws');

exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { userId, items } = payload;
  if (!userId || !Array.isArray(items) || items.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'userId and non-empty items[] are required' }),
    };
  }

  const order = {
    orderId: randomUUID(),
    userId,
    items,
    createdAt: new Date().toISOString(),
  };

  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.ORDER_QUEUE_URL,
    MessageBody: JSON.stringify(order),
  }));

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enqueued: true, order }),
  };
};
