// Public entry of the DynamoDB expression engine. Implements the
// ExpressionEngine contract (expression-types.ts) on top of the lexer/parser
// (parser.ts) and the value semantics (evaluate.ts). Input items are never
// mutated — updates and projections build fresh structures.
//
// Unused-placeholder validation is request-scoped on AWS (one names/values
// map serves KeyCondition + Filter + Projection of the same call), so it
// lives in `assertPlaceholdersUsed(expressions, ctx)` — the emulator core
// calls it once per request with every expression the request carried —
// instead of inside the per-expression functions, where a shared map would
// false-positive.

import type { AttributeMap, AttributeValue } from '../../../types.js';
import type {
  CompiledCondition, ExpressionContext, ExpressionEngine, ParsedKeyCondition,
} from './expression-types.js';
import { validationError } from '../../../http/errors.js';
import {
  parseConditionExpression, parseKeyConditionExpression, parseProjectionExpression, parseUpdateExpression,
} from './parser.js';
import {
  attributeValuesEqual, compareAttributeValues, formatPath, pathsOverlap, resolvePath,
  setDifference, setUnion, typeOf,
} from './evaluate.js';
import type { DocumentPath } from './evaluate.js';
import { addDecimals } from './decimal.js';

export type { DocumentPath, PathSegment } from './evaluate.js';
export { compareDecimals, addDecimals, subtractDecimals, normalizeDecimal } from './decimal.js';
export { attributeValuesEqual, compareAttributeValues };

const INVALID_DOCUMENT_PATH = 'The document path provided in the update expression is invalid for update';
const INCORRECT_OPERAND_TYPE = 'An operand in the update expression has an incorrect data type';

export function parseKeyCondition(expression: string, ctx: ExpressionContext): ParsedKeyCondition {
  return parseKeyConditionExpression(expression, ctx);
}

export function compileCondition(
  expression: string,
  ctx: ExpressionContext,
  label: 'ConditionExpression' | 'FilterExpression' = 'ConditionExpression',
): CompiledCondition {
  const predicate = parseConditionExpression(expression, ctx, label);
  return { evaluate: predicate };
}

// -- update application --------------------------------------------------------

// Walks to the container holding the last path segment. Returns undefined
// when an intermediate step is missing or of the wrong shape.
function resolveContainer(root: AttributeMap, path: DocumentPath): AttributeValue | undefined {
  let container: AttributeValue | undefined = { M: root };
  for (const seg of path.slice(0, -1)) {
    if (container === undefined) return undefined;
    container = 'attr' in seg ? container.M?.[seg.attr] : container.L?.[seg.index];
  }
  return container;
}

function setPath(root: AttributeMap, path: DocumentPath, value: AttributeValue): void {
  const container = resolveContainer(root, path);
  const last = path[path.length - 1];
  if ('attr' in last) {
    if (container?.M === undefined) throw validationError(INVALID_DOCUMENT_PATH);
    container.M[last.attr] = value;
    return;
  }
  if (container?.L === undefined) throw validationError(INVALID_DOCUMENT_PATH);
  // A SET beyond the end of a list appends (AWS semantics).
  if (last.index >= container.L.length) container.L.push(value);
  else container.L[last.index] = value;
}

function removePath(root: AttributeMap, path: DocumentPath): void {
  const container = resolveContainer(root, path);
  const last = path[path.length - 1];
  if ('attr' in last) {
    if (container?.M !== undefined) delete container.M[last.attr];
    return;
  }
  if (container?.L !== undefined && last.index < container.L.length) {
    container.L.splice(last.index, 1);
  }
}

function assertNoOverlap(paths: DocumentPath[]): void {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (pathsOverlap(paths[i], paths[j])) {
        throw validationError(
          'Invalid UpdateExpression: Two document paths overlap with each other; ' +
          `must remove or rewrite one of these paths; path one: [${formatPath(paths[i])}], path two: [${formatPath(paths[j])}]`,
        );
      }
    }
  }
}

// Splice order matters when several indexes of the same list are removed in
// one expression: apply the highest index first so every splice still refers
// to the original element positions.
function sortRemovesForSplice(removes: DocumentPath[]): DocumentPath[] {
  return [...removes].sort((a, b) => {
    const parentA = formatPath(a.slice(0, -1));
    const parentB = formatPath(b.slice(0, -1));
    if (parentA !== parentB) return parentA < parentB ? -1 : 1;
    const lastA = a[a.length - 1];
    const lastB = b[b.length - 1];
    if ('index' in lastA && 'index' in lastB) return lastB.index - lastA.index;
    return 0;
  });
}

