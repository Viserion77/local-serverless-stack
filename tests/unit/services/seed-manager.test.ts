// Unit tests for SeedManager. Complements seed-manager-guard.test.ts (the
// destructive-op endpoint guard) by covering listing, seeding (batch + 25-item
// chunking + UnprocessedItems retry), clearing (scan/delete pagination),
// liveTables, table-existence checks, and the error/fallback arms.
//
// Pattern (see queue-inspector.test.ts): mockClient(DynamoDBClient) patches the
// SDK client prototype so the calls the singleton makes through its cached
// clients are intercepted. `fs` is mocked so seed files can be crafted in-memory.
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  BatchWriteItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  SecretsManagerClient,
  DescribeSecretCommand,
  CreateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

jest.mock('fs');
import fs from 'fs';

import { SeedManager } from '../../../src/server/services/seed-manager';
import { EngineManager } from '../../../src/server/engine/engine-manager';
import { ConfigManager } from '../../../src/server/services/config-manager';

const ddbMock = mockClient(DynamoDBClient);
const secretsMock = mockClient(SecretsManagerClient);

// Named error with an SDK-style `.name` (mirrors resource-provisioner.test.ts).
function namedError(name: string, message = name): Error {
  const e = new Error(message);
  (e as any).name = name;
  return e;
}

const SEEDS_DIR = '/tmp/seeds';

const mockedFs = fs as unknown as Record<string, jest.Mock>;

let manager: SeedManager;
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let seedsDirSpy: jest.SpyInstance;

// File contents keyed by absolute path; drives the fs mock.
let files: Record<string, string>;

beforeEach(() => {
  ddbMock.reset();
  secretsMock.reset();
  manager = SeedManager.getInstance();
  // Reset singleton client cache + region.
  const m = manager as any;
  m.clients.clear();
  m.secretsClients.clear();
  m.defaultRegion = 'us-east-1';

  files = {};

  mockedFs.existsSync = jest.fn((p: string) => p === SEEDS_DIR || p in files);
  mockedFs.readFileSync = jest.fn((p: string) => {
    if (p in files) return files[p];
    throw new Error(`ENOENT: ${p}`);
  });
  mockedFs.readdirSync = jest.fn(() =>
    Object.keys(files).map(p => p.slice(SEEDS_DIR.length + 1)),
  );

  seedsDirSpy = jest
    .spyOn(ConfigManager.getInstance(), 'getSeedsDir')
    .mockReturnValue(SEEDS_DIR);

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  seedsDirSpy.mockRestore();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  jest.restoreAllMocks();
});

afterAll(() => {
  ddbMock.restore();
  secretsMock.restore();
});

function writeSeedFile(table: string, content: unknown): void {
  files[`${SEEDS_DIR}/${table}.json`] = JSON.stringify(content);
}

describe('getInstance / region setters', () => {
  it('is a singleton', () => {
    expect(SeedManager.getInstance()).toBe(manager);
  });

  it('setDefaultRegion ignores empty, accepts a value', () => {
    manager.setDefaultRegion('');
    expect((manager as any).defaultRegion).toBe('us-east-1');
    manager.setDefaultRegion('eu-west-1');
    expect((manager as any).defaultRegion).toBe('eu-west-1');
  });

  it('setRegion delegates to setDefaultRegion', () => {
    manager.setRegion('sa-east-1');
    expect((manager as any).defaultRegion).toBe('sa-east-1');
  });
});

describe('clientFor caching', () => {
  it('reuses a cached client for the same region and builds per-region', () => {
    const m = manager as any;
    const c1 = m.clientFor();
    const c1b = m.clientFor('us-east-1');
    expect(c1).toBe(c1b);
    const c2 = m.clientFor('eu-west-1');
    expect(c2).not.toBe(c1);
  });
});

describe('hasSeedFile', () => {
  it('returns true when the seed file exists, false otherwise', () => {
    writeSeedFile('Users', [{ id: '1' }]);
    expect(manager.hasSeedFile('Users')).toBe(true);
    expect(manager.hasSeedFile('Missing')).toBe(false);
  });
});

