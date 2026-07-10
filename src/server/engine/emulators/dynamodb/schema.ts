// Table metadata for the DynamoDB emulator: CreateTable validation into a
// persisted TableRecord, key extraction/validation against the schema, the
// canonical item-key encoding used by the ItemTable, ARN builders and the
// AWS-style item size estimate that backs the 400 KB limit.

import crypto from 'crypto';
import type { AttributeMap, AttributeValue } from '../../types.js';
import { validationError } from '../../http/errors.js';
import { normalizeDecimal } from './expressions/index.js';

export type KeyAttributeType = 'S' | 'N' | 'B';
export type StreamViewType = 'KEYS_ONLY' | 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES';

export interface KeySchemaElement {
  AttributeName: string;
  KeyType: 'HASH' | 'RANGE';
}

export interface AttributeDefinition {
  AttributeName: string;
  AttributeType: KeyAttributeType;
}

export interface ProjectionRecord {
  ProjectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE';
  NonKeyAttributes?: string[];
}

export interface IndexRecord {
  indexName: string;
  keySchema: KeySchemaElement[];
  projection: ProjectionRecord;
}

export interface TableRecord {
  tableName: string;
  tableId: string;
  createdAtMs: number;
  keySchema: KeySchemaElement[];
  attributeDefinitions: AttributeDefinition[];
  billingMode: 'PROVISIONED' | 'PAY_PER_REQUEST';
  readCapacityUnits: number;
  writeCapacityUnits: number;
  globalSecondaryIndexes: IndexRecord[];
  localSecondaryIndexes: IndexRecord[];
  streamSpecification?: { StreamEnabled: boolean; StreamViewType: StreamViewType };
  latestStreamLabel?: string;
  ttl?: { attributeName: string; enabled: boolean };
}

export interface KeyAttribute {
  name: string;
  type: KeyAttributeType;
}

const NAME_PATTERN = /^[a-zA-Z0-9_.-]{3,255}$/;
const INVALID_NAME_MESSAGE =
  'Invalid table/index name. Table/index names must be between 3 and 255 characters long, ' +
  "and may contain only the characters a-z, A-Z, 0-9, '_' (underscore), '-' (dash), and '.' (dot)";
const STREAM_VIEW_TYPES: StreamViewType[] = ['KEYS_ONLY', 'NEW_IMAGE', 'OLD_IMAGE', 'NEW_AND_OLD_IMAGES'];
const MAX_ITEM_BYTES = 400 * 1024;

// ---------------------------------------------------------------------------
// ARNs
// ---------------------------------------------------------------------------

export function tableArnFor(account: string, region: string, tableName: string): string {
  return `arn:aws:dynamodb:${region}:${account}:table/${tableName}`;
}

export function streamArnFor(account: string, region: string, record: TableRecord): string {
  return `${tableArnFor(account, region, record.tableName)}/stream/${record.latestStreamLabel}`;
}

// ---------------------------------------------------------------------------
// CreateTable validation
// ---------------------------------------------------------------------------

interface CreateTableWireInput {
  TableName?: unknown;
  KeySchema?: unknown;
  AttributeDefinitions?: unknown;
  BillingMode?: unknown;
  ProvisionedThroughput?: { ReadCapacityUnits?: unknown; WriteCapacityUnits?: unknown };
  GlobalSecondaryIndexes?: unknown;
  LocalSecondaryIndexes?: unknown;
  StreamSpecification?: { StreamEnabled?: unknown; StreamViewType?: unknown };
}

function parseAttributeDefinitions(raw: unknown): AttributeDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError('One or more parameter values were invalid: AttributeDefinitions must not be empty');
  }
  return raw.map((def: { AttributeName?: unknown; AttributeType?: unknown }) => {
    const name = def?.AttributeName;
    const type = def?.AttributeType;
    if (typeof name !== 'string' || name.length === 0 || (type !== 'S' && type !== 'N' && type !== 'B')) {
      throw validationError('One or more parameter values were invalid: AttributeType must be one of S, N or B');
    }
    return { AttributeName: name, AttributeType: type };
  });
}

