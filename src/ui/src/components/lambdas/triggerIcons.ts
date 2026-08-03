import type { AwsIconName } from '../../icons/aws';

/**
 * A Lambda trigger, paired with the AWS service that fires it.
 *
 * Both Lambda surfaces render the same `triggers` array — the list column and
 * the detail screen's "Trigger sources" card — so the mapping lives here once
 * instead of being copied into two templates.
 */
export interface LambdaTrigger {
  /** The raw Serverless event key. Stays the tag's visible text. */
  readonly name: string;
  /** The mark of the AWS service the trigger comes from, when it maps to one. */
  readonly icon?: AwsIconName;
}

/**
 * Serverless event key → AWS service mark.
 *
 * The keys are what the service actually declared: `serverless-state-parser.ts`
 * copies `functions.<fn>.events[].<key>` through `normalizeTriggerName()`,
 * which only special-cases `stream`, so `httpApi`, `eventBridge` and friends
 * reach the dashboard verbatim. Lookups are lower-cased to absorb that
 * camelCase without listing every spelling.
 *
 * `stream` resolves to DynamoDB because that is the only stream LSS wires:
 * `dispatch/stream-tailer.ts` tails DynamoDB Streams and the engine has no
 * Kinesis emulator. A Kinesis `stream:` event would be mislabelled here — the
 * cost of the parser folding both event shapes onto one key.
 *
 * Unmapped keys deliberately return `undefined` and the tag renders with no
 * icon: a missing mark is honest, a wrong brand is not.
 */
const TRIGGER_ICONS: Readonly<Record<string, AwsIconName | undefined>> = {
  // API Gateway serves all three: REST (`http`), HTTP API (`httpApi`) and
  // WebSocket APIs.
  http: 'aws-api-gateway',
  httpapi: 'aws-api-gateway',
  websocket: 'aws-api-gateway',
  // An ALB target is Elastic Load Balancing, not API Gateway.
  alb: 'aws-elb',
  sqs: 'aws-sqs',
  sns: 'aws-sns',
  s3: 'aws-s3',
  stream: 'aws-dynamodb',
  // `schedule` and the legacy `cloudwatchEvent` are both EventBridge rules.
  eventbridge: 'aws-eventbridge',
  schedule: 'aws-eventbridge',
  cloudwatchevent: 'aws-eventbridge',
  cognitouserpool: 'aws-cognito',
};

/** Pairs each trigger with its brand, keeping the declared order. */
export function toLambdaTriggers(triggers: readonly string[]): LambdaTrigger[] {
  return triggers.map((name) => {
    const icon = TRIGGER_ICONS[name.toLowerCase()];
    return icon ? { name, icon } : { name };
  });
}