describe('listLiveTables / listTables', () => {
  it('returns the live table names', async () => {
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['A', 'B'] });
    expect(await manager.listLiveTables()).toEqual(['A', 'B']);
  });

  it('returns [] when ListTables has no TableNames', async () => {
    ddbMock.on(ListTablesCommand).resolves({});
    expect(await manager.listLiveTables()).toEqual([]);
  });

  it('returns [] when ListTables fails (catch arm)', async () => {
    ddbMock.on(ListTablesCommand).rejects(new Error('down'));
    expect(await manager.listLiveTables()).toEqual([]);
  });

  // Past the 100-name page cap the seed↔table mismatch diagnostic would report
  // every table beyond the first page as "seed file with no live table".
  it('follows LastEvaluatedTableName across pages', async () => {
    ddbMock
      .on(ListTablesCommand, { ExclusiveStartTableName: undefined })
      .resolves({ TableNames: ['A'], LastEvaluatedTableName: 'A' })
      .on(ListTablesCommand, { ExclusiveStartTableName: 'A' })
      .resolves({ TableNames: ['B'] });
    expect(await manager.listLiveTables()).toEqual(['A', 'B']);
  });
});

describe('list', () => {
  it('returns [] when the seeds dir does not exist', async () => {
    mockedFs.existsSync = jest.fn(() => false);
    expect(await manager.list()).toEqual([]);
  });

  it('lists entries with item counts and tableExists flags', async () => {
    writeSeedFile('Users', [{ id: '1' }, { id: '2' }]);
    writeSeedFile('Orders', []);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['Users'] });

    const entries = await manager.list();
    const byName = Object.fromEntries(entries.map(e => [e.tableName, e]));
    expect(byName.Users).toMatchObject({
      tableName: 'Users',
      file: `${SEEDS_DIR}/Users.json`,
      itemCount: 2,
      tableExists: true,
    });
    expect(byName.Orders).toMatchObject({
      itemCount: 0,
      tableExists: false,
    });
  });

  it('ignores non-json files and reports itemCount -1 for an unreadable file', async () => {
    files[`${SEEDS_DIR}/Bad.json`] = 'not json {';
    files[`${SEEDS_DIR}/notes.txt`] = 'ignore me';
    ddbMock.on(ListTablesCommand).resolves({ TableNames: [] });

    const entries = await manager.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tableName: 'Bad', itemCount: -1 });
  });

  it('treats a missing items array as itemCount 0 (readSeedFile returns null after delete)', async () => {
    // File appears in readdir but existsSync says it is gone → readSeedFile null.
    files[`${SEEDS_DIR}/Ghost.json`] = '[]';
    mockedFs.existsSync = jest.fn((p: string) => p === SEEDS_DIR);
    mockedFs.readdirSync = jest.fn(() => ['Ghost.json']);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: [] });

    const entries = await manager.list();
    expect(entries[0]).toMatchObject({ tableName: 'Ghost', itemCount: 0 });
  });
});

describe('readSeedFile (via seedTable)', () => {
  it('returns skipped "no seed file" when the file is missing', async () => {
    const res = await manager.seedTable('Nope');
    expect(res).toEqual({
      tableName: 'Nope',
      inserted: 0,
      skipped: true,
      reason: 'no seed file',
    });
  });

  it('returns skipped "empty seed file" for an empty array', async () => {
    writeSeedFile('Empty', []);
    const res = await manager.seedTable('Empty');
    expect(res).toEqual({
      tableName: 'Empty',
      inserted: 0,
      skipped: true,
      reason: 'empty seed file',
    });
  });

  it('throws a wrapped error when the seed file is not a JSON array', async () => {
    writeSeedFile('Obj', { not: 'array' });
    await expect(manager.seedTable('Obj')).rejects.toThrow(
      /Failed to read seed file .*: seed file must contain a JSON array/,
    );
  });

  it('wraps non-Error throws with "unknown error"', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    // Make JSON.parse throw a non-Error value.
    mockedFs.readFileSync = jest.fn(() => '{bad');
    const parseSpy = jest.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'string failure';
    });
    await expect(manager.seedTable('Users')).rejects.toThrow(
      /Failed to read seed file .*: unknown error/,
    );
    parseSpy.mockRestore();
  });
});

