// Public API contract of the DynamoDB expression engine (lexer + parser +
// evaluators). ./index.ts implements and exports concrete functions matching
// `ExpressionEngine`; the DynamoDB emulator core imports them from there.
// All item data is wire-format AttributeValue JSON.
//
// Errors: every syntax/semantic problem must throw AwsError with code
// "ValidationException" and an AWS-worded message (unused
// ExpressionAttributeNames/Values, undefined placeholders; reserved-word
// misuse is NOT enforced in v1). ConditionalCheckFailedException is raised by
// the emulator core, not here — condition evaluation just returns boolean.

import type { AttributeMap, AttributeValue } from '../../../types.js';

export interface ExpressionContext {
  names?: Record<string, string>; // ExpressionAttributeNames  (#n → attribute)
  values?: AttributeMap;          // ExpressionAttributeValues (:v → value)
}

export type SortKeyOperator = '=' | '<' | '<=' | '>' | '>=' | 'BETWEEN' | 'begins_with';

export interface ParsedKeyCondition {
  partition: { name: string; value: AttributeValue };
  sort?: { name: string; operator: SortKeyOperator; values: AttributeValue[] };
}

// Parse once, evaluate per item. Supports comparators, BETWEEN, IN, AND/OR/
// NOT, parentheses, attribute_exists/attribute_not_exists, attribute_type,
// begins_with, contains, size — with document paths (a.b[0].c) and #/:
// placeholders on either side of an operator.
export interface CompiledCondition {
  evaluate(item: AttributeMap): boolean;
}

export interface ExpressionEngine {
  parseKeyCondition(expression: string, ctx: ExpressionContext): ParsedKeyCondition;

  compileCondition(expression: string, ctx: ExpressionContext): CompiledCondition;

  // SET (incl. `+`/`-` arithmetic, if_not_exists, list_append), REMOVE, ADD,
  // DELETE. Returns the new item (input never mutated). Number arithmetic is
  // decimal-string based — no float drift on N values.
  applyUpdate(expression: string, item: AttributeMap, ctx: ExpressionContext): AttributeMap;

  // Returns a new item containing only the projected document paths.
  applyProjection(expression: string, item: AttributeMap, ctx: ExpressionContext): AttributeMap;

  // Total ordering of two attribute values of the same type (S lexicographic,
  // N numeric via decimal comparison, B bytewise on the decoded base64).
  // Used for sort-key ranges and BETWEEN.
  compareAttributeValues(a: AttributeValue, b: AttributeValue): number;

  // Deep equality on wire-format values (set members order-insensitive).
  attributeValuesEqual(a: AttributeValue, b: AttributeValue): boolean;
}
