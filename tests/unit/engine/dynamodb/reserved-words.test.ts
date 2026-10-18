// Reserved words and missing-attribute comparison semantics of the
// expression engine. AWS rejects a bare reserved word used as an attribute
// name in every expression kind (case-insensitively, echoing the token as
// written), while placeholders, function names and the grammar's own
// keywords keep working. `<>` against a missing attribute is TRUE — the
// only comparator for which that holds.
import {
  applyProjection, applyUpdate, compileCondition, parseKeyCondition,
} from '../../../../src/server/engine/emulators/dynamodb/expressions';
import {
  isReservedWord, RESERVED_WORDS,
} from '../../../../src/server/engine/emulators/dynamodb/expressions/reserved-words';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap } from '../../../../src/server/engine/types';

const item: AttributeMap = {
  id: { S: 'order-1' },
  status: { S: 'OPEN' },
  amount: { N: '10' },
  profile: { M: { name: { S: 'acme' } } },
};

function expectReserved(fn: () => unknown, label: string, token: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  expect((caught as AwsError).code).toBe('ValidationException');
  expect((caught as AwsError).message).toBe(
    `Invalid ${label}: Attribute name is a reserved keyword; reserved keyword: ${token}`,
  );
}

const evaluate = (expression: string, values?: AttributeMap, names?: Record<string, string>): boolean =>
  compileCondition(expression, { names, values }).evaluate(item);

describe('reserved word list', () => {
  it('carries the full published DynamoDB list', () => {
    expect(RESERVED_WORDS.size).toBe(573);
    for (const word of ['ABORT', 'STATUS', 'NAME', 'DATA', 'SIZE', 'TTL', 'ZONE']) {
      expect(RESERVED_WORDS.has(word)).toBe(true);
    }
  });

  it('matches case-insensitively', () => {
    expect(isReservedWord('status')).toBe(true);
    expect(isReservedWord('Status')).toBe(true);
    expect(isReservedWord('orderId')).toBe(false);
  });
});

describe('bare reserved words in expressions', () => {
  it('rejects them in condition and filter expressions, echoing the token as written', () => {
    expectReserved(() => evaluate('status = :v', { ':v': { S: 'OPEN' } }), 'ConditionExpression', 'status');
    expectReserved(() => evaluate('Status = :v', { ':v': { S: 'OPEN' } }), 'ConditionExpression', 'Status');
    expectReserved(
      () => compileCondition('attribute_exists(data)', {}, 'FilterExpression'),
      'FilterExpression',
      'data',
    );
  });

  it('checks every path segment, not just the first', () => {
    expectReserved(() => evaluate('profile.name = :v', { ':v': { S: 'acme' } }), 'ConditionExpression', 'name');
  });

  it('rejects `size` used as a bare path but accepts the size() function', () => {
    expectReserved(() => evaluate('size = :n', { ':n': { N: '1' } }), 'ConditionExpression', 'size');
    expect(evaluate('size(#s) = :n', { ':n': { N: '4' } }, { '#s': 'status' })).toBe(true);
  });

  it('accepts placeholders and keeps the grammar keywords working', () => {
    expect(evaluate('#s = :v', { ':v': { S: 'OPEN' } }, { '#s': 'status' })).toBe(true);
    expect(evaluate('profile.#n = :v', { ':v': { S: 'acme' } }, { '#n': 'name' })).toBe(true);
    expect(evaluate(
      'NOT (id = :x) AND (amount BETWEEN :lo AND :hi OR id IN (:x, :y))',
      { ':x': { S: 'nope' }, ':y': { S: 'order-1' }, ':lo': { N: '1' }, ':hi': { N: '20' } },
    )).toBe(true);
  });

  it('rejects them in key conditions', () => {
    expectReserved(
      () => parseKeyCondition('id = :id AND timestamp > :t', { values: { ':id': { S: 'a' }, ':t': { N: '1' } } }),
      'KeyConditionExpression',
      'timestamp',
    );
    expect(parseKeyCondition('#pk = :id', { names: { '#pk': 'user' }, values: { ':id': { S: 'a' } } }).partition.name)
      .toBe('user');
  });

  it('rejects them in update expressions (SET targets and operands, REMOVE)', () => {
    expectReserved(() => applyUpdate('SET status = :v', item, { values: { ':v': { S: 'PAID' } } }), 'UpdateExpression', 'status');
    expectReserved(() => applyUpdate('SET note = total', item, {}), 'UpdateExpression', 'total');
    expectReserved(() => applyUpdate('REMOVE ttl', item, {}), 'UpdateExpression', 'ttl');
    const updated = applyUpdate('SET #s = :v REMOVE amount', item, { names: { '#s': 'status' }, values: { ':v': { S: 'PAID' } } });
    expect(updated.status).toEqual({ S: 'PAID' });
    expect(updated.amount).toBeUndefined();
  });

  it('rejects them in projection expressions', () => {
    expectReserved(() => applyProjection('id, status', item, {}), 'ProjectionExpression', 'status');
    expect(applyProjection('id, #s', item, { names: { '#s': 'status' } })).toEqual({ id: item.id, status: item.status });
  });
});

describe('comparisons against a missing attribute', () => {
  const v = { ':v': { S: 'x' } };

  it('makes <> true and every other comparator false', () => {
    expect(evaluate('ghost <> :v', v)).toBe(true);
    expect(evaluate(':v <> ghost', v)).toBe(true);
    expect(evaluate('ghost = :v', v)).toBe(false);
    for (const op of ['<', '<=', '>', '>=']) expect(evaluate(`ghost ${op} :v`, v)).toBe(false);
  });

  it('keeps <> and NOT (=) equivalent', () => {
    expect(evaluate('NOT (ghost = :v)', v)).toBe(evaluate('ghost <> :v', v));
    expect(evaluate('NOT (id = :v)', v)).toBe(evaluate('id <> :v', v));
    expect(evaluate('id <> :v', { ':v': { S: 'order-1' } })).toBe(false);
  });

  it('applies to size() of a missing attribute too, and leaves IN false', () => {
    expect(evaluate('size(ghost) <> :n', { ':n': { N: '0' } })).toBe(true);
    expect(evaluate('size(ghost) = :n', { ':n': { N: '0' } })).toBe(false);
    expect(evaluate('ghost IN (:v)', v)).toBe(false);
  });
});
