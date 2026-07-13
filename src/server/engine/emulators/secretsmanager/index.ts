// Secrets Manager emulator (AWS JSON 1.1, X-Amz-Target `secretsmanager.*`).
// Covers the data-plane surface applications actually depend on at boot:
// CreateSecret/GetSecretValue/PutSecretValue with real version staging
// (AWSCURRENT/AWSPREVIOUS), plus Describe/Update/Delete/Restore/List, tagging
// and GetRandomPassword. Secrets persist per region in a catalog; values are
// stored exactly as received (string or base64 binary). This is what lets a
// project retire the LocalStack Secrets Manager the self engine used to proxy
// through `fallbackEndpoint`.
//
// Not covered (rejected with an explicit AWS-shaped error, or silently
// accepted where harmless): rotation scheduling/Lambda, replication, KMS
// (KmsKeyId is accepted and ignored — values are not encrypted locally),
// resource policies.

import { randomBytes, randomUUID } from 'crypto';
import type { AwsRequest, EngineContext, EngineServiceName, TargetEmulator } from '../../types.js';
import type { CatalogStore } from '../../store/store-types.js';
import { AwsError, notImplementedOperation } from '../../http/errors.js';

const AWSCURRENT = 'AWSCURRENT';
const AWSPREVIOUS = 'AWSPREVIOUS';
const DEFAULT_RECOVERY_DAYS = 30;
const MIN_RECOVERY_DAYS = 7;
const MAX_RECOVERY_DAYS = 30;
const DEFAULT_PASSWORD_LENGTH = 32;

interface SecretVersion {
  versionId: string;
  secretString?: string;
  // base64, mirroring the wire SecretBinary blob.
  secretBinary?: string;
  versionStages: string[];
  createdAtMs: number;
}

interface SecretTag {
  Key: string;
  Value: string;
}

interface SecretRecord {
  name: string;
  arn: string;
  description?: string;
  kmsKeyId?: string;
  tags: SecretTag[];
  versions: SecretVersion[];
  createdAtMs: number;
  lastChangedAtMs: number;
  lastAccessedAtMs?: number;
  // Set by DeleteSecret (scheduled deletion); cleared by RestoreSecret.
  deletedAtMs?: number;
  deletionAtMs?: number;
}

export class SecretsManagerEmulator implements TargetEmulator {
  readonly service: EngineServiceName = 'secretsmanager';
  readonly targetPrefix = 'secretsmanager';
  readonly jsonVersion = '1.1' as const;

  private readonly catalogs = new Map<string, CatalogStore<SecretRecord>>();

  constructor(private readonly ctx: EngineContext) {}

  async handle(operation: string, input: Record<string, unknown>, req: AwsRequest): Promise<object> {
    const region = req.region;
    switch (operation) {
      case 'CreateSecret': return this.createSecret(region, input);
      case 'GetSecretValue': return this.getSecretValue(region, input);
      case 'PutSecretValue': return this.putSecretValue(region, input);
      case 'UpdateSecret': return this.updateSecret(region, input);
      case 'DescribeSecret': return this.describeSecret(region, input);
      case 'DeleteSecret': return this.deleteSecret(region, input);
      case 'RestoreSecret': return this.restoreSecret(region, input);
      case 'ListSecrets': return this.listSecrets(region, input);
      case 'TagResource': return this.tagResource(region, input);
      case 'UntagResource': return this.untagResource(region, input);
      case 'GetRandomPassword': return this.getRandomPassword(input);
      default: throw notImplementedOperation('secretsmanager', operation);
    }
  }

  // -- shared plumbing -------------------------------------------------------

  private async catalogFor(region: string): Promise<CatalogStore<SecretRecord>> {
    let catalog = this.catalogs.get(region);
    if (!catalog) {
      catalog = this.ctx.store.catalog<SecretRecord>(`secretsmanager/${region}/secrets`);
      this.catalogs.set(region, catalog);
    }
    await catalog.load();
    return catalog;
  }

