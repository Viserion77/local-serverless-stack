const { PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { dynamo } = require('./aws');

// EventBridge target — receives the event exactly as AWS delivers it:
// { version, id, source, "detail-type", detail, ... }. No Records wrapper.
// The rule pattern (source: ultimate.orders | ultimate.scheduler) on the
// ultimate-order-events bus filtered it here; each matched event becomes a
// row in the AuditTrail table, readable via GET /audit.
exports.handler = async (event) => {
  console.log(`[auditEvents] ${event.source} → ${event['detail-type']} (${event.id})`);

  const entry = {
    auditId: event.id,
    source: event.source,
    detailType: event['detail-type'],
    detail: event.detail,
    receivedAt: new Date().toISOString(),
  };

  await dynamo.send(new PutItemCommand({
    TableName: process.env.AUDIT_TABLE,
    Item: marshall(entry, { removeUndefinedValues: true }),
  }));

  return { stored: entry.auditId };
};
