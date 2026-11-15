// web-function-gateway.ts — the per-endpoint front door, over real HTTP and a
// real app process: request id echo, x-forwarded-*, IamAuth, revision pin and
// weights, streaming (SSE chunks arrive before the response ends), timeout 504
// vs mid-stream cut, 503 on a crash, LSS-labelled error bodies, the listener
// lifecycle (port conflict + rebind) and the request/activity records.
import path from 'path';
import http from 'http';
import net from 'net';
import { ConfigManager } from '../../../src/server/services/config-manager';
import { InvocationActivity } from '../../../src/server/services/invocation-activity';
import { WebFunctionManager, WebFunctionError, type WebLease } from '../../../src/server/services/web-function-manager';
import {
  WebFunctionGateway,
  iamAuthFailure,
  forwardedHeaders,
  sendLssError,
  REQUEST_ID_HEADER,
  ERROR_TYPE_HEADER,
} from '../../../src/server/services/web-function-gateway';
import type { RegisteredWebFunction, WebRevision } from '../../../src/server/services/web-function-assembler';

jest.setTimeout(30000);

const FIXTURES = path.join(__dirname, '../../fixtures/runtime/web');
const SERVICE = { name: 'orders', root: FIXTURES, region: 'us-east-1' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const SIGNED = 'AWS4-HMAC-SHA256 Credential=AKID/20261115/us-east-1/lambda/aws4_request, SignedHeaders=host, Signature=abc';

function revision(id: string, over: Partial<WebRevision> = {}, entry = 'app.js'): WebRevision {
  return {
    logicalId: `Rev${id}`,
    revisionId: id,
    arn: `arn:${id}`,
    runtime: 'nodejs24.x',
    environment: { RELEASE: id },
    timeoutSeconds: 5,
    maxConcurrency: 8,
    code: { source: 'source', reason: 'test', root: FIXTURES, entry },
    ...over,
  };
}

function fn(name: string, port: number, revisions: WebRevision[], authType: 'ApplicationManaged' | 'IamAuth' = 'ApplicationManaged', weights = revisions.map(r => ({ revisionId: r.revisionId, weight: 1 }))): RegisteredWebFunction {
  return {
    service: SERVICE.name,
    name,
    logicalId: name,
    arn: `arn:${name}`,
    revisions,
    endpoints: [{ logicalId: `${name}Ep`, name: 'live', arn: `arn:${name}/endpoint/live`, authType, endpointType: 'HomeRegion', weights, port }],
    warnings: [],
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }

function call(port: number, urlPath = '/', options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: options.method ?? 'GET', headers: options.headers, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode as number, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const config = ConfigManager.getInstance();
let manager: WebFunctionManager;
let gateway: WebFunctionGateway;

beforeEach(() => {
  jest.spyOn(config, 'getLambdaIdleTimeoutMs').mockReturnValue(0);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  manager = new WebFunctionManager({ readinessTimeoutMs: 400, readinessPollMs: 20, drainTimeoutMs: 100, echo: false, nativeTypeScript: false });
  gateway = new WebFunctionGateway(manager);
  gateway.rebindIntervalMs = 50;
  InvocationActivity.getInstance().reset();
});

afterEach(async () => {
  await gateway.stopAll();
  await manager.stopAll();
  jest.restoreAllMocks();
});

async function serve(fns: RegisteredWebFunction[]): Promise<void> {
  await manager.syncService(SERVICE, fns);
  await gateway.syncService(SERVICE.name, fns);
}

describe('WebFunctionGateway — proxying', () => {
  it('forwards with a request id and x-forwarded-*, and echoes the id back', async () => {
    const port = await freePort();
    await serve([fn('web', port, [revision('r1')])]);
    expect(gateway.getListenerStatus('orders', 'web', 'live')).toBe('online');
    const answer = await call(port, '/echo?x=1', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-forwarded-for': '10.0.0.9', 'x-lss-web-revision': 'r1', authorization: 'Bearer app-token' },
      body: 'payload',
    });
    expect(answer.status).toBe(201);
    expect(answer.headers['x-app']).toBe('echo');
    const echoed = JSON.parse(answer.body);
    expect(echoed).toMatchObject({ method: 'POST', url: '/echo?x=1', body: 'payload' });
    expect(echoed.headers[REQUEST_ID_HEADER]).toBe(answer.headers[REQUEST_ID_HEADER]);
    expect(answer.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(echoed.headers).toMatchObject({
      'x-forwarded-for': '10.0.0.9, 127.0.0.1',
      'x-forwarded-host': `127.0.0.1:${port}`,
      'x-forwarded-proto': 'https',
      authorization: 'Bearer app-token',
    });
    expect(echoed.headers['x-lss-web-revision']).toBeUndefined();

    await sleep(50);
    const [record] = manager.getRequests('orders', 'web');
    expect(record).toMatchObject({ method: 'POST', path: '/echo?x=1', status: 201, revisionId: 'r1', endpoint: 'live', coldStart: true });
    expect(InvocationActivity.getInstance().snapshot().spans[0]).toMatchObject({ service: 'orders', functionName: 'web', ok: true, coldStart: true });
  });

  it('streams Server-Sent Events as they are written', async () => {
    const port = await freePort();
    await serve([fn('web', port, [revision('r1')])]);
    await call(port, '/');
    const arrivals: number[] = [];
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/stream', agent: false }, res => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        let text = '';
        res.on('data', chunk => { arrivals.push(Date.now()); text += chunk; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body.match(/^data: /gm)).toHaveLength(3);
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    // Spread over ~300 ms: nothing was buffered until the end.
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(200);
  });

  it('pins a revision by header and splits by weight otherwise', async () => {
    const port = await freePort();
    await serve([fn('web', port, [revision('stable'), revision('canary')], 'ApplicationManaged', [{ revisionId: 'stable', weight: 100 }, { revisionId: 'canary', weight: 0 }])]);
    expect((await call(port, '/')).body).toBe('hello from stable');
    expect((await call(port, '/', { headers: { 'x-lss-web-revision': 'canary' } })).body).toBe('hello from canary');
    expect((await call(port, '/', { headers: { 'x-lss-web-revision': 'Revcanary' } })).body).toBe('hello from canary');
    const unknown = await call(port, '/', { headers: { 'x-lss-web-revision': 'nope' } });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body)).toMatchObject({ source: 'lss', message: expect.stringContaining('stable (Revstable)') });
    expect(unknown.headers[ERROR_TYPE_HEADER]).toBeUndefined();
  });

  it('answers 409 for a function with no revision and 404 once the function is gone', async () => {
    const port = await freePort();
    const empty = fn('web', port, []);
    await serve([empty]);
    const none = await call(port, '/', { headers: { 'x-lss-web-revision': '' } });
    expect(none.status).toBe(409);
    expect(none.headers[ERROR_TYPE_HEADER]).toBe('Platform.RevisionNotActive');
    const pinned = await call(port, '/', { headers: { 'x-lss-web-revision': 'x' } });
    expect(JSON.parse(pinned.body).message).toContain('known: none');
    await manager.removeService('orders');
    const gone = await call(port, '/');
    expect(gone.status).toBe(404);
    expect(gone.headers[ERROR_TYPE_HEADER]).toBe('Platform.InvalidEndpoint');
  });

  it('answers 502 with the init error type when the app cannot start', async () => {
    const port = await freePort();
    await serve([fn('web', port, [revision('never', {}, 'never-listens.js')])]);
    const answer = await call(port, '/');
    expect(answer.status).toBe(502);
    expect(answer.headers[ERROR_TYPE_HEADER]).toBe('Application.TimeoutListenError');
    expect(JSON.parse(answer.body)).toMatchObject({ source: 'lss', errorType: 'Application.TimeoutListenError', note: expect.stringContaining('not by your application') });
    await sleep(30);
    expect(manager.getRequests('orders', 'web')[0]).toMatchObject({ status: 502, errorType: 'Application.TimeoutListenError' });
  });

  it('times out: 504 before the response head, a cut connection after it', async () => {
    const port = await freePort();
    await serve([fn('web', port, [revision('r1', { timeoutSeconds: 1 })])]);
    const slow = await call(port, '/sleep?ms=3000');
    expect(slow.status).toBe(504);
    expect(slow.headers[ERROR_TYPE_HEADER]).toBe('Runtime.RequestTimeout');
    expect(slow.headers[REQUEST_ID_HEADER]).toBeDefined();
    await expect(call(port, '/head-then-hang')).rejects.toThrow();
  });

  it('answers 503 when the app dies mid-request, and cuts a stream that breaks', async () => {
    const port = await freePort();
    await serve([fn('web', port, [revision('r1')])]);
    const reset = await call(port, '/reset');
    expect(reset.status).toBe(503);
    expect(reset.headers[ERROR_TYPE_HEADER]).toBe('Runtime.OriginRequestError');
    await expect(call(port, '/head-then-reset')).rejects.toThrow();
    const crash = await call(port, '/crash');
    expect(crash.status).toBe(503);
    // The next request starts a new environment.
    await sleep(100);
    expect((await call(port, '/')).status).toBe(200);
  });

  it('maps a refused upstream to Runtime.Unreachable and a failed acquire to its error', async () => {
    const port = await freePort();
    const deadPort = await freePort();
    const def = fn('web', port, [revision('r1')]);
    const released: string[] = [];
    const fake = {
      getFunction: () => def,
      recordRequest: jest.fn(),
      acquire: jest.fn(async (): Promise<WebLease> => ({ host: '127.0.0.1', port: deadPort, revision: def.revisions[0], coldStart: false, release: () => released.push('x') })),
    };
    const local = new WebFunctionGateway(fake as unknown as WebFunctionManager);
    await local.syncService('orders', [def]);
    const refused = await call(port, '/');
    expect(refused.status).toBe(503);
    expect(refused.headers[ERROR_TYPE_HEADER]).toBe('Runtime.Unreachable');
    fake.acquire.mockRejectedValueOnce(new WebFunctionError(429, 'Platform.EndpointMaxEnvThrottle', 'full'));
    const full = await call(port, '/');
    expect(full.status).toBe(429);
    await sleep(20);
    expect(released).toEqual(['x']);
    await local.stopAll();
  });

  it('records a client that hangs up during a cold start as 499 and stops waiting', async () => {
    const port = await freePort();
    await manager.syncService(SERVICE, [fn('web', port, [revision('late', { environment: { LATE_MS: '300' } }, 'late-listener.js')])]);
    const slowStart = new WebFunctionManager({ readinessTimeoutMs: 3000, readinessPollMs: 20, drainTimeoutMs: 100, echo: false });
    const def = fn('web', port, [revision('late', { environment: { LATE_MS: '300' } }, 'late-listener.js')]);
    await slowStart.syncService(SERVICE, [def]);
    const local = new WebFunctionGateway(slowStart);
    await local.syncService('orders', [def]);
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false });
    req.on('error', () => undefined);
    await sleep(50);
    req.destroy();
    await sleep(500);
    expect(slowStart.getRequests('orders', 'web')[0]).toMatchObject({ status: 499 });
    // And a client that hangs up mid-response stops the upstream request.
    const mid = http.get({ host: '127.0.0.1', port, path: '/', agent: false });
    mid.on('error', () => undefined);
    await sleep(5);
    mid.destroy();
    await sleep(100);
    await manager.stopAll();
    const sleeper = fn('sleepy', port, [revision('s1')]);
    await manager.syncService(SERVICE, [sleeper]);
    await local.stopAll();
    const viaApp = new WebFunctionGateway(manager);
    await viaApp.syncService('orders', [sleeper]);
    await call(port, '/');
    const pending = http.get({ host: '127.0.0.1', port, path: '/sleep?ms=400', agent: false });
    pending.on('error', () => undefined);
    await sleep(100);
    pending.destroy();
    await sleep(100);
    expect(manager.getRequests('orders', 'sleepy')[1]).toMatchObject({ status: 499 });
    await viaApp.stopAll();
    await local.stopAll();
    await slowStart.stopAll();
  });
});

