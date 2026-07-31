// Base-URL discovery and the JSON caller. The failure message matters as much
// as the happy path: when the stack is down, the model must be told to run
// `lss start` rather than shown a bare TypeError from fetch.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHttp, resolveBaseUrl, LssUnreachableError } from '../../../src/mcp/http';

let dir: string;
const origEnv = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-mcp-http-'));
  delete process.env.LSS_BASE_URL;
  delete process.env.LSS_CONFIG;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...origEnv };
  jest.restoreAllMocks();
});

describe('resolveBaseUrl', () => {
  it('prefers an explicit base url and trims a trailing slash', () => {
    expect(resolveBaseUrl({ baseUrl: 'http://host:9/' })).toBe('http://host:9');
    expect(resolveBaseUrl({ baseUrl: 'http://host:9' })).toBe('http://host:9');
  });

  it('falls back to LSS_BASE_URL', () => {
    process.env.LSS_BASE_URL = 'http://elsewhere:1234';
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://elsewhere:1234');
  });

  it('reads serverPort from lss.config.json in the working directory', () => {
    fs.writeFileSync(path.join(dir, 'lss.config.json'), JSON.stringify({ serverPort: 3140 }));
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://localhost:3140');
  });

  it('falls back to .lssrc when there is no lss.config.json', () => {
    fs.writeFileSync(path.join(dir, '.lssrc'), JSON.stringify({ serverPort: 3222 }));
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://localhost:3222');
  });

  it('honours an explicit config path', () => {
    const custom = path.join(dir, 'lss.e2e.json');
    fs.writeFileSync(custom, JSON.stringify({ serverPort: 3999 }));
    expect(resolveBaseUrl({ cwd: dir, configPath: 'lss.e2e.json' })).toBe('http://localhost:3999');
    process.env.LSS_CONFIG = custom;
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://localhost:3999');
  });

  it('defaults to 3100 when nothing is readable, unparseable, or has no numeric serverPort', () => {
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://localhost:3100');
    fs.writeFileSync(path.join(dir, 'lss.config.json'), '{ not json');
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://localhost:3100');
    fs.writeFileSync(path.join(dir, 'lss.config.json'), JSON.stringify({ serverPort: '3140' }));
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://localhost:3100');
    fs.writeFileSync(path.join(dir, 'lss.config.json'), JSON.stringify({ serverPort: 1.5 }));
    expect(resolveBaseUrl({ cwd: dir })).toBe('http://localhost:3100');
  });

  it('defaults the working directory to the process cwd', () => {
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    fs.writeFileSync(path.join(dir, 'lss.config.json'), JSON.stringify({ serverPort: 3777 }));
    expect(resolveBaseUrl()).toBe('http://localhost:3777');
  });
});

function mockFetch(impl: (url: string, init: RequestInit) => Partial<Response> | Promise<never>) {
  const spy = jest.fn(async (url: unknown, init: unknown) => impl(String(url), init as RequestInit));
  (globalThis as { fetch: unknown }).fetch = spy;
  return spy;
}

const res = (status: number, body: string, statusText = '') =>
  ({ ok: status >= 200 && status < 300, status, statusText, text: async () => body }) as Partial<Response>;

describe('createHttp', () => {
  it('GETs without a content-type and parses the JSON body', async () => {
    const spy = mockFetch(() => res(200, '{"status":"ok"}'));
    const http = createHttp('http://localhost:3100');
    expect(await http('GET', '/api/health')).toEqual({ status: 'ok' });
    expect(spy.mock.calls[0][0]).toBe('http://localhost:3100/api/health');
    expect((spy.mock.calls[0][1] as RequestInit).headers).toBeUndefined();
  });

  it('POSTs a JSON body with the content-type header', async () => {
    const spy = mockFetch(() => res(200, '{}'));
    await createHttp('http://x')('POST', '/api/seeds/run', { tableName: 'Users' });
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"tableName":"Users"}');
  });

  it('returns null for an empty body and the raw text when it is not JSON', async () => {
    mockFetch(() => res(200, ''));
    expect(await createHttp('http://x')('GET', '/a')).toBeNull();
    mockFetch(() => res(200, 'plain text'));
    expect(await createHttp('http://x')('GET', '/a')).toBe('plain text');
  });

  it('treats 408 as a result — await-idle answers a meaningful body on timeout', async () => {
    mockFetch(() => res(408, '{"drained":false}'));
    expect(await createHttp('http://x')('POST', '/api/queues/q/await-idle', {})).toEqual({ drained: false });
  });

  it('raises the orchestrator error message, not the bare status', async () => {
    mockFetch(() => res(404, '{"error":"Queue not found"}'));
    await expect(createHttp('http://x')('GET', '/api/queues/ghost')).rejects.toThrow(
      'GET /api/queues/ghost → 404: Queue not found',
    );
  });

  it('falls back to the body text, then the status text, when there is no error field', async () => {
    mockFetch(() => res(500, 'boom'));
    await expect(createHttp('http://x')('GET', '/a')).rejects.toThrow('→ 500: boom');
    mockFetch(() => res(503, '', 'Service Unavailable'));
    await expect(createHttp('http://x')('GET', '/a')).rejects.toThrow('→ 503: Service Unavailable');
  });

  it('a connection failure explains how to start the stack', async () => {
    mockFetch(() => Promise.reject(Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' })));
    await expect(createHttp('http://localhost:3100')('GET', '/api/health')).rejects.toThrow(LssUnreachableError);
    await expect(createHttp('http://localhost:3100')('GET', '/api/health')).rejects.toThrow(
      /Could not reach the LSS orchestrator at http:\/\/localhost:3100 \(ECONNREFUSED\).*npx lss start/s,
    );
  });

  it('an abort is reported as a timeout with the budget that elapsed', async () => {
    mockFetch(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await expect(createHttp('http://x', 25)('GET', '/a')).rejects.toThrow('timed out after 25ms');
  });

  // The real timer path: a hanging orchestrator must not hang the MCP client.
  it('aborts a request that outlives its budget', async () => {
    mockFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }) as Promise<never>);
    await expect(createHttp('http://x', 10)('GET', '/slow')).rejects.toThrow('timed out after 10ms');
  });
});
