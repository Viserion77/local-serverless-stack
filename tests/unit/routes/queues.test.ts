// Unit test for the /api/queues route. Mounts the router on a throwaway Express
// app and drives it with supertest; the QueueInspector singleton is stubbed so
// no AWS/Docker calls happen. Covers every route, validation 400s, the
// not-found/conflict paths, and the fail() 500 catch.
import express from 'express';
import request from 'supertest';
import { queuesRouter } from '../../../src/server/routes/queues';
import { QueueInspector } from '../../../src/server/services/queue-inspector';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/queues', queuesRouter);
  return app;
}

// App without a body parser, so `req.body` is `undefined` and the `?? {}`
// fallbacks in the route handlers are exercised.
function appNoParser() {
  const app = express();
  app.use('/api/queues', queuesRouter);
  return app;
}

const inspector = QueueInspector.getInstance();

afterEach(() => jest.restoreAllMocks());

describe('GET /api/queues', () => {
  it('returns the queue list', async () => {
    const spy = jest.spyOn(inspector, 'listQueues').mockResolvedValue([{ name: 'q1' }] as never);
    const res = await request(appWith()).get('/api/queues?region=us-east-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'q1' }]);
    expect(spy).toHaveBeenCalledWith('us-east-1');
  });

  it('passes undefined region when none/empty supplied', async () => {
    const spy = jest.spyOn(inspector, 'listQueues').mockResolvedValue([] as never);
    await request(appWith()).get('/api/queues?region=');
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('returns 500 when the inspector throws', async () => {
    jest.spyOn(inspector, 'listQueues').mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).get('/api/queues');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });

  it('reports "Unknown error" when a non-Error is thrown', async () => {
    jest.spyOn(inspector, 'listQueues').mockRejectedValue('nope' as never);
    const res = await request(appWith()).get('/api/queues');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unknown error' });
  });
});

describe('GET /api/queues/:name', () => {
  it('returns the queue snapshot', async () => {
    jest.spyOn(inspector, 'getQueue').mockResolvedValue({ name: 'q1' } as never);
    const res = await request(appWith()).get('/api/queues/q1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'q1' });
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith()).get('/api/queues/' + encodeURIComponent('a..b'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid queue name' });
  });

  it('404 when not found', async () => {
    jest.spyOn(inspector, 'getQueue').mockResolvedValue(undefined as never);
    const res = await request(appWith()).get('/api/queues/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Queue not found' });
  });

  it('500 when inspector throws', async () => {
    jest.spyOn(inspector, 'getQueue').mockRejectedValue(new Error('kaboom'));
    const res = await request(appWith()).get('/api/queues/q1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'kaboom' });
  });
});

describe('POST /api/queues/:name/reset-processed', () => {
  it('resets the processed count', async () => {
    const spy = jest.spyOn(inspector, 'resetProcessedCount').mockImplementation(() => {});
    const res = await request(appWith()).post('/api/queues/q1/reset-processed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith('q1');
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith()).post('/api/queues/' + encodeURIComponent('a\\b') + '/reset-processed');
    expect(res.status).toBe(400);
  });

  it('500 when inspector throws', async () => {
    jest.spyOn(inspector, 'resetProcessedCount').mockImplementation(() => {
      throw new Error('reset fail');
    });
    const res = await request(appWith()).post('/api/queues/q1/reset-processed');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'reset fail' });
  });
});

describe('POST /api/queues/:name/await-idle', () => {
  it('200 when drained', async () => {
    const spy = jest.spyOn(inspector, 'awaitIdle').mockResolvedValue({
      available: 0,
      inFlight: 0,
      processed: 5,
      drained: true,
    } as never);
    const res = await request(appWith())
      .post('/api/queues/q1/await-idle')
      .send({ timeoutMs: 1000, sinceProcessed: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queue: 'q1', drained: true, processed: 5 });
    expect(spy).toHaveBeenCalledWith('q1', { timeoutMs: 1000, sinceProcessed: 1 }, undefined);
  });

  it('408 when not drained (timeout)', async () => {
    jest.spyOn(inspector, 'awaitIdle').mockResolvedValue({
      available: 2,
      inFlight: 1,
      processed: 0,
      drained: false,
    } as never);
    const res = await request(appWith()).post('/api/queues/q1/await-idle').send({});
    expect(res.status).toBe(408);
    expect(res.body).toMatchObject({ drained: false });
  });

  it('uses default clamped timeout when body is empty', async () => {
    const spy = jest.spyOn(inspector, 'awaitIdle').mockResolvedValue({
      available: 0,
      inFlight: 0,
      processed: 0,
      drained: true,
    } as never);
    await request(appWith()).post('/api/queues/q1/await-idle');
    expect(spy).toHaveBeenCalledWith('q1', { timeoutMs: 15000, sinceProcessed: undefined }, undefined);
  });

  it('404 when queue not found', async () => {
    jest.spyOn(inspector, 'awaitIdle').mockResolvedValue(undefined as never);
    const res = await request(appWith()).post('/api/queues/q1/await-idle').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Queue not found' });
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith())
      .post('/api/queues/' + encodeURIComponent('a..b') + '/await-idle')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid queue name' });
  });

  it('400 on invalid timeoutMs (not a number)', async () => {
    const res = await request(appWith()).post('/api/queues/q1/await-idle').send({ timeoutMs: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'timeoutMs must be a number' });
  });

  it('400 on non-finite timeoutMs', async () => {
    const res = await request(appWith())
      .post('/api/queues/q1/await-idle')
      .send({ timeoutMs: Number.POSITIVE_INFINITY });
    // JSON.stringify turns Infinity into null, so this exercises the typeof guard too.
    expect(res.status).toBe(400);
  });

  it('400 on invalid sinceProcessed (negative)', async () => {
    const res = await request(appWith())
      .post('/api/queues/q1/await-idle')
      .send({ sinceProcessed: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'sinceProcessed must be a non-negative integer' });
  });

  it('400 on invalid sinceProcessed (non-integer)', async () => {
    const res = await request(appWith())
      .post('/api/queues/q1/await-idle')
      .send({ sinceProcessed: 1.5 });
    expect(res.status).toBe(400);
  });

  it('500 when inspector throws', async () => {
    jest.spyOn(inspector, 'awaitIdle').mockRejectedValue(new Error('idle fail'));
    const res = await request(appWith()).post('/api/queues/q1/await-idle').send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'idle fail' });
  });

  it('falls back to {} when no body parser is mounted', async () => {
    const spy = jest.spyOn(inspector, 'awaitIdle').mockResolvedValue({
      available: 0,
      inFlight: 0,
      processed: 0,
      drained: true,
    } as never);
    const res = await request(appNoParser()).post('/api/queues/q1/await-idle');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('q1', { timeoutMs: 15000, sinceProcessed: undefined }, undefined);
  });
});

