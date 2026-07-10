import { S3Emulator } from '../../../../src/server/engine/emulators/s3/index.js';
import { parseXml, childText, childrenNamed, XmlNode } from '../../../../src/server/engine/http/xml.js';
import { makeContext, cleanupContext, makeReq, bodyText, TestContext } from './helpers';

const LAMBDA_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:onUpload';
const QUEUE_ARN = 'arn:aws:sqs:us-east-1:000000000000:notify-queue';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:notify-topic';

function filterRulesOf(node: XmlNode): Array<{ name?: string; value?: string }> {
  const filter = childrenNamed(node, 'Filter')[0];
  const s3Key = filter ? childrenNamed(filter, 'S3Key')[0] : undefined;
  if (!s3Key) return [];
  return childrenNamed(s3Key, 'FilterRule').map(rule => ({
    name: childText(rule, 'Name'),
    value: childText(rule, 'Value'),
  }));
}

describe('S3Emulator — bucket notification configuration', () => {
  let context: TestContext;
  let emulator: S3Emulator;

  beforeEach(async () => {
    context = makeContext();
    emulator = new S3Emulator(context.ctx);
    await emulator.handle(makeReq('PUT', '/notif-bucket'));
  });

  afterEach(() => {
    cleanupContext(context);
  });

  async function putConfig(xml: string): Promise<void> {
    const res = await emulator.handle(
      makeReq('PUT', '/notif-bucket', {
        query: { notification: '' },
        body: xml,
        // The provisioner always sends this flag (LocalStack Pro quirk) — it
        // must be accepted silently.
        headers: { 'x-amz-skip-destination-validation': 'true' },
      }),
    );
    expect(res.status).toBe(200);
  }

  async function getConfig(): Promise<{ raw: string; root: XmlNode }> {
    const res = await emulator.handle(makeReq('GET', '/notif-bucket', { query: { notification: '' } }));
    expect(res.status).toBe(200);
    const raw = bodyText(res.body);
    return { raw, root: parseXml(raw) };
  }

  test('GET before any PUT returns an empty NotificationConfiguration', async () => {
    const { root } = await getConfig();
    expect(root.name).toBe('NotificationConfiguration');
    expect(root.children).toHaveLength(0);
  });

  test('legacy CloudFunctionConfiguration/CloudFunction round-trips with filters', async () => {
    await putConfig(
      '<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        '<CloudFunctionConfiguration>' +
        '<Id>upload-handler</Id>' +
        `<CloudFunction>${LAMBDA_ARN}</CloudFunction>` +
        '<Event>s3:ObjectCreated:*</Event>' +
        '<Filter><S3Key>' +
        '<FilterRule><Name>prefix</Name><Value>uploads/</Value></FilterRule>' +
        '<FilterRule><Name>suffix</Name><Value>.jpg</Value></FilterRule>' +
        '</S3Key></Filter>' +
        '</CloudFunctionConfiguration>' +
        '</NotificationConfiguration>',
    );

    const { raw, root } = await getConfig();
    // Emission uses the LEGACY element names — pinned by the smithy model in
    // @aws-sdk/client-s3 (LambdaFunctionConfigurations serializes as
    // CloudFunctionConfiguration/CloudFunction on the wire).
    expect(raw).toContain('<CloudFunctionConfiguration>');
    expect(raw).toContain(`<CloudFunction>${LAMBDA_ARN}</CloudFunction>`);
    expect(raw).not.toContain('<LambdaFunctionConfiguration>');

    const configs = childrenNamed(root, 'CloudFunctionConfiguration');
    expect(configs).toHaveLength(1);
    expect(childText(configs[0], 'Id')).toBe('upload-handler');
    expect(childrenNamed(configs[0], 'Event').map(e => e.text)).toEqual(['s3:ObjectCreated:*']);
    expect(filterRulesOf(configs[0])).toEqual([
      { name: 'prefix', value: 'uploads/' },
      { name: 'suffix', value: '.jpg' },
    ]);
  });

  test('modern LambdaFunctionConfiguration/LambdaFunctionArn is accepted and re-emitted as legacy', async () => {
    await putConfig(
      '<NotificationConfiguration>' +
        '<LambdaFunctionConfiguration>' +
        `<LambdaFunctionArn>${LAMBDA_ARN}</LambdaFunctionArn>` +
        '<Event>s3:ObjectCreated:Put</Event>' +
        '</LambdaFunctionConfiguration>' +
        '</NotificationConfiguration>',
    );

    const { raw, root } = await getConfig();
    expect(raw).toContain(`<CloudFunction>${LAMBDA_ARN}</CloudFunction>`);
    const configs = childrenNamed(root, 'CloudFunctionConfiguration');
    expect(configs).toHaveLength(1);
    // No Id supplied — one is generated, like AWS does.
    expect(childText(configs[0], 'Id')).toBeTruthy();
    expect(childrenNamed(configs[0], 'Event').map(e => e.text)).toEqual(['s3:ObjectCreated:Put']);

    const normalized = await emulator.getNotificationConfiguration('notif-bucket');
    expect(normalized).toHaveLength(1);
    expect(normalized[0].lambdaFunctionArn).toBe(LAMBDA_ARN);
  });

  test('queue and topic configurations round-trip alongside lambda entries', async () => {
    await putConfig(
      '<NotificationConfiguration>' +
        `<CloudFunctionConfiguration><Id>fn</Id><CloudFunction>${LAMBDA_ARN}</CloudFunction>` +
        '<Event>s3:ObjectCreated:*</Event></CloudFunctionConfiguration>' +
        `<QueueConfiguration><Id>q1</Id><Queue>${QUEUE_ARN}</Queue>` +
        '<Event>s3:ObjectCreated:*</Event><Event>s3:ObjectRemoved:*</Event></QueueConfiguration>' +
        `<TopicConfiguration><Id>t1</Id><Topic>${TOPIC_ARN}</Topic>` +
        '<Event>s3:ObjectRemoved:Delete</Event>' +
        '<Filter><S3Key><FilterRule><Name>Prefix</Name><Value>logs/</Value></FilterRule></S3Key></Filter>' +
        '</TopicConfiguration>' +
        '</NotificationConfiguration>',
    );

    const { root } = await getConfig();
    const queue = childrenNamed(root, 'QueueConfiguration');
    expect(queue).toHaveLength(1);
    expect(childText(queue[0], 'Queue')).toBe(QUEUE_ARN);
    expect(childrenNamed(queue[0], 'Event').map(e => e.text)).toEqual(['s3:ObjectCreated:*', 's3:ObjectRemoved:*']);

    const topic = childrenNamed(root, 'TopicConfiguration');
    expect(topic).toHaveLength(1);
    expect(childText(topic[0], 'Topic')).toBe(TOPIC_ARN);
    // Capitalized rule names are normalized to lowercase.
    expect(filterRulesOf(topic[0])).toEqual([{ name: 'prefix', value: 'logs/' }]);

    expect(childrenNamed(root, 'CloudFunctionConfiguration')).toHaveLength(1);
  });

  test('QueueArn/TopicArn member names are accepted on parse', async () => {
    await putConfig(
      '<NotificationConfiguration>' +
        `<QueueConfiguration><QueueArn>${QUEUE_ARN}</QueueArn><Event>s3:ObjectCreated:*</Event></QueueConfiguration>` +
        `<TopicConfiguration><TopicArn>${TOPIC_ARN}</TopicArn><Event>s3:ObjectRemoved:*</Event></TopicConfiguration>` +
        '</NotificationConfiguration>',
    );
    const { root } = await getConfig();
    expect(childText(childrenNamed(root, 'QueueConfiguration')[0], 'Queue')).toBe(QUEUE_ARN);
    expect(childText(childrenNamed(root, 'TopicConfiguration')[0], 'Topic')).toBe(TOPIC_ARN);
  });

  test('re-PUT replaces the whole configuration; empty PUT clears it', async () => {
    await putConfig(
      '<NotificationConfiguration>' +
        `<CloudFunctionConfiguration><Id>a</Id><CloudFunction>${LAMBDA_ARN}</CloudFunction>` +
        '<Event>s3:ObjectCreated:*</Event></CloudFunctionConfiguration>' +
        '</NotificationConfiguration>',
    );
    await putConfig('<NotificationConfiguration/>');
    const { root } = await getConfig();
    expect(root.children).toHaveLength(0);
    expect(await emulator.getNotificationConfiguration('notif-bucket')).toEqual([]);
  });

  test('getNotificationConfiguration exposes the normalized shape for the dispatcher', async () => {
    await putConfig(
      '<NotificationConfiguration>' +
        '<CloudFunctionConfiguration>' +
        '<Id>upload-handler</Id>' +
        `<CloudFunction>${LAMBDA_ARN}</CloudFunction>` +
        '<Event>s3:ObjectCreated:*</Event><Event>s3:ObjectRemoved:*</Event>' +
        '<Filter><S3Key><FilterRule><Name>prefix</Name><Value>uploads/</Value></FilterRule></S3Key></Filter>' +
        '</CloudFunctionConfiguration>' +
        '</NotificationConfiguration>',
    );

    expect(await emulator.getNotificationConfiguration('notif-bucket')).toEqual([
      {
        id: 'upload-handler',
        lambdaFunctionArn: LAMBDA_ARN,
        events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
        filterRules: [{ name: 'prefix', value: 'uploads/' }],
      },
    ]);
    // Unknown bucket → empty, never a throw (dispatcher hot path).
    expect(await emulator.getNotificationConfiguration('ghost')).toEqual([]);
  });
});