  // SecretId is a friendly name, a full ARN or a partial ARN — match all three.
  private findBySecretId(catalog: CatalogStore<SecretRecord>, secretId: unknown): SecretRecord | undefined {
    if (typeof secretId !== 'string' || secretId.length === 0) {
      throw invalidParameter('Invalid SecretId provided');
    }
    const byName = catalog.get(secretId);
    if (byName) return byName;
    return catalog.values().find((record) => record.arn === secretId || record.arn.endsWith(`:secret:${secretId}`));
  }

  private requireSecret(catalog: CatalogStore<SecretRecord>, secretId: unknown): SecretRecord {
    const record = this.findBySecretId(catalog, secretId);
    if (!record) {
      throw new AwsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.", { status: 400 });
    }
    return record;
  }

  private requireActiveSecret(catalog: CatalogStore<SecretRecord>, secretId: unknown): SecretRecord {
    const record = this.requireSecret(catalog, secretId);
    if (record.deletedAtMs !== undefined) {
      throw invalidRequest(
        'You can’t perform this operation on the secret because it was marked for deletion.',
      );
    }
    return record;
  }

  private arnFor(region: string, name: string): string {
    const suffix = randomBytes(4).toString('base64url').slice(0, 6);
    return `arn:aws:secretsmanager:${region}:${this.ctx.config.account}:secret:${name}-${suffix}`;
  }

  private currentVersion(record: SecretRecord): SecretVersion | undefined {
    return record.versions.find((version) => version.versionStages.includes(AWSCURRENT));
  }

  // Attach a brand-new version and roll the requested stages onto it. Every
  // staging label is unique to one version at a time (AWS invariant): applying
  // a stage strips it from whoever held it. Promoting AWSCURRENT additionally
  // moves AWSPREVIOUS onto the version that just lost AWSCURRENT — which first
  // requires stripping AWSPREVIOUS from its prior holder, or successive
  // rotations would leave several versions tagged AWSPREVIOUS.
  private stageNewVersion(record: SecretRecord, version: SecretVersion, stages: string[]): void {
    const promotingCurrent = stages.includes(AWSCURRENT);
    const outgoingCurrent = promotingCurrent ? this.currentVersion(record) : undefined;
    for (const existing of record.versions) {
      existing.versionStages = existing.versionStages.filter((stage) => !stages.includes(stage));
    }
    if (outgoingCurrent && outgoingCurrent !== version) {
      for (const existing of record.versions) {
        existing.versionStages = existing.versionStages.filter((stage) => stage !== AWSPREVIOUS);
      }
      outgoingCurrent.versionStages.push(AWSPREVIOUS);
    }
    version.versionStages = [...stages];
    record.versions.push(version);
    // Drop versions that no longer carry any stage (AWS garbage-collects these).
    record.versions = record.versions.filter((v) => v === version || v.versionStages.length > 0);
  }

  // -- operations ------------------------------------------------------------

  private async createSecret(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    const catalog = await this.catalogFor(region);
    const existing = catalog.get(name);
    if (existing) {
      if (existing.deletedAtMs !== undefined) {
        // AWS blocks reusing the name of a secret scheduled for deletion until
        // it is restored or the recovery window elapses.
        throw invalidRequest(
          'You can’t create this secret because a secret with this name is already scheduled for deletion.',
        );
      }
      // Idempotent replay when the same client token created it.
      const token = input.ClientRequestToken;
      if (typeof token === 'string' && this.currentVersion(existing)?.versionId === token) {
        return { ARN: existing.arn, Name: existing.name, VersionId: token };
      }
      throw new AwsError(
        'ResourceExistsException',
        'The operation failed because the secret already exists.',
        { status: 400 },
      );
    }
    const { secretString, secretBinary } = readSecretValue(input, false);
    const versionId = clientToken(input);
    const nowMs = Date.now();
    const record: SecretRecord = {
      name,
      arn: this.arnFor(region, name),
      description: optionalString(input, 'Description'),
      kmsKeyId: optionalString(input, 'KmsKeyId'),
      tags: readTags(input),
      versions: [],
      createdAtMs: nowMs,
      lastChangedAtMs: nowMs,
    };
    if (secretString !== undefined || secretBinary !== undefined) {
      this.stageNewVersion(record, newVersion(versionId, secretString, secretBinary, nowMs), [AWSCURRENT]);
    }
    catalog.set(name, record);
    return {
      ARN: record.arn,
      Name: record.name,
      VersionId: secretString !== undefined || secretBinary !== undefined ? versionId : undefined,
    };
  }

