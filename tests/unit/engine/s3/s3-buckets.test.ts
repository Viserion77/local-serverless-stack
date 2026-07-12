import { S3Emulator } from '../../../../src/server/engine/emulators/s3/index.js';
import { parseXml, childText, childrenNamed } from '../../../../src/server/engine/http/xml.js';
import { makeContext, cleanupContext, makeReq, expectAwsError, bodyText, TestContext } from './helpers';

describe('S3Emulator — bucket lifecycle', () => {
  let context: TestContext;
  let emulator: S3Emulator;

  beforeEach(() => {
    context = makeContext();
    emulator = new S3Emulator(context.ctx);
  });

  afterEach(() => {
    cleanupContext(context);
  });

  test('CreateBucket returns 200 with a Location header', async () => {
    const res = await emulator.handle(makeReq('PUT', '/my-bucket'));
    expect(res.status).toBe(200);
    expect(res.headers?.Location).toBe('/my-bucket');
  });

  test('creating an existing bucket throws BucketAlreadyOwnedByYou (409)', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket'));
    await expectAwsError(emulator.handle(makeReq('PUT', '/my-bucket')), 'BucketAlreadyOwnedByYou', 409);
  });

  test('HeadBucket returns 200 for an existing bucket and NoSuchBucket 404 otherwise', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket'));
    const res = await emulator.handle(makeReq('HEAD', '/my-bucket'));
    expect(res.status).toBe(200);
    expect(res.body).toBeUndefined();
    await expectAwsError(emulator.handle(makeReq('HEAD', '/ghost')), 'NoSuchBucket', 404);
  });

  test('ListBuckets returns Owner and Bucket entries with CreationDate', async () => {
    await emulator.handle(makeReq('PUT', '/bravo'));
    await emulator.handle(makeReq('PUT', '/alpha'));
    const res = await emulator.handle(makeReq('GET', '/'));
    expect(res.status).toBe(200);
    const root = parseXml(bodyText(res.body));
    expect(root.name).toBe('ListAllMyBucketsResult');
    expect(root.attributes.xmlns).toBe('http://s3.amazonaws.com/doc/2006-03-01/');
    const owner = childrenNamed(root, 'Owner')[0];
    expect(childText(owner, 'ID')).toBeTruthy();
    const buckets = childrenNamed(childrenNamed(root, 'Buckets')[0], 'Bucket');
    expect(buckets.map(b => childText(b, 'Name'))).toEqual(['alpha', 'bravo']);
    for (const bucket of buckets) {
      const creationDate = childText(bucket, 'CreationDate');
      expect(Number.isNaN(Date.parse(creationDate ?? ''))).toBe(false);
    }
  });

  test('DeleteBucket: 204 when empty, BucketNotEmpty 409 otherwise, NoSuchBucket when missing', async () => {
    await expectAwsError(emulator.handle(makeReq('DELETE', '/ghost')), 'NoSuchBucket', 404);

    await emulator.handle(makeReq('PUT', '/my-bucket'));
    await emulator.handle(makeReq('PUT', '/my-bucket/file.txt', { body: 'data' }));
    await expectAwsError(emulator.handle(makeReq('DELETE', '/my-bucket')), 'BucketNotEmpty', 409);

    await emulator.handle(makeReq('DELETE', '/my-bucket/file.txt'));
    const res = await emulator.handle(makeReq('DELETE', '/my-bucket'));
    expect(res.status).toBe(204);
    await expectAwsError(emulator.handle(makeReq('HEAD', '/my-bucket')), 'NoSuchBucket', 404);

    // The name is reusable after deletion.
    const recreated = await emulator.handle(makeReq('PUT', '/my-bucket'));
    expect(recreated.status).toBe(200);
  });

  test('GetBucketLocation: us-east-1 is an EMPTY self-closing LocationConstraint', async () => {
    await emulator.handle(makeReq('PUT', '/home-bucket'));
    const res = await emulator.handle(makeReq('GET', '/home-bucket', { query: { location: '' } }));
    expect(bodyText(res.body)).toMatch(/<LocationConstraint[^>]*\/>/);
    const root = parseXml(bodyText(res.body));
    expect(root.name).toBe('LocationConstraint');
    expect(root.text).toBe('');
  });

  test('GetBucketLocation returns the region text for non-us-east-1 buckets', async () => {
    await emulator.handle(makeReq('PUT', '/far-bucket', { region: 'sa-east-1' }));
    const res = await emulator.handle(makeReq('GET', '/far-bucket', { query: { location: '' } }));
    expect(parseXml(bodyText(res.body)).text).toBe('sa-east-1');
  });

  test('CreateBucket honors a LocationConstraint body over the request region', async () => {
    const body =
      '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      '<LocationConstraint>eu-west-1</LocationConstraint></CreateBucketConfiguration>';
    await emulator.handle(makeReq('PUT', '/eu-bucket', { body }));
    const res = await emulator.handle(makeReq('GET', '/eu-bucket', { query: { location: '' } }));
    expect(parseXml(bodyText(res.body)).text).toBe('eu-west-1');
  });

  test('versioning flag round trip: unset → Enabled → Suspended', async () => {
    await emulator.handle(makeReq('PUT', '/ver-bucket'));

    const unset = await emulator.handle(makeReq('GET', '/ver-bucket', { query: { versioning: '' } }));
    const unsetRoot = parseXml(bodyText(unset.body));
    expect(unsetRoot.name).toBe('VersioningConfiguration');
    expect(childText(unsetRoot, 'Status')).toBeUndefined();

    const putEnabled =
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      '<Status>Enabled</Status></VersioningConfiguration>';
    const putRes = await emulator.handle(
      makeReq('PUT', '/ver-bucket', { query: { versioning: '' }, body: putEnabled }),
    );
    expect(putRes.status).toBe(200);
    const enabled = await emulator.handle(makeReq('GET', '/ver-bucket', { query: { versioning: '' } }));
    expect(childText(parseXml(bodyText(enabled.body)), 'Status')).toBe('Enabled');

    const putSuspended = putEnabled.replace('Enabled', 'Suspended');
    await emulator.handle(makeReq('PUT', '/ver-bucket', { query: { versioning: '' }, body: putSuspended }));
    const suspended = await emulator.handle(makeReq('GET', '/ver-bucket', { query: { versioning: '' } }));
    expect(childText(parseXml(bodyText(suspended.body)), 'Status')).toBe('Suspended');
  });

  test('PutBucketVersioning rejects a bogus status', async () => {
    await emulator.handle(makeReq('PUT', '/ver-bucket'));
    const body = '<VersioningConfiguration><Status>Sideways</Status></VersioningConfiguration>';
    await expectAwsError(
      emulator.handle(makeReq('PUT', '/ver-bucket', { query: { versioning: '' }, body })),
      'MalformedXML',
      400,
    );
  });

  test('bucket subresources on a missing bucket throw NoSuchBucket', async () => {
    await expectAwsError(emulator.handle(makeReq('GET', '/ghost', { query: { location: '' } })), 'NoSuchBucket', 404);
    await expectAwsError(emulator.handle(makeReq('GET', '/ghost', { query: { versioning: '' } })), 'NoSuchBucket', 404);
    await expectAwsError(
      emulator.handle(makeReq('GET', '/ghost', { query: { notification: '' } })),
      'NoSuchBucket',
      404,
    );
    await expectAwsError(
      emulator.handle(makeReq('GET', '/ghost', { query: { 'list-type': '2' } })),
      'NoSuchBucket',
      404,
    );
  });

  test('multipart operations are NotImplemented (501) until the hardening phase', async () => {
    await emulator.handle(makeReq('PUT', '/my-bucket'));
    const cases = [
      makeReq('POST', '/my-bucket/big.bin', { query: { uploads: '' } }),
      makeReq('PUT', '/my-bucket/big.bin', { query: { partNumber: '1', uploadId: 'abc' } }),
      makeReq('POST', '/my-bucket/big.bin', { query: { uploadId: 'abc' } }),
    ];
    for (const req of cases) {
      const error = await expectAwsError(emulator.handle(req), 'NotImplemented', 501);
      expect(error.message).toMatch(/multipart/i);
      expect(error.message).toMatch(/hardening/i);
    }
  });
});
