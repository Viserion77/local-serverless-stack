const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { sqs } = require('./aws');
const respond = require('./respond');

exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return respond(400, { error: 'invalid json' });
  }

  const { userId, items } = payload;
  if (!userId || !Array.isArray(items) || items.length === 0) {
    return respond(400, { error: 'userId and non-empty items[] are required' });
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

  return respond(202, { enqueued: true, order });
};
