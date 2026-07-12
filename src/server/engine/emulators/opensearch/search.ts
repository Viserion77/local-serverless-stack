// OpenSearch query-DSL subset evaluated in memory over hydrated documents.
// Supported: match_all, match, match_phrase, multi_match, term, terms, range,
// prefix, wildcard, exists, ids, bool (must/filter/should/must_not with
// minimum_should_match). Aggregations: terms + avg/sum/min/max/value_count.
// Anything else throws a plain Error naming the operator — the emulator wraps
// it into an OpenSearch-shaped 400 (never a silent empty result).
//
// Fidelity bar (a dev tool, like events/pattern.ts): no analyzers or scoring —
// text matching tokenizes on non-alphanumerics and lowercases, `_score` is a
// constant 1, and range comparisons are numeric when both sides are numbers,
// lexicographic otherwise (ISO dates compare correctly).

export interface SearchHitDoc {
  index: string;
  id: string;
  source: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Field resolution (dot paths, arrays flattened at every hop)
// ---------------------------------------------------------------------------

export function resolveField(source: unknown, path: string): unknown[] {
  let current: unknown[] = [source];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const value of current) {
      const stepped = Array.isArray(value) ? value : [value];
      for (const item of stepped) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const child = (item as Record<string, unknown>)[segment];
          if (child !== undefined) next.push(child);
        }
      }
    }
    current = next;
  }
  // Leaf arrays act as multi-valued fields, like OpenSearch.
  return current.flatMap(value => (Array.isArray(value) ? value : [value]));
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

function fieldTokens(values: unknown[]): string[] {
  return values.flatMap(value => (typeof value === 'string' ? tokenize(value) : [String(value).toLowerCase()]));
}

// ---------------------------------------------------------------------------
// Query evaluation
// ---------------------------------------------------------------------------

type QueryClause = Record<string, unknown>;

function singleEntry(clause: unknown, operator: string): [string, unknown] {
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) {
    throw new Error(`the ${operator} query expects an object with a single field`);
  }
  const entries = Object.entries(clause as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new Error(`the ${operator} query expects exactly one field, got ${entries.length}`);
  }
  return entries[0];
}

export function matchesQuery(query: unknown, doc: SearchHitDoc): boolean {
  if (query === undefined || query === null) return true;
  const [type, clause] = singleEntry(query, 'top-level');
  switch (type) {
    case 'match_all':
      return true;
    case 'match':
      return evalMatch(clause, doc, false);
    case 'match_phrase':
      return evalMatch(clause, doc, true);
    case 'multi_match':
      return evalMultiMatch(clause, doc);
    case 'term':
      return evalTerm(clause, doc);
    case 'terms':
      return evalTerms(clause, doc);
    case 'range':
      return evalRange(clause, doc);
    case 'prefix':
      return evalPrefix(clause, doc);
    case 'wildcard':
      return evalWildcard(clause, doc);
    case 'exists':
      return evalExists(clause, doc);
    case 'ids':
      return evalIds(clause, doc);
    case 'bool':
      return evalBool(clause, doc);
    default:
      throw new Error(`the "${type}" query is not supported by the LSS self engine — see docs/SELF_ENGINE.md#coverage`);
  }
}

function evalMatch(clause: unknown, doc: SearchHitDoc, phrase: boolean): boolean {
  const [field, spec] = singleEntry(clause, phrase ? 'match_phrase' : 'match');
  let text: string;
  let operator = 'or';
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    const options = spec as Record<string, unknown>;
    text = String(options.query ?? '');
    if (typeof options.operator === 'string') operator = options.operator.toLowerCase();
  } else {
    text = String(spec ?? '');
  }
  const queryTokens = tokenize(text);
  if (queryTokens.length === 0) return false;
  const docTokens = fieldTokens(resolveField(doc.source, field));
  if (phrase) return hasContiguousSubsequence(docTokens, queryTokens);
  const present = queryTokens.filter(token => docTokens.includes(token));
  return operator === 'and' ? present.length === queryTokens.length : present.length > 0;
}

