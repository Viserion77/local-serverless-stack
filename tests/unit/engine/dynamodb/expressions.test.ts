// Condition/FilterExpression compilation and evaluation, wire-format value
// equality/ordering and the request-level placeholder accounting. Table-driven
// against one representative item exercising every AttributeValue type.
import {
  compileCondition,
  compareAttributeValues,
  attributeValuesEqual,
  assertPlaceholdersUsed,
  expressionEngine,
} from '../../../../src/server/engine/emulators/dynamodb/expressions';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AttributeMap, AttributeValue } from '../../../../src/server/engine/types';

const b64 = (s: string) => Buffer.from(s).toString('base64');

const item: AttributeMap = {
  id: { S: 'user-1' },
  age: { N: '30' },
  active: { BOOL: true },
  nothing: { NULL: true },
  tags: { SS: ['alpha', 'beta'] },
  scores: { NS: ['1', '2.5'] },
  blobs: { BS: [b64('one'), b64('two')] },
  data: { B: b64('hello') },
  history: { L: [{ S: 'x' }, { N: '2' }, { M: { deep: { S: 'y' } } }] },
  profile: { M: { name: { S: 'Ana' }, address: { M: { city: { S: 'SP' } } }, pets: { L: [{ S: 'cat' }] } } },
};

function evaluate(expression: string, values?: AttributeMap, names?: Record<string, string>): boolean {
  return compileCondition(expression, { names, values }).evaluate(item);
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

describe('compileCondition: comparators', () => {
  const cases: Array<[string, AttributeMap, boolean]> = [
    ['id = :v', { ':v': { S: 'user-1' } }, true],
    ['id = :v', { ':v': { S: 'other' } }, false],
    ['id = :v', { ':v': { N: '1' } }, false], // '=' across types is false
    ['id <> :v', { ':v': { S: 'other' } }, true],
    ['id <> :v', { ':v': { S: 'user-1' } }, false],
    ['age > :n', { ':n': { N: '25' } }, true],
    ['age > :n', { ':n': { N: '30' } }, false],
    ['age >= :n', { ':n': { N: '30' } }, true],
    ['age < :n', { ':n': { N: '100' } }, true],
    ['age < :n', { ':n': { N: '9' } }, false], // numeric, not lexicographic
    ['age <= :n', { ':n': { N: '29.999' } }, false],
    ['id < :v', { ':v': { S: 'zzz' } }, true],
    ['data < :b', { ':b': { B: b64('zzz') } }, true],
    ['age > :n', { ':n': { S: '25' } }, false], // ordering across types is false
    ['active = :b', { ':b': { BOOL: true } }, true],
    ['nothing = :nul', { ':nul': { NULL: true } }, true],
    ['ghost = :v', { ':v': { S: 'x' } }, false], // missing attribute
    ['ghost <> :v', { ':v': { S: 'x' } }, false], // missing attribute: even <> is false
    [':v = id', { ':v': { S: 'user-1' } }, true], // value on the left
    ['profile.name = history[0]', {}, false], // path vs path
  ];
  test.each(cases)('%s -> %p', (expression, values, expected) => {
    expect(evaluate(expression, values)).toBe(expected);
  });
});

describe('compileCondition: BETWEEN and IN', () => {
  const cases: Array<[string, AttributeMap, boolean]> = [
    ['age BETWEEN :a AND :b', { ':a': { N: '20' }, ':b': { N: '40' } }, true],
    ['age BETWEEN :a AND :b', { ':a': { N: '30' }, ':b': { N: '30' } }, true], // inclusive
    ['age BETWEEN :a AND :b', { ':a': { N: '31' }, ':b': { N: '40' } }, false],
    ['id BETWEEN :a AND :b', { ':a': { S: 'a' }, ':b': { S: 'z' } }, true],
    ['ghost BETWEEN :a AND :b', { ':a': { N: '1' }, ':b': { N: '2' } }, false],
    ['age BETWEEN :a AND :b', { ':a': { S: '20' }, ':b': { N: '40' } }, false], // cross-type
    ['id IN (:a, :b)', { ':a': { S: 'nope' }, ':b': { S: 'user-1' } }, true],
    ['id IN (:a, :b)', { ':a': { S: 'nope' }, ':b': { S: 'also-nope' } }, false],
    ['ghost IN (:a)', { ':a': { S: 'x' } }, false],
    ['id IN (profile.name, :a)', { ':a': { S: 'user-1' } }, true], // path member
  ];
  test.each(cases)('%s -> %p', (expression, values, expected) => {
    expect(evaluate(expression, values)).toBe(expected);
  });
});

describe('compileCondition: boolean logic and precedence', () => {
  const v = { ':good': { S: 'user-1' }, ':bad': { S: 'nope' }, ':age': { N: '30' } };
  const cases: Array<[string, boolean]> = [
    ['id = :good AND age = :age', true],
    ['id = :good AND age = :bad', false],
    ['id = :bad OR age = :age', true],
    ['NOT id = :bad', true],
    ['NOT id = :good', false],
    ['NOT NOT id = :good', true],
    // AND binds tighter than OR: OR(bad, AND(good, good)) = true
    ['id = :bad OR id = :good AND age = :age', true],
    // parentheses override: AND(OR(bad, good), false-term) = false
    ['(id = :bad OR id = :good) AND age = :bad', false],
    // NOT binds tighter than AND: AND(NOT(bad), true-term) = true
    ['NOT id = :bad AND age = :age', true],
    ['NOT (id = :bad AND age = :age)', true],
    ['NOT (id = :good AND age = :age)', false],
  ];
  test.each(cases)('%s -> %p', (expression, expected) => {
    expect(evaluate(expression, v)).toBe(expected);
  });
});

describe('compileCondition: functions', () => {
  const cases: Array<[string, AttributeMap, boolean]> = [
    ['attribute_exists(id)', {}, true],
    ['attribute_exists(ghost)', {}, false],
    ['attribute_exists(profile.address.city)', {}, true],
    ['attribute_exists(profile.address.zip)', {}, false],
    ['attribute_not_exists(ghost)', {}, true],
    ['attribute_not_exists(id)', {}, false],
    ['attribute_type(age, :t)', { ':t': { S: 'N' } }, true],
    ['attribute_type(age, :t)', { ':t': { S: 'S' } }, false],
    ['attribute_type(tags, :t)', { ':t': { S: 'SS' } }, true],
    ['attribute_type(ghost, :t)', { ':t': { S: 'S' } }, false],
    ['begins_with(id, :p)', { ':p': { S: 'user' } }, true],
    ['begins_with(id, :p)', { ':p': { S: 'x' } }, false],
    ['begins_with(data, :p)', { ':p': { B: b64('hel') } }, true],
    ['begins_with(age, :p)', { ':p': { S: '3' } }, false], // N target: false, not error
    ['contains(id, :s)', { ':s': { S: 'ser-' } }, true],
    ['contains(id, :s)', { ':s': { S: 'xyz' } }, false],
    ['contains(tags, :s)', { ':s': { S: 'beta' } }, true],
    ['contains(scores, :n)', { ':n': { N: '2.50' } }, true], // NS membership is numeric
    ['contains(blobs, :b)', { ':b': { B: b64('two') } }, true],
    ['contains(history, :n)', { ':n': { N: '2' } }, true], // list membership
    ['contains(history, :m)', { ':m': { M: { deep: { S: 'y' } } } }, true],
    ['contains(age, :s)', { ':s': { S: '3' } }, false], // N target: false
    ['size(id) = :n', { ':n': { N: '6' } }, true],
    ['size(tags) = :n', { ':n': { N: '2' } }, true],
    ['size(scores) = :n', { ':n': { N: '2' } }, true],
    ['size(blobs) = :n', { ':n': { N: '2' } }, true],
    ['size(history) > :n', { ':n': { N: '2' } }, true],
    ['size(profile) = :n', { ':n': { N: '3' } }, true],
    ['size(data) = :n', { ':n': { N: '5' } }, true],
    ['size(ghost) = :n', { ':n': { N: '0' } }, false], // missing path: false
    [':n <= size(id)', { ':n': { N: '5' } }, true], // size on the right
    ['size(id) > size(profile.name)', {}, true],
    ['size(id) BETWEEN :a AND :b', { ':a': { N: '5' }, ':b': { N: '7' } }, true],
  ];
  test.each(cases)('%s -> %p', (expression, values, expected) => {
    expect(evaluate(expression, values)).toBe(expected);
  });
});

describe('compileCondition: document paths and placeholders', () => {
  it('resolves nested maps, list indexes and mixed paths', () => {
    expect(evaluate('profile.address.city = :c', { ':c': { S: 'SP' } })).toBe(true);
    expect(evaluate('history[1] = :n', { ':n': { N: '2' } })).toBe(true);
    expect(evaluate('history[2].deep = :y', { ':y': { S: 'y' } })).toBe(true);
    expect(evaluate('profile.pets[0] = :p', { ':p': { S: 'cat' } })).toBe(true);
    expect(evaluate('history[9] = :n', { ':n': { N: '2' } })).toBe(false);
    expect(evaluate('id[0] = :v', { ':v': { S: 'u' } })).toBe(false); // index into scalar
  });

  it('resolves #name placeholders per segment', () => {
    expect(evaluate('#p.#a.city = :c', { ':c': { S: 'SP' } }, { '#p': 'profile', '#a': 'address' })).toBe(true);
    expect(evaluate('#p.name = :n', { ':n': { S: 'Ana' } }, { '#p': 'profile' })).toBe(true);
  });

  it('rejects undefined placeholders with the AWS wording', () => {
    expectValidation(
      () => evaluate('#nope = :v', { ':v': { S: 'x' } }),
      'An expression attribute name used in the document path is not defined; attribute name: #nope',
    );
    expectValidation(
      () => evaluate('id = :missing'),
      'An expression attribute value used in expression is not defined; attribute value: :missing',
    );
  });
});

describe('compileCondition: syntax and semantic errors', () => {
  it('throws AWS-shaped syntax errors', () => {
    expectValidation(() => evaluate('id = = :v', { ':v': { S: 'x' } }), /Invalid ConditionExpression: Syntax error; token: "="/);
    expectValidation(() => evaluate('id ='), /Syntax error; token: "<EOF>"/);
    expectValidation(() => evaluate('id'), /Syntax error/);
    expectValidation(() => evaluate('(id = :v', { ':v': { S: 'x' } }), /Syntax error/);
    expectValidation(() => evaluate('id = :v)', { ':v': { S: 'x' } }), /Syntax error/);
    expectValidation(() => evaluate('id ~ :v', { ':v': { S: 'x' } }), /Syntax error/);
    expectValidation(() => evaluate('id = :v AND', { ':v': { S: 'x' } }), /Syntax error/);
  });

  it('rejects empty expressions', () => {
    expectValidation(() => evaluate('  '), 'Invalid ConditionExpression: The expression can not be empty;');
  });

  it('labels FilterExpression errors when asked to', () => {
    expectValidation(
      () => compileCondition('id =', {}, 'FilterExpression'),
      /Invalid FilterExpression: Syntax error/,
    );
  });

  it('rejects unknown and misused functions', () => {
    expectValidation(() => evaluate('foo(id)'), /Invalid function name; function: foo/);
    expectValidation(() => evaluate('if_not_exists(id, :v)', { ':v': { S: 'x' } }), /not allowed to be used this way; function: if_not_exists/);
    expectValidation(() => evaluate('ATTRIBUTE_EXISTS(id)'), /Invalid function name; function: ATTRIBUTE_EXISTS/);
  });

  it('validates function arity and path arguments', () => {
    expectValidation(() => evaluate('begins_with(id)'), /Incorrect number of operands for operator or function; operator or function: begins_with, number of operands: 1/);
    expectValidation(() => evaluate('attribute_exists(id, age)'), /Incorrect number of operands/);
    expectValidation(() => evaluate('attribute_exists(:v)', { ':v': { S: 'x' } }), /requires a document path; operator or function: attribute_exists/);
    expectValidation(() => evaluate('size(:v) = :v', { ':v': { S: 'x' } }), /requires a document path; operator or function: size/);
  });

  it('validates attribute_type type names', () => {
    expectValidation(() => evaluate('attribute_type(age, :t)', { ':t': { S: 'X' } }), /Invalid attribute type name found; type: X, valid types:/);
    expectValidation(() => evaluate('attribute_type(age, :t)', { ':t': { N: '1' } }), /Invalid attribute type name found/);
  });

  it('caps IN at 100 operands', () => {
    const values: AttributeMap = {};
    const members: string[] = [];
    for (let i = 0; i < 101; i++) {
      values[`:v${i}`] = { N: String(i) };
      members.push(`:v${i}`);
    }
    expectValidation(
      () => evaluate(`age IN (${members.join(', ')})`, values),
      /Too many operands for the operator or function; operator or function: IN, number of operands: 101/,
    );
    expect(evaluate(`age IN (${members.slice(0, 100).join(', ')})`, values)).toBe(true); // 30 is a member
  });
});

describe('attributeValuesEqual', () => {
  const cases: Array<[AttributeValue, AttributeValue, boolean]> = [
    [{ S: 'a' }, { S: 'a' }, true],
    [{ S: 'a' }, { S: 'b' }, false],
    [{ N: '1.0' }, { N: '1' }, true], // numeric equality
    [{ N: '1' }, { S: '1' }, false], // cross-type
    [{ B: b64('x') }, { B: b64('x') }, true],
    [{ BOOL: false }, { BOOL: false }, true],
    [{ BOOL: true }, { BOOL: false }, false],
    [{ NULL: true }, { NULL: true }, true],
    [{ SS: ['a', 'b'] }, { SS: ['b', 'a'] }, true], // sets are order-insensitive
    [{ SS: ['a'] }, { SS: ['a', 'b'] }, false],
    [{ NS: ['1', '2.50'] }, { NS: ['2.5', '1.0'] }, true],
    [{ BS: [b64('a'), b64('b')] }, { BS: [b64('b'), b64('a')] }, true],
    [{ L: [{ S: 'a' }, { S: 'b' }] }, { L: [{ S: 'b' }, { S: 'a' }] }, false], // lists are ordered
    [{ L: [{ N: '1' }] }, { L: [{ N: '1.0' }] }, true],
    [{ M: { a: { N: '1' } } }, { M: { a: { N: '1' } } }, true],
    [{ M: { a: { N: '1' } } }, { M: { a: { N: '2' } } }, false],
    [{ M: { a: { N: '1' } } }, { M: { a: { N: '1' }, b: { N: '2' } } }, false],
  ];
  test.each(cases)('%p vs %p -> %p', (a, b, expected) => {
    expect(attributeValuesEqual(a, b)).toBe(expected);
    expect(attributeValuesEqual(b, a)).toBe(expected);
  });
});

describe('compareAttributeValues', () => {
  it('orders S lexicographically, N numerically, B bytewise', () => {
    expect(compareAttributeValues({ S: 'a' }, { S: 'b' })).toBeLessThan(0);
    expect(compareAttributeValues({ S: 'b' }, { S: 'a' })).toBeGreaterThan(0);
    expect(compareAttributeValues({ S: 'a' }, { S: 'a' })).toBe(0);
    expect(compareAttributeValues({ N: '10' }, { N: '9' })).toBeGreaterThan(0);
    expect(compareAttributeValues({ N: '2.5' }, { N: '2.50' })).toBe(0);
    expect(compareAttributeValues({ B: b64('a') }, { B: b64('b') })).toBeLessThan(0);
    expect(compareAttributeValues({ B: b64('ab') }, { B: b64('a') })).toBeGreaterThan(0);
  });

  it('stays a total order on non-scalar or cross-type pairs', () => {
    expect(compareAttributeValues({ BOOL: true }, { BOOL: true })).toBe(0);
    const cross = compareAttributeValues({ S: '1' }, { N: '1' });
    expect(cross === 0).toBe(false);
    expect(compareAttributeValues({ N: '1' }, { S: '1' })).toBe(-cross);
  });
});

describe('assertPlaceholdersUsed', () => {
  it('accepts placeholders shared across a request expression set', () => {
    expect(() =>
      assertPlaceholdersUsed(
        ['#pk = :v', 'begins_with(#sk, :p)', '#pk, #sk'],
        { names: { '#pk': 'id', '#sk': 'sort' }, values: { ':v': { S: 'x' }, ':p': { S: 'y' } } },
      ),
    ).not.toThrow();
  });

  it('ignores null/undefined expressions and empty contexts', () => {
    expect(() => assertPlaceholdersUsed([undefined, null, ''], {})).not.toThrow();
  });

  it('reports unused names with the AWS wording', () => {
    expectValidation(
      () => assertPlaceholdersUsed(['id = :v'], { names: { '#x': 'id' }, values: { ':v': { S: 'a' } } }),
      'Value provided in ExpressionAttributeNames unused in expressions: keys: {#x}',
    );
    expectValidation(
      () => assertPlaceholdersUsed(['id = :v'], { names: { '#a': 'x', '#b': 'y' }, values: { ':v': { S: 'a' } } }),
      'Value provided in ExpressionAttributeNames unused in expressions: keys: {#a, #b}',
    );
  });

  it('reports unused values with the AWS wording', () => {
    expectValidation(
      () => assertPlaceholdersUsed(['id = :v'], { values: { ':v': { S: 'a' }, ':w': { S: 'b' } } }),
      'Value provided in ExpressionAttributeValues unused in expressions: keys: {:w}',
    );
  });
});

describe('expressionEngine object', () => {
  it('exposes the same implementations as the named exports', () => {
    expect(expressionEngine.compileCondition('id = :v', { values: { ':v': { S: 'user-1' } } }).evaluate(item)).toBe(true);
    expect(expressionEngine.attributeValuesEqual({ N: '1' }, { N: '1.0' })).toBe(true);
    expect(expressionEngine.compareAttributeValues({ N: '2' }, { N: '10' })).toBeLessThan(0);
  });
});
