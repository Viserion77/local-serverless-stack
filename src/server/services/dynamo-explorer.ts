import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
  ScanCommand,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  SearchVectorsCommand,
  type AttributeValue,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndexDescription,
  type LocalSecondaryIndexDescription,
  type VectorIndexDescription,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { EngineManager } from '../engine/engine-manager.js';

export interface TtlInfo {
  enabled: boolean;
  attributeName?: string;
}

export interface DynamoTableSummary {
  name: string;
  status?: string;
  itemCount: number;
  sizeBytes: number;
  keySchema: KeySchemaElement[];
  attributeDefinitions: AttributeDefinition[];
  hasGsi: boolean;
  hasLsi: boolean;
  // DynamoDB vector indexes (SearchVectors). Lets the table list badge the
  // tables a developer can run a similarity search against.
  hasVectorIndex: boolean;
  streamEnabled: boolean;
  ttl: TtlInfo;
  billingMode?: string;
  createdAt?: string;
  warnings: string[];
}

export interface DynamoTableDetail extends DynamoTableSummary {
  arn?: string;
  gsis: GlobalSecondaryIndexDescription[];
  lsis: LocalSecondaryIndexDescription[];
  vectorIndexes: VectorIndexDescription[];
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

// Body of POST /api/dynamo/tables/:name/vector-search — the SearchVectors
// input minus TableName, in the explorer's plain-JSON dialect (camelCase,
// unmarshalled values) like scan/query, plus two debugging conveniences:
// `similarTo` (search with an existing item's own embedding) and `filter`
// (equality filters the explorer turns into a SearchConditionExpression).
export interface VectorSearchInput {
  // Defaults to the table's only vector index.
  indexName?: string;
  // The query embedding. Exactly one of `vector` / `similarTo`.
  vector?: number[];
  // Plain key of an item whose embedding becomes the query. The item itself
  // (always its own nearest neighbour) is left out of the results, and a
  // partitioned index is scoped to the item's partition unless the filter
  // names another one.
  similarTo?: Record<string, unknown>;
  // 1..100, default 10.
  topK?: number;
  // SearchSchema attribute → value, ANDed equalities.
  filter?: Record<string, unknown>;
  // Raw alternative to `filter` (not both).
  searchConditionExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
  projectionExpression?: string;
}

export interface VectorSearchOutput {
  indexName: string;
  distanceFunction?: string;
  source: 'vector' | 'similarTo';
  results: Array<{ item: Record<string, unknown>; score: number }>;
}

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 100;

export interface ScanQueryOutput {
  items: Record<string, unknown>[];
  count: number;
  scannedCount?: number;
  lastEvaluatedKey?: Record<string, unknown>;
}

export class DynamoExplorer {
  private static instance: DynamoExplorer;
  private clients = new Map<string, DynamoDBClient>();
  private defaultRegion: string = 'us-east-1';

  // Seed the default from the active engine config (same as S3Explorer /
  // QueueInspector). Without this a project on any region but us-east-1 got an
  // empty table list from every caller that omits `?region=` — the CLI, the
  // LssClient and a bare curl all hit that path; only the dashboard was safe
  // because it always sends the region it read from /api/config.
  private constructor() {
    const region = EngineManager.getInstance().getConfig().region;
    if (region) this.defaultRegion = region;
  }

  static getInstance(): DynamoExplorer {
    if (!DynamoExplorer.instance) DynamoExplorer.instance = new DynamoExplorer();
    return DynamoExplorer.instance;
  }

  setDefaultRegion(region: string): void {
    if (region) this.defaultRegion = region;
  }

  private clientFor(region?: string): DynamoDBClient {
    const r = region || this.defaultRegion;
    let client = this.clients.get(r);
    if (!client) {
      const baseConfig = EngineManager.getInstance().getConfig();
      client = new DynamoDBClient({ ...baseConfig, region: r });
      this.clients.set(r, client);
    }
    return client;
  }

  async listTables(region?: string): Promise<DynamoTableSummary[]> {
    const names = await this.listTableNames(region);
    const summaries = await Promise.all(names.map((name: string) => this.summarize(name, region)));
    return summaries.filter((s: DynamoTableSummary | null): s is DynamoTableSummary => s !== null);
  }

