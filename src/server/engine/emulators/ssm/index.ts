// SSM Parameter Store emulator (AWS JSON 1.1, X-Amz-Target `AmazonSSM.*`).
// Covers the Parameter Store surface applications read at boot and tooling
// writes during setup: PutParameter (String / StringList / SecureString, with
// Overwrite, AllowedPattern, tiers, data types and create-time tags), the
// three read paths (GetParameter, GetParameters, GetParametersByPath with
// Recursive + filters + pagination), DescribeParameters, GetParameterHistory,
// LabelParameterVersion, DeleteParameter(s) and resource tagging. Parameters
// persist per region in a catalog, every version kept (up to the AWS limit of
// 100), so `name:3` and `name:label` selectors resolve exactly like AWS.
//
// SecureString and KMS: there is no KMS locally, so values are stored as
// received and WithDecryption=true returns them verbatim. WithDecryption=false
// (the AWS default) must NOT hand back the plaintext — AWS returns the
// ciphertext blob — so the emulator answers a deterministic opaque base64
// token derived from (name, version, value). It is stable across reads, never
// decodes to the plaintext, and changes whenever the value does, which is all
// a caller can legitimately rely on. KeyId is accepted and echoed (default
// `alias/aws/ssm`), never validated.
//
// Not covered (rejected with an explicit AWS-shaped error, or silently
// accepted where harmless): parameter policies (Expiration/notifications —
// `Policies` is accepted and ignored, always answered as []), public
// `/aws/service/...` parameters, cross-account sharing, UnlabelParameterVersion
// and the asynchronous `aws:ec2:image` value validation.

import { createHash } from 'crypto';
import type { AwsRequest, EngineContext, EngineServiceName, TargetEmulator } from '../../types.js';
import type { CatalogStore } from '../../store/store-types.js';
import { AwsError, notImplementedOperation } from '../../http/errors.js';

const PARAMETER_TYPES = ['String', 'StringList', 'SecureString'] as const;
type ParameterType = typeof PARAMETER_TYPES[number];
const TIERS = ['Standard', 'Advanced', 'Intelligent-Tiering'] as const;
type StoredTier = 'Standard' | 'Advanced';
const DATA_TYPES = ['text', 'aws:ec2:image', 'aws:ssm:integration'];
const DEFAULT_KEY_ID = 'alias/aws/ssm';

// AWS limits (Systems Manager service quotas, defaults).
const MAX_NAME_LENGTH = 1011;
const MAX_HIERARCHY_LEVELS = 15;
const STANDARD_VALUE_LIMIT = 4096;
const ADVANCED_VALUE_LIMIT = 8192;
const MAX_VERSIONS = 100;
const MAX_STANDARD_PARAMETERS = 10_000;
const MAX_TAGS = 50;
const MAX_LABELS_PER_VERSION = 10;
const MAX_NAMES_PER_BATCH = 10;
const BY_PATH_MAX_RESULTS = 10;
const DESCRIBE_MAX_RESULTS = 50;
const HISTORY_MAX_RESULTS = 50;

const NAME_CHARS = /^[a-zA-Z0-9_.\-/]+$/;
const LABEL_CHARS = /^[a-zA-Z0-9_.-]+$/;

interface ParameterTag {
  Key: string;
  Value: string;
}

interface ParameterVersion {
  version: number;
  value: string;
  type: ParameterType;
  description?: string;
  keyId?: string;
  allowedPattern?: string;
  dataType: string;
  tier: StoredTier;
  labels: string[];
  lastModifiedMs: number;
}

interface ParameterRecord {
  name: string;
  tags: ParameterTag[];
  // Ascending by version; the last entry is the current value.
  versions: ParameterVersion[];
}

interface ParameterFilter {
  Key: string;
  Option: string;
  Values: string[];
}

export class SsmEmulator implements TargetEmulator {
  readonly service: EngineServiceName = 'ssm';
  readonly targetPrefix = 'AmazonSSM';
  readonly jsonVersion = '1.1' as const;

  private readonly catalogs = new Map<string, CatalogStore<ParameterRecord>>();

  constructor(private readonly ctx: EngineContext) {}

