// Vector search for the DynamoDB emulator: write-time validation of the
// vector / SearchSchema attributes, the per-index derived cache, scoring and
// the exact k-NN behind SearchVectors.
//
// Why exact (brute force) and not an ANN structure (HNSW, IVF…): recall is
// 100 % — a superset of AWS's "99 %+" — so no test that passes against AWS
// can fail locally because of recall, and at local-dev sizes it is fast
// (10 000 items × 1 536 dims is ~15 M multiply-adds, a few milliseconds).
//
// The cache exists so a search does not re-parse every `N` string of every
// embedding. It is:
//   - lazy: built on the first SearchVectors against an index (one pass over
//     the table) — a table that is never searched costs nothing, which is
//     what keeps a 40-service stack cheap;
//   - incremental: the emulator's single write funnel (recordChange, the same
//     place stream records are produced) feeds every put / update / delete /
//     TTL expiry / batch / transaction write into applyChange;
//   - never persisted: rebuilt from the base table after a restart, exactly
//     like AWS rebuilds an index after a restore.

import type { AttributeMap, AttributeValue } from '../../types.js';
import { validationError } from '../../http/errors.js';
import { normalizeDecimal } from './expressions/index.js';
import type { KeyAttribute, KeyAttributeType, TableRecord, VectorDistanceFunction, VectorIndexRecord } from './schema.js';
import { vectorIndexesOf, wireTypeOf } from './schema.js';

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

// Equality key for a HASH / inline-filter value: `<type>#<normalized text>`,
// so "01" and "1.0" match as numbers (AWS semantics) and an S "1" never
// matches an N 1. B is round-tripped through Buffer to normalize padding.
export function encodeSearchValue(type: KeyAttributeType, value: AttributeValue): string {
  const text = type === 'S' ? value.S!
    : type === 'N' ? normalizeDecimal(value.N!)
    : Buffer.from(value.B!, 'base64').toString('base64');
  return `${type}#${text}`;
}

// An L of N parsed to f32 components. Returns a string describing the problem
// instead of a vector, so write validation and the cache share one parser
// (the cache treats any problem as "not indexed").
function parseVector(value: AttributeValue, dimensions: number): Float32Array | 'shape' | 'dimensions' | 'range' {
  const list = value.L;
  if (!Array.isArray(list)) return 'shape';
  if (list.length !== dimensions) return 'dimensions';
  const vec = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    const raw = list[i]?.N;
    if (typeof raw !== 'string') return 'shape';
    // Values more precise than f32 are accepted (the base table keeps the
    // exact decimal); the index stores f32, which Float32Array does for us.
    const component = Math.fround(Number(raw));
    if (!Number.isFinite(component)) return 'range';
    vec[i] = component;
  }
  return vec;
}

