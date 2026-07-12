const { PublishCommand } = require('@aws-sdk/client-sns');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { sns } = require('./aws');

// DynamoDB stream consumer — every INSERT/MODIFY/REMOVE on orders-Orders lands
// here (NEW_AND_OLD_IMAGES), and each record is fanned out as an order.* SNS
// message on the orders-OrderEvents topic.
exports.handler = async (event) => {
  const records = event.Records || [];
  console.log(`[onOrderStream] received ${records.length} stream record(s)`);

  for (const record of records) {
    const eventName = record.eventName; // INSERT | MODIFY | REMOVE
    const newImage = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
    const oldImage = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage) : null;

    const message = {
      type: `order.${eventName.toLowerCase()}`,
      orderId: (newImage || oldImage)?.id,
      item: (newImage || oldImage)?.item,
      user: (newImage || oldImage)?.user,
      status: newImage?.status,
      occurredAt: new Date().toISOString(),
    };

    await sns.send(new PublishCommand({
      TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
      Subject: message.type,
      Message: JSON.stringify(message),
    }));

    console.log(`[onOrderStream] published ${message.type} for ${message.orderId}`);
  }
};