  async handle(operation: string, input: Record<string, unknown>, req: AwsRequest): Promise<object> {
    const region = req.region;
    switch (operation) {
      case 'PutParameter': return this.putParameter(region, input);
      case 'GetParameter': return this.getParameter(region, input);
      case 'GetParameters': return this.getParameters(region, input);
      case 'GetParametersByPath': return this.getParametersByPath(region, input);
      case 'DescribeParameters': return this.describeParameters(region, input);
      case 'GetParameterHistory': return this.getParameterHistory(region, input);
      case 'LabelParameterVersion': return this.labelParameterVersion(region, input);
      case 'DeleteParameter': return this.deleteParameter(region, input);
      case 'DeleteParameters': return this.deleteParameters(region, input);
      case 'AddTagsToResource': return this.addTagsToResource(region, input);
      case 'RemoveTagsFromResource': return this.removeTagsFromResource(region, input);
      case 'ListTagsForResource': return this.listTagsForResource(region, input);
      default: throw notImplementedOperation('ssm', operation);
    }
  }

  // -- shared plumbing -------------------------------------------------------

  private async catalogFor(region: string): Promise<CatalogStore<ParameterRecord>> {
    let catalog = this.catalogs.get(region);
    if (!catalog) {
      catalog = this.ctx.store.catalog<ParameterRecord>(`ssm/${region}/parameters`);
      this.catalogs.set(region, catalog);
    }
    await catalog.load();
    return catalog;
  }

  // ARN shape: the name WITHOUT its leading slash follows `parameter/`, so
  // `/acme/orders/db-password` → `…:parameter/acme/orders/db-password` and a
  // flat `feature-flag` → `…:parameter/feature-flag`.
  private arnFor(region: string, name: string): string {
    const bare = name.startsWith('/') ? name.slice(1) : name;
    return `arn:aws:ssm:${region}:${this.ctx.config.account}:parameter/${bare}`;
  }

  // Every write is attributed to the same principal STS answers for.
  private lastModifiedUser(): string {
    return `arn:aws:iam::${this.ctx.config.account}:root`;
  }

  // Name or full ARN → stored record. An ARN drops the leading slash, so both
  // spellings (`x` and `/x`) are tried — names can't contain `:`, so nothing
  // ambiguous survives the prefix strip.
  private findRecord(catalog: CatalogStore<ParameterRecord>, reference: string): ParameterRecord | undefined {
    const arnMatch = /^arn:[^:]+:ssm:[^:]*:[^:]*:parameter\/(.+)$/.exec(reference);
    if (!arnMatch) return catalog.get(reference);
    return catalog.get(arnMatch[1]) ?? catalog.get(`/${arnMatch[1]}`);
  }

  private requireRecord(catalog: CatalogStore<ParameterRecord>, name: string): ParameterRecord {
    const record = this.findRecord(catalog, name);
    if (!record) throw parameterNotFound(name);
    return record;
  }

  // Resolve `name`, `name:<version>` or `name:<label>` to one version. Throws
  // the AWS error GetParameter surfaces; GetParameters maps any throw to an
  // InvalidParameters entry instead.
  private resolveSelector(
    catalog: CatalogStore<ParameterRecord>,
    reference: string,
  ): { record: ParameterRecord; version: ParameterVersion; selector?: string } {
    const { name, selector } = splitSelector(reference);
    const record = this.requireRecord(catalog, name);
    if (selector === undefined) return { record, version: currentVersion(record) };
    if (/^\d+$/.test(selector)) {
      const wanted = Number(selector);
      const version = record.versions.find((v) => v.version === wanted);
      if (!version) {
        throw new AwsError(
          'ParameterVersionNotFound',
          `Systems Manager could not find version ${wanted} of ${record.name}. Verify the version and try again.`,
        );
      }
      return { record, version, selector: `:${selector}` };
    }
    const version = record.versions.find((v) => v.labels.includes(selector));
    if (!version) throw parameterNotFound(reference);
    return { record, version, selector: `:${selector}` };
  }

