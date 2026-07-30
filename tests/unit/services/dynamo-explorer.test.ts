// Unit tests for DynamoExplorer. Follows the AWS-SDK-mock singleton pattern:
// mockClient(DynamoDBClient) patches the SDK client prototype so the calls the
// singleton makes through its cached clients are intercepted. The source uses
// the *plain* DynamoDBClient (with marshall/unmarshall from util-dynamodb), so
// that is the class we mock. Singleton state (client cache) is reset per test.
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
  ScanCommand,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { DynamoExplorer } from '../../../src/server/services/dynamo-explorer';

const ddbMock = mockClient(DynamoDBClient);

let explorer: DynamoExplorer;

beforeEach(() => {
  ddbMock.reset();
  explorer = DynamoExplorer.getInstance();
  const e = explorer as any;
  e.clients.clear();
  e.defaultRegion = 'us-east-1';
});

afterAll(() => {
  ddbMock.restore();
});

describe('getInstance / setDefaultRegion / clientFor', () => {
  it('is a singleton', () => {
    expect(DynamoExplorer.getInstance()).toBe(explorer);
  });

  it('setDefaultRegion ignores empty, accepts a value', () => {
    explorer.setDefaultRegion('');
    expect((explorer as any).defaultRegion).toBe('us-east-1');
    explorer.setDefaultRegion('eu-west-1');
    expect((explorer as any).defaultRegion).toBe('eu-west-1');
  });

  it('caches one client per region and reuses it', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: [] });
    await explorer.listTables('sa-east-1');
    await explorer.listTables('sa-east-1');
    const e = explorer as any;
    expect(e.clients.size).toBe(1);
    expect(e.clients.has('sa-east-1')).toBe(true);
  });

  it('falls back to the default region when none is given', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: [] });
    await explorer.listTables();
    expect((explorer as any).clients.has('us-east-1')).toBe(true);
  });
});

describe('listTables / summarize', () => {
  it('returns [] when there are no table names', async () => {
    ddbMock.on(ListTablesCommand).resolves({}); // no TableNames → `?? []`
    expect(await explorer.listTables()).toEqual([]);
  });

  // ListTables caps a page at 100 names. A monorepo with 40 services x 10
  // tables has 400 — without following LastEvaluatedTableName the dashboard
  // silently showed the first quarter.
  it('follows LastEvaluatedTableName across pages', async () => {
    ddbMock
      .on(ListTablesCommand, { ExclusiveStartTableName: undefined })
      .resolves({ TableNames: ['a', 'b'], LastEvaluatedTableName: 'b' })
      .on(ListTablesCommand, { ExclusiveStartTableName: 'b' })
      .resolves({ TableNames: ['c'], LastEvaluatedTableName: 'c' })
      .on(ListTablesCommand, { ExclusiveStartTableName: 'c' })
      .resolves({ TableNames: ['d'] });

    expect(await explorer.listTableNames()).toEqual(['a', 'b', 'c', 'd']);
    expect(ddbMock.commandCalls(ListTablesCommand)).toHaveLength(3);
  });

  it('summarizes each table with full metadata (GSI/LSI/stream/ttl/billing/created)', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['t1'] });
    ddbMock.on(DescribeTableCommand).resolves({
      Table: {
        TableStatus: 'ACTIVE',
        ItemCount: 4,
        TableSizeBytes: 128,
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
        LocalSecondaryIndexes: [{ IndexName: 'lsi1' }],
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        CreationDateTime: new Date('2024-01-01T00:00:00.000Z'),
      },
    });
    ddbMock.on(DescribeTimeToLiveCommand).resolves({
      TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'ttl' },
    });

    const tables = await explorer.listTables();
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      name: 't1',
      status: 'ACTIVE',
      itemCount: 4,
      sizeBytes: 128,
      hasGsi: true,
      hasLsi: true,
      streamEnabled: true,
      billingMode: 'PAY_PER_REQUEST',
      createdAt: '2024-01-01T00:00:00.000Z',
      ttl: { enabled: true, attributeName: 'ttl' },
      warnings: [],
    });
  });

  it('applies defensive fallbacks for a sparse table description and warns when TTL is off', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['sparse'] });
    // No counts/sizes/key schema/indexes/stream/billing/created → all fallbacks.
    ddbMock.on(DescribeTableCommand).resolves({ Table: {} });
    // TTL DISABLED → enabled false → warning pushed.
    ddbMock.on(DescribeTimeToLiveCommand).resolves({
      TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
    });

    const tables = await explorer.listTables();
    expect(tables[0]).toMatchObject({
      name: 'sparse',
      status: undefined,
      itemCount: 0,
      sizeBytes: 0,
      keySchema: [],
      attributeDefinitions: [],
      hasGsi: false,
      hasLsi: false,
      streamEnabled: false,
      billingMode: 'PROVISIONED',
      createdAt: undefined,
      ttl: { enabled: false },
      warnings: ['TTL not configured'],
    });
  });

  it('drops a table whose description has no Table (summarize returns null)', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['ghost'] });
    ddbMock.on(DescribeTableCommand).resolves({}); // no Table → null
    ddbMock.on(DescribeTimeToLiveCommand).resolves({});
    expect(await explorer.listTables()).toEqual([]);
  });

  it('drops a table when DescribeTable rejects (summarize catch, Error branch)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['boom'] });
    ddbMock.on(DescribeTableCommand).rejects(new Error('kaboom'));
    ddbMock.on(DescribeTimeToLiveCommand).resolves({});
    expect(await explorer.listTables()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[dynamo] failed to describe boom: kaboom');
    warn.mockRestore();
  });

  it('handles a non-Error rejection in summarize (unknown error branch)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['weird'] });
    // aws-sdk-client-mock coerces .rejects() values into Errors, so to drive the
    // non-Error (`'unknown error'`) arm we bypass the mock and reject send() with
    // a raw non-Error value straight from the client prototype.
    const sendSpy = jest
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockImplementation((command: any) => {
        if (command instanceof ListTablesCommand) return Promise.resolve({ TableNames: ['weird'] });
        if (command instanceof DescribeTimeToLiveCommand) return Promise.resolve({});
        // DescribeTableCommand → reject with a non-Error value.
        return Promise.reject('a string failure');
      });
    expect(await explorer.listTables()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[dynamo] failed to describe weird: unknown error');
    sendSpy.mockRestore();
    warn.mockRestore();
  });
});