describe('seedTable', () => {
  it('inserts items in a single batch', async () => {
    writeSeedFile('Users', [{ id: '1' }, { id: '2' }]);
    ddbMock.on(BatchWriteItemCommand).resolves({});
    const res = await manager.seedTable('Users');
    expect(res).toEqual({ tableName: 'Users', inserted: 2 });
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(1);
  });

  it('chunks more than 25 items into multiple batches', async () => {
    const items = Array.from({ length: 60 }, (_, n) => ({ id: String(n) }));
    writeSeedFile('Big', items);
    ddbMock.on(BatchWriteItemCommand).resolves({});
    const res = await manager.seedTable('Big');
    expect(res.inserted).toBe(60);
    // 60 -> 25 + 25 + 10 = 3 batches
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(3);
  });

  it('throws when an item is not a plain object (null/array/primitive)', async () => {
    writeSeedFile('Users', [{ id: '1' }, null]);
    await expect(manager.seedTable('Users')).rejects.toThrow(
      /Item at index 1 in Users.json is not a plain object/,
    );

    writeSeedFile('Users2', [['arr']]);
    await expect(manager.seedTable('Users2')).rejects.toThrow(
      /Item at index 0 in Users2.json is not a plain object/,
    );
  });
});

describe('writeBatchWithRetry (via seedTable)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries UnprocessedItems then succeeds', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    const leftover = [{ PutRequest: { Item: { id: { S: '1' } } } }];
    ddbMock
      .on(BatchWriteItemCommand)
      .resolvesOnce({ UnprocessedItems: { Users: leftover } })
      .resolves({});
    const p = manager.seedTable('Users');
    await jest.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toEqual({ tableName: 'Users', inserted: 1 });
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(2);
  });

  it('treats a missing UnprocessedItems map entry as done (?? [])', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    // UnprocessedItems present but no entry for this table → `?? []` → empty.
    ddbMock.on(BatchWriteItemCommand).resolves({ UnprocessedItems: {} });
    const res = await manager.seedTable('Users');
    expect(res.inserted).toBe(1);
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(1);
  });

  it('gives up after 5 retries with leftover unprocessed items', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    const leftover = [{ PutRequest: { Item: { id: { S: '1' } } } }];
    ddbMock.on(BatchWriteItemCommand).resolves({ UnprocessedItems: { Users: leftover } });
    const p = manager.seedTable('Users');
    // Attach rejection handler before advancing timers to avoid unhandled rejection.
    const assertion = expect(p).rejects.toThrow(
      /BatchWriteItem left 1 unprocessed item\(s\) after 5 retries/,
    );
    await jest.advanceTimersByTimeAsync(100 * (2 + 4 + 8 + 16 + 32) + 50);
    await assertion;
  });
});

describe('seedAll', () => {
  it('skips tables that do not exist and seeds the ones that do', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    writeSeedFile('Ghost', [{ id: '1' }]);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['Users'] });
    ddbMock.on(BatchWriteItemCommand).resolves({});

    const results = await manager.seedAll();
    const byName = Object.fromEntries(results.map(r => [r.tableName, r]));
    expect(byName.Users).toEqual({ tableName: 'Users', inserted: 1 });
    expect(byName.Ghost).toEqual({
      tableName: 'Ghost',
      inserted: 0,
      skipped: true,
      reason: 'table does not exist in the engine',
    });
  });

  it('captures a per-table seed error and reports it as skipped', async () => {
    writeSeedFile('Users', [{ id: '1' }, null]);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['Users'] });

    const results = await manager.seedAll();
    expect(results[0]).toMatchObject({
      tableName: 'Users',
      inserted: 0,
      skipped: true,
    });
    expect(results[0].reason).toMatch(/not a plain object/);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('reports "unknown error" when seedTable throws a non-Error', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['Users'] });
    jest.spyOn(manager, 'seedTable').mockRejectedValue('boom-string' as never);

    const results = await manager.seedAll();
    expect(results[0]).toMatchObject({
      tableName: 'Users',
      inserted: 0,
      skipped: true,
      reason: 'unknown error',
    });
  });
});

