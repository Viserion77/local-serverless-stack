const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const { s3, eventBridge } = require('./aws');

// SQS batch handler — real AWS event shape ({ Records: [{ body, ... }] }).
// For each order: write a receipt to S3 and announce OrderBilled on the bus.
exports.handler = async (event) => {
  for (const record of event.Records || []) {
    const order = JSON.parse(record.body);

    // Poison-message demo: an order that cannot be billed fails forever. The
    // throw leaves the whole batch on the queue, so SQS redelivers it until
    // ApproximateReceiveCount exceeds the queue's maxReceiveCount (2) and the
    // self engine moves it to orders-to-process-dlq — no infinite retry loop.
    if (!(order.total > 0)) {
      throw new Error(`order ${order.id} has a non-billable total (${order.total})`);
    }

    const receiptKey = `receipts/${order.id}.json`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.RECEIPTS_BUCKET,
      Key: receiptKey,
      ContentType: 'application/json',
      Body: JSON.stringify({
        orderId: order.id,
        customerId: order.customerId,
        total: order.total,
        billedAt: new Date().toISOString(),
      }),
    }));

    await eventBridge.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.BILLING_BUS,
        Source: 'billing',
        DetailType: 'OrderBilled',
        Detail: JSON.stringify({ orderId: order.id, customerId: order.customerId, total: order.total, receiptKey }),
      }],
    }));

    console.log(`[processOrder] billed ${order.id} → s3://${process.env.RECEIPTS_BUCKET}/${receiptKey}`);
  }

  return { processed: (event.Records || []).length };
};
