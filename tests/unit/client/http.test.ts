import http from 'http';
import type { AddressInfo } from 'net';
import { LssClient, LssHttpError } from '../../../src/client';

// Stub orchestrator: records every request and replies with whatever `responder`
// returns. Mirrors the pattern in tests/unit/cli-seed.test.ts, but in-process so
// the client's HTTP + error-mapping code counts toward coverage.

interface Recorded {
  method: string;
  url: string;
  body: string;
}
interface StubResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Override the HTTP reason phrase ('' exercises the no-statusText branch). */
  statusMessage?: string;
  /** When set, the server never replies (used to force a client-side timeout). */
  hang?: boolean;
}

let server: http.Server;
let baseUrl: string;
let recorded: Recorded[];
let responder: (req: http.IncomingMessage, body: string) => StubResponse;

function lastReq(): Recorded {
  return recorded[recorded.length - 1];
}
function pathOf(url: string): string {
  return new URL('http://x' + url).pathname;
}
function queryOf(url: string): URLSearchParams {
  return new URL('http://x' + url).searchParams;
}

// The error a call is expected to reject with.
//
// `promise.catch(e => e as LssHttpError)` types the result as
// `Result | LssHttpError`, so every assertion about `.message`/`.statusText`
// below was reaching into a union that might not have them — and a call that
// unexpectedly RESOLVED would flow into the same variable and only fail at the
// first `expect`. This says "this must reject" once, in the type and at runtime.
async function rejection(promise: Promise<unknown>): Promise<LssHttpError> {
  try {
    await promise;
  } catch (error) {
    return error as LssHttpError;
  }
  throw new Error('expected the request to reject, but it resolved');
}

