import fs from 'fs';
import path from 'path';
import { S3Emulator } from '../../../../src/server/engine/emulators/s3/index.js';
import { parseXml, childText, childrenNamed } from '../../../../src/server/engine/http/xml.js';
import {
  makeContext,
  cleanupContext,
  makeReq,
  expectAwsError,
  bodyText,
  collectObjectEvents,
  flushEvents,
  TestContext,
} from './helpers';

const HELLO_MD5 = '5eb63bbbe01eeed093cb22bb8f5acdc3'; // md5("hello world")

describe('S3Emulator — objects', () => {
  let context: TestContext;
  let emulator: S3Emulator;

  beforeEach(async () => {
    context = makeContext();
    emulator = new S3Emulator(context.ctx);
    await emulator.handle(makeReq('PUT', '/my-bucket'));
  });

  afterEach(() => {
    cleanupContext(context);
  });

  test('put/get/head round trip is byte-exact for binary bodies with metadata and content-type', async () => {
    const body = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const put = await emulator.handle(
      makeReq('PUT', '/my-bucket/bin/blob.dat', {
        body,
        headers: {
          'content-type': 'application/x-custom',
          'x-amz-meta-owner': 'jeff',
          'x-amz-meta-purpose': 'fixture',
        },
      }),
    );
    expect(put.status).toBe(200);

    const get = await emulator.handle(makeReq('GET', '/my-bucket/bin/blob.dat'));
    expect(get.status).toBe(200);
    expect(Buffer.isBuffer(get.body)).toBe(true);
    expect(Buffer.compare(get.body as Buffer, body)).toBe(0);
    expect(get.headers?.['Content-Type']).toBe('application/x-custom');
    expect(get.headers?.['Content-Length']).toBe('256');
    expect(get.headers?.['Accept-Ranges']).toBe('bytes');
    expect(get.headers?.['x-amz-meta-owner']).toBe('jeff');
    expect(get.headers?.['x-amz-meta-purpose']).toBe('fixture');
    expect(get.headers?.['Last-Modified']).toMatch(/GMT$/);

    const head = await emulator.handle(makeReq('HEAD', '/my-bucket/bin/blob.dat'));
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
    expect(head.headers?.['Content-Length']).toBe('256');
    expect(head.headers?.['Content-Type']).toBe('application/x-custom');
    expect(head.headers?.['x-amz-meta-owner']).toBe('jeff');
    expect(head.headers?.ETag).toBe(get.headers?.ETag);
  });

  test('PutObject returns the QUOTED md5 ETag; GET echoes it', async () => {
    const put = await emulator.handle(makeReq('PUT', '/my-bucket/hello.txt', { body: 'hello world' }));
    expect(put.headers?.ETag).toBe(`"${HELLO_MD5}"`);
    const get = await emulator.handle(makeReq('GET', '/my-bucket/hello.txt'));
    expect(get.headers?.ETag).toBe(`"${HELLO_MD5}"`);
  });

  test('keys with URL-encoded segments are decoded, slashes preserved', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket/docs/a%20b/c%2Bd.txt', { body: 'x' }));
    const get = await emulator.handle(makeReq('GET', '/my-bucket/docs/a%20b/c%2Bd.txt'));
    expect(get.status).toBe(200);
    // The decoded key is a single index entry, listable under its prefix.
    const list = await emulator.handle(
      makeReq('GET', '/my-bucket', { query: { 'list-type': '2', prefix: 'docs/a b/' } }),
    );
    const root = parseXml(bodyText(list.body));
    expect(childText(childrenNamed(root, 'Contents')[0], 'Key')).toBe('docs/a b/c+d.txt');
  });

  test('GetObject on a missing key throws NoSuchKey 404; missing bucket NoSuchBucket', async () => {
    await expectAwsError(emulator.handle(makeReq('GET', '/my-bucket/ghost.txt')), 'NoSuchKey', 404);
    await expectAwsError(emulator.handle(makeReq('HEAD', '/my-bucket/ghost.txt')), 'NoSuchKey', 404);
    await expectAwsError(emulator.handle(makeReq('GET', '/ghost/whatever.txt')), 'NoSuchBucket', 404);
  });

  test('presigned response-* query params override GET/HEAD response headers', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket/report.bin', {
      body: 'data',
      headers: { 'content-type': 'application/octet-stream' },
    }));
    const query = {
      'response-content-disposition': 'attachment; filename="Q3 Report.pdf"',
      'response-content-type': 'application/pdf',
      'response-cache-control': 'no-store',
      'response-content-encoding': 'gzip',
      'response-content-language': 'en-US',
      'response-expires': 'Wed, 21 Oct 2026 07:28:00 GMT',
    };
    const get = await emulator.handle(makeReq('GET', '/my-bucket/report.bin', { query }));
    expect(get.headers?.['Content-Disposition']).toBe('attachment; filename="Q3 Report.pdf"');
    expect(get.headers?.['Content-Type']).toBe('application/pdf');
    expect(get.headers?.['Cache-Control']).toBe('no-store');
    expect(get.headers?.['Content-Encoding']).toBe('gzip');
    expect(get.headers?.['Content-Language']).toBe('en-US');
    expect(get.headers?.Expires).toBe('Wed, 21 Oct 2026 07:28:00 GMT');

    // HEAD honors them too.
    const head = await emulator.handle(makeReq('HEAD', '/my-bucket/report.bin', {
      query: { 'response-content-disposition': 'inline' },
    }));
    expect(head.headers?.['Content-Disposition']).toBe('inline');

    // Absent overrides leave the stored content-type intact.
    const plain = await emulator.handle(makeReq('GET', '/my-bucket/report.bin'));
    expect(plain.headers?.['Content-Type']).toBe('application/octet-stream');
    expect(plain.headers?.['Content-Disposition']).toBeUndefined();
  });

  test('Range requests: bounded, open-ended, suffix, unsatisfiable and malformed', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket/digits.txt', { body: '0123456789' }));

    const bounded = await emulator.handle(
      makeReq('GET', '/my-bucket/digits.txt', { headers: { range: 'bytes=2-5' } }),
    );
    expect(bounded.status).toBe(206);
    expect(bodyText(bounded.body)).toBe('2345');
    expect(bounded.headers?.['Content-Range']).toBe('bytes 2-5/10');
    expect(bounded.headers?.['Content-Length']).toBe('4');

    const open = await emulator.handle(makeReq('GET', '/my-bucket/digits.txt', { headers: { range: 'bytes=6-' } }));
    expect(open.status).toBe(206);
    expect(bodyText(open.body)).toBe('6789');
    expect(open.headers?.['Content-Range']).toBe('bytes 6-9/10');

    const suffix = await emulator.handle(makeReq('GET', '/my-bucket/digits.txt', { headers: { range: 'bytes=-3' } }));
    expect(suffix.status).toBe(206);
    expect(bodyText(suffix.body)).toBe('789');
    expect(suffix.headers?.['Content-Range']).toBe('bytes 7-9/10');

    // End clamped to the object size.
    const clamped = await emulator.handle(
      makeReq('GET', '/my-bucket/digits.txt', { headers: { range: 'bytes=8-99' } }),
    );
    expect(bodyText(clamped.body)).toBe('89');
    expect(clamped.headers?.['Content-Range']).toBe('bytes 8-9/10');

    await expectAwsError(
      emulator.handle(makeReq('GET', '/my-bucket/digits.txt', { headers: { range: 'bytes=10-' } })),
      'InvalidRange',
      416,
    );

    // A malformed Range header is ignored — full 200 response, like AWS.
    const malformed = await emulator.handle(
      makeReq('GET', '/my-bucket/digits.txt', { headers: { range: 'bytes=abc' } }),
    );
    expect(malformed.status).toBe(200);
    expect(bodyText(malformed.body)).toBe('0123456789');
  });

  test('overwrite replaces content and deletes the previous blob', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket/note.txt', { body: 'version one' }));
    const blobDir = path.join(context.root, 's3', 'my-bucket', 'blobs');
    expect(fs.readdirSync(blobDir)).toHaveLength(1);
    const oldBlob = fs.readdirSync(blobDir)[0];

    await emulator.handle(makeReq('PUT', '/my-bucket/note.txt', { body: 'version two' }));
    const blobs = fs.readdirSync(blobDir);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).not.toBe(oldBlob);
    const get = await emulator.handle(makeReq('GET', '/my-bucket/note.txt'));
    expect(bodyText(get.body)).toBe('version two');
  });

  test('a blob shared by two keys survives until the last referencing key is deleted', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket/a.txt', { body: 'same bytes' }));
    await emulator.handle(makeReq('PUT', '/my-bucket/b.txt', { body: 'same bytes' }));
    const blobDir = path.join(context.root, 's3', 'my-bucket', 'blobs');
    expect(fs.readdirSync(blobDir)).toHaveLength(1); // content-addressed

    await emulator.handle(makeReq('DELETE', '/my-bucket/a.txt'));
    expect(fs.readdirSync(blobDir)).toHaveLength(1);
    const get = await emulator.handle(makeReq('GET', '/my-bucket/b.txt'));
    expect(bodyText(get.body)).toBe('same bytes');

    await emulator.handle(makeReq('DELETE', '/my-bucket/b.txt'));
    expect(fs.readdirSync(blobDir)).toHaveLength(0);
  });

  test('DeleteObject returns 204 even when the key does not exist', async () => {
    const res = await emulator.handle(makeReq('DELETE', '/my-bucket/never-there.txt'));
    expect(res.status).toBe(204);
  });

  test('CopyObject copies bytes, metadata and content-type across buckets', async () => {
    await emulator.handle(makeReq('PUT', '/dest-bucket'));
    await emulator.handle(
      makeReq('PUT', '/my-bucket/src%20file.txt', {
        body: 'hello world',
        headers: { 'content-type': 'text/plain', 'x-amz-meta-tag': 'orig' },
      }),
    );

    const copy = await emulator.handle(
      makeReq('PUT', '/dest-bucket/copied.txt', {
        headers: { 'x-amz-copy-source': '/my-bucket/src%20file.txt' },
      }),
    );
    expect(copy.status).toBe(200);
    const result = parseXml(bodyText(copy.body));
    expect(result.name).toBe('CopyObjectResult');
    expect(childText(result, 'ETag')).toBe(`"${HELLO_MD5}"`);
    expect(Number.isNaN(Date.parse(childText(result, 'LastModified') ?? ''))).toBe(false);

    const get = await emulator.handle(makeReq('GET', '/dest-bucket/copied.txt'));
    expect(bodyText(get.body)).toBe('hello world');
    expect(get.headers?.['Content-Type']).toBe('text/plain');
    expect(get.headers?.['x-amz-meta-tag']).toBe('orig');
    expect(get.headers?.ETag).toBe(`"${HELLO_MD5}"`);
  });

  test('CopyObject with REPLACE metadata directive takes headers from the request', async () => {
    await emulator.handle(
      makeReq('PUT', '/my-bucket/src.txt', {
        body: 'payload',
        headers: { 'content-type': 'text/plain', 'x-amz-meta-tag': 'orig' },
      }),
    );
    await emulator.handle(
      makeReq('PUT', '/my-bucket/dst.txt', {
        headers: {
          'x-amz-copy-source': 'my-bucket/src.txt',
          'x-amz-metadata-directive': 'REPLACE',
          'content-type': 'application/json',
          'x-amz-meta-tag': 'replaced',
        },
      }),
    );
    const get = await emulator.handle(makeReq('GET', '/my-bucket/dst.txt'));
    expect(get.headers?.['Content-Type']).toBe('application/json');
    expect(get.headers?.['x-amz-meta-tag']).toBe('replaced');
  });

  test('CopyObject error paths: missing source key/bucket, malformed source', async () => {
    await expectAwsError(
      emulator.handle(
        makeReq('PUT', '/my-bucket/x.txt', { headers: { 'x-amz-copy-source': '/my-bucket/ghost.txt' } }),
      ),
      'NoSuchKey',
      404,
    );
    await expectAwsError(
      emulator.handle(makeReq('PUT', '/my-bucket/x.txt', { headers: { 'x-amz-copy-source': '/ghost/y.txt' } })),
      'NoSuchBucket',
      404,
    );
    await expectAwsError(
      emulator.handle(makeReq('PUT', '/my-bucket/x.txt', { headers: { 'x-amz-copy-source': 'just-a-bucket' } })),
      'InvalidArgument',
      400,
    );
  });

  test('DeleteObjects XML round trip reports Deleted keys', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket/one.txt', { body: '1' }));
    await emulator.handle(makeReq('PUT', '/my-bucket/two.txt', { body: '2' }));
    await emulator.handle(makeReq('PUT', '/my-bucket/keep.txt', { body: '3' }));

    const body =
      '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      '<Object><Key>one.txt</Key></Object><Object><Key>two.txt</Key></Object></Delete>';
    const res = await emulator.handle(makeReq('POST', '/my-bucket', { query: { delete: '' }, body }));
    expect(res.status).toBe(200);
    const root = parseXml(bodyText(res.body));
    expect(root.name).toBe('DeleteResult');
    const deleted = childrenNamed(root, 'Deleted').map(node => childText(node, 'Key'));
    expect(deleted).toEqual(['one.txt', 'two.txt']);

    await expectAwsError(emulator.handle(makeReq('GET', '/my-bucket/one.txt')), 'NoSuchKey', 404);
    const keep = await emulator.handle(makeReq('GET', '/my-bucket/keep.txt'));
    expect(keep.status).toBe(200);
  });

  test('DeleteObjects with Quiet omits Deleted entries', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket/one.txt', { body: '1' }));
    const body = '<Delete><Object><Key>one.txt</Key></Object><Quiet>true</Quiet></Delete>';
    const res = await emulator.handle(makeReq('POST', '/my-bucket', { query: { delete: '' }, body }));
    const root = parseXml(bodyText(res.body));
    expect(root.name).toBe('DeleteResult');
    expect(childrenNamed(root, 'Deleted')).toHaveLength(0);
    await expectAwsError(emulator.handle(makeReq('GET', '/my-bucket/one.txt')), 'NoSuchKey', 404);
  });

  describe('object events', () => {
    test('PutObject emits s3:ObjectCreated:Put post-commit with size and unquoted eTag', async () => {
      const events = collectObjectEvents(context.bus);
      await emulator.handle(makeReq('PUT', '/my-bucket/hello.txt', { body: 'hello world' }));
      expect(events).toHaveLength(0); // deferred via setImmediate
      await flushEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        region: 'us-east-1',
        bucket: 'my-bucket',
        eventName: 's3:ObjectCreated:Put',
        key: 'hello.txt',
        size: 11,
        eTag: HELLO_MD5,
      });
      expect(events[0].sequencer).toMatch(/^[0-9A-F]{16,}$/);
    });

    test('copy and delete emit their event names; DeleteObjects emits one per key', async () => {
      const events = collectObjectEvents(context.bus);
      await emulator.handle(makeReq('PUT', '/my-bucket/a.txt', { body: 'abc' }));
      await emulator.handle(
        makeReq('PUT', '/my-bucket/b.txt', { headers: { 'x-amz-copy-source': '/my-bucket/a.txt' } }),
      );
      await emulator.handle(makeReq('DELETE', '/my-bucket/a.txt'));
      const body = '<Delete><Object><Key>b.txt</Key></Object></Delete>';
      await emulator.handle(makeReq('POST', '/my-bucket', { query: { delete: '' }, body }));
      await flushEvents();

      expect(events.map(e => e.eventName)).toEqual([
        's3:ObjectCreated:Put',
        's3:ObjectCreated:Copy',
        's3:ObjectRemoved:Delete',
        's3:ObjectRemoved:Delete',
      ]);
      const removals = events.filter(e => e.eventName === 's3:ObjectRemoved:Delete');
      expect(removals.map(e => e.key)).toEqual(['a.txt', 'b.txt']);
      for (const removal of removals) expect(removal.size).toBe(0);
    });

    test('sequencers are strictly increasing hex across events', async () => {
      const events = collectObjectEvents(context.bus);
      for (let i = 0; i < 5; i++) {
        await emulator.handle(makeReq('PUT', `/my-bucket/seq-${i}.txt`, { body: `v${i}` }));
      }
      await flushEvents();
      expect(events).toHaveLength(5);
      const values = events.map(e => BigInt(`0x${e.sequencer}`));
      for (let i = 1; i < values.length; i++) {
        expect(values[i] > values[i - 1]).toBe(true);
      }
    });
  });
});
