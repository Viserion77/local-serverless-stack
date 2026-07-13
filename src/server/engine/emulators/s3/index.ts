// S3 emulator: rest-xml protocol, path-style only (the router peels
// virtual-host requests back into path-style before dispatching here).
// Bucket metadata lives in the 's3/buckets' catalog; each bucket keeps an
// object index in its own ItemTable and object bodies live as blobs on disk —
// bodies are never held in in-memory maps.

import { createHash, randomUUID } from 'crypto';
import type { AwsRequest, AwsResponse, EngineContext, RestEmulator } from '../../types.js';
import type { CatalogStore, ItemTable } from '../../store/store-types.js';
import { s3Error, notImplementedOperation } from '../../http/errors.js';
import { tag, xmlDocument, parseXml, childrenNamed, childText } from '../../http/xml.js';
import type { XmlNode } from '../../http/xml.js';

const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';
// Fixed canonical owner (same fiction LocalStack uses) — tooling only displays it.
const OWNER_ID = '75aa57f09aa0c8caeab4f8c24e99d10f8e7faeebf76c078efc7c6caea54ba06a';
const OWNER_DISPLAY_NAME = 'webfile';
const DEFAULT_CONTENT_TYPE = 'binary/octet-stream';
const METADATA_HEADER_PREFIX = 'x-amz-meta-';

export interface S3NotificationFilterRule {
  name: 'prefix' | 'suffix';
  value: string;
}

// Normalized Lambda notification entry. The dispatcher matches emitted
// S3ObjectEvent payloads against these (event glob + filter rules) to build
// the `Records` envelope it delivers to the function.
export interface S3LambdaNotificationConfig {
  id: string;
  lambdaFunctionArn: string;
  events: string[];
  filterRules: S3NotificationFilterRule[];
}

// Queue/Topic destinations are stored only so the configuration round-trips
// (the explorer counts them); v1 does not deliver to them.
interface DestinationNotificationConfig {
  id: string;
  arn: string;
  events: string[];
  filterRules: S3NotificationFilterRule[];
}

interface S3NotificationConfiguration {
  lambda: S3LambdaNotificationConfig[];
  queue: DestinationNotificationConfig[];
  topic: DestinationNotificationConfig[];
}

interface S3BucketRecord {
  region: string;
  creationDate: string; // ISO 8601
  versioningStatus?: 'Enabled' | 'Suspended';
  notifications?: S3NotificationConfiguration;
}

interface S3ObjectRecord {
  size: number;
  eTag: string; // unquoted md5 hex — quoted at every HTTP surface
  lastModified: string; // ISO 8601
  blobPath: string;
  contentType: string;
  metadata: Record<string, string>; // x-amz-meta-* values keyed by suffix
  storageClass: 'STANDARD';
}

