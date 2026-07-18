// Pure unit tests for the shared Secrets Manager value resolution helpers
// (src/server/services/secret-value.ts). normalizeSecretSeed is a pure function —
// no mocks needed — driven across every bare-value and descriptor branch (this is
// what covers the inline tags-mapping arrow). resolveGeneratedSecretString is
// exercised with a tiny stub client to cover the template-injection vs
// raw-password branches and the GetRandomPassword defaults.
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  normalizeSecretSeed,
  resolveGeneratedSecretString,
} from '../../../src/server/services/secret-value';

describe('normalizeSecretSeed', () => {
  it('treats a bare string as the SecretString', () => {
    expect(normalizeSecretSeed('literal')).toEqual({ secretString: 'literal' });
  });

  it('JSON-stringifies a bare object with neither secretString nor generateSecretString', () => {
    const value = { username: 'admin', password: 'p@ss' };
    expect(normalizeSecretSeed(value)).toEqual({ secretString: JSON.stringify(value) });
  });

  it('keeps a descriptor secretString that is already a string verbatim', () => {
    // Descriptor via the secretString key, no optional metadata → nothing else copied.
    expect(normalizeSecretSeed({ secretString: 'dev-key' })).toEqual({ secretString: 'dev-key' });
  });

  it('JSON-stringifies a descriptor secretString that is a non-string object', () => {
    expect(normalizeSecretSeed({ secretString: { a: 1 } })).toEqual({
      secretString: JSON.stringify({ a: 1 }),
    });
  });

  it('leaves secretString unset when a descriptor secretString is null', () => {
    // raw !== undefined but raw === null → neither the string nor the stringify arm.
    expect(normalizeSecretSeed({ secretString: null } as never)).toEqual({});
  });

  it('copies a generateSecretString spec through (descriptor via that key alone)', () => {
    const gen = { passwordLength: 24 };
    expect(normalizeSecretSeed({ generateSecretString: gen })).toEqual({ generateSecretString: gen });
  });

  it('maps description, kmsKeyId and tags (tags → [{Key,Value}])', () => {
    const spec = normalizeSecretSeed({
      secretString: 'v',
      description: 'a key',
      kmsKeyId: 'alias/aws/secretsmanager',
      tags: { team: 'identity', env: 'dev' },
    });
    expect(spec).toEqual({
      secretString: 'v',
      description: 'a key',
      kmsKeyId: 'alias/aws/secretsmanager',
      tags: [
        { Key: 'team', Value: 'identity' },
        { Key: 'env', Value: 'dev' },
      ],
    });
  });

  it('stringifies non-string tag values', () => {
    const spec = normalizeSecretSeed({ secretString: 'v', tags: { count: 3 } as never });
    expect(spec.tags).toEqual([{ Key: 'count', Value: '3' }]);
  });

  it('ignores wrong-typed generateSecretString/description/kmsKeyId/tags on a descriptor', () => {
    // Still a descriptor (has generateSecretString key), but every optional field is
    // the wrong type → the right-hand operand of each guard is false, nothing copied.
    const spec = normalizeSecretSeed({
      generateSecretString: 'nope',
      description: 123,
      kmsKeyId: false,
      tags: 'not-an-object',
    } as never);
    expect(spec).toEqual({});
  });
});

describe('resolveGeneratedSecretString', () => {
  const stubClient = (randomPassword: string | undefined): SecretsManagerClient =>
    ({ send: jest.fn(async () => ({ RandomPassword: randomPassword })) } as unknown as SecretsManagerClient);

  it('injects the generated password into the template at the given key', async () => {
    const out = await resolveGeneratedSecretString(stubClient('gen-pw'), {
      secretStringTemplate: '{"username":"admin"}',
      generateStringKey: 'password',
    });
    expect(JSON.parse(out)).toEqual({ username: 'admin', password: 'gen-pw' });
  });

  it('returns the raw generated password when no template/key is given (explicit overrides)', async () => {
    const out = await resolveGeneratedSecretString(stubClient('raw-pw'), {
      passwordLength: 20,
      requireEachIncludedType: false,
    });
    expect(out).toBe('raw-pw');
  });

  it('returns the raw password when only a template (but no key) is given', async () => {
    const out = await resolveGeneratedSecretString(stubClient('raw-pw2'), {
      secretStringTemplate: '{"username":"admin"}',
    });
    expect(out).toBe('raw-pw2');
  });

  it('falls back to an empty string and AWS defaults when the engine returns no RandomPassword', async () => {
    const out = await resolveGeneratedSecretString(stubClient(undefined), {});
    expect(out).toBe('');
  });
});
