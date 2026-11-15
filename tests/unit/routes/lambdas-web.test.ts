// /api/lambdas/web — the Lambda Web Functions routes: list, detail, restart and
// the request proxy the MCP tool drives. The manager and gateway singletons are
// real, their state is stubbed per test; the request route talks to a real
// local HTTP server standing in for the endpoint listener.
import express from 'express';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({}) },
}));

import { lambdasRouter } from '../../../src/server/routes/lambdas';
import * as bindHost from '../../../src/server/services/bind-host';
import { WebFunctionManager } from '../../../src/server/services/web-function-manager';
import { WebFunctionGateway } from '../../../src/server/services/web-function-gateway';
import type { RegisteredWebFunction } from '../../../src/server/services/web-function-assembler';

const manager = WebFunctionManager.getInstance();
const gateway = WebFunctionGateway.getInstance();
const SERVICE = { name: 'orders', root: '/abs/orders', region: 'us-east-1' };

function fn(port?: number): RegisteredWebFunction {
  return {
    service: 'orders',
    name: 'orders-web',
    logicalId: 'OrdersWeb',
    arn: 'arn:fn',
    revisions: [{
      logicalId: 'Rev', revisionId: 'r1', arn: 'arn:rev', runtime: 'nodejs24.x', environment: { A: '1' },
      timeoutSeconds: 3, maxConcurrency: 8, code: { source: 'source', reason: 'test', root: '/abs/orders', entry: 'index.js' },
    }],
    endpoints: [
      { logicalId: 'Beta', name: 'beta', arn: 'arn:beta', authType: 'IamAuth', endpointType: 'HomeRegion', weights: [] },
      { logicalId: 'Live', name: 'live', arn: 'arn:live', authType: 'ApplicationManaged', endpointType: 'HomeRegion', weights: [{ revisionId: 'r1', weight: 100 }], port },
    ],
    warnings: ['a finding'],
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/lambdas', lambdasRouter);
  return a;
}

let server: http.Server | undefined;
let seen: http.IncomingMessage | undefined;
let seenBody = '';

async function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  await new Promise<void>(resolve => (server as http.Server).listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  jest.restoreAllMocks();
  if (server) await new Promise<void>(resolve => (server as http.Server).close(() => resolve()));
  server = undefined;
});

describe('GET /api/lambdas/web', () => {
  it('lists web functions with URLs, listener and environment state', async () => {
    jest.spyOn(manager, 'listFunctions').mockReturnValue([{ service: SERVICE, fn: fn(15000) }]);
    jest.spyOn(manager, 'functionState').mockReturnValue('ready');
    jest.spyOn(manager, 'getTotals').mockReturnValue({ requests: 3, errors: 1, lastRequestAt: 42 });
    jest.spyOn(manager, 'revisionStatus').mockReturnValue({ revisionId: 'r1', state: 'ready', inFlight: 1, queued: 0, pid: 7 });
    jest.spyOn(gateway, 'getListenerStatus').mockReturnValue('online');
    const res = await request(app()).get('/api/lambdas/web');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({
      service: 'orders',
      name: 'orders-web',
      state: 'ready',
      requests: 3,
      errors: 1,
      lastRequestAt: 42,
      warnings: ['a finding'],
    })]);
    expect(res.body[0].endpoints[1]).toMatchObject({ port: 15000, domainName: 'localhost:15000', url: 'http://localhost:15000', listener: 'online' });
    expect(res.body[0].endpoints[0].url).toBeUndefined();
    expect(res.body[0].revisions[0]).toMatchObject({ revisionId: 'r1', state: 'ready', pid: 7, code: { source: 'source' } });
  });
});