export class S3Emulator implements RestEmulator {
  readonly service = 's3' as const;
  private readonly ctx: EngineContext;
  private readonly buckets: CatalogStore<S3BucketRecord>;
  private lastSequencer = 0n;

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
    this.buckets = ctx.store.catalog<S3BucketRecord>('s3/buckets');
  }

  async handle(req: AwsRequest): Promise<AwsResponse> {
    await this.buckets.load();
    if ('uploads' in req.query || 'uploadId' in req.query || 'partNumber' in req.query) {
      throw s3Error(
        'NotImplemented',
        'S3 multipart upload is not implemented by the LSS self engine yet — it lands in the hardening phase',
        501,
      );
    }
    const { bucket, key } = parsePath(req.rawPath);
    if (!bucket) {
      if (req.method === 'GET') return this.listBuckets();
      throw notImplementedOperation('s3', `${req.method} /`);
    }
    if (key === undefined) return this.handleBucket(req, bucket);
    return this.handleObject(req, bucket, key);
  }

  // Dispatcher hook: the normalized Lambda notification entries for a bucket
  // (empty when the bucket is unknown or has no configuration).
  async getNotificationConfiguration(bucket: string): Promise<S3LambdaNotificationConfig[]> {
    await this.buckets.load();
    return this.buckets.get(bucket)?.notifications?.lambda ?? [];
  }

  // -------------------------------------------------------------------------
  // Bucket-level operations
  // -------------------------------------------------------------------------

  private async handleBucket(req: AwsRequest, bucket: string): Promise<AwsResponse> {
    if (req.method === 'PUT') {
      if ('versioning' in req.query) return this.putBucketVersioning(bucket, req);
      if ('notification' in req.query) return this.putBucketNotification(bucket, req);
      return this.createBucket(bucket, req);
    }
    if (req.method === 'GET') {
      if ('location' in req.query) return this.getBucketLocation(bucket);
      if ('versioning' in req.query) return this.getBucketVersioning(bucket);
      if ('notification' in req.query) return this.getBucketNotification(bucket);
      if (req.query['list-type'] === '2') return this.listObjectsV2(bucket, req.query);
      throw notImplementedOperation('s3', 'ListObjects (v1) — request with list-type=2');
    }
    if (req.method === 'HEAD') {
      this.requireBucket(bucket);
      return { status: 200 };
    }
    if (req.method === 'DELETE') return this.deleteBucket(bucket);
    if (req.method === 'POST' && 'delete' in req.query) return this.deleteObjects(bucket, req);
    throw notImplementedOperation('s3', `${req.method} /<bucket>`);
  }

  private createBucket(bucket: string, req: AwsRequest): AwsResponse {
    if (this.buckets.get(bucket)) {
      throw s3Error(
        'BucketAlreadyOwnedByYou',
        'Your previous request to create the named bucket succeeded and you already own it.',
        409,
      );
    }
    let region = req.region;
    if (req.body.length > 0) {
      const constraint = childText(parseBodyXml(req.body), 'LocationConstraint');
      if (constraint) region = constraint;
    }
    this.buckets.set(bucket, { region, creationDate: new Date().toISOString() });
    return { status: 200, headers: { Location: `/${bucket}` } };
  }

  private async deleteBucket(bucket: string): Promise<AwsResponse> {
    this.requireBucket(bucket);
    const index = await this.index(bucket);
    if (index.size() > 0) {
      throw s3Error('BucketNotEmpty', 'The bucket you tried to delete is not empty', 409);
    }
    await index.destroy();
    this.buckets.delete(bucket);
    return { status: 204 };
  }

  private listBuckets(): AwsResponse {
    const bucketsXml = this.buckets
      .keys()
      .sort()
      .map(name => {
        const record = this.buckets.get(name);
        const creationDate = record ? record.creationDate : new Date().toISOString();
        return tag('Bucket', tag('Name', name) + tag('CreationDate', creationDate), { escape: false });
      })
      .join('');
    const owner = tag('Owner', tag('ID', OWNER_ID) + tag('DisplayName', OWNER_DISPLAY_NAME), { escape: false });
    const root = tag('ListAllMyBucketsResult', owner + tag('Buckets', bucketsXml, { escape: false }), {
      attrs: { xmlns: S3_XMLNS },
      escape: false,
    });
    return xmlResponse(200, root);
  }

  private getBucketLocation(bucket: string): AwsResponse {
    const record = this.requireBucket(bucket);
    // AWS quirk: us-east-1 is reported as an EMPTY (self-closing) element.
    const content = record.region === 'us-east-1' ? '' : record.region;
    return xmlResponse(200, tag('LocationConstraint', content, { attrs: { xmlns: S3_XMLNS } }));
  }

  private putBucketVersioning(bucket: string, req: AwsRequest): AwsResponse {
    const record = this.requireBucket(bucket);
    const status = childText(parseBodyXml(req.body), 'Status');
    if (status !== 'Enabled' && status !== 'Suspended') {
      throw s3Error('MalformedXML', 'VersioningConfiguration Status must be Enabled or Suspended', 400);
    }
    this.buckets.set(bucket, { ...record, versioningStatus: status });
    return { status: 200 };
  }

  private getBucketVersioning(bucket: string): AwsResponse {
    const record = this.requireBucket(bucket);
    const content = record.versioningStatus ? tag('Status', record.versioningStatus) : '';
    return xmlResponse(200, tag('VersioningConfiguration', content, { attrs: { xmlns: S3_XMLNS }, escape: false }));
  }

  private putBucketNotification(bucket: string, req: AwsRequest): AwsResponse {
    // SkipDestinationValidation (x-amz-skip-destination-validation) is
    // accepted implicitly: destinations are never probed.
    const record = this.requireBucket(bucket);
    this.buckets.set(bucket, { ...record, notifications: parseNotificationConfiguration(req.body) });
    return { status: 200 };
  }

  private getBucketNotification(bucket: string): AwsResponse {
    const record = this.requireBucket(bucket);
    return xmlResponse(200, serializeNotificationConfiguration(record.notifications));
  }

  private async listObjectsV2(bucket: string, query: Record<string, string>): Promise<AwsResponse> {
    this.requireBucket(bucket);
    const index = await this.index(bucket);
    const prefix = query.prefix ?? '';
    const delimiter = query.delimiter || undefined;
    const encode = query['encoding-type'] === 'url';
    const requestedMax = Number.parseInt(query['max-keys'] ?? '', 10);
    const maxKeys = Number.isNaN(requestedMax) ? 1000 : Math.min(Math.max(requestedMax, 0), 1000);
    const continuationToken = query['continuation-token'];
    const startAfter = query['start-after'] ?? '';
    // The continuation token is opaque: base64 of the last key the previous
    // page consumed. It wins over start-after, like real S3.
    const after = continuationToken ? Buffer.from(continuationToken, 'base64').toString('utf8') : startAfter;

    const keys: string[] = [];
    if (maxKeys > 0) {
      for (const [key] of index.entries()) {
        if (key.startsWith(prefix) && key > after) keys.push(key);
      }
      keys.sort();
    }

    const contents: string[] = [];
    const prefixes: string[] = [];
    const seenPrefixes = new Set<string>();
    let truncated = false;
    let lastKey = '';
    for (const key of keys) {
      let commonPrefix: string | undefined;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(delimiter);
        if (cut >= 0) commonPrefix = prefix + rest.slice(0, cut + delimiter.length);
      }
      if (commonPrefix && seenPrefixes.has(commonPrefix)) {
        // Grouped under an already-counted prefix — consumes the key for the
        // continuation cursor but not the MaxKeys budget.
        lastKey = key;
        continue;
      }
      if (contents.length + prefixes.length >= maxKeys) {
        truncated = true;
        break;
      }
      if (commonPrefix) {
        seenPrefixes.add(commonPrefix);
        prefixes.push(commonPrefix);
      } else {
        const record = index.get(key) as S3ObjectRecord;
        contents.push(
          tag(
            'Contents',
            tag('Key', encode ? urlEncodeKey(key) : key) +
              tag('LastModified', record.lastModified) +
              tag('ETag', `"${record.eTag}"`) +
              tag('Size', String(record.size)) +
              tag('StorageClass', record.storageClass),
            { escape: false },
          ),
        );
      }
      lastKey = key;
    }

    const parts: string[] = [
      tag('Name', bucket),
      tag('Prefix', encode ? urlEncodeKey(prefix) : prefix),
    ];
    if (delimiter) parts.push(tag('Delimiter', encode ? urlEncodeKey(delimiter) : delimiter));
    if (encode) parts.push(tag('EncodingType', 'url'));
    parts.push(tag('MaxKeys', String(maxKeys)));
    parts.push(tag('KeyCount', String(contents.length + prefixes.length)));
    parts.push(tag('IsTruncated', truncated ? 'true' : 'false'));
    if (continuationToken) parts.push(tag('ContinuationToken', continuationToken));
    if (startAfter) parts.push(tag('StartAfter', encode ? urlEncodeKey(startAfter) : startAfter));
    if (truncated) parts.push(tag('NextContinuationToken', Buffer.from(lastKey, 'utf8').toString('base64')));
    parts.push(...contents);
    parts.push(...prefixes.map(p => tag('CommonPrefixes', tag('Prefix', encode ? urlEncodeKey(p) : p), { escape: false })));
    return xmlResponse(200, tag('ListBucketResult', parts.join(''), { attrs: { xmlns: S3_XMLNS }, escape: false }));
  }

  private async deleteObjects(bucket: string, req: AwsRequest): Promise<AwsResponse> {
    const bucketRecord = this.requireBucket(bucket);
    const index = await this.index(bucket);
    const root = parseBodyXml(req.body);
    if (root.name !== 'Delete') {
      throw s3Error('MalformedXML', 'DeleteObjects expects a <Delete> document', 400);
    }
    const quiet = (childText(root, 'Quiet') ?? '').toLowerCase() === 'true';
    const deleted: string[] = [];
    for (const objectNode of childrenNamed(root, 'Object')) {
      const key = childText(objectNode, 'Key');
      if (key === undefined) continue;
      await this.removeObject(index, key);
      this.queueObjectEvent(bucketRecord.region, bucket, 's3:ObjectRemoved:Delete', key, 0, '');
      deleted.push(key);
    }
    const body = quiet ? '' : deleted.map(key => tag('Deleted', tag('Key', key), { escape: false })).join('');
    return xmlResponse(200, tag('DeleteResult', body, { attrs: { xmlns: S3_XMLNS }, escape: false }));
  }

  // -------------------------------------------------------------------------
  // Object-level operations
  // -------------------------------------------------------------------------

  private async handleObject(req: AwsRequest, bucket: string, key: string): Promise<AwsResponse> {
    if (req.method === 'PUT') {
      if (req.headers['x-amz-copy-source']) return this.copyObject(bucket, key, req);
      return this.putObject(bucket, key, req);
    }
    if (req.method === 'GET') return this.getObject(bucket, key, req);
    if (req.method === 'HEAD') return this.headObject(bucket, key);
    if (req.method === 'DELETE') return this.deleteObject(bucket, key);
    throw notImplementedOperation('s3', `${req.method} /<bucket>/<key>`);
  }

  private async putObject(bucket: string, key: string, req: AwsRequest): Promise<AwsResponse> {
    const bucketRecord = this.requireBucket(bucket);
    const index = await this.index(bucket);
    const eTag = md5Hex(req.body);
    // Blob first, index second: the index never points at a missing blob.
    const blobPath = await this.ctx.store.writeBlob(`s3/${bucket}/blobs`, req.body);
    const previous = index.get(key) as S3ObjectRecord | undefined;
    const record: S3ObjectRecord = {
      size: req.body.length,
      eTag,
      lastModified: new Date().toISOString(),
      blobPath,
      contentType: req.headers['content-type'] ?? DEFAULT_CONTENT_TYPE,
      metadata: metadataFromHeaders(req.headers),
      storageClass: 'STANDARD',
    };
    index.put(key, record);
    if (previous && previous.blobPath !== blobPath) {
      await this.deleteBlobIfUnreferenced(index, previous.blobPath);
    }
    this.queueObjectEvent(bucketRecord.region, bucket, 's3:ObjectCreated:Put', key, record.size, eTag);
    return { status: 200, headers: { ETag: `"${eTag}"` } };
  }

  private async copyObject(bucket: string, key: string, req: AwsRequest): Promise<AwsResponse> {
    const bucketRecord = this.requireBucket(bucket);
    const rawSource = req.headers['x-amz-copy-source'] ?? '';
    const source = safeDecode(rawSource.split('?')[0]).replace(/^\//, '');
    const cut = source.indexOf('/');
    if (cut <= 0 || cut === source.length - 1) {
      throw s3Error('InvalidArgument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey', 400);
    }
    const sourceBucket = source.slice(0, cut);
    const sourceKey = source.slice(cut + 1);
    this.requireBucket(sourceBucket);
    const sourceIndex = await this.index(sourceBucket);
    const sourceRecord = sourceIndex.get(sourceKey) as S3ObjectRecord | undefined;
    if (!sourceRecord) throw s3Error('NoSuchKey', 'The specified key does not exist.', 404);

    const data = await this.ctx.store.readBlob(sourceRecord.blobPath);
    const index = await this.index(bucket);
    const blobPath = await this.ctx.store.writeBlob(`s3/${bucket}/blobs`, data);
    const replaceMetadata = (req.headers['x-amz-metadata-directive'] ?? 'COPY').toUpperCase() === 'REPLACE';
    const lastModified = new Date().toISOString();
    const previous = index.get(key) as S3ObjectRecord | undefined;
    const record: S3ObjectRecord = {
      size: sourceRecord.size,
      eTag: sourceRecord.eTag,
      lastModified,
      blobPath,
      contentType: replaceMetadata ? req.headers['content-type'] ?? DEFAULT_CONTENT_TYPE : sourceRecord.contentType,
      metadata: replaceMetadata ? metadataFromHeaders(req.headers) : { ...sourceRecord.metadata },
      storageClass: 'STANDARD',
    };
    index.put(key, record);
    if (previous && previous.blobPath !== blobPath) {
      await this.deleteBlobIfUnreferenced(index, previous.blobPath);
    }
    this.queueObjectEvent(bucketRecord.region, bucket, 's3:ObjectCreated:Copy', key, record.size, record.eTag);
    const result = tag('CopyObjectResult', tag('ETag', `"${record.eTag}"`) + tag('LastModified', lastModified), {
      attrs: { xmlns: S3_XMLNS },
      escape: false,
    });
    return xmlResponse(200, result);
  }

  private async getObject(bucket: string, key: string, req: AwsRequest): Promise<AwsResponse> {
    const record = await this.requireObject(bucket, key);
    const data = await this.ctx.store.readBlob(record.blobPath);
    const headers = objectHeaders(record);
    const range = parseRange(req.headers.range, record.size);
    if (range) {
      const slice = data.subarray(range.start, range.end + 1);
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${record.size}`;
      headers['Content-Length'] = String(slice.length);
      return { status: 206, headers, body: slice };
    }
    headers['Content-Length'] = String(record.size);
    return { status: 200, headers, body: data };
  }

  private async headObject(bucket: string, key: string): Promise<AwsResponse> {
    const record = await this.requireObject(bucket, key);
    const headers = objectHeaders(record);
    headers['Content-Length'] = String(record.size);
    return { status: 200, headers };
  }

  private async deleteObject(bucket: string, key: string): Promise<AwsResponse> {
    const bucketRecord = this.requireBucket(bucket);
    const index = await this.index(bucket);
    await this.removeObject(index, key);
    // AWS semantics: delete succeeds (and notifies) even for a missing key.
    this.queueObjectEvent(bucketRecord.region, bucket, 's3:ObjectRemoved:Delete', key, 0, '');
    return { status: 204 };
  }

  // -------------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------------

  private requireBucket(bucket: string): S3BucketRecord {
    const record = this.buckets.get(bucket);
    if (!record) throw s3Error('NoSuchBucket', 'The specified bucket does not exist', 404);
    return record;
  }

  private async requireObject(bucket: string, key: string): Promise<S3ObjectRecord> {
    this.requireBucket(bucket);
    const index = await this.index(bucket);
    const record = index.get(key) as S3ObjectRecord | undefined;
    if (!record) throw s3Error('NoSuchKey', 'The specified key does not exist.', 404);
    return record;
  }

  private async index(bucket: string): Promise<ItemTable> {
    const table = this.ctx.store.table(`s3/${bucket}/index`);
    await table.hydrate();
    return table;
  }

  private async removeObject(index: ItemTable, key: string): Promise<void> {
    const record = index.get(key) as S3ObjectRecord | undefined;
    if (!record) return;
    index.delete(key);
    await this.deleteBlobIfUnreferenced(index, record.blobPath);
  }

  // The blob store is content-addressed, so two keys written with the same
  // bytes share one blob file. Only delete a blob once no index entry
  // references it anymore (blobs never leak across buckets — each bucket has
  // its own blob directory).
  private async deleteBlobIfUnreferenced(index: ItemTable, blobPath: string): Promise<void> {
    for (const [, value] of index.entries()) {
      if ((value as S3ObjectRecord).blobPath === blobPath) return;
    }
    await this.ctx.store.deleteBlob(blobPath);
  }

  // Post-commit eventing: the sequencer is taken synchronously so ordering
  // matches commit order, but the bus emit is deferred to the next macrotask.
  private queueObjectEvent(
    region: string,
    bucket: string,
    eventName: string,
    key: string,
    size: number,
    eTag: string,
  ): void {
    const sequencer = this.nextSequencer();
    setImmediate(() => {
      this.ctx.bus.emit('s3:object-event', { region, bucket, eventName, key, size, eTag, sequencer });
    });
  }

  private nextSequencer(): string {
    const candidate = BigInt(Date.now()) << 16n;
    this.lastSequencer = candidate > this.lastSequencer ? candidate : this.lastSequencer + 1n;
    return this.lastSequencer.toString(16).toUpperCase().padStart(16, '0');
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// `/bucket/a/b%20c` → bucket plus key with each segment URL-decoded. Slashes
// between segments (and any decoded %2F inside one) become plain slashes in
// the key — exactly how real S3 treats them.
function parsePath(rawPath: string): { bucket: string | undefined; key: string | undefined } {
  const parts = rawPath.replace(/^\/+/, '').split('/');
  const bucket = safeDecode(parts[0] ?? '');
  if (!bucket) return { bucket: undefined, key: undefined };
  if (parts.length === 1) return { bucket, key: undefined };
  const key = parts.slice(1).map(safeDecode).join('/');
  return { bucket, key: key || undefined };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw s3Error('InvalidURI', `Couldn't parse the specified URI: ${value}`, 400);
  }
}

function parseBodyXml(body: Buffer): XmlNode {
  try {
    return parseXml(body.toString('utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw s3Error('MalformedXML', `The XML you provided was not well-formed: ${message}`, 400);
  }
}

function xmlResponse(status: number, root: string): AwsResponse {
  return { status, headers: { 'Content-Type': 'application/xml' }, body: xmlDocument(root) };
}

function md5Hex(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

// encoding-type=url: URL-encode response keys but keep the `/` separators, as
// real S3 does.
function urlEncodeKey(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function metadataFromHeaders(headers: Record<string, string>): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(METADATA_HEADER_PREFIX)) {
      metadata[name.slice(METADATA_HEADER_PREFIX.length)] = value;
    }
  }
  return metadata;
}

function objectHeaders(record: S3ObjectRecord): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': record.contentType,
    ETag: `"${record.eTag}"`,
    'Last-Modified': new Date(record.lastModified).toUTCString(),
    'Accept-Ranges': 'bytes',
  };
  for (const [name, value] of Object.entries(record.metadata)) {
    headers[`${METADATA_HEADER_PREFIX}${name}`] = value;
  }
  return headers;
}

