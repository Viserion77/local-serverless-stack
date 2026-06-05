// Unit test for the /api/dynamo route. Mounts the router on a throwaway Express
// app and drives it with supertest; the DynamoExplorer singleton is stubbed.
import express from 'express';
import request from 'supertest';
import { dynamoRouter } from '../../../src/server/routes/dynamo';
import { DynamoExplorer } from '../../../src/server/services/dynamo-explorer';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/dynamo', dynamoRouter);
  return app;
}

// An app that does NOT parse the JSON body, so `req.body` is left undefined.
// This exercises the defensive `req.body ?? {}` fallback branches that an app
// using express.json() can never reach (that middleware always sets `{}`).
function appNoBody() {
  const app = express();
  app.use('/api/dynamo', dynamoRouter);
  return app;
}

const explorer = DynamoExplorer.getInstance();

afterEach(() => jest.restoreAllMocks());

describe('GET /api/dynamo/tables', () => {
  it('returns the list of tables (default region)', async () => {
    const spy = jest.spyOn(explorer, 'listTables').mockResolvedValue([
      { name: 'users', itemCount: 0, sizeBytes: 0 } as never,
    ]);
    const res = await request(appWith()).get('/api/dynamo/tables');
    expect(res.status).toBe(200);
    expect(res.body.tables).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('forwards the region query string', async () => {
    const spy = jest.spyOn(explorer, 'listTables').mockResolvedValue([]);
    const res = await request(appWith()).get('/api/dynamo/tables?region=eu-west-1');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('eu-west-1');
  });

  it('ignores a non-string region query (array)', async () => {
    const spy = jest.spyOn(explorer, 'listTables').mockResolvedValue([]);
    const res = await request(appWith()).get('/api/dynamo/tables?region=a&region=b');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('ignores an empty region query string', async () => {
    const spy = jest.spyOn(explorer, 'listTables').mockResolvedValue([]);
    const res = await request(appWith()).get('/api/dynamo/tables?region=');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('returns 500 with the error message when listTables throws', async () => {
    jest.spyOn(explorer, 'listTables').mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).get('/api/dynamo/tables');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('returns 500 with Unknown error when a non-Error is thrown', async () => {
    jest.spyOn(explorer, 'listTables').mockRejectedValue('plain string');
    const res = await request(appWith()).get('/api/dynamo/tables');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });
});

describe('GET /api/dynamo/tables/:name', () => {
  it('returns the table detail', async () => {
    const spy = jest
      .spyOn(explorer, 'describeTable')
      .mockResolvedValue({ name: 'users' } as never);
    const res = await request(appWith()).get('/api/dynamo/tables/users?region=us-east-2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'users' });
    expect(spy).toHaveBeenCalledWith('users', 'us-east-2');
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith()).get('/api/dynamo/tables/bad..name');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 404 when the table is not found', async () => {
    jest.spyOn(explorer, 'describeTable').mockResolvedValue(undefined as never);
    const res = await request(appWith()).get('/api/dynamo/tables/users');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Table not found' });
  });

  it('returns 500 when describeTable throws', async () => {
    jest.spyOn(explorer, 'describeTable').mockRejectedValue(new Error('describe failed'));
    const res = await request(appWith()).get('/api/dynamo/tables/users');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'describe failed' });
  });
});

describe('GET /api/dynamo/tables/:name/ttl', () => {
  it('returns the ttl info', async () => {
    jest.spyOn(explorer, 'describeTtl').mockResolvedValue({ enabled: true } as never);
    const res = await request(appWith()).get('/api/dynamo/tables/users/ttl');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith()).get('/api/dynamo/tables/bad%2Fname/ttl');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 500 when describeTtl throws', async () => {
    jest.spyOn(explorer, 'describeTtl').mockRejectedValue(new Error('ttl failed'));
    const res = await request(appWith()).get('/api/dynamo/tables/users/ttl');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'ttl failed' });
  });
});

describe('PUT /api/dynamo/tables/:name/ttl', () => {
  it('sets the ttl', async () => {
    const spy = jest.spyOn(explorer, 'setTtl').mockResolvedValue({ enabled: true } as never);
    const res = await request(appWith())
      .put('/api/dynamo/tables/users/ttl')
      .send({ enabled: true, attributeName: 'expiresAt' });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('users', true, 'expiresAt', undefined);
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith())
      .put('/api/dynamo/tables/bad%5Cname/ttl')
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 400 when enabled is not a boolean', async () => {
    const res = await request(appWith())
      .put('/api/dynamo/tables/users/ttl')
      .send({ attributeName: 'expiresAt' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'enabled (boolean) is required' });
  });

  it('returns 400 when setTtl throws', async () => {
    jest.spyOn(explorer, 'setTtl').mockRejectedValue(new Error('set ttl failed'));
    const res = await request(appWith())
      .put('/api/dynamo/tables/users/ttl')
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'set ttl failed' });
  });
});

describe('POST /api/dynamo/tables/:name/scan', () => {
  it('scans the table with the supplied input', async () => {
    const spy = jest
      .spyOn(explorer, 'scan')
      .mockResolvedValue({ items: [], count: 0 } as never);
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/scan')
      .send({ limit: 10 });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('users', { limit: 10 }, undefined);
  });

  it('defaults the body to an empty object when none is provided', async () => {
    const spy = jest
      .spyOn(explorer, 'scan')
      .mockResolvedValue({ items: [], count: 0 } as never);
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/scan')
      .set('Content-Type', 'application/json')
      .send('');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('users', {}, undefined);
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith()).post('/api/dynamo/tables/bad..name/scan').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 400 when scan throws', async () => {
    jest.spyOn(explorer, 'scan').mockRejectedValue(new Error('scan failed'));
    const res = await request(appWith()).post('/api/dynamo/tables/users/scan').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'scan failed' });
  });
});

