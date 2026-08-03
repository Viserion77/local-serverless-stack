// Public types for the programmatic LSS client.
//
// The response shapes below MIRROR the server's interfaces (seed-manager.ts,
// queue-inspector.ts, dynamo-explorer.ts, s3-explorer.ts). They are re-declared
// here — rather than imported from `../server/**` — so the published client is a
// self-contained CommonJS build with zero compile-time coupling to the ESM
// server tree. Keep them in sync when the server response shapes change.

export interface LssClientOptions {
  /** Full base URL of a running orchestrator, e.g. "http://localhost:3100". Wins over host/port/config. */
  baseUrl?: string;
  /** Orchestrator host. Default "localhost". */
  host?: string;
  /** Orchestrator server port. See config-discovery for the full resolution order. */
  port?: number;
  /** Path to an lss.config.json. Threaded to the CLI as `--config` for lifecycle and used to discover the port. */
  configPath?: string;
  /** Working dir for config discovery + CLI subprocess spawn. Default process.cwd(). */
  cwd?: string;
  /** Default `?region=` applied to API calls that accept it. */
  region?: string;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

// ── Seeds (mirrors src/server/services/seed-manager.ts) ──────────────────────
export interface SeedFileEntry {
  tableName: string;
  file: string;
  itemCount: number;
  tableExists: boolean;
}
export interface SeedResult {
  tableName: string;
  inserted: number;
  skipped?: boolean;
  reason?: string;
}
export interface ClearResult {
  tableName: string;
  deleted: number;
  skipped?: boolean;
  reason?: string;
}
export interface SeedsListResult {
  seedsDir: string;
  entries: SeedFileEntry[];
  liveTables: string[];
}

// ── Queues (mirrors src/server/services/queue-inspector.ts) ───────────────────
export interface QueueConsumer {
  functionName: string;
  uuid?: string;
  state?: string;
  batchSize?: number;
  enabled: boolean;
}
export interface QueueSnapshot {
  name: string;
  url: string;
  arn?: string;
  available: number;
  inFlight: number;
  delayed: number;
  processed: number;
  total: number;
  fifo: boolean;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  createdAt?: number;
  lastModifiedAt?: number;
  consumers: QueueConsumer[];
  lastPolledAt: number;
}
export interface CapturedMessage {
  messageId?: string;
  body?: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, { type?: string; value?: string }>;
  receivedAt: number;
}
export interface SqsAttributeInput {
  name: string;
  type?: 'String' | 'Number' | 'Binary';
  value: string;
}
export interface SendMessageInput {
  body: string;
  delaySeconds?: number;
  messageAttributes?: SqsAttributeInput[];
  messageGroupId?: string;
  messageDeduplicationId?: string;
}
export interface SendMessageResult {
  messageId?: string;
  sequenceNumber?: string;
  md5OfBody?: string;
}
export interface SqsMessage {
  messageId?: string;
  receiptHandle?: string;
  body?: string;
  md5OfBody?: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, { type?: string; value?: string }>;
}
export interface ReceiveMessagesInput {
  maxNumberOfMessages?: number;
  visibilityTimeout?: number;
  waitTimeSeconds?: number;
}
export interface AwaitIdleInput {
  timeoutMs?: number;
  sinceProcessed?: number;
}
export interface AwaitIdleResult {
  queue: string;
  available: number;
  inFlight: number;
  processed: number;
  drained: boolean;
}

// ── DynamoDB (mirrors src/server/services/dynamo-explorer.ts) ─────────────────
// AWS-SDK-specific shapes (key schema, index descriptions) are typed loosely to
// avoid pulling @aws-sdk types into the client's public surface.
export interface TtlInfo {
  enabled: boolean;
  attributeName?: string;
}
export interface DynamoTableSummary {
  name: string;
  status?: string;
  itemCount: number;
  sizeBytes: number;
  keySchema: unknown[];
  attributeDefinitions: unknown[];
  hasGsi: boolean;
  hasLsi: boolean;
  streamEnabled: boolean;
  ttl: TtlInfo;
  billingMode?: string;
  createdAt?: string;
  warnings: string[];
}
export interface DynamoTableDetail extends DynamoTableSummary {
  arn?: string;
  gsis: unknown[];
  lsis: unknown[];
  streamArn?: string;
  streamViewType?: string;
}
export interface ScanQueryInput {
  filterExpression?: string;
  keyConditionExpression?: string;
  projectionExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
  indexName?: string;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  scanIndexForward?: boolean;
}
export interface ScanQueryOutput {
  items: Record<string, unknown>[];
  count: number;
  scannedCount?: number;
  lastEvaluatedKey?: Record<string, unknown>;
}

// ── S3 (mirrors src/server/services/s3-explorer.ts) ───────────────────────────
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
export interface ListObjectsInput {
  prefix?: string;
  continuationToken?: string;
  delimiter?: string;
  maxKeys?: number;
}
export interface PutObjectInput {
  key: string;
  body: string;
  contentType?: string;
  encoding?: 'base64';
}

// ── Resources ─────────────────────────────────────────────────────────────────
export interface ResourceOwners {
  tables: Array<{ name: string; service: string }>;
  queues: Array<{ name: string; service: string }>;
  topics: Array<{ name: string; service: string }>;
  buckets: Array<{ name: string; service: string }>;
  // Absent on orchestrators older than 0.9.0.
  collections?: Array<{ name: string; service: string }>;
}

// ── Services ──────────────────────────────────────────────────────────────────
export interface RegisterServiceInput {
  servicePath: string;
  invokePort?: number;
  /** Gateway proxy port for the service's HTTP routes (30xx convention). */
  apiPort?: number;
  region?: string;
}
// The body of POST /api/services/:name/start. It only *selects* what runs — the
// server decides the rest: the cwd is always the registered service root and the
// argv is always `run start[:stage]`.
//
// `cwd`, `args` and `env` used to live here and went straight into spawn() on
// the server, which made the endpoint a general command runner for anything able
// to reach the port. The server ignores them now, so advertising them here would
// promise a capability it refuses.
export interface StartServiceInput {
  /** Package manager that runs the script. Anything else is rejected with 400. */
  command?: 'npm' | 'yarn' | 'pnpm';
  /** Selects the npm script `start:${stage}`; `[A-Za-z0-9._-]+` only. Default `start`. */
  stage?: string;
}

// ── Health ────────────────────────────────────────────────────────────────────
export interface HealthStatus {
  status: string;
  /** True once the in-process AWS engine is serving. */
  engineRunning: boolean;
  engine: {
    kind: 'self';
    running: boolean;
    endpoint: string;
    /** Emulated AWS services the engine answers for. */
    services?: string[];
    eventSourceLoops?: { sqs: number; streams: number };
    scheduleRules?: number;
  };
  dynamoProxy: { enabled: boolean; running: boolean; port: number };
}
