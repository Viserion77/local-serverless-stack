import { currentRegion } from './region';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3100' : '';

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
    throw new Error(error.error || 'Request failed');
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

export interface HealthInfo {
  status: string;
  localstack: boolean;
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

export interface LssConfigSnapshot {
  serverPort: number;
  localstack: {
    mode: string;
    endpoint: string;
    port: number;
    edition: string;
    version: string;
    image: string;
    hasAuthToken: boolean;
  };
  dynamoProxy: {
    enabled: boolean;
    port: number;
  };
  region: string;
  services: string[];
  persistence: boolean;
  debug: boolean;
  seedsDir: string;
  autoPackage: boolean;
  packageCommand: string;
  packageTimeoutMs: number;
  configPath: string;
  branding: BrandingInfo;
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
  getConfig: () => request<LssConfigSnapshot>('/api/config'),
  getBranding: () => request<BrandingInfo>('/api/config/branding'),

  // Services
  listServices: () => request<ServiceSummary[]>('/api/services'),
  getService: (name: string) => request<ServiceDetail>(`/api/services/${encodeURIComponent(name)}`),
  registerService: (servicePath: string) =>
    request<any>('/api/services/register', {
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
