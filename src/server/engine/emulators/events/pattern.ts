// Pure EventBridge event-pattern matcher and validator (v1 subset — see
// docs/PRD_SELF_ENGINE.md §RF6.1). Leaf arrays are an OR of exact values
// (numbers compared numerically, everything else type-sensitive), {"prefix"}
// and {"exists"}; nested pattern objects recurse into event fields. Operators
// outside the v1 set are rejected up front by validatePattern (PutRule turns
// them into InvalidEventPatternException) — matching never fails silently on
// an operator the validator would have refused.

const V1_OPERATORS = new Set(['prefix', 'exists']);
// Lambda ESM FilterCriteria supports a superset of the EventBridge v1
// operators — it adds numeric ranges and anything-but (but NOT the EventBridge
// suffix/wildcard/cidr/equals-ignore-case). Kept separate from V1_OPERATORS so
// EventBridge PutRule keeps rejecting these operators unchanged.
const ESM_OPERATORS = new Set(['prefix', 'exists', 'numeric', 'anything-but']);

// A leaf matcher decides whether a value list matches the actual field value.
type LeafMatcher = (alternatives: unknown[], actual: unknown, present: boolean) => boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function matches(pattern: unknown, event: Record<string, unknown>): boolean {
  if (!isPlainObject(pattern)) return false;
  return matchObject(pattern, event, matchLeaf);
}

// ESM FilterCriteria matcher — same object-walking as EventBridge's `matches`
// but with the wider ESM leaf operator set. Separate entrypoint so the
// EventBridge matcher (and its defensive tests) stay byte-for-byte unchanged.
export function matchEsmPattern(pattern: unknown, event: Record<string, unknown>): boolean {
  if (!isPlainObject(pattern)) return false;
  return matchObject(pattern, event, matchEsmLeaf);
}

function matchObject(pattern: Record<string, unknown>, event: unknown, leaf: LeafMatcher): boolean {
  // An event array satisfies a nested pattern when any element does.
  if (Array.isArray(event)) return event.some(element => matchObject(pattern, element, leaf));
  for (const [key, expected] of Object.entries(pattern)) {
    const present = isPlainObject(event) && key in event;
    const actual = present ? (event as Record<string, unknown>)[key] : undefined;
    if (Array.isArray(expected)) {
      if (!leaf(expected, actual, present)) return false;
    } else if (isPlainObject(expected)) {
      if (!present || !matchObject(expected, actual, leaf)) return false;
    } else {
      // Bare primitives are invalid pattern shapes (validatePattern throws on
      // them); a rule that somehow carries one must never match.
      return false;
    }
  }
  return true;
}

function matchLeaf(alternatives: unknown[], actual: unknown, present: boolean): boolean {
  const candidates = Array.isArray(actual) ? actual : [actual];
  return alternatives.some(alternative => {
    if (isPlainObject(alternative)) {
      const keys = Object.keys(alternative);
      if (keys.length !== 1) return false;
      const operator = keys[0];
      const argument = alternative[operator];
      if (operator === 'exists') return argument === true ? present : !present;
      if (operator === 'prefix') {
        return present && typeof argument === 'string'
          && candidates.some(value => typeof value === 'string' && value.startsWith(argument));
      }
      return false; // unsupported operator — rejected at PutRule time
    }
    return present && candidates.some(value => valueEquals(alternative, value));
  });
}

// Exact-match semantics: numbers compare numerically (5 matches 5.0), every
// other JSON primitive is type-sensitive strict equality ("5" never matches 5).
function valueEquals(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'number') return typeof actual === 'number' && expected === actual;
  return expected === actual;
}

