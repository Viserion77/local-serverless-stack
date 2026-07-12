// The query-DSL subset as pure functions: operator semantics, field
// resolution over nested docs and arrays, sort/missing ordering, _source
// filtering shapes and aggregation math. Wire plumbing lives in
// data-plane.test.ts.
import {
  computeAggregations,
  filterSource,
  matchesQuery,
  normalizeSort,
  resolveField,
  sortHits,
  type SearchHitDoc,
} from '../../../../src/server/engine/emulators/opensearch/search';

const doc = (id: string, source: Record<string, unknown>): SearchHitDoc => ({ index: 'items', id, source });

const MOUSE = doc('1', {
  name: 'Wireless Mouse',
  price: 25,
  stock: 0,
  category: 'peripherals',
  tags: ['usb', 'wireless'],
  specs: { dpi: 1600, battery: { type: 'AA' } },
  releasedAt: '2026-01-15',
});
const KEYBOARD = doc('2', {
  name: 'Mechanical Keyboard',
  price: 90,
  category: 'peripherals',
  tags: ['usb'],
  releasedAt: '2026-06-30',
});
const HUB = doc('3', { name: 'usb hub', price: 15, category: 'accessories', discontinued: null });

describe('resolveField', () => {
  test('walks dot paths and flattens arrays at every hop', () => {
    expect(resolveField(MOUSE.source, 'specs.dpi')).toEqual([1600]);
    expect(resolveField(MOUSE.source, 'specs.battery.type')).toEqual(['AA']);
    expect(resolveField(MOUSE.source, 'tags')).toEqual(['usb', 'wireless']);
    expect(resolveField(MOUSE.source, 'missing.path')).toEqual([]);
    expect(resolveField({ list: [{ v: 1 }, { v: 2 }] }, 'list.v')).toEqual([1, 2]);
  });
});