  private toParameter(
    region: string,
    record: ParameterRecord,
    version: ParameterVersion,
    withDecryption: boolean,
    selector?: string,
  ): Record<string, unknown> {
    return {
      Name: record.name,
      Type: version.type,
      Value: renderValue(record.name, version, withDecryption),
      Version: version.version,
      Selector: selector,
      LastModifiedDate: epochSeconds(version.lastModifiedMs),
      ARN: this.arnFor(region, record.name),
      DataType: version.dataType,
    };
  }

  // -- operations ------------------------------------------------------------

  private async putParameter(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    validateName(name);
    const value = requireString(input, 'Value');
    const overwrite = input.Overwrite === true;
    const tags = readTags(input.Tags);
    if (overwrite && tags.length > 0) {
      throw validation(
        'Invalid request: tags and overwrite can\'t be used together. To create a parameter with tags, please ' +
          'remove overwrite flag. To update tags for an existing parameter, please use AddTagsToResource or ' +
          'RemoveTagsFromResource.',
      );
    }
    if (tags.length > MAX_TAGS) throw tooManyTags();

    const catalog = await this.catalogFor(region);
    const existing = catalog.get(name);
    if (existing && !overwrite) {
      throw new AwsError('ParameterAlreadyExists', 'The parameter already exists. To overwrite this request value, set the overwrite option in the request to true.');
    }
    const previous = existing ? currentVersion(existing) : undefined;
    if (!existing && catalog.keys().length >= MAX_STANDARD_PARAMETERS) {
      throw new AwsError('ParameterLimitExceeded', 'You have exceeded the number of parameters for this AWS account. Delete one or more parameters and try again.');
    }

    // Type is required on create; on overwrite an omitted Type keeps the
    // current one (the modern AWS API made it optional for that case).
    const rawType = input.Type;
    if (rawType === undefined && !previous) throw validation('A parameter type is required when you create a parameter.');
    if (rawType !== undefined && !PARAMETER_TYPES.includes(rawType as ParameterType)) {
      throw new AwsError('UnsupportedParameterType', `The parameter type ${String(rawType)} is not supported.`);
    }
    const type = (rawType as ParameterType | undefined) ?? (previous as ParameterVersion).type;

    const explicitKeyId = optionalString(input, 'KeyId');
    if (explicitKeyId !== undefined && type !== 'SecureString') {
      throw validation('KeyId is required for SecureString type parameter only.');
    }
    const keyId = type === 'SecureString'
      ? explicitKeyId ?? (previous?.type === 'SecureString' ? previous.keyId : undefined) ?? DEFAULT_KEY_ID
      : undefined;

    const dataType = optionalString(input, 'DataType') ?? previous?.dataType ?? 'text';
    if (!DATA_TYPES.includes(dataType)) {
      throw validation(`The following data type is not supported: ${dataType} (Data type names are all lowercase.)`);
    }

    // An omitted Description / AllowedPattern on overwrite keeps the current
    // one, so a value-only rotation doesn't silently drop the constraint.
    const description = input.Description !== undefined ? optionalString(input, 'Description') : previous?.description;
    const allowedPattern = input.AllowedPattern !== undefined ? optionalString(input, 'AllowedPattern') : previous?.allowedPattern;
    if (allowedPattern !== undefined) enforcePattern(allowedPattern, value);

    const tier = resolveTier(input.Tier, value, previous?.tier);

    const nowMs = Date.now();
    const record: ParameterRecord = existing ?? { name, tags, versions: [] };
    const version: ParameterVersion = {
      version: previous ? previous.version + 1 : 1,
      value,
      type,
      description,
      keyId,
      allowedPattern,
      dataType,
      tier,
      labels: [],
      lastModifiedMs: nowMs,
    };
    record.versions.push(version);
    // AWS keeps the 100 most recent versions; older ones age out on write.
    if (record.versions.length > MAX_VERSIONS) record.versions = record.versions.slice(-MAX_VERSIONS);
    catalog.set(name, record);
    return { Version: version.version, Tier: version.tier };
  }

  private async getParameter(region: string, input: Record<string, unknown>): Promise<object> {
    const reference = requireString(input, 'Name');
    const catalog = await this.catalogFor(region);
    const { record, version, selector } = this.resolveSelector(catalog, reference);
    return { Parameter: this.toParameter(region, record, version, input.WithDecryption === true, selector) };
  }