describe('WebFunctionGateway — IamAuth', () => {
  it('requires a SigV4 request for service lambda with a content hash, and strips the Authorization', async () => {
    const port = await freePort();
    await serve([fn('web', port, [revision('r1')], 'IamAuth')]);
    const unsigned = await call(port, '/');
    expect(unsigned.status).toBe(403);
    // AWS sends no lambda-web-error-type on authorization failures.
    expect(unsigned.headers[ERROR_TYPE_HEADER]).toBeUndefined();
    expect(JSON.parse(unsigned.body).message).toMatch(/^Forbidden: .*Signature Version 4/);
    expect((await call(port, '/', { headers: { authorization: SIGNED } })).status).toBe(403);
    const ok = await call(port, '/echo', { headers: { authorization: SIGNED, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } });
    expect(ok.status).toBe(201);
    expect(JSON.parse(ok.body).headers.authorization).toBeUndefined();
    await sleep(20);
    expect(manager.getRequests('orders', 'web')[0]).toMatchObject({ status: 403, errorType: 'Forbidden' });
  });

  it('names each failure', () => {
    expect(iamAuthFailure({})).toMatch(/not signed/);
    expect(iamAuthFailure({ authorization: 'AWS4-HMAC-SHA256 Credential=bad' })).toMatch(/credential scope/);
    expect(iamAuthFailure({ authorization: SIGNED.replace('/lambda/', '/execute-api/') })).toMatch(/service "execute-api"/);
    expect(iamAuthFailure({ authorization: SIGNED })).toMatch(/X-Amz-Content-SHA256/);
    expect(iamAuthFailure({ authorization: SIGNED, 'x-amz-content-sha256': 'abc' })).toBeNull();
  });
});

