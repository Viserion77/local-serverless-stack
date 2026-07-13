// DynamoDB emulator core: control plane (tables, TTL), item CRUD with
// condition expressions, Query/Scan (query.ts), batch ops, lazy TTL
// expiration and change streams (streams.ts). All AWS-shaped failures are
// thrown as AwsError with the exact error names the provisioner's idempotency
// and the SDK's error mapping depend on (PRD RF2.4/RF3).

import type {
  AttributeMap, AwsRequest, EngineContext, TargetEmulator,
} from '../../types.js';
import type { CatalogStore, ItemTable } from '../../store/store-types.js';
import { AwsError, dynamoError, notImplementedOperation, validationError } from '../../http/errors.js';
import {
  applyProjection, applyUpdate, assertPlaceholdersUsed, attributeValuesEqual, compileCondition,
} from './expressions/index.js';
import { parseUpdateExpression } from './expressions/parser.js';
import type { ExpressionContext } from './expressions/expression-types.js';
import type { TableRecord } from './schema.js';
import {
  assertItemSize, buildTableRecord, canonicalKey, itemSizeBytes, keyMapOf, rejectLegacyParams,
  streamArnFor, tableArnFor, validateItemKey, validateProvidedKey,
} from './schema.js';
import { executeQuery, executeScan, indexHasItem } from './query.js';
import type { PageResult } from './query.js';
import { DynamoStreams } from './streams.js';
import {
  parseTransactGetItems, parseTransactWriteItems, TransactTokenCache,
} from './transactions.js';
import type { TransactGetOp, TransactWriteOp } from './transactions.js';

const DYNAMO_NS = 'com.amazonaws.dynamodb.v20120810';
const TTL_USER_IDENTITY = { type: 'Service', principalId: 'dynamodb.amazonaws.com' };
const DEFAULT_LIST_TABLES_LIMIT = 100;
const MAX_BATCH_WRITE_ITEMS = 25;
const MAX_BATCH_GET_KEYS = 100;

interface BatchGetTableSpec {
  Keys?: AttributeMap[];
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ConsistentRead?: boolean;
}

interface BatchWriteEntry {
  PutRequest?: { Item?: AttributeMap };
  DeleteRequest?: { Key?: AttributeMap };
}

export class DynamoDbEmulator implements TargetEmulator {
  readonly service = 'dynamodb' as const;
  readonly targetPrefix = 'DynamoDB_20120810';
  readonly jsonVersion = '1.0' as const;

  private readonly streams: DynamoStreams;
  private readonly catalogs = new Map<string, CatalogStore<TableRecord>>();
  private readonly transactTokens = new TransactTokenCache();

  constructor(private readonly ctx: EngineContext) {
    this.streams = new DynamoStreams(ctx);
  }

  async handle(operation: string, input: Record<string, unknown>, req: AwsRequest): Promise<object> {
    const region = req.region;
    switch (operation) {
      case 'CreateTable': return this.createTable(region, input);
      case 'DescribeTable': return this.describeTable(region, input);
      case 'DeleteTable': return this.deleteTable(region, input);
      case 'ListTables': return this.listTables(region, input);
      case 'UpdateTimeToLive': return this.updateTimeToLive(region, input);
      case 'DescribeTimeToLive': return this.describeTimeToLive(region, input);
      case 'PutItem': return this.putItem(region, input);
      case 'GetItem': return this.getItem(region, input);
      case 'DeleteItem': return this.deleteItem(region, input);
      case 'UpdateItem': return this.updateItem(region, input);
      case 'Query': return this.query(region, input);
      case 'Scan': return this.scan(region, input);
      case 'BatchGetItem': return this.batchGetItem(region, input);
      case 'BatchWriteItem': return this.batchWriteItem(region, input);
      case 'TransactWriteItems': return this.transactWriteItems(region, input);
      case 'TransactGetItems': return this.transactGetItems(region, input);
      default: throw notImplementedOperation('dynamodb', operation);
    }
  }

  // -- dispatcher-facing stream API -----------------------------------------

  getStreamArn(region: string, tableName: string): string | undefined {
    const known = this.streams.getStreamArn(region, tableName);
    if (known) return known;
    // The region catalog may already be loaded (any prior op or primeRegion)
    // without this table's stream registered yet — e.g. right after boot.
    const record = this.catalogs.get(region)?.get(tableName);
    if (record) this.streams.ensureRegistered(region, record);
    return this.streams.getStreamArn(region, tableName);
  }

  readStream(
    region: string,
    tableName: string,
    afterSeq: string | undefined,
    limit: number,
  ): { records: unknown[]; lastSeq: string | undefined } {
    return this.streams.read(region, tableName, afterSeq, limit);
  }

