const crypto = require('crypto');
const {
  CreateSecretCommand,
  GetSecretValueCommand,
  GetRandomPasswordCommand,
} = require('@aws-sdk/client-secrets-manager');
const { secrets } = require('./aws');

const SECRET_ID = 'billing/receipt-signing-key';

// Lazily provisions the signing key on first use (CFN provisioning of
// AWS::SecretsManager::Secret is a follow-up, so real apps do this in a
// bootstrap step). Idempotent: a second call catches ResourceExistsException.
async function ensureSigningKey() {
  try {
    const { RandomPassword } = await secrets.send(new GetRandomPasswordCommand({
      PasswordLength: 48,
      ExcludePunctuation: true,
    }));
    await secrets.send(new CreateSecretCommand({
      Name: SECRET_ID,
      Description: 'HMAC key for signing billing receipts',
      SecretString: RandomPassword,
    }));
    console.log('[signReceipt] created signing key');
  } catch (err) {
    if (err.name !== 'ResourceExistsException') throw err;
  }
}

// GET /receipts/{id}/signature — signs the receipt id with the HMAC key read
// from Secrets Manager. Mirrors how an identity/billing service reads a signing
// key at request time. Never returns the key itself, only the signature.
exports.handler = async (event) => {
  const id = event.pathParameters && event.pathParameters.id;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'receipt id is required' }) };
  }

  await ensureSigningKey();
  const { SecretString, VersionId, VersionStages } = await secrets.send(
    new GetSecretValueCommand({ SecretId: SECRET_ID }),
  );

  const signature = crypto.createHmac('sha256', SecretString).update(id).digest('hex');
  console.log(`[signReceipt] signed ${id} with ${SECRET_ID} (${VersionStages.join(',')})`);
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      receiptId: id,
      signature,
      keyId: SECRET_ID,
      keyVersion: VersionId,
      keyStages: VersionStages,
    }),
  };
};
