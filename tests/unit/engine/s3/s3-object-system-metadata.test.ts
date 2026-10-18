// Object system metadata (Content-Disposition, Cache-Control,
// Content-Encoding, Content-Language, Expires) and server-side encryption:
// stored by PutObject / presigned POST / CopyObject, replayed by Get/Head,
// with SSE defaulting to the bucket's default encryption like AWS reports.
import { S3Emulator } from '../../../../src/server/engine/emulators/s3/index.js';
import { makeContext, cleanupContext, makeReq, expectAwsError, TestContext } from './helpers';

const SYSTEM_HEADERS = {
  'content-disposition': 'attachment; filename="invoice-42.pdf"',
  'cache-control': 'max-age=3600',
  'content-encoding': 'gzip',
  'content-language': 'en-US',
  expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
};

const BOUNDARY = 'acmeBOUNDARY';

function postReq(bucket: string, fields: Record<string, string>, data = 'posted') {
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  chunks.push(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\n\r\n${data}\r\n`);
  chunks.push(`--${BOUNDARY}--\r\n`);
  return makeReq('POST', `/${bucket}`, {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: chunks.join(''),
  });
}

function setKmsDefault(emulator: S3Emulator, bucket: string, keyId: string | undefined, bucketKey: boolean) {
  const key = keyId === undefined ? '' : `<KMSMasterKeyID>${keyId}</KMSMasterKeyID>`;
  return emulator.handle(
    makeReq('PUT', `/${bucket}`, {
      query: { encryption: '' },
      body:
        '<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault>' +
        `<SSEAlgorithm>aws:kms</SSEAlgorithm>${key}</ApplyServerSideEncryptionByDefault>` +
        `<BucketKeyEnabled>${bucketKey}</BucketKeyEnabled></Rule></ServerSideEncryptionConfiguration>`,
    }),
  );
}

describe('S3Emulator — object system metadata and SSE', () => {
  let context: TestContext;
  let emulator: S3Emulator;

  beforeEach(async () => {
    context = makeContext();
    emulator = new S3Emulator(context.ctx);
    await emulator.handle(makeReq('PUT', '/acme-orders'));
  });

  afterEach(() => cleanupContext(context));

  test('PutObject stores the system headers and Get/Head replay them; SSE defaults to AES256', async () => {
    const put = await emulator.handle(makeReq('PUT', '/acme-orders/invoice.pdf', { body: 'x', headers: SYSTEM_HEADERS }));
    expect(put.headers?.['x-amz-server-side-encryption']).toBe('AES256');
    expect(put.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined();

    for (const method of ['GET', 'HEAD']) {
      const res = await emulator.handle(makeReq(method, '/acme-orders/invoice.pdf'));
      expect(res.headers?.['Content-Disposition']).toBe(SYSTEM_HEADERS['content-disposition']);
      expect(res.headers?.['Cache-Control']).toBe('max-age=3600');
      expect(res.headers?.['Content-Encoding']).toBe('gzip');
      expect(res.headers?.['Content-Language']).toBe('en-US');
      expect(res.headers?.Expires).toBe(SYSTEM_HEADERS.expires);
      expect(res.headers?.['x-amz-server-side-encryption']).toBe('AES256');
      expect(res.headers?.['x-amz-server-side-encryption-bucket-key-enabled']).toBeUndefined();
    }
  });

  test('absent or empty system headers are not emitted', async () => {
    await emulator.handle(makeReq('PUT', '/acme-orders/plain.txt', { body: 'x', headers: { 'cache-control': '' } }));
    const head = await emulator.handle(makeReq('HEAD', '/acme-orders/plain.txt'));
    for (const name of ['Content-Disposition', 'Cache-Control', 'Content-Encoding', 'Content-Language', 'Expires']) {
      expect(head.headers?.[name]).toBeUndefined();
    }
  });

  test('response-* query overrides still win over the stored headers', async () => {
    await emulator.handle(makeReq('PUT', '/acme-orders/invoice.pdf', { body: 'x', headers: SYSTEM_HEADERS }));
    const get = await emulator.handle(
      makeReq('GET', '/acme-orders/invoice.pdf', {
        query: { 'response-content-disposition': 'inline', 'response-cache-control': 'no-store' },
      }),
    );
    expect(get.headers?.['Content-Disposition']).toBe('inline');
    expect(get.headers?.['Cache-Control']).toBe('no-store');
    expect(get.headers?.['Content-Encoding']).toBe('gzip');
  });

  test('explicit SSE-KMS headers are stored and echoed', async () => {
    const put = await emulator.handle(
      makeReq('PUT', '/acme-orders/secret.bin', {
        body: 'x',
        headers: {
          'x-amz-server-side-encryption': 'aws:kms',
          'x-amz-server-side-encryption-aws-kms-key-id': 'arn:aws:kms:us-east-1:000000000000:key/acme',
          'x-amz-server-side-encryption-bucket-key-enabled': 'TRUE',
        },
      }),
    );
    expect(put.headers?.['x-amz-server-side-encryption']).toBe('aws:kms');
    const head = await emulator.handle(makeReq('HEAD', '/acme-orders/secret.bin'));
    expect(head.headers?.['x-amz-server-side-encryption']).toBe('aws:kms');
    expect(head.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBe('arn:aws:kms:us-east-1:000000000000:key/acme');
    expect(head.headers?.['x-amz-server-side-encryption-bucket-key-enabled']).toBe('true');
  });

  test('explicit aws:kms without a key id records no key and inherits the bucket-level Bucket Key setting', async () => {
    await setKmsDefault(emulator, 'acme-orders', 'alias/bucket-default', true);
    await emulator.handle(makeReq('PUT', '/acme-orders/a', { body: 'x', headers: { 'x-amz-server-side-encryption': 'aws:kms:dsse' } }));
    const head = await emulator.handle(makeReq('HEAD', '/acme-orders/a'));
    expect(head.headers?.['x-amz-server-side-encryption']).toBe('aws:kms:dsse');
    expect(head.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined();
    expect(head.headers?.['x-amz-server-side-encryption-bucket-key-enabled']).toBe('true');

    // Without a bucket default, an explicit aws:kms has Bucket Keys off.
    await emulator.handle(makeReq('PUT', '/acme-billing'));
    await emulator.handle(makeReq('PUT', '/acme-billing/b', { body: 'x', headers: { 'x-amz-server-side-encryption': 'aws:kms' } }));
    const plain = await emulator.handle(makeReq('HEAD', '/acme-billing/b'));
    expect(plain.headers?.['x-amz-server-side-encryption-bucket-key-enabled']).toBeUndefined();
  });

  test('explicit AES256 ignores a KMS bucket default', async () => {
    await setKmsDefault(emulator, 'acme-orders', 'alias/bucket-default', true);
    await emulator.handle(makeReq('PUT', '/acme-orders/a', { body: 'x', headers: { 'x-amz-server-side-encryption': 'AES256' } }));
    const head = await emulator.handle(makeReq('HEAD', '/acme-orders/a'));
    expect(head.headers?.['x-amz-server-side-encryption']).toBe('AES256');
    expect(head.headers?.['x-amz-server-side-encryption-bucket-key-enabled']).toBeUndefined();
  });

  test('no SSE header → the bucket default rule (KMS key and Bucket Key) applies', async () => {
    await setKmsDefault(emulator, 'acme-orders', 'alias/acme-orders', true);
    const put = await emulator.handle(makeReq('PUT', '/acme-orders/a', { body: 'x' }));
    expect(put.headers?.['x-amz-server-side-encryption']).toBe('aws:kms');
    expect(put.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBe('alias/acme-orders');
    expect(put.headers?.['x-amz-server-side-encryption-bucket-key-enabled']).toBe('true');

    await setKmsDefault(emulator, 'acme-orders', undefined, false);
    const put2 = await emulator.handle(makeReq('PUT', '/acme-orders/b', { body: 'x' }));
    expect(put2.headers?.['x-amz-server-side-encryption']).toBe('aws:kms');
    expect(put2.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined();
    expect(put2.headers?.['x-amz-server-side-encryption-bucket-key-enabled']).toBeUndefined();
  });

  test('invalid SSE headers answer InvalidArgument and store nothing', async () => {
    await expectAwsError(
      emulator.handle(makeReq('PUT', '/acme-orders/a', { body: 'x', headers: { 'x-amz-server-side-encryption': 'ROT13' } })),
      'InvalidArgument',
      400,
    );
    await expectAwsError(
      emulator.handle(
        makeReq('PUT', '/acme-orders/a', { body: 'x', headers: { 'x-amz-server-side-encryption-aws-kms-key-id': 'alias/x' } }),
      ),
      'InvalidArgument',
      400,
    );
    await expectAwsError(
      emulator.handle(
        makeReq('PUT', '/acme-orders/a', {
          body: 'x',
          headers: { 'x-amz-server-side-encryption': 'AES256', 'x-amz-server-side-encryption-aws-kms-key-id': 'alias/x' },
        }),
      ),
      'InvalidArgument',
      400,
    );
    await expectAwsError(emulator.handle(makeReq('HEAD', '/acme-orders/a')), 'NoSuchKey', 404);
  });

  test('a record persisted before SSE was tracked reports AES256', async () => {
    await emulator.handle(makeReq('PUT', '/acme-orders/legacy', { body: 'x' }));
    const index = context.ctx.store.table('s3/acme-orders/index');
    const record = { ...(index.get('legacy') as Record<string, unknown>) };
    delete record.sse;
    index.put('legacy', record);
    const head = await emulator.handle(makeReq('HEAD', '/acme-orders/legacy'));
    expect(head.headers?.['x-amz-server-side-encryption']).toBe('AES256');
  });

  describe('CopyObject', () => {
    beforeEach(async () => {
      await emulator.handle(
        makeReq('PUT', '/acme-orders/src', {
          body: 'x',
          headers: { ...SYSTEM_HEADERS, 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': 'alias/src' },
        }),
      );
    });

    test('COPY directive copies the system headers; SSE comes from the destination default, not the source', async () => {
      const copy = await emulator.handle(makeReq('PUT', '/acme-orders/dst', { headers: { 'x-amz-copy-source': '/acme-orders/src' } }));
      expect(copy.headers?.['x-amz-server-side-encryption']).toBe('AES256');
      const head = await emulator.handle(makeReq('HEAD', '/acme-orders/dst'));
      expect(head.headers?.['Content-Disposition']).toBe(SYSTEM_HEADERS['content-disposition']);
      expect(head.headers?.['Cache-Control']).toBe('max-age=3600');
      expect(head.headers?.Expires).toBe(SYSTEM_HEADERS.expires);
      expect(head.headers?.['x-amz-server-side-encryption']).toBe('AES256');
      expect(head.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined();
    });

    test('REPLACE takes only the request headers; explicit SSE on the copy request applies', async () => {
      const copy = await emulator.handle(
        makeReq('PUT', '/acme-orders/dst', {
          headers: {
            'x-amz-copy-source': '/acme-orders/src',
            'x-amz-metadata-directive': 'REPLACE',
            'cache-control': 'no-cache',
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': 'alias/dst',
          },
        }),
      );
      expect(copy.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBe('alias/dst');
      const head = await emulator.handle(makeReq('HEAD', '/acme-orders/dst'));
      expect(head.headers?.['Cache-Control']).toBe('no-cache');
      expect(head.headers?.['Content-Disposition']).toBeUndefined();
      expect(head.headers?.['Content-Encoding']).toBeUndefined();
      expect(head.headers?.['x-amz-server-side-encryption']).toBe('aws:kms');
    });

    test('an invalid SSE header on the copy request answers InvalidArgument', async () => {
      await expectAwsError(
        emulator.handle(
          makeReq('PUT', '/acme-orders/dst', {
            headers: { 'x-amz-copy-source': '/acme-orders/src', 'x-amz-server-side-encryption': 'nope' },
          }),
        ),
        'InvalidArgument',
        400,
      );
    });
  });

  describe('presigned POST', () => {
    test('form fields carry system metadata and SSE (case-insensitive names)', async () => {
      const res = await emulator.handle(
        postReq('acme-orders', {
          key: 'uploads/doc',
          'Content-Disposition': 'attachment',
          'cache-control': 'max-age=60',
          'Content-Encoding': 'br',
          'Content-Language': 'pt-BR',
          Expires: 'Thu, 01 Jan 2027 00:00:00 GMT',
          'X-Amz-Server-Side-Encryption': 'aws:kms',
          'x-amz-server-side-encryption-aws-kms-key-id': 'alias/uploads',
        }),
      );
      expect(res.status).toBe(204);
      expect(res.headers?.ETag).toBeDefined();
      expect(res.headers?.['x-amz-server-side-encryption']).toBe('aws:kms');
      const head = await emulator.handle(makeReq('HEAD', '/acme-orders/uploads/doc'));
      expect(head.headers?.['Content-Disposition']).toBe('attachment');
      expect(head.headers?.['Cache-Control']).toBe('max-age=60');
      expect(head.headers?.['Content-Encoding']).toBe('br');
      expect(head.headers?.['Content-Language']).toBe('pt-BR');
      expect(head.headers?.Expires).toBe('Thu, 01 Jan 2027 00:00:00 GMT');
      expect(head.headers?.['x-amz-server-side-encryption-aws-kms-key-id']).toBe('alias/uploads');
    });

    test('without SSE fields the bucket default applies; an invalid one is rejected before writing', async () => {
      const res = await emulator.handle(postReq('acme-orders', { key: 'uploads/plain' }));
      expect(res.headers?.['x-amz-server-side-encryption']).toBe('AES256');
      await expectAwsError(
        emulator.handle(postReq('acme-orders', { key: 'uploads/bad', 'x-amz-server-side-encryption': 'nope' })),
        'InvalidArgument',
        400,
      );
      await expectAwsError(emulator.handle(makeReq('HEAD', '/acme-orders/uploads/bad')), 'NoSuchKey', 404);
    });
  });
});
