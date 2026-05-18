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
  type AttributeValue,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndexDescription,
  type LocalSecondaryIndexDescription,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { LocalStackManager } from './localstack-manager.js';

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

export class DynamoExplorer {
  private static instance: DynamoExplorer;
  private client!: DynamoDBClient;
  private currentRegion: string = 'us-east-1';

  private constructor() {
    this.init(this.currentRegion);
  }

  static getInstance(): DynamoExplorer {
    if (!DynamoExplorer.instance) DynamoExplorer.instance = new DynamoExplorer();
    return DynamoExplorer.instance;
  }

  private init(region: string): void {
    const baseConfig = LocalStackManager.getInstance().getConfig();
    this.client = new DynamoDBClient({ ...baseConfig, region });
    this.currentRegion = region;
  }

  setRegion(region: string): void {
    if (region && region !== this.currentRegion) this.init(region);
  }

  async listTables(): Promise<DynamoTableSummary[]> {
    const list = await this.client.send(new ListTablesCommand({}));
    const names = list.TableNames ?? [];
    const summaries = await Promise.all(names.map(name => this.summarize(name)));
    return summaries.filter((s): s is DynamoTableSummary => s !== null);
  }

  private async summarize(name: string): Promise<DynamoTableSummary | null> {
    try {
      const [desc, ttl] = await Promise.all([
        this.client.send(new DescribeTableCommand({ TableName: name })),
        this.describeTtl(name),
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

  async describeTable(name: string): Promise<DynamoTableDetail | null> {
    const summary = await this.summarize(name);
    if (!summary) return null;
    const desc = await this.client.send(new DescribeTableCommand({ TableName: name }));
    const table = desc.Table!;
    return {
      ...summary,
      arn: table.TableArn,
      gsis: table.GlobalSecondaryIndexes ?? [],
      lsis: table.LocalSecondaryIndexes ?? [],
      streamArn: table.LatestStreamArn,
      streamViewType: table.StreamSpecification?.StreamViewType,
    };
  }

  async describeTtl(name: string): Promise<TtlInfo> {
    try {
      const res = await this.client.send(new DescribeTimeToLiveCommand({ TableName: name }));
      const desc = res.TimeToLiveDescription;
      const status = desc?.TimeToLiveStatus;
      const enabled = status === 'ENABLED' || status === 'ENABLING';
      return { enabled, attributeName: desc?.AttributeName };
    } catch {
      return { enabled: false };
    }
  }

  async setTtl(name: string, enabled: boolean, attributeName?: string): Promise<TtlInfo> {
    if (enabled && !attributeName) {
      throw new Error('attributeName is required when enabling TTL');
    }
    const current = await this.describeTtl(name);
    // UpdateTimeToLive requires the attribute name even when disabling — pass the current one.
    const attr = enabled ? attributeName! : current.attributeName ?? attributeName ?? 'ttl';
    await this.client.send(
      new UpdateTimeToLiveCommand({
        TableName: name,
        TimeToLiveSpecification: { Enabled: enabled, AttributeName: attr },
      }),
    );
    return { enabled, attributeName: attr };
  }

  async scan(name: string, input: ScanQueryInput): Promise<ScanQueryOutput> {
    const eav = this.marshallExpressionValues(input.expressionAttributeValues);
    const esk = input.exclusiveStartKey
      ? (marshall(input.exclusiveStartKey, { removeUndefinedValues: true }) as Record<string, AttributeValue>)
      : undefined;

    const res = await this.client.send(
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

  async query(name: string, input: ScanQueryInput): Promise<ScanQueryOutput> {
    if (!input.keyConditionExpression) {
      throw new Error('keyConditionExpression is required for query');
    }
    const eav = this.marshallExpressionValues(input.expressionAttributeValues);
    const esk = input.exclusiveStartKey
      ? (marshall(input.exclusiveStartKey, { removeUndefinedValues: true }) as Record<string, AttributeValue>)
      : undefined;

    const res = await this.client.send(
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

  async getItem(name: string, key: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const res = await this.client.send(
      new GetItemCommand({
        TableName: name,
        Key: marshall(key, { removeUndefinedValues: true }) as Record<string, AttributeValue>,
      }),
    );
    return res.Item ? unmarshall(res.Item) : null;
  }

  async putItem(name: string, item: Record<string, unknown>): Promise<void> {
    if (!item || typeof item !== 'object') {
      throw new Error('Item must be a plain object');
    }
    await this.client.send(
      new PutItemCommand({
        TableName: name,
        Item: marshall(item, {
          removeUndefinedValues: true,
          convertClassInstanceToMap: true,
        }) as Record<string, AttributeValue>,
      }),
    );
  }

  async deleteItem(name: string, key: Record<string, unknown>): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: name,
        Key: marshall(key, { removeUndefinedValues: true }) as Record<string, AttributeValue>,
      }),
    );
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
