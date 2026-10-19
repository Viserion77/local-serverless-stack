// Wire helpers for the API Gateway (REST v1) control-plane emulator: the
// restJson1 error constructors, request-body and patch-operation parsing,
// AWS-style identifiers and the opaque `position` pagination token. Kept apart
// from index.ts so the operation handlers read as AWS semantics only.

import { randomInt } from 'crypto';
import type { AwsResponse } from '../../types.js';
import { AwsError, notImplementedOperation } from '../../http/errors.js';

// API Gateway answers every failure as rest-json: the status, the error name in
// `x-amzn-ErrorType` and a body whose text member is a lowercase `message`.
// The router's restJson serializer frames these (see router.ts shapeForService).
export function notFound(message: string): AwsError {
  return new AwsError('NotFoundException', message, { status: 404 });
}

export function conflict(message: string): AwsError {
  return new AwsError('ConflictException', message, { status: 409 });
}

export function badRequest(message: string): AwsError {
  return new AwsError('BadRequestException', message, { status: 400 });
}

// Every API Gateway operation this emulator does not serve. 501 rather than
// the engine's usual 400: it is what API Gateway clients expect for an
// unsupported call, and — unlike a 500/502/503/504 — the SDK never retries it.
export function notImplemented(operation: string): AwsError {
  const base = notImplementedOperation('apigateway', operation);
  return new AwsError(base.code, base.message, { status: 501 });
}

export function jsonResponse(status: number, payload: object): AwsResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

// DeleteApiKey / DeleteUsagePlan / DeleteUsagePlanKey answer 202 with no body;
// TagResource / UntagResource answer 204.
export function emptyResponse(status: number): AwsResponse {
  return { status };
}

// restJson1 timestamps travel as epoch SECONDS (the protocol default for body
// members, which API Gateway does not override). AWS emits whole seconds.
export function epochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw badRequest('Could not parse the request body as JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('The request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// AWS ids are lowercase alphanumerics: 10 characters for an API key, 6 for a
// usage plan. `taken` is checked instance-wide by the caller, so an id never
// repeats across regions either.
export function newResourceId(length: number, taken: (id: string) => boolean): string {
  let id = randomString(ID_ALPHABET, length);
  while (taken(id)) id = randomString(ID_ALPHABET, length);
  return id;
}

// AWS-generated API key values are 40 mixed-case alphanumerics.
export function newApiKeyValue(): string {
  return randomString(KEY_ALPHABET, 40);
}

// ---------------------------------------------------------------------------
// Pagination: `limit` (default 25, max 500) + an opaque `position` cursor
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;

// Lists are ordered by id and `position` encodes the LAST id handed out, never
// an offset: a caller that deletes items while paging the same list (revoking
// keys page by page) must neither skip nor repeat one, and an offset shifts
// under every deletion. The token is base64url so callers treat it as opaque;
// it is omitted on the last page.
export function paginate<T extends { id: string }>(
  items: T[],
  query: Record<string, string>,
): { page: T[]; position?: string } {
  const rawLimit = query.limit;
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > MAX_LIMIT) {
      throw badRequest(`Invalid limit specified: ${rawLimit}. The limit must be between 1 and ${MAX_LIMIT}.`);
    }
  }
  // Ids are unique within a list, so the comparator never sees a tie.
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
  let start = 0;
  if (query.position !== undefined) {
    const after = Buffer.from(query.position, 'base64url').toString('utf8');
    if (!/^[a-z0-9]+$/.test(after)) throw badRequest('Invalid position parameter specified');
    start = sorted.findIndex((item) => item.id > after);
    if (start === -1) start = sorted.length;
  }
  const page = sorted.slice(start, start + limit);
  const more = start + limit < sorted.length;
  return { page, position: more ? Buffer.from(page[page.length - 1].id).toString('base64url') : undefined };
}

// ---------------------------------------------------------------------------
// JSON Patch-style updates (UpdateApiKey / UpdateUsagePlan `patchOperations`)
// ---------------------------------------------------------------------------

export interface PatchOperation {
  op: string;
  path: string;
  value?: string;
}

const PATCH_OPS = ['add', 'remove', 'replace', 'move', 'copy', 'test'];

export function readPatchOperations(input: Record<string, unknown>): PatchOperation[] {
  const raw = input.patchOperations ?? [];
  if (!Array.isArray(raw)) throw badRequest('patchOperations must be a list');
  return raw.map((entry: unknown) => {
    const candidate = (entry ?? {}) as Record<string, unknown>;
    const op = candidate.op;
    const path = candidate.path;
    if (typeof op !== 'string' || !PATCH_OPS.includes(op)) {
      throw badRequest(`Invalid patch operation specified: ${String(op)}. Must be one of: [${PATCH_OPS.join(', ')}]`);
    }
    if (typeof path !== 'string') throw badRequest(`Invalid patch path specified for op '${op}'`);
    const value = candidate.value;
    return { op, path, value: value === undefined || value === null ? undefined : String(value) };
  });
}

// The path is valid but the op is not one AWS accepts on it (or the path is
// unknown altogether): AWS lists the paths the op supports.
export function invalidPatchPath(operation: PatchOperation, supported: string[]): AwsError {
  return badRequest(
    `Invalid patch path '${operation.path}' specified for op '${operation.op}'. Must be one of: [${supported.join(', ')}]`,
  );
}

export function requirePatchValue(operation: PatchOperation): string {
  if (operation.value === undefined) {
    throw badRequest(`Invalid patch value for path '${operation.path}': a value is required for op '${operation.op}'`);
  }
  return operation.value;
}

// Patch values are always strings on the wire ("100", "2.5"); numeric members
// are non-negative, and `integer` members reject fractions.
export function parsePatchNumber(operation: PatchOperation, integer: boolean): number {
  const raw = requirePatchValue(operation);
  const value = Number(raw);
  const valid = raw.trim() !== '' && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value));
  if (!valid) throw badRequest(`Invalid ${integer ? 'integer' : 'numeric'} value '${raw}' for path '${operation.path}'`);
  return value;
}

// ---------------------------------------------------------------------------
// Input members
// ---------------------------------------------------------------------------

export function optionalString(input: Record<string, unknown>, member: string): string | undefined {
  const value = input[member];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`Invalid value for ${member}: expected a string`);
  return value;
}

export function readTags(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('tags must be a map of string to string');
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') throw badRequest(`Invalid value for tag ${key}: expected a string`);
    tags[key] = value;
  }
  return tags;
}
