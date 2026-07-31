import { currentRegion } from './region';

// In dev the SPA runs on the Vite server, so it needs the orchestrator's
// absolute URL; in a build it is served by the orchestrator itself.
const API_BASE = import.meta.env.DEV ? 'http://localhost:14566' : '';

// Absolute URL for orchestrator-served paths (e.g. branding assets), so they
// also resolve under `vite dev` where the UI runs on a different port.
export function resolveApiUrl(path: string): string {
  return /^(https?:|data:)/i.test(path) ? path : `${API_BASE}${path}`;
}

function withRegion(path: string): string {
  const r = currentRegion.value;
  if (!r) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}region=${encodeURIComponent(r)}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${withRegion(path)}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    // Carry the parsed body: error payloads may hold more than the message
    // (e.g. install/package answer 422 with the command's output tail).
    throw Object.assign(new Error(error.error || 'Request failed'), { body: error });
  }

  return response.json();
}

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

export interface SqsMessageAttributeInput {
  name: string;
  type?: 'String' | 'Number' | 'Binary';
  value: string;
}

export interface SendQueueMessageInput {
  body: string;
  delaySeconds?: number;
  messageAttributes?: SqsMessageAttributeInput[];
  messageGroupId?: string;
  messageDeduplicationId?: string;
}

export interface SendQueueMessageResult {
  messageId?: string;
  sequenceNumber?: string;
  md5OfBody?: string;
}

export interface ReceiveQueueMessagesInput {
  maxNumberOfMessages?: number;
  visibilityTimeout?: number;
  waitTimeSeconds?: number;
}

export interface SqsMessage {
  messageId?: string;
  receiptHandle?: string;
  body?: string;
  md5OfBody?: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, { type?: string; value?: string }>;
}

export interface DynamoKeyAttr {
  AttributeName?: string;
  KeyType?: string;
}

export interface DynamoAttrDef {
  AttributeName?: string;
  AttributeType?: string;
}

export interface DynamoTtlInfo {
  enabled: boolean;
  attributeName?: string;
}

export interface DynamoTableSummary {
  name: string;
  status?: string;
  itemCount: number;
  sizeBytes: number;
  keySchema: DynamoKeyAttr[];
  attributeDefinitions: DynamoAttrDef[];
  hasGsi: boolean;
  hasLsi: boolean;
  streamEnabled: boolean;
  ttl: DynamoTtlInfo;
  billingMode?: string;
  createdAt?: string;
  warnings: string[];
}

export interface DynamoIndex {
  IndexName?: string;
  IndexStatus?: string;
  KeySchema?: DynamoKeyAttr[];
  Projection?: { ProjectionType?: string; NonKeyAttributes?: string[] };
  IndexSizeBytes?: number;
  ItemCount?: number;
}

export interface DynamoTableDetail extends DynamoTableSummary {
  arn?: string;
  gsis: DynamoIndex[];
  lsis: DynamoIndex[];
  streamArn?: string;
  streamViewType?: string;
}

