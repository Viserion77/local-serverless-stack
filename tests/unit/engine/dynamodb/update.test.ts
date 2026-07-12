// UpdateExpression application: SET (arithmetic, if_not_exists, list_append),
// REMOVE, ADD, DELETE, path-creation rules, overlap validation and strict
// input immutability.
import { applyUpdate } from '../../../../src/server/engine/emulators/dynamodb/expressions';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap } from '../../../../src/server/engine/types';

const b64 = (s: string) => Buffer.from(s).toString('base64');

function baseItem(): AttributeMap {
  return {
    id: { S: 'user-1' },
    age: { N: '30' },
    balance: { N: '0.1' },
    tags: { SS: ['alpha', 'beta'] },
    scores: { NS: ['1', '2.5'] },
    blobs: { BS: [b64('one')] },
    history: { L: [{ S: 'x' }, { N: '2' }, { S: 'z' }] },
    profile: { M: { name: { S: 'Ana' }, address: { M: { city: { S: 'SP' } } } } },
  };
}

function up(expression: string, values?: AttributeMap, names?: Record<string, string>, item: AttributeMap = baseItem()): AttributeMap {
  return applyUpdate(expression, item, { names, values });
}

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

describe('applyUpdate: SET', () => {
  it('sets new and existing top-level attributes', () => {
    const result = up('SET nick = :n, age = :a', { ':n': { S: 'aninha' }, ':a': { N: '31' } });
    expect(result.nick).toEqual({ S: 'aninha' });
    expect(result.age).toEqual({ N: '31' });
  });

  it('sets nested map keys and #name placeholders', () => {
    const result = up('SET profile.#n = :n, profile.address.zip = :z',
      { ':n': { S: 'Bia' }, ':z': { S: '01310' } }, { '#n': 'name' });
    expect(result.profile.M!.name).toEqual({ S: 'Bia' });
    expect(result.profile.M!.address.M!.zip).toEqual({ S: '01310' });
  });

  it('copies from another path (reading the original image)', () => {
    const result = up('SET copy = profile.name', {});
    expect(result.copy).toEqual({ S: 'Ana' });
  });

  it('replaces list elements and appends beyond the end', () => {
    const result = up('SET history[0] = :v, history[10] = :w', { ':v': { S: 'first' }, ':w': { S: 'last' } });
    expect(result.history.L).toEqual([{ S: 'first' }, { N: '2' }, { S: 'z' }, { S: 'last' }]);
  });

  it('rejects paths through missing maps, then succeeds once the map exists', () => {
    expectValidation(
      () => up('SET meta.count = :v', { ':v': { N: '1' } }),
      'The document path provided in the update expression is invalid for update',
    );
    const withMap = up('SET meta = :m', { ':m': { M: {} } });
    const result = applyUpdate('SET meta.count = :v', withMap, { values: { ':v': { N: '1' } } });
    expect(result.meta).toEqual({ M: { count: { N: '1' } } });
  });

  it('rejects indexing into non-lists and missing lists', () => {
    expectValidation(() => up('SET ghost[0] = :v', { ':v': { S: 'x' } }), /invalid for update/);
    expectValidation(() => up('SET id[0] = :v', { ':v': { S: 'x' } }), /invalid for update/);
  });

  it('does exact decimal arithmetic', () => {
    expect(up('SET age = age + :one', { ':one': { N: '1' } }).age).toEqual({ N: '31' });
    expect(up('SET age = age - :n', { ':n': { N: '0.5' } }).age).toEqual({ N: '29.5' });
    expect(up('SET total = balance + :v', { ':v': { N: '0.2' } }).total).toEqual({ N: '0.3' });
    expect(up('SET big = :a + :b', { ':a': { N: '9007199254740993' }, ':b': { N: '1' } }).big)
      .toEqual({ N: '9007199254740994' });
  });

  it('rejects arithmetic on non-numbers and missing operands', () => {
    expectValidation(
      () => up('SET age = id + :one', { ':one': { N: '1' } }),
      'An operand in the update expression has an incorrect data type',
    );
    expectValidation(
      () => up('SET age = ghost + :one', { ':one': { N: '1' } }),
      'The provided expression refers to an attribute that does not exist in the item',
    );
    expectValidation(() => up('SET copy = ghost', {}), /does not exist in the item/);
  });

  it('applies if_not_exists', () => {
    expect(up('SET age = if_not_exists(age, :d)', { ':d': { N: '0' } }).age).toEqual({ N: '30' });
    expect(up('SET views = if_not_exists(views, :d)', { ':d': { N: '0' } }).views).toEqual({ N: '0' });
    expect(up('SET views = if_not_exists(views, :d) + :one', { ':d': { N: '0' }, ':one': { N: '1' } }).views)
      .toEqual({ N: '1' });
    expect(up('SET x = if_not_exists(ghost, if_not_exists(age, :d))', { ':d': { N: '0' } }).x).toEqual({ N: '30' });
  });

  it('applies list_append in both directions', () => {
    expect(up('SET history = list_append(history, :more)', { ':more': { L: [{ S: 'w' }] } }).history.L)
      .toEqual([{ S: 'x' }, { N: '2' }, { S: 'z' }, { S: 'w' }]);
    expect(up('SET history = list_append(:more, history)', { ':more': { L: [{ S: 'w' }] } }).history.L)
      .toEqual([{ S: 'w' }, { S: 'x' }, { N: '2' }, { S: 'z' }]);
    expectValidation(
      () => up('SET history = list_append(history, :notalist)', { ':notalist': { S: 'x' } }),
      'An operand in the update expression has an incorrect data type',
    );
  });

  it('rejects misused and unknown functions in SET', () => {
    expectValidation(() => up('SET x = size(id)', {}), /not allowed to be used this way; function: size/);
    expectValidation(() => up('SET x = attribute_exists(id)', {}), /not allowed to be used this way/);
    expectValidation(() => up('SET x = foo(id)', {}), /Invalid function name; function: foo/);
  });
});

