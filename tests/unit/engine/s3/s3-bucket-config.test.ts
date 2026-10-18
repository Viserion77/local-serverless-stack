// Bucket configuration subresources: encryption, tagging, publicAccessBlock
// and policy round-trip through the bucket record, and every other known
// subresource answers NotImplemented (501) — a subresource request must never
// be mistaken for CreateBucket (409) or DeleteBucket (bucket destroyed).
import { S3Emulator } from '../../../../src/server/engine/emulators/s3/index.js';
import { parseXml, childText, childrenNamed } from '../../../../src/server/engine/http/xml.js';
import type { XmlNode } from '../../../../src/server/engine/http/xml.js';
import { makeContext, cleanupContext, makeReq, expectAwsError, bodyText, TestContext } from './helpers';

const BUCKET = '/acme-orders';

function child(node: XmlNode, name: string): XmlNode {
  return childrenNamed(node, name)[0];
}

function encryptionXml(rule: string): string {
  return `<ServerSideEncryptionConfiguration><Rule>${rule}</Rule></ServerSideEncryptionConfiguration>`;
}

describe('S3Emulator — bucket configuration subresources', () => {
  let context: TestContext;
  let emulator: S3Emulator;

  beforeEach(async () => {
    context = makeContext();
    emulator = new S3Emulator(context.ctx);
    await emulator.handle(makeReq('PUT', BUCKET));
  });

  afterEach(() => cleanupContext(context));

  const getEncryptionRule = async (): Promise<XmlNode> => {
    const res = await emulator.handle(makeReq('GET', BUCKET, { query: { encryption: '' } }));
    expect(res.status).toBe(200);
    const root = parseXml(bodyText(res.body));
    expect(root.name).toBe('ServerSideEncryptionConfiguration');
    return child(root, 'Rule');
  };

  describe('encryption', () => {
    test('a bucket without a rule reports the SSE-S3 (AES256) default', async () => {
      const rule = await getEncryptionRule();
      expect(childText(child(rule, 'ApplyServerSideEncryptionByDefault'), 'SSEAlgorithm')).toBe('AES256');
      expect(childText(child(rule, 'ApplyServerSideEncryptionByDefault'), 'KMSMasterKeyID')).toBeUndefined();
      expect(childText(rule, 'BucketKeyEnabled')).toBe('false');
    });

    test('Put stores a KMS rule, Get returns it, Delete reverts to the default', async () => {
      const put = await emulator.handle(
        makeReq('PUT', BUCKET, {
          query: { encryption: '' },
          body: encryptionXml(
            '<ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm>' +
              '<KMSMasterKeyID>alias/acme-orders</KMSMasterKeyID></ApplyServerSideEncryptionByDefault>' +
              '<BucketKeyEnabled>true</BucketKeyEnabled>',
          ),
        }),
      );
      expect(put.status).toBe(200);
      let rule = await getEncryptionRule();
      expect(childText(child(rule, 'ApplyServerSideEncryptionByDefault'), 'SSEAlgorithm')).toBe('aws:kms');
      expect(childText(child(rule, 'ApplyServerSideEncryptionByDefault'), 'KMSMasterKeyID')).toBe('alias/acme-orders');
      expect(childText(rule, 'BucketKeyEnabled')).toBe('true');

      const del = await emulator.handle(makeReq('DELETE', BUCKET, { query: { encryption: '' } }));
      expect(del.status).toBe(204);
      rule = await getEncryptionRule();
      expect(childText(child(rule, 'ApplyServerSideEncryptionByDefault'), 'SSEAlgorithm')).toBe('AES256');
      // The bucket itself survived the DELETE ?encryption.
      expect((await emulator.handle(makeReq('HEAD', BUCKET))).status).toBe(200);
    });

    test('a rule without BucketKeyEnabled stores it as false', async () => {
      await emulator.handle(
        makeReq('PUT', BUCKET, {
          query: { encryption: '' },
          body: encryptionXml('<ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault>'),
        }),
      );
      expect(childText(await getEncryptionRule(), 'BucketKeyEnabled')).toBe('false');
    });

    test('malformed rules: missing Rule, missing/unknown algorithm, KMS key on AES256', async () => {
      const put = (body: string) => emulator.handle(makeReq('PUT', BUCKET, { query: { encryption: '' }, body }));
      await expectAwsError(put('<ServerSideEncryptionConfiguration/>'), 'MalformedXML', 400);
      await expectAwsError(put(encryptionXml('<BucketKeyEnabled>true</BucketKeyEnabled>')), 'MalformedXML', 400);
      await expectAwsError(
        put(encryptionXml('<ApplyServerSideEncryptionByDefault/>')),
        'MalformedXML',
        400,
      );
      await expectAwsError(
        put(encryptionXml('<ApplyServerSideEncryptionByDefault><SSEAlgorithm>ROT13</SSEAlgorithm></ApplyServerSideEncryptionByDefault>')),
        'MalformedXML',
        400,
      );
      await expectAwsError(
        put(
          encryptionXml(
            '<ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm>' +
              '<KMSMasterKeyID>alias/nope</KMSMasterKeyID></ApplyServerSideEncryptionByDefault>',
          ),
        ),
        'InvalidArgument',
        400,
      );
      await expectAwsError(put(''), 'MalformedXML', 400);
    });

    test('encryption calls on a missing bucket answer NoSuchBucket', async () => {
      await expectAwsError(emulator.handle(makeReq('GET', '/ghost', { query: { encryption: '' } })), 'NoSuchBucket', 404);
      await expectAwsError(emulator.handle(makeReq('DELETE', '/ghost', { query: { encryption: '' } })), 'NoSuchBucket', 404);
      await expectAwsError(
        emulator.handle(makeReq('PUT', '/ghost', { query: { encryption: '' }, body: encryptionXml('') })),
        'NoSuchBucket',
        404,
      );
    });
  });

  describe('tagging', () => {
    const tagging = (tags: string) => `<Tagging><TagSet>${tags}</TagSet></Tagging>`;

    test('Get on an untagged bucket answers NoSuchTagSet', async () => {
      await expectAwsError(emulator.handle(makeReq('GET', BUCKET, { query: { tagging: '' } })), 'NoSuchTagSet', 404);
    });

    test('Put / Get / Delete round trip', async () => {
      const put = await emulator.handle(
        makeReq('PUT', BUCKET, {
          query: { tagging: '' },
          body: tagging('<Tag><Key>team</Key><Value>billing</Value></Tag><Tag><Key>empty</Key></Tag>'),
        }),
      );
      expect(put.status).toBe(204);
      const get = await emulator.handle(makeReq('GET', BUCKET, { query: { tagging: '' } }));
      const tagSet = child(parseXml(bodyText(get.body)), 'TagSet');
      expect(childrenNamed(tagSet, 'Tag').map(t => [childText(t, 'Key'), childText(t, 'Value')])).toEqual([
        ['team', 'billing'],
        ['empty', ''],
      ]);

      const del = await emulator.handle(makeReq('DELETE', BUCKET, { query: { tagging: '' } }));
      expect(del.status).toBe(204);
      await expectAwsError(emulator.handle(makeReq('GET', BUCKET, { query: { tagging: '' } })), 'NoSuchTagSet', 404);
      expect((await emulator.handle(makeReq('HEAD', BUCKET))).status).toBe(200);
    });

    test('an empty TagSet leaves the bucket untagged', async () => {
      await emulator.handle(makeReq('PUT', BUCKET, { query: { tagging: '' }, body: tagging('<Tag><Key>a</Key><Value>1</Value></Tag>') }));
      await emulator.handle(makeReq('PUT', BUCKET, { query: { tagging: '' }, body: tagging('') }));
      await expectAwsError(emulator.handle(makeReq('GET', BUCKET, { query: { tagging: '' } })), 'NoSuchTagSet', 404);
    });

    test('invalid tag sets: missing TagSet, empty key, duplicate keys', async () => {
      const put = (body: string) => emulator.handle(makeReq('PUT', BUCKET, { query: { tagging: '' }, body }));
      await expectAwsError(put('<Tagging/>'), 'MalformedXML', 400);
      await expectAwsError(put(tagging('<Tag><Value>x</Value></Tag>')), 'InvalidTag', 400);
      await expectAwsError(
        put(tagging('<Tag><Key>a</Key><Value>1</Value></Tag><Tag><Key>a</Key><Value>2</Value></Tag>')),
        'InvalidTag',
        400,
      );
    });
  });

  describe('publicAccessBlock', () => {
    const getBlock = async () => {
      const res = await emulator.handle(makeReq('GET', BUCKET, { query: { publicAccessBlock: '' } }));
      const root = parseXml(bodyText(res.body));
      expect(root.name).toBe('PublicAccessBlockConfiguration');
      return ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].map(n => childText(root, n));
    };

    test('a new bucket reports all four settings on (the AWS default)', async () => {
      expect(await getBlock()).toEqual(['true', 'true', 'true', 'true']);
    });

    test('Put stores the flags (omitted ones are false); Delete makes Get answer 404', async () => {
      const put = await emulator.handle(
        makeReq('PUT', BUCKET, {
          query: { publicAccessBlock: '' },
          body:
            '<PublicAccessBlockConfiguration><BlockPublicAcls>TRUE</BlockPublicAcls>' +
            '<BlockPublicPolicy>false</BlockPublicPolicy></PublicAccessBlockConfiguration>',
        }),
      );
      expect(put.status).toBe(200);
      expect(await getBlock()).toEqual(['true', 'false', 'false', 'false']);

      const del = await emulator.handle(makeReq('DELETE', BUCKET, { query: { publicAccessBlock: '' } }));
      expect(del.status).toBe(204);
      await expectAwsError(
        emulator.handle(makeReq('GET', BUCKET, { query: { publicAccessBlock: '' } })),
        'NoSuchPublicAccessBlockConfiguration',
        404,
      );
      expect((await emulator.handle(makeReq('HEAD', BUCKET))).status).toBe(200);
    });
  });

  describe('policy', () => {
    const policy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::acme-orders/*' }],
    });

    test('Get without a policy answers NoSuchBucketPolicy', async () => {
      await expectAwsError(emulator.handle(makeReq('GET', BUCKET, { query: { policy: '' } })), 'NoSuchBucketPolicy', 404);
    });

    test('Put / Get / Delete round trip, verbatim JSON', async () => {
      const put = await emulator.handle(makeReq('PUT', BUCKET, { query: { policy: '' }, body: policy }));
      expect(put.status).toBe(204);
      const get = await emulator.handle(makeReq('GET', BUCKET, { query: { policy: '' } }));
      expect(get.status).toBe(200);
      expect(get.headers?.['Content-Type']).toBe('application/json');
      expect(bodyText(get.body)).toBe(policy);

      const del = await emulator.handle(makeReq('DELETE', BUCKET, { query: { policy: '' } }));
      expect(del.status).toBe(204);
      await expectAwsError(emulator.handle(makeReq('GET', BUCKET, { query: { policy: '' } })), 'NoSuchBucketPolicy', 404);
      expect((await emulator.handle(makeReq('HEAD', BUCKET))).status).toBe(200);
    });

    test('a policy that is not a JSON object answers MalformedPolicy', async () => {
      for (const body of ['not json', '[]', 'null', '42']) {
        await expectAwsError(emulator.handle(makeReq('PUT', BUCKET, { query: { policy: '' }, body })), 'MalformedPolicy', 400);
      }
    });
  });

  describe('unsupported subresources never fall into create/delete bucket', () => {
    test.each([
      ['PUT', 'lifecycle', 's3.PutBucketLifecycleConfiguration'],
      ['PUT', 'ownershipControls', 's3.PutBucketOwnershipControls'],
      ['PUT', 'acl', 's3.PutBucketAcl'],
      ['PUT', 'website', 's3.PutBucketWebsite'],
      ['PUT', 'logging', 's3.PutBucketLogging'],
      ['GET', 'acl', 's3.GetBucketAcl'],
      ['GET', 'versions', 's3.ListObjectVersions'],
      ['GET', 'policyStatus', 's3.GetBucketPolicyStatus'],
      ['DELETE', 'lifecycle', 's3.DeleteBucketLifecycleConfiguration'],
      ['DELETE', 'website', 's3.DeleteBucketWebsite'],
      ['HEAD', 'location', 's3.HeadBucketLocation'],
    ])('%s ?%s answers NotImplemented 501', async (method, subresource, operation) => {
      const error = await expectAwsError(
        emulator.handle(makeReq(method, BUCKET, { query: { [subresource]: '' } })),
        'NotImplemented',
        501,
      );
      expect(error.message).toContain(operation);
      // The bucket is untouched: still there, still creatable-once.
      expect((await emulator.handle(makeReq('HEAD', BUCKET))).status).toBe(200);
    });

    test('bare PUT still creates and bare DELETE still deletes', async () => {
      await expectAwsError(emulator.handle(makeReq('PUT', BUCKET)), 'BucketAlreadyOwnedByYou', 409);
      // Non-subresource params (the SDK's x-id) do not change the routing.
      expect((await emulator.handle(makeReq('PUT', '/acme-billing', { query: { 'x-id': 'CreateBucket' } }))).status).toBe(200);
      expect((await emulator.handle(makeReq('DELETE', BUCKET))).status).toBe(204);
      await expectAwsError(emulator.handle(makeReq('HEAD', BUCKET)), 'NoSuchBucket', 404);
    });

    test('a query key named after an Object.prototype member is not a subresource', async () => {
      const res = await emulator.handle(makeReq('GET', BUCKET, { query: { 'list-type': '2', constructor: '' } }));
      expect(res.status).toBe(200);
    });
  });

  describe('object subresources never touch the object', () => {
    beforeEach(async () => {
      await emulator.handle(makeReq('PUT', `${BUCKET}/invoice.pdf`, { body: 'pdf-bytes' }));
    });

    test.each([
      ['PUT', 'tagging', 's3.PutObjectTagging'],
      ['GET', 'acl', 's3.GetObjectAcl'],
      ['DELETE', 'tagging', 's3.DeleteObjectTagging'],
      ['PUT', 'retention', 's3.PutObjectRetention'],
      ['GET', 'legal-hold', 's3.GetObjectLegalHold'],
      ['GET', 'attributes', 's3.GetObjectAttributes'],
      ['POST', 'restore', 's3.RestoreObject'],
      ['POST', 'select', 's3.SelectObjectContent'],
      ['GET', 'torrent', 's3.GetObjectTorrent'],
    ])('%s ?%s answers NotImplemented 501', async (method, subresource, operation) => {
      const error = await expectAwsError(
        emulator.handle(makeReq(method, `${BUCKET}/invoice.pdf`, { query: { [subresource]: '' }, body: '<Tagging/>' })),
        'NotImplemented',
        501,
      );
      expect(error.message).toContain(operation);
      const get = await emulator.handle(makeReq('GET', `${BUCKET}/invoice.pdf`));
      expect(bodyText(get.body)).toBe('pdf-bytes');
    });
  });
});
