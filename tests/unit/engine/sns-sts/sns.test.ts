// SnsEmulator: Query-protocol XML documents (shape-asserted via the engine's
// own strict parser), topic lifecycle idempotency the provisioner depends on,
// and Publish as a counted, logged no-op.
import { SnsEmulator } from '../../../../src/server/engine/emulators/sns/index';
import { EngineBus } from '../../../../src/server/engine/bus';
import { parseXml, childText, childrenNamed } from '../../../../src/server/engine/http/xml';
import type { AwsRequest, EngineContext } from '../../../../src/server/engine/types';
import type { CatalogStore, EngineStore } from '../../../../src/server/engine/store/store-types';

class FakeCatalog<T> implements CatalogStore<T> {
  private map = new Map<string, T>();
  async load(): Promise<void> {}
  get(key: string): T | undefined { return this.map.get(key); }
  set(key: string, value: T): void { this.map.set(key, value); }
  delete(key: string): boolean { return this.map.delete(key); }
  keys(): string[] { return [...this.map.keys()]; }
  values(): T[] { return [...this.map.values()]; }
  async flush(): Promise<void> {}
}

function makeContext(): EngineContext {
  const catalogs = new Map<string, FakeCatalog<unknown>>();
  const store = {
    dir: (...segments: string[]) => segments.join('/'),
    catalog<T>(relPath: string): CatalogStore<T> {
      if (!catalogs.has(relPath)) catalogs.set(relPath, new FakeCatalog());
      return catalogs.get(relPath) as CatalogStore<T>;
    },
    table: () => { throw new Error('not used'); },
    writeBlob: async () => { throw new Error('not used'); },
    readBlob: async () => { throw new Error('not used'); },
    deleteBlob: async () => { throw new Error('not used'); },
    startSweeper: () => {},
    stopSweeper: () => {},
    flushAll: async () => {},
  } as unknown as EngineStore;
  return {
    config: {
      port: 14566, dataDir: '/unused', account: '000000000000', region: 'us-east-1',
      idleUnloadMs: 60000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store,
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
}

function request(region = 'us-east-1'): AwsRequest {
  return {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'sns', region, requestId: 'test-request',
  };
}

const ORDERS_ARN = 'arn:aws:sns:us-east-1:000000000000:orders-topic';

let emulator: SnsEmulator;

beforeEach(() => {
  emulator = new SnsEmulator(makeContext());
});

async function handle(action: string, params: Record<string, string> = {}): Promise<string> {
  return emulator.handle(action, params, request());
}

test('CreateTopic returns the full Query XML document and is idempotent by name', async () => {
  const xml = await handle('CreateTopic', { Name: 'orders-topic' });
  const root = parseXml(xml);
  expect(root.name).toBe('CreateTopicResponse');
  expect(root.attributes.xmlns).toBe('http://sns.amazonaws.com/doc/2010-03-31/');
  const result = childrenNamed(root, 'CreateTopicResult')[0];
  expect(childText(result, 'TopicArn')).toBe(ORDERS_ARN);
  const metadata = childrenNamed(root, 'ResponseMetadata')[0];
  expect(childText(metadata, 'RequestId')).toMatch(/^[0-9a-f-]{36}$/);

  const again = parseXml(await handle('CreateTopic', { Name: 'orders-topic' }));
  expect(childText(childrenNamed(again, 'CreateTopicResult')[0], 'TopicArn')).toBe(ORDERS_ARN);
});

test('CreateTopic without a Name throws InvalidParameter', async () => {
  await expect(handle('CreateTopic', {})).rejects.toMatchObject({ code: 'InvalidParameter' });
});

test('ListTopics returns Topics/member/TopicArn entries, empty when no topics exist', async () => {
  const empty = parseXml(await handle('ListTopics'));
  expect(empty.name).toBe('ListTopicsResponse');
  const emptyTopics = childrenNamed(childrenNamed(empty, 'ListTopicsResult')[0], 'Topics')[0];
  expect(emptyTopics.children).toHaveLength(0);

  await handle('CreateTopic', { Name: 'orders-topic' });
  await handle('CreateTopic', { Name: 'alerts' });
  const listed = parseXml(await handle('ListTopics'));
  const members = childrenNamed(childrenNamed(childrenNamed(listed, 'ListTopicsResult')[0], 'Topics')[0], 'member');
  const arns = members.map(member => childText(member, 'TopicArn'));
  expect(arns).toContain(ORDERS_ARN);
  expect(arns).toContain('arn:aws:sns:us-east-1:000000000000:alerts');
  // The provisioner's deleteSNSTopic matches by endsWith(':' + name).
  expect(arns.some(arn => arn?.endsWith(':orders-topic'))).toBe(true);
});

test('GetTopicAttributes returns TopicArn and DisplayName entries', async () => {
  await handle('CreateTopic', {
    Name: 'orders-topic',
    'Attributes.entry.1.key': 'DisplayName',
    'Attributes.entry.1.value': 'Orders',
  });
  const root = parseXml(await handle('GetTopicAttributes', { TopicArn: ORDERS_ARN }));
  const attributes = childrenNamed(childrenNamed(root, 'GetTopicAttributesResult')[0], 'Attributes')[0];
  const map = Object.fromEntries(
    childrenNamed(attributes, 'entry').map(entry => [childText(entry, 'key'), childText(entry, 'value')]),
  );
  expect(map.TopicArn).toBe(ORDERS_ARN);
  expect(map.DisplayName).toBe('Orders');

  await handle('CreateTopic', { Name: 'plain' });
  const plain = parseXml(await handle('GetTopicAttributes', { TopicArn: 'arn:aws:sns:us-east-1:000000000000:plain' }));
  const plainAttributes = childrenNamed(childrenNamed(plain, 'GetTopicAttributesResult')[0], 'Attributes')[0];
  const displayName = childrenNamed(plainAttributes, 'entry').find(entry => childText(entry, 'key') === 'DisplayName');
  // DisplayName is present with an empty value (self-closed <value/>).
  expect(displayName && (childText(displayName, 'value') ?? '')).toBe('');

  await expect(handle('GetTopicAttributes', { TopicArn: 'arn:aws:sns:us-east-1:000000000000:ghost' }))
    .rejects.toMatchObject({ code: 'NotFound', status: 404 });
});

test('DeleteTopic removes the topic, omits a Result element, and is idempotent', async () => {
  await handle('CreateTopic', { Name: 'orders-topic' });
  const root = parseXml(await handle('DeleteTopic', { TopicArn: ORDERS_ARN }));
  expect(root.name).toBe('DeleteTopicResponse');
  expect(childrenNamed(root, 'DeleteTopicResult')).toHaveLength(0);
  expect(childrenNamed(root, 'ResponseMetadata')).toHaveLength(1);

  const listed = parseXml(await handle('ListTopics'));
  expect(childrenNamed(childrenNamed(listed, 'ListTopicsResult')[0], 'Topics')[0].children).toHaveLength(0);
  await expect(handle('DeleteTopic', { TopicArn: ORDERS_ARN })).resolves.toContain('DeleteTopicResponse');
});

test('Publish returns a MessageId, logs one line, counts per topic, and stores nothing', async () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await handle('CreateTopic', { Name: 'orders-topic' });
    const root = parseXml(await handle('Publish', { TopicArn: ORDERS_ARN, Message: '{"orderId":1}' }));
    const messageId = childText(childrenNamed(root, 'PublishResult')[0], 'MessageId');
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logSpy).toHaveBeenCalledTimes(1);

    await handle('Publish', { TargetArn: ORDERS_ARN, Message: 'via TargetArn' });
    expect(emulator.publishCount(ORDERS_ARN)).toBe(2);
    expect(emulator.publishCount('arn:aws:sns:us-east-1:000000000000:other')).toBe(0);
  } finally {
    logSpy.mockRestore();
  }
});

test('Publish error shapes: missing topic is a 404 NotFound Sender fault; empty message rejected', async () => {
  await expect(handle('Publish', { TopicArn: 'arn:aws:sns:us-east-1:000000000000:ghost', Message: 'x' }))
    .rejects.toMatchObject({ code: 'NotFound', status: 404, fault: 'Sender', message: 'Topic does not exist' });
  await handle('CreateTopic', { Name: 'orders-topic' });
  await expect(handle('Publish', { TopicArn: ORDERS_ARN }))
    .rejects.toMatchObject({ code: 'InvalidParameter' });
  await expect(handle('Publish', {})).rejects.toMatchObject({ code: 'InvalidParameter' });
});

test('unknown actions throw NotImplemented', async () => {
  await expect(handle('Subscribe', { TopicArn: ORDERS_ARN, Protocol: 'sqs' }))
    .rejects.toMatchObject({ code: 'NotImplemented' });
});
