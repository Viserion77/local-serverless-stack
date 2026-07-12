const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { sqs } = require('./aws');

// POST /orders — the cross-service authorizer (auth-service) already ran and
// put the session user on event.requestContext.authorizer. The order goes
// through SQS; processOrderQueue persists it.
exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { item } = payload;
  if (!item) {
    return { statusCode: 400, body: JSON.stringify({ error: 'item is required' }) };
  }

  const authorizer = (event.requestContext && event.requestContext.authorizer) || {};
  const order = {
    id: randomUUID(),
    item,
    user: authorizer.user,
    createdAt: new Date().toISOString(),
  };

  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.ORDER_QUEUE_URL,
    MessageBody: JSON.stringify(order),
  }));

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queued: true, id: order.id }),
  };
};