describe('getTableKeyAttributes (via clearTable)', () => {
  // Pin the endpoint to a local host so the guard always passes here.
  let endpointSpy: jest.SpyInstance;
  beforeEach(() => {
    endpointSpy = jest
      .spyOn(EngineManager.getInstance(), 'getEndpoint')
      .mockReturnValue('http://localhost:4566');
  });
  afterEach(() => endpointSpy.mockRestore());

  it('returns skipped "table not found" when DescribeTable fails (catch → null)', async () => {
    ddbMock.on(DescribeTableCommand).rejects(new Error('no table'));
    const res = await manager.clearTable('Missing');
    expect(res).toEqual({
      tableName: 'Missing',
      deleted: 0,
      skipped: true,
      reason: 'table not found',
    });
  });

  it('returns skipped "table not found" when the key schema is empty', async () => {
    ddbMock.on(DescribeTableCommand).resolves({ Table: { KeySchema: [] } });
    const res = await manager.clearTable('NoKeys');
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('table not found');
  });

  it('returns skipped "table not found" when Table is absent (?? [] fallback)', async () => {
    ddbMock.on(DescribeTableCommand).resolves({});
    const res = await manager.clearTable('NoTable');
    expect(res.reason).toBe('table not found');
  });
});

describe('clearTable', () => {
  let endpointSpy: jest.SpyInstance;
  beforeEach(() => {
    endpointSpy = jest
      .spyOn(EngineManager.getInstance(), 'getEndpoint')
      .mockReturnValue('http://localhost:4566');
  });
  afterEach(() => endpointSpy.mockRestore());

  it('scans and deletes items across pagination, filtering missing key attrs', async () => {
    ddbMock.on(DescribeTableCommand).resolves({
      Table: { KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] },
    });
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          { pk: { S: 'a' }, sk: { S: '1' } },
          { pk: { S: 'b' } }, // missing sk → only pk copied into the delete key
        ],
        LastEvaluatedKey: { pk: { S: 'b' } },
      })
      .resolves({ Items: [{ pk: { S: 'c' }, sk: { S: '2' } }] });
    ddbMock.on(BatchWriteItemCommand).resolves({});

    const res = await manager.clearTable('T');
    expect(res).toEqual({ tableName: 'T', deleted: 3 });
    // 2 scan pages → 2 batch writes
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(2);
  });

  it('handles a scan with no Items (?? [] fallback) → deletes 0', async () => {
    ddbMock.on(DescribeTableCommand).resolves({
      Table: { KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] },
    });
    ddbMock.on(ScanCommand).resolves({}); // no Items, no LastEvaluatedKey
    const res = await manager.clearTable('T');
    expect(res).toEqual({ tableName: 'T', deleted: 0 });
    expect(ddbMock.commandCalls(BatchWriteItemCommand)).toHaveLength(0);
  });

  it('filters out a KeySchema entry with a falsy AttributeName', async () => {
    ddbMock.on(DescribeTableCommand).resolves({
      Table: {
        // Second entry has empty AttributeName → filtered by .filter(Boolean).
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: '', KeyType: 'RANGE' }],
      },
    });
    ddbMock.on(ScanCommand).resolves({ Items: [{ pk: { S: 'a' } }] });
    ddbMock.on(BatchWriteItemCommand).resolves({});
    const res = await manager.clearTable('T');
    expect(res.deleted).toBe(1);
  });
});