describe('matchesQuery operators', () => {
  test('match tokenizes case-insensitively with OR default and AND operator', () => {
    expect(matchesQuery({ match: { name: 'MOUSE' } }, MOUSE)).toBe(true);
    expect(matchesQuery({ match: { name: 'mouse trackball' } }, MOUSE)).toBe(true);
    expect(matchesQuery({ match: { name: { query: 'mouse trackball', operator: 'and' } } }, MOUSE)).toBe(false);
    expect(matchesQuery({ match: { name: { query: 'wireless mouse', operator: 'AND' } } }, MOUSE)).toBe(true);
    expect(matchesQuery({ match: { name: '' } }, MOUSE)).toBe(false);
    expect(matchesQuery({ match: { price: '25' } }, MOUSE)).toBe(true); // non-string fields stringify
  });

  test('match_phrase requires the contiguous token sequence', () => {
    expect(matchesQuery({ match_phrase: { name: 'wireless mouse' } }, MOUSE)).toBe(true);
    expect(matchesQuery({ match_phrase: { name: 'mouse wireless' } }, MOUSE)).toBe(false);
  });

  test('multi_match ORs the fields and validates its shape', () => {
    expect(matchesQuery({ multi_match: { query: 'peripherals', fields: ['name', 'category'] } }, MOUSE)).toBe(true);
    expect(matchesQuery({ multi_match: { query: 'nothing', fields: ['name'] } }, MOUSE)).toBe(false);
    expect(() => matchesQuery({ multi_match: { query: 'x' } }, MOUSE)).toThrow(/fields/);
    expect(() => matchesQuery({ multi_match: null }, MOUSE)).toThrow(/multi_match/);
  });

  test('term/terms compare raw values, numbers loosely, arrays as any-of', () => {
    expect(matchesQuery({ term: { category: 'peripherals' } }, MOUSE)).toBe(true);
    expect(matchesQuery({ term: { category: 'Peripherals' } }, MOUSE)).toBe(false); // keyword semantics
    expect(matchesQuery({ term: { price: { value: 25 } } }, MOUSE)).toBe(true);
    expect(matchesQuery({ term: { price: '25' } }, MOUSE)).toBe(true);
    expect(matchesQuery({ term: { tags: 'wireless' } }, MOUSE)).toBe(true);
    expect(matchesQuery({ terms: { category: ['accessories', 'peripherals'] } }, MOUSE)).toBe(true);
    expect(matchesQuery({ terms: { category: ['accessories'] } }, MOUSE)).toBe(false);
    expect(() => matchesQuery({ terms: { category: 'not-array' } }, MOUSE)).toThrow(/array/);
  });

  test('range compares numerically when possible, lexicographically otherwise (ISO dates work)', () => {
    expect(matchesQuery({ range: { price: { gte: 20, lt: 30 } } }, MOUSE)).toBe(true);
    expect(matchesQuery({ range: { price: { gt: 25 } } }, MOUSE)).toBe(false);
    expect(matchesQuery({ range: { price: { lte: 25 } } }, MOUSE)).toBe(true);
    expect(matchesQuery({ range: { price: { lt: 25 } } }, MOUSE)).toBe(false);
    expect(matchesQuery({ range: { releasedAt: { gte: '2026-01-01', lte: '2026-03-31' } } }, MOUSE)).toBe(true);
    expect(matchesQuery({ range: { releasedAt: { gt: '2026-02-01' } } }, MOUSE)).toBe(false);
    expect(matchesQuery({ range: { discontinued: { gte: 1 } } }, HUB)).toBe(false); // null never matches
    expect(() => matchesQuery({ range: { price: { between: [1, 2] } } }, MOUSE)).toThrow(/between/);
    expect(() => matchesQuery({ range: { price: 5 } }, MOUSE)).toThrow(/bounds/);
  });

  test('prefix and wildcard match strings', () => {
    expect(matchesQuery({ prefix: { name: 'wire' } }, MOUSE)).toBe(true); // case-insensitive dev bar
    expect(matchesQuery({ prefix: { name: { value: 'Wireless' } } }, MOUSE)).toBe(true);
    expect(matchesQuery({ prefix: { price: '2' } }, MOUSE)).toBe(false); // non-strings never prefix-match
    expect(matchesQuery({ wildcard: { name: 'wire*mo?se' } }, MOUSE)).toBe(true);
    expect(matchesQuery({ wildcard: { name: { value: '*keyboard' } } }, KEYBOARD)).toBe(true);
    expect(matchesQuery({ wildcard: { name: 'usb' } }, MOUSE)).toBe(false);
  });

  test('exists checks presence (null is absent); ids matches _id', () => {
    expect(matchesQuery({ exists: { field: 'stock' } }, MOUSE)).toBe(true); // 0 exists
    expect(matchesQuery({ exists: { field: 'discontinued' } }, HUB)).toBe(false); // null
    expect(matchesQuery({ exists: { field: 'nope' } }, MOUSE)).toBe(false);
    expect(() => matchesQuery({ exists: {} }, MOUSE)).toThrow(/field/);
    expect(() => matchesQuery({ exists: null }, MOUSE)).toThrow(/exists/);
    expect(matchesQuery({ ids: { values: ['1', '9'] } }, MOUSE)).toBe(true);
    expect(matchesQuery({ ids: { values: [2] } }, KEYBOARD)).toBe(true); // numbers stringify
    expect(() => matchesQuery({ ids: {} }, MOUSE)).toThrow(/values/);
    expect(() => matchesQuery({ ids: [] }, MOUSE)).toThrow(/ids/);
  });

  test('bool composes must/filter/must_not/should with OpenSearch minimum_should_match defaults', () => {
    expect(matchesQuery({
      bool: {
        must: { match: { name: 'mouse' } },
        filter: [{ term: { category: 'peripherals' } }],
        must_not: [{ range: { price: { gt: 50 } } }],
      },
    }, MOUSE)).toBe(true);
    expect(matchesQuery({ bool: { must: [{ match: { name: 'mouse' } }, { match: { name: 'hub' } }] } }, MOUSE)).toBe(false);
    expect(matchesQuery({ bool: { filter: [{ term: { category: 'accessories' } }] } }, MOUSE)).toBe(false);
    expect(matchesQuery({ bool: { must_not: { term: { category: 'peripherals' } } } }, MOUSE)).toBe(false);

    // should alone requires >= 1; alongside must it becomes optional.
    expect(matchesQuery({ bool: { should: [{ term: { category: 'accessories' } }] } }, MOUSE)).toBe(false);
    expect(matchesQuery({
      bool: { must: [{ match: { name: 'mouse' } }], should: [{ term: { category: 'accessories' } }] },
    }, MOUSE)).toBe(true);
    expect(matchesQuery({
      bool: {
        should: [{ term: { category: 'peripherals' } }, { term: { tags: 'usb' } }],
        minimum_should_match: 2,
      },
    }, MOUSE)).toBe(true);
    expect(matchesQuery({
      bool: { must: [{ match_all: {} }], should: [{ term: { tags: 'usb' } }], minimum_should_match: 1 },
    }, HUB)).toBe(false);
    expect(() => matchesQuery({ bool: { should: [{ match_all: {} }], minimum_should_match: '75%' } }, MOUSE))
      .toThrow(/percentages/);
    expect(() => matchesQuery({ bool: 'x' }, MOUSE)).toThrow(/bool/);
  });

  test('shape violations and unknown operators are loud', () => {
    expect(matchesQuery(undefined, MOUSE)).toBe(true);
    expect(matchesQuery({ match_all: {} }, MOUSE)).toBe(true);
    expect(() => matchesQuery({ fuzzy: { name: 'mouse' } }, MOUSE)).toThrow(/"fuzzy" query is not supported/);
    expect(() => matchesQuery('text', MOUSE)).toThrow(/single field/);
    expect(() => matchesQuery({ match: { a: 1, b: 2 } }, MOUSE)).toThrow(/exactly one field/);
    expect(() => matchesQuery({}, MOUSE)).toThrow(/exactly one field/);
  });
});