  // Boot-time rearm hook: loads the region catalog and registers every
  // enabled stream so getStreamArn() answers before any table op runs.
  async primeRegion(region: string): Promise<void> {
    const catalog = await this.catalogFor(region);
    for (const record of catalog.values()) this.streams.ensureRegistered(region, record);
  }

  // -- shared plumbing -------------------------------------------------------

  private async catalogFor(region: string): Promise<CatalogStore<TableRecord>> {
    let catalog = this.catalogs.get(region);
    if (!catalog) {
      catalog = this.ctx.store.catalog<TableRecord>(`dynamodb/${region}/tables`);
      this.catalogs.set(region, catalog);
    }
    await catalog.load();
    return catalog;
  }

  // DescribeTable-family errors name the table; data-plane errors do not
  // (matches the real service).
  private async requireTable(region: string, tableName: unknown, style: 'plain' | 'named' = 'plain'): Promise<TableRecord> {
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw validationError('TableName is required');
    }
    const catalog = await this.catalogFor(region);
    const record = catalog.get(tableName);
    if (!record) {
      throw dynamoError(
        'ResourceNotFoundException',
        style === 'named' ? `Requested resource not found: Table: ${tableName} not found` : 'Requested resource not found',
      );
    }
    this.streams.ensureRegistered(region, record);
    return record;
  }

  private async itemsFor(region: string, tableName: string): Promise<ItemTable> {
    const table = this.ctx.store.table(`dynamodb/${region}/${tableName}/items`);
    await table.hydrate();
    return table;
  }

  private expressionContext(input: Record<string, unknown>): ExpressionContext {
    return {
      names: input.ExpressionAttributeNames as Record<string, string> | undefined,
      values: input.ExpressionAttributeValues as AttributeMap | undefined,
    };
  }

  private readReturnValues(raw: unknown, allowed: string[]): string {
    const returnValues = raw === undefined ? 'NONE' : String(raw);
    if (!allowed.includes(returnValues)) throw validationError('Return values set to invalid value');
    return returnValues;
  }

  private checkCondition(input: Record<string, unknown>, ctx: ExpressionContext, old: AttributeMap | undefined): void {
    if (typeof input.ConditionExpression !== 'string') return;
    const condition = compileCondition(input.ConditionExpression, ctx);
    if (condition.evaluate(old ?? {})) return;
    const withOld = input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD' && old !== undefined;
    throw new AwsError('ConditionalCheckFailedException', 'The conditional request failed', {
      typeName: `${DYNAMO_NS}#ConditionalCheckFailedException`,
      extra: withOld ? { Item: structuredClone(old) } : undefined,
    });
  }

  private addConsumedCapacity(response: Record<string, unknown>, input: Record<string, unknown>, tableName: string): void {
    const mode = input.ReturnConsumedCapacity;
    if (mode === 'TOTAL' || mode === 'INDEXES') {
      response.ConsumedCapacity = { TableName: tableName, CapacityUnits: 0 };
    }
  }

  // -- TTL laziness ----------------------------------------------------------

  private isExpired(record: TableRecord, item: AttributeMap): boolean {
    const ttl = record.ttl;
    if (!ttl?.enabled) return false;
    const raw = item[ttl.attributeName]?.N;
    if (raw === undefined) return false;
    const epoch = Number(raw);
    return Number.isFinite(epoch) && epoch < Date.now() / 1000;
  }

  private removeExpired(region: string, record: TableRecord, items: ItemTable, key: string, item: AttributeMap): void {
    items.delete(key);
    this.streams.append(region, record.tableName, {
      eventName: 'REMOVE',
      keys: keyMapOf(record, item),
      oldImage: structuredClone(item),
      userIdentity: TTL_USER_IDENTITY,
    });
  }

  // Single-item read path: expired items are invisible and physically removed.
  private liveItem(region: string, record: TableRecord, items: ItemTable, key: string): AttributeMap | undefined {
    const item = items.get(key) as AttributeMap | undefined;
    if (!item) return undefined;
    if (this.isExpired(record, item)) {
      this.removeExpired(region, record, items, key, item);
      return undefined;
    }
    return item;
  }

  // Multi-item read path (Query/Scan): purges expired items opportunistically
  // and returns the live ones in the store's insertion order.
  private collectLive(region: string, record: TableRecord, items: ItemTable): AttributeMap[] {
    const live: AttributeMap[] = [];
    const expired: Array<[string, AttributeMap]> = [];
    for (const [key, value] of items.entries()) {
      const item = value as AttributeMap;
      if (this.isExpired(record, item)) expired.push([key, item]);
      else live.push(item);
    }
    for (const [key, item] of expired) this.removeExpired(region, record, items, key, item);
    return live;
  }

  // -- control plane ----------------------------------------------------------

  private async createTable(region: string, input: Record<string, unknown>): Promise<object> {
    const record = buildTableRecord(input);
    const catalog = await this.catalogFor(region);
    if (catalog.get(record.tableName)) {
      throw dynamoError('ResourceInUseException', `Table already exists: ${record.tableName}`);
    }
    catalog.set(record.tableName, record);
    this.streams.ensureRegistered(region, record);
    const items = await this.itemsFor(region, record.tableName);
    return { TableDescription: this.tableDescription(region, record, items) };
  }

  private async describeTable(region: string, input: Record<string, unknown>): Promise<object> {
    const record = await this.requireTable(region, input.TableName, 'named');
    const items = await this.itemsFor(region, record.tableName);
    return { Table: this.tableDescription(region, record, items) };
  }

  private async deleteTable(region: string, input: Record<string, unknown>): Promise<object> {
    const record = await this.requireTable(region, input.TableName, 'named');
    const items = this.ctx.store.table(`dynamodb/${region}/${record.tableName}/items`);
    await items.destroy();
    this.streams.unregister(region, record.tableName);
    const catalog = await this.catalogFor(region);
    catalog.delete(record.tableName);
    return {
      TableDescription: {
        TableName: record.tableName,
        TableStatus: 'DELETING',
        TableArn: tableArnFor(this.ctx.config.account, region, record.tableName),
        TableId: record.tableId,
      },
    };
  }

  private async listTables(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const names = catalog.keys().sort();
    const after = input.ExclusiveStartTableName;
    let start = 0;
    if (typeof after === 'string') {
      start = names.findIndex((name) => name > after);
      if (start === -1) return { TableNames: [] };
    }
    const limit = typeof input.Limit === 'number' ? input.Limit : DEFAULT_LIST_TABLES_LIMIT;
    const page = names.slice(start, start + limit);
    const response: Record<string, unknown> = { TableNames: page };
    if (start + limit < names.length && page.length > 0) {
      response.LastEvaluatedTableName = page[page.length - 1];
    }
    return response;
  }

  private async updateTimeToLive(region: string, input: Record<string, unknown>): Promise<object> {
    const spec = input.TimeToLiveSpecification as { AttributeName?: unknown; Enabled?: unknown } | undefined;
    if (!spec || typeof spec.AttributeName !== 'string' || spec.AttributeName.length === 0 || typeof spec.Enabled !== 'boolean') {
      throw validationError('One or more parameter values were invalid: TimeToLiveSpecification is malformed');
    }
    const record = await this.requireTable(region, input.TableName, 'named');
    const currentlyEnabled = record.ttl?.enabled === true;
    if (spec.Enabled && currentlyEnabled) throw validationError('TimeToLive is already enabled');
    if (!spec.Enabled && !currentlyEnabled) throw validationError('TimeToLive is already disabled');
    record.ttl = { attributeName: spec.AttributeName, enabled: spec.Enabled };
    (await this.catalogFor(region)).set(record.tableName, record);
    return { TimeToLiveSpecification: { AttributeName: spec.AttributeName, Enabled: spec.Enabled } };
  }

  private async describeTimeToLive(region: string, input: Record<string, unknown>): Promise<object> {
    const record = await this.requireTable(region, input.TableName, 'named');
    const description: Record<string, unknown> = record.ttl?.enabled
      ? { TimeToLiveStatus: 'ENABLED', AttributeName: record.ttl.attributeName }
      : { TimeToLiveStatus: 'DISABLED' };
    return { TimeToLiveDescription: description };
  }

  // Full introspection shape ORMs read; stream fields present immediately so
  // the provisioner's DescribeTable retry for LatestStreamArn passes on try 1.
  private tableDescription(region: string, record: TableRecord, items: ItemTable): Record<string, unknown> {
    const account = this.ctx.config.account;
    const arn = tableArnFor(account, region, record.tableName);
    let tableSizeBytes = 0;
    let itemCount = 0;
    const indexStats = new Map<string, { count: number; size: number }>();
    const allIndexes = [...record.globalSecondaryIndexes, ...record.localSecondaryIndexes];
    for (const index of allIndexes) indexStats.set(index.indexName, { count: 0, size: 0 });
    for (const [, value] of items.entries()) {
      const item = value as AttributeMap;
      const size = itemSizeBytes(item);
      tableSizeBytes += size;
      itemCount++;
      for (const index of allIndexes) {
        if (indexHasItem(record, index, item)) {
          const stats = indexStats.get(index.indexName)!;
          stats.count++;
          stats.size += size;
        }
      }
    }
    const epochSeconds = record.createdAtMs / 1000;
    const provisionedThroughput = {
      NumberOfDecreasesToday: 0,
      ReadCapacityUnits: record.readCapacityUnits,
      WriteCapacityUnits: record.writeCapacityUnits,
    };
    const description: Record<string, unknown> = {
      TableName: record.tableName,
      AttributeDefinitions: record.attributeDefinitions,
      KeySchema: record.keySchema,
      TableStatus: 'ACTIVE',
      CreationDateTime: epochSeconds,
      ProvisionedThroughput: provisionedThroughput,
      TableSizeBytes: tableSizeBytes,
      ItemCount: itemCount,
      TableArn: arn,
      TableId: record.tableId,
      DeletionProtectionEnabled: false,
    };
    if (record.billingMode === 'PAY_PER_REQUEST') {
      description.BillingModeSummary = {
        BillingMode: 'PAY_PER_REQUEST',
        LastUpdateToPayPerRequestDateTime: epochSeconds,
      };
    }
    if (record.globalSecondaryIndexes.length > 0) {
      description.GlobalSecondaryIndexes = record.globalSecondaryIndexes.map((index) => ({
        IndexName: index.indexName,
        KeySchema: index.keySchema,
        Projection: index.projection,
        IndexStatus: 'ACTIVE',
        IndexArn: `${arn}/index/${index.indexName}`,
        ItemCount: indexStats.get(index.indexName)!.count,
        IndexSizeBytes: indexStats.get(index.indexName)!.size,
        ProvisionedThroughput: provisionedThroughput,
      }));
    }
    if (record.localSecondaryIndexes.length > 0) {
      description.LocalSecondaryIndexes = record.localSecondaryIndexes.map((index) => ({
        IndexName: index.indexName,
        KeySchema: index.keySchema,
        Projection: index.projection,
        IndexArn: `${arn}/index/${index.indexName}`,
        ItemCount: indexStats.get(index.indexName)!.count,
        IndexSizeBytes: indexStats.get(index.indexName)!.size,
      }));
    }
    if (record.streamSpecification?.StreamEnabled) {
      description.StreamSpecification = record.streamSpecification;
      description.LatestStreamLabel = record.latestStreamLabel;
      description.LatestStreamArn = streamArnFor(account, region, record);
    }
    return description;
  }

  // -- item CRUD ---------------------------------------------------------------

  private async putItem(region: string, input: Record<string, unknown>): Promise<object> {
    rejectLegacyParams(input, ['Expected', 'ConditionalOperator']);
    const record = await this.requireTable(region, input.TableName);
    const item = input.Item as AttributeMap | undefined;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw validationError('One or more parameter values were invalid: Item is required');
    }
    validateItemKey(record, item);
    assertItemSize(item);
    const returnValues = this.readReturnValues(input.ReturnValues, ['NONE', 'ALL_OLD']);
    const ctx = this.expressionContext(input);
    assertPlaceholdersUsed([input.ConditionExpression as string | undefined], ctx);
    const items = await this.itemsFor(region, record.tableName);
    const key = canonicalKey(record, item);
    const old = items.get(key) as AttributeMap | undefined;
    this.checkCondition(input, ctx, old);
    const stored = structuredClone(item);
    items.put(key, stored);
    this.streams.append(region, record.tableName, {
      eventName: old ? 'MODIFY' : 'INSERT',
      keys: keyMapOf(record, stored),
      oldImage: old,
      newImage: stored,
    });
    const response: Record<string, unknown> = {};
    if (returnValues === 'ALL_OLD' && old) response.Attributes = structuredClone(old);
    this.addConsumedCapacity(response, input, record.tableName);
    return response;
  }

  private async getItem(region: string, input: Record<string, unknown>): Promise<object> {
    rejectLegacyParams(input, ['AttributesToGet']);
    const record = await this.requireTable(region, input.TableName);
    const keyInput = validateProvidedKey(record, input.Key);
    const ctx = this.expressionContext(input);
    assertPlaceholdersUsed([input.ProjectionExpression as string | undefined], ctx);
    const items = await this.itemsFor(region, record.tableName);
    const item = this.liveItem(region, record, items, canonicalKey(record, keyInput));
    const response: Record<string, unknown> = {};
    if (item) {
      const clone = structuredClone(item);
      response.Item = typeof input.ProjectionExpression === 'string'
        ? applyProjection(input.ProjectionExpression, clone, ctx)
        : clone;
    }
    this.addConsumedCapacity(response, input, record.tableName);
    return response;
  }

  private async deleteItem(region: string, input: Record<string, unknown>): Promise<object> {
    rejectLegacyParams(input, ['Expected', 'ConditionalOperator']);
    const record = await this.requireTable(region, input.TableName);
    const keyInput = validateProvidedKey(record, input.Key);
    const returnValues = this.readReturnValues(input.ReturnValues, ['NONE', 'ALL_OLD']);
    const ctx = this.expressionContext(input);
    assertPlaceholdersUsed([input.ConditionExpression as string | undefined], ctx);
    const items = await this.itemsFor(region, record.tableName);
    const key = canonicalKey(record, keyInput);
    const old = items.get(key) as AttributeMap | undefined;
    this.checkCondition(input, ctx, old);
    if (old) {
      items.delete(key);
      this.streams.append(region, record.tableName, {
        eventName: 'REMOVE',
        keys: keyMapOf(record, old),
        oldImage: old,
      });
    }
    const response: Record<string, unknown> = {};
    if (returnValues === 'ALL_OLD' && old) response.Attributes = structuredClone(old);
    this.addConsumedCapacity(response, input, record.tableName);
    return response;
  }

  private async updateItem(region: string, input: Record<string, unknown>): Promise<object> {
    rejectLegacyParams(input, ['AttributeUpdates', 'Expected', 'ConditionalOperator']);
    const record = await this.requireTable(region, input.TableName);
    const keyInput = validateProvidedKey(record, input.Key);
    const returnValues = this.readReturnValues(
      input.ReturnValues,
      ['NONE', 'ALL_OLD', 'ALL_NEW', 'UPDATED_OLD', 'UPDATED_NEW'],
    );
    const ctx = this.expressionContext(input);
    assertPlaceholdersUsed(
      [input.UpdateExpression as string | undefined, input.ConditionExpression as string | undefined],
      ctx,
    );
    const items = await this.itemsFor(region, record.tableName);
    const key = canonicalKey(record, keyInput);
    const old = items.get(key) as AttributeMap | undefined;
    this.checkCondition(input, ctx, old);

    // AWS semantics: updating a missing item creates it — key attrs merged in.
    const base = old ?? (structuredClone(keyInput) as AttributeMap);
    let updated: AttributeMap;
    let touched: string[] = [];
    if (typeof input.UpdateExpression === 'string') {
      updated = applyUpdate(input.UpdateExpression, base, ctx);
      touched = this.topLevelUpdatedNames(input.UpdateExpression, ctx);
    } else {
      updated = structuredClone(base);
    }
    this.assertKeyUnchanged(record, updated, keyInput);
    assertItemSize(updated);
    items.put(key, updated);
    this.streams.append(region, record.tableName, {
      eventName: old ? 'MODIFY' : 'INSERT',
      keys: keyMapOf(record, updated),
      oldImage: old,
      newImage: updated,
    });

    const response: Record<string, unknown> = {};
    const pick = (source: AttributeMap, names: string[]): AttributeMap => {
      const out: AttributeMap = {};
      for (const name of names) {
        if (source[name] !== undefined) out[name] = structuredClone(source[name]);
      }
      return out;
    };
    if (returnValues === 'ALL_NEW') response.Attributes = structuredClone(updated);
    else if (returnValues === 'ALL_OLD' && old) response.Attributes = structuredClone(old);
    else if (returnValues === 'UPDATED_NEW') response.Attributes = pick(updated, touched);
    else if (returnValues === 'UPDATED_OLD' && old) response.Attributes = pick(old, touched);
    this.addConsumedCapacity(response, input, record.tableName);
    return response;
  }

  private assertKeyUnchanged(record: TableRecord, updated: AttributeMap, keyInput: AttributeMap): void {
    for (const { AttributeName } of record.keySchema) {
      if (updated[AttributeName] === undefined || !attributeValuesEqual(updated[AttributeName], keyInput[AttributeName]!)) {
        throw validationError(
          `One or more parameter values were invalid: Cannot update attribute ${AttributeName}. This attribute is part of the key`,
        );
      }
    }
  }

  // Top-level attribute names touched by an UpdateExpression — the granularity
  // AWS's UPDATED_OLD/UPDATED_NEW return values are keyed by.
  private topLevelUpdatedNames(expression: string, ctx: ExpressionContext): string[] {
    const parsed = parseUpdateExpression(expression, ctx);
    const names = new Set<string>();
    const paths = [
      ...parsed.sets.map((a) => a.path),
      ...parsed.removes,
      ...parsed.adds.map((a) => a.path),
      ...parsed.deletes.map((a) => a.path),
    ];
    for (const path of paths) {
      const first = path[0];
      if ('attr' in first) names.add(first.attr);
    }
    return [...names];
  }

  // -- query / scan --------------------------------------------------------------

  private async query(region: string, input: Record<string, unknown>): Promise<object> {
    rejectLegacyParams(input, ['KeyConditions', 'QueryFilter', 'ConditionalOperator', 'AttributesToGet']);
    return this.page(region, input, executeQuery);
  }

  private async scan(region: string, input: Record<string, unknown>): Promise<object> {
    rejectLegacyParams(input, ['ScanFilter', 'ConditionalOperator', 'AttributesToGet']);
    return this.page(region, input, executeScan);
  }

  private async page(
    region: string,
    input: Record<string, unknown>,
    execute: (table: TableRecord, items: AttributeMap[], input: Record<string, unknown>) => PageResult,
  ): Promise<object> {
    const record = await this.requireTable(region, input.TableName);
    const items = await this.itemsFor(region, record.tableName);
    const live = this.collectLive(region, record, items);
    const result = execute(record, live, input);
    const response: Record<string, unknown> = { Count: result.count, ScannedCount: result.scannedCount };
    if (result.items) response.Items = result.items;
    if (result.lastEvaluatedKey) response.LastEvaluatedKey = result.lastEvaluatedKey;
    this.addConsumedCapacity(response, input, record.tableName);
    return response;
  }

  // -- batch ops -------------------------------------------------------------------

  private async batchGetItem(region: string, input: Record<string, unknown>): Promise<object> {
    const request = input.RequestItems as Record<string, BatchGetTableSpec> | undefined;
    if (!request || typeof request !== 'object' || Object.keys(request).length === 0) {
      throw validationError('One or more parameter values were invalid: RequestItems must not be empty');
    }
    const totalKeys = Object.values(request).reduce((sum, spec) => sum + (spec.Keys?.length ?? 0), 0);
    if (totalKeys > MAX_BATCH_GET_KEYS) {
      throw validationError('Too many items requested for the BatchGetItem call');
    }
    const responses: Record<string, AttributeMap[]> = {};
    for (const [tableName, spec] of Object.entries(request)) {
      const record = await this.requireTable(region, tableName);
      const items = await this.itemsFor(region, tableName);
      const ctx: ExpressionContext = { names: spec.ExpressionAttributeNames };
      assertPlaceholdersUsed([spec.ProjectionExpression], ctx);
      const found: AttributeMap[] = [];
      for (const keyInput of spec.Keys ?? []) {
        validateProvidedKey(record, keyInput);
        const item = this.liveItem(region, record, items, canonicalKey(record, keyInput));
        if (!item) continue;
        const clone = structuredClone(item);
        found.push(spec.ProjectionExpression ? applyProjection(spec.ProjectionExpression, clone, ctx) : clone);
      }
      responses[tableName] = found;
    }
    return { Responses: responses, UnprocessedKeys: {} };
  }

  private async batchWriteItem(region: string, input: Record<string, unknown>): Promise<object> {
    const request = input.RequestItems as Record<string, BatchWriteEntry[]> | undefined;
    if (!request || typeof request !== 'object' || Object.keys(request).length === 0) {
      throw validationError('One or more parameter values were invalid: RequestItems must not be empty');
    }
    const total = Object.values(request).reduce((sum, entries) => sum + entries.length, 0);
    if (total > MAX_BATCH_WRITE_ITEMS) {
      throw validationError('Too many items requested for the BatchWriteItem call');
    }
    for (const [tableName, entries] of Object.entries(request)) {
      const record = await this.requireTable(region, tableName);
      const items = await this.itemsFor(region, tableName);
      for (const entry of entries) {
        if (entry.PutRequest) {
          const item = entry.PutRequest.Item;
          if (!item) throw validationError('One or more parameter values were invalid: PutRequest must carry an Item');
          validateItemKey(record, item);
          assertItemSize(item);
          const key = canonicalKey(record, item);
          const old = items.get(key) as AttributeMap | undefined;
          const stored = structuredClone(item);
          items.put(key, stored);
          this.streams.append(region, tableName, {
            eventName: old ? 'MODIFY' : 'INSERT',
            keys: keyMapOf(record, stored),
            oldImage: old,
            newImage: stored,
          });
        } else if (entry.DeleteRequest) {
          const keyInput = validateProvidedKey(record, entry.DeleteRequest.Key);
          const key = canonicalKey(record, keyInput);
          const old = items.get(key) as AttributeMap | undefined;
          if (old) {
            items.delete(key);
            this.streams.append(region, tableName, { eventName: 'REMOVE', keys: keyMapOf(record, old), oldImage: old });
          }
        } else {
          throw validationError('One or more parameter values were invalid: A request entry must carry a PutRequest or a DeleteRequest');
        }
      }
    }
    return { UnprocessedItems: {} };
  }

  // -- transactions ----------------------------------------------------------------

  // The prepare loop awaits table/item hydration, which lets the store's
  // memory-budget sweeper dehydrate a table hydrated earlier in the same
  // request. The evaluate/commit phases must run synchronously against
  // hydrated tables, so loop until one pass finds everything resident.
  private async ensureHydrated(tables: ItemTable[]): Promise<void> {
    for (let pass = 0; pass < 10 && tables.some((table) => !table.isHydrated()); pass++) {
      for (const table of tables) {
        if (!table.isHydrated()) await table.hydrate();
      }
    }
  }

  private transactDuplicateGuard(): (record: TableRecord, canonical: string) => void {
    const seen = new Set<string>();
    return (record, canonical) => {
      const target = JSON.stringify([record.tableName, canonical]);
      if (seen.has(target)) {
        throw validationError('Transaction request cannot include multiple operations on one item');
      }
      seen.add(target);
    };
  }

  private transactConsumedCapacity(response: Record<string, unknown>, input: Record<string, unknown>, tableNames: string[]): void {
    const mode = input.ReturnConsumedCapacity;
    if (mode === 'TOTAL' || mode === 'INDEXES') {
      response.ConsumedCapacity = [...new Set(tableNames)]
        .map((tableName) => ({ TableName: tableName, CapacityUnits: 0 }));
    }
  }

  private async transactWriteItems(region: string, input: Record<string, unknown>): Promise<object> {
    const ops = parseTransactWriteItems(input);

    const token = input.ClientRequestToken;
    if (token !== undefined && (typeof token !== 'string' || token.length === 0 || token.length > 36)) {
      throw validationError('ClientRequestToken must be a non-empty string with a maximum length of 36');
    }
    // Idempotency is namespaced per region — DynamoDB is a regional service,
    // and one emulator instance serves every region.
    const tokenKey = typeof token === 'string' ? JSON.stringify([region, token]) : undefined;
    if (tokenKey !== undefined) {
      const replay = this.transactTokens.begin(tokenKey, JSON.stringify(input.TransactItems), {
        mismatch: () => dynamoError(
          'IdempotentParameterMismatchException',
          'Request with the same client token already completed with different parameters',
        ),
        inProgress: () => dynamoError(
          'TransactionInProgressException',
          'The transaction with the given request token is currently in progress',
        ),
      });
      if (replay) return replay;
    }
    try {
      const response = await this.executeTransactWrite(region, input, ops);
      if (tokenKey !== undefined) this.transactTokens.complete(tokenKey, response);
      return response;
    } catch (err) {
      // Failed transactions are not idempotency-cached — a retry re-executes.
      if (tokenKey !== undefined) this.transactTokens.abandon(tokenKey);
      throw err;
    }
  }

  // All-or-nothing (PRD RF3): conditions AND the update computations are
  // evaluated against current state first — in one synchronous block, so no
  // other request interleaves between the checks and the writes — and any
  // failure cancels the whole request with per-item CancellationReasons (the
  // shape clients inspect to map "condition failed on entry N" to domain
  // errors like duplicate e-mail). Only a fully clean pass applies the
  // writes — each one emitting its stream record.
  private async executeTransactWrite(
    region: string,
    input: Record<string, unknown>,
    ops: TransactWriteOp[],
  ): Promise<object> {
    interface PreparedOp {
      op: TransactWriteOp;
      record: TableRecord;
      items: ItemTable;
      canonical: string;
      keyInput: AttributeMap;
      old?: AttributeMap;
      stored?: AttributeMap;
    }
    const guardDuplicate = this.transactDuplicateGuard();
    const prepared: PreparedOp[] = [];
    for (const op of ops) {
      const record = await this.requireTable(region, op.tableName);
      const items = await this.itemsFor(region, record.tableName);
      let keyInput: AttributeMap;
      if (op.kind === 'Put') {
        validateItemKey(record, op.item!);
        assertItemSize(op.item!);
        keyInput = keyMapOf(record, op.item!);
      } else {
        keyInput = validateProvidedKey(record, op.key);
      }
      assertPlaceholdersUsed([op.updateExpression, op.conditionExpression], op.ctx);
      // Statically invalid updates reject the request up front (AWS
      // behavior): syntax/placeholder errors and expressions that touch a
      // key attribute. Runtime apply failures cancel the transaction below.
      if (op.kind === 'Update') {
        const touched = this.topLevelUpdatedNames(op.updateExpression!, op.ctx);
        for (const { AttributeName } of record.keySchema) {
          if (touched.includes(AttributeName)) {
            throw validationError(
              `One or more parameter values were invalid: Cannot update attribute ${AttributeName}. This attribute is part of the key`,
            );
          }
        }
      }
      guardDuplicate(record, canonicalKey(record, keyInput));
      prepared.push({ op, record, items, canonical: canonicalKey(record, keyInput), keyInput });
    }
    await this.ensureHydrated(prepared.map((entry) => entry.items));

    const reasons: Array<Record<string, unknown>> = prepared.map((entry) => {
      const { op, record, keyInput } = entry;
      entry.old = this.liveItem(region, record, entry.items, entry.canonical);
      if (op.conditionExpression) {
        const passed = compileCondition(op.conditionExpression, op.ctx).evaluate(entry.old ?? {});
        if (!passed) {
          const reason: Record<string, unknown> = { Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' };
          if (op.returnOldOnFail && entry.old) reason.Item = structuredClone(entry.old);
          return reason;
        }
      }
      if (op.kind === 'Put') {
        entry.stored = structuredClone(op.item!);
      } else if (op.kind === 'Update') {
        // Dry-run the update NOW so a failing op cancels the transaction
        // (AWS reports it as a ValidationError cancellation reason) instead
        // of surfacing after earlier ops were already written.
        try {
          const base = entry.old ?? (structuredClone(keyInput) as AttributeMap);
          const stored = applyUpdate(op.updateExpression!, base, op.ctx);
          this.assertKeyUnchanged(record, stored, keyInput);
          assertItemSize(stored);
          entry.stored = stored;
        } catch (err) {
          if (err instanceof AwsError && err.code === 'ValidationException') {
            return { Code: 'ValidationError', Message: err.message };
          }
          throw err;
        }
      }
      return { Code: 'None', Message: null };
    });
    if (reasons.some((reason) => reason.Code !== 'None')) {
      throw new AwsError(
        'TransactionCanceledException',
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((r) => r.Code).join(', ')}]`,
        {
          typeName: `${DYNAMO_NS}#TransactionCanceledException`,
          extra: { CancellationReasons: reasons },
        },
      );
    }

    for (const { op, record, items, canonical, old, stored } of prepared) {
      if (op.kind === 'ConditionCheck') continue;
      if (op.kind === 'Delete') {
        if (old) {
          items.delete(canonical);
          this.streams.append(region, record.tableName, {
            eventName: 'REMOVE',
            keys: keyMapOf(record, old),
            oldImage: old,
          });
        }
        continue;
      }
      items.put(canonical, stored!);
      this.streams.append(region, record.tableName, {
        eventName: old ? 'MODIFY' : 'INSERT',
        keys: keyMapOf(record, stored!),
        oldImage: old,
        newImage: stored,
      });
    }

    const response: Record<string, unknown> = {};
    this.transactConsumedCapacity(response, input, prepared.map((entry) => entry.record.tableName));
    return response;
  }

  private async transactGetItems(region: string, input: Record<string, unknown>): Promise<object> {
    const gets = parseTransactGetItems(input);
    interface PreparedGet {
      get: TransactGetOp;
      record: TableRecord;
      items: ItemTable;
      canonical: string;
    }
    const guardDuplicate = this.transactDuplicateGuard();
    const prepared: PreparedGet[] = [];
    for (const get of gets) {
      const record = await this.requireTable(region, get.tableName);
      const items = await this.itemsFor(region, record.tableName);
      const keyInput = validateProvidedKey(record, get.key);
      assertPlaceholdersUsed([get.projectionExpression], get.ctx);
      const canonical = canonicalKey(record, keyInput);
      guardDuplicate(record, canonical);
      prepared.push({ get, record, items, canonical });
    }
    await this.ensureHydrated(prepared.map((entry) => entry.items));

    // One synchronous pass — the reads are a consistent snapshot, matching
    // the operation's serializable-isolation contract.
    const responses = prepared.map(({ get, record, items, canonical }): Record<string, unknown> => {
      const item = this.liveItem(region, record, items, canonical);
      if (!item) return {};
      const clone = structuredClone(item);
      return {
        Item: get.projectionExpression ? applyProjection(get.projectionExpression, clone, get.ctx) : clone,
      };
    });
    const response: Record<string, unknown> = { Responses: responses };
    this.transactConsumedCapacity(response, input, prepared.map((entry) => entry.record.tableName));
    return response;
  }
}
