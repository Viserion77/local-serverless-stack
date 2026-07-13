// Unit tests for SecretsExplorer. Uses the AWS-SDK-mock singleton pattern
// (mockClient patches the SecretsManagerClient prototype so calls made through
// the cached clients are intercepted). Covers list pagination, describe/reveal
// mapping, ResourceNotFoundException → null, error re-throw and client caching.
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  ListSecretsCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SecretsExplorer } from '../../../src/server/services/secrets-explorer';

const smMock = mockClient(SecretsManagerClient);
let explorer: SecretsExplorer;

const notFound = Object.assign(new Error('no secret'), { name: 'ResourceNotFoundException' });

beforeEach(() => {
  smMock.reset();
  explorer = SecretsExplorer.getInstance();
  const e = explorer as any;
  e.clients.clear();
  e.defaultRegion = 'us-east-1';
});

describe('listSecrets', () => {
  it('paginates through every page and maps summaries', async () => {
    smMock
      .on(ListSecretsCommand)
      .resolvesOnce({
        SecretList: [
          {
            Name: 'b/two',
            ARN: 'arn:aws:secretsmanager:us-east-1:0:secret:b/two-xx',
            Description: 'second',
            // A well-formed tag plus one missing Key/Value covers the ?? ''
            // fallbacks; Tags present covers the truthy `?? []` branch.
            Tags: [{ Key: 'env', Value: 'dev' }, {}],
            SecretVersionsToStages: { v1: ['AWSCURRENT'] },
            LastChangedDate: new Date('2026-07-01T00:00:00Z'),
          },
        ],
        NextToken: 'page2',
      })
      .resolvesOnce({
        // Second entry (no name/versions/tags) covers the `?? []`/`?? 0`
        // fallbacks and Tags-undefined branch.
        SecretList: [{}],
      });

    const secrets = await explorer.listSecrets('us-east-1');
    // Sorted by name: '' (the empty second entry) sorts before 'b/two'.
    expect(secrets.map(s => s.name)).toEqual(['', 'b/two']);
    const two = secrets.find(s => s.name === 'b/two')!;
    expect(two.description).toBe('second');
    expect(two.tags).toEqual([{ key: 'env', value: 'dev' }, { key: '', value: '' }]);
    expect(two.versionCount).toBe(1);
    const empty = secrets.find(s => s.name === '')!;
    expect(empty.tags).toEqual([]);
    expect(empty.versionCount).toBe(0);
    // Two pages were fetched.
    expect(smMock.commandCalls(ListSecretsCommand)).toHaveLength(2);
  });

  it('handles an empty SecretList', async () => {
    smMock.on(ListSecretsCommand).resolves({});
    expect(await explorer.listSecrets()).toEqual([]);
  });
});

describe('describeSecret', () => {
  it('maps the full metadata shape', async () => {
    smMock.on(DescribeSecretCommand).resolves({
      Name: 'app/key',
      ARN: 'arn:...:secret:app/key-ab',
      Description: 'signing key',
      KmsKeyId: 'alias/aws/secretsmanager',
      Tags: [{ Key: 'team', Value: 'identity' }, {}],
      VersionIdsToStages: { v2: ['AWSCURRENT'], v1: ['AWSPREVIOUS'] },
      CreatedDate: new Date('2026-06-01T00:00:00Z'),
      LastChangedDate: new Date('2026-07-01T00:00:00Z'),
      LastAccessedDate: new Date('2026-07-02T00:00:00Z'),
    });
    const detail = await explorer.describeSecret('app/key', 'us-east-1');
    expect(detail).toMatchObject({
      name: 'app/key',
      description: 'signing key',
      kmsKeyId: 'alias/aws/secretsmanager',
      versionCount: 2,
      tags: [{ key: 'team', value: 'identity' }, { key: '', value: '' }],
    });
    expect(detail!.versionStages).toEqual({ v2: ['AWSCURRENT'], v1: ['AWSPREVIOUS'] });
    expect(detail!.lastAccessedDate).toBe('2026-07-02T00:00:00.000Z');
  });

  it('falls back to the requested id and empties when fields are absent', async () => {
    smMock.on(DescribeSecretCommand).resolves({});
    const detail = await explorer.describeSecret('bare');
    expect(detail).toMatchObject({ name: 'bare', tags: [], versionCount: 0, versionStages: {} });
  });

  it('returns null on ResourceNotFoundException', async () => {
    smMock.on(DescribeSecretCommand).rejects(notFound);
    expect(await explorer.describeSecret('ghost')).toBeNull();
  });

  it('re-throws other errors', async () => {
    smMock.on(DescribeSecretCommand).rejects(new Error('throttled'));
    await expect(explorer.describeSecret('k')).rejects.toThrow('throttled');
  });
});

describe('getSecretValue', () => {
  it('reveals a string value', async () => {
    smMock.on(GetSecretValueCommand).resolves({
      Name: 'k', VersionId: 'v1', VersionStages: ['AWSCURRENT'], SecretString: 'hunter2',
      CreatedDate: new Date('2026-07-01T00:00:00Z'),
    });
    const value = await explorer.getSecretValue('k');
    expect(value).toMatchObject({ name: 'k', versionId: 'v1', secretString: 'hunter2' });
    expect(value!.secretBinary).toBeUndefined();
  });

  it('base64-encodes a binary value and defaults name/stages', async () => {
    smMock.on(GetSecretValueCommand).resolves({
      SecretBinary: new Uint8Array([0, 1, 2, 250]),
    });
    const value = await explorer.getSecretValue('bin', 'eu-west-1');
    expect(value).toMatchObject({ name: 'bin', versionStages: [] });
    expect(value!.secretBinary).toBe(Buffer.from([0, 1, 2, 250]).toString('base64'));
    expect(value!.secretString).toBeUndefined();
  });

  it('returns null on ResourceNotFoundException', async () => {
    smMock.on(GetSecretValueCommand).rejects(notFound);
    expect(await explorer.getSecretValue('ghost')).toBeNull();
  });

  it('re-throws other errors', async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error('denied'));
    await expect(explorer.getSecretValue('k')).rejects.toThrow('denied');
  });
});

describe('client caching and region', () => {
  it('reuses one client per region and honors setDefaultRegion', async () => {
    smMock.on(ListSecretsCommand).resolves({ SecretList: [] });
    explorer.setDefaultRegion('sa-east-1');
    explorer.setDefaultRegion(''); // no-op branch
    await explorer.listSecrets();      // uses default sa-east-1
    await explorer.listSecrets();      // cache hit
    await explorer.listSecrets('us-west-2');
    const clients = (explorer as any).clients as Map<string, unknown>;
    expect(clients.has('sa-east-1')).toBe(true);
    expect(clients.has('us-west-2')).toBe(true);
    expect(clients.size).toBe(2);
  });
});