describe('normalizeSort + sortHits', () => {
  test('accepts strings, {field: order} and {field: {order}} forms', () => {
    expect(normalizeSort(undefined)).toEqual([]);
    expect(normalizeSort('price')).toEqual([{ field: 'price', order: 'asc' }]);
    expect(normalizeSort('_score')).toEqual([{ field: '_score', order: 'desc' }]);
    expect(normalizeSort([{ price: 'desc' }, { name: { order: 'asc' } }])).toEqual([
      { field: 'price', order: 'desc' },
      { field: 'name', order: 'asc' },
    ]);
    expect(() => normalizeSort([{ price: 'sideways' }])).toThrow(/asc/);
  });

  test('sorts numbers, strings, tiebreaks by later keys, missing last', () => {
    const docs = [KEYBOARD, HUB, MOUSE];
    expect(sortHits(docs, normalizeSort([{ price: 'asc' }])).map(d => d.id)).toEqual(['3', '1', '2']);
    expect(sortHits(docs, normalizeSort([{ price: 'desc' }])).map(d => d.id)).toEqual(['2', '1', '3']);
    expect(sortHits(docs, normalizeSort([{ category: 'asc' }, { price: 'desc' }])).map(d => d.id))
      .toEqual(['3', '2', '1']);
    // 'stock' only exists on MOUSE — the others sort last in both directions.
    expect(sortHits(docs, normalizeSort([{ stock: 'asc' }]))[0].id).toBe('1');
    expect(sortHits(docs, normalizeSort([{ stock: 'desc' }]))[0].id).toBe('1');
    // _score is constant, _id is the stable tiebreaker; no sort keeps input order.
    expect(sortHits(docs, normalizeSort(['_score', { _id: 'asc' }])).map(d => d.id)).toEqual(['1', '2', '3']);
    expect(sortHits(docs, []).map(d => d.id)).toEqual(['2', '3', '1']);
  });
});