  private async getParameters(region: string, input: Record<string, unknown>): Promise<object> {
    const names = requireNameList(input, 'Names');
    const catalog = await this.catalogFor(region);
    const parameters: Record<string, unknown>[] = [];
    const invalid: string[] = [];
    for (const reference of names) {
      try {
        const { record, version, selector } = this.resolveSelector(catalog, reference);
        parameters.push(this.toParameter(region, record, version, input.WithDecryption === true, selector));
      } catch {
        invalid.push(reference);
      }
    }
    return { Parameters: parameters, InvalidParameters: invalid };
  }

  private async getParametersByPath(region: string, input: Record<string, unknown>): Promise<object> {
    const path = requireString(input, 'Path');
    validatePath(path);
    const recursive = input.Recursive === true;
    const filters = readFilters(input.ParameterFilters, 'by-path');
    const maxResults = readMaxResults(input, BY_PATH_MAX_RESULTS);
    const withDecryption = input.WithDecryption === true;
    const prefix = path.endsWith('/') ? path : `${path}/`;

    const catalog = await this.catalogFor(region);
    const matches: Array<{ record: ParameterRecord; version: ParameterVersion }> = [];
    for (const record of sortedRecords(catalog)) {
      if (!record.name.startsWith(prefix)) continue;
      if (!recursive && record.name.slice(prefix.length).includes('/')) continue;
      // A Label filter answers the labeled version, not the current one.
      const labelFilter = filters.find((f) => f.Key === 'Label');
      const version = labelFilter
        ? record.versions.find((v) => v.labels.some((l) => labelFilter.Values.includes(l)))
        : currentVersion(record);
      if (!version) continue;
      if (!filters.every((f) => f.Key === 'Label' || matchesFilter(f, record, version))) continue;
      matches.push({ record, version });
    }
    const { page, nextToken } = paginate(matches, input.NextToken, maxResults);
    return {
      Parameters: page.map(({ record, version }) => this.toParameter(region, record, version, withDecryption)),
      NextToken: nextToken,
    };
  }

  private async describeParameters(region: string, input: Record<string, unknown>): Promise<object> {
    const filters = readFilters(input.ParameterFilters, 'describe');
    const maxResults = readMaxResults(input, DESCRIBE_MAX_RESULTS);
    const catalog = await this.catalogFor(region);
    const matches = sortedRecords(catalog).filter((record) => {
      const version = currentVersion(record);
      return filters.every((f) => matchesFilter(f, record, version));
    });
    const { page, nextToken } = paginate(matches, input.NextToken, maxResults);
    return {
      Parameters: page.map((record) => {
        const version = currentVersion(record);
        return {
          Name: record.name,
          ARN: this.arnFor(region, record.name),
          Type: version.type,
          KeyId: version.keyId,
          LastModifiedDate: epochSeconds(version.lastModifiedMs),
          LastModifiedUser: this.lastModifiedUser(),
          Description: version.description,
          AllowedPattern: version.allowedPattern,
          Version: version.version,
          Tier: version.tier,
          Policies: [],
          DataType: version.dataType,
        };
      }),
      NextToken: nextToken,
    };
  }

  private async getParameterHistory(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    const maxResults = readMaxResults(input, HISTORY_MAX_RESULTS);
    const withDecryption = input.WithDecryption === true;
    const catalog = await this.catalogFor(region);
    const record = this.requireRecord(catalog, name);
    const { page, nextToken } = paginate(record.versions, input.NextToken, maxResults);
    return {
      Parameters: page.map((version) => ({
        Name: record.name,
        Type: version.type,
        KeyId: version.keyId,
        LastModifiedDate: epochSeconds(version.lastModifiedMs),
        LastModifiedUser: this.lastModifiedUser(),
        Description: version.description,
        Value: renderValue(record.name, version, withDecryption),
        AllowedPattern: version.allowedPattern,
        Version: version.version,
        Labels: [...version.labels],
        Tier: version.tier,
        Policies: [],
        DataType: version.dataType,
      })),
      NextToken: nextToken,
    };
  }

