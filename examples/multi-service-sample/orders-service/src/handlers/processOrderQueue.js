const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// SQS consumer — persists each queued order with status "processed".
exports.handler = async (event) => {
  const records = event.Records || [];
  console.log(`[processOrderQueue] received ${records.length} message(s)`);

  for (const record of records) {
    let order;
    try {
      order = JSON.parse(record.body);
    } catch {
      console.error('[processOrderQueue] invalid body, dropping:', record.body);
      continue;
    }

    await doc.send(new PutCommand({
      TableName: process.env.ORDERS_TABLE,
      Item: {
        ...order,
        status: 'processed',
        processedAt: new Date().toISOString(),
      },
    }));

    console.log(`[processOrderQueue] stored order ${order.id} (processed)`);
  }

  return { batchItemFailures: [] };
};
