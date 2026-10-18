// Full-stack wire conformance for S3 bucket configuration subresources and
// object system metadata / server-side encryption. Boots the real
// SelfEngineBackend and drives it through @aws-sdk/client-s3 — the same calls
// an IaC tool issues after CreateBucket (PutBucketEncryption, tagging, public
// access block, policy) — and asserts none of them is mistaken for
// CreateBucket/DeleteBucket, that unsupported subresources answer
// NotImplemented, and that PutObject/CopyObject headers round-trip through
// GetObject/HeadObject the way the SDK parses them.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  S3Client,
  S3ServiceException,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  GetBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  PutBucketTaggingCommand,
  GetBucketTaggingCommand,
  DeleteBucketTaggingCommand,
  PutPublicAccessBlockCommand,
  GetPublicAccessBlockCommand,
  DeletePublicAccessBlockCommand,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketWebsiteCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: 'us-east-1',
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

async function sdkError(run: Promise<unknown>): Promise<S3ServiceException> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(S3ServiceException);
    return error as S3ServiceException;
  }
  throw new Error('expected the call to fail');
}

describe('wire: S3 bucket configuration subresources + object metadata/SSE', () => {
  const Bucket = 'acme-invoices';
  let dataDir: string;
  let backend: SelfEngineBackend;
  let s3: S3Client;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-s3cfg-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    s3 = new S3Client({
      endpoint: backend.getEndpoint(), region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await s3.send(new CreateBucketCommand({ Bucket }));
  });

  afterEach(async () => {
    s3.destroy();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('encryption: AES256 default, KMS rule round trip, delete reverts (bucket survives)', async () => {
    const initial = await s3.send(new GetBucketEncryptionCommand({ Bucket }));
    expect(initial.ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe('AES256');

    await s3.send(new PutBucketEncryptionCommand({
      Bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: 'alias/acme' }, BucketKeyEnabled: true }],
      },
    }));
    const rule = (await s3.send(new GetBucketEncryptionCommand({ Bucket }))).ServerSideEncryptionConfiguration?.Rules?.[0];
    expect(rule?.ApplyServerSideEncryptionByDefault).toEqual({ SSEAlgorithm: 'aws:kms', KMSMasterKeyID: 'alias/acme' });
    expect(rule?.BucketKeyEnabled).toBe(true);

    // The bucket default now drives PutObject's encryption.
    const put = await s3.send(new PutObjectCommand({ Bucket, Key: 'a.txt', Body: 'a' }));
    expect(put.ServerSideEncryption).toBe('aws:kms');
    expect(put.SSEKMSKeyId).toBe('alias/acme');
    expect(put.BucketKeyEnabled).toBe(true);

    await s3.send(new DeleteBucketEncryptionCommand({ Bucket }));
    const reverted = await s3.send(new GetBucketEncryptionCommand({ Bucket }));
    expect(reverted.ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe('AES256');
    await s3.send(new HeadBucketCommand({ Bucket }));
  });

  test('tagging, public access block and policy round trip; Delete* keep the bucket', async () => {
    expect((await sdkError(s3.send(new GetBucketTaggingCommand({ Bucket })))).name).toBe('NoSuchTagSet');
    await s3.send(new PutBucketTaggingCommand({ Bucket, Tagging: { TagSet: [{ Key: 'team', Value: 'billing' }] } }));
    expect((await s3.send(new GetBucketTaggingCommand({ Bucket }))).TagSet).toEqual([{ Key: 'team', Value: 'billing' }]);
    await s3.send(new DeleteBucketTaggingCommand({ Bucket }));
    expect((await sdkError(s3.send(new GetBucketTaggingCommand({ Bucket })))).$metadata.httpStatusCode).toBe(404);

    expect((await s3.send(new GetPublicAccessBlockCommand({ Bucket }))).PublicAccessBlockConfiguration?.BlockPublicAcls).toBe(true);
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket,
      PublicAccessBlockConfiguration: { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: true },
    }));
    expect((await s3.send(new GetPublicAccessBlockCommand({ Bucket }))).PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: true,
    });
    await s3.send(new DeletePublicAccessBlockCommand({ Bucket }));
    expect((await sdkError(s3.send(new GetPublicAccessBlockCommand({ Bucket })))).name).toBe('NoSuchPublicAccessBlockConfiguration');

    const Policy = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${Bucket}/*` }] });
    expect((await sdkError(s3.send(new GetBucketPolicyCommand({ Bucket })))).name).toBe('NoSuchBucketPolicy');
    await s3.send(new PutBucketPolicyCommand({ Bucket, Policy }));
    expect(JSON.parse((await s3.send(new GetBucketPolicyCommand({ Bucket }))).Policy ?? '')).toEqual(JSON.parse(Policy));
    await s3.send(new DeleteBucketPolicyCommand({ Bucket }));
    expect((await sdkError(s3.send(new GetBucketPolicyCommand({ Bucket })))).name).toBe('NoSuchBucketPolicy');

    await s3.send(new HeadBucketCommand({ Bucket }));
  });

  test('unsupported subresources answer NotImplemented 501 and leave the bucket alone', async () => {
    const lifecycle = await sdkError(s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket,
      LifecycleConfiguration: { Rules: [{ ID: 'expire', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } }] },
    })));
    expect(lifecycle.name).toBe('NotImplemented');
    expect(lifecycle.$metadata.httpStatusCode).toBe(501);
    const website = await sdkError(s3.send(new DeleteBucketWebsiteCommand({ Bucket })));
    expect(website.name).toBe('NotImplemented');
    await s3.send(new HeadBucketCommand({ Bucket }));
  });

  test('PutObject system metadata + SSE round trip through Get/Head/Copy as the SDK parses them', async () => {
    const Expires = new Date('2026-10-21T07:28:00Z');
    const put = await s3.send(new PutObjectCommand({
      Bucket, Key: 'invoice.pdf', Body: 'pdf',
      ContentType: 'application/pdf',
      ContentDisposition: 'attachment; filename="invoice.pdf"',
      CacheControl: 'max-age=3600',
      ContentEncoding: 'identity',
      ContentLanguage: 'en-US',
      Expires,
    }));
    expect(put.ServerSideEncryption).toBe('AES256');

    const head = await s3.send(new HeadObjectCommand({ Bucket, Key: 'invoice.pdf' }));
    expect(head.ContentDisposition).toBe('attachment; filename="invoice.pdf"');
    expect(head.CacheControl).toBe('max-age=3600');
    expect(head.ContentEncoding).toBe('identity');
    expect(head.ContentLanguage).toBe('en-US');
    expect(head.Expires?.toISOString()).toBe(Expires.toISOString());
    expect(head.ServerSideEncryption).toBe('AES256');

    const get = await s3.send(new GetObjectCommand({ Bucket, Key: 'invoice.pdf', ResponseContentDisposition: 'inline' }));
    expect(get.ContentDisposition).toBe('inline');
    expect(get.CacheControl).toBe('max-age=3600');
    expect(await get.Body?.transformToString()).toBe('pdf');

    const copy = await s3.send(new CopyObjectCommand({
      Bucket, Key: 'copy.pdf', CopySource: `${Bucket}/invoice.pdf`,
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'alias/copies',
    }));
    expect(copy.ServerSideEncryption).toBe('aws:kms');
    const copied = await s3.send(new HeadObjectCommand({ Bucket, Key: 'copy.pdf' }));
    expect(copied.CacheControl).toBe('max-age=3600');
    expect(copied.SSEKMSKeyId).toBe('alias/copies');
  });
});
