// Unit test for the /api/opensearch route. Mounts the router on a throwaway
// Express app and drives it with supertest; the OpenSearchExplorer singleton
// is stubbed.
import express from 'express';
import request from 'supertest';
import { opensearchRouter } from '../../../src/server/routes/opensearch';
import {
  OpenSearchExplorer,
  OpenSearchDataPlaneError,
} from '../../../src/server/services/opensearch-explorer';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/opensearch', opensearchRouter);
  return app;
}

const explorer = OpenSearchExplorer.getInstance();

afterEach(() => jest.restoreAllMocks());

describe('GET /api/opensearch/collections', () => {
  it('returns the collection list', async () => {
    const collections = [{ name: 'products', endpoint: 'http://localhost:14567/_aoss/products' }];
    const spy = jest.spyOn(explorer, 'listCollections').mockResolvedValue(collections);
    const res = await request(appWith()).get('/api/opensearch/collections');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ collections });
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('passes the region query through', async () => {
    const spy = jest.spyOn(explorer, 'listCollections').mockResolvedValue([]);
    await request(appWith()).get('/api/opensearch/collections?region=eu-west-1');
    expect(spy).toHaveBeenCalledWith('eu-west-1');
  });

  it('ignores an empty region query param (treated as undefined)', async () => {
    const spy = jest.spyOn(explorer, 'listCollections').mockResolvedValue([]);
    await request(appWith()).get('/api/opensearch/collections?region=');
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('ignores a non-string region query param (array)', async () => {
    const spy = jest.spyOn(explorer, 'listCollections').mockResolvedValue([]);
    await request(appWith()).get('/api/opensearch/collections?region=a&region=b');
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('returns 500 when the explorer throws', async () => {
    jest.spyOn(explorer, 'listCollections').mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).get('/api/opensearch/collections');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('reports "Unknown error" for non-Error throwables', async () => {
    jest.spyOn(explorer, 'listCollections').mockRejectedValue('plain string');
    const res = await request(appWith()).get('/api/opensearch/collections');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });
});

describe('GET /api/opensearch/collections/:name/indices', () => {
  it('returns the index list', async () => {
    const indices = [{ index: 'products-v1', docsCount: 42, health: 'green', status: 'open' }];
    const spy = jest.spyOn(explorer, 'listIndices').mockResolvedValue(indices);
    const res = await request(appWith()).get('/api/opensearch/collections/products/indices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ indices });
    expect(spy).toHaveBeenCalledWith('products', undefined);
  });

  it('passes the region query through', async () => {
    const spy = jest.spyOn(explorer, 'listIndices').mockResolvedValue([]);
    await request(appWith()).get('/api/opensearch/collections/products/indices?region=eu-west-1');
    expect(spy).toHaveBeenCalledWith('products', 'eu-west-1');
  });

  it('returns 400 for an invalid collection name', async () => {
    const spy = jest.spyOn(explorer, 'listIndices');
    const res = await request(appWith()).get('/api/opensearch/collections/..bad/indices');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid collection name' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes a data-plane 404 (collection_not_found_exception) through as 404', async () => {
    jest
      .spyOn(explorer, 'listIndices')
      .mockRejectedValue(new OpenSearchDataPlaneError(404, 'Collection ghost does not exist'));
    const res = await request(appWith()).get('/api/opensearch/collections/ghost/indices');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Collection ghost does not exist' });
  });

  it('maps a data-plane 5xx to 502', async () => {
    jest
      .spyOn(explorer, 'listIndices')
      .mockRejectedValue(new OpenSearchDataPlaneError(503, 'data plane unavailable'));
    const res = await request(appWith()).get('/api/opensearch/collections/products/indices');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'data plane unavailable' });
  });

  it('returns 500 when the explorer throws a plain error', async () => {
    jest.spyOn(explorer, 'listIndices').mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).get('/api/opensearch/collections/products/indices');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });
});

describe('POST /api/opensearch/collections/:name/search', () => {
  it('forwards the search input and returns the raw response verbatim', async () => {
    const raw = {
      took: 0,
      hits: { total: { value: 1 }, hits: [{ _index: 'products-v1', _id: '1', _source: { a: 1 } }] },
    };
    const spy = jest.spyOn(explorer, 'search').mockResolvedValue(raw);
    const res = await request(appWith())
      .post('/api/opensearch/collections/products/search?region=eu-west-1')
      .send({ index: 'products-v1', query: { match_all: {} }, from: 2, size: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(raw);
    expect(spy).toHaveBeenCalledWith(
      'products',
      { index: 'products-v1', query: { match_all: {} }, from: 2, size: 5 },
      'eu-west-1',
    );
  });

  it('forwards the q shorthand', async () => {
    const spy = jest.spyOn(explorer, 'search').mockResolvedValue({ hits: { hits: [] } });
    await request(appWith())
      .post('/api/opensearch/collections/products/search')
      .send({ q: 'title:hello' });
    expect(spy).toHaveBeenCalledWith('products', { q: 'title:hello' }, undefined);
  });

  it('defaults to an empty input when req.body is undefined', async () => {
    // Mount the router WITHOUT express.json() so req.body is undefined,
    // exercising the `req.body ?? {}` fallback branch.
    const spy = jest.spyOn(explorer, 'search').mockResolvedValue({ hits: { hits: [] } });
    const bareApp = express();
    bareApp.use('/api/opensearch', opensearchRouter);
    const res = await request(bareApp).post('/api/opensearch/collections/products/search');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('products', {}, undefined);
  });

  it('returns 400 for an invalid collection name', async () => {
    const spy = jest.spyOn(explorer, 'search');
    const res = await request(appWith())
      .post(`/api/opensearch/collections/${'a'.repeat(33)}/search`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid collection name' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes a data-plane 400 (bad query DSL) through as 400', async () => {
    jest
      .spyOn(explorer, 'search')
      .mockRejectedValue(new OpenSearchDataPlaneError(400, 'unsupported query: [foo]'));
    const res = await request(appWith())
      .post('/api/opensearch/collections/products/search')
      .send({ query: { foo: {} } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported query: [foo]' });
  });

  it('passes a data-plane 404 through as 404', async () => {
    jest
      .spyOn(explorer, 'search')
      .mockRejectedValue(new OpenSearchDataPlaneError(404, 'Collection ghost does not exist'));
    const res = await request(appWith())
      .post('/api/opensearch/collections/ghost/search')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Collection ghost does not exist' });
  });

  it('returns 500 when the explorer throws a plain error', async () => {
    jest.spyOn(explorer, 'search').mockRejectedValue(new Error('boom'));
    const res = await request(appWith())
      .post('/api/opensearch/collections/products/search')
      .send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('reports "Unknown error" for non-Error throwables', async () => {
    jest.spyOn(explorer, 'search').mockRejectedValue('plain string');
    const res = await request(appWith())
      .post('/api/opensearch/collections/products/search')
      .send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });
});
