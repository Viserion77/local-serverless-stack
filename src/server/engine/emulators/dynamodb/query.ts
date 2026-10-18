// Query/Scan engine: index resolution, key-condition matching, ordering,
// pagination (ExclusiveStartKey/LastEvaluatedKey) and index read semantics
// (sparse items, KEYS_ONLY/INCLUDE projections). Per PRD RF3.4, GSI/LSI
// queries are answered by scanning the base table — index semantics are
// enforced at read time, never maintained on write.

import type { AttributeMap, AttributeValue } from '../../types.js';
import { validationError } from '../../http/errors.js';
import {
  applyProjection, assertPlaceholdersUsed, attributeValuesEqual, compareAttributeValues,
  compileCondition, parseKeyCondition,
} from './expressions/index.js';
import { beginsWith } from './expressions/evaluate.js';
import type { CompiledCondition, ExpressionContext, SortKeyOperator } from './expressions/expression-types.js';
import type { IndexRecord, KeyAttribute, TableRecord } from './schema.js';
import { canonicalKey, itemSizeBytes, tableKeyAttrs, validateProvidedKey, wireTypeOf } from './schema.js';

// AWS caps one Query/Scan page at 1 MB of data READ — measured before the
// FilterExpression runs, so a selective filter over big items can return few
// (even zero) items plus a LastEvaluatedKey. Exported for the tests only.
export const MAX_PAGE_BYTES = 1024 * 1024;

export interface PageResult {
  // Absent when Select COUNT.
  items?: AttributeMap[];
  count: number;
  scannedCount: number;
  lastEvaluatedKey?: AttributeMap;
}

interface QueryScanWireInput {
  IndexName?: unknown;
  KeyConditionExpression?: unknown;
  FilterExpression?: unknown;
  ProjectionExpression?: unknown;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: AttributeMap;
  ScanIndexForward?: unknown;
  Limit?: unknown;
  ExclusiveStartKey?: unknown;
  Select?: unknown;
  ConsistentRead?: unknown;
}

// A "view" over the table: the base key schema or a GSI/LSI. `tuple` is the
// full ordering/pagination key — view keys then table keys, deduplicated —
// which is exactly what AWS puts in an index query's LastEvaluatedKey.
interface View {
  index?: IndexRecord;
  // True for a GSI (false for an LSI or the base table).
  global: boolean;
  pk: KeyAttribute;
  sk?: KeyAttribute;
  tuple: KeyAttribute[];
}

function resolveView(table: TableRecord, indexName: unknown): View {
  const tableKeys = tableKeyAttrs(table);
  if (indexName === undefined) {
    return { global: false, pk: tableKeys[0], sk: tableKeys[1], tuple: tableKeys };
  }
  const index = [...table.globalSecondaryIndexes, ...table.localSecondaryIndexes]
    .find((idx) => idx.indexName === indexName);
  if (!index) {
    throw validationError(`The table does not have the specified index: ${String(indexName)}`);
  }
  const types = new Map(table.attributeDefinitions.map((d) => [d.AttributeName, d.AttributeType]));
  const viewKeys = index.keySchema.map((el) => ({ name: el.AttributeName, type: types.get(el.AttributeName)! }));
  const tuple = [...viewKeys];
  for (const attr of tableKeys) {
    if (!tuple.some((t) => t.name === attr.name)) tuple.push(attr);
  }
  return { index, global: table.globalSecondaryIndexes.includes(index), pk: viewKeys[0], sk: viewKeys[1], tuple };
}

// GSIs are maintained asynchronously on AWS, so a strongly consistent read of
// one is impossible and the request is rejected outright. LSIs share the base
// table's partition and DO support ConsistentRead.
function assertReadConsistencySupported(view: View, input: QueryScanWireInput): void {
  if (input.ConsistentRead === true && view.global) {
    throw validationError('Consistent reads are not supported on global secondary indexes');
  }
}

// Sparse-index semantics: an item is visible in a view only when every view
// key attribute is present with the declared type.
function visibleInView(view: View, item: AttributeMap): boolean {
  return view.tuple.every(({ name, type }) => wireTypeOf(item[name]) === type);
}

export function indexHasItem(table: TableRecord, index: IndexRecord, item: AttributeMap): boolean {
  const types = new Map(table.attributeDefinitions.map((d) => [d.AttributeName, d.AttributeType]));
  return index.keySchema.every((el) => wireTypeOf(item[el.AttributeName]) === types.get(el.AttributeName));
}