  private async getSecretValue(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireActiveSecret(catalog, input.SecretId);
    const versionId = optionalString(input, 'VersionId');
    const versionStage = optionalString(input, 'VersionStage');
    let version: SecretVersion | undefined;
    if (versionId) {
      version = record.versions.find((v) => v.versionId === versionId);
      if (version && versionStage && !version.versionStages.includes(versionStage)) version = undefined;
    } else {
      version = record.versions.find((v) => v.versionStages.includes(versionStage ?? AWSCURRENT));
    }
    if (!version) {
      throw new AwsError(
        'ResourceNotFoundException',
        "Secrets Manager can't find the specified secret value for staging label: " + (versionStage ?? AWSCURRENT),
        { status: 400 },
      );
    }
    // AWS tracks LastAccessedDate at day granularity — persist only when the
    // day rolls over, so a read-heavy secret doesn't rewrite the whole
    // per-region catalog on every GetSecretValue.
    const nowMs = Date.now();
    const previousDay = record.lastAccessedAtMs ? Math.floor(record.lastAccessedAtMs / 86_400_000) : -1;
    record.lastAccessedAtMs = nowMs;
    if (Math.floor(nowMs / 86_400_000) !== previousDay) catalog.set(record.name, record);
    return {
      ARN: record.arn,
      Name: record.name,
      VersionId: version.versionId,
      SecretString: version.secretString,
      SecretBinary: version.secretBinary,
      VersionStages: [...version.versionStages],
      CreatedDate: epochSeconds(version.createdAtMs),
    };
  }

  private async putSecretValue(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireActiveSecret(catalog, input.SecretId);
    const { secretString, secretBinary } = readSecretValue(input, true);
    const versionId = clientToken(input);
    if (record.versions.some((v) => v.versionId === versionId)) {
      // Same token already applied — idempotent, return the existing version.
      const existing = record.versions.find((v) => v.versionId === versionId)!;
      return { ARN: record.arn, Name: record.name, VersionId: versionId, VersionStages: [...existing.versionStages] };
    }
    const stages = readVersionStages(input);
    const nowMs = Date.now();
    const version = newVersion(versionId, secretString, secretBinary, nowMs);
    this.stageNewVersion(record, version, stages);
    record.lastChangedAtMs = nowMs;
    catalog.set(record.name, record);
    return { ARN: record.arn, Name: record.name, VersionId: versionId, VersionStages: [...version.versionStages] };
  }

  private async updateSecret(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireActiveSecret(catalog, input.SecretId);
    if (input.Description !== undefined) record.description = optionalString(input, 'Description');
    if (input.KmsKeyId !== undefined) record.kmsKeyId = optionalString(input, 'KmsKeyId');
    const nowMs = Date.now();
    let versionId: string | undefined;
    if (input.SecretString !== undefined || input.SecretBinary !== undefined) {
      const { secretString, secretBinary } = readSecretValue(input, false);
      versionId = clientToken(input);
      // Idempotent on ClientRequestToken, like PutSecretValue: a retry with the
      // same token must not stage a second version sharing that id.
      if (!record.versions.some((v) => v.versionId === versionId)) {
        this.stageNewVersion(record, newVersion(versionId, secretString, secretBinary, nowMs), [AWSCURRENT]);
      }
    }
    record.lastChangedAtMs = nowMs;
    catalog.set(record.name, record);
    return { ARN: record.arn, Name: record.name, VersionId: versionId };
  }