describe('applyUpdate: REMOVE', () => {
  it('removes attributes and nested paths', () => {
    const result = up('REMOVE age, profile.address.city', {});
    expect(result.age).toBeUndefined();
    expect(result.profile.M!.address).toEqual({ M: {} });
  });

  it('removes list elements by original index, in one splice pass', () => {
    expect(up('REMOVE history[0], history[2]', {}).history.L).toEqual([{ N: '2' }]);
    expect(up('REMOVE history[2], history[0]', {}).history.L).toEqual([{ N: '2' }]);
  });

  it('treats missing targets as no-ops', () => {
    expect(up('REMOVE ghost', {})).toEqual(baseItem());
    expect(up('REMOVE history[9]', {})).toEqual(baseItem());
    expect(up('REMOVE ghost.deeper', {})).toEqual(baseItem());
  });
});

describe('applyUpdate: ADD', () => {
  it('adds numbers with decimal exactness', () => {
    expect(up('ADD age :n', { ':n': { N: '2.5' } }).age).toEqual({ N: '32.5' });
    expect(up('ADD balance :n', { ':n': { N: '0.2' } }).balance).toEqual({ N: '0.3' });
    expect(up('ADD counter :n', { ':n': { N: '5' } }).counter).toEqual({ N: '5' }); // missing → value
  });

  it('unions sets without duplicates', () => {
    expect(up('ADD tags :t', { ':t': { SS: ['beta', 'gamma'] } }).tags).toEqual({ SS: ['alpha', 'beta', 'gamma'] });
    expect(up('ADD scores :s', { ':s': { NS: ['2.50', '3'] } }).scores).toEqual({ NS: ['1', '2.5', '3'] });
    expect(up('ADD blobs :b', { ':b': { BS: [b64('one'), b64('two')] } }).blobs).toEqual({ BS: [b64('one'), b64('two')] });
    expect(up('ADD newset :t', { ':t': { SS: ['x'] } }).newset).toEqual({ SS: ['x'] });
  });

  it('rejects ADD with non-number/non-set values at parse time', () => {
    expectValidation(
      () => up('ADD age :v', { ':v': { S: 'x' } }),
      /Incorrect operand type for operator or function; operator: ADD, operand type: STRING/,
    );
    expectValidation(() => up('ADD age :v', { ':v': { M: {} } }), /operand type: MAP/);
    expectValidation(() => up('ADD age :v', { ':v': { L: [] } }), /operand type: LIST/);
  });

  it('rejects ADD on mismatched existing types at apply time', () => {
    expectValidation(() => up('ADD id :n', { ':n': { N: '1' } }), 'An operand in the update expression has an incorrect data type');
    expectValidation(() => up('ADD tags :n', { ':n': { NS: ['1'] } }), /incorrect data type/);
  });

  it('rejects ADD into a missing parent map', () => {
    expectValidation(() => up('ADD ghost.count :n', { ':n': { N: '1' } }), /invalid for update/);
  });
});