function compareTuples(view: View, a: AttributeMap, b: AttributeMap): number {
  for (const { name } of view.tuple) {
    const cmp = compareAttributeValues(a[name]!, b[name]!);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function viewKeyOf(view: View, item: AttributeMap): AttributeMap {
  const key: AttributeMap = {};
  for (const { name } of view.tuple) key[name] = structuredClone(item[name]!);
  return key;
}

function readStartKey(view: View, raw: unknown): AttributeMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError('The provided starting key is invalid');
  }
  const key = raw as AttributeMap;
  for (const { name, type } of view.tuple) {
    if (wireTypeOf(key[name]) !== type) {
      throw validationError('The provided starting key is invalid');
    }
  }
  return key;
}

// Index projection applied at read: the base-table scan sees every attribute,
// but a GSI/LSI reader must only observe what the index projects.
function stripToProjection(view: View, item: AttributeMap): AttributeMap {
  if (!view.index || view.index.projection.ProjectionType === 'ALL') return structuredClone(item);
  const keep = new Set(view.tuple.map((attr) => attr.name));
  for (const name of view.index.projection.NonKeyAttributes ?? []) keep.add(name);
  const out: AttributeMap = {};
  for (const name of keep) {
    if (item[name] !== undefined) out[name] = structuredClone(item[name]);
  }
  return out;
}

function readLimit(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw validationError('Limit must be an integer greater than or equal to 1');
  }
  return raw;
}