describe('clearAllSeeded', () => {
  let endpointSpy: jest.SpyInstance;
  beforeEach(() => {
    endpointSpy = jest
      .spyOn(EngineManager.getInstance(), 'getEndpoint')
      .mockReturnValue('http://localhost:4566');
  });
  afterEach(() => endpointSpy.mockRestore());

  it('clears existing tables and skips missing ones', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    writeSeedFile('Ghost', [{ id: '1' }]);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['Users'] });
    ddbMock.on(DescribeTableCommand).resolves({
      Table: { KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] },
    });
    ddbMock.on(ScanCommand).resolves({ Items: [{ id: { S: '1' } }] });
    ddbMock.on(BatchWriteItemCommand).resolves({});

    const results = await manager.clearAllSeeded();
    const byName = Object.fromEntries(results.map(r => [r.tableName, r]));
    expect(byName.Users).toEqual({ tableName: 'Users', deleted: 1 });
    expect(byName.Ghost).toEqual({
      tableName: 'Ghost',
      deleted: 0,
      skipped: true,
      reason: 'table does not exist in the engine',
    });
  });

  it('captures a per-table clear error and reports it as skipped', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['Users'] });
    ddbMock.on(DescribeTableCommand).resolves({
      Table: { KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] },
    });
    ddbMock.on(ScanCommand).rejects(new Error('scan boom'));

    const results = await manager.clearAllSeeded();
    expect(results[0]).toMatchObject({
      tableName: 'Users',
      deleted: 0,
      skipped: true,
      reason: 'scan boom',
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('reports "unknown error" when clearTable throws a non-Error', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    ddbMock.on(ListTablesCommand).resolves({ TableNames: ['Users'] });
    jest.spyOn(manager, 'clearTable').mockRejectedValue(42 as never);

    const results = await manager.clearAllSeeded();
    expect(results[0]).toMatchObject({
      tableName: 'Users',
      deleted: 0,
      skipped: true,
      reason: 'unknown error',
    });
  });
});

describe('seedOnTableCreated', () => {
  it('does nothing when there is no seed file', () => {
    const spy = jest.spyOn(manager, 'seedTable');
    manager.seedOnTableCreated('Missing');
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires seedTable in the background when a seed file exists', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    const seedSpy = jest
      .spyOn(manager, 'seedTable')
      .mockResolvedValue({ tableName: 'Users', inserted: 1 });
    manager.seedOnTableCreated('Users');
    await Promise.resolve();
    expect(seedSpy).toHaveBeenCalledWith('Users', undefined);
  });

  it('swallows a background seed failure and warns (Error)', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    jest
      .spyOn(manager, 'seedTable')
      .mockRejectedValue(new Error('background boom'));
    manager.seedOnTableCreated('Users');
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto-seed for Users failed: background boom'),
    );
  });

  it('swallows a background seed failure with "unknown error" (non-Error)', async () => {
    writeSeedFile('Users', [{ id: '1' }]);
    jest.spyOn(manager, 'seedTable').mockRejectedValue('nope' as never);
    manager.seedOnTableCreated('Users');
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto-seed for Users failed: unknown error'),
    );
  });
});

// Boot Secrets Manager seeding — the error/skip arms of readSecretSeedFile() and
// ensureSecret(). Happy paths run against the real self engine in
// wire-secret-seed-on-boot.test.ts; here we mock SecretsManagerClient to drive the
// DescribeSecret/CreateSecret failure branches. Kept in this file (not a separate
// one) so seed-manager.ts has exactly two coverage loaders — this suite and the
// wire suite — which keeps the merged branch coverage of the secret paths stable.
describe('readSecretSeedFile (secret seeds)', () => {
  it('warns and returns null for a malformed JSON seed file (Error message)', () => {
    files[`${SEEDS_DIR}/secrets/bad.json`] = 'not json {';
    const result = (manager as any).readSecretSeedFile(`${SEEDS_DIR}/secrets/bad.json`);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`failed to read secret seed ${SEEDS_DIR}/secrets/bad.json`),
    );
  });

  it('reports "unknown error" when the parse throws a non-Error', () => {
    files[`${SEEDS_DIR}/secrets/ok.json`] = '{}';
    const parseSpy = jest.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'string failure';
    });
    const result = (manager as any).readSecretSeedFile(`${SEEDS_DIR}/secrets/ok.json`);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
    parseSpy.mockRestore();
  });
});

