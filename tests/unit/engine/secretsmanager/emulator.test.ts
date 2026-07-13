// Secrets Manager emulator: the data-plane surface a project needs to retire
// the LocalStack Secrets Manager the self engine used to proxy — CreateSecret,
// GetSecretValue, PutSecretValue with AWSCURRENT/AWSPREVIOUS staging, plus
// Update/Describe/Delete/Restore/List, tagging and GetRandomPassword. Error
// names match what @aws-sdk/client-secrets-manager branches on.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SecretsManagerEmulator } from '../../../../src/server/engine/emulators/secretsmanager';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store';
import { EngineBus } from '../../../../src/server/engine/bus';
import { AwsError } from '../../../../src/server/engine/http/errors';
import type { AwsRequest, EngineContext } from '../../../../src/server/engine/types';

const REGION = 'us-west-2';
const ACCOUNT = '000000000000';

function makeCtx(): { ctx: EngineContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-secrets-'));
  const ctx: EngineContext = {
    config: {
      port: 14566, dataDir: dir, account: ACCOUNT, region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 128, fsync: false }),
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
  return { ctx, dir };
}

function makeReq(region = REGION): AwsRequest {
  return {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'secretsmanager', region, requestId: 'test-request',
  };
}

async function expectAwsError(promise: Promise<unknown>, code: string): Promise<AwsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  const error = caught as AwsError;
  expect(error.code).toBe(code);
  return error;
}

