// Unit tests for S3Explorer. Follows the AWS-SDK-mock exemplar
// (tests/unit/services/queue-inspector.test.ts): mockClient() patches the S3
// client prototype so calls made through the singleton's cached clients are
// intercepted; singleton client cache + mock are reset between tests.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'stream';
import { sdkStreamMixin } from '@smithy/util-stream';
import {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetBucketNotificationConfigurationCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { S3Explorer } from '../../../src/server/services/s3-explorer';

const s3Mock = mockClient(S3Client);

let explorer: S3Explorer;

beforeEach(() => {
  s3Mock.reset();
  explorer = S3Explorer.getInstance();
  const e = explorer as any;
  e.clients.clear();
  e.defaultRegion = 'us-east-1';
});

afterAll(() => {
  s3Mock.restore();
});

function streamBody(buf: Buffer) {
  const stream = new Readable();
  stream.push(buf);
  stream.push(null);
  return sdkStreamMixin(stream);
}

describe('getInstance / setDefaultRegion', () => {
  it('is a singleton', () => {
    expect(S3Explorer.getInstance()).toBe(explorer);
  });

  it('setDefaultRegion ignores empty, accepts a value', () => {
    explorer.setDefaultRegion('');
    expect((explorer as any).defaultRegion).toBe('us-east-1');
    explorer.setDefaultRegion('eu-west-1');
    expect((explorer as any).defaultRegion).toBe('eu-west-1');
  });
});

describe('clientFor', () => {
  it('caches the client per region and reuses it', async () => {
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [] });
    await explorer.listBuckets('us-west-2');
    await explorer.listBuckets('us-west-2');
    // Two regions seeded: default not used, only us-west-2 created once + reused.
    expect((explorer as any).clients.size).toBe(1);
    expect((explorer as any).clients.has('us-west-2')).toBe(true);
  });
});

describe('listBuckets', () => {
  it('returns [] when the response has no Buckets (|| [] fallback)', async () => {
    s3Mock.on(ListBucketsCommand).resolves({});
    expect(await explorer.listBuckets()).toEqual([]);
  });

  it('enriches buckets with object count/size and filters nameless ones', async () => {
    s3Mock.on(ListBucketsCommand).resolves({
      Buckets: [
        { Name: 'a', CreationDate: new Date(1700000000000) },
        { Name: 'b' }, // no CreationDate → createdAt undefined
        { CreationDate: new Date() }, // no Name → filtered out
      ],
    });
    s3Mock.on(ListObjectsV2Command, { Bucket: 'a' }).resolves({
      KeyCount: 2,
      Contents: [{ Size: 10 }, { Size: 5 }],
    });
    // For bucket 'b' return a payload missing KeyCount/Contents to hit fallbacks.
    s3Mock.on(ListObjectsV2Command, { Bucket: 'b' }).resolves({});

    const buckets = await explorer.listBuckets();
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({
      name: 'a',
      createdAt: 1700000000000,
      region: 'us-east-1',
      objectCount: 2,
      totalSize: 15,
    });
    expect(buckets[1]).toMatchObject({
      name: 'b',
      createdAt: undefined,
      objectCount: 0,
      totalSize: 0,
    });
  });

  it('degrades gracefully when ListObjectsV2 fails (catch arm)', async () => {
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'a' }] });
    s3Mock.on(ListObjectsV2Command).rejects(new Error('boom'));
    const buckets = await explorer.listBuckets('eu-west-1');
    expect(buckets[0]).toEqual({ name: 'a', createdAt: undefined, region: 'eu-west-1' });
    expect(buckets[0].objectCount).toBeUndefined();
  });

  it('sums sizes with a Content entry missing Size (o.Size || 0)', async () => {
    s3Mock.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'a' }] });
    s3Mock.on(ListObjectsV2Command).resolves({ KeyCount: 1, Contents: [{}] });
    const buckets = await explorer.listBuckets();
    expect(buckets[0].totalSize).toBe(0);
  });
});