  // ListTables answers at most 100 names per page (AWS's hard limit, faithfully
  // reproduced by the self engine). A monorepo with 40 services x 10 tables has
  // 400 — following LastEvaluatedTableName is the difference between the
  // dashboard showing everything and silently showing the first quarter.
  async listTableNames(region?: string): Promise<string[]> {
    const client = this.clientFor(region);
    const names: string[] = [];
    let exclusiveStartTableName: string | undefined;
    do {
      const page = await client.send(new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }));
      names.push(...(page.TableNames ?? []));
      exclusiveStartTableName = page.LastEvaluatedTableName;
    } while (exclusiveStartTableName);
    return names;
  }

  private async summarize(name: string, region?: string): Promise<DynamoTableSummary | null> {
    try {
      const client = this.clientFor(region);
      const [desc, ttl] = await Promise.all([
        client.send(new DescribeTableCommand({ TableName: name })),
        this.describeTtl(name, region),
      ]);
      const table = desc.Table;
      if (!table) return null;

      const warnings: string[] = [];
      if (!ttl.enabled) warnings.push('TTL not configured');

      return {
        name,
        status: table.TableStatus,
        itemCount: table.ItemCount ?? 0,
        sizeBytes: table.TableSizeBytes ?? 0,
        keySchema: table.KeySchema ?? [],
        attributeDefinitions: table.AttributeDefinitions ?? [],
        hasGsi: (table.GlobalSecondaryIndexes ?? []).length > 0,
        hasLsi: (table.LocalSecondaryIndexes ?? []).length > 0,
        hasVectorIndex: (table.VectorIndexes ?? []).length > 0,
        streamEnabled: Boolean(table.StreamSpecification?.StreamEnabled),
        ttl,
        billingMode: table.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
        createdAt: table.CreationDateTime?.toISOString(),
        warnings,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      console.warn(`[dynamo] failed to describe ${name}: ${msg}`);
      return null;
    }
  }

  async describeTable(name: string, region?: string): Promise<DynamoTableDetail | null> {
    const summary = await this.summarize(name, region);
    if (!summary) return null;
    const client = this.clientFor(region);
    const desc = await client.send(new DescribeTableCommand({ TableName: name }));
    const table = desc.Table!;
    return {
      ...summary,
      arn: table.TableArn,
      gsis: table.GlobalSecondaryIndexes ?? [],
      lsis: table.LocalSecondaryIndexes ?? [],
      vectorIndexes: table.VectorIndexes ?? [],
      streamArn: table.LatestStreamArn,
      streamViewType: table.StreamSpecification?.StreamViewType,
    };
  }

  async describeTtl(name: string, region?: string): Promise<TtlInfo> {
    try {
      const client = this.clientFor(region);
      const res = await client.send(new DescribeTimeToLiveCommand({ TableName: name }));
      const desc = res.TimeToLiveDescription;
      const status = desc?.TimeToLiveStatus;
      const enabled = status === 'ENABLED' || status === 'ENABLING';
      return { enabled, attributeName: desc?.AttributeName };
    } catch {
      return { enabled: false };
    }
  }

  async setTtl(name: string, enabled: boolean, attributeName?: string, region?: string): Promise<TtlInfo> {
    if (enabled && !attributeName) {
      throw new Error('attributeName is required when enabling TTL');
    }
    const current = await this.describeTtl(name, region);
    // UpdateTimeToLive requires the attribute name even when disabling — pass the current one.
    const attr = enabled ? attributeName! : current.attributeName ?? attributeName ?? 'ttl';
    const client = this.clientFor(region);
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: name,
        TimeToLiveSpecification: { Enabled: enabled, AttributeName: attr },
      }),
    );
    return { enabled, attributeName: attr };
  }

  async scan(name: string, input: ScanQueryInput, region?: string): Promise<ScanQueryOutput> {
    const eav = this.marshallExpressionValues(input.expressionAttributeValues);
    const esk = input.exclusiveStartKey
      ? (marshall(input.exclusiveStartKey, { removeUndefinedValues: true }) as Record<string, AttributeValue>)
      : undefined;

    const client = this.clientFor(region);
    const res = await client.send(
      new ScanCommand({
        TableName: name,
        FilterExpression: input.filterExpression || undefined,
        ProjectionExpression: input.projectionExpression || undefined,
        ExpressionAttributeNames: input.expressionAttributeNames,
        ExpressionAttributeValues: eav,
        IndexName: input.indexName || undefined,
        Limit: input.limit,
        ExclusiveStartKey: esk,
      }),
    );
    return this.formatPagedOutput(res);
  }

  async query(name: string, input: ScanQueryInput, region?: string): Promise<ScanQueryOutput> {
    if (!input.keyConditionExpression) {
      throw new Error('keyConditionExpression is required for query');
    }
    const eav = this.marshallExpressionValues(input.expressionAttributeValues);
    const esk = input.exclusiveStartKey
      ? (marshall(input.exclusiveStartKey, { removeUndefinedValues: true }) as Record<string, AttributeValue>)
      : undefined;

    const client = this.clientFor(region);
    const res = await client.send(
      new QueryCommand({
        TableName: name,
        KeyConditionExpression: input.keyConditionExpression,
        FilterExpression: input.filterExpression || undefined,
        ProjectionExpression: input.projectionExpression || undefined,
        ExpressionAttributeNames: input.expressionAttributeNames,
        ExpressionAttributeValues: eav,
        IndexName: input.indexName || undefined,
        Limit: input.limit,
        ExclusiveStartKey: esk,
        ScanIndexForward: input.scanIndexForward,
      }),
    );
    return this.formatPagedOutput(res);
  }

  async getItem(name: string, key: Record<string, unknown>, region?: string): Promise<Record<string, unknown> | null> {
    const client = this.clientFor(region);
    const res = await client.send(
      new GetItemCommand({
        TableName: name,
        Key: marshall(key, { removeUndefinedValues: true }) as Record<string, AttributeValue>,
      }),
    );
    return res.Item ? unmarshall(res.Item) : null;
  }

  async putItem(name: string, item: Record<string, unknown>, region?: string): Promise<void> {
    if (!item || typeof item !== 'object') {
      throw new Error('Item must be a plain object');
    }
    const client = this.clientFor(region);
    await client.send(
      new PutItemCommand({
        TableName: name,
        Item: marshall(item, {
          removeUndefinedValues: true,
          convertClassInstanceToMap: true,
        }) as Record<string, AttributeValue>,
      }),
    );
  }

  async deleteItem(name: string, key: Record<string, unknown>, region?: string): Promise<void> {
    const client = this.clientFor(region);
    await client.send(
      new DeleteItemCommand({
        TableName: name,
        Key: marshall(key, { removeUndefinedValues: true }) as Record<string, AttributeValue>,
      }),
    );
  }

  /**
   * Similarity search for the dashboard / LssClient / MCP. Resolves the index
   * (the only one when omitted), the query vector (given, or read from the
   * `similarTo` item), the condition (from `filter` or raw), then sends a
   * real SearchVectors — the engine does the ranking, this only adapts the
   * explorer's plain-JSON dialect.
   */
  async searchVectors(name: string, input: VectorSearchInput, region?: string): Promise<VectorSearchOutput> {
    const client = this.clientFor(region);
    const described = await client.send(new DescribeTableCommand({ TableName: name }));
    const indexes = described.Table?.VectorIndexes ?? [];
    if (indexes.length === 0) throw new Error(`Table ${name} has no vector index`);
    const index = input.indexName ? indexes.find(i => i.IndexName === input.indexName) : indexes.length === 1 ? indexes[0] : undefined;
    if (!index) {
      const names = indexes.map(i => i.IndexName).join(', ');
      throw new Error(input.indexName
        ? `Table ${name} has no vector index named ${input.indexName} (vector indexes: ${names})`
        : `Table ${name} has several vector indexes — pass indexName (one of: ${names})`);
    }
    if ((input.vector === undefined) === (input.similarTo === undefined)) {
      throw new Error('Pass exactly one of vector or similarTo');
    }
    if (input.filter !== undefined && input.searchConditionExpression !== undefined) {
      throw new Error('Pass either filter or searchConditionExpression, not both');
    }
    const topK = input.topK ?? DEFAULT_TOP_K;
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
      throw new Error(`topK must be an integer between 1 and ${MAX_TOP_K}`);
    }

    const filter: Record<string, unknown> = { ...(input.filter ?? {}) };
    let vector: number[];
    let selfKey: string | undefined;
    if (input.similarTo !== undefined) {
      const res = await client.send(new GetItemCommand({
        TableName: name,
        Key: marshall(input.similarTo, { removeUndefinedValues: true }) as Record<string, AttributeValue>,
      }));
      if (!res.Item) throw new Error('similarTo: item not found');
      const source = unmarshall(res.Item);
      const embedding = source[index.VectorAttribute!.AttributeName!];
      if (!Array.isArray(embedding) || embedding.some(component => typeof component !== 'number')) {
        throw new Error(`similarTo: the item has no ${index.VectorAttribute!.AttributeName} embedding`);
      }
      vector = embedding;
      selfKey = this.keyFingerprint(described.Table!.KeySchema ?? [], source);
      // Searching a partitioned index requires its HASH: default it to the
      // item's own partition — "more like this one" almost always means
      // "within its category".
      const hash = (index.SearchSchema ?? []).find(el => el.SearchSchemaElementType === 'HASH')?.AttributeName;
      if (hash && input.searchConditionExpression === undefined && filter[hash] === undefined && source[hash] !== undefined) {
        filter[hash] = source[hash];
      }
    } else {
      if (!Array.isArray(input.vector) || input.vector.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
        throw new Error('vector must be an array of finite numbers');
      }
      vector = input.vector;
    }

    let condition = input.searchConditionExpression || undefined;
    let names = input.expressionAttributeNames;
    let values = this.marshallExpressionValues(input.expressionAttributeValues);
    const filterEntries = Object.entries(filter);
    if (filterEntries.length > 0) {
      condition = filterEntries.map((_, i) => `#f${i} = :f${i}`).join(' AND ');
      names = Object.fromEntries(filterEntries.map(([attr], i) => [`#f${i}`, attr]));
      values = this.marshallExpressionValues(Object.fromEntries(filterEntries.map(([, value], i) => [`:f${i}`, value])));
    }

    const res = await client.send(new SearchVectorsCommand({
      TableName: name,
      IndexName: index.IndexName,
      SearchVector: vector.map(component => ({ N: String(component) })),
      // One extra slot for the source item, which is filtered out below.
      TopK: selfKey === undefined ? topK : Math.min(topK + 1, MAX_TOP_K),
      SearchConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ProjectionExpression: input.projectionExpression || undefined,
    }));
    const keySchema = described.Table!.KeySchema ?? [];
    const results = (res.SearchResults ?? [])
      .map(result => ({ item: unmarshall(result.Item ?? {}), score: result.Score ?? 0 }))
      .filter(result => selfKey === undefined || this.keyFingerprint(keySchema, result.item) !== selfKey)
      .slice(0, topK);
    return {
      indexName: index.IndexName!,
      distanceFunction: index.DistanceFunction,
      source: selfKey === undefined ? 'vector' : 'similarTo',
      results,
    };
  }

  // Identity of an item by its table-key values (plain JSON).
  private keyFingerprint(keySchema: KeySchemaElement[], item: Record<string, unknown>): string {
    return JSON.stringify(keySchema.map(el => item[el.AttributeName!]));
  }

  private marshallExpressionValues(
    values?: Record<string, unknown>,
  ): Record<string, AttributeValue> | undefined {
    if (!values || Object.keys(values).length === 0) return undefined;
    // marshall expects a plain object — each value is marshalled to AttributeValue individually.
    const out: Record<string, AttributeValue> = {};
    for (const [placeholder, v] of Object.entries(values)) {
      const wrapped = marshall({ v }, { removeUndefinedValues: true });
      out[placeholder] = wrapped.v;
    }
    return out;
  }

  private formatPagedOutput(res: {
    Items?: Record<string, AttributeValue>[];
    Count?: number;
    ScannedCount?: number;
    LastEvaluatedKey?: Record<string, AttributeValue>;
  }): ScanQueryOutput {
    return {
      items: (res.Items ?? []).map(item => unmarshall(item)),
      count: res.Count ?? 0,
      scannedCount: res.ScannedCount,
      lastEvaluatedKey: res.LastEvaluatedKey ? unmarshall(res.LastEvaluatedKey) : undefined,
    };
  }
}
