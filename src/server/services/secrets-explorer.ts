// Read-only Secrets Manager explorer for the dashboard: lists secrets, reads
// one secret's metadata (version stages, tags) and — on explicit request —
// reveals the current value. Talks the AWS wire against the active engine
// endpoint, so it works identically on the self engine and LocalStack. Mirrors
// the DynamoExplorer/S3Explorer pattern (per-region memoized client, region
// from the request, AWS errors mapped to plain messages).

import {
  SecretsManagerClient,
  ListSecretsCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  type SecretListEntry,
} from '@aws-sdk/client-secrets-manager';
import { LocalStackManager } from './localstack-manager.js';

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
  // versionId → staging labels (AWSCURRENT/AWSPREVIOUS/…).
  versionStages: Record<string, string[]>;
  kmsKeyId?: string;
}

export interface SecretValue {
  name: string;
  versionId?: string;
  versionStages: string[];
  // Exactly one of these is present.
  secretString?: string;
  secretBinary?: string;
  createdDate?: string;
}

export class SecretsExplorer {
  private static instance: SecretsExplorer;
  private clients = new Map<string, SecretsManagerClient>();
  private defaultRegion = 'us-east-1';

  // Seeded from the active engine config so a caller that omits `?region=`
  // (CLI, LssClient, curl) still reads the project's own region — see the
  // matching note in DynamoExplorer.
  private constructor() {
    const region = LocalStackManager.getInstance().getConfig().region;
    if (region) this.defaultRegion = region;
  }

  static getInstance(): SecretsExplorer {
    if (!SecretsExplorer.instance) SecretsExplorer.instance = new SecretsExplorer();
    return SecretsExplorer.instance;
  }

  setDefaultRegion(region: string): void {
    if (region) this.defaultRegion = region;
  }

  private clientFor(region?: string): SecretsManagerClient {
    const r = region || this.defaultRegion;
    let client = this.clients.get(r);
    if (!client) {
      const baseConfig = LocalStackManager.getInstance().getConfig();
      client = new SecretsManagerClient({ ...baseConfig, region: r });
      this.clients.set(r, client);
    }
    return client;
  }

  async listSecrets(region?: string): Promise<SecretSummary[]> {
    const client = this.clientFor(region);
    const summaries: SecretSummary[] = [];
    let nextToken: string | undefined;
    do {
      const page = await client.send(new ListSecretsCommand({ NextToken: nextToken, MaxResults: 100 }));
      for (const entry of page.SecretList ?? []) summaries.push(toSummary(entry));
      nextToken = page.NextToken;
    } while (nextToken);
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeSecret(secretId: string, region?: string): Promise<SecretDetail | null> {
    try {
      const res = await this.clientFor(region).send(new DescribeSecretCommand({ SecretId: secretId }));
      return {
        name: res.Name ?? secretId,
        arn: res.ARN,
        description: res.Description,
        lastChangedDate: res.LastChangedDate?.toISOString(),
        lastAccessedDate: res.LastAccessedDate?.toISOString(),
        createdDate: res.CreatedDate?.toISOString(),
        deletedDate: res.DeletedDate?.toISOString(),
        tags: (res.Tags ?? []).map(tag => ({ key: tag.Key ?? '', value: tag.Value ?? '' })),
        versionCount: Object.keys(res.VersionIdsToStages ?? {}).length,
        versionStages: res.VersionIdsToStages ?? {},
        kmsKeyId: res.KmsKeyId,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // Reveals the current secret value — an explicit, separate call so a plain
  // list never ships secret material to the browser.
  async getSecretValue(secretId: string, region?: string): Promise<SecretValue | null> {
    try {
      const res = await this.clientFor(region).send(new GetSecretValueCommand({ SecretId: secretId }));
      return {
        name: res.Name ?? secretId,
        versionId: res.VersionId,
        versionStages: res.VersionStages ?? [],
        secretString: res.SecretString,
        secretBinary: res.SecretBinary ? Buffer.from(res.SecretBinary).toString('base64') : undefined,
        createdDate: res.CreatedDate?.toISOString(),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

function toSummary(entry: SecretListEntry): SecretSummary {
  return {
    name: entry.Name ?? '',
    arn: entry.ARN,
    description: entry.Description,
    lastChangedDate: entry.LastChangedDate?.toISOString(),
    lastAccessedDate: entry.LastAccessedDate?.toISOString(),
    createdDate: entry.CreatedDate?.toISOString(),
    deletedDate: entry.DeletedDate?.toISOString(),
    tags: (entry.Tags ?? []).map(tag => ({ key: tag.Key ?? '', value: tag.Value ?? '' })),
    versionCount: Object.keys(entry.SecretVersionsToStages ?? {}).length,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}
