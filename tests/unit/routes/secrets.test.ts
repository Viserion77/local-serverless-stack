// Unit test for the /api/secrets route. Mounts the router on a throwaway
// Express app and drives it with supertest; the SecretsExplorer singleton is
// stubbed. Covers region forwarding, name validation (slashes allowed,
// traversal/control chars rejected), 404s and error mapping.
import express from 'express';
import request from 'supertest';
import { secretsRouter } from '../../../src/server/routes/secrets';
import { SecretsExplorer } from '../../../src/server/services/secrets-explorer';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/secrets', secretsRouter);
  return app;
}

const explorer = SecretsExplorer.getInstance();

afterEach(() => jest.restoreAllMocks());

describe('GET /api/secrets', () => {
  it('returns the list of secrets (default region)', async () => {
    const spy = jest.spyOn(explorer, 'listSecrets').mockResolvedValue([
      { name: 'app/key', tags: [], versionCount: 1 } as never,
    ]);
    const res = await request(appWith()).get('/api/secrets');
    expect(res.status).toBe(200);
    expect(res.body.secrets).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('forwards the region query string', async () => {
    const spy = jest.spyOn(explorer, 'listSecrets').mockResolvedValue([]);
    await request(appWith()).get('/api/secrets?region=eu-west-1');
    expect(spy).toHaveBeenCalledWith('eu-west-1');
  });

  it('ignores a non-string region query (array)', async () => {
    const spy = jest.spyOn(explorer, 'listSecrets').mockResolvedValue([]);
    await request(appWith()).get('/api/secrets?region=a&region=b');
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('ignores an empty region query string', async () => {
    const spy = jest.spyOn(explorer, 'listSecrets').mockResolvedValue([]);
    await request(appWith()).get('/api/secrets?region=');
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('returns 500 with the error message when listSecrets throws', async () => {
    jest.spyOn(explorer, 'listSecrets').mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).get('/api/secrets');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('returns 500 with Unknown error when a non-Error is thrown', async () => {
    jest.spyOn(explorer, 'listSecrets').mockRejectedValue('plain string');
    const res = await request(appWith()).get('/api/secrets');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });
});

describe('GET /api/secrets/:name', () => {
  it('describes a secret whose name contains a slash', async () => {
    const spy = jest.spyOn(explorer, 'describeSecret').mockResolvedValue({
      name: 'app/signing-key', tags: [], versionCount: 2, versionStages: {},
    } as never);
    const res = await request(appWith()).get(`/api/secrets/${encodeURIComponent('app/signing-key')}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('app/signing-key');
    expect(spy).toHaveBeenCalledWith('app/signing-key', undefined);
  });

  it('forwards the region', async () => {
    const spy = jest.spyOn(explorer, 'describeSecret').mockResolvedValue({ name: 'k', tags: [], versionCount: 0, versionStages: {} } as never);
    await request(appWith()).get('/api/secrets/k?region=us-west-2');
    expect(spy).toHaveBeenCalledWith('k', 'us-west-2');
  });

  it('rejects a name with path traversal', async () => {
    const spy = jest.spyOn(explorer, 'describeSecret');
    const res = await request(appWith()).get(`/api/secrets/${encodeURIComponent('../etc')}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid secret name');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a name with a backslash', async () => {
    const res = await request(appWith()).get(`/api/secrets/${encodeURIComponent('a\\b')}`);
    expect(res.status).toBe(400);
  });

  it('rejects a name with a control character', async () => {
    const res = await request(appWith()).get(`/api/secrets/${encodeURIComponent('a\u0001b')}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the secret is missing', async () => {
    jest.spyOn(explorer, 'describeSecret').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/secrets/ghost');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Secret not found' });
  });

  it('returns 500 when describeSecret throws', async () => {
    jest.spyOn(explorer, 'describeSecret').mockRejectedValue(new Error('kaboom'));
    const res = await request(appWith()).get('/api/secrets/k');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'kaboom' });
  });
});

describe('GET /api/secrets/:name/value', () => {
  it('reveals the secret value', async () => {
    const spy = jest.spyOn(explorer, 'getSecretValue').mockResolvedValue({
      name: 'k', versionStages: ['AWSCURRENT'], secretString: 's3cr3t',
    } as never);
    const res = await request(appWith()).get('/api/secrets/k/value?region=sa-east-1');
    expect(res.status).toBe(200);
    expect(res.body.secretString).toBe('s3cr3t');
    expect(spy).toHaveBeenCalledWith('k', 'sa-east-1');
  });

  it('rejects an invalid name before revealing', async () => {
    const spy = jest.spyOn(explorer, 'getSecretValue');
    // Encoded slash keeps ".." inside one path segment so it reaches the
    // handler (not normalized away by the HTTP client).
    const res = await request(appWith()).get(`/api/secrets/${encodeURIComponent('a/../b')}/value`);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 404 when the secret is missing', async () => {
    jest.spyOn(explorer, 'getSecretValue').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/secrets/ghost/value');
    expect(res.status).toBe(404);
  });

  it('returns 500 when getSecretValue throws', async () => {
    jest.spyOn(explorer, 'getSecretValue').mockRejectedValue(new Error('nope'));
    const res = await request(appWith()).get('/api/secrets/k/value');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'nope' });
  });
});