function hasContiguousSubsequence(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function evalMultiMatch(clause: unknown, doc: SearchHitDoc): boolean {
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) {
    throw new Error('the multi_match query expects an object with "query" and "fields"');
  }
  const options = clause as Record<string, unknown>;
  const fields = options.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('the multi_match query requires a non-empty "fields" array');
  }
  // "*" expands to every top-level field (the shape `?q=<text>` produces).
  const expanded = fields.flatMap(field => (field === '*' ? Object.keys(doc.source) : [String(field)]));
  return expanded.some(field => evalMatch({ [field]: options.query }, doc, false));
}

// Term is exact-value comparison on the raw (unanalyzed) value; numbers and
// their string forms compare equal so `term: {price: "10"}` behaves sanely.
function termEquals(candidate: unknown, expected: unknown): boolean {
  if (candidate === expected) return true;
  if (typeof candidate === 'number' || typeof expected === 'number') {
    return Number(candidate) === Number(expected) && candidate !== null && expected !== null;
  }
  return false;
}

function evalTerm(clause: unknown, doc: SearchHitDoc): boolean {
  const [field, spec] = singleEntry(clause, 'term');
  const expected =
    spec !== null && typeof spec === 'object' && !Array.isArray(spec)
      ? (spec as Record<string, unknown>).value
      : spec;
  return resolveField(doc.source, field).some(value => termEquals(value, expected));
}

function evalTerms(clause: unknown, doc: SearchHitDoc): boolean {
  const [field, expected] = singleEntry(clause, 'terms');
  if (!Array.isArray(expected)) {
    throw new Error('the terms query expects an array of values');
  }
  const values = resolveField(doc.source, field);
  return expected.some(candidate => values.some(value => termEquals(value, candidate)));
}

function compareForRange(value: unknown, bound: unknown): number | undefined {
  const numericValue = typeof value === 'number' ? value : Number(value);
  const numericBound = typeof bound === 'number' ? bound : Number(bound);
  if (!Number.isNaN(numericValue) && !Number.isNaN(numericBound)) {
    return numericValue - numericBound;
  }
  const left = String(value);
  const right = String(bound);
  return left < right ? -1 : left > right ? 1 : 0;
}

function evalRange(clause: unknown, doc: SearchHitDoc): boolean {
  const [field, spec] = singleEntry(clause, 'range');
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('the range query expects an object of bounds (gt/gte/lt/lte)');
  }
  const bounds = spec as Record<string, unknown>;
  for (const key of Object.keys(bounds)) {
    if (!['gt', 'gte', 'lt', 'lte'].includes(key)) {
      throw new Error(`the range bound "${key}" is not supported by the LSS self engine (use gt/gte/lt/lte)`);
    }
  }
  return resolveField(doc.source, field).some(value => {
    if (value === null || value === undefined) return false;
    if (bounds.gt !== undefined && (compareForRange(value, bounds.gt) ?? 0) <= 0) return false;
    if (bounds.gte !== undefined && (compareForRange(value, bounds.gte) ?? 0) < 0) return false;
    if (bounds.lt !== undefined && (compareForRange(value, bounds.lt) ?? 0) >= 0) return false;
    if (bounds.lte !== undefined && (compareForRange(value, bounds.lte) ?? 0) > 0) return false;
    return true;
  });
}

function evalPrefix(clause: unknown, doc: SearchHitDoc): boolean {
  const [field, spec] = singleEntry(clause, 'prefix');
  const prefix =
    spec !== null && typeof spec === 'object' && !Array.isArray(spec)
      ? String((spec as Record<string, unknown>).value ?? '')
      : String(spec ?? '');
  return resolveField(doc.source, field).some(
    value => typeof value === 'string' && value.toLowerCase().startsWith(prefix.toLowerCase()),
  );
}