  // A label belongs to one version at a time: attaching it moves it off any
  // other version of the same parameter. Malformed labels are not an error —
  // AWS reports them in InvalidLabels and applies the rest.
  private async labelParameterVersion(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    const labels = input.Labels;
    if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_LABELS_PER_VERSION) {
      throw validation(`Labels must contain between 1 and ${MAX_LABELS_PER_VERSION} labels.`);
    }
    const catalog = await this.catalogFor(region);
    const record = this.requireRecord(catalog, name);
    let version = currentVersion(record);
    if (input.ParameterVersion !== undefined) {
      const wanted = Number(input.ParameterVersion);
      const found = record.versions.find((v) => v.version === wanted);
      if (!found) {
        throw new AwsError(
          'ParameterVersionNotFound',
          `Systems Manager could not find version ${wanted} of ${record.name}. Verify the version and try again.`,
        );
      }
      version = found;
    }
    const valid = labels.map(String).filter(isValidLabel);
    const invalid = labels.map(String).filter((label) => !isValidLabel(label));
    const merged = [...new Set([...version.labels, ...valid])];
    if (merged.length > MAX_LABELS_PER_VERSION) {
      throw new AwsError(
        'ParameterVersionLabelLimitExceeded',
        `A parameter version can have maximum ${MAX_LABELS_PER_VERSION} labels. Move one or more labels to another version and try again.`,
      );
    }
    for (const other of record.versions) {
      if (other !== version) other.labels = other.labels.filter((label) => !valid.includes(label));
    }
    version.labels = merged;
    catalog.set(record.name, record);
    return { InvalidLabels: invalid, ParameterVersion: version.version };
  }

  private async deleteParameter(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    const catalog = await this.catalogFor(region);
    const record = this.requireRecord(catalog, name);
    catalog.delete(record.name);
    return {};
  }

  private async deleteParameters(region: string, input: Record<string, unknown>): Promise<object> {
    const names = requireNameList(input, 'Names');
    const catalog = await this.catalogFor(region);
    const deleted: string[] = [];
    const invalid: string[] = [];
    for (const name of names) {
      const record = this.findRecord(catalog, name);
      if (record) {
        catalog.delete(record.name);
        deleted.push(name);
      } else {
        invalid.push(name);
      }
    }
    return { DeletedParameters: deleted, InvalidParameters: invalid };
  }

  private async taggedRecord(region: string, input: Record<string, unknown>): Promise<{
    catalog: CatalogStore<ParameterRecord>;
    record: ParameterRecord;
  }> {
    const resourceType = input.ResourceType;
    if (resourceType !== 'Parameter') {
      throw new AwsError(
        'InvalidResourceType',
        `The resource type ${String(resourceType)} is not supported by the LSS self engine — only Parameter is.`,
      );
    }
    const resourceId = requireString(input, 'ResourceId');
    const catalog = await this.catalogFor(region);
    const record = this.findRecord(catalog, resourceId);
    if (!record) throw new AwsError('InvalidResourceId', 'The resource ID is not valid. Verify the ID and try again.');
    return { catalog, record };
  }

  private async addTagsToResource(region: string, input: Record<string, unknown>): Promise<object> {
    const { catalog, record } = await this.taggedRecord(region, input);
    const tags = readTags(input.Tags);
    if (tags.length === 0) throw validation('Tags must contain at least one tag.');
    // Merge into a copy so a rejected call leaves the stored tags untouched.
    const merged = record.tags.map((tag) => ({ ...tag }));
    for (const tag of tags) {
      const existing = merged.find((t) => t.Key === tag.Key);
      if (existing) existing.Value = tag.Value;
      else merged.push(tag);
    }
    if (merged.length > MAX_TAGS) throw tooManyTags();
    record.tags = merged;
    catalog.set(record.name, record);
    return {};
  }

  private async removeTagsFromResource(region: string, input: Record<string, unknown>): Promise<object> {
    const { catalog, record } = await this.taggedRecord(region, input);
    const keys = Array.isArray(input.TagKeys) ? input.TagKeys.map(String) : [];
    record.tags = record.tags.filter((tag) => !keys.includes(tag.Key));
    catalog.set(record.name, record);
    return {};
  }

  private async listTagsForResource(region: string, input: Record<string, unknown>): Promise<object> {
    const { record } = await this.taggedRecord(region, input);
    return { TagList: record.tags.map((tag) => ({ Key: tag.Key, Value: tag.Value })) };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function currentVersion(record: ParameterRecord): ParameterVersion {
  return record.versions[record.versions.length - 1];
}

function sortedRecords(catalog: CatalogStore<ParameterRecord>): ParameterRecord[] {
  // Names are unique catalog keys, so the comparator never sees a tie.
  return catalog.values().sort((a, b) => (a.name < b.name ? -1 : 1));
}

// `name:selector` — names can't contain `:`, but ARNs do, so the selector is
// whatever follows the LAST colon only when it carries no `/` (an ARN's own
// last colon is followed by `parameter/…`).
function splitSelector(reference: string): { name: string; selector?: string } {
  const colon = reference.lastIndexOf(':');
  if (colon === -1) return { name: reference };
  const tail = reference.slice(colon + 1);
  if (tail.includes('/')) return { name: reference };
  return { name: reference.slice(0, colon), selector: tail };
}

// AWS name rules: [a-zA-Z0-9_.-/] only, at most 1011 characters, a `/` anywhere
// means a hierarchy (which must then be fully qualified: leading `/`, no empty
// or trailing segment, at most 15 levels), and neither the name nor its first
// hierarchy segment may start with `aws` or `ssm` (case-insensitive) — those
// prefixes are reserved for AWS-owned parameters.
function validateName(name: string): void {
  if (name.length > MAX_NAME_LENGTH) {
    throw validation(`Parameter name must be less than or equal to ${MAX_NAME_LENGTH} characters.`);
  }
  if (!NAME_CHARS.test(name)) {
    throw validation(
      'Parameter name: can\'t contain spaces or special characters. Only letters, numbers, and the symbols ' +
        '"_", ".", "-" and "/" are allowed.',
    );
  }
  if (name.includes('/')) {
    if (!name.startsWith('/') || name.endsWith('/') || name.slice(1).split('/').some((segment) => segment === '')) {
      throw validation('Parameter name must be a fully qualified name.');
    }
    if (name.slice(1).split('/').length > MAX_HIERARCHY_LEVELS) {
      throw new AwsError(
        'HierarchyLevelLimitExceededException',
        `A hierarchy can have a maximum of ${MAX_HIERARCHY_LEVELS} levels. You can't create additional levels.`,
      );
    }
  }
  const head = (name.startsWith('/') ? name.slice(1) : name).toLowerCase();
  if (head.startsWith('aws') || head.startsWith('ssm')) {
    throw validation('Parameter name: can\'t be prefixed with "aws" or "ssm" (case-insensitive).');
  }
}

// GetParametersByPath: `/` alone is valid; otherwise the same hierarchy shape
// as a name (a trailing slash is tolerated, AWS normalizes it away).
function validatePath(path: string): void {
  if (path === '/') return;
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  if (!path.startsWith('/') || !NAME_CHARS.test(path) || trimmed.slice(1).split('/').some((segment) => segment === '')) {
    throw validation(`The parameter doesn't meet the parameter name requirements. The parameter name must begin with a forward slash "/". Path: ${path}`);
  }
  if (trimmed.slice(1).split('/').length > MAX_HIERARCHY_LEVELS) {
    throw new AwsError(
      'HierarchyLevelLimitExceededException',
      `A hierarchy can have a maximum of ${MAX_HIERARCHY_LEVELS} levels. You can't create additional levels.`,
    );
  }
}

// AllowedPattern is a regular expression the value must satisfy (search
// semantics, so patterns carry their own ^…$ anchors as AWS examples do).
function enforcePattern(pattern: string, value: string): void {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    throw new AwsError('InvalidAllowedPatternException', `The request doesn't meet the regular expression requirement: ${pattern}`);
  }
  if (!regex.test(value)) {
    throw new AwsError(
      'ParameterPatternMismatchException',
      `Parameter value, cannot be validated against allowedPattern: ${pattern}`,
    );
  }
}

