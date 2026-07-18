// Pure unit coverage for the ESM FilterCriteria compiler, control-plane
// validator and the per-source filter views.

import {
  buildSqsFilterView,
  buildStreamFilterView,
  compileFilterCriteria,
  validateFilterCriteria,
} from '../../../../src/server/engine/dispatch/filter-criteria.js';
import type { DeliveredMessage } from '../../../../src/server/engine/emulators/sqs/index.js';

function crit(...patterns: unknown[]): unknown {
  return { Filters: patterns.map(p => ({ Pattern: JSON.stringify(p) })) };
}

describe('compileFilterCriteria', () => {
  test('undefined / missing Filters / empty Filters delivers everything', () => {
    for (const c of [undefined, {}, { Filters: [] }]) {
      const predicate = compileFilterCriteria(c);
      expect(predicate({ anything: 'goes' })).toBe(true);
    }
  });

  test('a stream record is matched against typed leaves and eventName', () => {
    const predicate = compileFilterCriteria(crit({ eventName: ['INSERT'] }));
    expect(predicate({ eventName: 'INSERT' })).toBe(true);
    expect(predicate({ eventName: 'MODIFY' })).toBe(false);
  });

  test('multiple filters are OR-d; sibling keys within one pattern are AND-d', () => {
    const predicate = compileFilterCriteria(crit({ eventName: ['INSERT'] }, { eventName: ['REMOVE'] }));
    expect(predicate({ eventName: 'INSERT' })).toBe(true);
    expect(predicate({ eventName: 'REMOVE' })).toBe(true);
    expect(predicate({ eventName: 'MODIFY' })).toBe(false);

    const anded = compileFilterCriteria(crit({ eventName: ['INSERT'], region: ['us-east-1'] }));
    expect(anded({ eventName: 'INSERT', region: 'us-east-1' })).toBe(true);
    expect(anded({ eventName: 'INSERT', region: 'eu-west-1' })).toBe(false);
  });
});

describe('validateFilterCriteria', () => {
  test('accepts undefined, empty and valid criteria', () => {
    expect(() => validateFilterCriteria(undefined)).not.toThrow();
    expect(() => validateFilterCriteria({ Filters: [] })).not.toThrow();
    expect(() => validateFilterCriteria(crit({ body: { status: ['done'] } }))).not.toThrow();
  });

  test.each([
    ['non-object criteria', 'nope'],
    ['non-array Filters', { Filters: {} }],
    ['non-string Pattern', { Filters: [{ Pattern: 5 }] }],
    ['invalid JSON Pattern', { Filters: [{ Pattern: '{oops' }] }],
    ['non-object pattern', { Filters: [{ Pattern: '["x"]' }] }],
    ['unsupported operator', crit({ source: [{ suffix: 'x' }] })],
    ['too many filters', { Filters: Array.from({ length: 6 }, () => ({ Pattern: '{"a":[1]}' })) }],
  ])('rejects %s', (_name, criteria) => {
    expect(() => validateFilterCriteria(criteria)).toThrow(Error);
  });
});

describe('buildSqsFilterView / buildStreamFilterView', () => {
  function message(overrides: Partial<DeliveredMessage>): DeliveredMessage {
    return {
      messageId: 'm-1',
      receiptHandle: 'rh-1',
      body: '',
      attributes: {},
      messageAttributes: {},
      md5OfBody: 'x',
      sentTimestamp: 1,
      approximateReceiveCount: 1,
      ...overrides,
    };
  }

  test('BODY-AS-JSON: a JSON-object body is parsed; a non-JSON body stays a string', () => {
    const jsonView = buildSqsFilterView(message({ body: '{"status":"completed"}' }));
    expect(jsonView.body).toEqual({ status: 'completed' });

    const rawView = buildSqsFilterView(message({ body: 'PING' }));
    expect(rawView.body).toBe('PING');

    // A bare JSON number is a primitive, so the raw string is used (filterable
    // by exact/prefix on the string).
    const numView = buildSqsFilterView(message({ body: '1234' }));
    expect(numView.body).toBe('1234');
  });

  test('a body-content filter matches only when the body parses to an object', () => {
    const predicate = compileFilterCriteria(crit({ body: { status: ['completed'] } }));
    expect(predicate(buildSqsFilterView(message({ body: '{"status":"completed"}' })))).toBe(true);
    expect(predicate(buildSqsFilterView(message({ body: '{"status":"pending"}' })))).toBe(false);
    expect(predicate(buildSqsFilterView(message({ body: 'PING' })))).toBe(false);

    const rawPredicate = compileFilterCriteria(crit({ body: ['1234'] }));
    expect(rawPredicate(buildSqsFilterView(message({ body: '1234' })))).toBe(true);
  });

  test('stream filter view is the identity (raw wire record)', () => {
    const wire = { eventName: 'INSERT', dynamodb: { Keys: { id: { S: 'a' } } } };
    expect(buildStreamFilterView(wire)).toBe(wire);
  });
});