function evalWildcard(clause: unknown, doc: SearchHitDoc): boolean {
  const [field, spec] = singleEntry(clause, 'wildcard');
  const pattern =
    spec !== null && typeof spec === 'object' && !Array.isArray(spec)
      ? String((spec as Record<string, unknown>).value ?? '')
      : String(spec ?? '');
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return resolveField(doc.source, field).some(value => typeof value === 'string' && regex.test(value));
}

function evalExists(clause: unknown, doc: SearchHitDoc): boolean {
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) {
    throw new Error('the exists query expects an object with a "field"');
  }
  const field = (clause as Record<string, unknown>).field;
  if (typeof field !== 'string') throw new Error('the exists query requires a string "field"');
  return resolveField(doc.source, field).some(value => value !== null && value !== undefined);
}

function evalIds(clause: unknown, doc: SearchHitDoc): boolean {
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) {
    throw new Error('the ids query expects an object with "values"');
  }
  const values = (clause as Record<string, unknown>).values;
  if (!Array.isArray(values)) throw new Error('the ids query requires a "values" array');
  return values.map(String).includes(doc.id);
}

function asClauseArray(raw: unknown): QueryClause[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]) as QueryClause[];
}

function evalBool(clause: unknown, doc: SearchHitDoc): boolean {
  if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) {
    throw new Error('the bool query expects an object of occurrence clauses');
  }
  const options = clause as Record<string, unknown>;
  const must = asClauseArray(options.must);
  const filter = asClauseArray(options.filter);
  const should = asClauseArray(options.should);
  const mustNot = asClauseArray(options.must_not);

  if (!must.every(sub => matchesQuery(sub, doc))) return false;
  if (!filter.every(sub => matchesQuery(sub, doc))) return false;
  if (mustNot.some(sub => matchesQuery(sub, doc))) return false;

  if (should.length > 0) {
    const matched = should.filter(sub => matchesQuery(sub, doc)).length;
    // OpenSearch default: should is optional when must/filter exist, required
    // (>= 1) otherwise; an explicit minimum_should_match always wins.
    const raw = options.minimum_should_match;
    const minimum = raw !== undefined ? Number(raw) : must.length + filter.length > 0 ? 0 : 1;
    if (Number.isNaN(minimum)) {
      throw new Error('minimum_should_match must be a number (percentages are not supported by the LSS self engine)');
    }
    if (matched < minimum) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

interface SortKey {
  field: string;
  order: 'asc' | 'desc';
}

export function normalizeSort(raw: unknown): SortKey[] {
  if (raw === undefined) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  const keys: SortKey[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      keys.push({ field: entry, order: entry === '_score' ? 'desc' : 'asc' });
      continue;
    }
    const [field, spec] = singleEntry(entry, 'sort');
    const order =
      spec !== null && typeof spec === 'object' && !Array.isArray(spec)
        ? String((spec as Record<string, unknown>).order ?? 'asc')
        : String(spec ?? 'asc');
    if (order !== 'asc' && order !== 'desc') {
      throw new Error(`sort order must be "asc" or "desc", got "${order}"`);
    }
    keys.push({ field, order });
  }
  return keys;
}

function sortValue(doc: SearchHitDoc, field: string): unknown {
  // _score is a constant 1 in the LSS engine, so it never reorders; _id gives
  // a stable explicit tiebreaker.
  if (field === '_score') return 1;
  if (field === '_id') return doc.id;
  return resolveField(doc.source, field)[0];
}