describe('describeTable', () => {
  it('returns null when the summary is null', async () => {
    ddbMock.on(DescribeTableCommand).resolves({}); // summarize → null
    ddbMock.on(DescribeTimeToLiveCommand).resolves({});
    expect(await explorer.describeTable('missing')).toBeNull();
  });

  it('returns full detail (arn, gsis, lsis, stream arn + view type)', async () => {
    ddbMock.on(DescribeTableCommand).resolves({
      Table: {
        TableStatus: 'ACTIVE',
        TableArn: 'arn:aws:dynamodb:us-east-1:000:table/t',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
        LocalSecondaryIndexes: [{ IndexName: 'lsi1' }],
        LatestStreamArn: 'arn:aws:dynamodb:us-east-1:000:table/t/stream/x',
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
      },
    });
    ddbMock.on(DescribeTimeToLiveCommand).resolves({
      TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'ttl' },
    });

    const detail = await explorer.describeTable('t');
    expect(detail).toMatchObject({
      name: 't',
      arn: 'arn:aws:dynamodb:us-east-1:000:table/t',
      gsis: [{ IndexName: 'gsi1' }],
      lsis: [{ IndexName: 'lsi1' }],
      streamArn: 'arn:aws:dynamodb:us-east-1:000:table/t/stream/x',
      streamViewType: 'NEW_AND_OLD_IMAGES',
    });
  });

  it('uses fallbacks for a detail with no indexes/stream', async () => {
    ddbMock.on(DescribeTableCommand).resolves({ Table: { TableStatus: 'ACTIVE' } });
    ddbMock.on(DescribeTimeToLiveCommand).resolves({});
    const detail = await explorer.describeTable('t');
    expect(detail).toMatchObject({
      gsis: [],
      lsis: [],
      arn: undefined,
      streamArn: undefined,
      streamViewType: undefined,
    });
  });
});

