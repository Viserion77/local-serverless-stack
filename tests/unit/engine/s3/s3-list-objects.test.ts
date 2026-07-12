import { S3Emulator } from '../../../../src/server/engine/emulators/s3/index.js';
import { parseXml, childText, childrenNamed, XmlNode } from '../../../../src/server/engine/http/xml.js';
import { makeContext, cleanupContext, makeReq, bodyText, TestContext } from './helpers';

async function listPage(
  emulator: S3Emulator,
  bucket: string,
  query: Record<string, string> = {},
): Promise<XmlNode> {
  const res = await emulator.handle(makeReq('GET', `/${bucket}`, { query: { 'list-type': '2', ...query } }));
  expect(res.status).toBe(200);
  const root = parseXml(bodyText(res.body));
  expect(root.name).toBe('ListBucketResult');
  return root;
}

function keysOf(root: XmlNode): string[] {
  return childrenNamed(root, 'Contents').map(node => childText(node, 'Key') ?? '');
}

function prefixesOf(root: XmlNode): string[] {
  return childrenNamed(root, 'CommonPrefixes').map(node => childText(node, 'Prefix') ?? '');
}

describe('S3Emulator — ListObjectsV2', () => {
  let context: TestContext;
  let emulator: S3Emulator;

  beforeEach(async () => {
    context = makeContext();
    emulator = new S3Emulator(context.ctx);
    await emulator.handle(makeReq('PUT', '/list-bucket'));
  });

  afterEach(() => {
    cleanupContext(context);
  });

  async function seed(keys: string[]): Promise<void> {
    for (const key of keys) {
      const encoded = key.split('/').map(encodeURIComponent).join('/');
      await emulator.handle(makeReq('PUT', `/list-bucket/${encoded}`, { body: `body:${key}` }));
    }
  }

  test('lists Contents sorted with Key, LastModified, quoted ETag, Size, StorageClass', async () => {
    await seed(['zebra.txt', 'apple.txt']);
    const root = await listPage(emulator, 'list-bucket');
    expect(keysOf(root)).toEqual(['apple.txt', 'zebra.txt']);
    expect(childText(root, 'Name')).toBe('list-bucket');
    expect(childText(root, 'KeyCount')).toBe('2');
    expect(childText(root, 'MaxKeys')).toBe('1000');
    expect(childText(root, 'IsTruncated')).toBe('false');
    const entry = childrenNamed(root, 'Contents')[0];
    expect(childText(entry, 'ETag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(childText(entry, 'Size')).toBe('body:apple.txt'.length.toString());
    expect(childText(entry, 'StorageClass')).toBe('STANDARD');
    expect(Number.isNaN(Date.parse(childText(entry, 'LastModified') ?? ''))).toBe(false);
  });

  test('Prefix filters and is echoed back', async () => {
    await seed(['logs/a.log', 'logs/b.log', 'data/c.bin']);
    const root = await listPage(emulator, 'list-bucket', { prefix: 'logs/' });
    expect(keysOf(root)).toEqual(['logs/a.log', 'logs/b.log']);
    expect(childText(root, 'Prefix')).toBe('logs/');
    expect(childText(root, 'KeyCount')).toBe('2');
  });

  test('Delimiter groups keys beyond the prefix into CommonPrefixes', async () => {
    await seed(['photos/2024/a.jpg', 'photos/2024/b.jpg', 'photos/2025/c.jpg', 'photos/index.html', 'root.txt']);
    const root = await listPage(emulator, 'list-bucket', { prefix: 'photos/', delimiter: '/' });
    expect(keysOf(root)).toEqual(['photos/index.html']);
    expect(prefixesOf(root)).toEqual(['photos/2024/', 'photos/2025/']);
    expect(childText(root, 'Delimiter')).toBe('/');
    expect(childText(root, 'KeyCount')).toBe('3'); // 1 content + 2 prefixes
  });

  test('MaxKeys + ContinuationToken paginate; grouped keys do not consume the budget', async () => {
    await seed(['a.txt', 'b/one.txt', 'b/two.txt', 'c.txt']);

    const page1 = await listPage(emulator, 'list-bucket', { delimiter: '/', 'max-keys': '1' });
    expect(keysOf(page1)).toEqual(['a.txt']);
    expect(prefixesOf(page1)).toEqual([]);
    expect(childText(page1, 'IsTruncated')).toBe('true');
    expect(childText(page1, 'MaxKeys')).toBe('1');
    const token1 = childText(page1, 'NextContinuationToken');
    expect(token1).toBeTruthy();
    // Opaque token: base64, not the raw key.
    expect(token1).not.toContain('a.txt');
    expect(Buffer.from(token1 ?? '', 'base64').toString('utf8')).toBe('a.txt');

    const page2 = await listPage(emulator, 'list-bucket', {
      delimiter: '/',
      'max-keys': '1',
      'continuation-token': token1 ?? '',
    });
    expect(keysOf(page2)).toEqual([]);
    expect(prefixesOf(page2)).toEqual(['b/']);
    expect(childText(page2, 'KeyCount')).toBe('1');
    expect(childText(page2, 'ContinuationToken')).toBe(token1);
    expect(childText(page2, 'IsTruncated')).toBe('true');
    const token2 = childText(page2, 'NextContinuationToken');
    // Both keys under b/ were consumed by the grouped prefix.
    expect(Buffer.from(token2 ?? '', 'base64').toString('utf8')).toBe('b/two.txt');

    const page3 = await listPage(emulator, 'list-bucket', {
      delimiter: '/',
      'max-keys': '1',
      'continuation-token': token2 ?? '',
    });
    expect(keysOf(page3)).toEqual(['c.txt']);
    expect(childText(page3, 'IsTruncated')).toBe('false');
    expect(childText(page3, 'NextContinuationToken')).toBeUndefined();
  });

  test('StartAfter skips keys up to and including the marker', async () => {
    await seed(['a.txt', 'b.txt', 'c.txt']);
    const root = await listPage(emulator, 'list-bucket', { 'start-after': 'a.txt' });
    expect(keysOf(root)).toEqual(['b.txt', 'c.txt']);
    expect(childText(root, 'StartAfter')).toBe('a.txt');
  });

  test('MaxKeys=0 returns an empty non-truncated page', async () => {
    await seed(['a.txt']);
    const root = await listPage(emulator, 'list-bucket', { 'max-keys': '0' });
    expect(keysOf(root)).toEqual([]);
    expect(childText(root, 'KeyCount')).toBe('0');
    expect(childText(root, 'IsTruncated')).toBe('false');
    expect(childText(root, 'NextContinuationToken')).toBeUndefined();
  });

  test('special characters in keys are XML-escaped and round-trip through the parser', async () => {
    const key = 'weird &<>"\'.txt';
    await seed([key]);
    const res = await emulator.handle(makeReq('GET', '/list-bucket', { query: { 'list-type': '2' } }));
    const raw = bodyText(res.body);
    expect(raw).toContain('weird &amp;&lt;&gt;&quot;&apos;.txt');
    const root = parseXml(raw);
    expect(keysOf(root)).toEqual([key]);
  });

  test('encoding-type=url URL-encodes Key, Prefix and CommonPrefixes, preserving slashes', async () => {
    await seed(['docs 2026/héllo wörld+.txt', 'docs 2026/sub dir/inner.txt', 'plain.txt']);
    const root = await listPage(emulator, 'list-bucket', {
      'encoding-type': 'url',
      prefix: 'docs 2026/',
      delimiter: '/',
    });
    expect(childText(root, 'EncodingType')).toBe('url');
    expect(childText(root, 'Prefix')).toBe('docs%202026/');
    expect(keysOf(root)).toEqual(['docs%202026/h%C3%A9llo%20w%C3%B6rld%2B.txt']);
    expect(prefixesOf(root)).toEqual(['docs%202026/sub%20dir/']);
    // The encoded key decodes back to the original.
    expect(decodeURIComponent(keysOf(root)[0])).toBe('docs 2026/héllo wörld+.txt');
  });

  test('pagination walks every key exactly once across many pages', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `item-${String(i).padStart(2, '0')}.txt`);
    await seed(keys);
    const collected: string[] = [];
    let token: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const query: Record<string, string> = { 'max-keys': '3' };
      if (token) query['continuation-token'] = token;
      const page = await listPage(emulator, 'list-bucket', query);
      collected.push(...keysOf(page));
      if (childText(page, 'IsTruncated') !== 'true') break;
      token = childText(page, 'NextContinuationToken');
    }
    expect(collected).toEqual(keys);
  });
});