describe('getBucket', () => {
  it('returns null when HeadBucket fails', async () => {
    s3Mock.on(HeadBucketCommand).rejects(new Error('NotFound'));
    expect(await explorer.getBucket('missing')).toBeNull();
  });

  it('builds a full snapshot from all settled calls', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    s3Mock.on(GetBucketLocationCommand).resolves({ LocationConstraint: 'eu-central-1' });
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    // The snapshot only counts these, but a configuration without its ARN and
    // events is not a shape S3 can return — `{}` typechecked as nothing and
    // documented nothing.
    s3Mock.on(GetBucketNotificationConfigurationCommand).resolves({
      LambdaFunctionConfigurations: [
        { LambdaFunctionArn: 'arn:aws:lambda:us-east-1:000000000000:function:a', Events: ['s3:ObjectCreated:*'] },
        { LambdaFunctionArn: 'arn:aws:lambda:us-east-1:000000000000:function:b', Events: ['s3:ObjectRemoved:*'] },
      ],
      QueueConfigurations: [
        { QueueArn: 'arn:aws:sqs:us-east-1:000000000000:q', Events: ['s3:ObjectCreated:*'] },
      ],
      TopicConfigurations: [
        { TopicArn: 'arn:aws:sns:us-east-1:000000000000:t', Events: ['s3:ObjectCreated:*'] },
      ],
    });
    s3Mock.on(ListObjectsV2Command).resolves({
      KeyCount: 3,
      Contents: [{ Size: 100 }, { Size: 50 }, {}],
    });

    const snap = await explorer.getBucket('b');
    expect(snap).toEqual({
      name: 'b',
      region: 'eu-central-1',
      versioning: true,
      notifications: 4,
      objectCount: 3,
      totalSize: 150,
    });
  });

  it('falls back to defaults when settled payloads are empty/rejected', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    // Location resolves but with no LocationConstraint → keeps snap.region.
    s3Mock.on(GetBucketLocationCommand).resolves({});
    // Versioning not Enabled → false.
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Suspended' });
    // Notifications resolves but with no config arrays → all || 0 → 0.
    s3Mock.on(GetBucketNotificationConfigurationCommand).resolves({});
    // ListObjects resolves with no KeyCount/Contents → 0/0.
    s3Mock.on(ListObjectsV2Command).resolves({});

    const snap = await explorer.getBucket('b', 'ap-south-1');
    expect(snap).toEqual({
      name: 'b',
      region: 'ap-south-1',
      versioning: false,
      notifications: 0,
      objectCount: 0,
      totalSize: 0,
    });
  });

  it('skips metadata fields whose settled promise rejected', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    s3Mock.on(GetBucketLocationCommand).rejects(new Error('no location'));
    s3Mock.on(GetBucketVersioningCommand).rejects(new Error('no versioning'));
    s3Mock.on(GetBucketNotificationConfigurationCommand).rejects(new Error('no notif'));
    s3Mock.on(ListObjectsV2Command).rejects(new Error('no list'));

    const snap = await explorer.getBucket('b');
    // All rejected → only name/region remain at defaults.
    expect(snap).toEqual({ name: 'b', region: 'us-east-1' });
  });
});

describe('listObjects', () => {
  it('maps objects, common prefixes and pagination with explicit options', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        {
          Key: 'a/file.txt',
          Size: 12,
          LastModified: new Date(1700000000000),
          ETag: '"abc"',
          StorageClass: 'STANDARD',
        },
      ],
      CommonPrefixes: [{ Prefix: 'a/' }, {}], // second has no Prefix → '' → filtered
      IsTruncated: true,
      NextContinuationToken: 'next-token',
    });

    const res = await explorer.listObjects(
      'bucket',
      { prefix: 'a/', continuationToken: 'tok', maxKeys: 50, delimiter: '/' },
      'us-east-1',
    );
    expect(res).toEqual({
      bucket: 'bucket',
      prefix: 'a/',
      objects: [
        {
          key: 'a/file.txt',
          size: 12,
          lastModified: 1700000000000,
          etag: '"abc"',
          storageClass: 'STANDARD',
        },
      ],
      commonPrefixes: ['a/'],
      isTruncated: true,
      nextContinuationToken: 'next-token',
    });

    const input = s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input as any;
    expect(input).toMatchObject({
      Bucket: 'bucket',
      Prefix: 'a/',
      ContinuationToken: 'tok',
      MaxKeys: 50,
      Delimiter: '/',
    });
  });

  it('applies defaults and fallbacks on a sparse response', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{}], // no Key/Size/LastModified/ETag/StorageClass → fallbacks
    });
    const res = await explorer.listObjects('bucket', {});
    expect(res).toEqual({
      bucket: 'bucket',
      prefix: undefined,
      objects: [
        {
          key: '',
          size: 0,
          lastModified: undefined,
          etag: undefined,
          storageClass: undefined,
        },
      ],
      commonPrefixes: [],
      isTruncated: false,
      nextContinuationToken: undefined,
    });
    const input = s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input as any;
    expect(input.MaxKeys).toBe(100); // maxKeys ?? 100
  });

  it('returns empty objects when Contents is entirely absent (|| [] fallback)', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({}); // no Contents key at all
    const res = await explorer.listObjects('bucket', { maxKeys: 0 });
    expect(res.objects).toEqual([]);
    expect(res.commonPrefixes).toEqual([]);
    const input = s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input as any;
    expect(input.MaxKeys).toBe(0); // maxKeys ?? 100 → 0 kept (nullish coalescing)
  });
});

