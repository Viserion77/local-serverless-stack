const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// EventBridge target — receives the event exactly as AWS delivers it:
// { version, id, source, "detail-type", detail, ... }. No Records wrapper.
// The event was published by users-service (createUser → PutEvents) onto the
// shared domain-events bus; the rule pattern (source: users, detail-type:
// UserSignedUp) filtered it here.
exports.handler = async (event) => {
  console.log(`[onUserSignedUp] ${event.source} → ${event['detail-type']} (${event.id})`);

  await doc.send(new PutCommand({
    TableName: process.env.SIGNUP_AUDIT_TABLE,
    Item: {
      eventId: event.id,
      source: event.source,
      detailType: event['detail-type'],
      detail: event.detail,
      receivedAt: new Date().toISOString(),
    },
  }));

  return { stored: event.id };
};
