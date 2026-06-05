// Unit test for the /api/seeds route. Mounts the router on a throwaway Express
// app and drives it with supertest; the SeedManager + ConfigManager singletons
// are stubbed so no DynamoDB/Docker calls are made.
import express from 'express';
import request from 'supertest';
import { seedsRouter } from '../../../src/server/routes/seeds';
import { SeedManager } from '../../../src/server/services/seed-manager';
import { ConfigManager } from '../../../src/server/services/config-manager';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/seeds', seedsRouter);
  return app;
}

// Same router but WITHOUT the JSON body parser. express.json() always assigns
// req.body = {} (even for an empty/non-JSON request), so the only way to leave
// req.body === undefined — and thus exercise the `req.body ?? {}` fallback — is
// to mount the router with no body parser at all.
function appNoBodyParser() {
  const app = express();
  app.use('/api/seeds', seedsRouter);
  return app;
}

const sm = SeedManager.getInstance();

afterEach(() => jest.restoreAllMocks());

describe('GET /api/seeds', () => {
  it('returns the seeds dir, entries and live tables', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getSeedsDir').mockReturnValue('/abs/seeds');
    const entries = [
      { tableName: 'Users', file: '/abs/seeds/Users.json', itemCount: 3, tableExists: true },
    ];
    const listSpy = jest.spyOn(sm, 'list').mockResolvedValue(entries);
    const liveSpy = jest.spyOn(sm, 'listLiveTables').mockResolvedValue(['Users', 'Orders']);

    const res = await request(appWith()).get('/api/seeds?region=eu-west-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      seedsDir: '/abs/seeds',
      entries,
      liveTables: ['Users', 'Orders'],
    });
    // region querystring is forwarded to the manager.
    expect(listSpy).toHaveBeenCalledWith('eu-west-1');
    expect(liveSpy).toHaveBeenCalledWith('eu-west-1');
  });

  it('treats an empty region querystring as undefined', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getSeedsDir').mockReturnValue('/abs/seeds');
    const listSpy = jest.spyOn(sm, 'list').mockResolvedValue([]);
    jest.spyOn(sm, 'listLiveTables').mockResolvedValue([]);

    const res = await request(appWith()).get('/api/seeds?region=');

    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith(undefined);
  });

  it('returns 500 with the error message when listing fails', async () => {
    jest.spyOn(sm, 'list').mockRejectedValue(new Error('boom'));
    jest.spyOn(sm, 'listLiveTables').mockResolvedValue([]);

    const res = await request(appWith()).get('/api/seeds');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('returns 500 with a fallback message for non-Error throws', async () => {
    jest.spyOn(sm, 'list').mockRejectedValue('nope');
    jest.spyOn(sm, 'listLiveTables').mockResolvedValue([]);

    const res = await request(appWith()).get('/api/seeds');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to list seeds' });
  });
});

describe('POST /api/seeds/run', () => {
  it('seeds a single table when tableName is provided', async () => {
    const result = { tableName: 'Users', inserted: 3 };
    const seedSpy = jest.spyOn(sm, 'seedTable').mockResolvedValue(result);

    const res = await request(appWith())
      .post('/api/seeds/run?region=us-east-2')
      .send({ tableName: 'Users' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [result] });
    expect(seedSpy).toHaveBeenCalledWith('Users', 'us-east-2');
  });

  it('seeds all tables when no tableName is provided', async () => {
    const results = [{ tableName: 'Users', inserted: 1 }];
    const allSpy = jest.spyOn(sm, 'seedAll').mockResolvedValue(results);

    const res = await request(appWith()).post('/api/seeds/run').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results });
    expect(allSpy).toHaveBeenCalledWith(undefined);
  });

  it('seeds all tables when req.body is undefined (no body parser)', async () => {
    const allSpy = jest.spyOn(sm, 'seedAll').mockResolvedValue([]);

    const res = await request(appNoBodyParser()).post('/api/seeds/run');

    expect(res.status).toBe(200);
    expect(allSpy).toHaveBeenCalled();
  });

  it('rejects an invalid tableName with 400', async () => {
    const res = await request(appWith())
      .post('/api/seeds/run')
      .send({ tableName: '../etc/passwd' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid tableName' });
  });

  it('returns 500 with the error message when seeding fails', async () => {
    jest.spyOn(sm, 'seedAll').mockRejectedValue(new Error('seed failed'));

    const res = await request(appWith()).post('/api/seeds/run').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'seed failed' });
  });

  it('returns 500 with a fallback message for non-Error throws', async () => {
    jest.spyOn(sm, 'seedAll').mockRejectedValue('nope');

    const res = await request(appWith()).post('/api/seeds/run').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to run seeds' });
  });
});

describe('POST /api/seeds/clear', () => {
  it('clears a single table when tableName is provided', async () => {
    const result = { tableName: 'Users', deleted: 2 };
    const clearSpy = jest.spyOn(sm, 'clearTable').mockResolvedValue(result);

    const res = await request(appWith())
      .post('/api/seeds/clear?region=us-west-1')
      .send({ tableName: 'Users' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [result] });
    expect(clearSpy).toHaveBeenCalledWith('Users', 'us-west-1');
  });

  it('clears all seeded tables when no tableName is provided', async () => {
    const results = [{ tableName: 'Users', deleted: 5 }];
    const allSpy = jest.spyOn(sm, 'clearAllSeeded').mockResolvedValue(results);

    const res = await request(appWith()).post('/api/seeds/clear').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results });
    expect(allSpy).toHaveBeenCalledWith(undefined);
  });

  it('clears all seeded tables when req.body is undefined (no body parser)', async () => {
    const allSpy = jest.spyOn(sm, 'clearAllSeeded').mockResolvedValue([]);

    const res = await request(appNoBodyParser()).post('/api/seeds/clear');

    expect(res.status).toBe(200);
    expect(allSpy).toHaveBeenCalled();
  });

  it('rejects an invalid tableName with 400', async () => {
    const res = await request(appWith())
      .post('/api/seeds/clear')
      .send({ tableName: 'bad/name' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid tableName' });
  });

  it('returns 500 with the error message when clearing fails', async () => {
    jest.spyOn(sm, 'clearAllSeeded').mockRejectedValue(new Error('clear failed'));

    const res = await request(appWith()).post('/api/seeds/clear').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'clear failed' });
  });

  it('returns 500 with a fallback message for non-Error throws', async () => {
    jest.spyOn(sm, 'clearAllSeeded').mockRejectedValue('nope');

    const res = await request(appWith()).post('/api/seeds/clear').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to clear seeds' });
  });
});