describe('forwardedHeaders / sendLssError', () => {
  it('strips an AWS signature from ApplicationManaged requests, keeps app auth, and fills defaults', () => {
    const headers = forwardedHeaders(
      { authorization: SIGNED, 'x-amz-security-token': 't', connection: 'keep-alive', 'transfer-encoding': 'chunked', 'x-lss-web-revision': 'r' },
      { authType: 'ApplicationManaged', requestId: 'id', port: 15000, remoteAddress: '::ffff:10.1.1.1' },
    );
    expect(headers).toEqual({
      'x-forwarded-for': '10.1.1.1',
      'x-forwarded-host': 'localhost:15000',
      'x-forwarded-proto': 'https',
      [REQUEST_ID_HEADER]: 'id',
    });
    expect(forwardedHeaders({ authorization: 'Bearer x' }, { authType: 'ApplicationManaged', requestId: 'id', port: 1 })).toMatchObject({
      authorization: 'Bearer x', 'x-forwarded-for': '127.0.0.1',
    });
    expect(forwardedHeaders({}, { authType: 'IamAuth', requestId: 'id', port: 1 })).not.toHaveProperty('authorization');
  });

  it('labels LSS answers', () => {
    const res = { writeHead: jest.fn(), end: jest.fn() } as unknown as http.ServerResponse;
    sendLssError(res, 403, undefined, 'no');
    expect((res.writeHead as jest.Mock).mock.calls[0][1]).not.toHaveProperty(ERROR_TYPE_HEADER);
    expect(JSON.parse((res.end as jest.Mock).mock.calls[0][0])).toEqual({ message: 'no', source: 'lss', note: expect.any(String) });
  });
});