// "bytes=a-b" | "bytes=a-" | "bytes=-n". A malformed header is ignored (full
// response), like real S3; a syntactically valid but unsatisfiable one is 416.
function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  if (match[1] === '') {
    const suffixLength = Number.parseInt(match[2], 10);
    if (suffixLength === 0 || size === 0) throw invalidRange();
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number.parseInt(match[1], 10);
  const end = match[2] === '' ? size - 1 : Math.min(Number.parseInt(match[2], 10), size - 1);
  if (start >= size || start > end) throw invalidRange();
  return { start, end };
}

function invalidRange(): Error {
  return s3Error('InvalidRange', 'The requested range is not satisfiable', 416);
}

// ---------------------------------------------------------------------------
// Notification configuration XML (rest-xml quirk: the wire format uses the
// LEGACY element names <CloudFunctionConfiguration><CloudFunction> for what
// the SDK calls LambdaFunctionConfigurations[].LambdaFunctionArn — pinned by
// the smithy model shipped in @aws-sdk/client-s3. The modern member names are
// accepted on parse for tools that send them.)
// ---------------------------------------------------------------------------

function parseNotificationConfiguration(body: Buffer): S3NotificationConfiguration {
  const configuration: S3NotificationConfiguration = { lambda: [], queue: [], topic: [] };
  if (body.length === 0) return configuration;
  const root = parseBodyXml(body);
  for (const elementName of ['CloudFunctionConfiguration', 'LambdaFunctionConfiguration']) {
    for (const node of childrenNamed(root, elementName)) {
      configuration.lambda.push({
        id: childText(node, 'Id') ?? randomUUID(),
        lambdaFunctionArn: childText(node, 'CloudFunction') ?? childText(node, 'LambdaFunctionArn') ?? '',
        events: childrenNamed(node, 'Event').map(event => event.text),
        filterRules: parseFilterRules(node),
      });
    }
  }
  for (const node of childrenNamed(root, 'QueueConfiguration')) {
    configuration.queue.push(parseDestination(node, ['Queue', 'QueueArn']));
  }
  for (const node of childrenNamed(root, 'TopicConfiguration')) {
    configuration.topic.push(parseDestination(node, ['Topic', 'TopicArn']));
  }
  return configuration;
}

