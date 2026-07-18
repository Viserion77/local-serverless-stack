// Shared Secrets Manager value resolution used by BOTH boot paths that need a
// secret to EXIST with an AWSCURRENT version before the first GetSecretValue:
//   - the CFN provisioner (AWS::SecretsManager::Secret), and
//   - the boot seed applier (seeds/secrets/<name>.json + config `secrets`).
// Keeping the GenerateSecretString expansion here means both call sites
// synthesize identical values, matching how CloudFormation expands the
// (control-plane-only) GenerateSecretString into GetRandomPassword + CreateSecret.

import { GetRandomPasswordCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// CFN GenerateSecretString / seed `generateSecretString`, camelCased. Mirrors
// the sub-fields the engine's GetRandomPassword honors.
export interface GenerateSecretStringSpec {
  secretStringTemplate?: string;
  generateStringKey?: string;
  passwordLength?: number;
  excludeCharacters?: string;
  excludeUppercase?: boolean;
  excludeLowercase?: boolean;
  excludeNumbers?: boolean;
  excludePunctuation?: boolean;
  includeSpace?: boolean;
  requireEachIncludedType?: boolean;
}

// A boot seed value: either the SecretString itself (a bare string, or a JSON
// object that is stringified) or a descriptor carrying metadata alongside a
// secretString/generateSecretString. A bare object with NEITHER key IS the
// SecretString (so a DB-cred JSON just works).
export type SecretSeedValue = string | SecretSeedDescriptor;

export interface SecretSeedDescriptor {
  secretString?: string | Record<string, unknown>;
  generateSecretString?: GenerateSecretStringSpec;
  description?: string;
  kmsKeyId?: string;
  tags?: Record<string, string>;
  // Bare-object values carry arbitrary keys — they ARE the secret payload.
  [key: string]: unknown;
}

// A seed/CFN spec normalized to the pieces CreateSecret needs.
export interface NormalizedSecretSpec {
  secretString?: string;
  generateSecretString?: GenerateSecretStringSpec;
  description?: string;
  kmsKeyId?: string;
  tags?: Array<{ Key: string; Value: string }>;
}

// Expand a GenerateSecretString spec into a SecretString exactly like AWS
// CloudFormation does: GetRandomPassword with the REAL AWS defaults
// (PasswordLength 32; every char class included; RequireEachIncludedType true),
// then — when SecretStringTemplate + GenerateStringKey are both present —
// inject the generated value into the parsed template at that key. With neither
// template/key, the raw generated password is the SecretString.
export async function resolveGeneratedSecretString(
  client: SecretsManagerClient,
  spec: GenerateSecretStringSpec,
): Promise<string> {
  const { RandomPassword } = await client.send(
    new GetRandomPasswordCommand({
      PasswordLength: spec.passwordLength ?? 32,
      ExcludeCharacters: spec.excludeCharacters,
      ExcludeUppercase: spec.excludeUppercase,
      ExcludeLowercase: spec.excludeLowercase,
      ExcludeNumbers: spec.excludeNumbers,
      ExcludePunctuation: spec.excludePunctuation,
      IncludeSpace: spec.includeSpace,
      // CFN GenerateSecretString requires each included type by default.
      RequireEachIncludedType: spec.requireEachIncludedType ?? true,
    }),
  );
  const generated = RandomPassword ?? '';
  if (spec.secretStringTemplate !== undefined && spec.generateStringKey !== undefined) {
    const template = JSON.parse(spec.secretStringTemplate) as Record<string, unknown>;
    template[spec.generateStringKey] = generated;
    return JSON.stringify(template);
  }
  return generated;
}

// Interpret a boot seed value into a normalized CreateSecret spec. A bare string
// is the SecretString; a bare object (no secretString/generateSecretString key)
// is JSON-stringified into the SecretString; otherwise it is a descriptor.
export function normalizeSecretSeed(value: SecretSeedValue): NormalizedSecretSpec {
  if (typeof value === 'string') {
    return { secretString: value };
  }
  const obj = value as Record<string, unknown>;
  const isDescriptor = 'secretString' in obj || 'generateSecretString' in obj;
  if (!isDescriptor) {
    // The whole object IS the secret value (DB-cred JSON just works).
    return { secretString: JSON.stringify(obj) };
  }
  const spec: NormalizedSecretSpec = {};
  const raw = obj.secretString;
  if (typeof raw === 'string') spec.secretString = raw;
  else if (raw !== undefined && raw !== null) spec.secretString = JSON.stringify(raw);
  if (obj.generateSecretString && typeof obj.generateSecretString === 'object') {
    spec.generateSecretString = obj.generateSecretString as GenerateSecretStringSpec;
  }
  if (typeof obj.description === 'string') spec.description = obj.description;
  if (typeof obj.kmsKeyId === 'string') spec.kmsKeyId = obj.kmsKeyId;
  if (obj.tags && typeof obj.tags === 'object') {
    spec.tags = Object.entries(obj.tags as Record<string, unknown>).map(([Key, Value]) => ({
      Key,
      Value: String(Value),
    }));
  }
  return spec;
}