  private async describeSecret(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireSecret(catalog, input.SecretId);
    const versionIdsToStages: Record<string, string[]> = {};
    for (const version of record.versions) {
      if (version.versionStages.length > 0) versionIdsToStages[version.versionId] = [...version.versionStages];
    }
    return {
      ARN: record.arn,
      Name: record.name,
      Description: record.description,
      KmsKeyId: record.kmsKeyId,
      Tags: serializeTags(record.tags),
      VersionIdsToStages: versionIdsToStages,
      CreatedDate: epochSeconds(record.createdAtMs),
      LastChangedDate: epochSeconds(record.lastChangedAtMs),
      LastAccessedDate: record.lastAccessedAtMs ? epochSeconds(record.lastAccessedAtMs) : undefined,
      DeletedDate: record.deletedAtMs ? epochSeconds(record.deletedAtMs) : undefined,
    };
  }

  private async deleteSecret(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireSecret(catalog, input.SecretId);
    const force = input.ForceDeleteWithoutRecovery === true;
    const hasRecoveryWindow = input.RecoveryWindowInDays !== undefined;
    if (force && hasRecoveryWindow) {
      throw invalidParameter('You can’t use ForceDeleteWithoutRecovery in conjunction with RecoveryWindowInDays.');
    }
    if (force) {
      catalog.delete(record.name);
      return { ARN: record.arn, Name: record.name, DeletionDate: epochSeconds(Date.now()) };
    }
    const days = readRecoveryWindow(input);
    const nowMs = Date.now();
    record.deletedAtMs = nowMs;
    record.deletionAtMs = nowMs + days * 86_400_000;
    catalog.set(record.name, record);
    return { ARN: record.arn, Name: record.name, DeletionDate: epochSeconds(record.deletionAtMs) };
  }

  private async restoreSecret(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireSecret(catalog, input.SecretId);
    record.deletedAtMs = undefined;
    record.deletionAtMs = undefined;
    catalog.set(record.name, record);
    return { ARN: record.arn, Name: record.name };
  }

