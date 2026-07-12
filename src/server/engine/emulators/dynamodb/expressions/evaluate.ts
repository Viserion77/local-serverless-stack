// Value semantics of the expression language: document-path resolution,
// wire-format equality/ordering and the per-function predicates. Pure over
// AttributeValue JSON — nothing here mutates an item.

import type { AttributeMap, AttributeValue } from '../../../types.js';
import { compareDecimals, normalizeDecimal } from './decimal.js';

export type PathSegment = { attr: string } | { index: number };
export type DocumentPath = PathSegment[];

export type AttributeTypeName = 'S' | 'N' | 'B' | 'BOOL' | 'NULL' | 'L' | 'M' | 'SS' | 'NS' | 'BS';

const TYPE_TAGS: AttributeTypeName[] = ['S', 'N', 'B', 'BOOL', 'NULL', 'L', 'M', 'SS', 'NS', 'BS'];

export function typeOf(value: AttributeValue): AttributeTypeName {
  for (const tag of TYPE_TAGS) {
    if (value[tag] !== undefined) return tag;
  }
  // Unreachable for wire-valid items; treat a degenerate {} as NULL.
  return 'NULL';
}

// Human-readable form used by the "Two document paths overlap" error:
// [a, b, [0]].
export function formatPath(path: DocumentPath): string {
  return path.map((seg) => ('attr' in seg ? seg.attr : `[${seg.index}]`)).join(', ');
}

export function resolvePath(item: AttributeMap, path: DocumentPath): AttributeValue | undefined {
  let current: AttributeValue | undefined = { M: item };
  for (const seg of path) {
    if (current === undefined) return undefined;
    current = 'attr' in seg ? current.M?.[seg.attr] : current.L?.[seg.index];
  }
  return current;
}

// One path is a prefix of the other (or they are identical). Distinct list
// indexes at the fork point do not overlap.
export function pathsOverlap(a: DocumentPath, b: DocumentPath): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const sa = a[i];
    const sb = b[i];
    if ('attr' in sa && 'attr' in sb) {
      if (sa.attr !== sb.attr) return false;
    } else if ('index' in sa && 'index' in sb) {
      if (sa.index !== sb.index) return false;
    } else {
      return false;
    }
  }
  return true;
}

function base64Bytes(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function setEquals(a: string[], b: string[], memberEquals: (x: string, y: string) => boolean): boolean {
  if (a.length !== b.length) return false;
  return a.every((x) => b.some((y) => memberEquals(x, y)));
}

export function attributeValuesEqual(a: AttributeValue, b: AttributeValue): boolean {
  const type = typeOf(a);
  if (type !== typeOf(b)) return false;
  switch (type) {
    case 'S':
      return a.S === b.S;
    case 'N':
      return compareDecimals(a.N!, b.N!) === 0;
    case 'B':
      return base64Bytes(a.B!).equals(base64Bytes(b.B!));
    case 'BOOL':
      return a.BOOL === b.BOOL;
    case 'NULL':
      return true;
    case 'L':
      return a.L!.length === b.L!.length && a.L!.every((v, i) => attributeValuesEqual(v, b.L![i]));
    case 'M': {
      const keysA = Object.keys(a.M!);
      return keysA.length === Object.keys(b.M!).length &&
        keysA.every((k) => b.M![k] !== undefined && attributeValuesEqual(a.M![k], b.M![k]));
    }
    case 'SS':
      return setEquals(a.SS!, b.SS!, (x, y) => x === y);
    case 'NS':
      return setEquals(a.NS!, b.NS!, (x, y) => compareDecimals(x, y) === 0);
    case 'BS':
      return setEquals(a.BS!, b.BS!, (x, y) => base64Bytes(x).equals(base64Bytes(y)));
  }
}

// Total ordering for same-type scalars (sort keys, BETWEEN, comparators).
// Non-orderable or cross-type pairs still get a stable deterministic order so
// the function stays total, but condition evaluation never relies on it —
// orderedCompare() guards the orderable types first.
export function compareAttributeValues(a: AttributeValue, b: AttributeValue): number {
  const type = typeOf(a);
  if (type === typeOf(b)) {
    if (type === 'S') return a.S! < b.S! ? -1 : a.S! > b.S! ? 1 : 0;
    if (type === 'N') return compareDecimals(a.N!, b.N!);
    if (type === 'B') return base64Bytes(a.B!).compare(base64Bytes(b.B!));
  }
  if (attributeValuesEqual(a, b)) return 0;
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
}

export function isOrderable(value: AttributeValue): boolean {
  const type = typeOf(value);
  return type === 'S' || type === 'N' || type === 'B';
}

// Ordering comparison usable inside condition evaluation: false whenever the
// operands are not the same orderable type (AWS semantics — never an error).
export function orderedCompare(a: AttributeValue, b: AttributeValue, op: '<' | '<=' | '>' | '>='): boolean {
  if (typeOf(a) !== typeOf(b) || !isOrderable(a)) return false;
  const cmp = compareAttributeValues(a, b);
  switch (op) {
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
  }
}

export function beginsWith(target: AttributeValue, prefix: AttributeValue): boolean {
  if (target.S !== undefined && prefix.S !== undefined) return target.S.startsWith(prefix.S);
  if (target.B !== undefined && prefix.B !== undefined) {
    const t = base64Bytes(target.B);
    const p = base64Bytes(prefix.B);
    return t.length >= p.length && t.subarray(0, p.length).equals(p);
  }
  return false;
}

export function containsValue(target: AttributeValue, operand: AttributeValue): boolean {
  if (target.S !== undefined) return operand.S !== undefined && target.S.includes(operand.S);
  if (target.SS !== undefined) return operand.S !== undefined && target.SS.includes(operand.S);
  if (target.NS !== undefined) return operand.N !== undefined && target.NS.some((n) => compareDecimals(n, operand.N!) === 0);
  if (target.BS !== undefined) {
    return operand.B !== undefined && target.BS.some((b) => base64Bytes(b).equals(base64Bytes(operand.B!)));
  }
  if (target.L !== undefined) return target.L.some((v) => attributeValuesEqual(v, operand));
  return false;
}

export function sizeOf(value: AttributeValue): AttributeValue | undefined {
  if (value.S !== undefined) return { N: String(value.S.length) };
  if (value.B !== undefined) return { N: String(base64Bytes(value.B).length) };
  if (value.L !== undefined) return { N: String(value.L.length) };
  if (value.M !== undefined) return { N: String(Object.keys(value.M).length) };
  if (value.SS !== undefined) return { N: String(value.SS.length) };
  if (value.NS !== undefined) return { N: String(value.NS.length) };
  if (value.BS !== undefined) return { N: String(value.BS.length) };
  return undefined;
}

// Set union / difference for ADD and DELETE. `tag` picks the member equality.
export function setUnion(tag: 'SS' | 'NS' | 'BS', existing: string[], added: string[]): string[] {
  const result = [...existing];
  for (const member of added) {
    if (!setContains(tag, result, member)) result.push(member);
  }
  return result;
}

export function setDifference(tag: 'SS' | 'NS' | 'BS', existing: string[], removed: string[]): string[] {
  return existing.filter((member) => !setContains(tag, removed, member));
}

function setContains(tag: 'SS' | 'NS' | 'BS', members: string[], candidate: string): boolean {
  if (tag === 'NS') return members.some((m) => compareDecimals(m, candidate) === 0);
  if (tag === 'BS') return members.some((m) => base64Bytes(m).equals(base64Bytes(candidate)));
  return members.includes(candidate);
}

export { normalizeDecimal };
