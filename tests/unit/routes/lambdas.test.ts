// Unit test for the /api/lambdas route. Mounts the router on a throwaway
// Express app and drives it with supertest. FunctionRegistry and
// LambdaRuntimeManager are jest.mocked at the module level (the runtime
// manager forks worker processes and uses import.meta, so the real module
// cannot load under ts-jest).
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/server/services/function-registry', () => {
  const instance = { listFunctions: jest.fn(), resolve: jest.fn() };
  return { FunctionRegistry: { getInstance: () => instance } };
});
jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { getRuntimeInfo: jest.fn(), getHistory: jest.fn(), invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { lambdasRouter } from '../../../src/server/routes/lambdas';
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
