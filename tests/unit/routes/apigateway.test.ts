// Unit test for the /api/apigateway route. Mounts the router on a throwaway
// Express app and drives it with supertest; the ApiGatewayExplorer singleton
// is stubbed. Covers region forwarding, key-id validation on the reveal path,
// 404s and error mapping.
import express from 'express';
import request from 'supertest';
import { apiGatewayRouter } from '../../../src/server/routes/apigateway';
import { ApiGatewayExplorer } from '../../../src/server/services/apigateway-explorer';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/apigateway', apiGatewayRouter);
  return app;
}

const explorer = ApiGatewayExplorer.getInstance();

afterEach(() => jest.restoreAllMocks());

describe('GET /api/apigateway/keys', () => {
  it('returns the keys (default region)', async () => {
    const spy = jest.spyOn(explorer, 'listApiKeys').mockResolvedValue([
      { id: 'k1', name: 'acme-partner', enabled: true, stageKeys: [], tags: {}, usagePlans: [] },
    ]);
    const res = await request(appWith()).get('/api/apigateway/keys');
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].value).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('forwards the region query string', async () => {
    const spy = jest.spyOn(explorer, 'listApiKeys').mockResolvedValue([]);
    await request(appWith()).get('/api/apigateway/keys?region=eu-west-1');
    expect(spy).toHaveBeenCalledWith('eu-west-1');
  });

  it('ignores a non-string or empty region query', async () => {
    const spy = jest.spyOn(explorer, 'listApiKeys').mockResolvedValue([]);
    await request(appWith()).get('/api/apigateway/keys?region=a&region=b');
    await request(appWith()).get('/api/apigateway/keys?region=');
    expect(spy).toHaveBeenNthCalledWith(1, undefined);
    expect(spy).toHaveBeenNthCalledWith(2, undefined);
  });

  it('returns 500 with the error message when listing throws', async () => {
    jest.spyOn(explorer, 'listApiKeys').mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).get('/api/apigateway/keys');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('returns 500 with Unknown error when a non-Error is thrown', async () => {
    jest.spyOn(explorer, 'listApiKeys').mockRejectedValue('plain string');
    const res = await request(appWith()).get('/api/apigateway/keys');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });
});

describe('GET /api/apigateway/keys/:id/value', () => {
  it('reveals the value', async () => {
    const spy = jest.spyOn(explorer, 'getApiKeyValue').mockResolvedValue({
      id: 'k1', name: 'acme-partner', value: 'abcdefghijklmnopqrstuvwxyz',
    });
    const res = await request(appWith()).get('/api/apigateway/keys/k1/value?region=sa-east-1');
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(spy).toHaveBeenCalledWith('k1', 'sa-east-1');
  });

  it('rejects an invalid id before revealing', async () => {
    const spy = jest.spyOn(explorer, 'getApiKeyValue');
    const res = await request(appWith()).get(`/api/apigateway/keys/${encodeURIComponent('a/../b')}/value`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid API key id');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 404 when the key is missing', async () => {
    jest.spyOn(explorer, 'getApiKeyValue').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/apigateway/keys/ghost/value');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'API key not found' });
  });

  it('returns 500 when the reveal throws', async () => {
    jest.spyOn(explorer, 'getApiKeyValue').mockRejectedValue(new Error('nope'));
    const res = await request(appWith()).get('/api/apigateway/keys/k1/value');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'nope' });
  });
});

describe('GET /api/apigateway/plans', () => {
  it('returns the usage plans with the region forwarded', async () => {
    const spy = jest.spyOn(explorer, 'listUsagePlans').mockResolvedValue([
      { id: 'p1', name: 'partners', apiStages: [{ apiId: 'orders-api', stage: 'dev' }], tags: {}, keyCount: 2 },
    ]);
    const res = await request(appWith()).get('/api/apigateway/plans?region=us-west-2');
    expect(res.status).toBe(200);
    expect(res.body.plans[0].keyCount).toBe(2);
    expect(spy).toHaveBeenCalledWith('us-west-2');
  });

  it('returns 500 when listing throws', async () => {
    jest.spyOn(explorer, 'listUsagePlans').mockRejectedValue(new Error('down'));
    const res = await request(appWith()).get('/api/apigateway/plans');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'down' });
  });
});
