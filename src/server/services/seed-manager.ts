import fs from 'fs';
import path from 'path';
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  BatchWriteItemCommand,
  ScanCommand,
  type WriteRequest,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { LocalStackManager } from './localstack-manager.js';
import { ConfigManager } from './config-manager.js';

const BATCH_LIMIT = 25;

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

export class SeedManager {
  private static instance: SeedManager;
  private dynamoClient!: DynamoDBClient;
  private currentRegion: string = 'us-east-1';

  private constructor() {
    this.initializeClient(this.currentRegion);
  }

  static getInstance(): SeedManager {
    if (!SeedManager.instance) {
      SeedManager.instance = new SeedManager();
    }
    return SeedManager.instance;
  }

  private initializeClient(region: string): void {
    const baseConfig = LocalStackManager.getInstance().getConfig();
    this.dynamoClient = new DynamoDBClient({ ...baseConfig, region });
    this.currentRegion = region;
  }

  setRegion(region: string): void {
    if (region && region !== this.currentRegion) {
      this.initializeClient(region);
    }
  }

  private getSeedsDir(): string {
    return ConfigManager.getInstance().getSeedsDir();
  }

  private seedFilePath(tableName: string): string {
    return path.join(this.getSeedsDir(), `${tableName}.json`);
  }

