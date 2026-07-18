// Pure compiler + view builders for Lambda event source mapping FilterCriteria
// (PRD RF4/RF5 content filtering). FilterCriteria = { Filters: [{ Pattern }] }
// where each Pattern is a JSON-ENCODED string holding one EventBridge-style
// content-filter object. Filters are OR'd (a record passes if it matches ANY
// pattern); sibling keys inside one pattern are AND'd. Matching delegates to
// the shared ESM matcher in emulators/events/pattern.ts. When FilterCriteria is
// absent, has no Filters, or Filters === [], the predicate is always-true so
// every record is delivered (the pre-filtering default).

import { matchEsmPattern, validateEsmPattern } from '../emulators/events/pattern.js';
import type { DeliveredMessage } from '../emulators/sqs/index.js';

// AWS default account limit is 5 filter patterns per ESM.
const MAX_FILTERS = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Returns the raw Pattern strings from a FilterCriteria value, or [] when there
// is nothing to filter on (undefined criteria / missing / empty Filters).
function patternStrings(filterCriteria: unknown): string[] {
  if (!isPlainObject(filterCriteria)) return [];
  const filters = filterCriteria.Filters;
  if (!Array.isArray(filters) || filters.length === 0) return [];
  const patterns: string[] = [];
  for (const filter of filters) {
    if (isPlainObject(filter) && typeof filter.Pattern === 'string') patterns.push(filter.Pattern);
  }
  return patterns;
}

// Compiles FilterCriteria into a predicate that is TRUE when the record matches
// ANY pattern. Parses each Pattern once at compile time. An undefined / empty
// FilterCriteria compiles to an always-true predicate (no filtering).
export function compileFilterCriteria(
  filterCriteria: unknown,
): (record: Record<string, unknown>) => boolean {
  const raw = patternStrings(filterCriteria);
  if (raw.length === 0) return () => true;
  const patterns: Record<string, unknown>[] = [];
  for (const str of raw) {
    try {
      const parsed = JSON.parse(str);
      if (isPlainObject(parsed)) patterns.push(parsed);
    } catch {
      // Unparseable patterns are rejected at write time by validateFilterCriteria;
      // a stray one here is simply dropped from the OR set.
    }
  }
  return record => patterns.some(pattern => matchEsmPattern(pattern, record));
}

// Control-plane validation. Throws a plain Error (callers wrap it into
// InvalidArgumentException) when FilterCriteria is structurally invalid: a
// non-object Filters, more than MAX_FILTERS entries, a non-object filter, a
// non-JSON / non-object Pattern, or an unsupported operator.
export function validateFilterCriteria(filterCriteria: unknown): void {
  if (filterCriteria === undefined || filterCriteria === null) return;
  if (!isPlainObject(filterCriteria)) {
    throw new Error('FilterCriteria must be an object.');
  }
  const filters = filterCriteria.Filters;
  if (filters === undefined) return;
  if (!Array.isArray(filters)) {
    throw new Error('FilterCriteria.Filters must be an array.');
  }
  if (filters.length > MAX_FILTERS) {
    throw new Error(`FilterCriteria supports at most ${MAX_FILTERS} filters.`);
  }
  for (const filter of filters) {
    if (!isPlainObject(filter) || typeof filter.Pattern !== 'string') {
      throw new Error('Each FilterCriteria filter must be an object with a string Pattern.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(filter.Pattern);
    } catch {
      throw new Error('FilterCriteria Pattern must be valid JSON.');
    }
    if (!isPlainObject(parsed)) {
      throw new Error('FilterCriteria Pattern must be a JSON object.');
    }
    validateEsmPattern(parsed);
  }
}

// Stream records are matched against the raw wire record exactly as readStream
// returns it (top-level eventName + dynamodb.Keys/NewImage/OldImage in typed
// attribute-value form), so the filter view is the identity.
export function buildStreamFilterView(wireRecord: Record<string, unknown>): Record<string, unknown> {
  return wireRecord;
}

// SQS records are matched against the Lambda SQS record shape. BODY-AS-JSON
// rule: if message.body parses to a plain object/array use the parsed value
// (nested content filters); otherwise use the raw body string (scalar/prefix/
// anything-but on the string). The delivered event still carries the raw body.
export function buildSqsFilterView(message: DeliveredMessage): Record<string, unknown> {
  let body: unknown = message.body;
  try {
    const parsed = JSON.parse(message.body);
    if (parsed !== null && typeof parsed === 'object') body = parsed;
  } catch {
    // Not JSON — keep the raw string body.
  }
  const messageAttributes: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(message.messageAttributes)) {
    messageAttributes[name] = {
      ...(value.StringValue !== undefined ? { stringValue: value.StringValue } : {}),
      ...(value.BinaryValue !== undefined ? { binaryValue: value.BinaryValue } : {}),
      dataType: value.DataType,
    };
  }
  return {
    messageId: message.messageId,
    receiptHandle: message.receiptHandle,
    body,
    md5OfBody: message.md5OfBody,
    attributes: message.attributes,
    messageAttributes,
    eventSource: 'aws:sqs',
  };
}
