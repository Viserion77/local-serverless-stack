const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { dynamo, eventBridge } = require('./aws');

exports.handler = async (event) => {
  const records = event.Records || [];
  console.log(`[processOrderQueue] received ${records.length} message(s)`);

  // ReportBatchItemFailures contract: only the messageIds listed here are kept
  // on the queue; everything else is deleted. A poison message is re-received
  // until maxReceiveCount, then SQS redrives it to the OrderProcessingDLQ.
  const batchItemFailures = [];

  for (const record of records) {
    try {
      let order;
      try {
        order = JSON.parse(record.body);
      } catch (e) {
        throw new Error(`invalid body: ${record.body}`);
      }

      const total = (order.items || []).reduce(
        (s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1),
        0,
      );

      // Obviously invalid orders are poison messages: throwing (instead of
      // dropping) keeps them on the queue so the DLQ redrive is observable.
      if (!order.userId) {
        throw new Error('poison order: missing userId');
      }
      if (total <= 0) {
        throw new Error(`poison order ${order.orderId}: total ${total} <= 0`);
      }

      const persisted = {
        ...order,
        status: total > 100 ? 'PENDING_REVIEW' : 'CONFIRMED',
        total,
        processedAt: new Date().toISOString(),
      };

      await dynamo.send(new PutItemCommand({
        TableName: process.env.ORDERS_TABLE,
        Item: marshall(persisted, { removeUndefinedValues: true }),
      }));

      // Announce the processed order on the custom EventBridge bus — the
      // auditEvents rule (source: ultimate.orders) picks it up.
      await eventBridge.send(new PutEventsCommand({
        Entries: [{
          EventBusName: process.env.ORDER_EVENTS_BUS,
          Source: 'ultimate.orders',
          DetailType: 'order.processed',
          Detail: JSON.stringify({
            orderId: persisted.orderId,
            userId: persisted.userId,
            status: persisted.status,
            total: persisted.total,
          }),
        }],
      }));

      console.log(`[processOrderQueue] stored order ${persisted.orderId} (${persisted.status})`);
    } catch (err) {
      console.error(`[processOrderQueue] message ${record.messageId} failed: ${err.message}`);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
