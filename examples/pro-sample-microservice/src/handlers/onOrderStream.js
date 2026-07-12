const { PublishCommand } = require('@aws-sdk/client-sns');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { sns } = require('./aws');

exports.handler = async (event) => {
  const records = event.Records || [];
  console.log(`[onOrderStream] received ${records.length} stream record(s)`);

  for (const record of records) {
    const eventName = record.eventName; // INSERT | MODIFY | REMOVE
    const newImage = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
    const oldImage = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage) : null;

    const message = {
      type: `order.${eventName.toLowerCase()}`,
      orderId: (newImage || oldImage)?.orderId,
      userId: (newImage || oldImage)?.userId,
      status: newImage?.status,
      total: newImage?.total,
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