export function applyUpdate(expression: string, item: AttributeMap, ctx: ExpressionContext): AttributeMap {
  const parsed = parseUpdateExpression(expression, ctx);
  assertNoOverlap([
    ...parsed.sets.map((a) => a.path),
    ...parsed.removes,
    ...parsed.adds.map((a) => a.path),
    ...parsed.deletes.map((a) => a.path),
  ]);
  const updated = structuredClone(item);

  // SET operands read the original image; results are cloned so the new item
  // never aliases values inside the input.
  for (const action of parsed.sets) {
    setPath(updated, action.path, structuredClone(action.value(item)));
  }

  for (const action of parsed.adds) {
    const existing = resolvePath(updated, action.path);
    const addition = structuredClone(action.value);
    if (existing === undefined) {
      setPath(updated, action.path, addition);
      continue;
    }
    const type = typeOf(action.value);
    if (typeOf(existing) !== type) throw validationError(INCORRECT_OPERAND_TYPE);
    if (type === 'N') {
      setPath(updated, action.path, { N: addDecimals(existing.N!, addition.N!) });
    } else {
      const tag = type as 'SS' | 'NS' | 'BS';
      const merged: AttributeValue = {};
      merged[tag] = setUnion(tag, existing[tag]!, addition[tag]!);
      setPath(updated, action.path, merged);
    }
  }

  for (const action of parsed.deletes) {
    const existing = resolvePath(updated, action.path);
    if (existing === undefined) continue;
    const tag = typeOf(action.value) as 'SS' | 'NS' | 'BS';
    if (typeOf(existing) !== tag) throw validationError(INCORRECT_OPERAND_TYPE);
    const remaining = setDifference(tag, existing[tag]!, action.value[tag]!);
    if (remaining.length === 0) {
      removePath(updated, action.path);
    } else {
      const reduced: AttributeValue = {};
      reduced[tag] = remaining;
      setPath(updated, action.path, reduced);
    }
  }

  for (const path of sortRemovesForSplice(parsed.removes)) {
    removePath(updated, path);
  }
  return updated;
}

// -- projection ------------------------------------------------------------------

interface ProjectionNode {
  take: boolean;
  attrs: Map<string, ProjectionNode>;
  indexes: Map<number, ProjectionNode>;
}

function newNode(): ProjectionNode {
  return { take: false, attrs: new Map(), indexes: new Map() };
}

function insertPath(root: ProjectionNode, path: DocumentPath): void {
  let node = root;
  for (const seg of path) {
    if (node.take) return; // a shorter overlapping path already takes the subtree
    if ('attr' in seg) {
      if (!node.attrs.has(seg.attr)) node.attrs.set(seg.attr, newNode());
      node = node.attrs.get(seg.attr)!;
    } else {
      if (!node.indexes.has(seg.index)) node.indexes.set(seg.index, newNode());
      node = node.indexes.get(seg.index)!;
    }
  }
  node.take = true;
}

function projectValue(value: AttributeValue, node: ProjectionNode): AttributeValue | undefined {
  if (node.take) return structuredClone(value);
  if (value.M !== undefined && node.attrs.size > 0) {
    const out: AttributeMap = {};
    for (const [name, child] of node.attrs) {
      const inner = value.M[name];
      if (inner === undefined) continue;
      const projected = projectValue(inner, child);
      if (projected !== undefined) out[name] = projected;
    }
    return Object.keys(out).length > 0 ? { M: out } : undefined;
  }
  if (value.L !== undefined && node.indexes.size > 0) {
    // Selected list elements are kept in ascending index order, compacted.
    const out: AttributeValue[] = [];
    for (const index of [...node.indexes.keys()].sort((a, b) => a - b)) {
      const inner = value.L[index];
      if (inner === undefined) continue;
      const projected = projectValue(inner, node.indexes.get(index)!);
      if (projected !== undefined) out.push(projected);
    }
    return out.length > 0 ? { L: out } : undefined;
  }
  return undefined;
}

export function applyProjection(expression: string, item: AttributeMap, ctx: ExpressionContext): AttributeMap {
  const paths = parseProjectionExpression(expression, ctx);
  const root = newNode();
  for (const path of paths) insertPath(root, path);
  const result: AttributeMap = {};
  for (const [name, child] of root.attrs) {
    const value = item[name];
    if (value === undefined) continue;
    const projected = projectValue(value, child);
    if (projected !== undefined) result[name] = projected;
  }
  return result;
}

// -- request-level placeholder accounting ------------------------------------------

const PLACEHOLDER_PATTERN = /[#:][A-Za-z0-9_]+/g;

// Call once per request with every expression it carried (undefined entries
// are fine). Throws the AWS unused-names/values ValidationExceptions.
export function assertPlaceholdersUsed(
  expressions: Array<string | null | undefined>,
  ctx: ExpressionContext,
): void {
  const used = new Set<string>();
  for (const expression of expressions) {
    for (const match of (expression ?? '').matchAll(PLACEHOLDER_PATTERN)) used.add(match[0]);
  }
  const unusedNames = Object.keys(ctx.names ?? {}).filter((key) => !used.has(key));
  if (unusedNames.length > 0) {
    throw validationError(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${unusedNames.join(', ')}}`);
  }
  const unusedValues = Object.keys(ctx.values ?? {}).filter((key) => !used.has(key));
  if (unusedValues.length > 0) {
    throw validationError(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${unusedValues.join(', ')}}`);
  }
}

export const expressionEngine: ExpressionEngine = {
  parseKeyCondition,
  compileCondition,
  applyUpdate,
  applyProjection,
  compareAttributeValues,
  attributeValuesEqual,
};