describe('POST /api/queues/:name/hold', () => {
  it('returns the hold result', async () => {
    jest.spyOn(inspector, 'holdQueue').mockResolvedValue({ held: true } as never);
    const res = await request(appWith()).post('/api/queues/q1/hold');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ held: true });
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith()).post('/api/queues/' + encodeURIComponent('a..b') + '/hold');
    expect(res.status).toBe(400);
  });

  it('404 when queue not found', async () => {
    jest.spyOn(inspector, 'holdQueue').mockResolvedValue(undefined as never);
    const res = await request(appWith()).post('/api/queues/q1/hold');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Queue not found' });
  });

  it('500 when inspector throws', async () => {
    jest.spyOn(inspector, 'holdQueue').mockRejectedValue(new Error('hold fail'));
    const res = await request(appWith()).post('/api/queues/q1/hold');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/queues/:name/captured', () => {
  it('returns captured messages', async () => {
    jest.spyOn(inspector, 'getCaptured').mockResolvedValue([{ body: 'm' }] as never);
    const res = await request(appWith()).get('/api/queues/q1/captured');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ body: 'm' }]);
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith()).get('/api/queues/' + encodeURIComponent('a..b') + '/captured');
    expect(res.status).toBe(400);
  });

  it('409 when the queue is not held', async () => {
    jest.spyOn(inspector, 'getCaptured').mockResolvedValue(undefined as never);
    const res = await request(appWith()).get('/api/queues/q1/captured');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Queue is not held' });
  });

  it('500 when inspector throws', async () => {
    jest.spyOn(inspector, 'getCaptured').mockRejectedValue(new Error('cap fail'));
    const res = await request(appWith()).get('/api/queues/q1/captured');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/queues/:name/release', () => {
  it('returns the release result', async () => {
    jest.spyOn(inspector, 'releaseQueue').mockResolvedValue({ released: true } as never);
    const res = await request(appWith()).post('/api/queues/q1/release');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ released: true });
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith()).post('/api/queues/' + encodeURIComponent('a..b') + '/release');
    expect(res.status).toBe(400);
  });

  it('409 when the queue is not held', async () => {
    jest.spyOn(inspector, 'releaseQueue').mockResolvedValue(undefined as never);
    const res = await request(appWith()).post('/api/queues/q1/release');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Queue is not held' });
  });

  it('500 when inspector throws', async () => {
    jest.spyOn(inspector, 'releaseQueue').mockRejectedValue(new Error('rel fail'));
    const res = await request(appWith()).post('/api/queues/q1/release');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/queues/:name/messages', () => {
  it('sends a message', async () => {
    const spy = jest.spyOn(inspector, 'sendMessage').mockResolvedValue({ messageId: 'id' } as never);
    const res = await request(appWith())
      .post('/api/queues/q1/messages')
      .send({ body: 'hello', delaySeconds: 5, messageGroupId: 'g', messageDeduplicationId: 'd' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: 'id' });
    expect(spy).toHaveBeenCalledWith(
      'q1',
      {
        body: 'hello',
        delaySeconds: 5,
        messageAttributes: undefined,
        messageGroupId: 'g',
        messageDeduplicationId: 'd',
      },
      undefined,
    );
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith())
      .post('/api/queues/' + encodeURIComponent('a..b') + '/messages')
      .send({ body: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid queue name' });
  });

  it('400 when body missing/empty', async () => {
    const res = await request(appWith()).post('/api/queues/q1/messages').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'body (string) is required' });
  });

  it('400 on invalid delaySeconds (too large)', async () => {
    const res = await request(appWith())
      .post('/api/queues/q1/messages')
      .send({ body: 'x', delaySeconds: 901 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'delaySeconds must be between 0 and 900' });
  });

  it('400 on invalid delaySeconds (negative)', async () => {
    const res = await request(appWith())
      .post('/api/queues/q1/messages')
      .send({ body: 'x', delaySeconds: -1 });
    expect(res.status).toBe(400);
  });

  it('400 on invalid delaySeconds (not a number)', async () => {
    const res = await request(appWith())
      .post('/api/queues/q1/messages')
      .send({ body: 'x', delaySeconds: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 when sendMessage throws', async () => {
    jest.spyOn(inspector, 'sendMessage').mockRejectedValue(new Error('send fail'));
    const res = await request(appWith()).post('/api/queues/q1/messages').send({ body: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'send fail' });
  });

  it('falls back to {} (400 body required) when no body parser is mounted', async () => {
    const res = await request(appNoParser()).post('/api/queues/q1/messages');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'body (string) is required' });
  });
});

