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
import { LocalStackManager } from './localstack-manager.js';

export interface BucketSnapshot {
  name: string;
  createdAt?: number;
  objectCount?: number;
  totalSize?: number;
  versioning?: boolean;
  notifications?: number;
  region?: string;
}

export interface BucketObject {
  key: string;
  size: number;
  lastModified?: number;
  etag?: string;
  storageClass?: string;
}

export interface ListObjectsResult {
  bucket: string;
  prefix?: string;
  objects: BucketObject[];
  commonPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface PutObjectInput {
  key: string;
  body: string | Buffer;
  contentType?: string;
}

export class S3Explorer {
  private static instance: S3Explorer;
  private clients = new Map<string, S3Client>();
  private defaultRegion = 'us-east-1';

  private constructor() {
    const region = LocalStackManager.getInstance().getConfig().region;
    if (region) this.defaultRegion = region;
  }

  static getInstance(): S3Explorer {
    if (!S3Explorer.instance) {
      S3Explorer.instance = new S3Explorer();
    }
    return S3Explorer.instance;
  }

  setDefaultRegion(region: string): void {
    if (region) this.defaultRegion = region;
  }

  private clientFor(region?: string): S3Client {
    const r = region || this.defaultRegion;
    let client = this.clients.get(r);
    if (!client) {
      const base = LocalStackManager.getInstance().getConfig();
      // forcePathStyle is required so LocalStack receives the bucket name in
      // the URL path instead of as a virtual-host subdomain.
      client = new S3Client({ ...base, region: r, forcePathStyle: true });
      this.clients.set(r, client);
    }
    return client;
  }

  async listBuckets(region?: string): Promise<BucketSnapshot[]> {
    const client = this.clientFor(region);
    const response = await client.send(new ListBucketsCommand({}));
    const buckets = response.Buckets || [];

    // Enrich with cheap metadata in parallel; failures degrade gracefully.
    return Promise.all(
      buckets
        .filter(b => b.Name)
        .map(async b => {
          const name = b.Name!;
          const snap: BucketSnapshot = {
            name,
            createdAt: b.CreationDate ? b.CreationDate.getTime() : undefined,
            region: region || this.defaultRegion,
          };
          try {
            const objects = await client.send(
              new ListObjectsV2Command({ Bucket: name, MaxKeys: 1000 }),
            );
            snap.objectCount = objects.KeyCount || 0;
            snap.totalSize = (objects.Contents || []).reduce(
              (sum, o) => sum + (o.Size || 0),
              0,
            );
          } catch {
            // Ignore — show bucket without size info
          }
          return snap;
        }),
    );
  }

  async getBucket(name: string, region?: string): Promise<BucketSnapshot | null> {
    const client = this.clientFor(region);
    try {
      await client.send(new HeadBucketCommand({ Bucket: name }));
    } catch {
      return null;
    }

    const snap: BucketSnapshot = { name, region: region || this.defaultRegion };

    const [location, versioning, notif, objects] = await Promise.allSettled([
      client.send(new GetBucketLocationCommand({ Bucket: name })),
      client.send(new GetBucketVersioningCommand({ Bucket: name })),
      client.send(new GetBucketNotificationConfigurationCommand({ Bucket: name })),
      client.send(new ListObjectsV2Command({ Bucket: name, MaxKeys: 1000 })),
    ]);

    if (location.status === 'fulfilled') {
      snap.region = location.value.LocationConstraint || snap.region;
    }
    if (versioning.status === 'fulfilled') {
      snap.versioning = versioning.value.Status === 'Enabled';
    }
    if (notif.status === 'fulfilled') {
      snap.notifications =
        (notif.value.LambdaFunctionConfigurations?.length || 0)
        + (notif.value.QueueConfigurations?.length || 0)
        + (notif.value.TopicConfigurations?.length || 0);
    }
    if (objects.status === 'fulfilled') {
      snap.objectCount = objects.value.KeyCount || 0;
      snap.totalSize = (objects.value.Contents || []).reduce(
        (sum, o) => sum + (o.Size || 0),
        0,
      );
    }

    return snap;
  }

  async listObjects(
    bucket: string,
    options: { prefix?: string; continuationToken?: string; maxKeys?: number; delimiter?: string },
    region?: string,
  ): Promise<ListObjectsResult> {
    const client = this.clientFor(region);
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: options.prefix,
        ContinuationToken: options.continuationToken,
        MaxKeys: options.maxKeys ?? 100,
        Delimiter: options.delimiter,
      }),
    );

    return {
      bucket,
      prefix: options.prefix,
      objects: (response.Contents || []).map(o => ({
        key: o.Key || '',
        size: o.Size || 0,
        lastModified: o.LastModified ? o.LastModified.getTime() : undefined,
        etag: o.ETag,
        storageClass: o.StorageClass,
      })),
      commonPrefixes: (response.CommonPrefixes || [])
        .map(p => p.Prefix || '')
        .filter(p => p !== ''),
      isTruncated: response.IsTruncated || false,
      nextContinuationToken: response.NextContinuationToken,
    };
  }

  async getObject(
    bucket: string,
    key: string,
    region?: string,
  ): Promise<{ body: Buffer; contentType?: string; size: number; lastModified?: number } | null> {
    const client = this.clientFor(region);
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = response.Body
        ? Buffer.from(await response.Body.transformToByteArray())
        : Buffer.alloc(0);
      return {
        body,
        contentType: response.ContentType,
        size: response.ContentLength || body.length,
        lastModified: response.LastModified ? response.LastModified.getTime() : undefined,
      };
    } catch (error: any) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async headObject(
    bucket: string,
    key: string,
    region?: string,
  ): Promise<{ contentType?: string; size: number; lastModified?: number } | null> {
    const client = this.clientFor(region);
    try {
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        contentType: response.ContentType,
        size: response.ContentLength || 0,
        lastModified: response.LastModified ? response.LastModified.getTime() : undefined,
      };
    } catch (error: any) {
      if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async putObject(bucket: string, input: PutObjectInput, region?: string): Promise<void> {
    const client = this.clientFor(region);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  async deleteObject(bucket: string, key: string, region?: string): Promise<void> {
    const client = this.clientFor(region);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