describe('filterSource', () => {
  const source = { a: 1, b: 2, c: 3 };

  test('boolean, list, string and includes/excludes shapes', () => {
    expect(filterSource(source, undefined)).toBe(source);
    expect(filterSource(source, true)).toBe(source);
    expect(filterSource(source, false)).toBeUndefined();
    expect(filterSource(source, ['a', 'c'])).toEqual({ a: 1, c: 3 });
    expect(filterSource(source, 'b')).toEqual({ b: 2 });
    expect(filterSource(source, { includes: ['a', 'b'], excludes: ['b'] })).toEqual({ a: 1 });
    expect(filterSource(source, { includes: 'a' })).toEqual({ a: 1 });
    expect(filterSource(source, { excludes: 'b' })).toEqual({ a: 1, c: 3 });
    expect(filterSource(source, {})).toEqual(source);
    expect(() => filterSource(source, 42)).toThrow(/_source/);
  });
});

describe('computeAggregations', () => {
  const docs = [MOUSE, KEYBOARD, HUB];

  test('terms buckets sort by count then key and honor size', () => {
    const result = computeAggregations({ cats: { terms: { field: 'category' } } }, docs) as any;
    expect(result.cats.buckets).toEqual([
      { key: 'peripherals', doc_count: 2 },
      { key: 'accessories', doc_count: 1 },
    ]);
    expect(result.cats.sum_other_doc_count).toBe(0);

    const sized = computeAggregations({ cats: { terms: { field: 'category', size: 1 } } }, docs) as any;
    expect(sized.cats.buckets).toHaveLength(1);
    expect(sized.cats.sum_other_doc_count).toBe(1);

    // Multi-valued fields count every value; null/undefined are skipped.
    const tags = computeAggregations({ t: { terms: { field: 'tags' } } }, docs) as any;
    expect(tags.t.buckets).toEqual([
      { key: 'usb', doc_count: 2 },
      { key: 'wireless', doc_count: 1 },
    ]);
    const nulls = computeAggregations({ d: { terms: { field: 'discontinued' } } }, docs) as any;
    expect(nulls.d.buckets).toEqual([]);
  });

  test('metric aggregations: avg/sum/min/max/value_count and empty-set null', () => {
    const result = computeAggregations({
      avg: { avg: { field: 'price' } },
      sum: { sum: { field: 'price' } },
      min: { min: { field: 'price' } },
      max: { max: { field: 'price' } },
      count: { value_count: { field: 'price' } },
      names: { value_count: { field: 'name' } },
      empty: { avg: { field: 'nope' } },
    }, docs) as any;
    expect(result.avg.value).toBeCloseTo((25 + 90 + 15) / 3);
    expect(result.sum.value).toBe(130);
    expect(result.min.value).toBe(15);
    expect(result.max.value).toBe(90);
    expect(result.count.value).toBe(3);
    expect(result.names.value).toBe(3); // non-numeric values still count
    expect(result.empty.value).toBeNull();
  });

  test('invalid shapes, sub-aggregations and unknown types are loud', () => {
    expect(() => computeAggregations([], docs)).toThrow(/named aggregations/);
    expect(() => computeAggregations({ a: { terms: { field: 'x' }, aggs: {} } }, docs)).toThrow(/exactly one field/);
    expect(() => computeAggregations({ a: { aggs: { nested: {} } } }, docs)).toThrow(/sub-aggregations/);
    expect(() => computeAggregations({ a: { terms: 'x' } }, docs)).toThrow(/object with a "field"/);
    expect(() => computeAggregations({ a: { terms: {} } }, docs)).toThrow(/requires a "field"/);
    expect(() => computeAggregations({ a: { histogram: { field: 'price' } } }, docs)).toThrow(/"histogram" aggregation/);
  });
});