// AWS also rejects AttributeDefinitions entries not used by any key — the
// provisioner only ever defines key attributes, so extras are tolerated here.
function parseKeySchema(raw: unknown, defined: Map<string, KeyAttributeType>, where: string): KeySchemaElement[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) {
    throw validationError(`One or more parameter values were invalid: Invalid KeySchema on ${where}: 1 or 2 key elements required`);
  }
  const elements = raw as Array<{ AttributeName?: unknown; KeyType?: unknown }>;
  if (elements[0]?.KeyType !== 'HASH') {
    throw validationError('Invalid KeySchema: The first KeySchemaElement is not a HASH key type');
  }
  if (elements.length === 2 && elements[1]?.KeyType !== 'RANGE') {
    throw validationError('Invalid KeySchema: The second KeySchemaElement is not a RANGE key type');
  }
  return elements.map((el) => {
    const name = el.AttributeName;
    if (typeof name !== 'string' || name.length === 0) {
      throw validationError(`One or more parameter values were invalid: Invalid KeySchema on ${where}: AttributeName is required`);
    }
    if (!defined.has(name)) {
      throw validationError(
        'One or more parameter values were invalid: Some index key attributes are not defined in AttributeDefinitions. ' +
        `Keys: [${name}], AttributeDefinitions: [${[...defined.keys()].join(', ')}]`,
      );
    }
    return { AttributeName: name, KeyType: el.KeyType as 'HASH' | 'RANGE' };
  });
}

function parseProjection(raw: unknown): ProjectionRecord {
  const wire = raw as { ProjectionType?: unknown; NonKeyAttributes?: unknown } | undefined;
  const type = wire?.ProjectionType ?? 'ALL';
  if (type !== 'ALL' && type !== 'KEYS_ONLY' && type !== 'INCLUDE') {
    throw validationError('One or more parameter values were invalid: ProjectionType must be one of ALL, KEYS_ONLY or INCLUDE');
  }
  const projection: ProjectionRecord = { ProjectionType: type };
  if (type === 'INCLUDE') {
    if (!Array.isArray(wire?.NonKeyAttributes) || wire.NonKeyAttributes.length === 0) {
      throw validationError('One or more parameter values were invalid: NonKeyAttributes is required when ProjectionType is INCLUDE');
    }
    projection.NonKeyAttributes = wire.NonKeyAttributes.map(String);
  }
  return projection;
}

function parseIndexes(
  raw: unknown,
  defined: Map<string, KeyAttributeType>,
  seenNames: Set<string>,
  kind: 'GSI' | 'LSI',
  tableHashAttr: string,
): IndexRecord[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw validationError(`One or more parameter values were invalid: ${kind === 'GSI' ? 'GlobalSecondaryIndexes' : 'LocalSecondaryIndexes'} must be a list`);
  }
  return raw.map((idx: { IndexName?: unknown; KeySchema?: unknown; Projection?: unknown }) => {
    const indexName = idx?.IndexName;
    if (typeof indexName !== 'string' || !NAME_PATTERN.test(indexName)) {
      throw validationError(INVALID_NAME_MESSAGE);
    }
    if (seenNames.has(indexName)) {
      throw validationError(`One or more parameter values were invalid: Duplicate index name: ${indexName}`);
    }
    seenNames.add(indexName);
    const keySchema = parseKeySchema(idx.KeySchema, defined, indexName);
    if (kind === 'LSI') {
      if (keySchema[0].AttributeName !== tableHashAttr) {
        throw validationError('One or more parameter values were invalid: Index KeySchema does not have the same leading hash key as table KeySchema');
      }
      if (keySchema.length !== 2) {
        throw validationError('One or more parameter values were invalid: Local secondary indexes must have a range key');
      }
    }
    return { indexName, keySchema, projection: parseProjection(idx.Projection) };
  });
}

