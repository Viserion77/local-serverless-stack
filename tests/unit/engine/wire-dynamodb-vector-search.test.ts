// End-to-end against the REAL SelfEngineBackend front door, through the
// bumped AWS SDK (@aws-sdk/client-dynamodb / lib-dynamodb >= 3.1169): the
// serializers carry `VectorIndexes` / `VectorIndexUpdates`, SearchVectors
// arrives on the ordinary JSON 1.0 route (a configured endpoint overrides the
// SDK's dedicated `search-ddb` host), the DocumentClient marshals a plain
// number[] as the SearchVector, and engine errors surface as the SDK's typed
// exceptions — the contract a handler written for AWS relies on.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  LimitExceededException,
  PutItemCommand,
  ResourceNotFoundException,
  ScanCommand,
  SearchVectorsCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  SearchVectorsCommand as DocSearchVectorsCommand,
} from '@aws-sdk/lib-dynamodb';

// lambda-runtime-manager uses import.meta.url (ESM-only) which jest's CJS
// transform cannot load; nothing here invokes a function.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke: jest.fn() }) },
}));

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-west-2';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

describe('wire: DynamoDB vector indexes and SearchVectors (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let ddb: DynamoDBClient;
  let doc: DynamoDBDocumentClient;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-ddb-vector-'));
    const config: Partial<ResolvedSelfEngineConfig> = {
      port: 0, dataDir, account: '000000000000', region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    };
    backend = new SelfEngineBackend(config);
    await backend.start();
    ddb = new DynamoDBClient({ endpoint: backend.getEndpoint(), region: REGION, credentials: CREDS });
    doc = DynamoDBDocumentClient.from(ddb);
  });

  afterAll(async () => {
    ddb.destroy();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a table with a vector index through CreateTableCommand and describes it', async () => {
    const created = await ddb.send(new CreateTableCommand({
      TableName: 'catalog-embeddings',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'productId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'productId', AttributeType: 'S' },
        { AttributeName: 'category', AttributeType: 'S' },
      ],
      VectorIndexes: [{
        IndexName: 'ProductEmbeddingIndex',
        VectorAttribute: { AttributeName: 'embedding' },
        SearchSchema: [{ AttributeName: 'category', SearchSchemaElementType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        Dimensions: 4,
        DistanceFunction: 'COSINE',
      }],
    }));
    expect(created.TableDescription?.VectorIndexes?.[0]?.IndexName).toBe('ProductEmbeddingIndex');
    const described = await ddb.send(new DescribeTableCommand({ TableName: 'catalog-embeddings' }));
    expect(described.Table?.VectorIndexes?.[0]).toMatchObject({
      IndexName: 'ProductEmbeddingIndex',
      VectorAttribute: { AttributeName: 'embedding' },
      SearchSchema: [{ AttributeName: 'category', SearchSchemaElementType: 'HASH' }],
      Dimensions: 4,
      DistanceFunction: 'COSINE',
      IndexStatus: 'ACTIVE',
      ItemCount: 0,
    });
  });

  it('ranks neighbours with SearchVectorsCommand (low-level client)', async () => {
    const put = (id: string, category: string, v: number[]) => ddb.send(new PutItemCommand({
      TableName: 'catalog-embeddings',
      Item: { productId: { S: id }, category: { S: category }, embedding: { L: v.map((n) => ({ N: String(n) })) } },
    }));
    await put('mouse', 'peripherals', [1, 0, 0, 0]);
    await put('silent-mouse', 'peripherals', [0.9, 0.1, 0, 0]);
    await put('keyboard', 'peripherals', [0, 1, 0, 0]);
    await put('earbuds', 'audio', [1, 0, 0, 0]);

    const res = await ddb.send(new SearchVectorsCommand({
      TableName: 'catalog-embeddings',
      IndexName: 'ProductEmbeddingIndex',
      SearchVector: [{ N: '1' }, { N: '0' }, { N: '0' }, { N: '0' }],
      TopK: 3,
      SearchConditionExpression: 'category = :c',
      ExpressionAttributeValues: { ':c': { S: 'peripherals' } },
      ReturnConsumedCapacity: 'TOTAL',
    }));
    expect(res.SearchResults?.map((r) => r.Item?.productId?.S)).toEqual(['mouse', 'silent-mouse', 'keyboard']);
    expect(res.SearchResults?.[0]?.Score).toBe(0);
    expect(res.SearchResults?.[2]?.Score).toBeCloseTo(1, 5);
    // The vector attribute is left out unless projected.
    expect(res.SearchResults?.[0]?.Item?.embedding).toBeUndefined();
    expect(res.ConsumedCapacity?.VectorSearchRequestBytes).toBe(16);
  });

  it('runs the DocumentClient SearchVectorsCommand with a plain number[] query', async () => {
    await doc.send(new PutCommand({
      TableName: 'catalog-embeddings',
      Item: { productId: 'trackball', category: 'peripherals', name: 'Trackball', embedding: [0.7, 0.7, 0, 0] },
    }));
    const res = await doc.send(new DocSearchVectorsCommand({
      TableName: 'catalog-embeddings',
      IndexName: 'ProductEmbeddingIndex',
      SearchVector: [0.5, 0.5, 0, 0],
      TopK: 1,
      SearchConditionExpression: 'category = :c',
      ExpressionAttributeValues: { ':c': 'peripherals' },
      ProjectionExpression: 'productId, #n, embedding',
      ExpressionAttributeNames: { '#n': 'name' },
    }));
    expect(res.SearchResults).toEqual([{
      Item: { productId: 'trackball', name: 'Trackball', embedding: [0.7, 0.7, 0, 0] },
      Score: expect.any(Number),
    }]);
    expect(res.SearchResults?.[0]?.Score).toBeCloseTo(0, 5);
  });

  it('maps engine errors to the SDK exception classes', async () => {
    const searchWithout = ddb.send(new SearchVectorsCommand({
      TableName: 'catalog-embeddings', IndexName: 'ProductEmbeddingIndex',
      SearchVector: [{ N: '1' }, { N: '0' }, { N: '0' }, { N: '0' }], TopK: 1,
    }));
    await expect(searchWithout).rejects.toMatchObject({ name: 'ValidationException', message: expect.stringContaining('category') });

    await expect(ddb.send(new SearchVectorsCommand({
      TableName: 'nope', IndexName: 'x', SearchVector: [{ N: '1' }], TopK: 1,
    }))).rejects.toBeInstanceOf(ResourceNotFoundException);

    await expect(doc.send(new PutCommand({
      TableName: 'catalog-embeddings', Item: { productId: 'bad', category: 'audio', embedding: [1, 2] },
    }))).rejects.toMatchObject({ name: 'ValidationException', message: expect.stringContaining('has 2 dimensions') });

    await expect(ddb.send(new ScanCommand({ TableName: 'catalog-embeddings', IndexName: 'ProductEmbeddingIndex' })))
      .rejects.toMatchObject({ name: 'ValidationException' });
  });

  it('adds and drops an index with UpdateTableCommand (VectorIndexUpdates)', async () => {
    const res = await ddb.send(new UpdateTableCommand({
      TableName: 'catalog-embeddings',
      VectorIndexUpdates: [{
        Create: {
          IndexName: 'GlobalEmbeddingIndex',
          VectorAttribute: { AttributeName: 'embedding' },
          Projection: { ProjectionType: 'KEYS_ONLY' },
          Dimensions: 4,
          DistanceFunction: 'DOT_PRODUCT',
        },
      }],
    }));
    expect(res.TableDescription?.VectorIndexes?.map((i) => i.IndexName)).toEqual(['ProductEmbeddingIndex', 'GlobalEmbeddingIndex']);

    // Un-partitioned: no condition needed, every category is a candidate.
    const global = await ddb.send(new SearchVectorsCommand({
      TableName: 'catalog-embeddings', IndexName: 'GlobalEmbeddingIndex',
      SearchVector: [{ N: '1' }, { N: '0' }, { N: '0' }, { N: '0' }], TopK: 2,
    }));
    // Both score 1: the tie breaks on the canonical key encoding
    // (`S#<length>#<value>`), deterministic across runs.
    expect(global.SearchResults?.map((r) => r.Item?.productId?.S)).toEqual(['mouse', 'earbuds']);
    expect(Object.keys(global.SearchResults?.[0]?.Item ?? {})).toEqual(['productId']);

    await expect(ddb.send(new UpdateTableCommand({
      TableName: 'catalog-embeddings',
      VectorIndexUpdates: [{ Delete: { IndexName: 'GlobalEmbeddingIndex' } }, { Delete: { IndexName: 'ProductEmbeddingIndex' } }],
    }))).rejects.toBeInstanceOf(LimitExceededException);

    await ddb.send(new UpdateTableCommand({
      TableName: 'catalog-embeddings', VectorIndexUpdates: [{ Delete: { IndexName: 'GlobalEmbeddingIndex' } }],
    }));
    const described = await ddb.send(new DescribeTableCommand({ TableName: 'catalog-embeddings' }));
    expect(described.Table?.VectorIndexes?.map((i) => i.IndexName)).toEqual(['ProductEmbeddingIndex']);
  });
});