// Leaf matcher for Lambda ESM FilterCriteria. Adds numeric + anything-but on
// top of the v1 exact/OR/prefix/exists operators and refines `exists`: a
// present-but-null value counts as NOT existing (exists:true → false,
// exists:false → true), matching AWS ESM filtering.
function matchEsmLeaf(alternatives: unknown[], actual: unknown, present: boolean): boolean {
  const existsNonNull = present && actual !== null;
  const candidates = Array.isArray(actual) ? actual : [actual];
  return alternatives.some(alternative => {
    if (isPlainObject(alternative)) {
      const keys = Object.keys(alternative);
      if (keys.length !== 1) return false;
      const operator = keys[0];
      const argument = alternative[operator];
      if (operator === 'exists') return argument === true ? existsNonNull : !existsNonNull;
      if (operator === 'prefix') {
        return present && typeof argument === 'string'
          && candidates.some(value => typeof value === 'string' && value.startsWith(argument));
      }
      if (operator === 'numeric') return present && matchNumeric(argument, candidates);
      if (operator === 'anything-but') return present && matchAnythingBut(argument, candidates);
      return false; // unsupported operator — rejected at write time by validateEsmPattern
    }
    return present && candidates.some(value => valueEquals(alternative, value));
  });
}

// {"numeric":["=",n]} or a range {"numeric":[">",0,"<=",100]}. DynamoDB N
// leaves arrive as strings, so coerce with Number() before comparing.
function matchNumeric(argument: unknown, candidates: unknown[]): boolean {
  if (!Array.isArray(argument) || argument.length < 2 || argument.length % 2 !== 0) return false;
  return candidates.some(raw => {
    const actual = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
    if (Number.isNaN(actual)) return false;
    for (let i = 0; i < argument.length; i += 2) {
      const op = argument[i];
      const value = argument[i + 1];
      if (typeof op !== 'string' || typeof value !== 'number' || !numericOp(op, actual, value)) return false;
    }
    return true;
  });
}

