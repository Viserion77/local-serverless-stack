// Wire-shape parsing for TransactWriteItems / TransactGetItems: each entry is
// validated structurally (exactly one action, required members present) and
// normalized into a discriminated op the emulator executes. Table-schema
// validation (keys, item size, duplicates) needs the TableRecord and stays in
// the emulator; everything here is checkable from the request alone.

import type { AttributeMap } from '../../types.js';
import { validationError } from '../../http/errors.js';
import type { ExpressionContext } from './expressions/expression-types.js';

// AWS raised the per-transaction item cap from 25 to 100 in Sept 2022.
export const MAX_TRANSACT_ITEMS = 100;

interface TransactMemberWire {
  TableName?: unknown;
  Item?: unknown;
  Key?: unknown;
  UpdateExpression?: unknown;
  ConditionExpression?: unknown;
  ProjectionExpression?: unknown;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: AttributeMap;
  ReturnValuesOnConditionCheckFailure?: unknown;
}

export type TransactWriteKind = 'Put' | 'Update' | 'Delete' | 'ConditionCheck';

export interface TransactWriteOp {
  kind: TransactWriteKind;
  tableName: string;
  // Put carries the full item; the other three carry the key.
  item?: AttributeMap;
  key?: AttributeMap;
  updateExpression?: string;
  conditionExpression?: string;
  returnOldOnFail: boolean;
  ctx: ExpressionContext;
}

export interface TransactGetOp {
  tableName: string;
  key: AttributeMap;
  projectionExpression?: string;
  ctx: ExpressionContext;
}

function requireItems(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw validationError(`One or more parameter values were invalid: TransactItems must not be empty for ${operation}`);
  }
  if (raw.length > MAX_TRANSACT_ITEMS) {
    throw validationError(
      `1 validation error detected: Value at 'transactItems' failed to satisfy constraint: ` +
      `Member must have length less than or equal to ${MAX_TRANSACT_ITEMS}`,
    );
  }
  return raw;
}

function memberTableName(member: TransactMemberWire, kind: string): string {
  if (typeof member.TableName !== 'string' || member.TableName.length === 0) {
    throw validationError(`One or more parameter values were invalid: TableName is required for ${kind}`);
  }
  return member.TableName;
}

function memberContext(member: TransactMemberWire): ExpressionContext {
  return { names: member.ExpressionAttributeNames, values: member.ExpressionAttributeValues };
}

function optionalExpression(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw validationError(`One or more parameter values were invalid: ${label} must be a non-empty string`);
  }
  return raw;
}

function returnOldOnFail(member: TransactMemberWire): boolean {
  const raw = member.ReturnValuesOnConditionCheckFailure;
  if (raw !== undefined && raw !== 'ALL_OLD' && raw !== 'NONE') {
    throw validationError('One or more parameter values were invalid: ReturnValuesOnConditionCheckFailure must be one of NONE, ALL_OLD');
  }
  return raw === 'ALL_OLD';
}

export function parseTransactWriteItems(input: Record<string, unknown>): TransactWriteOp[] {
  return requireItems(input.TransactItems, 'TransactWriteItems').map((entry) => {
    const wire = entry as Record<TransactWriteKind, TransactMemberWire | undefined> | null;
    const kinds: TransactWriteKind[] = ['Put', 'Update', 'Delete', 'ConditionCheck'];
    const present = kinds.filter((kind) => wire?.[kind] !== undefined);
    if (present.length !== 1) {
      throw validationError('One or more parameter values were invalid: A TransactWriteItem must carry exactly one of Put, Update, Delete or ConditionCheck');
    }
    const kind = present[0];
    const member = wire![kind]!;
    const op: TransactWriteOp = {
      kind,
      tableName: memberTableName(member, kind),
      conditionExpression: optionalExpression(member.ConditionExpression, 'ConditionExpression'),
      returnOldOnFail: returnOldOnFail(member),
      ctx: memberContext(member),
    };
    if (kind === 'Put') {
      const item = member.Item;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw validationError('One or more parameter values were invalid: Item is required for Put');
      }
      op.item = item as AttributeMap;
    } else {
      const key = member.Key;
      if (!key || typeof key !== 'object' || Array.isArray(key)) {
        throw validationError(`One or more parameter values were invalid: Key is required for ${kind}`);
      }
      op.key = key as AttributeMap;
    }
    if (kind === 'Update') {
      op.updateExpression = optionalExpression(member.UpdateExpression, 'UpdateExpression');
      if (!op.updateExpression) {
        throw validationError('One or more parameter values were invalid: UpdateExpression is required for Update');
      }
    }
    if (kind === 'ConditionCheck' && !op.conditionExpression) {
      throw validationError('One or more parameter values were invalid: ConditionExpression is required for ConditionCheck');
    }
    return op;
  });
}

export function parseTransactGetItems(input: Record<string, unknown>): TransactGetOp[] {
  return requireItems(input.TransactItems, 'TransactGetItems').map((entry) => {
    const wire = entry as { Get?: TransactMemberWire } | null;
    const member = wire?.Get;
    if (!member || typeof member !== 'object') {
      throw validationError('One or more parameter values were invalid: A TransactGetItem must carry a Get');
    }
    const key = member.Key;
    if (!key || typeof key !== 'object' || Array.isArray(key)) {
      throw validationError('One or more parameter values were invalid: Key is required for Get');
    }
    return {
      tableName: memberTableName(member, 'Get'),
      key: key as AttributeMap,
      projectionExpression: optionalExpression(member.ProjectionExpression, 'ProjectionExpression'),
      ctx: memberContext(member),
    };
  });
}

// ClientRequestToken idempotency: AWS replays the original success for 10
// minutes when the same token arrives with an identical request, rejects the
// token when the request differs, and answers TransactionInProgressException
// while the first attempt is still executing (the emulator awaits table
// hydration mid-request, so same-token requests genuinely can overlap).
// Failed transactions are not cached — a retry re-executes. Memory-only,
// like the stream rings.
export const TRANSACT_TOKEN_TTL_MS = 10 * 60_000;

interface TokenEntry {
  digest: string;
  // undefined while the first attempt is still in flight.
  response?: object;
  expiresAt: number;
}

export interface TokenConflictErrors {
  mismatch: () => Error;
  inProgress: () => Error;
}

export class TransactTokenCache {
  private readonly entries = new Map<string, TokenEntry>();

  // Reserves the token (so overlapping attempts are detected) and returns
  // undefined, or returns the cached response for a replay. Throws for a
  // token reused with different parameters or still in flight.
  begin(token: string, digest: string, errors: TokenConflictErrors): object | undefined {
    this.prune();
    const entry = this.entries.get(token);
    if (entry) {
      if (entry.digest !== digest) throw errors.mismatch();
      if (entry.response === undefined) throw errors.inProgress();
      return structuredClone(entry.response);
    }
    this.entries.set(token, { digest, expiresAt: Date.now() + TRANSACT_TOKEN_TTL_MS });
    return undefined;
  }

  complete(token: string, response: object): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    entry.response = structuredClone(response);
    entry.expiresAt = Date.now() + TRANSACT_TOKEN_TTL_MS;
  }

  abandon(token: string): void {
    const entry = this.entries.get(token);
    // Only the in-flight reservation is dropped — a completed entry must
    // survive later conflicting begin() throws.
    if (entry && entry.response === undefined) this.entries.delete(token);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}