describe('POST /api/dynamo/tables/:name/query', () => {
  it('queries the table with the supplied input', async () => {
    const spy = jest
      .spyOn(explorer, 'query')
      .mockResolvedValue({ items: [], count: 0 } as never);
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/query')
      .send({ keyConditionExpression: 'id = :id' });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('users', { keyConditionExpression: 'id = :id' }, undefined);
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith()).post('/api/dynamo/tables/..%2F/query').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 400 when query throws', async () => {
    jest.spyOn(explorer, 'query').mockRejectedValue(new Error('query failed'));
    const res = await request(appWith()).post('/api/dynamo/tables/users/query').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'query failed' });
  });
});

describe('POST /api/dynamo/tables/:name/items/get', () => {
  it('returns the item', async () => {
    const spy = jest.spyOn(explorer, 'getItem').mockResolvedValue({ id: '1' } as never);
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/get')
      .send({ key: { id: '1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ item: { id: '1' } });
    expect(spy).toHaveBeenCalledWith('users', { id: '1' }, undefined);
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/..%2Fx/items/get')
      .send({ key: { id: '1' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 400 when key is missing', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/get')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key is required' });
  });

  it('returns 400 when key is not an object', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/get')
      .send({ key: 'not-an-object' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key is required' });
  });

  it('returns 500 when getItem throws', async () => {
    jest.spyOn(explorer, 'getItem').mockRejectedValue(new Error('get failed'));
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/get')
      .send({ key: { id: '1' } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'get failed' });
  });
});

describe('POST /api/dynamo/tables/:name/items', () => {
  it('puts the item', async () => {
    const spy = jest.spyOn(explorer, 'putItem').mockResolvedValue(undefined as never);
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items')
      .send({ item: { id: '1', name: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith('users', { id: '1', name: 'x' }, undefined);
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/..%2F/items')
      .send({ item: { id: '1' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 400 when item is missing', async () => {
    const res = await request(appWith()).post('/api/dynamo/tables/users/items').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'item must be a plain object' });
  });

  it('returns 400 when item is not an object', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items')
      .send({ item: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'item must be a plain object' });
  });

  it('returns 400 when item is an array', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items')
      .send({ item: [1, 2, 3] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'item must be a plain object' });
  });

  it('returns 400 when putItem throws', async () => {
    jest.spyOn(explorer, 'putItem').mockRejectedValue(new Error('put failed'));
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items')
      .send({ item: { id: '1' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'put failed' });
  });
});

describe('POST /api/dynamo/tables/:name/items/delete', () => {
  it('deletes the item', async () => {
    const spy = jest.spyOn(explorer, 'deleteItem').mockResolvedValue(undefined as never);
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/delete')
      .send({ key: { id: '1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith('users', { id: '1' }, undefined);
  });

  it('returns 400 for an invalid table name', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/..%2Fx/items/delete')
      .send({ key: { id: '1' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid table name' });
  });

  it('returns 400 when key is missing', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/delete')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key is required' });
  });

  it('returns 400 when key is not an object', async () => {
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/delete')
      .send({ key: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key is required' });
  });

  it('returns 400 when deleteItem throws', async () => {
    jest.spyOn(explorer, 'deleteItem').mockRejectedValue(new Error('delete failed'));
    const res = await request(appWith())
      .post('/api/dynamo/tables/users/items/delete')
      .send({ key: { id: '1' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'delete failed' });
  });
});

// These cover the defensive `req.body ?? {}` fallback branches, which require
// `req.body` to be undefined (i.e. no body-parsing middleware).
describe('defensive req.body ?? {} fallbacks (no body parser)', () => {
  it('PUT ttl: treats an absent body as {} (enabled is undefined -> 400)', async () => {
    const res = await request(appNoBody()).put('/api/dynamo/tables/users/ttl');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'enabled (boolean) is required' });
  });

  it('scan: treats an absent body as {} and forwards it', async () => {
    const spy = jest
      .spyOn(explorer, 'scan')
      .mockResolvedValue({ items: [], count: 0 } as never);
    const res = await request(appNoBody()).post('/api/dynamo/tables/users/scan');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('users', {}, undefined);
  });

  it('query: treats an absent body as {} and forwards it', async () => {
    const spy = jest
      .spyOn(explorer, 'query')
      .mockResolvedValue({ items: [], count: 0 } as never);
    const res = await request(appNoBody()).post('/api/dynamo/tables/users/query');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('users', {}, undefined);
  });

  it('items/get: treats an absent body as {} (key is undefined -> 400)', async () => {
    const res = await request(appNoBody()).post('/api/dynamo/tables/users/items/get');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key is required' });
  });

  it('items: treats an absent body as {} (item is undefined -> 400)', async () => {
    const res = await request(appNoBody()).post('/api/dynamo/tables/users/items');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'item must be a plain object' });
  });

  it('items/delete: treats an absent body as {} (key is undefined -> 400)', async () => {
    const res = await request(appNoBody()).post('/api/dynamo/tables/users/items/delete');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key is required' });
  });
});