  private async listSecrets(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const includePlanned = input.IncludePlannedDeletion === true;
    const secretList = catalog.values()
      .filter((record) => includePlanned || record.deletedAtMs === undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((record) => ({
        ARN: record.arn,
        Name: record.name,
        Description: record.description,
        KmsKeyId: record.kmsKeyId,
        Tags: serializeTags(record.tags),
        SecretVersionsToStages: versionsToStages(record.versions),
        CreatedDate: epochSeconds(record.createdAtMs),
        LastChangedDate: epochSeconds(record.lastChangedAtMs),
        LastAccessedDate: record.lastAccessedAtMs ? epochSeconds(record.lastAccessedAtMs) : undefined,
        DeletedDate: record.deletedAtMs ? epochSeconds(record.deletedAtMs) : undefined,
      }));
    return { SecretList: secretList };
  }

  private async tagResource(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireSecret(catalog, input.SecretId);
    for (const tag of readTags(input)) {
      const existing = record.tags.find((t) => t.Key === tag.Key);
      if (existing) existing.Value = tag.Value;
      else record.tags.push(tag);
    }
    catalog.set(record.name, record);
    return {};
  }

  private async untagResource(region: string, input: Record<string, unknown>): Promise<object> {
    const catalog = await this.catalogFor(region);
    const record = this.requireSecret(catalog, input.SecretId);
    const keys = Array.isArray(input.TagKeys) ? input.TagKeys.map(String) : [];
    record.tags = record.tags.filter((tag) => !keys.includes(tag.Key));
    catalog.set(record.name, record);
    return {};
  }

  private getRandomPassword(input: Record<string, unknown>): object {
    const length = typeof input.PasswordLength === 'number' ? input.PasswordLength : DEFAULT_PASSWORD_LENGTH;
    if (length < 1 || length > 4096) throw invalidParameter('PasswordLength must be between 1 and 4096.');
    const exclude = new Set((optionalString(input, 'ExcludeCharacters') ?? '').split(''));
    const classes: string[][] = [];
    const addClass = (chars: string): void => {
      const filtered = [...chars].filter((ch) => !exclude.has(ch));
      if (filtered.length > 0) classes.push(filtered);
    };
    if (input.ExcludeUppercase !== true) addClass('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    if (input.ExcludeLowercase !== true) addClass('abcdefghijklmnopqrstuvwxyz');
    if (input.ExcludeNumbers !== true) addClass('0123456789');
    if (input.ExcludePunctuation !== true) addClass('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
    if (input.IncludeSpace === true) addClass(' ');
    const pool = classes.flat();
    if (pool.length === 0) throw invalidParameter('The character pool is empty after applying the exclusions.');

    const chars = Array.from({ length }, () => pool[randomInt(pool.length)]);
    // RequireEachIncludedType defaults to true: guarantee at least one
    // character from every included class, at distinct positions.
    if (input.RequireEachIncludedType !== false && length >= classes.length) {
      const positions = [...Array(length).keys()];
      for (let i = positions.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [positions[i], positions[j]] = [positions[j], positions[i]];
      }
      classes.forEach((cls, i) => { chars[positions[i]] = cls[randomInt(cls.length)]; });
    }
    return { RandomPassword: chars.join('') };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function newVersion(versionId: string, secretString: string | undefined, secretBinary: string | undefined, createdAtMs: number): SecretVersion {
  return { versionId, secretString, secretBinary, versionStages: [], createdAtMs };
}

// Uniform integer in [0, max) with rejection sampling — no modulo bias, so the
// generated passwords are unbiased over the character pool.
function randomInt(max: number): number {
  const limit = Math.floor(256 / max) * max;
  let byte: number;
  do {
    byte = randomBytes(1)[0];
  } while (byte >= limit);
  return byte % max;
}

function clientToken(input: Record<string, unknown>): string {
  const token = input.ClientRequestToken;
  return typeof token === 'string' && token.length > 0 ? token : randomUUID();
}

function readSecretValue(input: Record<string, unknown>, required: boolean): { secretString?: string; secretBinary?: string } {
  const secretString = input.SecretString;
  const secretBinary = input.SecretBinary;
  if (secretString !== undefined && typeof secretString !== 'string') {
    throw invalidParameter('SecretString must be a string.');
  }
  if (secretBinary !== undefined && typeof secretBinary !== 'string') {
    throw invalidParameter('SecretBinary must be a base64-encoded string.');
  }
  if (required && secretString === undefined && secretBinary === undefined) {
    throw invalidParameter('You must provide either SecretString or SecretBinary.');
  }
  return {
    secretString: typeof secretString === 'string' ? secretString : undefined,
    secretBinary: typeof secretBinary === 'string' ? secretBinary : undefined,
  };
}

function readVersionStages(input: Record<string, unknown>): string[] {
  const stages = input.VersionStages;
  if (stages === undefined) return [AWSCURRENT];
  if (!Array.isArray(stages) || stages.length === 0 || !stages.every((s) => typeof s === 'string')) {
    throw invalidParameter('VersionStages must be a non-empty list of strings.');
  }
  return stages as string[];
}

function readRecoveryWindow(input: Record<string, unknown>): number {
  const raw = input.RecoveryWindowInDays;
  if (raw === undefined) return DEFAULT_RECOVERY_DAYS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_RECOVERY_DAYS || raw > MAX_RECOVERY_DAYS) {
    throw invalidParameter(`RecoveryWindowInDays must be an integer between ${MIN_RECOVERY_DAYS} and ${MAX_RECOVERY_DAYS}.`);
  }
  return raw;
}

function readTags(input: Record<string, unknown>): SecretTag[] {
  const tags = input.Tags;
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => {
    const entry = tag as { Key?: unknown; Value?: unknown };
    return { Key: String(entry.Key ?? ''), Value: String(entry.Value ?? '') };
  });
}

function serializeTags(tags: SecretTag[]): SecretTag[] | undefined {
  return tags.length > 0 ? tags.map((tag) => ({ Key: tag.Key, Value: tag.Value })) : undefined;
}

function versionsToStages(versions: SecretVersion[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const version of versions) {
    if (version.versionStages.length > 0) map[version.versionId] = [...version.versionStages];
  }
  return map;
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParameter(`${field} is a required field.`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === 'string' ? value : undefined;
}

function epochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function invalidParameter(message: string): AwsError {
  return new AwsError('InvalidParameterException', message, { status: 400 });
}

function invalidRequest(message: string): AwsError {
  return new AwsError('InvalidRequestException', message, { status: 400 });
}
