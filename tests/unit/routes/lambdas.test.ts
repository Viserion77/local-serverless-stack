// Unit test for the /api/lambdas route. Mounts the router on a throwaway
// Express app and drives it with supertest. FunctionRegistry and
// LambdaRuntimeManager are jest.mocked at the module level (the runtime
// manager forks worker processes and uses import.meta, so the real module
// cannot load under ts-jest).
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/server/services/function-registry', () => {
  const instance = { listFunctions: jest.fn(), resolve: jest.fn(), listServices: jest.fn() };
  return { FunctionRegistry: { getInstance: () => instance } };
});
jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { getRuntimeInfo: jest.fn(), getHistory: jest.fn(), invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import os from 'os';
import { lambdasRouter } from '../../../src/server/routes/lambdas';
import { ConfigManager } from '../../../src/server/services/config-manager';
import { InvocationActivity } from '../../../src/server/services/invocation-activity';
import { FunctionRegistry } from '../../../src/server/services/function-registry';
import { LambdaRuntimeManager } from '../../../src/server/services/lambda-runtime-manager';

const registry = FunctionRegistry.getInstance() as jest.Mocked<FunctionRegistry>;
const runtime = LambdaRuntimeManager.getInstance() as jest.Mocked<LambdaRuntimeManager>;

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/lambdas', lambdasRouter);
  return app;
}

// Same router WITHOUT a body parser so `req.body` is undefined and the
// `req.body || {}` fallback in POST /:name/invoke is exercised.
function appNoBodyParser() {
  const app = express();
  app.use('/api/lambdas', lambdasRouter);
  return app;
}

const REF = {
  service: {
    name: 'svc',
    root: '/abs/svc',
    invokePort: 13001,
    functions: [],
    routes: [
      { functionName: 'users', method: 'GET', path: '/users', eventType: 'http' as const, cors: false, authorizerName: 'auth' },
      { functionName: 'other', method: 'POST', path: '/other', eventType: 'httpApi' as const, cors: false },
    ],
    authorizers: [],
  },
  fn: {
    name: 'users',
    fullName: 'svc-dev-users',
    handler: 'src/users.handler',
    runtime: 'nodejs20.x',
    memorySize: 256,
    timeout: 10,
    environment: { TABLE: 'users' },
    triggers: ['http'],
  },
};

beforeEach(() => {
  registry.listFunctions.mockReset();
  registry.resolve.mockReset();
  registry.listServices.mockReset().mockReturnValue([]);
  runtime.getRuntimeInfo.mockReset();
  runtime.getHistory.mockReset();
  runtime.invoke.mockReset();

  runtime.getRuntimeInfo.mockReturnValue({ status: 'online', resolvedMode: 'source', invocations: 2, errors: 1 } as never);
  runtime.getHistory.mockReturnValue([
    { at: 100, functionName: 'users', ok: false, durationMs: 8, logs: ['err'] },
    { at: 200, functionName: 'users', ok: true, durationMs: 5, logs: ['ok'] },
  ]);
  registry.resolve.mockReturnValue(REF as never);
});

describe('GET /api/lambdas', () => {
  it('lists every registered function with runtime status and history stats', async () => {
    registry.listFunctions.mockReturnValue([REF] as never);
    const res = await request(appWith()).get('/api/lambdas');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        name: 'users',
        fullName: 'svc-dev-users',
        service: 'svc',
        handler: 'src/users.handler',
        runtime: 'nodejs20.x',
        memorySize: 256,
        timeout: 10,
        triggers: ['http'],
        invokePort: 13001,
        status: 'online',
        // The stubbed RuntimeInfo carries no `warm`, so the route reports the
        // conservative default: ready, but no worker forked yet.
        warm: false,
        executionMode: 'source',
        invocations: 2,
        errors: 1,
        lastInvokedAt: 200,
        lastDurationMs: 5,
        lastOk: true,
      },
    ]);
  });

  it('reports zero/undefined stats for a function that was never invoked', async () => {
    registry.listFunctions.mockReturnValue([REF] as never);
    runtime.getHistory.mockReturnValue([]);
    const res = await request(appWith()).get('/api/lambdas');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(
      expect.objectContaining({ invocations: 0, errors: 0 }),
    );
    expect(res.body[0].lastInvokedAt).toBeUndefined();
    expect(res.body[0].lastOk).toBeUndefined();
  });
});

