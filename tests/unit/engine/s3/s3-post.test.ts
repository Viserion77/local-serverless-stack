// Presigned POST (browser form upload): multipart/form-data to the bucket
// stores the object exactly like PutObject, honors ${filename} substitution,
// success_action_status/redirect and x-amz-meta-* fields, and emits an
// s3:ObjectCreated:Post event. Policy/signature fields are accepted, not
// verified (the engine never verifies SigV4).
import { S3Emulator } from '../../../../src/server/engine/emulators/s3';
import {
  cleanupContext, collectObjectEvents, flushEvents, makeContext, makeReq, expectAwsError,
  type TestContext,
} from './helpers';

const BOUNDARY = 'lssBOUNDARY123';

interface Part {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

function buildMultipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) header += `; filename="${part.filename}"`;
    header += '\r\n';
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(part.data ?? Buffer.from(part.value ?? '', 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function postReq(bucket: string, parts: Part[]) {
  return makeReq('POST', `/${bucket}`, {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: buildMultipart(parts),
  });
}

describe('S3 presigned POST', () => {
  let context: TestContext;
  let s3: S3Emulator;

  beforeEach(async () => {
    context = makeContext();
    s3 = new S3Emulator(context.ctx);
    await s3.handle(makeReq('PUT', '/uploads'));
  });

  afterEach(() => cleanupContext(context));

  it('stores the object and returns 204 by default', async () => {
    const events = collectObjectEvents(context.bus);
    const res = await s3.handle(postReq('uploads', [
      { name: 'key', value: 'docs/hello.txt' },
      { name: 'Content-Type', value: 'text/plain' },
      { name: 'file', filename: 'hello.txt', contentType: 'text/plain', data: Buffer.from('hello world') },
    ]));
    expect(res.status).toBe(204);
    expect(res.headers?.ETag).toBe('"5eb63bbbe01eeed093cb22bb8f5acdc3"');

    const got = await s3.handle(makeReq('GET', '/uploads/docs/hello.txt'));
    expect(got.status).toBe(200);
    expect(got.body?.toString()).toBe('hello world');
    expect(got.headers?.['Content-Type']).toBe('text/plain');

    await flushEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('s3:ObjectCreated:Post');
    expect(events[0].key).toBe('docs/hello.txt');
  });

  it('substitutes ${filename} with the uploaded file name', async () => {
    await s3.handle(postReq('uploads', [
      { name: 'key', value: 'incoming/${filename}' },
      { name: 'file', filename: 'report.pdf', data: Buffer.from('%PDF-1.7') },
    ]));
    const got = await s3.handle(makeReq('GET', '/uploads/incoming/report.pdf'));
    expect(got.status).toBe(200);
    expect(got.body?.toString()).toBe('%PDF-1.7');
  });

  it('honors success_action_status=201 with a PostResponse document', async () => {
    const res = await s3.handle(postReq('uploads', [
      { name: 'key', value: 'a/b.txt' },
      { name: 'success_action_status', value: '201' },
      { name: 'file', filename: 'b.txt', data: Buffer.from('x') },
    ]));
    expect(res.status).toBe(201);
    const xml = res.body?.toString() ?? '';
    expect(xml).toContain('<PostResponse>');
    expect(xml).toContain('<Bucket>uploads</Bucket>');
    expect(xml).toContain('<Key>a/b.txt</Key>');
    // The ETag carries its quotes; XML-escaped in element content, which any
    // XML parser decodes back to the literal quoted value.
    expect(xml).toContain('9dd4e461268c8034f5c8564e155c67a6');
    expect(xml).toMatch(/<ETag>(&quot;|")9dd4e461268c8034f5c8564e155c67a6(&quot;|")<\/ETag>/);
  });

  it('honors success_action_status=200', async () => {
    const res = await s3.handle(postReq('uploads', [
      { name: 'key', value: 'k' },
      { name: 'success_action_status', value: '200' },
      { name: 'file', filename: 'k', data: Buffer.from('x') },
    ]));
    expect(res.status).toBe(200);
  });

  it('303-redirects with bucket/key/etag appended when success_action_redirect is set', async () => {
    const res = await s3.handle(postReq('uploads', [
      { name: 'key', value: 'r/obj' },
      { name: 'success_action_redirect', value: 'https://app.example.com/done' },
      { name: 'file', filename: 'obj', data: Buffer.from('data') },
    ]));
    expect(res.status).toBe(303);
    const location = new URL(res.headers!.Location);
    expect(location.origin + location.pathname).toBe('https://app.example.com/done');
    expect(location.searchParams.get('bucket')).toBe('uploads');
    expect(location.searchParams.get('key')).toBe('r/obj');
    expect(location.searchParams.get('etag')).toBe('"8d777f385d3dfec8815d20f7496026dc"');
  });

  it('captures x-amz-meta-* form fields as object metadata', async () => {
    await s3.handle(postReq('uploads', [
      { name: 'key', value: 'meta.txt' },
      { name: 'x-amz-meta-owner', value: 'alice' },
      { name: 'file', filename: 'meta.txt', data: Buffer.from('x') },
    ]));
    const head = await s3.handle(makeReq('HEAD', '/uploads/meta.txt'));
    expect(head.headers?.['x-amz-meta-owner']).toBe('alice');
  });

  it('preserves binary file bytes exactly', async () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x0d, 0x0a, 0x2d, 0x80]);
    await s3.handle(postReq('uploads', [
      { name: 'key', value: 'blob.bin' },
      { name: 'file', filename: 'blob.bin', data: binary },
    ]));
    const got = await s3.handle(makeReq('GET', '/uploads/blob.bin'));
    expect(Buffer.compare(got.body as Buffer, binary)).toBe(0);
  });

  it('inserts a filename with $-sequences literally into the key', async () => {
    // A crafted filename must not be interpreted as a String.replace pattern.
    await s3.handle(postReq('uploads', [
      { name: 'key', value: 'in/${filename}' },
      { name: 'file', filename: 'a$&$`b.txt', data: Buffer.from('x') },
    ]));
    const got = await s3.handle(makeReq('GET', '/uploads/in/a$&$`b.txt'));
    expect(got.status).toBe(200);
  });

  it('rejects a POST with no file part', async () => {
    await expectAwsError(
      s3.handle(postReq('uploads', [{ name: 'key', value: 'k' }])),
      'InvalidArgument',
      400,
    );
  });

  it('rejects a POST with no key field', async () => {
    await expectAwsError(
      s3.handle(postReq('uploads', [{ name: 'file', filename: 'f', data: Buffer.from('x') }])),
      'InvalidArgument',
      400,
    );
  });

  it('fails on a POST to a missing bucket', async () => {
    await expectAwsError(
      s3.handle(postReq('ghost', [
        { name: 'key', value: 'k' },
        { name: 'file', filename: 'f', data: Buffer.from('x') },
      ])),
      'NoSuchBucket',
      404,
    );
  });
});