describe('GET /api/lambdas/web/:service/:name', () => {
  it('returns detail with environment, recent requests (newest first) and logs', async () => {
    jest.spyOn(manager, 'listFunctions').mockReturnValue([{ service: SERVICE, fn: fn(15000) }]);
    jest.spyOn(manager, 'getRequests').mockReturnValue([
      { at: 1, method: 'GET', path: '/a', status: 200, durationMs: 1, requestId: 'a', endpoint: 'live', coldStart: true },
      { at: 2, method: 'GET', path: '/b', status: 200, durationMs: 1, requestId: 'b', endpoint: 'live', coldStart: false },
    ]);
    jest.spyOn(manager, 'getLogs').mockReturnValue([{ at: 1, stream: 'stdout', revisionId: 'r1', text: 'hi' }]);
    const res = await request(app()).get('/api/lambdas/web/orders/orders-web');
    expect(res.status).toBe(200);
    expect(res.body.environment).toEqual({ r1: { A: '1' } });
    expect(res.body.recentRequests.map((r: { requestId: string }) => r.requestId)).toEqual(['b', 'a']);
    expect(res.body.logs).toHaveLength(1);
  });

  it('404s an unknown function on every route', async () => {
    jest.spyOn(manager, 'listFunctions').mockReturnValue([{ service: SERVICE, fn: fn() }]);
    jest.spyOn(manager, 'restartFunction').mockResolvedValue(false);
    expect((await request(app()).get('/api/lambdas/web/orders/nope')).status).toBe(404);
    expect((await request(app()).get('/api/lambdas/web/billing/orders-web')).status).toBe(404);
    expect((await request(app()).post('/api/lambdas/web/orders/nope/restart')).status).toBe(404);
    expect((await request(app()).post('/api/lambdas/web/orders/nope/request').send({})).status).toBe(404);
  });
});

describe('POST /api/lambdas/web/:service/:name/restart', () => {
  it('restarts the function environments', async () => {
    const restart = jest.spyOn(manager, 'restartFunction').mockResolvedValue(true);
    const res = await request(app()).post('/api/lambdas/web/orders/orders-web/restart');
    expect(res.body).toEqual({ restarted: true });
    expect(restart).toHaveBeenCalledWith('orders', 'orders-web');
  });
});

describe('POST /api/lambdas/web/:service/:name/request', () => {
  it('sends the request through the endpoint and returns what came back', async () => {
    const port = await listen((req, res) => {
      seen = req;
      seenBody = '';
      req.on('data', chunk => { seenBody += chunk; });
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'text/plain', 'lambda-web-request-id': 'rid' });
        res.end(req.url === '/big' ? 'x'.repeat(70 * 1024) : 'ok');
      });
    });
    jest.spyOn(manager, 'listFunctions').mockReturnValue([{ service: SERVICE, fn: fn(port) }]);

    const res = await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({
      method: 'post', path: 'items?x=1', headers: { 'x-test': 1 }, body: { a: 1 }, revision: 'r1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 201, body: 'ok', truncated: false, headers: { 'lambda-web-request-id': 'rid' } });
    expect(res.body.durationMs).toEqual(expect.any(Number));
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('/items?x=1');
    expect(seen?.headers).toMatchObject({ 'x-test': '1', 'x-lss-web-revision': 'r1' });
    expect(seenBody).toBe('{"a":1}');

    const text = await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({ method: 'PUT', path: '/t', body: 'raw', endpoint: 'live' });
    expect(text.body.status).toBe(201);
    expect(seenBody).toBe('raw');

    const get = await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({ path: '/big', body: 'ignored' });
    expect(get.body).toMatchObject({ truncated: true });
    expect(get.body.body).toHaveLength(64 * 1024);
    expect(seen?.method).toBe('GET');

    const bare = await request(app()).post('/api/lambdas/web/orders/orders-web/request');
    expect(bare.body.status).toBe(201);
    expect(seen?.url).toBe('/');
  });

  it('reaches the listener through the bind host, or the loopback for a wildcard bind', async () => {
    const port = await listen((_req, res) => res.end('ok'));
    jest.spyOn(manager, 'listFunctions').mockReturnValue([{ service: SERVICE, fn: fn(port) }]);
    for (const wildcard of ['0.0.0.0', '::']) {
      jest.spyOn(bindHost, 'getBindHost').mockReturnValue(wildcard);
      expect((await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({})).body.body).toBe('ok');
    }
    jest.spyOn(bindHost, 'getBindHost').mockReturnValue('::1');
    const v6 = await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({});
    expect([200, 502]).toContain(v6.status);
  });

  it('404s an endpoint without a port and 502s an unreachable one', async () => {
    jest.spyOn(manager, 'listFunctions').mockReturnValue([{ service: SERVICE, fn: fn(1) }]);
    const unserved = await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({ endpoint: 'beta' });
    expect(unserved.status).toBe(404);
    expect(unserved.body.error).toContain('"beta"');
    const failed = await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({});
    expect(failed.status).toBe(502);
    jest.spyOn(manager, 'listFunctions').mockReturnValue([{ service: SERVICE, fn: { ...fn(), endpoints: [] } }]);
    const none = await request(app()).post('/api/lambdas/web/orders/orders-web/request').send({});
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('No served endpoint on orders-web');
  });
});