describe('describeTtl', () => {
  it('reports enabled for ENABLED status', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({
      TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'expireAt' },
    });
    expect(await explorer.describeTtl('t')).toEqual({ enabled: true, attributeName: 'expireAt' });
  });

  it('reports enabled for ENABLING status', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({
      TimeToLiveDescription: { TimeToLiveStatus: 'ENABLING', AttributeName: 'expireAt' },
    });
    expect(await explorer.describeTtl('t')).toEqual({ enabled: true, attributeName: 'expireAt' });
  });

  it('reports disabled for any other status (and undefined attribute)', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({
      TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
    });
    expect(await explorer.describeTtl('t')).toEqual({ enabled: false, attributeName: undefined });
  });

  it('reports disabled when the description is missing entirely', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({}); // no TimeToLiveDescription
    expect(await explorer.describeTtl('t')).toEqual({ enabled: false, attributeName: undefined });
  });

  it('reports disabled and swallows errors (catch branch)', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).rejects(new Error('no such table'));
    expect(await explorer.describeTtl('t')).toEqual({ enabled: false });
  });
});

describe('setTtl', () => {
  it('throws when enabling without an attribute name', async () => {
    await expect(explorer.setTtl('t', true)).rejects.toThrow(
      'attributeName is required when enabling TTL',
    );
  });

  it('enables TTL with the provided attribute name', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({}); // describeTtl current
    ddbMock.on(UpdateTimeToLiveCommand).resolves({});
    const res = await explorer.setTtl('t', true, 'expireAt');
    expect(res).toEqual({ enabled: true, attributeName: 'expireAt' });
    const call = ddbMock.commandCalls(UpdateTimeToLiveCommand)[0].args[0].input as any;
    expect(call.TimeToLiveSpecification).toEqual({ Enabled: true, AttributeName: 'expireAt' });
  });

  it('disables TTL reusing the current attribute name', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({
      TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'currentTtl' },
    });
    ddbMock.on(UpdateTimeToLiveCommand).resolves({});
    const res = await explorer.setTtl('t', false);
    expect(res).toEqual({ enabled: false, attributeName: 'currentTtl' });
  });

  it('disables TTL using the passed attribute when there is no current one', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({}); // no current attribute
    ddbMock.on(UpdateTimeToLiveCommand).resolves({});
    const res = await explorer.setTtl('t', false, 'passedTtl');
    expect(res).toEqual({ enabled: false, attributeName: 'passedTtl' });
  });

  it('disables TTL falling back to the literal "ttl" when nothing is known', async () => {
    ddbMock.on(DescribeTimeToLiveCommand).resolves({}); // no current attribute
    ddbMock.on(UpdateTimeToLiveCommand).resolves({});
    const res = await explorer.setTtl('t', false); // no passed attribute either
    expect(res).toEqual({ enabled: false, attributeName: 'ttl' });
  });
});

describe('scan', () => {
  it('scans with all options and marshalls values + start key, formatting paged output', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [marshall({ pk: 'a', n: 1 })],
      Count: 1,
      ScannedCount: 2,
      LastEvaluatedKey: marshall({ pk: 'a' }),
    });

    const out = await explorer.scan('t', {
      filterExpression: '#n > :min',
      projectionExpression: 'pk, #n',
      expressionAttributeNames: { '#n': 'n' },
      expressionAttributeValues: { ':min': 0 },
      indexName: 'gsi1',
      limit: 10,
      exclusiveStartKey: { pk: 'start' },
    });

    expect(out).toEqual({
      items: [{ pk: 'a', n: 1 }],
      count: 1,
      scannedCount: 2,
      lastEvaluatedKey: { pk: 'a' },
    });

    const input = ddbMock.commandCalls(ScanCommand)[0].args[0].input as any;
    expect(input.FilterExpression).toBe('#n > :min');
    expect(input.IndexName).toBe('gsi1');
    expect(input.ExclusiveStartKey).toEqual(marshall({ pk: 'start' }));
    expect(input.ExpressionAttributeValues[':min']).toEqual({ N: '0' });
  });

  it('scans with empty/blank options (undefined fallbacks, no start key, no values)', async () => {
    ddbMock.on(ScanCommand).resolves({}); // no Items/Count/etc → all output fallbacks
    const out = await explorer.scan('t', {
      filterExpression: '', // falsy → undefined
      projectionExpression: '',
      indexName: '',
      expressionAttributeValues: {}, // empty → marshall returns undefined
    });
    expect(out).toEqual({
      items: [],
      count: 0,
      scannedCount: undefined,
      lastEvaluatedKey: undefined,
    });
    const input = ddbMock.commandCalls(ScanCommand)[0].args[0].input as any;
    expect(input.FilterExpression).toBeUndefined();
    expect(input.ProjectionExpression).toBeUndefined();
    expect(input.IndexName).toBeUndefined();
    expect(input.ExpressionAttributeValues).toBeUndefined();
    expect(input.ExclusiveStartKey).toBeUndefined();
  });
});