// Standard holds 4 KB, Advanced 8 KB. Intelligent-Tiering picks the cheapest
// tier that fits. A parameter never moves back down: AWS refuses an explicit
// Advanced → Standard downgrade, and an omitted Tier keeps the current one.
function resolveTier(raw: unknown, value: string, previous: StoredTier | undefined): StoredTier {
  if (raw !== undefined && !TIERS.includes(raw as typeof TIERS[number])) {
    throw validation(`Tier ${String(raw)} is not valid. Valid values: ${TIERS.join(', ')}.`);
  }
  if (value.length > ADVANCED_VALUE_LIMIT) {
    throw validation(`Parameter value must be less than or equal to ${ADVANCED_VALUE_LIMIT} characters.`);
  }
  const needsAdvanced = value.length > STANDARD_VALUE_LIMIT || previous === 'Advanced';
  if (raw === 'Standard') {
    if (previous === 'Advanced') {
      throw validation('This parameter uses the advanced-parameter tier. You can\'t downgrade a parameter from the advanced-parameter tier to the standard-parameter tier.');
    }
    if (needsAdvanced) {
      throw validation(
        `Standard tier parameters support a maximum parameter value of ${STANDARD_VALUE_LIMIT} characters. ` +
          'To create a larger parameter value, upgrade the parameter to use the advanced-parameter tier.',
      );
    }
    return 'Standard';
  }
  if (raw === 'Advanced') return 'Advanced';
  return needsAdvanced ? 'Advanced' : 'Standard';
}

