// Boot-time Secrets Manager seeding against the REAL self engine: a
// seeds/secrets/<name>.json fixture (or a config `secrets` entry) must make the
// secret EXIST with an AWSCURRENT version before the FIRST GetSecretValue — with
// NO prior manual CreateSecret. This is the workaround-retiring path: today a
// service does a lazy CreateSecret / a `bootstrap:local` step; after this the
// secret is present on boot. Boots the SelfEngineBackend front door and drives
// SeedManager.seedAllSecrets exactly as index.ts start() does.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import { SeedManager } from '../../../src/server/services/seed-manager.js';
import { ConfigManager } from '../../../src/server/services/config-manager.js';
import { EngineManager } from '../../../src/server/engine/engine-manager.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: REGION,
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

describe('wire: boot secret seeding (real self engine, no prior CreateSecret)', () => {
  let dataDir: string;
  let seedsDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  let client: SecretsManagerClient;
  let getSecretSeedsSpy: jest.SpyInstance;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-seed-sm-'));
    seedsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-seed-dir-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();

    // Point the SeedManager's per-region client (and the assertion client) at
    // the live backend, and its seeds at the temp dir.
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({
      endpoint, region: REGION, credentials: CREDS,
    });
    jest.spyOn(ConfigManager.getInstance(), 'getSeedsDir').mockReturnValue(seedsDir);
    getSecretSeedsSpy = jest.spyOn(ConfigManager.getInstance(), 'getSecretSeeds').mockReturnValue({});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Reset the SeedManager singleton's cached clients + region.
    const sm = SeedManager.getInstance() as any;
    sm.clients.clear();
    sm.secretsClients.clear();
    sm.defaultRegion = REGION;

    client = new SecretsManagerClient({ endpoint, region: REGION, credentials: CREDS });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(seedsDir, { recursive: true, force: true });
  });

  // Secret names can contain "/", so the file lives at a nested path.
  function writeSecretSeed(name: string, value: unknown): void {
    const file = path.join(seedsDir, 'secrets', `${name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }

  it('makes a descriptor seed readable (AWSCURRENT) on the FIRST GetSecretValue', async () => {
    writeSecretSeed('billing/receipt-signing-key', {
      description: 'hmac key',
      secretString: 'dev-signing-key',
    });

    await SeedManager.getInstance().seedAllSecrets(REGION);

    const got = await client.send(new GetSecretValueCommand({ SecretId: 'billing/receipt-signing-key' }));
    expect(got.SecretString).toBe('dev-signing-key');
    expect(got.VersionStages).toEqual(['AWSCURRENT']);
  });

  it('treats a bare string as the SecretString and a bare object as JSON', async () => {
    writeSecretSeed('plain-string', 'literal-value');
    writeSecretSeed('db/creds', { username: 'admin', password: 'p@ss' });

    await SeedManager.getInstance().seedAllSecrets(REGION);

    const str = await client.send(new GetSecretValueCommand({ SecretId: 'plain-string' }));
    expect(str.SecretString).toBe('literal-value');
    const obj = await client.send(new GetSecretValueCommand({ SecretId: 'db/creds' }));
    expect(JSON.parse(obj.SecretString!)).toEqual({ username: 'admin', password: 'p@ss' });
  });

  it('applies a config `secrets` entry and lets config win on a name collision', async () => {
    writeSecretSeed('shared', 'from-file');
    getSecretSeedsSpy.mockReturnValue({ shared: 'from-config', 'config-only': 'x' });

    await SeedManager.getInstance().seedAllSecrets(REGION);

    const shared = await client.send(new GetSecretValueCommand({ SecretId: 'shared' }));
    expect(shared.SecretString).toBe('from-config');
    const only = await client.send(new GetSecretValueCommand({ SecretId: 'config-only' }));
    expect(only.SecretString).toBe('x');
  });

  it('generates a value from generateSecretString with template injection (real GetRandomPassword)', async () => {
    writeSecretSeed('db/generated', {
      generateSecretString: { secretStringTemplate: '{"username":"admin"}', generateStringKey: 'password' },
    });

    await SeedManager.getInstance().seedAllSecrets(REGION);

    const got = await client.send(new GetSecretValueCommand({ SecretId: 'db/generated' }));
    const parsed = JSON.parse(got.SecretString!);
    expect(parsed.username).toBe('admin');
    expect(typeof parsed.password).toBe('string');
    expect(parsed.password).toHaveLength(32); // default PasswordLength
    // RequireEachIncludedType defaults to true → at least one of each class.
    expect(parsed.password).toMatch(/[A-Z]/);
    expect(parsed.password).toMatch(/[a-z]/);
    expect(parsed.password).toMatch(/[0-9]/);
  });

  it('is idempotent + no-clobber across restarts (a runtime-edited value survives re-seeding)', async () => {
    writeSecretSeed('billing/receipt-signing-key', 'seed-v1');
    await SeedManager.getInstance().seedAllSecrets(REGION);

    // Developer changes the value at runtime.
    await client.send(new PutSecretValueCommand({
      SecretId: 'billing/receipt-signing-key', SecretString: 'runtime-v2',
    }));

    // Re-seed (like an orchestrator restart) — must NOT clobber and NOT throw.
    await expect(SeedManager.getInstance().seedAllSecrets(REGION)).resolves.toBeUndefined();

    const got = await client.send(new GetSecretValueCommand({ SecretId: 'billing/receipt-signing-key' }));
    expect(got.SecretString).toBe('runtime-v2');
  });
});