describe('query', () => {
  it('throws when keyConditionExpression is missing', async () => {
    await expect(explorer.query('t', {})).rejects.toThrow(
      'keyConditionExpression is required for query',
    );
  });

  it('queries with all options and marshalls values + start key', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [marshall({ pk: 'a' })],
      Count: 1,
      ScannedCount: 1,
    });
    const out = await explorer.query('t', {
      keyConditionExpression: 'pk = :pk',
      filterExpression: 'attribute_exists(x)',
      projectionExpression: 'pk',
      expressionAttributeNames: { '#x': 'x' },
      expressionAttributeValues: { ':pk': 'a' },
      indexName: 'gsi1',
      limit: 5,
      exclusiveStartKey: { pk: 'a' },
      scanIndexForward: false,
    });
    expect(out).toEqual({
      items: [{ pk: 'a' }],
      count: 1,
      scannedCount: 1,
      lastEvaluatedKey: undefined,
    });
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input as any;
    expect(input.KeyConditionExpression).toBe('pk = :pk');
    expect(input.ScanIndexForward).toBe(false);
    expect(input.ExclusiveStartKey).toEqual(marshall({ pk: 'a' }));
  });

  it('queries with only the required key condition (fallbacks elsewhere)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });
    const out = await explorer.query('t', { keyConditionExpression: 'pk = :pk' });
    expect(out.items).toEqual([]);
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input as any;
    expect(input.FilterExpression).toBeUndefined();
    expect(input.ProjectionExpression).toBeUndefined();
    expect(input.IndexName).toBeUndefined();
    expect(input.ExpressionAttributeValues).toBeUndefined();
    expect(input.ExclusiveStartKey).toBeUndefined();
  });
});

describe('getItem', () => {
  it('returns the unmarshalled item when present', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: marshall({ pk: 'a', n: 7 }) });
    expect(await explorer.getItem('t', { pk: 'a' })).toEqual({ pk: 'a', n: 7 });
    const input = ddbMock.commandCalls(GetItemCommand)[0].args[0].input as any;
    expect(input.Key).toEqual(marshall({ pk: 'a' }));
  });

  it('returns null when the item is absent', async () => {
    ddbMock.on(GetItemCommand).resolves({}); // no Item → null
    expect(await explorer.getItem('t', { pk: 'missing' })).toBeNull();
  });
});

describe('putItem', () => {
  it('throws when the item is not a plain object', async () => {
    await expect(explorer.putItem('t', null as any)).rejects.toThrow('Item must be a plain object');
    await expect(explorer.putItem('t', 'nope' as any)).rejects.toThrow(
      'Item must be a plain object',
    );
  });

  it('marshalls and writes the item', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    await expect(explorer.putItem('t', { pk: 'a', n: 1 })).resolves.toBeUndefined();
    const input = ddbMock.commandCalls(PutItemCommand)[0].args[0].input as any;
    expect(input.Item).toEqual(marshall({ pk: 'a', n: 1 }));
  });
});

describe('deleteItem', () => {
  it('marshalls the key and deletes', async () => {
    ddbMock.on(DeleteItemCommand).resolves({});
    await expect(explorer.deleteItem('t', { pk: 'a' })).resolves.toBeUndefined();
    const input = ddbMock.commandCalls(DeleteItemCommand)[0].args[0].input as any;
    expect(input.Key).toEqual(marshall({ pk: 'a' }));
  });
});
