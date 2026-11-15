// SearchVectors — ranking and scores (the Developer Guide's worked example as
// the golden table, all three distance functions), top-K bound and the
// deterministic tie-break, HASH partition scoping, inline filters, the
// SearchConditionExpression grammar, projection rules, request errors, and
// the incrementality of the derived cache across every write path
// (put → update → delete → TTL → batch → transaction).
import {
  catalogTable, expectAwsError, flatTable, item, makeHarness, query, vec,
} from './vector-helpers';
import type { Harness } from './vector-helpers';
import { vectorScore } from '../../../../src/server/engine/emulators/dynamodb/vector';

describe('DynamoDB SearchVectors', () => {
  let h: Harness;
  let call: Harness['call'];

  beforeEach(() => {
    h = makeHarness();
    call = h.call;
  });

  afterEach(() => h.cleanup());

  const search = (input: Record<string, unknown>) => call('SearchVectors', { TableName: 'catalog', IndexName: 'EmbeddingIndex', TopK: 10, ...input });
  const ids = (res: any): string[] => res.SearchResults.map((r: any) => r.Item.productId?.S ?? r.Item.id?.S);
  const inMice = { SearchConditionExpression: 'category = :c', ExpressionAttributeValues: { ':c': { S: 'mice' } } };

  describe('scores — the guide\'s worked example (query [1,0,0,0])', () => {
    const golden: Array<[string, Record<string, number>]> = [
      ['COSINE', { far: 0.0, diagonal: 0.29, opposite: 2.0 }],
      ['EUCLIDEAN', { far: 9.0, diagonal: 0.77, opposite: 2.0 }],
      ['DOT_PRODUCT', { far: 10.0, diagonal: 0.71, opposite: -1.0 }],
    ];

    it.each(golden)('%s', async (distance, expected) => {
      await call('CreateTable', flatTable('golden', distance));
      await call('PutItem', { TableName: 'golden', Item: { id: { S: 'far' }, v: vec(10, 0, 0, 0) } });
      await call('PutItem', { TableName: 'golden', Item: { id: { S: 'diagonal' }, v: vec(0.7071, 0.7071, 0, 0) } });
      await call('PutItem', { TableName: 'golden', Item: { id: { S: 'opposite' }, v: vec(-1, 0, 0, 0) } });
      const res = await call('SearchVectors', { TableName: 'golden', IndexName: 'flat', SearchVector: query(1, 0, 0, 0), TopK: 3 });
      for (const result of res.SearchResults) {
        expect(result.Score).toBeCloseTo(expected[result.Item.id.S], 2);
      }
      // Most similar first: ascending distances, descending dot product.
      const scores = res.SearchResults.map((r: any) => r.Score);
      const sorted = [...scores].sort((a, b) => (distance === 'DOT_PRODUCT' ? b - a : a - b));
      expect(scores).toEqual(sorted);
      expect(res.SearchResults[0].Item.id.S).toBe(distance === 'EUCLIDEAN' ? 'diagonal' : 'far');
    });

    it('scores a zero-norm vector as orthogonal (1) under COSINE instead of NaN', () => {
      const zero = new Float32Array([0, 0]);
      const unit = new Float32Array([1, 0]);
      expect(vectorScore('COSINE', unit, 1, zero, 0)).toBe(1);
      expect(vectorScore('COSINE', zero, 0, unit, 1)).toBe(1);
    });
  });

  describe('ranking', () => {
    beforeEach(async () => {
      await call('CreateTable', catalogTable());
      const rows: Array<[string, string, string | undefined, number[]]> = [
        ['m1', 'mice', 'acme', [1, 0, 0, 0]],
        ['m2', 'mice', 'globex', [0.9, 0.1, 0, 0]],
        ['m3', 'mice', 'acme', [0, 1, 0, 0]],
        ['m4', 'mice', undefined, [0.5, 0.5, 0, 0]],
        ['k1', 'keyboards', 'acme', [1, 0, 0, 0]],
      ];
      for (const [id, category, brand, v] of rows) {
        await call('PutItem', {
          TableName: 'catalog',
          Item: item(id, { category: { S: category }, ...(brand ? { brand: { S: brand } } : {}), embedding: vec(...v), price: { N: '10' } }),
        });
      }
    });

    it('scopes to the HASH partition and ranks most similar first', async () => {
      const res = await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      expect(ids(res)).toEqual(['m1', 'm2', 'm4', 'm3']);
      expect(res.SearchResults[0].Score).toBe(0);
    });

    it('bounds the result list to TopK', async () => {
      expect(ids(await search({ SearchVector: query(1, 0, 0, 0), TopK: 2, ...inMice }))).toEqual(['m1', 'm2']);
    });

    it('breaks score ties deterministically on the item key', async () => {
      await call('PutItem', { TableName: 'catalog', Item: item('m0', { category: { S: 'mice' }, embedding: vec(2, 0, 0, 0) }) });
      // m0 and m1 point the same way: cosine distance 0 for both.
      expect(ids(await search({ SearchVector: query(1, 0, 0, 0), TopK: 2, ...inMice }))).toEqual(['m0', 'm1']);
      expect(ids(await search({ SearchVector: query(1, 0, 0, 0), TopK: 1, ...inMice }))).toEqual(['m0']);
    });

    it('applies inline filters on top of the partition (items missing the filter never match)', async () => {
      const res = await search({
        SearchVector: query(1, 0, 0, 0),
        SearchConditionExpression: 'category = :c AND brand = :b',
        ExpressionAttributeValues: { ':c': { S: 'mice' }, ':b': { S: 'acme' } },
      });
      expect(ids(res)).toEqual(['m1', 'm3']);
    });

    it('accepts names, parentheses and either term order', async () => {
      const res = await search({
        SearchVector: query(1, 0, 0, 0),
        SearchConditionExpression: '(#b = :b) AND (#c = :c)',
        ExpressionAttributeNames: { '#b': 'brand', '#c': 'category' },
        ExpressionAttributeValues: { ':c': { S: 'mice' }, ':b': { S: 'globex' } },
      });
      expect(ids(res)).toEqual(['m2']);
    });

    it('answers an empty list for an unknown partition value', async () => {
      const res = await search({ SearchVector: query(1, 0, 0, 0), ...inMice, ExpressionAttributeValues: { ':c': { S: 'monitors' } } });
      expect(res.SearchResults).toEqual([]);
    });

    it('excludes the vector attribute by default and returns it only when projected', async () => {
      const plain = await search({ SearchVector: query(1, 0, 0, 0), TopK: 1, ...inMice });
      expect(plain.SearchResults[0].Item).toEqual({ productId: { S: 'm1' }, category: { S: 'mice' }, brand: { S: 'acme' }, price: { N: '10' } });
      const withVector = await search({ SearchVector: query(1, 0, 0, 0), TopK: 1, ...inMice, ProjectionExpression: 'productId, embedding' });
      expect(withVector.SearchResults[0].Item).toEqual({ productId: { S: 'm1' }, embedding: vec(1, 0, 0, 0) });
    });

    it('reports ConsumedCapacity.VectorSearchRequestBytes when asked', async () => {
      const res = await search({ SearchVector: query(1, 0, 0, 0), ...inMice, ReturnConsumedCapacity: 'TOTAL' });
      expect(res.ConsumedCapacity).toEqual({ VectorSearchRequestBytes: 16 });
      expect((await search({ SearchVector: query(1, 0, 0, 0), ...inMice, ReturnConsumedCapacity: 'INDEXES' })).ConsumedCapacity).toBeDefined();
      expect((await search({ SearchVector: query(1, 0, 0, 0), ...inMice })).ConsumedCapacity).toBeUndefined();
    });
  });

  describe('SearchConditionExpression rules', () => {
    beforeEach(async () => {
      await call('CreateTable', catalogTable());
    });
    const v = query(1, 0, 0, 0);

    it('requires the HASH attribute when the index defines one', async () => {
      await expectAwsError(search({ SearchVector: v }), 'ValidationException',
        /partition attribute category of vector index EmbeddingIndex is required/);
      await expectAwsError(search({
        SearchVector: v, SearchConditionExpression: 'brand = :b', ExpressionAttributeValues: { ':b': { S: 'acme' } },
      }), 'ValidationException', /partition attribute category/);
    });

    it('only allows SearchSchema attributes', async () => {
      await expectAwsError(search({
        SearchVector: v, SearchConditionExpression: 'category = :c AND price = :p',
        ExpressionAttributeValues: { ':c': { S: 'mice' }, ':p': { N: '1' } },
      }), 'ValidationException', /The attribute price is not part of the SearchSchema/);
    });

    it('only allows = joined by AND', async () => {
      const values = { ':c': { S: 'mice' }, ':b': { S: 'acme' } };
      await expectAwsError(search({ SearchVector: v, SearchConditionExpression: 'category = :c OR brand = :b', ExpressionAttributeValues: values }),
        'ValidationException', 'Invalid operator used in SearchConditionExpression: OR');
      await expectAwsError(search({ SearchVector: v, SearchConditionExpression: 'category = :c AND brand <> :b', ExpressionAttributeValues: values }),
        'ValidationException', 'Invalid operator used in SearchConditionExpression: <>');
      await expectAwsError(search({ SearchVector: v, SearchConditionExpression: 'category = :c AND brand > :b', ExpressionAttributeValues: values }),
        'ValidationException', 'Invalid operator used in SearchConditionExpression: >');
      await expectAwsError(search({ SearchVector: v, SearchConditionExpression: 'category = :c AND begins_with(brand, :b)', ExpressionAttributeValues: values }),
        'ValidationException', 'Invalid operator used in SearchConditionExpression: begins_with');
      await expectAwsError(search({ SearchVector: v, SearchConditionExpression: 'NOT category = :c', ExpressionAttributeValues: { ':c': values[':c'] } }),
        'ValidationException', 'Invalid operator used in SearchConditionExpression: NOT');
    });

    it('rejects a repeated attribute and a value of the wrong type', async () => {
      await expectAwsError(search({
        SearchVector: v, SearchConditionExpression: 'category = :c AND category = :d',
        ExpressionAttributeValues: { ':c': { S: 'mice' }, ':d': { S: 'pads' } },
      }), 'ValidationException', /The attribute category appears more than once/);
      await expectAwsError(search({ SearchVector: v, ...inMice, ExpressionAttributeValues: { ':c': { N: '1' } } }),
        'ValidationException', /Condition parameter type does not match schema type/);
    });

    it('rejects unused placeholders exactly like Query', async () => {
      await expectAwsError(search({ SearchVector: v, ...inMice, ExpressionAttributeNames: { '#x': 'x' } }),
        'ValidationException', 'Value provided in ExpressionAttributeNames unused in expressions: keys: {#x}');
    });
  });

  it('compares N partition values numerically and B filters by bytes', async () => {
    await call('CreateTable', {
      TableName: 'typed', BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'tenant', AttributeType: 'N' },
        { AttributeName: 'tag', AttributeType: 'B' },
      ],
      VectorIndexes: [{
        IndexName: 'byTenant', VectorAttribute: { AttributeName: 'v' }, Dimensions: 2, DistanceFunction: 'EUCLIDEAN',
        SearchSchema: [
          { AttributeName: 'tenant', SearchSchemaElementType: 'HASH' },
          { AttributeName: 'tag', SearchSchemaElementType: 'INLINE_FILTER' },
        ],
      }],
    });
    await call('PutItem', { TableName: 'typed', Item: { id: { S: 'a' }, tenant: { N: '1.0' }, tag: { B: 'AQI=' }, v: vec(0, 0) } });
    // A wrongly typed inline filter is stored as absent: indexed, never matched.
    await call('PutItem', { TableName: 'typed', Item: { id: { S: 'b' }, tenant: { N: '1' }, tag: { S: 'AQI=' }, v: vec(1, 1) } });
    const res = await call('SearchVectors', {
      TableName: 'typed', IndexName: 'byTenant', SearchVector: query(0, 0), TopK: 5,
      SearchConditionExpression: 'tenant = :t AND tag = :g',
      ExpressionAttributeValues: { ':t': { N: '01' }, ':g': { B: 'AQI' } },
    });
    expect(ids(res)).toEqual(['a']);
    const all = await call('SearchVectors', {
      TableName: 'typed', IndexName: 'byTenant', SearchVector: query(0, 0), TopK: 5,
      SearchConditionExpression: 'tenant = :t', ExpressionAttributeValues: { ':t': { N: '1' } },
    });
    expect(ids(all)).toEqual(['a', 'b']);
    expect(all.SearchResults[1].Score).toBeCloseTo(Math.SQRT2, 5);
  });

  describe('projection of KEYS_ONLY / INCLUDE indexes', () => {
    it('returns keys + SearchSchema attributes only, and refuses unprojected attributes', async () => {
      await call('CreateTable', catalogTable({}, { Projection: { ProjectionType: 'KEYS_ONLY' } }));
      await call('PutItem', { TableName: 'catalog', Item: item('m1', { category: { S: 'mice' }, brand: { S: 'acme' }, embedding: vec(1, 0, 0, 0), price: { N: '9' } }) });
      const res = await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      expect(res.SearchResults[0].Item).toEqual({ productId: { S: 'm1' }, category: { S: 'mice' }, brand: { S: 'acme' } });
      await expectAwsError(search({ SearchVector: query(1, 0, 0, 0), ...inMice, ProjectionExpression: 'productId, price' }),
        'ValidationException', /ProjectionExpression references price, which is not projected into vector index EmbeddingIndex/);
      const withVector = await search({ SearchVector: query(1, 0, 0, 0), ...inMice, ProjectionExpression: 'embedding' });
      expect(withVector.SearchResults[0].Item).toEqual({ embedding: vec(1, 0, 0, 0) });
    });

    it('adds the NonKeyAttributes of an INCLUDE projection', async () => {
      await call('CreateTable', catalogTable({}, { Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['price'] } }));
      await call('PutItem', { TableName: 'catalog', Item: item('m1', { category: { S: 'mice' }, embedding: vec(1, 0, 0, 0), price: { N: '9' }, name: { S: 'x' } }) });
      const res = await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      expect(res.SearchResults[0].Item).toEqual({ productId: { S: 'm1' }, category: { S: 'mice' }, price: { N: '9' } });
    });
  });

  describe('request errors', () => {
    beforeEach(async () => {
      await call('CreateTable', catalogTable({
        GlobalSecondaryIndexes: [{ IndexName: 'byCategory', KeySchema: [{ AttributeName: 'category', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } }],
      }));
    });

    it('answers ResourceNotFoundException for an unknown table', async () => {
      await expectAwsError(call('SearchVectors', { TableName: 'ghost', IndexName: 'x', SearchVector: query(1), TopK: 1 }),
        'ResourceNotFoundException', 'Requested resource not found');
    });

    it('refuses an index that is not a vector index', async () => {
      await expectAwsError(search({ IndexName: 'byCategory', SearchVector: query(1, 0, 0, 0) }), 'ValidationException',
        'The table does not have the specified index: byCategory');
      await expectAwsError(search({ IndexName: 'nope', SearchVector: query(1, 0, 0, 0) }), 'ValidationException',
        'The table does not have the specified index: nope');
    });

    it('validates SearchVector', async () => {
      await expectAwsError(search({ SearchVector: query(1, 0) }), 'ValidationException',
        /SearchVector has 2 dimensions, but vector index EmbeddingIndex expects 4/);
      await expectAwsError(search({ SearchVector: [] }), 'ValidationException', /SearchVector must be a non-empty list/);
      await expectAwsError(search({ SearchVector: undefined }), 'ValidationException', /SearchVector must be a non-empty list/);
      await expectAwsError(search({ SearchVector: [{ S: '1' }, { N: '0' }, { N: '0' }, { N: '0' }] }), 'ValidationException', /list of numbers/);
      await expectAwsError(search({ SearchVector: query(1e39, 0, 0, 0) }), 'ValidationException', /list of numbers/);
    });

    it.each([0, 101, 1.5, '5', undefined])('validates TopK = %p', async (topK) => {
      await expectAwsError(search({ SearchVector: query(1, 0, 0, 0), ...inMice, TopK: topK }), 'ValidationException',
        /TopK must be an integer between 1 and 100/);
    });

    it('accepts the TopK bound 100', async () => {
      expect((await search({ SearchVector: query(1, 0, 0, 0), ...inMice, TopK: 100 })).SearchResults).toEqual([]);
    });

    it('refuses Query and Scan against a vector index', async () => {
      await expectAwsError(call('Scan', { TableName: 'catalog', IndexName: 'EmbeddingIndex' }), 'ValidationException',
        /EmbeddingIndex is a vector index: it can only be read with SearchVectors/);
      await expectAwsError(call('Query', {
        TableName: 'catalog', IndexName: 'EmbeddingIndex', KeyConditionExpression: 'category = :c',
        ExpressionAttributeValues: { ':c': { S: 'mice' } },
      }), 'ValidationException', /vector index/);
      // A GSI is still queryable on the same table.
      expect((await call('Scan', { TableName: 'catalog', IndexName: 'byCategory' })).Count).toBe(0);
    });
  });

  describe('cache incrementality', () => {
    const cache = () => (h.emulator as any).vectors;

    beforeEach(async () => {
      await call('CreateTable', catalogTable());
      await call('PutItem', { TableName: 'catalog', Item: item('m1', { category: { S: 'mice' }, embedding: vec(1, 0, 0, 0) }) });
    });

    it('builds lazily on the first search', async () => {
      expect(cache().isBuilt('us-east-1', 'catalog', 'EmbeddingIndex')).toBe(false);
      await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      expect(cache().isBuilt('us-east-1', 'catalog', 'EmbeddingIndex')).toBe(true);
    });

    it('follows put → update → delete after the cache is built', async () => {
      await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      await call('PutItem', { TableName: 'catalog', Item: item('m2', { category: { S: 'mice' }, embedding: vec(0, 1, 0, 0) }) });
      expect(ids(await search({ SearchVector: query(0, 1, 0, 0), ...inMice }))).toEqual(['m2', 'm1']);

      await call('UpdateItem', {
        TableName: 'catalog', Key: { productId: { S: 'm1' } },
        UpdateExpression: 'SET embedding = :v', ExpressionAttributeValues: { ':v': vec(0, 2, 0, 0) },
      });
      expect(ids(await search({ SearchVector: query(0, 1, 0, 0), TopK: 2, ...inMice }))).toEqual(['m1', 'm2']);

      // Moving an item to another partition moves its entry.
      await call('UpdateItem', {
        TableName: 'catalog', Key: { productId: { S: 'm1' } },
        UpdateExpression: 'SET category = :k', ExpressionAttributeValues: { ':k': { S: 'keyboards' } },
      });
      expect(ids(await search({ SearchVector: query(0, 1, 0, 0), ...inMice }))).toEqual(['m2']);

      await call('DeleteItem', { TableName: 'catalog', Key: { productId: { S: 'm2' } } });
      expect(ids(await search({ SearchVector: query(0, 1, 0, 0), ...inMice }))).toEqual([]);

      // Dropping the HASH un-indexes the item.
      await call('UpdateItem', { TableName: 'catalog', Key: { productId: { S: 'm1' } }, UpdateExpression: 'REMOVE category' });
      expect((await call('DescribeTable', { TableName: 'catalog' })).Table.VectorIndexes[0].ItemCount).toBe(0);
    });

    it('follows batch and transaction writes', async () => {
      await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      await call('BatchWriteItem', {
        RequestItems: {
          catalog: [
            { PutRequest: { Item: item('b1', { category: { S: 'mice' }, embedding: vec(0, 0, 1, 0) }) } },
            { DeleteRequest: { Key: { productId: { S: 'm1' } } } },
          ],
        },
      });
      expect(ids(await search({ SearchVector: query(0, 0, 1, 0), ...inMice }))).toEqual(['b1']);
      await call('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: 'catalog', Item: item('t1', { category: { S: 'mice' }, embedding: vec(0, 0, 0, 1) }) } },
          { Delete: { TableName: 'catalog', Key: { productId: { S: 'b1' } } } },
        ],
      });
      expect(ids(await search({ SearchVector: query(0, 0, 0, 1), ...inMice }))).toEqual(['t1']);
    });

    it('skips and purges TTL-expired items, and re-reads expiry when TTL settings change', async () => {
      const past = String(Math.floor(Date.now() / 1000) - 60);
      await call('PutItem', { TableName: 'catalog', Item: item('old', { category: { S: 'mice' }, embedding: vec(1, 0, 0, 0), expiresAt: { N: past } }) });
      // Built before TTL is on: the expiry is not tracked yet…
      expect(ids(await search({ SearchVector: query(1, 0, 0, 0), ...inMice }))).toEqual(['m1', 'old']);
      // …enabling TTL drops the cache, so the rebuild sees the expiry.
      await call('UpdateTimeToLive', { TableName: 'catalog', TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } });
      expect(cache().isBuilt('us-east-1', 'catalog', 'EmbeddingIndex')).toBe(false);
      expect(ids(await search({ SearchVector: query(1, 0, 0, 0), ...inMice }))).toEqual(['m1']);
      // Purged from the base table too, as any read of an expired item does.
      expect((await call('Scan', { TableName: 'catalog' })).Count).toBe(1);
      expect(ids(await search({ SearchVector: query(1, 0, 0, 0), ...inMice }))).toEqual(['m1']);
    });

    it('never leaks a dropped table into a recreated one', async () => {
      await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      await call('DeleteTable', { TableName: 'catalog' });
      expect(cache().isBuilt('us-east-1', 'catalog', 'EmbeddingIndex')).toBe(false);
      await call('CreateTable', catalogTable());
      expect((await search({ SearchVector: query(1, 0, 0, 0), ...inMice })).SearchResults).toEqual([]);
    });

    it('rebuilds when the cached state belongs to an older incarnation of the table', async () => {
      await search({ SearchVector: query(1, 0, 0, 0), ...inMice });
      // Simulate a stale state (another tableId) without going through DeleteTable.
      const states: Map<string, { tableId: string }> = cache().states;
      for (const state of states.values()) state.tableId = 'stale';
      expect(ids(await search({ SearchVector: query(1, 0, 0, 0), ...inMice }))).toEqual(['m1']);
      for (const state of states.values()) expect(state.tableId).not.toBe('stale');
    });

    it('ignores writes to tables without vector indexes', async () => {
      await call('CreateTable', {
        TableName: 'plain', BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      });
      const spy = jest.spyOn(cache(), 'applyChange');
      await call('PutItem', { TableName: 'plain', Item: { id: { S: 'a' }, embedding: vec(1) } });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