beforeAll(async () => {
  recorded = [];
  responder = () => ({ status: 200, body: '{}' });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', body });
      const r = responder(req, body);
      if (r.hang) return; // never respond — client aborts on timeout
      const headers = r.headers ?? { 'Content-Type': 'application/json' };
      if (r.statusMessage !== undefined) res.writeHead(r.status, r.statusMessage, headers);
      else res.writeHead(r.status, headers);
      res.end(r.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  recorded = [];
  responder = () => ({ status: 200, body: '{}' });
});

describe('client data-plane — every namespace method maps to the right route', () => {
  const client = (): LssClient => new LssClient({ baseUrl, region: 'us-east-1' });

  const cases: Array<{ name: string; run: (c: LssClient) => Promise<unknown>; method: string; path: string }> = [
    { name: 'seeds.list', run: (c) => c.seeds.list(), method: 'GET', path: '/api/seeds' },
    { name: 'seeds.run', run: (c) => c.seeds.run('Users'), method: 'POST', path: '/api/seeds/run' },
    { name: 'seeds.run (all)', run: (c) => c.seeds.run(), method: 'POST', path: '/api/seeds/run' },
    { name: 'seeds.clear', run: (c) => c.seeds.clear('Users'), method: 'POST', path: '/api/seeds/clear' },
    { name: 'seeds.clear (all)', run: (c) => c.seeds.clear(), method: 'POST', path: '/api/seeds/clear' },
    { name: 'queues.list', run: (c) => c.queues.list(), method: 'GET', path: '/api/queues' },
    { name: 'queues.get', run: (c) => c.queues.get('q'), method: 'GET', path: '/api/queues/q' },
    { name: 'queues.resetProcessed', run: (c) => c.queues.resetProcessed('q'), method: 'POST', path: '/api/queues/q/reset-processed' },
    { name: 'queues.hold', run: (c) => c.queues.hold('q'), method: 'POST', path: '/api/queues/q/hold' },
    { name: 'queues.captured', run: (c) => c.queues.captured('q'), method: 'GET', path: '/api/queues/q/captured' },
    { name: 'queues.release', run: (c) => c.queues.release('q'), method: 'POST', path: '/api/queues/q/release' },
    { name: 'queues.send', run: (c) => c.queues.send('q', { body: 'x' }), method: 'POST', path: '/api/queues/q/messages' },
    { name: 'queues.receive', run: (c) => c.queues.receive('q'), method: 'POST', path: '/api/queues/q/messages/receive' },
    { name: 'queues.receive (input)', run: (c) => c.queues.receive('q', { maxNumberOfMessages: 5 }), method: 'POST', path: '/api/queues/q/messages/receive' },
    { name: 'queues.deleteMessage', run: (c) => c.queues.deleteMessage('q', 'rh'), method: 'POST', path: '/api/queues/q/messages/delete' },
    { name: 'queues.purge', run: (c) => c.queues.purge('q'), method: 'POST', path: '/api/queues/q/purge' },
    { name: 'dynamo.listTables', run: (c) => c.dynamo.listTables(), method: 'GET', path: '/api/dynamo/tables' },
    { name: 'dynamo.describeTable', run: (c) => c.dynamo.describeTable('t'), method: 'GET', path: '/api/dynamo/tables/t' },
    { name: 'dynamo.getTtl', run: (c) => c.dynamo.getTtl('t'), method: 'GET', path: '/api/dynamo/tables/t/ttl' },
    { name: 'dynamo.setTtl', run: (c) => c.dynamo.setTtl('t', true, 'exp'), method: 'PUT', path: '/api/dynamo/tables/t/ttl' },
    { name: 'dynamo.scan', run: (c) => c.dynamo.scan('t'), method: 'POST', path: '/api/dynamo/tables/t/scan' },
    { name: 'dynamo.scan (input)', run: (c) => c.dynamo.scan('t', { limit: 1 }), method: 'POST', path: '/api/dynamo/tables/t/scan' },
    { name: 'dynamo.query', run: (c) => c.dynamo.query('t', { keyConditionExpression: 'id = :id' }), method: 'POST', path: '/api/dynamo/tables/t/query' },
    { name: 'dynamo.getItem', run: (c) => c.dynamo.getItem('t', { id: '1' }), method: 'POST', path: '/api/dynamo/tables/t/items/get' },
    { name: 'dynamo.putItem', run: (c) => c.dynamo.putItem('t', { id: '1' }), method: 'POST', path: '/api/dynamo/tables/t/items' },
    { name: 'dynamo.deleteItem', run: (c) => c.dynamo.deleteItem('t', { id: '1' }), method: 'POST', path: '/api/dynamo/tables/t/items/delete' },
    { name: 'buckets.list', run: (c) => c.buckets.list(), method: 'GET', path: '/api/buckets' },
    { name: 'buckets.get', run: (c) => c.buckets.get('b'), method: 'GET', path: '/api/buckets/b' },
    { name: 'buckets.listObjects', run: (c) => c.buckets.listObjects('b'), method: 'GET', path: '/api/buckets/b/objects' },
    { name: 'buckets.listObjects (input)', run: (c) => c.buckets.listObjects('b', { prefix: 'p/', maxKeys: 10 }), method: 'GET', path: '/api/buckets/b/objects' },
    { name: 'buckets.putObject', run: (c) => c.buckets.putObject('b', { key: 'k', body: 'x' }), method: 'POST', path: '/api/buckets/b/objects' },
    { name: 'buckets.deleteObject', run: (c) => c.buckets.deleteObject('b', 'k'), method: 'DELETE', path: '/api/buckets/b/objects' },
    { name: 'resources.list', run: (c) => c.resources.list(), method: 'GET', path: '/api/resources' },
    { name: 'resources.owners', run: (c) => c.resources.owners(), method: 'GET', path: '/api/resources/owners' },
    { name: 'services.register', run: (c) => c.services.register({ servicePath: '/svc' }), method: 'POST', path: '/api/services/register' },
    { name: 'services.scan', run: (c) => c.services.scan(), method: 'GET', path: '/api/services/scan' },
    { name: 'services.install', run: (c) => c.services.install('/svc'), method: 'POST', path: '/api/services/install' },
    { name: 'services.install (command)', run: (c) => c.services.install('/svc', 'yarn install'), method: 'POST', path: '/api/services/install' },
    { name: 'services.package', run: (c) => c.services.package('/svc'), method: 'POST', path: '/api/services/package' },
    { name: 'services.list', run: (c) => c.services.list(), method: 'GET', path: '/api/services' },
    { name: 'services.get', run: (c) => c.services.get('s'), method: 'GET', path: '/api/services/s' },
    { name: 'services.remove', run: (c) => c.services.remove('s'), method: 'DELETE', path: '/api/services/s' },
    { name: 'services.setStatus', run: (c) => c.services.setStatus('s', { status: 'running' }), method: 'PATCH', path: '/api/services/s/status' },
    { name: 'services.start', run: (c) => c.services.start('s'), method: 'POST', path: '/api/services/s/start' },
    { name: 'services.start (input)', run: (c) => c.services.start('s', { command: 'npm' }), method: 'POST', path: '/api/services/s/start' },
    { name: 'services.stop', run: (c) => c.services.stop('s'), method: 'POST', path: '/api/services/s/stop' },
    { name: 'services.logs', run: (c) => c.services.logs('s'), method: 'GET', path: '/api/services/s/logs' },
    { name: 'services.runtime', run: (c) => c.services.runtime('s'), method: 'GET', path: '/api/services/s/runtime' },
    { name: 'services.startRuntime', run: (c) => c.services.startRuntime('s'), method: 'POST', path: '/api/services/s/runtime/start' },
    { name: 'services.stopRuntime', run: (c) => c.services.stopRuntime('s'), method: 'POST', path: '/api/services/s/runtime/stop' },
    { name: 'lambdas.list', run: (c) => c.lambdas.list(), method: 'GET', path: '/api/lambdas' },
    { name: 'lambdas.get', run: (c) => c.lambdas.get('fn'), method: 'GET', path: '/api/lambdas/fn' },
    { name: 'lambdas.invoke', run: (c) => c.lambdas.invoke('fn'), method: 'POST', path: '/api/lambdas/fn/invoke' },
    { name: 'lambdas.invoke (input)', run: (c) => c.lambdas.invoke('fn', { payload: { a: 1 } }), method: 'POST', path: '/api/lambdas/fn/invoke' },
    { name: 'lambdas.logs', run: (c) => c.lambdas.logs('fn'), method: 'GET', path: '/api/lambdas/fn/logs' },
    { name: 'apis.list', run: (c) => c.apis.list(), method: 'GET', path: '/api/apis' },
    { name: 'apis.clearAuthorizerCache', run: (c) => c.apis.clearAuthorizerCache(), method: 'POST', path: '/api/apis/authorizer-cache/clear' },
    { name: 'config.get', run: (c) => c.config.get(), method: 'GET', path: '/api/config' },
    { name: 'health.get', run: (c) => c.health.get(), method: 'GET', path: '/api/health' },
  ];

  for (const tc of cases) {
    it(`${tc.name} -> ${tc.method} ${tc.path}`, async () => {
      await tc.run(client());
      expect(lastReq().method).toBe(tc.method);
      expect(pathOf(lastReq().url)).toBe(tc.path);
    });
  }

  it('awaitIdle posts to /await-idle and resolves a drained body', async () => {
    responder = () => ({ status: 200, body: JSON.stringify({ queue: 'q', available: 0, inFlight: 0, processed: 1, drained: true }) });
    const res = await client().queues.awaitIdle('q', { timeoutMs: 1000, sinceProcessed: 1 });
    expect(pathOf(lastReq().url)).toBe('/api/queues/q/await-idle');
    expect(res.drained).toBe(true);
  });
});

describe('client data-plane — request shaping', () => {
  it('threads an explicit region as ?region= for each region-aware namespace', async () => {
    const c = new LssClient({ baseUrl }); // no default region
    await c.seeds.list('eu-west-1');
    expect(queryOf(lastReq().url).get('region')).toBe('eu-west-1');
    await c.queues.list('eu-west-2');
    expect(queryOf(lastReq().url).get('region')).toBe('eu-west-2');
    await c.dynamo.listTables('eu-west-3');
    expect(queryOf(lastReq().url).get('region')).toBe('eu-west-3');
    await c.buckets.list('sa-east-1');
    expect(queryOf(lastReq().url).get('region')).toBe('sa-east-1');
    await c.resources.list('us-west-1');
    expect(queryOf(lastReq().url).get('region')).toBe('us-west-1');
  });

  it('omits the region query entirely when there is no default and none passed', async () => {
    const c = new LssClient({ baseUrl });
    await c.seeds.list();
    expect(lastReq().url).toBe('/api/seeds');
  });

  it('falls back to the default region when a call omits it', async () => {
    const c = new LssClient({ baseUrl, region: 'us-east-1' });
    await c.seeds.list();
    expect(queryOf(lastReq().url).get('region')).toBe('us-east-1');
  });

  it('serializes a JSON body on POST and sends none on GET', async () => {
    const c = new LssClient({ baseUrl });
    await c.seeds.run('Users');
    expect(JSON.parse(lastReq().body)).toEqual({ tableName: 'Users' });
    await c.seeds.list();
    expect(lastReq().body).toBe('');
  });

  it('forwards listObjects query params and the download flag for getObject', async () => {
    const c = new LssClient({ baseUrl });
    await c.buckets.listObjects('b', { prefix: 'p/', delimiter: '/', maxKeys: 7, continuationToken: 'tok' });
    const q = queryOf(lastReq().url);
    expect(q.get('prefix')).toBe('p/');
    expect(q.get('maxKeys')).toBe('7');
    responder = () => ({ status: 200, body: 'binary-bytes' });
    const buf = await c.buckets.getObject('b', 'file.txt', { download: true });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('binary-bytes');
    expect(queryOf(lastReq().url).get('download')).toBe('1');
  });

  it('lambdas.invoke defaults the body to {} and forwards the input otherwise', async () => {
    const c = new LssClient({ baseUrl });
    await c.lambdas.invoke('fn');
    expect(JSON.parse(lastReq().body)).toEqual({});
    await c.lambdas.invoke('fn', { payload: { a: 1 }, invocationType: 'Event' });
    expect(JSON.parse(lastReq().body)).toEqual({ payload: { a: 1 }, invocationType: 'Event' });
  });

  it('apis.clearAuthorizerCache forwards service/authorizer filters and omits them when absent', async () => {
    const c = new LssClient({ baseUrl });
    await c.apis.clearAuthorizerCache({ service: 'svc', authorizer: 'auth' });
    expect(queryOf(lastReq().url).get('service')).toBe('svc');
    expect(queryOf(lastReq().url).get('authorizer')).toBe('auth');
    await c.apis.clearAuthorizerCache();
    expect(lastReq().url).toBe('/api/apis/authorizer-cache/clear');
  });

  it('constructs with no options at all (pure defaults)', () => {
    const c = new LssClient();
    expect(c.baseUrl).toMatch(/^http:\/\//);
  });

  it('exposes a request() escape hatch for arbitrary calls', async () => {
    responder = () => ({ status: 200, body: JSON.stringify({ pong: true }) });
    const c = new LssClient({ baseUrl });
    const out = await c.request<{ pong: boolean }>('GET', '/api/health', undefined, { region: 'us-east-1' });
    expect(out.pong).toBe(true);
    expect(pathOf(lastReq().url)).toBe('/api/health');
  });

  it('returns an empty object for a 2xx with no body', async () => {
    responder = () => ({ status: 200, body: '' });
    const out = await new LssClient({ baseUrl }).queues.purge('q');
    expect(out).toEqual({});
  });
});

describe('client data-plane — error mapping', () => {
  const c = (): LssClient => new LssClient({ baseUrl });

  it('surfaces the orchestrator {error} message', async () => {
    responder = () => ({ status: 500, body: JSON.stringify({ error: 'boom' }) });
    await expect(c().seeds.run()).rejects.toMatchObject({ message: 'boom', status: 500 });
  });

  it('surfaces the orchestrator {message} field', async () => {
    responder = () => ({ status: 500, body: JSON.stringify({ message: 'kaput' }) });
    await expect(c().seeds.run()).rejects.toThrow('kaput');
  });

  it('includes a snippet when the error body has no error/message field', async () => {
    responder = () => ({ status: 500, body: JSON.stringify({ error: '' }) });
    const err = await rejection(c().seeds.run());
    expect(err).toBeInstanceOf(LssHttpError);
    expect(err.message).toContain('HTTP 500');
    expect(err.message).toContain('error');
  });

  it('handles a non-JSON error body', async () => {
    responder = () => ({ status: 500, body: 'plain text failure', headers: { 'Content-Type': 'text/plain' } });
    await expect(c().seeds.run()).rejects.toThrow(/HTTP 500.*plain text failure/);
  });

  it('handles an empty error body', async () => {
    responder = () => ({ status: 500, body: '' });
    await expect(c().seeds.run()).rejects.toThrow(/HTTP 500.*no error body/);
  });

  it('does not inline an over-long error body', async () => {
    responder = () => ({ status: 500, body: 'x'.repeat(400), headers: { 'Content-Type': 'text/plain' } });
    await expect(c().seeds.run()).rejects.toThrow(/no error body/);
  });

  it('labels the error with the bare status when there is no reason phrase', async () => {
    responder = () => ({ status: 500, body: '', statusMessage: '' });
    const err = await rejection(c().seeds.run());
    expect(err).toBeInstanceOf(LssHttpError);
    expect(err.message).toContain('HTTP 500');
  });

  it('throws on a non-2xx for a raw (binary) request', async () => {
    responder = () => ({ status: 404, body: JSON.stringify({ error: 'Object not found' }) });
    await expect(c().buckets.getObject('b', 'missing')).rejects.toThrow('Object not found');
  });

  it('resolves awaitIdle on a 408 timeout (not drained)', async () => {
    responder = () => ({ status: 408, body: JSON.stringify({ queue: 'q', available: 1, inFlight: 0, processed: 0, drained: false }) });
    const res = await c().queues.awaitIdle('q');
    expect(res.drained).toBe(false);
  });

  it('still throws awaitIdle on a real 500', async () => {
    responder = () => ({ status: 500, body: JSON.stringify({ error: 'queue blew up' }) });
    await expect(c().queues.awaitIdle('q')).rejects.toThrow('queue blew up');
  });

  it('treats a 2xx as success even when okStatuses is set (additive, not replacing)', async () => {
    // awaitIdle passes okStatuses:[408]; a normal 200 must still succeed.
    responder = () => ({ status: 200, body: JSON.stringify({ queue: 'q', available: 0, inFlight: 0, processed: 1, drained: true }) });
    const res = await c().queues.awaitIdle('q');
    expect(res.drained).toBe(true);
  });

  it('maps a timeout to a clear error', async () => {
    responder = () => ({ status: 200, hang: true });
    const client = new LssClient({ baseUrl, timeoutMs: 40 });
    const err = await rejection(client.health.get());
    expect(err).toBeInstanceOf(LssHttpError);
    expect(err.statusText).toBe('timeout');
    expect(err.message).toMatch(/timed out/);
  });

  it('maps a connection failure to a clear error', async () => {
    // Bind then immediately close a server to obtain a guaranteed-closed port.
    const probe = http.createServer();
    const closedPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port));
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const client = new LssClient({ baseUrl: `http://127.0.0.1:${closedPort}` });
    const err = await rejection(client.health.get());
    expect(err).toBeInstanceOf(LssHttpError);
    expect(err.message).toContain('could not connect to orchestrator');
  });
});