describe('applyUpdate: DELETE', () => {
  it('removes set members and drops empty sets', () => {
    expect(up('DELETE tags :t', { ':t': { SS: ['beta'] } }).tags).toEqual({ SS: ['alpha'] });
    expect(up('DELETE scores :s', { ':s': { NS: ['2.50'] } }).scores).toEqual({ NS: ['1'] });
    expect(up('DELETE tags :t', { ':t': { SS: ['alpha', 'beta'] } }).tags).toBeUndefined();
    expect(up('DELETE blobs :b', { ':b': { BS: [b64('one')] } }).blobs).toBeUndefined();
  });

  it('ignores absent members and missing attributes', () => {
    expect(up('DELETE tags :t', { ':t': { SS: ['nope'] } }).tags).toEqual({ SS: ['alpha', 'beta'] });
    expect(up('DELETE ghost :t', { ':t': { SS: ['x'] } })).toEqual(baseItem());
  });

  it('rejects non-set values and mismatched set types', () => {
    expectValidation(
      () => up('DELETE tags :v', { ':v': { N: '1' } }),
      /Incorrect operand type for operator or function; operator: DELETE, operand type: NUMBER/,
    );
    expectValidation(() => up('DELETE tags :v', { ':v': { NS: ['1'] } }), 'An operand in the update expression has an incorrect data type');
  });
});

describe('applyUpdate: clause structure and overlap', () => {
  it('combines all four clauses in one expression', () => {
    const result = up('SET nick = :n REMOVE age ADD scores :s DELETE tags :t', {
      ':n': { S: 'aninha' }, ':s': { NS: ['9' ] }, ':t': { SS: ['alpha'] },
    });
    expect(result.nick).toEqual({ S: 'aninha' });
    expect(result.age).toBeUndefined();
    expect(result.scores).toEqual({ NS: ['1', '2.5', '9'] });
    expect(result.tags).toEqual({ SS: ['beta'] });
  });

  it('rejects a repeated clause', () => {
    expectValidation(
      () => up('SET a = :v SET b = :v', { ':v': { S: 'x' } }),
      'Invalid UpdateExpression: The "SET" section can only be used once in an update expression;',
    );
    expectValidation(() => up('REMOVE age REMOVE id', {}), /"REMOVE" section can only be used once/);
  });

  it('rejects overlapping document paths', () => {
    expectValidation(
      () => up('SET profile.name = :v REMOVE profile', { ':v': { S: 'x' } }),
      'Invalid UpdateExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [profile, name], path two: [profile]',
    );
    expectValidation(() => up('SET a = :v, a = :w', { ':v': { S: 'x' }, ':w': { S: 'y' } }), /Two document paths overlap/);
    expectValidation(() => up('SET history[0] = :v REMOVE history[0]', { ':v': { S: 'x' } }), /path one: \[history, \[0\]\]/);
  });

  it('allows sibling paths that do not overlap', () => {
    const result = up('SET history[0] = :v, history[1] = :w REMOVE profile.name', { ':v': { S: 'a' }, ':w': { S: 'b' } });
    expect(result.history.L).toEqual([{ S: 'a' }, { S: 'b' }, { S: 'z' }]);
    expect(result.profile.M!.name).toBeUndefined();
  });

  it('throws syntax errors with the UpdateExpression label', () => {
    expectValidation(() => up('SET', {}), /Invalid UpdateExpression: Syntax error/);
    expectValidation(() => up('FOO a', {}), /Invalid UpdateExpression: Syntax error; token: "FOO"/);
    expectValidation(() => up('ADD age 5', {}), /Invalid UpdateExpression: Syntax error/);
    expectValidation(() => up('REMOVE age,', {}), /Invalid UpdateExpression: Syntax error/);
    expectValidation(() => up('', {}), 'Invalid UpdateExpression: The expression can not be empty;');
  });

  it('rejects undefined placeholders', () => {
    expectValidation(() => up('SET a = :nope', {}), 'An expression attribute value used in expression is not defined; attribute value: :nope');
    expectValidation(() => up('SET #nope = :v', { ':v': { S: 'x' } }), 'An expression attribute name used in the document path is not defined; attribute name: #nope');
  });
});

describe('applyUpdate: immutability', () => {
  it('never mutates the input item', () => {
    const item = baseItem();
    const snapshot = JSON.stringify(item);
    up('SET profile.name = :v, history[0] = :w REMOVE age ADD tags :t DELETE scores :s', {
      ':v': { S: 'Bia' }, ':w': { S: 'first' }, ':t': { SS: ['x'] }, ':s': { NS: ['1'] },
    }, undefined, item);
    expect(JSON.stringify(item)).toBe(snapshot);
  });

  it('returns an item that does not alias the input', () => {
    const item = baseItem();
    const result = applyUpdate('SET copy = profile', item, { values: {} });
    result.copy.M!.name.S = 'mutated';
    expect(item.profile.M!.name.S).toBe('Ana');
    result.history.L![0].S = 'mutated';
    expect(item.history.L![0].S).toBe('x');
  });
});
