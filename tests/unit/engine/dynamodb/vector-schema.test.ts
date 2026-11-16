// Vector indexes — control plane and writes: CreateTable / DescribeTable
// shapes, every validation rule of PRD §2.1 (AWS-shaped errors), the
// vector-index subset of UpdateTable, write validation per §2.2, and the
// restart acceptance (indexes described and searchable after a reload).
import { DynamoDbEmulator } from '../../../../src/server/engine/emulators/dynamodb';
import {
  catalogTable, expectAwsError, item, makeCtx, makeHarness, query, req, vec,
} from './vector-helpers';
import type { Harness } from './vector-helpers';

describe('DynamoDB vector indexes — schema, UpdateTable and writes', () => {
  let h: Harness;
  let call: Harness['call'];

  beforeEach(() => {
    h = makeHarness();
    call = h.call;
  });

  afterEach(() => h.cleanup());

  const describeVector = async (table = 'catalog') => (await call('DescribeTable', { TableName: table })).Table.VectorIndexes;

  describe('CreateTable / DescribeTable', () => {
    it('creates the table with its vector index and describes it AWS-shaped', async () => {
      const created = await call('CreateTable', catalogTable());
      expect(created.TableDescription.VectorIndexes).toHaveLength(1);
      const [index] = await describeVector();
      expect(index).toEqual({
        IndexName: 'EmbeddingIndex',
        VectorAttribute: { AttributeName: 'embedding' },
        Dimensions: 4,
        DistanceFunction: 'COSINE',
        Projection: { ProjectionType: 'ALL' },
        SearchSchema: [
          { AttributeName: 'category', SearchSchemaElementType: 'HASH' },
          { AttributeName: 'brand', SearchSchemaElementType: 'INLINE_FILTER' },
        ],
        IndexStatus: 'ACTIVE',
        IndexArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/catalog/index/EmbeddingIndex',
        ItemCount: 0,
        IndexSizeBytes: 0,
      });
      expect(index.Backfilling).toBeUndefined();
    });

    it('omits SearchSchema for an un-partitioned index and defaults Projection to ALL', async () => {
      await call('CreateTable', catalogTable({}, { SearchSchema: undefined, Projection: undefined }));
      const [index] = await describeVector();
      expect(index.SearchSchema).toBeUndefined();
      expect(index.Projection).toEqual({ ProjectionType: 'ALL' });
    });

    it('treats an empty VectorIndexes list as no vector index at all', async () => {
      await call('CreateTable', catalogTable({ VectorIndexes: [] }));
      expect(await describeVector()).toBeUndefined();
    });

    it('counts only indexed items and sizes the index from vector + projected bytes', async () => {
      await call('CreateTable', catalogTable({}, { Projection: { ProjectionType: 'KEYS_ONLY' } }));
      await call('PutItem', { TableName: 'catalog', Item: item('p1', { category: { S: 'mice' }, embedding: vec(1, 0, 0, 0), price: { N: '10' } }) });
      // Missing inline filter: still indexed.
      await call('PutItem', { TableName: 'catalog', Item: item('p2', { category: { S: 'mice' }, brand: { S: 'acme' }, embedding: vec(0, 1, 0, 0) }) });
      // Missing HASH: accepted, silently not indexed.
      await call('PutItem', { TableName: 'catalog', Item: item('p3', { embedding: vec(0, 0, 1, 0) }) });
      // Missing vector: not indexed.
      await call('PutItem', { TableName: 'catalog', Item: item('p4', { category: { S: 'mice' } }) });
      const [index] = await describeVector();
      expect(index.ItemCount).toBe(2);
      // 2 × 16 f32 bytes plus productId/category/brand (price is not projected under KEYS_ONLY).
      const projected = ('productId'.length + 2) + ('category'.length + 4)
        + ('productId'.length + 2) + ('category'.length + 4) + ('brand'.length + 4);
      expect(index.IndexSizeBytes).toBe(32 + projected);
    });

    it('accepts an INCLUDE projection', async () => {
      await call('CreateTable', catalogTable({}, { Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['price'] } }));
      const [index] = await describeVector();
      expect(index.Projection).toEqual({ ProjectionType: 'INCLUDE', NonKeyAttributes: ['price'] });
    });
  });

  describe('CreateTable validation (PRD §2.1)', () => {
    const invalid = (overrides: Record<string, unknown>, index: Record<string, unknown>, message: RegExp | string, code = 'ValidationException') =>
      expectAwsError(call('CreateTable', catalogTable(overrides, index)), code, message);

    it('rejects vector indexes on a PROVISIONED table — explicit or by default', async () => {
      await invalid({ BillingMode: 'PROVISIONED' }, {}, /only supported on tables with BillingMode PAY_PER_REQUEST/);
      await invalid({ BillingMode: undefined }, {}, /table catalog is PROVISIONED/);
    });

    it('rejects a sixth vector index with the AWS per-table limit message', async () => {
      const indexes = Array.from({ length: 6 }, (_, i) => ({
        IndexName: `idx${i}`, VectorAttribute: { AttributeName: `v${i}` }, Dimensions: 2, DistanceFunction: 'COSINE',
      }));
      await invalid(
        { VectorIndexes: indexes }, {},
        'One or more parameter values were invalid: VectorIndex count exceeds the per-table limit of 5',
      );
    });

    it('counts vector indexes toward the 20-GSI quota', async () => {
      const gsis = Array.from({ length: 16 }, (_, i) => ({
        IndexName: `gsi${i}`, KeySchema: [{ AttributeName: 'category', KeyType: 'HASH' }], Projection: { ProjectionType: 'KEYS_ONLY' },
      }));
      const indexes = Array.from({ length: 5 }, (_, i) => ({
        IndexName: `vec${i}`, VectorAttribute: { AttributeName: `v${i}` }, Dimensions: 2, DistanceFunction: 'COSINE',
      }));
      await invalid({ GlobalSecondaryIndexes: gsis, VectorIndexes: indexes }, {}, /vector indexes included\) exceeds the per-table limit of 20/);
    });

    it.each([0, 4097, 1.5, '8', undefined])('rejects Dimensions = %p', async (dimensions) => {
      await invalid({}, { Dimensions: dimensions }, /Dimensions must be an integer between 1 and 4096/);
    });

    it('accepts the Dimensions bounds 1 and 4096', async () => {
      await call('CreateTable', catalogTable({ TableName: 'one' }, { Dimensions: 1 }));
      await call('CreateTable', catalogTable({ TableName: 'max' }, { Dimensions: 4096 }));
      expect((await describeVector('max'))[0].Dimensions).toBe(4096);
    });

    it('rejects an unknown DistanceFunction', async () => {
      await invalid({}, { DistanceFunction: 'MANHATTAN' }, /DistanceFunction must be one of COSINE, EUCLIDEAN, DOT_PRODUCT/);
    });

    it('rejects two HASH elements', async () => {
      await invalid({}, {
        SearchSchema: [
          { AttributeName: 'category', SearchSchemaElementType: 'HASH' },
          { AttributeName: 'brand', SearchSchemaElementType: 'HASH' },
        ],
      }, /at most one HASH element/);
    });

    it('rejects a 19th INLINE_FILTER (18 is the limit)', async () => {
      const names = Array.from({ length: 19 }, (_, i) => `f${i}`);
      const defs = names.map((name) => ({ AttributeName: name, AttributeType: 'S' }));
      const schema = names.map((name) => ({ AttributeName: name, SearchSchemaElementType: 'INLINE_FILTER' }));
      await invalid(
        { AttributeDefinitions: [{ AttributeName: 'productId', AttributeType: 'S' }, ...defs] },
        { SearchSchema: schema },
        /at most 18 INLINE_FILTER elements/,
      );
      await call('CreateTable', catalogTable(
        { AttributeDefinitions: [{ AttributeName: 'productId', AttributeType: 'S' }, ...defs] },
        { SearchSchema: schema.slice(0, 18) },
      ));
    });

    it('requires every SearchSchema attribute in AttributeDefinitions, like a GSI key', async () => {
      await invalid({}, { SearchSchema: [{ AttributeName: 'color', SearchSchemaElementType: 'INLINE_FILTER' }] },
        /Some index key attributes are not defined in AttributeDefinitions. Keys: \[color\]/);
    });

    it('rejects malformed SearchSchema elements', async () => {
      await invalid({}, { SearchSchema: 'category' }, /SearchSchema must be a list/);
      await invalid({}, { SearchSchema: [{ SearchSchemaElementType: 'HASH' }] }, /SearchSchema elements require an AttributeName/);
      await invalid({}, { SearchSchema: [null] }, /SearchSchema elements require an AttributeName/);
      await invalid({}, { SearchSchema: [{ AttributeName: 'category', SearchSchemaElementType: 'RANGE' }] },
        /SearchSchemaElementType must be one of HASH, INLINE_FILTER/);
      await invalid({}, {
        SearchSchema: [
          { AttributeName: 'brand', SearchSchemaElementType: 'INLINE_FILTER' },
          { AttributeName: 'brand', SearchSchemaElementType: 'INLINE_FILTER' },
        ],
      }, /Duplicate attribute in the SearchSchema of vector index EmbeddingIndex: brand/);
      await invalid({}, { SearchSchema: [{ AttributeName: 'embedding', SearchSchemaElementType: 'INLINE_FILTER' }] },
        /Duplicate attribute in the SearchSchema/);
    });

    it('requires a VectorAttribute that is not a table key', async () => {
      await invalid({}, { VectorAttribute: undefined }, /VectorAttribute.AttributeName is required/);
      await invalid({}, { VectorAttribute: { AttributeName: '' } }, /VectorAttribute.AttributeName is required/);
      await invalid({}, { VectorAttribute: { AttributeName: 'productId' } }, /cannot be a key attribute/);
    });

    it('enforces index-name syntax and uniqueness across GSI, LSI and vector indexes', async () => {
      await invalid({}, { IndexName: 'ab' }, /Invalid table\/index name/);
      await expectAwsError(call('CreateTable', catalogTable({ VectorIndexes: [null] })), 'ValidationException', /Invalid table\/index name/);
      await invalid({
        GlobalSecondaryIndexes: [{
          IndexName: 'EmbeddingIndex', KeySchema: [{ AttributeName: 'category', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' },
        }],
      }, {}, /Duplicate index name: EmbeddingIndex/);
    });

    it('rejects a VectorIndexes value that is not a list', async () => {
      await invalid({ VectorIndexes: {} }, {}, /VectorIndexes must be a list/);
    });
  });

  describe('UpdateTable (vector subset, PRD §4.4)', () => {
    const plainTable = (billing = 'PAY_PER_REQUEST') => call('CreateTable', {
      TableName: 'plain',
      BillingMode: billing,
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    });
    const createAction = (extra: Record<string, unknown> = {}) => ({
      Create: {
        IndexName: 'byText',
        VectorAttribute: { AttributeName: 'v' },
        SearchSchema: [{ AttributeName: 'tenant', SearchSchemaElementType: 'HASH' }],
        Dimensions: 2,
        DistanceFunction: 'EUCLIDEAN',
        ...extra,
      },
    });

    it('creates an index on an existing table, merging the AttributeDefinitions it needs', async () => {
      await plainTable();
      const res = await call('UpdateTable', {
        TableName: 'plain',
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }, { AttributeName: 'tenant', AttributeType: 'S' }],
        VectorIndexUpdates: [createAction()],
      });
      expect(res.TableDescription.VectorIndexes[0]).toMatchObject({ IndexName: 'byText', IndexStatus: 'ACTIVE', DistanceFunction: 'EUCLIDEAN' });
      const described = (await call('DescribeTable', { TableName: 'plain' })).Table;
      expect(described.AttributeDefinitions).toEqual([
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'tenant', AttributeType: 'S' },
      ]);
    });

    it('indexes items written before the index existed (synchronous backfill)', async () => {
      await plainTable();
      await call('PutItem', { TableName: 'plain', Item: { id: { S: 'a' }, v: vec(1, 1) } });
      await call('PutItem', { TableName: 'plain', Item: { id: { S: 'b' }, v: vec(1, 2, 3) } });
      await call('UpdateTable', { TableName: 'plain', VectorIndexUpdates: [createAction({ SearchSchema: undefined })] });
      const [index] = (await call('DescribeTable', { TableName: 'plain' })).Table.VectorIndexes;
      // The 3-dim vector predates the index: never indexed, never searchable.
      expect(index.ItemCount).toBe(1);
      const res = await call('SearchVectors', { TableName: 'plain', IndexName: 'byText', SearchVector: query(1, 1), TopK: 5 });
      expect(res.SearchResults.map((r: any) => r.Item.id.S)).toEqual(['a']);
    });

    it('fails a Create that references an undefined attribute', async () => {
      await plainTable();
      await expectAwsError(
        call('UpdateTable', { TableName: 'plain', VectorIndexUpdates: [createAction()] }),
        'ValidationException', /Keys: \[tenant\], AttributeDefinitions: \[id\]/,
      );
    });

    it('refuses to retype an existing attribute', async () => {
      await plainTable();
      await expectAwsError(call('UpdateTable', {
        TableName: 'plain',
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'N' }],
        VectorIndexUpdates: [createAction()],
      }), 'ValidationException', /Cannot change the type of attribute id from S to N/);
    });

    it('rejects a Create on a PROVISIONED table', async () => {
      await plainTable('PROVISIONED');
      await expectAwsError(call('UpdateTable', {
        TableName: 'plain',
        AttributeDefinitions: [{ AttributeName: 'tenant', AttributeType: 'S' }],
        VectorIndexUpdates: [createAction()],
      }), 'ValidationException', /PAY_PER_REQUEST/);
    });

    it('allows one index operation per call — two actions hit the AWS limit error', async () => {
      await plainTable();
      await expectAwsError(call('UpdateTable', {
        TableName: 'plain',
        AttributeDefinitions: [{ AttributeName: 'tenant', AttributeType: 'S' }],
        VectorIndexUpdates: [createAction(), createAction({ IndexName: 'second' })],
      }), 'LimitExceededException', 'Subscriber limit exceeded: Only 1 online index can be created or deleted simultaneously per table');
    });

    it('requires exactly one of Create / Delete per action, and at least one action', async () => {
      await plainTable();
      await expectAwsError(call('UpdateTable', { TableName: 'plain', VectorIndexUpdates: [{}] }), 'ValidationException', /exactly one of Create or Delete/);
      await expectAwsError(call('UpdateTable', { TableName: 'plain', VectorIndexUpdates: [null] }), 'ValidationException', /exactly one of Create or Delete/);
      await expectAwsError(call('UpdateTable', {
        TableName: 'plain', VectorIndexUpdates: [{ ...createAction(), Delete: { IndexName: 'byText' } }],
      }), 'ValidationException', /exactly one of Create or Delete/);
      await expectAwsError(call('UpdateTable', { TableName: 'plain', VectorIndexUpdates: [] }), 'ValidationException', /must contain one Create or Delete/);
      await expectAwsError(call('UpdateTable', { TableName: 'plain' }), 'ValidationException', /must contain one Create or Delete/);
    });

    it('refuses every field outside the vector subset by name', async () => {
      await plainTable();
      await expectAwsError(
        call('UpdateTable', { TableName: 'plain', BillingMode: 'PROVISIONED', StreamSpecification: { StreamEnabled: true } }),
        'ValidationException', /unsupported parameter\(s\): BillingMode, StreamSpecification/,
      );
    });

    it('deletes an index, and reports a missing one as ResourceNotFoundException', async () => {
      await call('CreateTable', catalogTable({}, {}));
      await call('UpdateTable', {
        TableName: 'catalog',
        VectorIndexUpdates: [{ Create: { IndexName: 'second', VectorAttribute: { AttributeName: 'v2' }, Dimensions: 3, DistanceFunction: 'DOT_PRODUCT' } }],
      });
      expect((await describeVector()).map((i: any) => i.IndexName)).toEqual(['EmbeddingIndex', 'second']);
      await call('UpdateTable', { TableName: 'catalog', VectorIndexUpdates: [{ Delete: { IndexName: 'EmbeddingIndex' } }] });
      expect((await describeVector()).map((i: any) => i.IndexName)).toEqual(['second']);
      await call('UpdateTable', { TableName: 'catalog', VectorIndexUpdates: [{ Delete: { IndexName: 'second' } }] });
      expect(await describeVector()).toBeUndefined();
      await expectAwsError(
        call('UpdateTable', { TableName: 'catalog', VectorIndexUpdates: [{ Delete: { IndexName: 'second' } }] }),
        'ResourceNotFoundException', 'Requested resource not found: Vector index: second not found',
      );
    });

    it('answers ResourceNotFoundException for an unknown table', async () => {
      await expectAwsError(
        call('UpdateTable', { TableName: 'ghost', VectorIndexUpdates: [{ Delete: { IndexName: 'x' } }] }),
        'ResourceNotFoundException', /Table: ghost not found/,
      );
    });

    it('rebuilds the search cache when an index is deleted and recreated with another shape', async () => {
      await call('CreateTable', catalogTable({}, { SearchSchema: undefined }));
      await call('PutItem', { TableName: 'catalog', Item: item('p1', { embedding: vec(1, 0, 0, 0), e2: vec(0, 1) }) });
      await call('SearchVectors', { TableName: 'catalog', IndexName: 'EmbeddingIndex', SearchVector: query(1, 0, 0, 0), TopK: 1 });
      await call('UpdateTable', { TableName: 'catalog', VectorIndexUpdates: [{ Delete: { IndexName: 'EmbeddingIndex' } }] });
      await call('UpdateTable', {
        TableName: 'catalog',
        VectorIndexUpdates: [{ Create: { IndexName: 'EmbeddingIndex', VectorAttribute: { AttributeName: 'e2' }, Dimensions: 2, DistanceFunction: 'DOT_PRODUCT' } }],
      });
      const res = await call('SearchVectors', { TableName: 'catalog', IndexName: 'EmbeddingIndex', SearchVector: query(0, 3), TopK: 1 });
      expect(res.SearchResults[0].Score).toBe(3);
    });
  });

  describe('write validation (PRD §2.2)', () => {
    beforeEach(async () => {
      await call('CreateTable', catalogTable());
    });

    const put = (attrs: Record<string, unknown>) => call('PutItem', { TableName: 'catalog', Item: item('p1', attrs as never) });

    it('rejects a vector with the wrong number of dimensions', async () => {
      await expectAwsError(put({ embedding: vec(1, 0, 0) }), 'ValidationException',
        'One or more parameter values were invalid: The vector attribute embedding has 3 dimensions, but vector index EmbeddingIndex expects 4');
      expect((await call('GetItem', { TableName: 'catalog', Key: { productId: { S: 'p1' } } })).Item).toBeUndefined();
    });

    it('rejects a vector that is not a list of numbers', async () => {
      await expectAwsError(put({ embedding: { S: '[1,0,0,0]' } }), 'ValidationException', /must be a list of numbers/);
      await expectAwsError(put({ embedding: { L: [{ N: '1' }, { S: '0' }, { N: '0' }, { N: '0' }] } }), 'ValidationException', /must be a list of numbers/);
    });

    it('rejects a component outside the f32 range', async () => {
      await expectAwsError(put({ embedding: vec(1e39, 0, 0, 0) }), 'ValidationException', /32-bit floating point range/);
    });

    it('rejects a HASH attribute of the wrong type', async () => {
      await expectAwsError(put({ category: { N: '7' }, embedding: vec(1, 0, 0, 0) }), 'ValidationException',
        'One or more parameter values were invalid: Type mismatch for Index Key category Expected: S Actual: N IndexName: EmbeddingIndex');
    });

    it('accepts a missing HASH (not indexed) and a missing inline filter (indexed)', async () => {
      await put({ embedding: vec(1, 0, 0, 0) });
      await call('PutItem', { TableName: 'catalog', Item: item('p2', { category: { S: 'mice' }, embedding: vec(1, 0, 0, 0) }) });
      expect((await describeVector())[0].ItemCount).toBe(1);
    });

    it('keeps the full decimal on the base table even though the index stores f32', async () => {
      await put({ category: { S: 'mice' }, embedding: vec(0.123456789012345, 0, 0, 0) });
      const stored = await call('GetItem', { TableName: 'catalog', Key: { productId: { S: 'p1' } } });
      expect(stored.Item.embedding.L[0].N).toBe('0.123456789012345');
    });

    it('validates UpdateItem results, and lets an update remove the vector', async () => {
      await put({ category: { S: 'mice' }, embedding: vec(1, 0, 0, 0) });
      await expectAwsError(call('UpdateItem', {
        TableName: 'catalog', Key: { productId: { S: 'p1' } },
        UpdateExpression: 'SET embedding = :v', ExpressionAttributeValues: { ':v': vec(1, 2) },
      }), 'ValidationException', /has 2 dimensions/);
      await call('UpdateItem', { TableName: 'catalog', Key: { productId: { S: 'p1' } }, UpdateExpression: 'REMOVE embedding' });
      expect((await describeVector())[0].ItemCount).toBe(0);
    });

    it('validates BatchWriteItem puts', async () => {
      await expectAwsError(call('BatchWriteItem', {
        RequestItems: { catalog: [{ PutRequest: { Item: item('p1', { embedding: vec(1) }) } }] },
      }), 'ValidationException', /has 1 dimensions/);
    });

    it('cancels a transaction whose Put or Update carries a bad vector', async () => {
      const putErr = await expectAwsError(call('TransactWriteItems', {
        TransactItems: [
          { Put: { TableName: 'catalog', Item: item('ok', { embedding: vec(1, 0, 0, 0) }) } },
          { Put: { TableName: 'catalog', Item: item('bad', { embedding: vec(1, 0) }) } },
        ],
      }), 'TransactionCanceledException', /\[None, ValidationError\]/);
      expect((putErr.extra!.CancellationReasons as Array<{ Message: string }>)[1].Message).toMatch(/has 2 dimensions/);
      expect((await call('GetItem', { TableName: 'catalog', Key: { productId: { S: 'ok' } } })).Item).toBeUndefined();

      await expectAwsError(call('TransactWriteItems', {
        TransactItems: [{
          Update: {
            TableName: 'catalog', Key: { productId: { S: 'x' } },
            UpdateExpression: 'SET category = :c', ExpressionAttributeValues: { ':c': { B: 'AQ==' } },
          },
        }],
      }), 'TransactionCanceledException', /\[ValidationError\]/);
    });
  });

  it('survives a restart: indexes are still described and searches rebuild the cache from disk', async () => {
    await call('CreateTable', catalogTable());
    await call('PutItem', { TableName: 'catalog', Item: item('p1', { category: { S: 'mice' }, embedding: vec(1, 0, 0, 0) }) });
    await call('PutItem', { TableName: 'catalog', Item: item('p2', { category: { S: 'mice' }, embedding: vec(0, 1, 0, 0) }) });
    await h.ctx.store.flushAll();
    h.ctx.store.stopSweeper();

    const { ctx: reloaded } = makeCtx(h.dir);
    const fresh = new DynamoDbEmulator(reloaded);
    try {
      const described = await fresh.handle('DescribeTable', { TableName: 'catalog' }, req) as any;
      expect(described.Table.VectorIndexes[0]).toMatchObject({ IndexName: 'EmbeddingIndex', ItemCount: 2 });
      const res = await fresh.handle('SearchVectors', {
        TableName: 'catalog', IndexName: 'EmbeddingIndex', SearchVector: query(0, 1, 0, 0), TopK: 1,
        SearchConditionExpression: 'category = :c', ExpressionAttributeValues: { ':c': { S: 'mice' } },
      }, req) as any;
      expect(res.SearchResults[0].Item.productId.S).toBe('p2');
    } finally {
      reloaded.store.stopSweeper();
    }
  });
});
