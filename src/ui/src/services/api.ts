import { currentRegion } from './region';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3100' : '';

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
}

export interface ResourceOwner {
  name: string;
  service: string;
}

export interface ResourceOwnersResponse {
  tables: ResourceOwner[];
  queues: ResourceOwner[];
  topics: ResourceOwner[];
}

export interface ServiceResource {
  type: 'lambda' | 'dynamodb' | 'sqs' | 'sns' | 'event-source';
  name: string;
}

export interface ResourceBreakdown {
  lambdas: number;
  tables: number;
  queues: number;
  topics: number;
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

export const api = {
  // Health & config
  checkHealth: () => request<HealthInfo>('/api/health'),
  getConfig: () => request<LssConfigSnapshot>('/api/config'),

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

  // Resources
  listResources: () => request<{ tables: string[]; queues: string[]; topics: string[] }>('/api/resources'),
  listResourceOwners: () => request<ResourceOwnersResponse>('/api/resources/owners'),

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