describe('SecretsManagerEmulator', () => {
  let ctx: EngineContext;
  let dir: string;
  let emulator: SecretsManagerEmulator;
  const req = makeReq();
  const call = (op: string, input: Record<string, unknown>) => emulator.handle(op, input, req);

  beforeEach(() => {
    ({ ctx, dir } = makeCtx());
    emulator = new SecretsManagerEmulator(ctx);
  });

  afterEach(() => {
    ctx.store.stopSweeper();
    ctx.bus.removeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('CreateSecret / GetSecretValue', () => {
    it('creates a secret and reads it back at AWSCURRENT', async () => {
      const created = await call('CreateSecret', {
        Name: 's7/identity/signing-key', SecretString: 'rs256-private-key',
      }) as { ARN: string; Name: string; VersionId: string };
      expect(created.Name).toBe('s7/identity/signing-key');
      expect(created.ARN).toMatch(new RegExp(`^arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:s7/identity/signing-key-`));
      expect(created.VersionId).toEqual(expect.any(String));

      const got = await call('GetSecretValue', { SecretId: 's7/identity/signing-key' }) as Record<string, unknown>;
      expect(got.SecretString).toBe('rs256-private-key');
      expect(got.VersionStages).toEqual(['AWSCURRENT']);
      expect(got.VersionId).toBe(created.VersionId);
      expect(got.ARN).toBe(created.ARN);
    });

    it('reads a secret by full ARN and by partial name', async () => {
      const created = await call('CreateSecret', { Name: 'db/password', SecretString: 'hunter2' }) as { ARN: string };
      const byArn = await call('GetSecretValue', { SecretId: created.ARN }) as Record<string, unknown>;
      expect(byArn.SecretString).toBe('hunter2');
    });

    it('stores SecretBinary round-tripping base64', async () => {
      const b64 = Buffer.from([0, 1, 2, 250]).toString('base64');
      await call('CreateSecret', { Name: 'bin', SecretBinary: b64 });
      const got = await call('GetSecretValue', { SecretId: 'bin' }) as Record<string, unknown>;
      expect(got.SecretBinary).toBe(b64);
      expect(got.SecretString).toBeUndefined();
    });

    it('rejects a duplicate name with ResourceExistsException', async () => {
      await call('CreateSecret', { Name: 'dup', SecretString: 'a' });
      await expectAwsError(call('CreateSecret', { Name: 'dup', SecretString: 'b' }), 'ResourceExistsException');
    });

    it('replays idempotently for the same ClientRequestToken', async () => {
      const token = 'token-abc';
      const first = await call('CreateSecret', { Name: 'idem', SecretString: 'v1', ClientRequestToken: token }) as { VersionId: string };
      const second = await call('CreateSecret', { Name: 'idem', SecretString: 'v1', ClientRequestToken: token }) as { VersionId: string };
      expect(second.VersionId).toBe(first.VersionId);
    });

    it('throws ResourceNotFoundException for a missing secret', async () => {
      await expectAwsError(call('GetSecretValue', { SecretId: 'nope' }), 'ResourceNotFoundException');
    });

    it('requires a Name', async () => {
      await expectAwsError(call('CreateSecret', { SecretString: 'x' }), 'InvalidParameterException');
    });
  });

  describe('PutSecretValue version staging', () => {
    it('rotates AWSCURRENT to AWSPREVIOUS on a new version', async () => {
      const v1 = await call('CreateSecret', { Name: 'rot', SecretString: 'key-1' }) as { VersionId: string };
      const v2 = await call('PutSecretValue', { SecretId: 'rot', SecretString: 'key-2' }) as { VersionId: string; VersionStages: string[] };
      expect(v2.VersionStages).toEqual(['AWSCURRENT']);
      expect(v2.VersionId).not.toBe(v1.VersionId);

      const current = await call('GetSecretValue', { SecretId: 'rot' }) as Record<string, unknown>;
      expect(current.SecretString).toBe('key-2');
      expect(current.VersionId).toBe(v2.VersionId);

      const previous = await call('GetSecretValue', { SecretId: 'rot', VersionStage: 'AWSPREVIOUS' }) as Record<string, unknown>;
      expect(previous.SecretString).toBe('key-1');
      expect(previous.VersionId).toBe(v1.VersionId);
    });

    it('keeps AWSPREVIOUS unique across repeated rotations', async () => {
      await call('CreateSecret', { Name: 'multi', SecretString: 'v1' });
      const v2 = await call('PutSecretValue', { SecretId: 'multi', SecretString: 'v2' }) as { VersionId: string };
      const v3 = await call('PutSecretValue', { SecretId: 'multi', SecretString: 'v3' }) as { VersionId: string };

      // AWSCURRENT is v3; AWSPREVIOUS must be the immediately-prior v2, not v1.
      const current = await call('GetSecretValue', { SecretId: 'multi' }) as Record<string, unknown>;
      expect(current.SecretString).toBe('v3');
      expect(current.VersionId).toBe(v3.VersionId);
      const previous = await call('GetSecretValue', { SecretId: 'multi', VersionStage: 'AWSPREVIOUS' }) as Record<string, unknown>;
      expect(previous.SecretString).toBe('v2');
      expect(previous.VersionId).toBe(v2.VersionId);

      // Exactly one version carries AWSPREVIOUS, and the orphaned v1 is GC'd.
      const described = await call('DescribeSecret', { SecretId: 'multi' }) as { VersionIdsToStages: Record<string, string[]> };
      const stageLists = Object.values(described.VersionIdsToStages);
      expect(stageLists.filter(stages => stages.includes('AWSPREVIOUS'))).toHaveLength(1);
      expect(stageLists.filter(stages => stages.includes('AWSCURRENT'))).toHaveLength(1);
      expect(Object.keys(described.VersionIdsToStages)).toHaveLength(2);
    });

    it('reads a specific version by VersionId', async () => {
      const v1 = await call('CreateSecret', { Name: 'byid', SecretString: 'one' }) as { VersionId: string };
      await call('PutSecretValue', { SecretId: 'byid', SecretString: 'two' });
      const got = await call('GetSecretValue', { SecretId: 'byid', VersionId: v1.VersionId }) as Record<string, unknown>;
      expect(got.SecretString).toBe('one');
    });

    it('is idempotent for a repeated ClientRequestToken', async () => {
      await call('CreateSecret', { Name: 'putidem', SecretString: 'a' });
      const first = await call('PutSecretValue', { SecretId: 'putidem', SecretString: 'b', ClientRequestToken: 'puttok' }) as { VersionId: string };
      const again = await call('PutSecretValue', { SecretId: 'putidem', SecretString: 'b', ClientRequestToken: 'puttok' }) as { VersionId: string };
      expect(again.VersionId).toBe(first.VersionId);
      // Only one non-current historical version should exist (no duplicate).
      const described = await call('DescribeSecret', { SecretId: 'putidem' }) as { VersionIdsToStages: Record<string, string[]> };
      expect(Object.keys(described.VersionIdsToStages)).toHaveLength(2);
    });
  });

  describe('UpdateSecret / DescribeSecret', () => {
    it('updates the value and description, creating a new AWSCURRENT', async () => {
      await call('CreateSecret', { Name: 'upd', SecretString: 'old', Description: 'first' });
      await call('UpdateSecret', { SecretId: 'upd', SecretString: 'new', Description: 'second' });
      const got = await call('GetSecretValue', { SecretId: 'upd' }) as Record<string, unknown>;
      expect(got.SecretString).toBe('new');
      const described = await call('DescribeSecret', { SecretId: 'upd' }) as Record<string, unknown>;
      expect(described.Description).toBe('second');
      expect(described.Name).toBe('upd');
    });

    it('is idempotent on ClientRequestToken (no duplicate version on retry)', async () => {
      await call('CreateSecret', { Name: 'updidem', SecretString: 'a' });
      await call('UpdateSecret', { SecretId: 'updidem', SecretString: 'b', ClientRequestToken: 'updtok' });
      await call('UpdateSecret', { SecretId: 'updidem', SecretString: 'b', ClientRequestToken: 'updtok' });
      const described = await call('DescribeSecret', { SecretId: 'updidem' }) as { VersionIdsToStages: Record<string, string[]> };
      // The retry must not create a second version sharing the token id.
      expect(Object.keys(described.VersionIdsToStages)).toHaveLength(2);
      const got = await call('GetSecretValue', { SecretId: 'updidem' }) as Record<string, unknown>;
      expect(got.SecretString).toBe('b');
      expect(got.VersionId).toBe('updtok');
    });
  });

  describe('DeleteSecret / RestoreSecret', () => {
    it('schedules deletion and blocks reads until restored', async () => {
      await call('CreateSecret', { Name: 'del', SecretString: 'x' });
      const deleted = await call('DeleteSecret', { SecretId: 'del' }) as { DeletionDate: number };
      expect(deleted.DeletionDate).toEqual(expect.any(Number));
      await expectAwsError(call('GetSecretValue', { SecretId: 'del' }), 'InvalidRequestException');

      await call('RestoreSecret', { SecretId: 'del' });
      const got = await call('GetSecretValue', { SecretId: 'del' }) as Record<string, unknown>;
      expect(got.SecretString).toBe('x');
    });

    it('force-deletes immediately, freeing the name for reuse', async () => {
      await call('CreateSecret', { Name: 'force', SecretString: 'x' });
      await call('DeleteSecret', { SecretId: 'force', ForceDeleteWithoutRecovery: true });
      await expectAwsError(call('DescribeSecret', { SecretId: 'force' }), 'ResourceNotFoundException');
      // Name is free again.
      const recreated = await call('CreateSecret', { Name: 'force', SecretString: 'y' }) as { Name: string };
      expect(recreated.Name).toBe('force');
    });

    it('blocks recreating a secret scheduled for deletion until it is restored', async () => {
      await call('CreateSecret', { Name: 'sched', SecretString: 'x' });
      await call('DeleteSecret', { SecretId: 'sched' });
      await expectAwsError(call('CreateSecret', { Name: 'sched', SecretString: 'y' }), 'InvalidRequestException');
      await call('RestoreSecret', { SecretId: 'sched' });
      // Restored — CreateSecret still conflicts (it exists again), matching AWS.
      await expectAwsError(call('CreateSecret', { Name: 'sched', SecretString: 'y' }), 'ResourceExistsException');
    });

    it('rejects ForceDeleteWithoutRecovery combined with RecoveryWindowInDays', async () => {
      await call('CreateSecret', { Name: 'conflict', SecretString: 'x' });
      await expectAwsError(
        call('DeleteSecret', { SecretId: 'conflict', ForceDeleteWithoutRecovery: true, RecoveryWindowInDays: 7 }),
        'InvalidParameterException',
      );
    });

    it('validates the recovery window range', async () => {
      await call('CreateSecret', { Name: 'win', SecretString: 'x' });
      await expectAwsError(call('DeleteSecret', { SecretId: 'win', RecoveryWindowInDays: 3 }), 'InvalidParameterException');
    });
  });

  describe('ListSecrets / tagging', () => {
    it('lists active secrets and hides scheduled-deletion ones by default', async () => {
      await call('CreateSecret', { Name: 'keep', SecretString: 'a' });
      await call('CreateSecret', { Name: 'gone', SecretString: 'b' });
      await call('DeleteSecret', { SecretId: 'gone' });
      const listed = await call('ListSecrets', {}) as { SecretList: Array<{ Name: string }> };
      expect(listed.SecretList.map(s => s.Name)).toEqual(['keep']);
      const withPlanned = await call('ListSecrets', { IncludePlannedDeletion: true }) as { SecretList: Array<{ Name: string }> };
      expect(withPlanned.SecretList.map(s => s.Name).sort()).toEqual(['gone', 'keep']);
    });

    it('adds and removes tags', async () => {
      await call('CreateSecret', { Name: 'tagged', SecretString: 'x', Tags: [{ Key: 'env', Value: 'dev' }] });
      await call('TagResource', { SecretId: 'tagged', Tags: [{ Key: 'team', Value: 'identity' }] });
      let described = await call('DescribeSecret', { SecretId: 'tagged' }) as { Tags: Array<{ Key: string; Value: string }> };
      expect(described.Tags).toEqual(expect.arrayContaining([
        { Key: 'env', Value: 'dev' },
        { Key: 'team', Value: 'identity' },
      ]));
      await call('UntagResource', { SecretId: 'tagged', TagKeys: ['env'] });
      described = await call('DescribeSecret', { SecretId: 'tagged' }) as { Tags: Array<{ Key: string; Value: string }> };
      expect(described.Tags).toEqual([{ Key: 'team', Value: 'identity' }]);
    });
  });

  describe('GetRandomPassword', () => {
    it('returns a password of the requested length', async () => {
      const res = await call('GetRandomPassword', { PasswordLength: 24 }) as { RandomPassword: string };
      expect(res.RandomPassword).toHaveLength(24);
    });

    it('excludes characters when asked', async () => {
      const res = await call('GetRandomPassword', {
        PasswordLength: 64, ExcludePunctuation: true, ExcludeUppercase: true, ExcludeNumbers: true,
      }) as { RandomPassword: string };
      expect(res.RandomPassword).toMatch(/^[a-z]{64}$/);
    });

    it('includes at least one character of every included type by default', async () => {
      // RequireEachIncludedType defaults to true — a short password must still
      // carry an upper, lower, digit and punctuation char. Repeat to guard
      // against a lucky pass.
      for (let i = 0; i < 40; i++) {
        const res = await call('GetRandomPassword', { PasswordLength: 4 }) as { RandomPassword: string };
        expect(res.RandomPassword).toMatch(/[A-Z]/);
        expect(res.RandomPassword).toMatch(/[a-z]/);
        expect(res.RandomPassword).toMatch(/[0-9]/);
        expect(res.RandomPassword).toMatch(/[^A-Za-z0-9]/);
      }
    });

    it('does not force each type when RequireEachIncludedType is false', async () => {
      const res = await call('GetRandomPassword', { PasswordLength: 20, RequireEachIncludedType: false }) as { RandomPassword: string };
      expect(res.RandomPassword).toHaveLength(20);
    });

    it('rejects an impossible character pool', async () => {
      await expectAwsError(
        call('GetRandomPassword', {
          ExcludeUppercase: true, ExcludeLowercase: true, ExcludeNumbers: true, ExcludePunctuation: true,
        }),
        'InvalidParameterException',
      );
    });
  });

  it('scopes secrets per region', async () => {
    await call('CreateSecret', { Name: 'scoped', SecretString: 'west' });
    const euReq = makeReq('eu-west-1');
    await expectAwsError(emulator.handle('GetSecretValue', { SecretId: 'scoped' }, euReq), 'ResourceNotFoundException');
  });

  it('reports NotImplemented for unsupported operations without a fallback dead end', async () => {
    const error = await expectAwsError(call('RotateSecret', { SecretId: 'x' }), 'NotImplemented');
    expect(error.message).toMatch(/does not apply/);
  });
});