describe('POST /api/queues/:name/messages/receive', () => {
  it('receives messages', async () => {
    const spy = jest.spyOn(inspector, 'receiveMessages').mockResolvedValue([{ body: 'm' }] as never);
    const res = await request(appWith())
      .post('/api/queues/q1/messages/receive')
      .send({ maxNumberOfMessages: 3, visibilityTimeout: 10, waitTimeSeconds: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [{ body: 'm' }] });
    expect(spy).toHaveBeenCalledWith(
      'q1',
      { maxNumberOfMessages: 3, visibilityTimeout: 10, waitTimeSeconds: 0 },
      undefined,
    );
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith()).post(
      '/api/queues/' + encodeURIComponent('a..b') + '/messages/receive',
    );
    expect(res.status).toBe(400);
  });

  it('400 when receiveMessages throws', async () => {
    jest.spyOn(inspector, 'receiveMessages').mockRejectedValue(new Error('recv fail'));
    const res = await request(appWith()).post('/api/queues/q1/messages/receive').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'recv fail' });
  });

  it('falls back to {} when no body parser is mounted', async () => {
    const spy = jest.spyOn(inspector, 'receiveMessages').mockResolvedValue([] as never);
    const res = await request(appNoParser()).post('/api/queues/q1/messages/receive');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      'q1',
      { maxNumberOfMessages: undefined, visibilityTimeout: undefined, waitTimeSeconds: undefined },
      undefined,
    );
  });
});

describe('POST /api/queues/:name/messages/delete', () => {
  it('deletes a message', async () => {
    const spy = jest.spyOn(inspector, 'deleteMessage').mockResolvedValue(undefined as never);
    const res = await request(appWith())
      .post('/api/queues/q1/messages/delete')
      .send({ receiptHandle: 'rh' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith('q1', 'rh', undefined);
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith())
      .post('/api/queues/' + encodeURIComponent('a..b') + '/messages/delete')
      .send({ receiptHandle: 'rh' });
    expect(res.status).toBe(400);
  });

  it('400 when receiptHandle missing', async () => {
    const res = await request(appWith()).post('/api/queues/q1/messages/delete').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'receiptHandle (string) is required' });
  });

  it('400 when deleteMessage throws', async () => {
    jest.spyOn(inspector, 'deleteMessage').mockRejectedValue(new Error('del fail'));
    const res = await request(appWith())
      .post('/api/queues/q1/messages/delete')
      .send({ receiptHandle: 'rh' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'del fail' });
  });

  it('falls back to {} (400 receiptHandle required) when no body parser is mounted', async () => {
    const res = await request(appNoParser()).post('/api/queues/q1/messages/delete');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'receiptHandle (string) is required' });
  });
});

describe('POST /api/queues/:name/purge', () => {
  it('purges the queue', async () => {
    const spy = jest.spyOn(inspector, 'purgeQueue').mockResolvedValue(undefined as never);
    const res = await request(appWith()).post('/api/queues/q1/purge');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith('q1', undefined);
  });

  it('400 on invalid queue name', async () => {
    const res = await request(appWith()).post('/api/queues/' + encodeURIComponent('a..b') + '/purge');
    expect(res.status).toBe(400);
  });

  it('400 when purgeQueue throws', async () => {
    jest.spyOn(inspector, 'purgeQueue').mockRejectedValue(new Error('purge fail'));
    const res = await request(appWith()).post('/api/queues/q1/purge');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'purge fail' });
  });
});