export function sortHits(hits: SearchHitDoc[], keys: SortKey[]): SearchHitDoc[] {
  if (keys.length === 0) return hits;
  return [...hits].sort((a, b) => {
    for (const key of keys) {
      const left = sortValue(a, key.field);
      const right = sortValue(b, key.field);
      if (left === right) continue;
      // Missing values sort last regardless of direction, like OpenSearch's
      // default missing:_last.
      if (left === undefined || left === null) return 1;
      if (right === undefined || right === null) return -1;
      const comparison =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left) < String(right)
            ? -1
            : 1;
      if (comparison !== 0) return key.order === 'asc' ? comparison : -comparison;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// _source filtering
// ---------------------------------------------------------------------------

export function filterSource(source: Record<string, unknown>, spec: unknown): Record<string, unknown> | undefined {
  if (spec === undefined || spec === true) return source;
  if (spec === false) return undefined;
  const includes = Array.isArray(spec) ? spec.map(String) : typeof spec === 'string' ? [spec] : undefined;
  if (includes) return pickFields(source, includes);
  if (spec !== null && typeof spec === 'object') {
    const options = spec as Record<string, unknown>;
    let result = source;
    if (options.includes !== undefined) {
      const list = Array.isArray(options.includes) ? options.includes.map(String) : [String(options.includes)];
      result = pickFields(result, list);
    }
    if (options.excludes !== undefined) {
      const list = Array.isArray(options.excludes) ? options.excludes.map(String) : [String(options.excludes)];
      result = Object.fromEntries(Object.entries(result).filter(([key]) => !list.includes(key)));
    }
    return result;
  }
  throw new Error('_source must be a boolean, a field list or an {includes, excludes} object');
}

// Top-level field picking only — wildcards and nested include paths are out of
// the v1 fidelity bar.
function pickFields(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => fields.includes(key)));
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

export function computeAggregations(aggs: unknown, hits: SearchHitDoc[]): Record<string, unknown> {
  if (aggs === null || typeof aggs !== 'object' || Array.isArray(aggs)) {
    throw new Error('aggs must be an object of named aggregations');
  }
  const results: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(aggs as Record<string, unknown>)) {
    results[name] = computeOneAggregation(name, definition, hits);
  }
  return results;
}

function computeOneAggregation(name: string, definition: unknown, hits: SearchHitDoc[]): unknown {
  const [type, spec] = singleEntry(definition, `aggregation "${name}"`);
  if (type === 'aggs' || type === 'aggregations') {
    throw new Error(`sub-aggregations (in "${name}") are not supported by the LSS self engine`);
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`aggregation "${name}" expects an object with a "field"`);
  }
  const options = spec as Record<string, unknown>;
  const field = String(options.field ?? '');
  if (!field) throw new Error(`aggregation "${name}" requires a "field"`);

  if (type === 'terms') {
    const size = options.size !== undefined ? Number(options.size) : 10;
    const counts = new Map<string, number>();
    for (const hit of hits) {
      for (const value of resolveField(hit.source, field)) {
        if (value === null || value === undefined) continue;
        const key = typeof value === 'number' || typeof value === 'boolean' ? String(value) : String(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const buckets = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, size)
      .map(([key, count]) => ({ key, doc_count: count }));
    return { doc_count_error_upper_bound: 0, sum_other_doc_count: Math.max(0, counts.size - buckets.length), buckets };
  }

  if (['avg', 'sum', 'min', 'max', 'value_count'].includes(type)) {
    const numbers: number[] = [];
    let present = 0;
    for (const hit of hits) {
      for (const value of resolveField(hit.source, field)) {
        if (value === null || value === undefined) continue;
        present++;
        const numeric = Number(value);
        if (!Number.isNaN(numeric)) numbers.push(numeric);
      }
    }
    if (type === 'value_count') return { value: present };
    if (numbers.length === 0) return { value: null };
    const sum = numbers.reduce((acc, value) => acc + value, 0);
    switch (type) {
      case 'avg': return { value: sum / numbers.length };
      case 'sum': return { value: sum };
      case 'min': return { value: Math.min(...numbers) };
      default: return { value: Math.max(...numbers) };
    }
  }

  throw new Error(`the "${type}" aggregation (in "${name}") is not supported by the LSS self engine — see docs/SELF_ENGINE.md#coverage`);
}