function normOf(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

// ---------------------------------------------------------------------------
// Write validation (PutItem / UpdateItem / BatchWriteItem / TransactWriteItems)
// ---------------------------------------------------------------------------

/**
 * AWS rules for a write to a table with vector indexes (Developer Guide,
 * *Requirements and limitations*):
 *   - vector attribute present ⇒ must be an L of N with exactly `Dimensions`
 *     elements (else the write is rejected);
 *   - HASH attribute present with the wrong type ⇒ rejected;
 *   - HASH attribute missing ⇒ accepted, the item is silently not indexed;
 *   - inline filter missing ⇒ accepted and indexed;
 *   - vector attribute missing ⇒ accepted, not indexed (removing it from an
 *     item removes the index entry).
 */
export function validateVectorAttributes(record: TableRecord, item: AttributeMap): void {
  for (const index of vectorIndexesOf(record)) {
    const vector = item[index.vectorAttribute];
    if (vector !== undefined) {
      const parsed = parseVector(vector, index.dimensions);
      if (parsed === 'shape') {
        throw validationError(
          `One or more parameter values were invalid: The vector attribute ${index.vectorAttribute} must be a list of numbers ` +
          `for vector index ${index.indexName}`,
        );
      }
      if (parsed === 'dimensions') {
        throw validationError(
          `One or more parameter values were invalid: The vector attribute ${index.vectorAttribute} has ${vector.L!.length} ` +
          `dimensions, but vector index ${index.indexName} expects ${index.dimensions}`,
        );
      }
      if (parsed === 'range') {
        throw validationError(
          `One or more parameter values were invalid: The vector attribute ${index.vectorAttribute} contains a value outside ` +
          `the 32-bit floating point range (vector index ${index.indexName})`,
        );
      }
    }
    const hash = index.hashAttribute;
    if (hash && item[hash.name] !== undefined && wireTypeOf(item[hash.name]) !== hash.type) {
      throw validationError(
        `One or more parameter values were invalid: Type mismatch for Index Key ${hash.name} Expected: ${hash.type} ` +
        `Actual: ${wireTypeOf(item[hash.name])} IndexName: ${index.indexName}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The score AWS returns for one candidate. COSINE is the cosine DISTANCE
 * (1 − cos, 0..2, lower = closer), EUCLIDEAN the L2 distance (lower =
 * closer), DOT_PRODUCT the raw dot product (higher = closer, may be
 * negative). A zero-norm vector under COSINE has no direction; the emulator
 * scores it 1 (orthogonal) rather than NaN — a documented divergence, AWS
 * does not specify it.
 */
export function vectorScore(
  fn: VectorDistanceFunction,
  query: Float32Array,
  queryNorm: number,
  vec: Float32Array,
  norm: number,
): number {
  if (fn === 'EUCLIDEAN') {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) {
      const diff = query[i] - vec[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }
  let dot = 0;
  for (let i = 0; i < vec.length; i++) dot += query[i] * vec[i];
  if (fn === 'DOT_PRODUCT') return dot;
  if (queryNorm === 0 || norm === 0) return 1;
  return 1 - dot / (queryNorm * norm);
}

// Lower is better for the two distances, higher for the dot product.
export function scoreOrder(fn: VectorDistanceFunction): 1 | -1 {
  return fn === 'DOT_PRODUCT' ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Derived cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  vec: Float32Array;
  norm: number;
  hash?: string;
  // Inline-filter attribute → encoded value; missing filters are absent.
  filters: Map<string, string>;
  // TTL instant (ms) when the table has TTL on; lets a search skip (and
  // purge) expired items without loading them.
  expiresAtMs?: number;
}

interface IndexState {
  // Rebuild guards: a table deleted and recreated under the same name gets a
  // new tableId; an index deleted and recreated gets a new createdAtMs.
  tableId: string;
  createdAtMs: number;
  entries: Map<string, CacheEntry>;
  // Present for partitioned indexes (a HASH in the SearchSchema): a search
  // scoped by HASH scans only its partition, which mirrors AWS's own scaling
  // advice for vector indexes.
  partitions?: Map<string, Set<string>>;
}

export type ExpiryOf = (item: AttributeMap) => number | undefined;

/**
 * The cache entry for one item, or undefined when AWS would not index it:
 * no vector, a malformed vector (only possible for items written before the
 * index existed — writes validate it), or a missing / wrongly typed HASH.
 */
function entryFor(index: VectorIndexRecord, item: AttributeMap, expiryOf: ExpiryOf): CacheEntry | undefined {
  const vector = item[index.vectorAttribute];
  if (vector === undefined) return undefined;
  const vec = parseVector(vector, index.dimensions);
  if (typeof vec === 'string') return undefined;
  const entry: CacheEntry = { vec, norm: normOf(vec), filters: new Map() };
  if (index.hashAttribute) {
    const value = item[index.hashAttribute.name];
    if (wireTypeOf(value) !== index.hashAttribute.type) return undefined;
    entry.hash = encodeSearchValue(index.hashAttribute.type, value!);
  }
  for (const filter of index.inlineFilters) {
    const value = item[filter.name];
    // A filter of the wrong type can never equal a correctly typed search
    // value, so it is stored as absent.
    if (wireTypeOf(value) === filter.type) entry.filters.set(filter.name, encodeSearchValue(filter.type, value!));
  }
  const expiresAtMs = expiryOf(item);
  if (expiresAtMs !== undefined) entry.expiresAtMs = expiresAtMs;
  return entry;
}

// Whether DescribeTable counts the item in the index's ItemCount.
export function isIndexed(index: VectorIndexRecord, item: AttributeMap): boolean {
  return entryFor(index, item, () => undefined) !== undefined;
}

export interface SearchCandidate {
  key: string;
  score: number;
}

export interface SearchOptions {
  query: Float32Array;
  topK: number;
  hash?: string;
  filters: Array<[string, string]>;
  nowMs: number;
}

export interface SearchOutcome {
  results: SearchCandidate[];
  // Keys of cached items whose TTL passed; the emulator purges them (which
  // emits the TTL REMOVE stream record and, through recordChange, drops them
  // from this cache).
  expired: string[];
}

export class VectorIndexCache {
  private readonly states = new Map<string, IndexState>();

  private stateKey(region: string, tableName: string, indexName: string): string {
    return JSON.stringify([region, tableName, indexName]);
  }

  // Exposed for the tests: whether an index's cache has been built.
  isBuilt(region: string, tableName: string, indexName: string): boolean {
    return this.states.has(this.stateKey(region, tableName, indexName));
  }

  private insert(state: IndexState, key: string, entry: CacheEntry): void {
    state.entries.set(key, entry);
    if (state.partitions && entry.hash !== undefined) {
      let members = state.partitions.get(entry.hash);
      if (!members) {
        members = new Set();
        state.partitions.set(entry.hash, members);
      }
      members.add(key);
    }
  }

  private remove(state: IndexState, key: string): void {
    const previous = state.entries.get(key);
    if (!previous) return;
    state.entries.delete(key);
    if (state.partitions && previous.hash !== undefined) {
      const members = state.partitions.get(previous.hash)!;
      members.delete(key);
      if (members.size === 0) state.partitions.delete(previous.hash);
    }
  }

  /**
   * The write funnel's hook: one call per committed change of one item
   * (`newImage` undefined for a delete). Only indexes whose cache is already
   * built are touched — an unbuilt cache will read the item when it builds.
   */
  applyChange(region: string, record: TableRecord, key: string, newImage: AttributeMap | undefined, expiryOf: ExpiryOf): void {
    for (const index of vectorIndexesOf(record)) {
      const state = this.states.get(this.stateKey(region, record.tableName, index.indexName));
      if (!state) continue;
      this.remove(state, key);
      if (newImage === undefined) continue;
      const entry = entryFor(index, newImage, expiryOf);
      if (entry) this.insert(state, key, entry);
    }
  }

  dropTable(region: string, tableName: string): void {
    const prefix = JSON.stringify([region, tableName]).slice(0, -1) + ',';
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(prefix)) this.states.delete(key);
    }
  }

  dropIndex(region: string, tableName: string, indexName: string): void {
    this.states.delete(this.stateKey(region, tableName, indexName));
  }

  private stateFor(
    region: string,
    record: TableRecord,
    index: VectorIndexRecord,
    items: Iterable<[string, unknown]>,
    expiryOf: ExpiryOf,
  ): IndexState {
    const stateKey = this.stateKey(region, record.tableName, index.indexName);
    const current = this.states.get(stateKey);
    if (current && current.tableId === record.tableId && current.createdAtMs === index.createdAtMs) return current;
    const state: IndexState = { tableId: record.tableId, createdAtMs: index.createdAtMs, entries: new Map() };
    if (index.hashAttribute) state.partitions = new Map();
    for (const [key, value] of items) {
      const entry = entryFor(index, value as AttributeMap, expiryOf);
      if (entry) this.insert(state, key, entry);
    }
    this.states.set(stateKey, state);
    return state;
  }

  /**
   * Exact top-K over the index: score every candidate (only the HASH
   * partition when one is given), keep a bounded sorted list, tie-break on
   * the canonical item key so results are deterministic across runs.
   */
  search(
    region: string,
    record: TableRecord,
    index: VectorIndexRecord,
    items: Iterable<[string, unknown]>,
    expiryOf: ExpiryOf,
    options: SearchOptions,
  ): SearchOutcome {
    const state = this.stateFor(region, record, index, items, expiryOf);
    let keys: Iterable<string>;
    if (options.hash !== undefined) {
      keys = state.partitions!.get(options.hash) ?? [];
    } else {
      keys = state.entries.keys();
    }
    const order = scoreOrder(index.distanceFunction);
    const queryNorm = normOf(options.query);
    const top: SearchCandidate[] = [];
    const expired: string[] = [];
    const better = (a: SearchCandidate, b: SearchCandidate): boolean =>
      a.score !== b.score ? (a.score - b.score) * order < 0 : a.key < b.key;
    for (const key of keys) {
      const entry = state.entries.get(key)!;
      if (entry.expiresAtMs !== undefined && entry.expiresAtMs < options.nowMs) {
        expired.push(key);
        continue;
      }
      if (options.filters.some(([name, value]) => entry.filters.get(name) !== value)) continue;
      const candidate = { key, score: vectorScore(index.distanceFunction, options.query, queryNorm, entry.vec, entry.norm) };
      if (top.length === options.topK && !better(candidate, top[top.length - 1])) continue;
      // Sorted insert — K ≤ 100, so a linear scan beats any heap bookkeeping.
      let at = top.length;
      while (at > 0 && better(candidate, top[at - 1])) at--;
      top.splice(at, 0, candidate);
      if (top.length > options.topK) top.pop();
    }
    return { results: top, expired };
  }
}

// ---------------------------------------------------------------------------
// SearchVectors request parsing
// ---------------------------------------------------------------------------

export const MAX_TOP_K = 100;

export function parseSearchVector(raw: unknown, index: VectorIndexRecord): Float32Array {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError('One or more parameter values were invalid: SearchVector must be a non-empty list of numbers');
  }
  const parsed = parseVector({ L: raw as AttributeValue[] }, index.dimensions);
  if (parsed === 'shape' || parsed === 'range') {
    throw validationError('One or more parameter values were invalid: SearchVector must be a list of numbers ({"N": "…"})');
  }
  if (parsed === 'dimensions') {
    throw validationError(
      `One or more parameter values were invalid: SearchVector has ${raw.length} dimensions, ` +
      `but vector index ${index.indexName} expects ${index.dimensions}`,
    );
  }
  return parsed;
}

export function parseTopK(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_TOP_K) {
    throw validationError(`One or more parameter values were invalid: TopK must be an integer between 1 and ${MAX_TOP_K}`);
  }
  return raw;
}

/**
 * Turn the parsed SearchConditionExpression terms into the partition value
 * and inline-filter pairs. AWS: only `=` over top-level attributes that are
 * in the index's SearchSchema; the HASH attribute is mandatory when the index
 * defines one; each value must carry the attribute's declared type.
 */
export function resolveSearchCondition(
  index: VectorIndexRecord,
  terms: Array<{ name: string; value: AttributeValue }>,
): { hash?: string; filters: Array<[string, string]> } {
  const schema = new Map<string, KeyAttribute & { kind: 'HASH' | 'INLINE_FILTER' }>();
  if (index.hashAttribute) schema.set(index.hashAttribute.name, { ...index.hashAttribute, kind: 'HASH' });
  for (const filter of index.inlineFilters) schema.set(filter.name, { ...filter, kind: 'INLINE_FILTER' });
  let hash: string | undefined;
  const filters: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const attr = schema.get(term.name);
    if (!attr) {
      throw validationError(
        `Invalid SearchConditionExpression: The attribute ${term.name} is not part of the SearchSchema of vector index ${index.indexName}`,
      );
    }
    if (seen.has(term.name)) {
      throw validationError(`Invalid SearchConditionExpression: The attribute ${term.name} appears more than once`);
    }
    seen.add(term.name);
    if (wireTypeOf(term.value) !== attr.type) {
      throw validationError('One or more parameter values were invalid: Condition parameter type does not match schema type');
    }
    const encoded = encodeSearchValue(attr.type, term.value);
    if (attr.kind === 'HASH') hash = encoded;
    else filters.push([term.name, encoded]);
  }
  if (index.hashAttribute && hash === undefined) {
    throw validationError(
      `Invalid SearchConditionExpression: The partition attribute ${index.hashAttribute.name} of vector index ` +
      `${index.indexName} is required`,
    );
  }
  return { hash, filters };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Attributes a reader of the index may see: the table keys, the SearchSchema
 * attributes, the vector attribute, plus whatever the index projects
 * (`undefined` = ALL). The vector attribute is projected but only RETURNED
 * when the request names it in ProjectionExpression.
 */
export function projectedNames(record: TableRecord, index: VectorIndexRecord): Set<string> | undefined {
  if (index.projection.ProjectionType === 'ALL') return undefined;
  const names = new Set<string>(record.keySchema.map((el) => el.AttributeName));
  names.add(index.vectorAttribute);
  if (index.hashAttribute) names.add(index.hashAttribute.name);
  for (const filter of index.inlineFilters) names.add(filter.name);
  for (const name of index.projection.NonKeyAttributes ?? []) names.add(name);
  return names;
}

// The default result item: projected attributes minus the vector.
export function defaultResultItem(item: AttributeMap, projected: Set<string> | undefined, vectorAttribute: string): AttributeMap {
  const out: AttributeMap = {};
  for (const [name, value] of Object.entries(item)) {
    if (name === vectorAttribute) continue;
    if (projected && !projected.has(name)) continue;
    out[name] = structuredClone(value);
  }
  return out;
}