function parseDestination(node: XmlNode, arnElementNames: string[]): DestinationNotificationConfig {
  let arn = '';
  for (const name of arnElementNames) {
    const value = childText(node, name);
    if (value) {
      arn = value;
      break;
    }
  }
  return {
    id: childText(node, 'Id') ?? randomUUID(),
    arn,
    events: childrenNamed(node, 'Event').map(event => event.text),
    filterRules: parseFilterRules(node),
  };
}

function parseFilterRules(node: XmlNode): S3NotificationFilterRule[] {
  const filter = node.children.find(child => child.name === 'Filter');
  const s3Key = filter?.children.find(child => child.name === 'S3Key');
  if (!s3Key) return [];
  const rules: S3NotificationFilterRule[] = [];
  for (const rule of childrenNamed(s3Key, 'FilterRule')) {
    const name = (childText(rule, 'Name') ?? '').toLowerCase();
    if (name !== 'prefix' && name !== 'suffix') continue;
    rules.push({ name, value: childText(rule, 'Value') ?? '' });
  }
  return rules;
}

function serializeNotificationConfiguration(configuration: S3NotificationConfiguration | undefined): string {
  const parts: string[] = [];
  for (const entry of configuration?.lambda ?? []) {
    parts.push(
      serializeDestination('CloudFunctionConfiguration', 'CloudFunction', {
        id: entry.id,
        arn: entry.lambdaFunctionArn,
        events: entry.events,
        filterRules: entry.filterRules,
      }),
    );
  }
  for (const entry of configuration?.queue ?? []) {
    parts.push(serializeDestination('QueueConfiguration', 'Queue', entry));
  }
  for (const entry of configuration?.topic ?? []) {
    parts.push(serializeDestination('TopicConfiguration', 'Topic', entry));
  }
  return tag('NotificationConfiguration', parts.join(''), { attrs: { xmlns: S3_XMLNS }, escape: false });
}

function serializeDestination(
  elementName: string,
  arnElementName: string,
  entry: DestinationNotificationConfig,
): string {
  const content =
    tag('Id', entry.id) +
    tag(arnElementName, entry.arn) +
    entry.events.map(event => tag('Event', event)).join('') +
    serializeFilterRules(entry.filterRules);
  return tag(elementName, content, { escape: false });
}

function serializeFilterRules(rules: S3NotificationFilterRule[]): string {
  if (rules.length === 0) return '';
  const ruleXml = rules
    .map(rule => tag('FilterRule', tag('Name', rule.name) + tag('Value', rule.value), { escape: false }))
    .join('');
  return tag('Filter', tag('S3Key', ruleXml, { escape: false }), { escape: false });
}
