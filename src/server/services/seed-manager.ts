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
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { EngineManager } from '../engine/engine-manager.js';
import { ConfigManager } from './config-manager.js';
import { normalizeSecretSeed, resolveGeneratedSecretString, type SecretSeedValue } from './secret-value.js';

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
  private clients = new Map<string, DynamoDBClient>();
  private secretsClients = new Map<string, SecretsManagerClient>();
  private defaultRegion: string = 'us-east-1';

  private constructor() {}

  static getInstance(): SeedManager {
    if (!SeedManager.instance) {
      SeedManager.instance = new SeedManager();
    }
    return SeedManager.instance;
  }

  setDefaultRegion(region: string): void {
    if (region) this.defaultRegion = region;
  }

  // Kept for backwards compatibility with ResourceProvisioner.setRegion calls.
  setRegion(region: string): void {
    this.setDefaultRegion(region);
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

  // Per-region Secrets Manager client, built like clientFor / SecretsExplorer so
  // it targets the active engine (self or LocalStack).
  private secretsClientFor(region?: string): SecretsManagerClient {
    const r = region || this.defaultRegion;
    let client = this.secretsClients.get(r);
    if (!client) {
      const baseConfig = EngineManager.getInstance().getConfig();
      client = new SecretsManagerClient({ ...baseConfig, region: r });
      this.secretsClients.set(r, client);
    }
    return client;
  }

  // Defensive guard against destructive ops ever hitting a non-local endpoint.
  // The architecture already pins us to the local engine, but
  // `clearTable`/`clearAllSeeded` are explicit deletes — verify the endpoint
  // hostname every time and refuse anything that isn't loopback/local before
  // issuing a DeleteRequest.
  private assertLocalEndpoint(): void {
    const endpoint = EngineManager.getInstance().getEndpoint();
    let hostname: string;
    try {
      hostname = new URL(endpoint).hostname.toLowerCase();
      // URL.hostname wraps IPv6 in brackets (e.g. "[::1]"). Normalize them out
      // so the allowlist matches "::1" directly.
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
      }
    } catch {
      throw new Error(
        `Refusing destructive operation: invalid local engine endpoint "${endpoint}".`,
      );
    }
    // The two `localstack` spellings are kept deliberately: 1.0 removed that
    // backend, but `selfEngine.fallbackEndpoint` can still point at a container
    // reachable under those names, and this list decides what a DELETE may
    // reach — dropping a hostname here is a behaviour change, not a text edit.
    const allowed = new Set([
      'localhost',
      '127.0.0.1',
      '::1',
      '0.0.0.0',
      'host.docker.internal',
      'localstack',
      'lss-localstack',
    ]);
    const isAllowed =
      allowed.has(hostname) ||
      hostname.endsWith('.localhost') ||
      hostname.startsWith('lss-localstack-');
    if (!isAllowed) {
      throw new Error(
        `Refusing destructive operation: endpoint "${endpoint}" is not a recognized local host. ` +
          `seed:clear may ONLY run against the local engine — never against AWS.`,
      );
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

  async listLiveTables(region?: string): Promise<string[]> {
    return this.listTables(region);
  }

  async list(region?: string): Promise<SeedFileEntry[]> {
    const dir = this.getSeedsDir();
    if (!fs.existsSync(dir)) return [];

    const liveTables = new Set(await this.listTables(region));
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

  async seedTable(tableName: string, region?: string): Promise<SeedResult> {
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
      await this.writeBatchWithRetry(tableName, chunk, region);
      inserted += chunk.length;
    }

    console.log(`  ✓ Seeded ${inserted} item(s) into ${tableName}`);
    return { tableName, inserted };
  }

  async seedAll(region?: string): Promise<SeedResult[]> {
    const entries = await this.list(region);
    const results = await Promise.all(
      entries.map(async entry => {
        if (!entry.tableExists) {
          return {
            tableName: entry.tableName,
            inserted: 0,
            skipped: true,
            reason: 'table does not exist in the engine',
          } as SeedResult;
        }
        try {
          return await this.seedTable(entry.tableName, region);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'unknown error';
          console.warn(`[seed] ${entry.tableName}: ${msg}`);
          return { tableName: entry.tableName, inserted: 0, skipped: true, reason: msg };
        }
      }),
    );
    return results;
  }

  async clearTable(tableName: string, region?: string): Promise<ClearResult> {
    this.assertLocalEndpoint();
    const keyAttrs = await this.getTableKeyAttributes(tableName, region);
    if (!keyAttrs) {
      return { tableName, deleted: 0, skipped: true, reason: 'table not found' };
    }

    const client = this.clientFor(region);
    let deleted = 0;
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
      const scan = await client.send(
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
        const chunk = items.slice(i, i + BATCH_LIMIT).map((item: Record<string, AttributeValue>) => {
          const key: Record<string, AttributeValue> = {};
          for (const attr of keyAttrs) {
            if (item[attr] !== undefined) key[attr] = item[attr];
          }
          return { DeleteRequest: { Key: key } } as WriteRequest;
        });
        await this.writeBatchWithRetry(tableName, chunk, region);
        deleted += chunk.length;
      }

      exclusiveStartKey = scan.LastEvaluatedKey;
    } while (exclusiveStartKey);

    console.log(`  ✓ Cleared ${deleted} item(s) from ${tableName}`);
    return { tableName, deleted };
  }

  async clearAllSeeded(region?: string): Promise<ClearResult[]> {
    this.assertLocalEndpoint();
    const entries = await this.list(region);
    const results: ClearResult[] = [];
    for (const entry of entries) {
      if (!entry.tableExists) {
        results.push({
          tableName: entry.tableName,
          deleted: 0,
          skipped: true,
          reason: 'table does not exist in the engine',
        });
        continue;
      }
      try {
        results.push(await this.clearTable(entry.tableName, region));
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
  seedOnTableCreated(tableName: string, region?: string): void {
    if (!this.hasSeedFile(tableName)) return;
    this.seedTable(tableName, region).catch(error => {
      const msg = error instanceof Error ? error.message : 'unknown error';
      console.warn(`[seed] auto-seed for ${tableName} failed: ${msg}`);
    });
  }

  // -- Secrets Manager seeding ----------------------------------------------
  // A boot-time seed path (analogous to table seeding) so a secret EXISTS with
  // an AWSCURRENT version before the first GetSecretValue — even for services
  // that never declare the secret in CFN. Sources: seeds/secrets/<name>.json
  // files AND the config `secrets` map. Applied idempotently and never throwing.

  private getSecretSeedsDir(): string {
    return path.join(this.getSeedsDir(), 'secrets');
  }

  // Recursively collect *.json under seeds/secrets/. A secret name may contain
  // "/" (e.g. billing/receipt-signing-key), so the name is the file's path
  // relative to the secrets dir, without the .json extension.
  private listSecretSeeds(): Array<{ name: string; file: string }> {
    const dir = this.getSecretSeedsDir();
    if (!fs.existsSync(dir)) return [];
    const results: Array<{ name: string; file: string }> = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          const rel = path.relative(dir, full).slice(0, -'.json'.length);
          results.push({ name: rel.split(path.sep).join('/'), file: full });
        }
      }
    };
    walk(dir);
    return results;
  }

  private readSecretSeedFile(file: string): SecretSeedValue | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as SecretSeedValue;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      console.warn(`[secrets] failed to read secret seed ${file}: ${msg}`);
      return null;
    }
  }

  /**
   * Ensure a single secret exists with an AWSCURRENT version. Never throws —
   * logs warnings like seedOnTableCreated. DescribeSecret first: an existing
   * active secret is SKIPPED (don't clobber a runtime-edited value; keep
   * restarts idempotent); a secret scheduled for deletion is warned + skipped;
   * a missing one is created from the resolved value.
   */
  async ensureSecret(name: string, value: SecretSeedValue, region?: string): Promise<void> {
    try {
      const client = this.secretsClientFor(region);
      try {
        const existing = await client.send(new DescribeSecretCommand({ SecretId: name }));
        if (existing.DeletedDate) {
          console.warn(`[secrets] "${name}" is scheduled for deletion — skipped`);
          return;
        }
        // Already present and active — leave it untouched.
        return;
      } catch (error) {
        const errName = error instanceof Error && 'name' in error ? (error as { name: string }).name : '';
        if (errName !== 'ResourceNotFoundException') {
          const msg = error instanceof Error ? error.message : 'unknown error';
          console.warn(`[secrets] could not describe "${name}": ${msg}`);
          return;
        }
        // Not found → fall through and create it.
      }

      const spec = normalizeSecretSeed(value);
      let secretString = spec.secretString;
      if (secretString === undefined && spec.generateSecretString) {
        secretString = await resolveGeneratedSecretString(client, spec.generateSecretString);
      }
      if (secretString === undefined) {
        console.warn(`[secrets] "${name}" seed has no secretString/generateSecretString — skipped`);
        return;
      }
      await client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: secretString,
          Description: spec.description,
          KmsKeyId: spec.kmsKeyId,
          Tags: spec.tags && spec.tags.length > 0 ? spec.tags : undefined,
        }),
      );
      console.log(`  ✓ Seeded secret: ${name}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      console.warn(`[secrets] seed for "${name}" failed: ${msg}`);
    }
  }

  /**
   * Apply every secret seed on boot: files under seeds/secrets/ merged with the
   * config `secrets` map (config wins on a name collision, with a warning).
   * Never throws — a single failing seed is logged and the rest still run.
   */
  async seedAllSecrets(region?: string): Promise<void> {
    const r = region || this.defaultRegion;
    const merged = new Map<string, SecretSeedValue>();

    for (const { name, file } of this.listSecretSeeds()) {
      const value = this.readSecretSeedFile(file);
      if (value !== null) merged.set(name, value);
    }

    const configSeeds = ConfigManager.getInstance().getSecretSeeds();
    for (const [name, value] of Object.entries(configSeeds)) {
      if (merged.has(name)) {
        console.warn(`[secrets] config secret "${name}" overrides the seeds/secrets file of the same name`);
      }
      merged.set(name, value);
    }

    for (const [name, value] of merged) {
      await this.ensureSecret(name, value, r);
    }
  }

  // Paginated: ListTables caps a page at 100 names, so a monorepo with more
  // tables than that would silently report every seed file past the cap as
  // "no matching live table".
  private async listTables(region?: string): Promise<string[]> {
    try {
      const client = this.clientFor(region);
      const names: string[] = [];
      let exclusiveStartTableName: string | undefined;
      do {
        const res = await client.send(new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }));
        names.push(...(res.TableNames ?? []));
        exclusiveStartTableName = res.LastEvaluatedTableName;
      } while (exclusiveStartTableName);
      return names;
    } catch {
      return [];
    }
  }

  private async getTableKeyAttributes(tableName: string, region?: string): Promise<string[] | null> {
    try {
      const client = this.clientFor(region);
      const res = await client.send(
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
  private async writeBatchWithRetry(tableName: string, requests: WriteRequest[], region?: string): Promise<void> {
    const client = this.clientFor(region);
    let pending = requests;
    let attempt = 0;
    while (pending.length > 0) {
      const res = await client.send(
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
