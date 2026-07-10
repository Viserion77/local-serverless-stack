// Exact decimal-string arithmetic: the N-value math behind ADD, SET a = a + :v
// and sort-key comparison. Everything is table-driven — each row is one wire
// case the engine must get byte-exact.
import {
  addDecimals,
  subtractDecimals,
  compareDecimals,
  normalizeDecimal,
} from '../../../../src/server/engine/emulators/dynamodb/expressions/decimal';
import { AwsError } from '../../../../src/server/engine/http/errors';

describe('addDecimals', () => {
  const cases: Array<[string, string, string]> = [
    ['1', '2', '3'],
    ['0.1', '0.2', '0.3'], // the float-drift classic — must be exactly 0.3
    ['0.05', '0.05', '0.1'],
    ['9.99', '0.01', '10'],
    ['999', '1', '1000'],
    ['-1', '2', '1'],
    ['2', '-3', '-1'],
    ['-0.1', '-0.2', '-0.3'],
    ['-1', '1', '0'],
    ['0', '0', '0'],
    ['1.005', '2.995', '4'],
    ['0.30', '0.00', '0.3'],
    // integers beyond 2^53 stay exact
    ['9007199254740993', '1', '9007199254740994'],
    ['123456789012345678901234567890', '1', '123456789012345678901234567891'],
    ['99999999999999999999', '1.00000000001', '100000000000000000000.00000000001'],
    // exponent forms on the wire
    ['1e2', '5', '105'],
    ['1.5E-3', '0.0005', '0.002'],
    ['-2.5e1', '5', '-20'],
  ];
  test.each(cases)('%s + %s = %s', (a, b, expected) => {
    expect(addDecimals(a, b)).toBe(expected);
    expect(addDecimals(b, a)).toBe(expected);
  });
});

describe('subtractDecimals', () => {
  const cases: Array<[string, string, string]> = [
    ['3', '2', '1'],
    ['0.3', '0.1', '0.2'],
    ['1', '2', '-1'],
    ['-1', '-2', '1'],
    ['10.05', '0.05', '10'],
    ['1', '0.999', '0.001'],
    ['0', '0.5', '-0.5'],
    ['9007199254740994', '1', '9007199254740993'],
    ['100', '100', '0'],
  ];
  test.each(cases)('%s - %s = %s', (a, b, expected) => {
    expect(subtractDecimals(a, b)).toBe(expected);
  });
});

describe('compareDecimals', () => {
  const cases: Array<[string, string, number]> = [
    ['1', '2', -1],
    ['2', '1', 1],
    ['2', '2', 0],
    ['0.1', '0.2', -1],
    ['1.0', '1', 0],
    ['2.50', '2.5', 0],
    ['-0', '0', 0],
    ['-5', '3', -1],
    ['-5', '-3', -1],
    ['10', '9', 1], // numeric, not lexicographic
    ['1e3', '999', 1],
    ['9007199254740993', '9007199254740992', 1],
    ['0.000000000000000001', '0', 1],
  ];
  test.each(cases)('compare(%s, %s) = %i', (a, b, expected) => {
    expect(compareDecimals(a, b)).toBe(expected);
  });
});

describe('normalizeDecimal', () => {
  const cases: Array<[string, string]> = [
    ['01.10', '1.1'],
    ['-0', '0'],
    ['.5', '0.5'],
    ['5.', '5'],
    ['+7', '7'],
    ['1e2', '100'],
    ['1.5e-2', '0.015'],
    ['0e999', '0'],
    ['000', '0'],
    ['-00.500', '-0.5'],
  ];
  test.each(cases)('normalize(%s) = %s', (input, expected) => {
    expect(normalizeDecimal(input)).toBe(expected);
  });

  test.each([['abc'], [''], ['.'], ['1.2.3'], ['--1'], ['1e'], ['1,5']])(
    'rejects %s as non-numeric',
    (input) => {
      expect(() => normalizeDecimal(input)).toThrow(AwsError);
      expect(() => normalizeDecimal(input)).toThrow(/cannot be converted to a numeric value/);
    },
  );

  it('rejects magnitudes outside the supported range', () => {
    expect(() => normalizeDecimal('1e200')).toThrow(/Number overflow/);
    expect(() => normalizeDecimal('1e-200')).toThrow(/Number underflow/);
  });

  it('throws ValidationException-coded AwsError', () => {
    try {
      normalizeDecimal('nope');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AwsError);
      expect((err as AwsError).code).toBe('ValidationException');
    }
  });
});
