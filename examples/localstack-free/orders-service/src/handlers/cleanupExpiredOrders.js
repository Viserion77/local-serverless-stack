const { ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

const ONE_HOUR_MS = 60 * 60 * 1000;

// schedule: rate(1 hour). LSS does not fire schedules yet (documented TODO),
// but the function is registered and invocable via the Lambda Invoke API on
// port 13612 — handy for exercising it on demand.
exports.handler = async () => {
  const res = await doc.send(new ScanCommand({ TableName: process.env.ORDERS_TABLE }));
  const items = res.Items || [];
  const cutoff = Date.now() - ONE_HOUR_MS;

  const expired = items.filter((item) => {
    const created = Date.parse(item.createdAt || '');
    return Number.isFinite(created) && created < cutoff;
  });

  for (const item of expired) {
    await doc.send(new DeleteCommand({
      TableName: process.env.ORDERS_TABLE,
      Key: { id: item.id },
    }));
  }

  console.log(`[cleanupExpiredOrders] deleted ${expired.length} of ${items.length} order(s) older than 1 hour`);
  return { scanned: items.length, deleted: expired.length };
};
