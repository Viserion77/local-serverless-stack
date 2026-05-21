const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { dynamo } = require('./aws');

exports.handler = async (event) => {
  const records = event.Records || [];
  console.log(`[processOrderQueue] received ${records.length} message(s)`);

  for (const record of records) {
    let order;
    try {
      order = JSON.parse(record.body);
    } catch (e) {
      console.error('[processOrderQueue] invalid body, dropping:', record.body);
      continue;
    }

    const total = (order.items || []).reduce(
      (s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 1),
      0,
    );

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

    console.log(`[processOrderQueue] stored order ${persisted.orderId} (${persisted.status})`);
  }

  return { batchItemFailures: [] };
};
