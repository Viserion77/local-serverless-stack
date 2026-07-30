// Unit tests for the DynamoDB dev proxy. `startDynamoProxy` calls server.listen()
// itself, so we pass port 0 (ephemeral) and wait for the 'listening' event rather
// than listening again.
import http from 'http';
import { once } from 'events';
import { AddressInfo } from 'net';
import { startDynamoProxy } from '../../../src/server/dev/dynamo-proxy';

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}
async function startProxy(target: string): Promise<{ server: http.Server; port: number }> {
  const server = startDynamoProxy(target, 0);
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

describe('startDynamoProxy', () => {
  let upstream: http.Server | undefined;
  let proxy: http.Server | undefined;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (proxy) await close(proxy);
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
    jest.restoreAllMocks();
  });

  it('forwards path, method and body upstream and pipes the response back (trailing slash stripped)', async () => {
    let seen: { url?: string; method?: string; body: string } = { body: '' };
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        seen = { url: req.url, method: req.method, body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    upstream.listen(0);
    await once(upstream, 'listening');
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const started = await startProxy(`http://localhost:${upstreamPort}/`); // trailing slash stripped
    proxy = started.server;

    const res = await fetch(`http://localhost:${started.port}/tables/Foo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 1 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.url).toBe('/tables/Foo');
    expect(seen.method).toBe('POST');
    expect(JSON.parse(seen.body)).toEqual({ q: 1 });
  });

  it('returns 502 Bad Gateway when the upstream is unreachable', async () => {
    const started = await startProxy('http://localhost:1'); // nothing listening on :1
    proxy = started.server;
    const res = await fetch(`http://localhost:${started.port}/anything`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('Bad Gateway');
  });

  it('defaults the port to 8000 when not provided', async () => {
    // Stub http.createServer so we never bind 8000; assert the default arg is used.
    const fakeServer = {
      listen: jest.fn((_p: number, cb?: () => void) => cb && cb()),
      on: jest.fn(),
    } as unknown as http.Server;
    const spy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer);
    const returned = startDynamoProxy('http://localhost:4566');
    expect(returned).toBe(fakeServer);
    expect(spy).toHaveBeenCalled();
    expect((fakeServer.listen as jest.Mock)).toHaveBeenCalledWith(8000, expect.any(Function));
    expect((fakeServer.on as jest.Mock)).toHaveBeenCalledWith('error', expect.any(Function));
  });

  // The proxy is optional: a busy port warns and leaves the orchestrator up,
  // instead of throwing an unhandled 'error' event that kills the process.
  it('warns instead of throwing when the port is already in use', () => {
    const handlers: Record<string, (err: NodeJS.ErrnoException) => void> = {};
    const fakeServer = {
      listen: jest.fn(),
      on: jest.fn((event: string, handler: (err: NodeJS.ErrnoException) => void) => {
        handlers[event] = handler;
      }),
    } as unknown as http.Server;
    jest.spyOn(http, 'createServer').mockReturnValue(fakeServer);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    startDynamoProxy('http://localhost:4566', 8123);
    handlers.error(Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('port 8123 is already in use'));

    handlers.error(Object.assign(new Error('some other failure'), { code: 'EACCES' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('some other failure'));
    warn.mockRestore();
  });
});