describe('getObject', () => {
  it('returns the body buffer with metadata (stream → bytes)', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody(Buffer.from('hello world')) as any,
      ContentType: 'text/plain',
      ContentLength: 11,
      LastModified: new Date(1700000000000),
    });
    const res = await explorer.getObject('bucket', 'key');
    expect(res!.body.toString()).toBe('hello world');
    expect(res).toMatchObject({
      contentType: 'text/plain',
      size: 11,
      lastModified: 1700000000000,
    });
  });

  it('falls back to empty buffer and body length when Body/ContentLength missing', async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    const res = await explorer.getObject('bucket', 'key', 'eu-west-1');
    expect(res!.body.length).toBe(0);
    expect(res!.size).toBe(0);
    expect(res!.contentType).toBeUndefined();
    expect(res!.lastModified).toBeUndefined();
  });

  it('computes size from body length when ContentLength is absent but body present', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody(Buffer.from('abc')) as any,
    });
    const res = await explorer.getObject('bucket', 'key');
    expect(res!.size).toBe(3); // ContentLength || body.length
  });

  it('returns null for NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
    expect(await explorer.getObject('bucket', 'gone')).toBeNull();
  });

  it('returns null for a 404 metadata error', async () => {
    s3Mock
      .on(GetObjectCommand)
      .rejects(Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } }));
    expect(await explorer.getObject('bucket', 'gone')).toBeNull();
  });

  it('rethrows other errors', async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('boom'), { name: 'AccessDenied' }));
    await expect(explorer.getObject('bucket', 'key')).rejects.toThrow('boom');
  });
});

describe('headObject', () => {
  it('returns metadata', async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentType: 'application/json',
      ContentLength: 42,
      LastModified: new Date(1700000000000),
    });
    const res = await explorer.headObject('bucket', 'key');
    expect(res).toEqual({
      contentType: 'application/json',
      size: 42,
      lastModified: 1700000000000,
    });
  });

  it('applies fallbacks for a sparse response', async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    const res = await explorer.headObject('bucket', 'key');
    expect(res).toEqual({ contentType: undefined, size: 0, lastModified: undefined });
  });

  it('returns null for NotFound', async () => {
    s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('nope'), { name: 'NotFound' }));
    expect(await explorer.headObject('bucket', 'gone')).toBeNull();
  });

  it('returns null for a 404 metadata error', async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } }));
    expect(await explorer.headObject('bucket', 'gone')).toBeNull();
  });

  it('rethrows other errors', async () => {
    s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('boom'), { name: 'AccessDenied' }));
    await expect(explorer.headObject('bucket', 'key')).rejects.toThrow('boom');
  });
});

describe('putObject', () => {
  it('puts an object with content type', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await expect(
      explorer.putObject('bucket', { key: 'k', body: 'data', contentType: 'text/plain' }),
    ).resolves.toBeUndefined();
    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input as any;
    expect(input).toMatchObject({
      Bucket: 'bucket',
      Key: 'k',
      Body: 'data',
      ContentType: 'text/plain',
    });
  });

  it('puts a buffer body (no content type)', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const buf = Buffer.from('binary');
    await explorer.putObject('bucket', { key: 'k', body: buf }, 'us-west-1');
    const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input as any;
    expect(input.Body).toBe(buf);
    expect(input.ContentType).toBeUndefined();
  });
});

describe('deleteObject', () => {
  it('deletes an object', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await expect(explorer.deleteObject('bucket', 'k')).resolves.toBeUndefined();
    const input = s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input as any;
    expect(input).toMatchObject({ Bucket: 'bucket', Key: 'k' });
  });
});
