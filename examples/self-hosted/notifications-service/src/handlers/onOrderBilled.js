const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// EventBridge target — receives the event exactly as AWS delivers it.
exports.handler = async (event) => {
  const detail = event.detail || {};
  console.log(`[onOrderBilled] ${event.source} → ${event['detail-type']} (order ${detail.orderId})`);

  await doc.send(new PutCommand({
    TableName: process.env.NOTIFICATIONS_TABLE,
    Item: {
      id: event.id,
      orderId: detail.orderId,
      customerId: detail.customerId,
      message: `Order ${detail.orderId} billed at ${detail.total} — receipt: ${detail.receiptKey}`,
      createdAt: new Date().toISOString(),
    },
  }));

  return { notified: detail.orderId };
};
