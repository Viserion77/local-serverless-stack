// Table-driven tests for the pure EventBridge pattern matcher and the PutRule
// validator (v1 semantics: exact / OR / prefix / exists / nesting; unsupported
// operators are surfaced by validatePattern, never silently at match time).
import { matches, validatePattern } from '../../../../src/server/engine/emulators/events/pattern';

describe('matches', () => {
  const event = {
    version: '0',
    'detail-type': 'UserSignedUp',
    source: 'app.users',
    account: '000000000000',
    region: 'us-east-1',
    resources: ['arn:aws:events:us-east-1:000000000000:rule/a'],
    detail: {
      plan: 'pro',
      seats: 5,
      active: true,
      churnedAt: null,
      nested: { deep: 'value' },
      tags: ['beta', 'founder'],
      items: [{ sku: 'A-1', qty: 1 }, { sku: 'B-2', qty: 2 }],
    },
  };

  const table: Array<[string, unknown, boolean]> = [
    ['exact string', { source: ['app.users'] }, true],
    ['exact string mismatch', { source: ['app.orders'] }, false],
    ['multi-value OR hits', { source: ['app.orders', 'app.users'] }, true],
    ['multi-value OR misses', { source: ['app.orders', 'app.billing'] }, false],
    ['top-level hyphenated key', { 'detail-type': ['UserSignedUp'] }, true],
    ['numeric equality', { detail: { seats: [5] } }, true],
    ['numeric equality with float literal', { detail: { seats: [5.0] } }, true],
    ['number does not match numeric string', { detail: { plan: [5] } }, false],
    ['string does not match number', { detail: { seats: ['5'] } }, false],
    ['boolean exact', { detail: { active: [true] } }, true],
    ['boolean mismatch', { detail: { active: [false] } }, false],
    ['null exact', { detail: { churnedAt: [null] } }, true],
    ['prefix', { source: [{ prefix: 'app.' }] }, true],
    ['prefix mismatch', { source: [{ prefix: 'aws.' }] }, false],
    ['prefix on non-string value', { detail: { seats: [{ prefix: '5' }] } }, false],
    ['exists true on present key', { detail: { plan: [{ exists: true }] } }, true],
    ['exists true on missing key', { detail: { missing: [{ exists: true }] } }, false],
    ['exists false on missing key', { detail: { missing: [{ exists: false }] } }, true],
    ['exists false on present key', { detail: { plan: [{ exists: false }] } }, false],
    ['nested object recursion', { detail: { nested: { deep: ['value'] } } }, true],
    ['nested object mismatch', { detail: { nested: { deep: ['other'] } } }, false],
    ['nested pattern under missing key', { detail: { missing: { deep: ['value'] } } }, false],
    ['nested exists false under non-object value', { detail: { plan: { deep: [{ exists: false }] } } }, true],
    ['missing key never matches values', { detail: { missing: ['x'] } }, false],
    ['event array matches on any element', { detail: { tags: ['founder'] } }, true],
    ['event array with no matching element', { detail: { tags: ['vip'] } }, false],
    ['event array prefix on any element', { detail: { tags: [{ prefix: 'found' }] } }, true],
    ['event array of objects matches on any element', { detail: { items: { sku: ['B-2'] } } }, true],
    ['event array of objects with no matching element', { detail: { items: { sku: ['C-3'] } } }, false],
    ['multiple keys AND together', { source: ['app.users'], detail: { plan: ['pro'] } }, true],
    ['multiple keys AND fails when one misses', { source: ['app.users'], detail: { plan: ['free'] } }, false],
    ['empty pattern object matches everything', {}, true],
    ['mixed values and operators OR together', { detail: { plan: ['free', { prefix: 'pr' }] } }, true],
    // Defensive behavior on shapes validatePattern would have rejected:
    ['non-object pattern never matches', 'app.users', false],
    ['bare primitive pattern value never matches', { source: 'app.users' }, false],
    ['multi-key operator object never matches', { source: [{ prefix: 'app.', exists: true }] }, false],
    ['unsupported operator never silently matches', { source: [{ 'anything-but': 'x' }] }, false],
  ];

  test.each(table)('%s', (_name, pattern, expected) => {
    expect(matches(pattern, event)).toBe(expected);
  });
});

describe('validatePattern', () => {
  test('returns an empty array for a fully supported pattern', () => {
    expect(validatePattern({
      source: ['app.users'],
      'detail-type': [{ prefix: 'User' }],
      detail: { plan: ['pro', 'free'], seats: [5], missing: [{ exists: false }], active: [true], gone: [null] },
    })).toEqual([]);
  });

  test.each([
    ['anything-but', { detail: { plan: [{ 'anything-but': 'free' }] } }],
    ['numeric', { detail: { seats: [{ numeric: ['>', 0] }] } }],
    ['suffix', { source: [{ suffix: '.users' }] }],
    ['cidr', { detail: { ip: [{ cidr: '10.0.0.0/24' }] } }],
    ['equals-ignore-case', { source: [{ 'equals-ignore-case': 'APP.USERS' }] }],
    ['wildcard', { source: [{ wildcard: 'app.*' }] }],
  ])('reports unsupported operator %s', (operator, pattern) => {
    expect(validatePattern(pattern)).toEqual([operator]);
  });

  test('reports unknown operators and deduplicates', () => {
    const pattern = {
      a: [{ suffix: 'x' }],
      b: [{ suffix: 'y' }, { 'made-up-op': 1 }],
    };
    expect(validatePattern(pattern).sort()).toEqual(['made-up-op', 'suffix']);
  });

  test.each([
    ['non-object root', 'source'],
    ['null root', null],
    ['array root', [{ source: ['x'] }]],
    ['empty root object', {}],
    ['empty nested object', { detail: {} }],
    ['empty match value list', { source: [] }],
    ['bare primitive leaf', { source: 'app.users' }],
    ['nested array in match list', { source: [['app.users']] }],
    ['multi-key operator object', { source: [{ prefix: 'a', exists: true }] }],
    ['prefix with non-string argument', { source: [{ prefix: 5 }] }],
    ['exists with non-boolean argument', { source: [{ exists: 'yes' }] }],
  ])('throws on invalid structure: %s', (_name, pattern) => {
    expect(() => validatePattern(pattern)).toThrow(Error);
  });
});
