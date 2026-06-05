// Unit test for the /api/buckets route. Mounts the router on a throwaway Express
// app and drives it with supertest; the S3Explorer singleton is stubbed.
import express from 'express';
import request from 'supertest';
import { bucketsRouter } from '../../../src/server/routes/buckets';
import { S3Explorer } from '../../../src/server/services/s3-explorer';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/buckets', bucketsRouter);
  return app;
}

const explorer = S3Explorer.getInstance();

afterEach(() => jest.restoreAllMocks());

describe('GET /api/buckets', () => {
  it('returns the bucket list', async () => {
    const buckets = [{ name: 'a', region: 'us-east-1' }];
    const spy = jest.spyOn(explorer, 'listBuckets').mockResolvedValue(buckets as never);
    const res = await request(appWith()).get('/api/buckets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(buckets);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('passes the region query through', async () => {
    const spy = jest.spyOn(explorer, 'listBuckets').mockResolvedValue([] as never);
    await request(appWith()).get('/api/buckets?region=eu-west-1');
    expect(spy).toHaveBeenCalledWith('eu-west-1');
  });

  it('returns 500 when the explorer throws', async () => {
    jest.spyOn(explorer, 'listBuckets').mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).get('/api/buckets');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('reports "Unknown error" for non-Error throwables', async () => {
    jest.spyOn(explorer, 'listBuckets').mockRejectedValue('plain string');
    const res = await request(appWith()).get('/api/buckets');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });

  it('ignores an empty region query param (treated as undefined)', async () => {
    const spy = jest.spyOn(explorer, 'listBuckets').mockResolvedValue([] as never);
    await request(appWith()).get('/api/buckets?region=');
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('ignores a non-string region query param (array)', async () => {
    const spy = jest.spyOn(explorer, 'listBuckets').mockResolvedValue([] as never);
    await request(appWith()).get('/api/buckets?region=a&region=b');
    expect(spy).toHaveBeenCalledWith(undefined);
  });
});

describe('GET /api/buckets/:name', () => {
  it('returns the bucket snapshot', async () => {
    const snap = { name: 'mybucket', region: 'us-east-1' };
    jest.spyOn(explorer, 'getBucket').mockResolvedValue(snap as never);
    const res = await request(appWith()).get('/api/buckets/mybucket');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(snap);
  });

  it('returns 404 when the bucket does not exist', async () => {
    jest.spyOn(explorer, 'getBucket').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/buckets/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Bucket not found' });
  });

  it('returns 400 for an invalid bucket name', async () => {
    const spy = jest.spyOn(explorer, 'getBucket');
    // A name longer than 63 chars fails validation but still routes to :name.
    const longName = 'a'.repeat(64);
    const res = await request(appWith()).get(`/api/buckets/${longName}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid bucket name' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 500 when the explorer throws', async () => {
    jest.spyOn(explorer, 'getBucket').mockRejectedValue(new Error('describe failed'));
    const res = await request(appWith()).get('/api/buckets/mybucket');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'describe failed' });
  });
});

describe('GET /api/buckets/:name/objects', () => {
  it('lists objects with no query params (defaults to undefined)', async () => {
    const result = { bucket: 'b', objects: [], commonPrefixes: [], isTruncated: false };
    const spy = jest.spyOn(explorer, 'listObjects').mockResolvedValue(result as never);
    const res = await request(appWith()).get('/api/buckets/b/objects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(spy).toHaveBeenCalledWith(
      'b',
      { prefix: undefined, continuationToken: undefined, maxKeys: undefined, delimiter: undefined },
      undefined,
    );
  });

  it('forwards all query params', async () => {
    const spy = jest
      .spyOn(explorer, 'listObjects')
      .mockResolvedValue({ bucket: 'b' } as never);
    await request(appWith()).get(
      '/api/buckets/b/objects?prefix=logs/&continuationToken=tok&delimiter=/&maxKeys=25&region=eu-west-1',
    );
    expect(spy).toHaveBeenCalledWith(
      'b',
      { prefix: 'logs/', continuationToken: 'tok', maxKeys: 25, delimiter: '/' },
      'eu-west-1',
    );
  });

  it('returns 400 for an invalid bucket name', async () => {
    const res = await request(appWith()).get('/api/buckets/..%2Fevil/objects');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid bucket name' });
  });

  it('returns 500 when the explorer throws', async () => {
    jest.spyOn(explorer, 'listObjects').mockRejectedValue(new Error('list failed'));
    const res = await request(appWith()).get('/api/buckets/b/objects');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'list failed' });
  });
});

describe('GET /api/buckets/:name/objects/content', () => {
  it('returns 400 for an invalid bucket name', async () => {
    const res = await request(appWith()).get('/api/buckets/..bad/objects/content?key=k');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid bucket name' });
  });

  it('returns 400 for a missing/invalid object key', async () => {
    const res = await request(appWith()).get('/api/buckets/b/objects/content');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid object key' });
  });

  it('returns 404 when the object does not exist', async () => {
    jest.spyOn(explorer, 'getObject').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/buckets/b/objects/content?key=missing.txt');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Object not found' });
  });

  it('streams inline content with content-type and length', async () => {
    jest.spyOn(explorer, 'getObject').mockResolvedValue({
      body: Buffer.from('hello world'),
      contentType: 'text/plain',
      size: 11,
    } as never);
    const res = await request(appWith()).get('/api/buckets/b/objects/content?key=note.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-length']).toBe('11');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.text).toBe('hello world');
  });

  it('omits Content-Type header when the object has none', async () => {
    jest.spyOn(explorer, 'getObject').mockResolvedValue({
      body: Buffer.from('raw'),
      size: 3,
    } as never);
    const res = await request(appWith()).get('/api/buckets/b/objects/content?key=raw.bin');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('3');
  });

  it('forces attachment disposition when download=1', async () => {
    jest.spyOn(explorer, 'getObject').mockResolvedValue({
      body: Buffer.from('data'),
      contentType: 'application/octet-stream',
      size: 4,
    } as never);
    const res = await request(appWith()).get(
      '/api/buckets/b/objects/content?key=dir/file.bin&download=1',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="file.bin"');
  });

  it('forces attachment disposition when download=true', async () => {
    jest.spyOn(explorer, 'getObject').mockResolvedValue({
      body: Buffer.from('data'),
      size: 4,
    } as never);
    const res = await request(appWith()).get(
      '/api/buckets/b/objects/content?key=file.bin&download=true',
    );
    expect(res.headers['content-disposition']).toBe('attachment; filename="file.bin"');
  });

  it('falls back to "download" filename when the key ends with a slash', async () => {
    jest.spyOn(explorer, 'getObject').mockResolvedValue({
      body: Buffer.alloc(0),
      size: 0,
    } as never);
    const res = await request(appWith()).get(
      '/api/buckets/b/objects/content?key=folder/&download=1',
    );
    expect(res.headers['content-disposition']).toBe('attachment; filename="download"');
  });

  it('returns 500 when the explorer throws', async () => {
    jest.spyOn(explorer, 'getObject').mockRejectedValue(new Error('get failed'));
    const res = await request(appWith()).get('/api/buckets/b/objects/content?key=k');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'get failed' });
  });
});

describe('POST /api/buckets/:name/objects', () => {
  it('uploads a plain string body', async () => {
    const spy = jest.spyOn(explorer, 'putObject').mockResolvedValue(undefined);
    const res = await request(appWith())
      .post('/api/buckets/b/objects')
      .send({ key: 'note.txt', body: 'hello', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith(
      'b',
      { key: 'note.txt', body: 'hello', contentType: 'text/plain' },
      undefined,
    );
  });

  it('decodes a base64-encoded body into a Buffer', async () => {
    const spy = jest.spyOn(explorer, 'putObject').mockResolvedValue(undefined);
    const encoded = Buffer.from('binary!').toString('base64');
    await request(appWith())
      .post('/api/buckets/b/objects?region=eu-west-1')
      .send({ key: 'file.bin', body: encoded, encoding: 'base64' });
    const callArg = spy.mock.calls[0][1];
    expect(Buffer.isBuffer(callArg.body)).toBe(true);
    expect((callArg.body as Buffer).toString()).toBe('binary!');
    expect(spy.mock.calls[0][2]).toBe('eu-west-1');
  });

  it('returns 400 for an invalid bucket name', async () => {
    const res = await request(appWith())
      .post('/api/buckets/..bad/objects')
      .send({ key: 'k', body: 'v' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid bucket name' });
  });

  it('returns 400 when key is missing/invalid', async () => {
    const res = await request(appWith())
      .post('/api/buckets/b/objects')
      .send({ body: 'v' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key (string) is required' });
  });

  it('returns 400 when body is not a string', async () => {
    const res = await request(appWith())
      .post('/api/buckets/b/objects')
      .send({ key: 'k', body: 123 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'body (string) is required' });
  });

  it('defaults to an empty object when req.body is undefined', async () => {
    // Mount the router WITHOUT express.json() so req.body is undefined,
    // exercising the `req.body ?? {}` fallback branch.
    const bareApp = express();
    bareApp.use('/api/buckets', bucketsRouter);
    const res = await request(bareApp).post('/api/buckets/b/objects');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'key (string) is required' });
  });

  it('returns 400 when the explorer throws', async () => {
    jest.spyOn(explorer, 'putObject').mockRejectedValue(new Error('put failed'));
    const res = await request(appWith())
      .post('/api/buckets/b/objects')
      .send({ key: 'k', body: 'v' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'put failed' });
  });
});

describe('DELETE /api/buckets/:name/objects', () => {
  it('deletes an object', async () => {
    const spy = jest.spyOn(explorer, 'deleteObject').mockResolvedValue(undefined);
    const res = await request(appWith()).delete('/api/buckets/b/objects?key=note.txt&region=eu-west-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith('b', 'note.txt', 'eu-west-1');
  });

  it('returns 400 for an invalid bucket name', async () => {
    const res = await request(appWith()).delete('/api/buckets/..bad/objects?key=k');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid bucket name' });
  });

  it('returns 400 for a missing/invalid object key', async () => {
    const res = await request(appWith()).delete('/api/buckets/b/objects');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid object key' });
  });

  it('returns 400 when the explorer throws', async () => {
    jest.spyOn(explorer, 'deleteObject').mockRejectedValue(new Error('delete failed'));
    const res = await request(appWith()).delete('/api/buckets/b/objects?key=k');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'delete failed' });
  });
});