// See the header: an encrypted read without decryption gets an opaque,
// deterministic stand-in for the KMS ciphertext, never the plaintext.
function renderValue(name: string, version: ParameterVersion, withDecryption: boolean): string {
  if (version.type !== 'SecureString' || withDecryption) return version.value;
  const digest = createHash('sha256').update(`${name}\0${version.version}\0${version.value}`).digest();
  return Buffer.concat([Buffer.from('lss-ssm-securestring:'), digest]).toString('base64');
}

function isValidLabel(label: string): boolean {
  if (label.length === 0 || label.length > 100) return false;
  if (!LABEL_CHARS.test(label) || /^\d/.test(label)) return false;
  const lower = label.toLowerCase();
  return !lower.startsWith('aws') && !lower.startsWith('ssm');
}

// ParameterFilters. GetParametersByPath accepts Type / KeyId / Label /
// DataType; DescribeParameters adds Name, Path, Tier and `tag:<key>` but not
// Label. Options: Equals everywhere, BeginsWith / Contains for Name, and
// OneLevel / Recursive for Path.
function readFilters(raw: unknown, mode: 'by-path' | 'describe'): ParameterFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw validation('ParameterFilters must be a list.');
  const allowed = mode === 'by-path'
    ? ['Type', 'KeyId', 'Label', 'DataType']
    : ['Name', 'Type', 'KeyId', 'Path', 'Tier', 'DataType'];
  return raw.map((entry) => {
    const filter = entry as { Key?: unknown; Option?: unknown; Values?: unknown };
    const key = String(filter.Key ?? '');
    const isTag = mode === 'describe' && key.startsWith('tag:') && key.length > 4;
    if (!allowed.includes(key) && !isTag) {
      throw new AwsError('InvalidFilterKey', `The following filter key is not valid: ${key}`);
    }
    const defaultOption = key === 'Path' ? 'OneLevel' : 'Equals';
    const option = filter.Option === undefined ? defaultOption : String(filter.Option);
    const options = key === 'Name' ? ['Equals', 'BeginsWith', 'Contains'] : key === 'Path' ? ['OneLevel', 'Recursive'] : ['Equals'];
    if (!options.includes(option)) {
      throw new AwsError('InvalidFilterOption', `The filter option ${option} is not valid for key ${key}. Valid options: ${options.join(', ')}.`);
    }
    const values = Array.isArray(filter.Values) ? filter.Values.map(String) : [];
    if (values.length === 0 && !isTag) {
      throw new AwsError('InvalidFilterValue', `The filter key ${key} requires at least one value.`);
    }
    return { Key: key, Option: option, Values: values };
  });
}