export function buildTableRecord(input: Record<string, unknown>): TableRecord {
  const wire = input as CreateTableWireInput;
  if (typeof wire.TableName !== 'string' || !NAME_PATTERN.test(wire.TableName)) {
    throw validationError(INVALID_NAME_MESSAGE);
  }
  const attributeDefinitions = parseAttributeDefinitions(wire.AttributeDefinitions);
  const defined = new Map(attributeDefinitions.map((d) => [d.AttributeName, d.AttributeType]));
  const keySchema = parseKeySchema(wire.KeySchema, defined, wire.TableName);

  const seenIndexNames = new Set<string>();
  const globalSecondaryIndexes = parseIndexes(wire.GlobalSecondaryIndexes, defined, seenIndexNames, 'GSI', keySchema[0].AttributeName);
  const localSecondaryIndexes = parseIndexes(wire.LocalSecondaryIndexes, defined, seenIndexNames, 'LSI', keySchema[0].AttributeName);

  if (wire.BillingMode !== undefined && wire.BillingMode !== 'PROVISIONED' && wire.BillingMode !== 'PAY_PER_REQUEST') {
    throw validationError('One or more parameter values were invalid: BillingMode must be one of PROVISIONED, PAY_PER_REQUEST');
  }
  const billingMode = wire.BillingMode === 'PAY_PER_REQUEST' ? 'PAY_PER_REQUEST' : 'PROVISIONED';
  // AWS requires ProvisionedThroughput with PROVISIONED; local dev tolerates
  // its absence with a small default instead of failing the registration.
  const readCapacityUnits = billingMode === 'PROVISIONED' ? Number(wire.ProvisionedThroughput?.ReadCapacityUnits ?? 5) : 0;
  const writeCapacityUnits = billingMode === 'PROVISIONED' ? Number(wire.ProvisionedThroughput?.WriteCapacityUnits ?? 5) : 0;

  const record: TableRecord = {
    tableName: wire.TableName,
    tableId: crypto.randomUUID(),
    createdAtMs: Date.now(),
    keySchema,
    attributeDefinitions,
    billingMode,
    readCapacityUnits,
    writeCapacityUnits,
    globalSecondaryIndexes,
    localSecondaryIndexes,
  };

  if (wire.StreamSpecification?.StreamEnabled === true) {
    const viewType = wire.StreamSpecification.StreamViewType;
    if (typeof viewType !== 'string' || !STREAM_VIEW_TYPES.includes(viewType as StreamViewType)) {
      throw validationError('One or more parameter values were invalid: StreamViewType must be one of KEYS_ONLY, NEW_IMAGE, OLD_IMAGE, NEW_AND_OLD_IMAGES');
    }
    record.streamSpecification = { StreamEnabled: true, StreamViewType: viewType as StreamViewType };
    // AWS stream labels are ISO-8601 without the trailing Z.
    record.latestStreamLabel = new Date().toISOString().replace(/Z$/, '');
  }
  return record;
}

// ---------------------------------------------------------------------------
// Key validation / extraction
// ---------------------------------------------------------------------------

export function tableKeyAttrs(record: TableRecord): KeyAttribute[] {
  const types = new Map(record.attributeDefinitions.map((d) => [d.AttributeName, d.AttributeType]));
  return record.keySchema.map((el) => ({ name: el.AttributeName, type: types.get(el.AttributeName)! }));
}

export function wireTypeOf(value: AttributeValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  for (const tag of ['S', 'N', 'B', 'BOOL', 'NULL', 'L', 'M', 'SS', 'NS', 'BS'] as const) {
    if (value[tag] !== undefined) return tag;
  }
  return undefined;
}

function keyValueIsEmpty(type: KeyAttributeType, value: AttributeValue): boolean {
  return (type === 'S' && value.S === '') || (type === 'B' && value.B === '');
}

// PutItem/BatchWriteItem item validation: key attributes present, typed per
// the schema and non-empty. AWS-worded errors.
export function validateItemKey(record: TableRecord, item: AttributeMap): void {
  for (const { name, type } of tableKeyAttrs(record)) {
    const value = item[name];
    if (value === undefined) {
      throw validationError(`One or more parameter values were invalid: Missing the key ${name} in the item`);
    }
    const actual = wireTypeOf(value);
    if (actual !== type) {
      throw validationError(`One or more parameter values were invalid: Type mismatch for key ${name} expected: ${type} actual: ${actual}`);
    }
    if (keyValueIsEmpty(type, value)) {
      throw validationError(`One or more parameter values were invalid: The AttributeValue for a key attribute cannot contain an empty string value. Key: ${name}`);
    }
  }
}