export interface DynamoScanQueryInput {
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

export interface DynamoScanQueryOutput {
  items: Record<string, unknown>[];
  count: number;
  scannedCount?: number;
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface SeedFileEntry {
  tableName: string;
  file: string;
  itemCount: number;
  tableExists: boolean;
}

export interface SeedListResponse {
  seedsDir: string;
  entries: SeedFileEntry[];
}

export interface SeedRunResult {
  tableName: string;
  inserted: number;
  skipped?: boolean;
  reason?: string;
}

export interface SeedClearResult {
  tableName: string;
  deleted: number;
  skipped?: boolean;
  reason?: string;
}

// One row of GET /api/services/scan — a discovered (not necessarily
// registered) Serverless/osls service under the project root.
export interface ScannedService {
  name: string;
  root: string;
  relPath: string;
  configFile: string;
  installed: boolean;
  packaged: boolean;
  registered: boolean;
  region?: string;
  // Effective values: `serviceRuntime` config overrides win over yml hints.
  apiPort?: number;
  invokePort?: number;
  // Effective package command for this service (servicePackaging else global).
  packageCommand: string;
  warnings: ScanWarning[];
}

// A scan warning carries a stable code the dashboard translates, plus the
// English message the server produced as a fallback.
export interface ScanWarning {
  code: string;
  message: string;
  params?: Record<string, string>;
}

// Result of POST /api/services/install and /api/services/package.
export interface PrepareServiceResult {
  success: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface ScanResponse {
  projectRoot: string;
  services: ScannedService[];
}

export interface RegisterServiceResult {
  success: boolean;
  serviceName: string;
  resourcesCount: number;
  functionsCount: number;
  routesCount: number;
  warnings: string[];
}

export interface HealthInfo {
  status: string;
  engineRunning: boolean;
  engine?: {
    kind: 'self';
    running: boolean;
    endpoint: string;
    services?: string[];
  };
  dynamoProxy: {
    enabled: boolean;
    running: boolean;
    port: number;
  };
}

export interface BrandingInfo {
  title: string;
  subtitle: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  defaultTheme: 'dark' | 'light';
  colors: Record<string, string>;
  themeColors: {
    dark: Record<string, string>;
    light: Record<string, string>;
  };
}

export interface SelfEngineInfo {
  port: number;
  dataDir: string;
  account: string;
  idleUnloadMs: number;
  memoryBudgetMb: number;
  fsync: boolean;
  fallbackEndpoint: string | null;
}

export interface LambdaRuntimeInfo {
  enabled: boolean;
  execution: 'auto' | 'artifact' | 'source';
  // null = mode-dependent default (source → on, artifact → off).
  watch: boolean | null;
  invokePortOffset: number;
  invokeHost: string;
  // Residency policy, already resolved by the server (maxWarmWorkers' default
  // is derived from the host's RAM, so the raw value is rarely the useful one).
  lazy: boolean;
  idleTimeoutMs: number;
  maxWarmWorkers: number;
}

// Per-service packaging override with env VALUES redacted to key names.
export interface ServicePackagingInfo {
  packageCommand?: string;
  packageArgs?: string[];
  packageTimeoutMs?: number;
  packageEnvKeys: string[];
}

export interface ServiceRuntimeInfo {
  enabled?: boolean;
  apiPort?: number;
  invokePort?: number;
  execution?: string;
  watch?: boolean;
}

export interface LssConfigSnapshot {
  serverPort: number;
  engine: {
    kind: 'self';
    endpoint: string;
  };
  selfEngine: SelfEngineInfo;
  dynamoProxy: {
    enabled: boolean;
    port: number;
  };
  region: string;
  persistence: boolean;
  debug: boolean;
  seedsDir: string;
  stateDir: string | null;
  autoPackage: boolean;
  packageCommand: string;
  packageTimeoutMs: number;
  packageArgs: string[];
  packageEnvKeys: string[];
  servicePackaging: Record<string, ServicePackagingInfo>;
  lambdaRuntime: LambdaRuntimeInfo;
  serviceRuntime: Record<string, ServiceRuntimeInfo>;
  secretSeedCount: number;
  // Config keys currently masked by an env var (env wins over the file).
  envOverrides: string[];
  configPath: string;
  projectRoot: string;
  branding: BrandingInfo;
}

// Writable subset for PUT /api/config. A top-level null deletes the key from
// the file; object blocks merge one level deep and a null subkey deletes it.
export interface LssConfigUpdate {
  serverPort?: number;
  enableDynamoProxy?: boolean;
  dynamoProxyPort?: number;
  region?: string;
  persistence?: boolean;
  debug?: boolean;
  seedsDir?: string | null;
  stateDir?: string | null;
  autoPackage?: boolean;
  packageCommand?: string | null;
  packageArgs?: string[];
  packageTimeoutMs?: number;
  lambdaRuntime?: {
    enabled?: boolean;
    execution?: 'auto' | 'artifact' | 'source';
    watch?: boolean | null;
    invokePortOffset?: number;
    invokeHost?: string | null;
    lazy?: boolean;
    idleTimeoutMs?: number;
    maxWarmWorkers?: number;
  };
  selfEngine?: {
    port?: number;
    account?: string;
    idleUnloadMs?: number;
    memoryBudgetMb?: number;
    fsync?: boolean;
    fallbackEndpoint?: string | null;
  };
  branding?: {
    title?: string | null;
    subtitle?: string | null;
    defaultTheme?: 'dark' | 'light';
  };
  // Map entries merge per service on the server: sending one subkey never
  // drops that entry's siblings; null deletes an entry (or one subkey).
  serviceRuntime?: Record<string, { apiPort?: number | null; invokePort?: number | null } | null>;
  servicePackaging?: Record<string, { packageCommand?: string | null } | null>;
}

export interface ConfigUpdateResponse {
  config: LssConfigSnapshot;
  configPath: string;
  // Boot-materialized keys that changed — need `lss stop && lss start`.
  restartRequired: string[];
  // Patch keys whose file value is masked by an env var right now.
  envOverridden: string[];
}

export interface ConfigReloadResponse {
  config: LssConfigSnapshot;
  configPath: string;
  restartRequired: string[];
}

export interface PortEntry {
  name: string;
  kind: 'orchestrator' | 'engine' | 'proxy' | 'service-api' | 'service-invoke';
  port: number;
  url: string;
  description: string;
}

export interface ResourceOwner {
  name: string;
  service: string;
}

export interface ResourceOwnersResponse {
  tables: ResourceOwner[];
  queues: ResourceOwner[];
  topics: ResourceOwner[];
  buckets: ResourceOwner[];
  collections?: ResourceOwner[];
}

export interface ServiceResource {
  type: 'lambda' | 'dynamodb' | 'sqs' | 'sns' | 's3' | 'eventbus' | 'event-rule' | 'opensearch' | 'event-source';
  name: string;
}

export interface ResourceBreakdown {
  lambdas: number;
  tables: number;
  queues: number;
  topics: number;
  buckets: number;
  buses?: number;
  eventRules?: number;
  collections?: number;
}

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

export interface ListBucketObjectsResult {
  bucket: string;
  prefix?: string;
  objects: BucketObject[];
  commonPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface PutBucketObjectInput {
  key: string;
  body: string;
  contentType?: string;
  encoding?: 'base64';
}

export interface OpenSearchCollectionSummary {
  name: string;
  endpoint: string;
}

export interface SecretSummary {
  name: string;
  arn?: string;
  description?: string;
  lastChangedDate?: string;
  lastAccessedDate?: string;
  createdDate?: string;
  deletedDate?: string;
  tags: Array<{ key: string; value: string }>;
  versionCount: number;
}

export interface SecretDetail extends SecretSummary {
  versionStages: Record<string, string[]>;
  kmsKeyId?: string;
}

export interface SecretValue {
  name: string;
  versionId?: string;
  versionStages: string[];
  secretString?: string;
  secretBinary?: string;
  createdDate?: string;
}

export interface OpenSearchIndexSummary {
  index: string;
  docsCount: number;
  health: string;
  status: string;
}

export interface OpenSearchSearchInput {
  index?: string;
  q?: string;
  query?: Record<string, unknown>;
  from?: number;
  size?: number;
}

export interface OpenSearchSearchHit {
  _index: string;
  _id: string;
  _source: Record<string, unknown>;
}

export interface OpenSearchSearchResponse {
  took: number;
  hits: {
    total: { value: number };
    hits: OpenSearchSearchHit[];
  };
  aggregations?: Record<string, unknown>;
}

export interface ServiceSummary {
  name: string;
  status: 'registered' | 'running' | 'stopped' | 'error';
  root: string;
  lastUpdated: number;
  resourcesCount?: number;
  resourceBreakdown?: ResourceBreakdown;
  pid?: number;
  invokePort?: number;
  region?: string;
}

export interface ServiceDetail extends ServiceSummary {
  resources: ServiceResource[];
}

export interface LambdaSummary {
  name: string;
  fullName: string;
  service: string;
  handler: string;
  runtime: string;
  memorySize: number;
  timeout: number;
  triggers: string[];
  invokePort?: number;
  status: 'stopped' | 'starting' | 'online' | 'error';
  executionMode?: 'artifact' | 'source';
  invocations: number;
  errors: number;
  lastInvokedAt?: number;
  lastDurationMs?: number;
  lastOk?: boolean;
}

export interface LambdaRouteInfo {
  method: string;
  path: string;
  eventType: 'http' | 'httpApi';
  authorizerName?: string;
}

export interface LambdaDetailInfo extends LambdaSummary {
  environment: Record<string, string>;
  routes: LambdaRouteInfo[];
}

export interface InvokeLambdaInput {
  payload?: unknown;
  invocationType?: 'RequestResponse' | 'Event';
}

export interface InvokeResult {
  ok: boolean;
  payload?: unknown;
  functionError?: { errorType?: string; errorMessage?: string; trace?: string[] };
  logs: string[];
  durationMs: number;
}

export interface LambdaInvocationRecord {
  at: number;
  functionName: string;
  ok: boolean;
  statusCode?: number;
  durationMs: number;
  logs: string[];
}

export type GatewayListenerStatus = 'online' | 'port-conflict' | 'stopped' | 'disabled';

export interface ApiRouteInfo {
  method: string;
  path: string;
  functionName: string;
  eventType: 'http' | 'httpApi';
  payloadVersion: '1.0' | '2.0';
  cors: boolean;
  authorizerName?: string;
}

export interface ApiAuthorizerInfo {
  name: string;
  type: 'request' | 'token';
  eventType: 'http' | 'httpApi';
  payloadVersion: '1.0' | '2.0';
  enableSimpleResponses: boolean;
  identitySource: string[];
  resultTtlInSeconds: number;
  functionName?: string;
  arn?: string;
}

export interface ServiceApiInfo {
  service: string;
  apiPort?: number;
  invokePort?: number;
  stage?: string;
  status: GatewayListenerStatus;
  invokeStatus: GatewayListenerStatus;
  routes: ApiRouteInfo[];
  authorizers: ApiAuthorizerInfo[];
}

export const api = {
  // Health & config
  checkHealth: () => request<HealthInfo>('/api/health'),
  scanServices: () => request<ScanResponse>('/api/services/scan'),
  getConfig: () => request<LssConfigSnapshot>('/api/config'),
  updateConfig: (patch: LssConfigUpdate) =>
    request<ConfigUpdateResponse>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  reloadConfig: () =>
    request<ConfigReloadResponse>('/api/config/reload', { method: 'POST' }),
  getPorts: () => request<{ ports: PortEntry[] }>('/api/config/ports'),
  getBranding: () => request<BrandingInfo>('/api/config/branding'),

  // Services
  listServices: () => request<ServiceSummary[]>('/api/services'),
  getService: (name: string) => request<ServiceDetail>(`/api/services/${encodeURIComponent(name)}`),
  registerService: (servicePath: string) =>
    request<RegisterServiceResult>('/api/services/register', {
      method: 'POST',
      body: JSON.stringify({ servicePath }),
    }),
  installService: (servicePath: string, command?: string) =>
    request<PrepareServiceResult>('/api/services/install', {
      method: 'POST',
      body: JSON.stringify({ servicePath, command }),
    }),
  packageService: (servicePath: string) =>
    request<PrepareServiceResult>('/api/services/package', {
      method: 'POST',
      body: JSON.stringify({ servicePath }),
    }),
  deleteService: (name: string) =>
    request<any>(`/api/services/${name}`, {
      method: 'DELETE',
    }),
  updateServiceStatus: (name: string, status: string, pid?: number) =>
    request<any>(`/api/services/${name}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, pid }),
    }),

  // Process control
  startService: (name: string, payload?: { stage?: string; cwd?: string; command?: string; args?: string[] }) =>
    request<any>(`/api/services/${name}/start`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    }),
  stopService: (name: string) =>
    request<any>(`/api/services/${name}/stop`, {
      method: 'POST',
    }),
  getServiceLogs: (name: string) => request<any>(`/api/services/${name}/logs`),

  // Lambdas
  listLambdas: () => request<LambdaSummary[]>('/api/lambdas'),
  getLambda: (name: string) =>
    request<LambdaDetailInfo>(`/api/lambdas/${encodeURIComponent(name)}`),
  invokeLambda: (name: string, input: InvokeLambdaInput) =>
    request<InvokeResult | { accepted: true }>(
      `/api/lambdas/${encodeURIComponent(name)}/invoke`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  getLambdaLogs: (name: string) =>
    request<{ invocations: LambdaInvocationRecord[] }>(
      `/api/lambdas/${encodeURIComponent(name)}/logs`,
    ),

  // HTTP APIs
  listApis: () => request<ServiceApiInfo[]>('/api/apis'),
  clearAuthorizerCache: (filter?: { service?: string; authorizer?: string }) => {
    const params = new URLSearchParams();
    if (filter?.service) params.set('service', filter.service);
    if (filter?.authorizer) params.set('authorizer', filter.authorizer);
    const qs = params.toString();
    return request<{ success: true; removed: number }>(
      `/api/apis/authorizer-cache/clear${qs ? `?${qs}` : ''}`,
      { method: 'POST' },
    );
  },

  // Resources
  listResources: () =>
    request<{ tables: string[]; queues: string[]; topics: string[]; buckets: string[]; collections?: string[] }>(
      '/api/resources',
    ),
  listResourceOwners: () => request<ResourceOwnersResponse>('/api/resources/owners'),

  // S3 buckets
  listBuckets: () => request<BucketSnapshot[]>('/api/buckets'),
  getBucket: (name: string) => request<BucketSnapshot>(`/api/buckets/${encodeURIComponent(name)}`),
  listBucketObjects: (
    name: string,
    options?: { prefix?: string; continuationToken?: string; maxKeys?: number; delimiter?: string },
  ) => {
    const params = new URLSearchParams();
    if (options?.prefix) params.set('prefix', options.prefix);
    if (options?.continuationToken) params.set('continuationToken', options.continuationToken);
    if (options?.maxKeys !== undefined) params.set('maxKeys', String(options.maxKeys));
    if (options?.delimiter) params.set('delimiter', options.delimiter);
    const qs = params.toString();
    return request<ListBucketObjectsResult>(
      `/api/buckets/${encodeURIComponent(name)}/objects${qs ? `?${qs}` : ''}`,
    );
  },
  bucketObjectContentUrl: (name: string, key: string, download = false) => {
    const params = new URLSearchParams({ key });
    if (download) params.set('download', '1');
    const r = currentRegion.value;
    if (r) params.set('region', r);
    return `${API_BASE}/api/buckets/${encodeURIComponent(name)}/objects/content?${params.toString()}`;
  },
  putBucketObject: (name: string, input: PutBucketObjectInput) =>
    request<{ success: boolean }>(`/api/buckets/${encodeURIComponent(name)}/objects`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteBucketObject: (name: string, key: string) =>
    request<{ success: boolean }>(
      `/api/buckets/${encodeURIComponent(name)}/objects?key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),

  // OpenSearch collections
  listOpenSearchCollections: () =>
    request<{ collections: OpenSearchCollectionSummary[] }>('/api/opensearch/collections'),
  listOpenSearchIndices: (name: string) =>
    request<{ indices: OpenSearchIndexSummary[] }>(
      `/api/opensearch/collections/${encodeURIComponent(name)}/indices`,
    ),
  searchOpenSearch: (name: string, input: OpenSearchSearchInput) =>
    request<OpenSearchSearchResponse>(
      `/api/opensearch/collections/${encodeURIComponent(name)}/search`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  // Secrets Manager
  listSecrets: () => request<{ secrets: SecretSummary[] }>('/api/secrets'),
  describeSecret: (name: string) =>
    request<SecretDetail>(`/api/secrets/${encodeURIComponent(name)}`),
  getSecretValue: (name: string) =>
    request<SecretValue>(`/api/secrets/${encodeURIComponent(name)}/value`),

  // Queues
  listQueues: () => request<QueueSnapshot[]>('/api/queues'),
  getQueue: (name: string) => request<QueueSnapshot>(`/api/queues/${encodeURIComponent(name)}`),
  resetQueueProcessed: (name: string) =>
    request<{ success: boolean }>(`/api/queues/${encodeURIComponent(name)}/reset-processed`, {
      method: 'POST',
    }),
  sendQueueMessage: (name: string, input: SendQueueMessageInput) =>
    request<SendQueueMessageResult>(`/api/queues/${encodeURIComponent(name)}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  receiveQueueMessages: (name: string, input: ReceiveQueueMessagesInput) =>
    request<{ messages: SqsMessage[] }>(
      `/api/queues/${encodeURIComponent(name)}/messages/receive`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  deleteQueueMessage: (name: string, receiptHandle: string) =>
    request<{ success: boolean }>(
      `/api/queues/${encodeURIComponent(name)}/messages/delete`,
      { method: 'POST', body: JSON.stringify({ receiptHandle }) },
    ),
  purgeQueue: (name: string) =>
    request<{ success: boolean }>(`/api/queues/${encodeURIComponent(name)}/purge`, {
      method: 'POST',
    }),

  // DynamoDB explorer
  listDynamoTables: () => request<{ tables: DynamoTableSummary[] }>('/api/dynamo/tables'),
  describeDynamoTable: (name: string) =>
    request<DynamoTableDetail>(`/api/dynamo/tables/${encodeURIComponent(name)}`),
  setDynamoTtl: (name: string, enabled: boolean, attributeName?: string) =>
    request<DynamoTtlInfo>(`/api/dynamo/tables/${encodeURIComponent(name)}/ttl`, {
      method: 'PUT',
      body: JSON.stringify({ enabled, attributeName }),
    }),
  scanDynamoTable: (name: string, input: DynamoScanQueryInput) =>
    request<DynamoScanQueryOutput>(`/api/dynamo/tables/${encodeURIComponent(name)}/scan`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  queryDynamoTable: (name: string, input: DynamoScanQueryInput) =>
    request<DynamoScanQueryOutput>(`/api/dynamo/tables/${encodeURIComponent(name)}/query`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getDynamoItem: (name: string, key: Record<string, unknown>) =>
    request<{ item: Record<string, unknown> | null }>(
      `/api/dynamo/tables/${encodeURIComponent(name)}/items/get`,
      { method: 'POST', body: JSON.stringify({ key }) },
    ),
  putDynamoItem: (name: string, item: Record<string, unknown>) =>
    request<{ success: boolean }>(`/api/dynamo/tables/${encodeURIComponent(name)}/items`, {
      method: 'POST',
      body: JSON.stringify({ item }),
    }),
  deleteDynamoItem: (name: string, key: Record<string, unknown>) =>
    request<{ success: boolean }>(
      `/api/dynamo/tables/${encodeURIComponent(name)}/items/delete`,
      { method: 'POST', body: JSON.stringify({ key }) },
    ),

  // Seeds
  listSeeds: () => request<SeedListResponse>('/api/seeds'),
  runSeed: (tableName?: string) =>
    request<{ results: SeedRunResult[] }>('/api/seeds/run', {
      method: 'POST',
      body: JSON.stringify(tableName ? { tableName } : {}),
    }),
  clearSeed: (tableName?: string) =>
    request<{ results: SeedClearResult[] }>('/api/seeds/clear', {
      method: 'POST',
      body: JSON.stringify(tableName ? { tableName } : {}),
    }),
};
