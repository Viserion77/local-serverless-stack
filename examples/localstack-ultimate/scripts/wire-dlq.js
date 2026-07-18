// Applies the RedrivePolicy declared in serverless.yml to the LIVE LocalStack
// queue. LSS now carries RedrivePolicy from the CloudFormation template into
// CreateQueue, so this is a no-op safety net: it re-applies the same policy,
// which matters only for a queue provisioned by an older LSS (CreateQueue
// cannot change the attributes of a queue that already exists).
// `npm run offline` runs this right after `serverless package` (which
// registers the service and provisions the queues); it is also available
// standalone as `npm run dlq:wire`.
const {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} = require('@aws-sdk/client-sqs');

const sqs = new SQSClient({
  region: process.env.AWS_REGION || 'eu-west-1',
  endpoint: process.env.AWS_ENDPOINT || 'http://localhost:4571',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const QUEUE = 'localstack-ultimate-OrderProcessing';
const DLQ = 'localstack-ultimate-OrderProcessingDLQ';
const MAX_RECEIVE_COUNT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Registration provisions the queues asynchronously to this script, so poll
// for up to ~30s before giving up.
async function getQueueUrlWithRetry(name) {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      return res.QueueUrl;
    } catch {
      await sleep(1000);
    }
  }
  return undefined;
}

async function main() {
  const queueUrl = await getQueueUrlWithRetry(QUEUE);
  const dlqUrl = await getQueueUrlWithRetry(DLQ);
  if (!queueUrl || !dlqUrl) {
    // Fail soft: don't block `npm run offline` when LSS/LocalStack isn't up
    // yet — re-run `npm run dlq:wire` once it is.
    console.warn(`[wire-dlq] ⚠ queues not found on ${process.env.AWS_ENDPOINT || 'http://localhost:4571'} — is LSS running (npm run lss:start)? Skipping.`);
    return;
  }

  const attrs = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: dlqUrl,
    AttributeNames: ['QueueArn'],
  }));
  const dlqArn = attrs.Attributes && attrs.Attributes.QueueArn;

  await sqs.send(new SetQueueAttributesCommand({
    QueueUrl: queueUrl,
    Attributes: {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      }),
    },
  }));

  console.log(`[wire-dlq] ✓ RedrivePolicy set on ${QUEUE} → ${DLQ} (maxReceiveCount: ${MAX_RECEIVE_COUNT})`);
}

main().catch((err) => {
  console.warn(`[wire-dlq] ⚠ ${err.message} — skipping.`);
});