  private readSeedFile(tableName: string): unknown[] | null {
    const file = this.seedFilePath(tableName);
    if (!fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('seed file must contain a JSON array of items');
      }
      return parsed;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`Failed to read seed file ${file}: ${msg}`);
    }
  }

  hasSeedFile(tableName: string): boolean {
    return fs.existsSync(this.seedFilePath(tableName));
  }

  async list(): Promise<SeedFileEntry[]> {
    const dir = this.getSeedsDir();
    if (!fs.existsSync(dir)) return [];

    const liveTables = new Set(await this.listTables());
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    return files.map(file => {
      const tableName = file.slice(0, -5);
      let itemCount = 0;
      try {
        const items = this.readSeedFile(tableName);
        itemCount = items?.length ?? 0;
      } catch {
        itemCount = -1;
      }
      return {
        tableName,
        file: path.join(dir, file),
        itemCount,
        tableExists: liveTables.has(tableName),
      };
    });
  }

  async seedTable(tableName: string): Promise<SeedResult> {
    const items = this.readSeedFile(tableName);
    if (items === null) {
      return { tableName, inserted: 0, skipped: true, reason: 'no seed file' };
    }
    if (items.length === 0) {
      return { tableName, inserted: 0, skipped: true, reason: 'empty seed file' };
    }

    const requests: WriteRequest[] = items.map((item, idx) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Item at index ${idx} in ${tableName}.json is not a plain object`);
      }
      return {
        PutRequest: {
          Item: marshall(item as Record<string, unknown>, {
            removeUndefinedValues: true,
            convertClassInstanceToMap: true,
          }) as Record<string, AttributeValue>,
        },
      };
    });

    let inserted = 0;
    for (let i = 0; i < requests.length; i += BATCH_LIMIT) {
      const chunk = requests.slice(i, i + BATCH_LIMIT);
      await this.writeBatchWithRetry(tableName, chunk);
      inserted += chunk.length;
    }

    console.log(`  ✓ Seeded ${inserted} item(s) into ${tableName}`);
    return { tableName, inserted };
  }

  async seedAll(): Promise<SeedResult[]> {
    const entries = await this.list();
    const results = await Promise.all(
      entries.map(async entry => {
        if (!entry.tableExists) {
          return {
            tableName: entry.tableName,
            inserted: 0,
            skipped: true,
            reason: 'table does not exist in LocalStack',
          } as SeedResult;
        }
        try {
          return await this.seedTable(entry.tableName);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'unknown error';
          console.warn(`[seed] ${entry.tableName}: ${msg}`);
          return { tableName: entry.tableName, inserted: 0, skipped: true, reason: msg };
        }
      }),
    );
    return results;
  }

  async clearTable(tableName: string): Promise<ClearResult> {
    const keyAttrs = await this.getTableKeyAttributes(tableName);
    if (!keyAttrs) {
      return { tableName, deleted: 0, skipped: true, reason: 'table not found' };
    }

    let deleted = 0;
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
      const scan = await this.dynamoClient.send(
        new ScanCommand({
          TableName: tableName,
          ProjectionExpression: keyAttrs.map((_, i) => `#k${i}`).join(', '),
          ExpressionAttributeNames: Object.fromEntries(
            keyAttrs.map((attr, i) => [`#k${i}`, attr]),
          ),
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      const items = scan.Items ?? [];
      for (let i = 0; i < items.length; i += BATCH_LIMIT) {
        const chunk = items.slice(i, i + BATCH_LIMIT).map(item => {
          const key: Record<string, AttributeValue> = {};
          for (const attr of keyAttrs) {
            if (item[attr] !== undefined) key[attr] = item[attr];
          }
          return { DeleteRequest: { Key: key } } as WriteRequest;
        });
        await this.writeBatchWithRetry(tableName, chunk);
        deleted += chunk.length;
      }

      exclusiveStartKey = scan.LastEvaluatedKey;
    } while (exclusiveStartKey);

    console.log(`  ✓ Cleared ${deleted} item(s) from ${tableName}`);
    return { tableName, deleted };
  }

  async clearAllSeeded(): Promise<ClearResult[]> {
    const entries = await this.list();
    const results: ClearResult[] = [];
    for (const entry of entries) {
      if (!entry.tableExists) {
        results.push({
          tableName: entry.tableName,
          deleted: 0,
          skipped: true,
          reason: 'table does not exist in LocalStack',
        });
        continue;
      }
      try {
        results.push(await this.clearTable(entry.tableName));
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        console.warn(`[seed:clear] ${entry.tableName}: ${msg}`);
        results.push({ tableName: entry.tableName, deleted: 0, skipped: true, reason: msg });
      }
    }
    return results;
  }

  /**
   * Background fire-and-forget seeding triggered when a table is provisioned.
   * Never throws — logs warnings instead so it cannot break the provisioner.
   */
  seedOnTableCreated(tableName: string): void {
    if (!this.hasSeedFile(tableName)) return;
    this.seedTable(tableName).catch(error => {
      const msg = error instanceof Error ? error.message : 'unknown error';
      console.warn(`[seed] auto-seed for ${tableName} failed: ${msg}`);
    });
  }

  private async listTables(): Promise<string[]> {
    try {
      const res = await this.dynamoClient.send(new ListTablesCommand({}));
      return res.TableNames ?? [];
    } catch {
      return [];
    }
  }

  private async getTableKeyAttributes(tableName: string): Promise<string[] | null> {
    try {
      const res = await this.dynamoClient.send(
        new DescribeTableCommand({ TableName: tableName }),
      );
      const keys = res.Table?.KeySchema?.map(k => k.AttributeName!).filter(Boolean) ?? [];
      return keys.length > 0 ? keys : null;
    } catch {
      return null;
    }
  }

  // BatchWriteItem returns UnprocessedItems on throttling/partial failures.
  // Retry them with exponential backoff so we don't silently drop writes.
  private async writeBatchWithRetry(tableName: string, requests: WriteRequest[]): Promise<void> {
    let pending = requests;
    let attempt = 0;
    while (pending.length > 0) {
      const res = await this.dynamoClient.send(
        new BatchWriteItemCommand({ RequestItems: { [tableName]: pending } }),
      );
      const unprocessed = res.UnprocessedItems?.[tableName] ?? [];
      if (unprocessed.length === 0) return;
      attempt++;
      if (attempt > 5) {
        throw new Error(
          `BatchWriteItem left ${unprocessed.length} unprocessed item(s) after 5 retries`,
        );
      }
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
      pending = unprocessed;
    }
  }
}