// The classic parity rule pinned by tests: Limit counts items EXAMINED
// (ScannedCount) before FilterExpression, not items returned — and a page
// that stops exactly on the limit still carries a LastEvaluatedKey (AWS
// cannot know it was the last item; neither do we pretend to).
//
// The 1 MB page cap works the same way: every examined item adds its size
// (itemSizeBytes — attribute-name lengths plus value sizes, the AWS
// item-size formula approximated in schema.ts; for an index, the size of the
// projected index entry) BEFORE the filter runs. The item that reaches the
// cap is still part of the page — so progress is guaranteed even for
// 400 KB items — and the page then stops with a LastEvaluatedKey, unless that
// item was the last candidate (nothing left to page through).
function paginate(
  view: View,
  ordered: AttributeMap[],
  input: QueryScanWireInput,
  filter: CompiledCondition | undefined,
  ctx: ExpressionContext,
): PageResult {
  const limit = readLimit(input.Limit);
  const collected: AttributeMap[] = [];
  let scanned = 0;
  let readBytes = 0;
  let lastExamined: AttributeMap | undefined;
  let truncated = false;
  for (const item of ordered) {
    scanned++;
    lastExamined = item;
    const visible = stripToProjection(view, item);
    readBytes += itemSizeBytes(visible);
    if (!filter || filter.evaluate(visible)) collected.push(visible);
    if (limit !== undefined && scanned >= limit) {
      truncated = true;
      break;
    }
    if (readBytes >= MAX_PAGE_BYTES && scanned < ordered.length) {
      truncated = true;
      break;
    }
  }
  const result: PageResult = { count: collected.length, scannedCount: scanned };
  if (truncated && lastExamined) result.lastEvaluatedKey = viewKeyOf(view, lastExamined);
  if (input.Select !== 'COUNT') {
    result.items = typeof input.ProjectionExpression === 'string'
      ? collected.map((item) => applyProjection(input.ProjectionExpression as string, item, ctx))
      : collected;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Key condition resolution
// ---------------------------------------------------------------------------

interface ResolvedKeyCondition {
  pkValue: AttributeValue;
  sort?: { operator: SortKeyOperator; values: AttributeValue[] };
}

function resolveKeyCondition(view: View, expression: string, ctx: ExpressionContext): ResolvedKeyCondition {
  const parsed = parseKeyCondition(expression, ctx);
  let partition = parsed.partition;
  let sort = parsed.sort;
  // The parser designates the first `=` term as partition when both terms are
  // equalities — swap by schema when it guessed the sort key.
  if (partition.name !== view.pk.name && sort?.operator === '=' && sort.name === view.pk.name) {
    const previous = partition;
    partition = { name: sort.name, value: sort.values[0] };
    sort = { name: previous.name, operator: '=', values: [previous.value] };
  }
  if (partition.name !== view.pk.name) {
    throw validationError(`Query condition missed key schema element: ${view.pk.name}`);
  }
  if (wireTypeOf(partition.value) !== view.pk.type) {
    throw validationError('One or more parameter values were invalid: Condition parameter type does not match schema type');
  }
  if (!sort) return { pkValue: partition.value };
  if (!view.sk) throw validationError('Query key condition not supported');
  if (sort.name !== view.sk.name) {
    throw validationError(`Query condition missed key schema element: ${view.sk.name}`);
  }
  if (sort.operator === 'begins_with' && view.sk.type === 'N') {
    throw validationError('Function begins_with is only supported for the sort key of type String or Binary');
  }
  for (const value of sort.values) {
    if (wireTypeOf(value) !== view.sk.type) {
      throw validationError('One or more parameter values were invalid: Condition parameter type does not match schema type');
    }
  }
  return { pkValue: partition.value, sort: { operator: sort.operator, values: sort.values } };
}

function sortKeyMatches(condition: ResolvedKeyCondition['sort'], actual: AttributeValue): boolean {
  if (!condition) return true;
  const { operator, values } = condition;
  switch (operator) {
    case '=': return compareAttributeValues(actual, values[0]) === 0;
    case '<': return compareAttributeValues(actual, values[0]) < 0;
    case '<=': return compareAttributeValues(actual, values[0]) <= 0;
    case '>': return compareAttributeValues(actual, values[0]) > 0;
    case '>=': return compareAttributeValues(actual, values[0]) >= 0;
    case 'BETWEEN':
      return compareAttributeValues(actual, values[0]) >= 0 && compareAttributeValues(actual, values[1]) <= 0;
    case 'begins_with': return beginsWith(actual, values[0]);
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export function executeQuery(table: TableRecord, items: AttributeMap[], rawInput: Record<string, unknown>): PageResult {
  const input = rawInput as QueryScanWireInput;
  const view = resolveView(table, input.IndexName);
  assertReadConsistencySupported(view, input);
  const ctx: ExpressionContext = { names: input.ExpressionAttributeNames, values: input.ExpressionAttributeValues };
  if (typeof input.KeyConditionExpression !== 'string') {
    throw validationError('Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.');
  }
  assertPlaceholdersUsed(
    [input.KeyConditionExpression, input.FilterExpression as string | undefined, input.ProjectionExpression as string | undefined],
    ctx,
  );
  const condition = resolveKeyCondition(view, input.KeyConditionExpression, ctx);
  // AWS allows filtering on non-key attributes only; that validation is
  // intentionally skipped here (assumption flagged in the module report).
  const filter = typeof input.FilterExpression === 'string'
    ? compileCondition(input.FilterExpression, ctx, 'FilterExpression')
    : undefined;

  const forward = input.ScanIndexForward !== false;
  let candidates = items
    .filter((item) => visibleInView(view, item)
      && attributeValuesEqual(item[view.pk.name]!, condition.pkValue)
      && (!view.sk || sortKeyMatches(condition.sort, item[view.sk.name]!)))
    .sort((a, b) => compareTuples(view, a, b));
  if (!forward) candidates.reverse();

  if (input.ExclusiveStartKey !== undefined) {
    const startKey = readStartKey(view, input.ExclusiveStartKey);
    const startIndex = candidates.findIndex((item) => (forward
      ? compareTuples(view, item, startKey) > 0
      : compareTuples(view, item, startKey) < 0));
    candidates = startIndex === -1 ? [] : candidates.slice(startIndex);
  }
  return paginate(view, candidates, input, filter, ctx);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

// Segment/TotalSegments are accepted and ignored: the store is a single
// insertion-ordered map, so parallel-scan hints have nothing to shard.
export function executeScan(table: TableRecord, items: AttributeMap[], rawInput: Record<string, unknown>): PageResult {
  const input = rawInput as QueryScanWireInput;
  const view = resolveView(table, input.IndexName);
  assertReadConsistencySupported(view, input);
  const ctx: ExpressionContext = { names: input.ExpressionAttributeNames, values: input.ExpressionAttributeValues };
  assertPlaceholdersUsed(
    [input.FilterExpression as string | undefined, input.ProjectionExpression as string | undefined],
    ctx,
  );
  const filter = typeof input.FilterExpression === 'string'
    ? compileCondition(input.FilterExpression, ctx, 'FilterExpression')
    : undefined;

  let candidates = items.filter((item) => visibleInView(view, item));
  // Base-table scan order is the store's insertion order; index scans sort by
  // the view tuple so ExclusiveStartKey positioning is deterministic.
  if (view.index) candidates.sort((a, b) => compareTuples(view, a, b));

  if (input.ExclusiveStartKey !== undefined) {
    const startKey = readStartKey(view, input.ExclusiveStartKey);
    if (view.index) {
      const startIndex = candidates.findIndex((item) => compareTuples(view, item, startKey) > 0);
      candidates = startIndex === -1 ? [] : candidates.slice(startIndex);
    } else {
      // Positional match on the canonical key. If the marker item was deleted
      // mid-pagination the scan restarts from the top (dev-tool trade-off).
      validateProvidedKey(table, startKey);
      const marker = canonicalKey(table, startKey);
      const markerIndex = candidates.findIndex((item) => canonicalKey(table, item) === marker);
      if (markerIndex !== -1) candidates = candidates.slice(markerIndex + 1);
    }
  }
  return paginate(view, candidates, input, filter, ctx);
}
