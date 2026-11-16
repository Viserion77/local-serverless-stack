// AWS::DynamoDB::Table.VectorIndexes provisioning (PRD §4.6), driven against a
// REAL SelfEngineBackend through the bumped AWS SDK — so the CreateTable /
// UpdateTable serializers that used to drop `VectorIndexes` are part of what
// is proven — plus a spied client for the failure shapes a healthy engine
// never produces.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CreateTableCommand, DescribeTableCommand, UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend';
import { EngineManager } from '../../../src/server/engine/engine-manager';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner';
import { SeedManager } from '../../../src/server/services/seed-manager';
import type { DynamoDBResource, DynamoDBVectorIndex } from '../../../src/server/services/cloudformation-parser';

const embeddingIndex = (over: Partial<DynamoDBVectorIndex> = {}): DynamoDBVectorIndex => ({
  IndexName: 'ProductEmbeddingIndex',
  VectorAttribute: { AttributeName: 'embedding' },
  SearchSchema: [{ AttributeName: 'category', SearchSchemaElementType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  Dimensions: 8,
  DistanceFunction: 'COSINE',
  ...over,
});

// `category` is deliberately NOT in attributeDefinitions: the provisioner adds
// SearchSchema attributes the way it adds GSI keys.
const tableResource = (over: Partial<DynamoDBResource> = {}): DynamoDBResource => ({
  type: 'dynamodb',
  logicalId: 'CatalogEmbeddings',
  name: 'catalog-embeddings',
  keySchema: [{ AttributeName: 'productId', KeyType: 'HASH' }],
  attributeDefinitions: [{ AttributeName: 'productId', AttributeType: 'S' }],
  billingMode: 'PAY_PER_REQUEST',
  vectorIndexes: [embeddingIndex()],
  ...over,
});

describe('vector indexes (via provisionResources)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let provisioner: ResourceProvisioner;
  let send: jest.SpyInstance;
  let realSend: (cmd: unknown) => Promise<unknown>;

  const describe_ = async (name = 'catalog-embeddings') =>
    (await (provisioner as any).dynamoClient.send(new DescribeTableCommand({ TableName: name }))).Table;
  const calls = (type: abstract new (...args: never[]) => unknown) => send.mock.calls.filter(([cmd]) => cmd instanceof type);

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-prov-vector-'));
    backend = new SelfEngineBackend({
      port: 0, dataDir, account: '000000000000', region: 'us-east-1',
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    });
    await backend.start();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({
      endpoint: backend.getEndpoint(), region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    provisioner = ResourceProvisioner.getInstance();
    (provisioner as any).currentRegion = 'us-east-1';
    (provisioner as any).initializeClients('us-east-1');
    const client = (provisioner as any).dynamoClient;
    realSend = client.send.bind(client);
    send = jest.spyOn(client, 'send');
    jest.spyOn(SeedManager.getInstance(), 'seedOnTableCreated').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates the table WITH its vector index and the SearchSchema attribute definition', async () => {
    const result = await provisioner.provisionResources('catalog-service', [tableResource()]);
    expect(result.warnings).toEqual([]);
    const table = await describe_();
    expect(table.VectorIndexes).toHaveLength(1);
    expect(table.VectorIndexes[0]).toMatchObject({ IndexName: 'ProductEmbeddingIndex', Dimensions: 8, DistanceFunction: 'COSINE', IndexStatus: 'ACTIVE' });
    expect(table.AttributeDefinitions).toEqual([
      { AttributeName: 'productId', AttributeType: 'S' },
      { AttributeName: 'category', AttributeType: 'S' },
    ]);
  });

  it('adds a newly declared index to an existing table, one UpdateTable per index, idempotently', async () => {
    await provisioner.provisionResources('catalog-service', [tableResource({ vectorIndexes: undefined })]);
    expect((await describe_()).VectorIndexes).toBeUndefined();

    const declared = [
      embeddingIndex(),
      embeddingIndex({ IndexName: 'TitleIndex', VectorAttribute: { AttributeName: 'titleVec' }, SearchSchema: undefined, Dimensions: 4 }),
    ];
    const result = await provisioner.provisionResources('catalog-service', [tableResource({ vectorIndexes: declared })]);
    expect(result.warnings).toEqual([]);
    expect(calls(UpdateTableCommand)).toHaveLength(2);
    expect(calls(UpdateTableCommand)[0][0].input.AttributeDefinitions).toEqual([{ AttributeName: 'category', AttributeType: 'S' }]);
    expect(calls(UpdateTableCommand)[1][0].input.AttributeDefinitions).toBeUndefined();
    expect((await describe_()).VectorIndexes.map((i: any) => i.IndexName)).toEqual(['ProductEmbeddingIndex', 'TitleIndex']);

    send.mockClear();
    await provisioner.provisionResources('catalog-service', [tableResource({ vectorIndexes: declared })]);
    expect(calls(UpdateTableCommand)).toHaveLength(0);
  });

  it('never deletes an index the template stopped declaring — it warns instead', async () => {
    await provisioner.provisionResources('catalog-service', [tableResource()]);
    const result = await provisioner.provisionResources('catalog-service', [tableResource({ vectorIndexes: undefined })]);
    expect(result.warnings).toEqual([expect.stringContaining('has vector index(es) ProductEmbeddingIndex that the template no longer declares')]);
    expect((await describe_()).VectorIndexes).toHaveLength(1);
  });

  it.each([
    ['PROVISIONED', 'PROVISIONED'],
    [undefined, 'PROVISIONED (the default)'],
  ])('provisions a %s table WITHOUT its vector indexes and says how to fix the template', async (billingMode, shown) => {
    const result = await provisioner.provisionResources('catalog-service', [tableResource({ billingMode })]);
    expect(result.provisioned).toBe(1);
    expect(result.warnings).toEqual([
      expect.stringContaining(`but its BillingMode is ${shown}; vector indexes require BillingMode: PAY_PER_REQUEST`),
    ]);
    const table = await describe_();
    expect(table.TableStatus).toBe('ACTIVE');
    expect(table.VectorIndexes).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('set BillingMode: PAY_PER_REQUEST'));
  });

  it('retries CreateTable without the vector indexes the engine rejects', async () => {
    const result = await provisioner.provisionResources('catalog-service', [tableResource({ vectorIndexes: [embeddingIndex({ Dimensions: 0 })] })]);
    expect(result.warnings).toEqual([expect.stringMatching(/ProductEmbeddingIndex were rejected \(.*Dimensions must be an integer.*\); the table was provisioned WITHOUT them/)]);
    expect(calls(CreateTableCommand)).toHaveLength(2);
    expect((await describe_()).VectorIndexes).toBeUndefined();
  });

  it('does not retry on a non-validation failure (or a non-Error rejection)', async () => {
    send.mockImplementation(() => Promise.reject(new Error('disk on fire')));
    const first = await provisioner.provisionResources('catalog-service', [tableResource()]);
    expect(first.warnings).toEqual([expect.stringContaining('was NOT provisioned: disk on fire')]);
    send.mockImplementation(() => Promise.reject('raw'));
    await provisioner.provisionResources('catalog-service', [tableResource()]);
    expect(calls(CreateTableCommand)).toHaveLength(2);
  });

  describe('re-registration failure shapes', () => {
    beforeEach(async () => {
      await provisioner.provisionResources('catalog-service', [tableResource({ vectorIndexes: undefined })]);
      send.mockClear();
    });

    const passthrough = (override: (cmd: unknown) => Promise<unknown> | undefined) => {
      send.mockImplementation((cmd: unknown) => override(cmd) ?? realSend(cmd));
    };

    it('warns when the existing table cannot be described', async () => {
      passthrough((cmd) => (cmd instanceof DescribeTableCommand ? Promise.reject(new Error('describe down')) : undefined));
      const result = await provisioner.provisionResources('catalog-service', [tableResource()]);
      expect(result.warnings).toEqual([expect.stringContaining('could not read its vector indexes (describe down)')]);
    });

    it('does nothing when DescribeTable answers without a table body', async () => {
      passthrough((cmd) => (cmd instanceof DescribeTableCommand ? Promise.resolve({}) : undefined));
      const result = await provisioner.provisionResources('catalog-service', [tableResource()]);
      expect(result.warnings).toEqual([]);
      expect(calls(UpdateTableCommand)).toHaveLength(0);
    });

    it('warns when UpdateTable fails, but treats a concurrent duplicate as done', async () => {
      passthrough((cmd) => (cmd instanceof UpdateTableCommand ? Promise.reject(new Error('throttled')) : undefined));
      const failed = await provisioner.provisionResources('catalog-service', [tableResource()]);
      expect(failed.warnings).toEqual([expect.stringContaining('vector index ProductEmbeddingIndex was NOT added (throttled)')]);

      passthrough((cmd) => (cmd instanceof UpdateTableCommand
        ? Promise.reject(new Error('One or more parameter values were invalid: Duplicate index name: ProductEmbeddingIndex'))
        : undefined));
      const raced = await provisioner.provisionResources('catalog-service', [tableResource()]);
      expect(raced.warnings).toEqual([]);
    });
  });
});