// Key-parameter validation for GetItem/DeleteItem/UpdateItem/BatchGetItem.
export function validateProvidedKey(record: TableRecord, key: unknown): AttributeMap {
  if (key === undefined || key === null || typeof key !== 'object' || Array.isArray(key)) {
    throw validationError('One of the required keys was not given a value');
  }
  const keyMap = key as AttributeMap;
  const attrs = tableKeyAttrs(record);
  const allowed = new Set(attrs.map((a) => a.name));
  for (const name of Object.keys(keyMap)) {
    if (!allowed.has(name)) throw validationError('The provided key element does not match the schema');
  }
  for (const { name, type } of attrs) {
    const value = keyMap[name];
    if (value === undefined) throw validationError('One of the required keys was not given a value');
    if (wireTypeOf(value) !== type || keyValueIsEmpty(type, value)) {
      throw validationError('The provided key element does not match the schema');
    }
  }
  return keyMap;
}

// ---------------------------------------------------------------------------
// Canonical key encoding
// ---------------------------------------------------------------------------

// Stable, collision-free map key: every component is length-prefixed
// (`<type>#<length>#<value>`) and components are joined with `|`, so no value
// bytes can be confused with the separators. N is normalized (sign kept,
// leading/trailing zeros stripped) so "01" and "1.0" collide as AWS requires;
// B is round-tripped through Buffer to normalize base64 padding.
export function canonicalKey(record: TableRecord, source: AttributeMap): string {
  return tableKeyAttrs(record)
    .map(({ name, type }) => {
      const value = source[name]!;
      const text = type === 'S' ? value.S!
        : type === 'N' ? normalizeDecimal(value.N!)
        : Buffer.from(value.B!, 'base64').toString('base64');
      return `${type}#${text.length}#${text}`;
    })
    .join('|');
}

// The table-key attributes of an item, deep-cloned (stream Keys / LEK material).
export function keyMapOf(record: TableRecord, item: AttributeMap): AttributeMap {
  const key: AttributeMap = {};
  for (const { name } of tableKeyAttrs(record)) key[name] = structuredClone(item[name]!);
  return key;
}

// ---------------------------------------------------------------------------
// Item size (approximation of the AWS storage-size formula)
// ---------------------------------------------------------------------------

function valueSizeBytes(value: AttributeValue): number {
  if (value.S !== undefined) return Buffer.byteLength(value.S);
  if (value.N !== undefined) return value.N.length;
  if (value.B !== undefined) return Buffer.from(value.B, 'base64').length;
  if (value.BOOL !== undefined || value.NULL !== undefined) return 1;
  if (value.SS !== undefined) return value.SS.reduce((sum, m) => sum + Buffer.byteLength(m), 0);
  if (value.NS !== undefined) return value.NS.reduce((sum, m) => sum + m.length, 0);
  if (value.BS !== undefined) return value.BS.reduce((sum, m) => sum + Buffer.from(m, 'base64').length, 0);
  if (value.L !== undefined) return 3 + value.L.reduce((sum, el) => sum + 1 + valueSizeBytes(el), 0);
  if (value.M !== undefined) {
    return 3 + Object.entries(value.M).reduce((sum, [name, el]) => sum + Buffer.byteLength(name) + valueSizeBytes(el) + 1, 0);
  }
  return 0;
}

export function itemSizeBytes(item: AttributeMap): number {
  let total = 0;
  for (const [name, value] of Object.entries(item)) {
    total += Buffer.byteLength(name) + valueSizeBytes(value);
  }
  return total;
}

export function assertItemSize(item: AttributeMap): void {
  if (itemSizeBytes(item) > MAX_ITEM_BYTES) {
    throw validationError('Item size has exceeded the maximum allowed size');
  }
}

// ---------------------------------------------------------------------------
// Legacy (pre-expression) parameters — explicit rejection per PRD RF3.6
// ---------------------------------------------------------------------------

const LEGACY_REPLACEMENT: Record<string, string> = {
  AttributeUpdates: 'UpdateExpression',
  Expected: 'ConditionExpression',
  KeyConditions: 'KeyConditionExpression',
  QueryFilter: 'FilterExpression',
  ScanFilter: 'FilterExpression',
  AttributesToGet: 'ProjectionExpression',
  ConditionalOperator: 'expression operators (AND/OR)',
};

export function rejectLegacyParams(input: Record<string, unknown>, params: string[]): void {
  for (const param of params) {
    if (input[param] !== undefined) {
      throw validationError(
        `The legacy parameter ${param} is not supported by the LSS self engine — use ${LEGACY_REPLACEMENT[param]} instead`,
      );
    }
  }
}