function numericOp(op: string, a: number, b: number): boolean {
  switch (op) {
    case '=': return a === b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

// {"anything-but": scalar | [list]} — matches when the value is present and is
// not equal to any listed value.
function matchAnythingBut(argument: unknown, candidates: unknown[]): boolean {
  const excluded = Array.isArray(argument) ? argument : [argument];
  return candidates.every(value => !excluded.some(ex => valueEquals(ex, value)));
}

// Structural validation for PutRule. Returns the (deduplicated) operator names
// used by the pattern that the v1 matcher does not support — suffix,
// anything-but, numeric, cidr, equals-ignore-case, wildcard, or anything else
// unknown — and an empty array when the pattern is fully supported. Throws a
// plain Error on structurally invalid patterns (non-object root, empty
// objects/arrays, bare primitive leaves, nested arrays, malformed operator
// objects); callers wrap the message into InvalidEventPatternException.
export function validatePattern(pattern: unknown): string[] {
  if (!isPlainObject(pattern)) {
    throw new Error('Event pattern must be a JSON object.');
  }
  const unsupported = new Set<string>();
  walkPattern(pattern, '', unsupported);
  return [...unsupported];
}

function walkPattern(pattern: Record<string, unknown>, path: string, unsupported: Set<string>): void {
  const entries = Object.entries(pattern);
  if (entries.length === 0) {
    throw new Error(`Event pattern must not contain an empty object${path ? ` at "${path}"` : ''}.`);
  }
  for (const [key, value] of entries) {
    const keyPath = path ? `${path}.${key}` : key;
    if (Array.isArray(value)) {
      if (value.length === 0) throw new Error(`Match value list at "${keyPath}" must not be empty.`);
      for (const alternative of value) validateAlternative(alternative, keyPath, unsupported);
    } else if (isPlainObject(value)) {
      walkPattern(value, keyPath, unsupported);
    } else {
      throw new Error(`Pattern value at "${keyPath}" must be an array of match values or a nested object.`);
    }
  }
}

function validateAlternative(alternative: unknown, keyPath: string, unsupported: Set<string>): void {
  if (Array.isArray(alternative)) {
    throw new Error(`Nested arrays are not allowed in the match value list at "${keyPath}".`);
  }
  if (!isPlainObject(alternative)) return; // exact-match primitive — always supported
  const keys = Object.keys(alternative);
  if (keys.length !== 1) {
    throw new Error(`Match operator objects must have exactly one key (at "${keyPath}").`);
  }
  const operator = keys[0];
  if (!V1_OPERATORS.has(operator)) {
    unsupported.add(operator);
    return;
  }
  if (operator === 'prefix' && typeof alternative[operator] !== 'string') {
    throw new Error(`Operator "prefix" at "${keyPath}" requires a string argument.`);
  }
  if (operator === 'exists' && typeof alternative[operator] !== 'boolean') {
    throw new Error(`Operator "exists" at "${keyPath}" requires a boolean argument.`);
  }
}

// Structural validation for a single ESM FilterCriteria pattern (control-plane
// write path). Throws a plain Error on a non-object root, empty objects/lists,
// bare primitive leaves, nested arrays, malformed operator objects, or an
// operator outside the ESM set (prefix/exists/numeric/anything-but); callers
// wrap the message into InvalidArgumentException.
export function validateEsmPattern(pattern: unknown): void {
  if (!isPlainObject(pattern)) {
    throw new Error('Filter pattern must be a JSON object.');
  }
  walkEsmPattern(pattern, '');
}

function walkEsmPattern(pattern: Record<string, unknown>, path: string): void {
  const entries = Object.entries(pattern);
  if (entries.length === 0) {
    throw new Error(`Filter pattern must not contain an empty object${path ? ` at "${path}"` : ''}.`);
  }
  for (const [key, value] of entries) {
    const keyPath = path ? `${path}.${key}` : key;
    if (Array.isArray(value)) {
      if (value.length === 0) throw new Error(`Match value list at "${keyPath}" must not be empty.`);
      for (const alternative of value) validateEsmAlternative(alternative, keyPath);
    } else if (isPlainObject(value)) {
      walkEsmPattern(value, keyPath);
    } else {
      throw new Error(`Pattern value at "${keyPath}" must be an array of match values or a nested object.`);
    }
  }
}

function validateEsmAlternative(alternative: unknown, keyPath: string): void {
  if (Array.isArray(alternative)) {
    throw new Error(`Nested arrays are not allowed in the match value list at "${keyPath}".`);
  }
  if (!isPlainObject(alternative)) return; // exact-match primitive — always supported
  const keys = Object.keys(alternative);
  if (keys.length !== 1) {
    throw new Error(`Match operator objects must have exactly one key (at "${keyPath}").`);
  }
  const operator = keys[0];
  if (!ESM_OPERATORS.has(operator)) {
    throw new Error(`Unsupported filter operator "${operator}" at "${keyPath}".`);
  }
  if (operator === 'prefix' && typeof alternative[operator] !== 'string') {
    throw new Error(`Operator "prefix" at "${keyPath}" requires a string argument.`);
  }
  if (operator === 'exists' && typeof alternative[operator] !== 'boolean') {
    throw new Error(`Operator "exists" at "${keyPath}" requires a boolean argument.`);
  }
  if (operator === 'numeric') {
    const arg = alternative[operator];
    if (!Array.isArray(arg) || arg.length < 2 || arg.length % 2 !== 0) {
      throw new Error(`Operator "numeric" at "${keyPath}" requires [op, value, ...] pairs.`);
    }
    for (let i = 0; i < arg.length; i += 2) {
      if (typeof arg[i] !== 'string' || !['=', '<', '<=', '>', '>='].includes(arg[i] as string)) {
        throw new Error(`Operator "numeric" at "${keyPath}" has an invalid comparator "${String(arg[i])}".`);
      }
      if (typeof arg[i + 1] !== 'number') {
        throw new Error(`Operator "numeric" at "${keyPath}" requires numeric operands.`);
      }
    }
  }
}