describe('listSecretSeeds / seedAllSecrets', () => {
  it('listSecretSeeds returns [] when the secrets dir does not exist', () => {
    // existsSync is true only for SEEDS_DIR + crafted files, so `<SEEDS_DIR>/secrets`
    // is absent → the `!existsSync(dir)` early return (line 343) is taken.
    expect((manager as any).listSecretSeeds()).toEqual([]);
  });

  it('seedAllSecrets defaults the region to defaultRegion when none is passed', async () => {
    // No seed files and an empty config map → nothing to seed, but the
    // `region || this.defaultRegion` default (line 429) is exercised.
    jest.spyOn(ConfigManager.getInstance(), 'getSecretSeeds').mockReturnValue({});
    await expect(manager.seedAllSecrets()).resolves.toBeUndefined();
  });
});

describe('ensureSecret', () => {
  it('skips a secret scheduled for deletion (DescribeSecret returns DeletedDate)', async () => {
    secretsMock.on(DescribeSecretCommand).resolves({ DeletedDate: new Date() });
    await manager.ensureSecret('app/key', 'value');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduled for deletion'));
    expect(secretsMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('warns and returns when DescribeSecret fails with a non-ResourceNotFound error', async () => {
    secretsMock.on(DescribeSecretCommand).rejects(namedError('AccessDeniedException', 'denied'));
    await manager.ensureSecret('app/key', 'value');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not describe "app/key": denied'),
    );
    expect(secretsMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('reports "unknown error" when DescribeSecret rejects a non-Error', async () => {
    // aws-sdk-client-mock coerces .rejects(string) into an Error, so spy on the
    // per-region client's send to reject a genuine non-Error value.
    const client = (manager as any).secretsClientFor('us-east-1');
    jest.spyOn(client, 'send').mockRejectedValue('weird-failure' as never);
    await manager.ensureSecret('app/key', 'value');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not describe "app/key": unknown error'),
    );
  });

  it('skips a value that normalizes to neither secretString nor generateSecretString', async () => {
    secretsMock.on(DescribeSecretCommand).rejects(namedError('ResourceNotFoundException'));
    await manager.ensureSecret('app/key', { secretString: null } as never);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"app/key" seed has no secretString/generateSecretString'),
    );
    expect(secretsMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('creates a secret with tags when the value carries them (Tags mapped through)', async () => {
    secretsMock.on(DescribeSecretCommand).rejects(namedError('ResourceNotFoundException'));
    secretsMock.on(CreateSecretCommand).resolves({});
    await manager.ensureSecret('app/key', { secretString: 'v', tags: { team: 'identity' } } as never);
    const calls = secretsMock.commandCalls(CreateSecretCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0].args[0].input as any).Tags).toEqual([{ Key: 'team', Value: 'identity' }]);
  });

  it('swallows a CreateSecret failure — warns and does not throw (Error)', async () => {
    secretsMock.on(DescribeSecretCommand).rejects(namedError('ResourceNotFoundException'));
    secretsMock.on(CreateSecretCommand).rejects(new Error('boom'));
    await expect(manager.ensureSecret('app/key', 'value')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('seed for "app/key" failed: boom'),
    );
  });

  it('swallows a CreateSecret failure with "unknown error" (non-Error)', async () => {
    // DescribeSecret rejects ResourceNotFound (fall through to create), then
    // CreateSecret rejects a genuine non-Error → outer catch "unknown error".
    const client = (manager as any).secretsClientFor('us-east-1');
    jest.spyOn(client, 'send').mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeSecretCommand) {
        return Promise.reject(namedError('ResourceNotFoundException'));
      }
      return Promise.reject('nope');
    });
    await expect(manager.ensureSecret('app/key', 'value')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('seed for "app/key" failed: unknown error'),
    );
  });
});