function matchesFilter(filter: ParameterFilter, record: ParameterRecord, version: ParameterVersion): boolean {
  const { Key: key, Option: option, Values: values } = filter;
  switch (key) {
    case 'Name':
      return values.some((value) => {
        // AWS matches Name filters with or without the leading slash.
        const wanted = value.startsWith('/') || !record.name.startsWith('/') ? value : `/${value}`;
        if (option === 'BeginsWith') return record.name.startsWith(wanted);
        if (option === 'Contains') return record.name.includes(value);
        return record.name === wanted;
      });
    case 'Type': return values.includes(version.type);
    case 'KeyId': return version.keyId !== undefined && values.includes(version.keyId);
    case 'Tier': return values.includes(version.tier);
    case 'DataType': return values.includes(version.dataType);
    case 'Path':
      return values.some((value) => {
        const prefix = value.endsWith('/') ? value : `${value}/`;
        if (!record.name.startsWith(prefix)) return false;
        return option === 'Recursive' || !record.name.slice(prefix.length).includes('/');
      });
    default: {
      // tag:<key> — presence when no values are given, else value match.
      const tag = record.tags.find((t) => t.Key === key.slice(4));
      return tag !== undefined && (values.length === 0 || values.includes(tag.Value));
    }
  }
}

function readMaxResults(input: Record<string, unknown>, max: number): number {
  const raw = input.MaxResults;
  if (raw === undefined) return max;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) {
    throw validation(`1 validation error detected: Value '${String(raw)}' at 'maxResults' failed to satisfy constraint: Member must have value less than or equal to ${max}`);
  }
  return raw;
}

// NextToken is an opaque base64 offset into the (stably sorted) result list.
function paginate<T>(items: T[], rawToken: unknown, maxResults: number): { page: T[]; nextToken?: string } {
  let offset = 0;
  if (rawToken !== undefined) {
    const decoded = typeof rawToken === 'string' ? Buffer.from(rawToken, 'base64').toString('utf8') : '';
    const match = /^lss-ssm:(\d+)$/.exec(decoded);
    if (!match) throw new AwsError('InvalidNextToken', 'The specified token isn\'t valid.');
    offset = Number(match[1]);
  }
  const page = items.slice(offset, offset + maxResults);
  const next = offset + maxResults;
  return { page, nextToken: next < items.length ? Buffer.from(`lss-ssm:${next}`).toString('base64') : undefined };
}

function readTags(raw: unknown): ParameterTag[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((tag) => {
    const entry = tag as { Key?: unknown; Value?: unknown };
    // Key is required by the API model; Value may be empty.
    if (typeof entry.Key !== 'string' || entry.Key.length === 0) throw validation('Tag keys must be non-empty strings.');
    return { Key: entry.Key, Value: String(entry.Value ?? '') };
  });
}

function requireNameList(input: Record<string, unknown>, field: string): string[] {
  const raw = input[field];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NAMES_PER_BATCH || !raw.every((n) => typeof n === 'string')) {
    throw validation(`${field} must contain between 1 and ${MAX_NAMES_PER_BATCH} parameter names.`);
  }
  return raw as string[];
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw validation(`1 validation error detected: Value null at '${field.charAt(0).toLowerCase()}${field.slice(1)}' failed to satisfy constraint: Member must not be null`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === 'string' ? value : undefined;
}

// SSM timestamps are epoch seconds with millisecond precision (a float on the
// wire), unlike Secrets Manager's whole seconds.
function epochSeconds(ms: number): number {
  return ms / 1000;
}

function parameterNotFound(name: string): AwsError {
  return new AwsError('ParameterNotFound', `Parameter ${name} not found.`);
}

function tooManyTags(): AwsError {
  return new AwsError('TooManyTagsError', `The resource has too many tags. A parameter can have a maximum of ${MAX_TAGS} tags; remove one or more and try again.`);
}

function validation(message: string): AwsError {
  return new AwsError('ValidationException', message);
}