describe('GET /api/lambdas/:name', () => {
  it('404s when the function is unknown', async () => {
    registry.resolve.mockReturnValue(undefined);
    const res = await request(appWith()).get('/api/lambdas/ghost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Function not found: ghost');
  });

  it('returns the detail including environment and only this function\'s routes', async () => {
    const res = await request(appWith()).get('/api/lambdas/users');
    expect(res.status).toBe(200);
    expect(registry.resolve).toHaveBeenCalledWith('users');
    expect(res.body.environment).toEqual({ TABLE: 'users' });
    expect(res.body.routes).toEqual([
      { method: 'GET', path: '/users', eventType: 'http', authorizerName: 'auth' },
    ]);
  });
});

describe('POST /api/lambdas/:name/invoke', () => {
  it('404s when the function is unknown', async () => {
    registry.resolve.mockReturnValue(undefined);
    const res = await request(appWith()).post('/api/lambdas/ghost/invoke').send({});
    expect(res.status).toBe(404);
  });

  it('invokes synchronously and returns payload/logs/duration on success', async () => {
    runtime.invoke.mockResolvedValue({ ok: true, payload: { hello: 'world' }, logs: ['line'], durationMs: 12 });
    const res = await request(appWith())
      .post('/api/lambdas/users/invoke')
      .send({ payload: { in: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, payload: { hello: 'world' }, logs: ['line'], durationMs: 12 });
    expect(runtime.invoke).toHaveBeenCalledWith('svc', REF.fn, { in: 1 });
  });

  it('maps a function error into functionError', async () => {
    runtime.invoke.mockResolvedValue({
      ok: false,
      errorType: 'TypeError',
      errorMessage: 'x is not a function',
      trace: ['at handler'],
      logs: [],
      durationMs: 3,
    });
    const res = await request(appWith()).post('/api/lambdas/users/invoke').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.functionError).toEqual({
      errorType: 'TypeError',
      errorMessage: 'x is not a function',
      trace: ['at handler'],
    });
  });

  it('accepts Event invocations with 202 without awaiting the result', async () => {
    runtime.invoke.mockResolvedValue({ ok: true, payload: null, logs: [], durationMs: 1 });
    const res = await request(appWith())
      .post('/api/lambdas/users/invoke')
      .send({ invocationType: 'Event', payload: { fire: true } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(runtime.invoke).toHaveBeenCalledWith('svc', REF.fn, { fire: true });
  });

  it('defaults the payload to {} for Event invocations without one', async () => {
    runtime.invoke.mockResolvedValue({ ok: true, payload: null, logs: [], durationMs: 1 });
    const res = await request(appWith())
      .post('/api/lambdas/users/invoke')
      .send({ invocationType: 'Event' });
    expect(res.status).toBe(202);
    expect(runtime.invoke).toHaveBeenCalledWith('svc', REF.fn, {});
  });

  it('defaults the whole body when no body parser ran (req.body undefined)', async () => {
    runtime.invoke.mockResolvedValue({ ok: true, payload: null, logs: [], durationMs: 1 });
    const res = await request(appNoBodyParser()).post('/api/lambdas/users/invoke');
    expect(res.status).toBe(200);
    expect(runtime.invoke).toHaveBeenCalledWith('svc', REF.fn, {});
  });

  it('500s when the invoke throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    runtime.invoke.mockRejectedValue(new Error('worker died'));
    const res = await request(appWith()).post('/api/lambdas/users/invoke').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to invoke function');
  });
});

describe('GET /api/lambdas/:name/logs', () => {
  it('404s when the function is unknown', async () => {
    registry.resolve.mockReturnValue(undefined);
    const res = await request(appWith()).get('/api/lambdas/ghost/logs');
    expect(res.status).toBe(404);
  });

  it('returns the invocation history', async () => {
    const res = await request(appWith()).get('/api/lambdas/users/logs');
    expect(res.status).toBe(200);
    expect(res.body.invocations).toHaveLength(2);
    expect(runtime.getHistory).toHaveBeenCalledWith('svc', 'users');
  });
});

// The Overview activity panel's data source. Its job is honesty about load:
// which workers are resident, what ran, how much overlapped, and what that
// costs the host — so a "why is my laptop hot?" question has an answer.
describe('GET /api/lambdas/activity', () => {
  beforeEach(() => {
    InvocationActivity.getInstance().reset();
    const cm = ConfigManager.getInstance();
    jest.spyOn(cm, 'getLambdaMaxWarmWorkers').mockReturnValue(4);
    jest.spyOn(cm, 'isLambdaRuntimeLazy').mockReturnValue(true);
    jest.spyOn(cm, 'getLambdaIdleTimeoutMs').mockReturnValue(60000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports an idle stack without pretending anything ran', async () => {
    const res = await request(appWith()).get('/api/lambdas/activity');
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([]);
    expect(res.body.totals).toMatchObject({ invocations: 0, peakConcurrency: 0, activeNow: 0 });
    expect(res.body.workers).toEqual([]);
    expect(res.body.residency).toEqual({
      warm: 0, maxWarmWorkers: 4, lazy: true, idleTimeoutMs: 60000,
    });
  });

  it('lists one row per service — a worker is a process, not a function', async () => {
    registry.listServices.mockReturnValue([
      { name: 'orders', functions: [{ name: 'a' }, { name: 'b' }] },
      { name: 'billing', functions: [] },
    ] as never);
    runtime.getRuntimeInfo
      .mockReturnValueOnce({ status: 'online', warm: true, pid: 42, startedAt: 10, lastInvokedAt: 20, invocations: 3, errors: 1, resolvedMode: 'source' } as never)
      .mockReturnValueOnce({ status: 'online', warm: false, invocations: 0, errors: 0 } as never);

    const res = await request(appWith()).get('/api/lambdas/activity');
    expect(res.body.workers).toEqual([
      { service: 'orders', status: 'online', warm: true, pid: 42, startedAt: 10, lastInvokedAt: 20, invocations: 3, errors: 1, functions: 2, executionMode: 'source' },
      { service: 'billing', status: 'online', warm: false, invocations: 0, errors: 0, functions: 0 },
    ]);
    // Only the forked one counts against the residency cap.
    expect(res.body.residency.warm).toBe(1);
  });

  // `warm` only exists on a RuntimeInfo once a worker process has been forked;
  // for a service that was registered but never invoked the flag is simply
  // absent. The row must then read "cold" instead of leaking `undefined` into
  // the panel, and must not be counted against the warm-worker cap.
  it('reads a RuntimeInfo without a warm flag as cold', async () => {
    registry.listServices.mockReturnValue([
      { name: 'orders', functions: [{ name: 'a' }] },
    ] as never);
    // The suite-wide stub deliberately carries no `warm` key.

    const res = await request(appWith()).get('/api/lambdas/activity');
    expect(res.body.workers).toEqual([
      { service: 'orders', status: 'online', warm: false, invocations: 2, errors: 1, functions: 1, executionMode: 'source' },
    ]);
    expect(res.body.residency.warm).toBe(0);
  });

  it('surfaces recorded spans and the parallelism between them', async () => {
    const now = Date.now();
    const activity = InvocationActivity.getInstance();
    activity.record({ service: 'orders', functionName: 'a', startedAt: now - 400, durationMs: 300, ok: true, coldStart: true });
    activity.record({ service: 'billing', functionName: 'b', startedAt: now - 350, durationMs: 200, ok: false, coldStart: false });

    const res = await request(appWith()).get('/api/lambdas/activity');
    expect(res.body.spans).toHaveLength(2);
    expect(res.body.totals).toMatchObject({ invocations: 2, errors: 1, coldStarts: 1, peakConcurrency: 2 });
  });

  it('honours windowMs/buckets and ignores garbage query values', async () => {
    let res = await request(appWith()).get('/api/lambdas/activity?windowMs=30000&buckets=10');
    expect(res.body.windowMs).toBe(30000);
    expect(res.body.buckets).toHaveLength(10);

    res = await request(appWith()).get('/api/lambdas/activity?windowMs=abc&buckets=');
    expect(res.body.windowMs).toBe(120000);
    expect(res.body.buckets).toHaveLength(60);
  });

  it('reports host pressure, so the numbers can be read against the machine', async () => {
    jest.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 ** 3);
    jest.spyOn(os, 'freemem').mockReturnValue(4 * 1024 ** 3);
    jest.spyOn(os, 'cpus').mockReturnValue([{}, {}, {}, {}] as never);
    jest.spyOn(os, 'loadavg').mockReturnValue([1.5, 1, 0.5]);

    const res = await request(appWith()).get('/api/lambdas/activity');
    expect(res.body.host).toMatchObject({
      totalMemBytes: 16 * 1024 ** 3,
      freeMemBytes: 4 * 1024 ** 3,
      cpuCount: 4,
      loadAvg1m: 1.5,
    });
    expect(res.body.host.rssBytes).toBeGreaterThan(0);
    expect(res.body.host.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});
