// KeyConditionExpression parsing: the restricted grammar (partition equality
// plus one optional sort-key range term) and every AWS rejection the emulator
// core relies on.
import { parseKeyCondition } from '../../../../src/server/engine/emulators/dynamodb/expressions';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap } from '../../../../src/server/engine/types';

const values: AttributeMap = {
  ':pk': { S: 'user-1' },
  ':a': { N: '1' },
  ':b': { N: '9' },
  ':p': { S: 'ORDER#' },
};

function expectValidation(fn: () => unknown, pattern: RegExp | string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AwsError);
    expect((err as AwsError).code).toBe('ValidationException');
    if (typeof pattern === 'string') expect((err as AwsError).message).toBe(pattern);
    else expect((err as AwsError).message).toMatch(pattern);
    return;
  }
  throw new Error('expected a ValidationException');
}

describe('parseKeyCondition: accepted forms', () => {
  it('parses a partition-only equality', () => {
    expect(parseKeyCondition('pk = :pk', { values })).toEqual({
      partition: { name: 'pk', value: { S: 'user-1' } },
    });
  });

  it('resolves #name placeholders', () => {
    expect(parseKeyCondition('#p = :pk', { names: { '#p': 'userId' }, values })).toEqual({
      partition: { name: 'userId', value: { S: 'user-1' } },
    });
  });

  test.each(['<', '<=', '>', '>='])('parses sort-key comparator %s', (op) => {
    const parsed = parseKeyCondition(`pk = :pk AND sk ${op} :a`, { values });
    expect(parsed.partition).toEqual({ name: 'pk', value: { S: 'user-1' } });
    expect(parsed.sort).toEqual({ name: 'sk', operator: op, values: [{ N: '1' }] });
  });

  it('parses sort-key equality and BETWEEN', () => {
    expect(parseKeyCondition('pk = :pk AND sk = :a', { values }).sort).toEqual({
      name: 'sk', operator: '=', values: [{ N: '1' }],
    });
    expect(parseKeyCondition('pk = :pk AND sk BETWEEN :a AND :b', { values }).sort).toEqual({
      name: 'sk', operator: 'BETWEEN', values: [{ N: '1' }, { N: '9' }],
    });
  });

  it('parses begins_with on the sort key', () => {
    expect(parseKeyCondition('pk = :pk AND begins_with(sk, :p)', { values }).sort).toEqual({
      name: 'sk', operator: 'begins_with', values: [{ S: 'ORDER#' }],
    });
    expect(parseKeyCondition('pk = :pk AND begins_with(#s, :p)', { names: { '#s': 'sortKey' }, values }).sort).toEqual({
      name: 'sortKey', operator: 'begins_with', values: [{ S: 'ORDER#' }],
    });
  });

  it('designates the equality term as partition regardless of order', () => {
    const parsed = parseKeyCondition('sk > :a AND pk = :pk', { values });
    expect(parsed.partition).toEqual({ name: 'pk', value: { S: 'user-1' } });
    expect(parsed.sort).toEqual({ name: 'sk', operator: '>', values: [{ N: '1' }] });
  });

  it('accepts parenthesized terms', () => {
    expect(parseKeyCondition('(pk = :pk) AND (sk < :a)', { values }).sort?.operator).toBe('<');
    expect(parseKeyCondition('(pk = :pk AND sk < :a)', { values }).partition.name).toBe('pk');
    expect(parseKeyCondition('((pk = :pk))', { values }).partition.name).toBe('pk');
  });
});

describe('parseKeyCondition: rejections', () => {
  it('rejects OR, NOT and <>', () => {
    expectValidation(() => parseKeyCondition('pk = :pk OR sk = :a', { values }), 'Invalid operator used in KeyConditionExpression: OR');
    expectValidation(() => parseKeyCondition('NOT pk = :pk', { values }), 'Invalid operator used in KeyConditionExpression: NOT');
    expectValidation(() => parseKeyCondition('pk = :pk AND NOT sk = :a', { values }), 'Invalid operator used in KeyConditionExpression: NOT');
    expectValidation(() => parseKeyCondition('pk <> :pk', { values }), 'Invalid operator used in KeyConditionExpression: <>');
  });

  it('rejects more than two terms', () => {
    expectValidation(
      () => parseKeyCondition('pk = :pk AND sk > :a AND sk < :b', { values }),
      'Conditions can be of length 1 or 2 only',
    );
  });

  it('rejects two conditions on the same key', () => {
    expectValidation(
      () => parseKeyCondition('sk > :a AND sk < :b', { values }),
      'KeyConditionExpressions must only contain one condition per key',
    );
  });

  it('requires an equality term', () => {
    expectValidation(() => parseKeyCondition('pk > :a', { values }), 'Query key condition not supported');
    expectValidation(() => parseKeyCondition('pk BETWEEN :a AND :b', { values }), 'Query key condition not supported');
    expectValidation(() => parseKeyCondition('begins_with(pk, :p)', { values }), 'Query key condition not supported');
    expectValidation(() => parseKeyCondition('pk > :a AND sk < :b', { values }), 'Query key condition not supported');
  });

  it('rejects non-key functions', () => {
    expectValidation(() => parseKeyCondition('attribute_exists(pk)', { values }), 'Invalid operator used in KeyConditionExpression: attribute_exists');
    expectValidation(() => parseKeyCondition('pk = :pk AND contains(sk, :p)', { values }), 'Invalid operator used in KeyConditionExpression: contains');
    expectValidation(() => parseKeyCondition('pk = :pk AND size(sk) = :a', { values }), 'Invalid operator used in KeyConditionExpression: size');
    expectValidation(() => parseKeyCondition('foo(pk, :p)', { values }), /Invalid function name; function: foo/);
  });

  it('rejects nested paths and non-value operands', () => {
    expectValidation(() => parseKeyCondition('a.b = :pk', { values }), /Syntax error/);
    expectValidation(() => parseKeyCondition('a[0] = :pk', { values }), /Syntax error/);
    expectValidation(() => parseKeyCondition('pk = sk', { values }), /Syntax error/);
    expectValidation(() => parseKeyCondition('pk = :pk AND sk BETWEEN :a AND sk2', { values }), /Syntax error/);
  });

  it('rejects undefined placeholders and empty expressions', () => {
    expectValidation(
      () => parseKeyCondition('pk = :nope', { values }),
      'An expression attribute value used in expression is not defined; attribute value: :nope',
    );
    expectValidation(
      () => parseKeyCondition('#nope = :pk', { values }),
      'An expression attribute name used in the document path is not defined; attribute name: #nope',
    );
    expectValidation(() => parseKeyCondition('', { values }), 'Invalid KeyConditionExpression: The expression can not be empty;');
  });

  it('prefixes syntax errors with the KeyConditionExpression label', () => {
    expectValidation(() => parseKeyCondition('pk = ', { values }), /Invalid KeyConditionExpression: Syntax error; token: "<EOF>"/);
  });
});