describe('WebFunctionGateway — listeners', () => {
  it('reports and recovers from a port conflict, keeps an unchanged listener, closes removed ones', async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(port, '127.0.0.1', resolve));
    const def = fn('web', port, [revision('r1')]);
    await serve([def]);
    expect(gateway.getListenerStatus('orders', 'web', 'live')).toBe('port-conflict');
    await sleep(120);
    await new Promise<void>(resolve => blocker.close(() => resolve()));
    await sleep(150);
    expect(gateway.getListenerStatus('orders', 'web', 'live')).toBe('online');

    // Same port: kept. New port: rebound. Disabled: closed.
    await gateway.syncService('orders', [def]);
    expect((await call(port, '/')).status).toBe(200);
    const other = await freePort();
    await gateway.syncService('orders', [fn('web', other, [revision('r1')]), fn('no-port', 0, [])].map(f => (f.name === 'no-port' ? { ...f, endpoints: [{ ...f.endpoints[0], port: undefined }] } : f)));
    expect((await call(other, '/')).status).toBe(200);
    await expect(call(port, '/')).rejects.toThrow();
    await gateway.syncService('orders', [fn('web', other, [revision('r1')])], false);
    expect(gateway.getListenerStatus('orders', 'web', 'live')).toBe('stopped');
    expect(gateway.getListenerStatus('nobody', 'x', 'y')).toBe('stopped');

    // removeService closes a listener that never managed to bind, too.
    const busy = net.createServer();
    await new Promise<void>(resolve => busy.listen(other, '127.0.0.1', resolve));
    await gateway.syncService('orders', [fn('web', other, [revision('r1')])]);
    await gateway.syncService('billing', [fn('bill', await freePort(), [revision('b1')])]);
    await gateway.removeService('orders');
    expect(gateway.getListenerStatus('orders', 'web', 'live')).toBe('stopped');
    expect(gateway.getListenerStatus('billing', 'bill', 'live')).toBe('online');
    await new Promise<void>(resolve => busy.close(() => resolve()));
  });

  it('reports a bind that fails for another reason as stopped', async () => {
    await gateway.syncService('orders', [fn('web', 1, [revision('r1')])]);
    expect(gateway.getListenerStatus('orders', 'web', 'live')).toBe('stopped');
  });

  it('is a singleton by default', () => {
    expect(WebFunctionGateway.getInstance()).toBe(WebFunctionGateway.getInstance());
  });
});
