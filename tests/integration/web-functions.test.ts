// End-to-end Lambda Web Functions on examples/self-hosted's orders-service:
// the raw AWS::Lambda::WebFunction* resources are discovered from the packaged
// template, the plain node:http app is started by the first request on its
// stable local URL, streams SSE incrementally, reads DynamoDB through the
// engine, answers 504 past TimeoutSeconds, is reached by a sibling event
// function through the URL resolved from `Fn::GetAtt Endpoint.DomainName`, and
// keeps its port across an orchestrator restart.
//
// Isolated instance (own ports, stateDir and config directory — so its cached
// registration never leaks into the other suites' project cache). Runs on the
// self engine: no Docker, no token.
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import http from 'http';

const execAsync = promisify(exec);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CONFIG = 'tests/integration/fixtures/web-functions/lss.config.json';
const BASE = 'http://localhost:14593';
const API = 'http://localhost:3693';
const SERVICE_PATH = path.join(REPO_ROOT, 'examples/self-hosted/orders-service');

function cli(args: string) {
  return execAsync(`node bin/cli.js ${args}`, { cwd: REPO_ROOT, env: process.env });
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond().catch(() => false)) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

async function startStack(): Promise<void> {
  await cli(`start --config ${CONFIG}`);
  await waitFor(async () => {
    const res = await fetch(`${BASE}/api/health`);
    return ((await res.json()) as { engineRunning?: boolean }).engineRunning === true;
  }, 60000);
}

interface WebFunctionView {
  name: string;
  state: string;
  endpoints: Array<{ name: string; url?: string; port?: number; listener: string }>;
  revisions: Array<{ revisionId: string; logicalId: string }>;
}

async function ordersWeb(): Promise<WebFunctionView> {
  const list = (await (await fetch(`${BASE}/api/lambdas/web`)).json()) as WebFunctionView[];
  return list.find(fn => fn.name === 'orders-web') as WebFunctionView;
}

describe('Lambda Web Functions on examples/self-hosted (integration)', () => {
  let url = '';

  beforeAll(async () => {
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
    await startStack();
    const reg = await fetch(`${BASE}/api/services/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servicePath: SERVICE_PATH }),
    });
    expect(reg.status).toBe(200);
    url = (await ordersWeb()).endpoints[0].url as string;
  }, 300000);

  afterAll(async () => {
    await fetch(`${BASE}/api/services/orders-service`, { method: 'DELETE' }).catch(() => undefined);
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
    await execAsync('rm -rf tests/.lss-web-functions', { cwd: REPO_ROOT }).catch(() => undefined);
  }, 60000);

  it('discovers the web function from the raw CloudFormation resources, cold', async () => {
    const fn = await ordersWeb();
    expect(fn.state).toBe('cold');
    expect(fn.revisions.map(r => r.logicalId)).toEqual(['OrdersWebRevision', 'OrdersWebRevisionCanary']);
    expect(fn.endpoints[0]).toMatchObject({ name: 'live', listener: 'online' });
    expect(fn.endpoints[0].port).toBeGreaterThanOrEqual(15990);
    expect(fn.endpoints[0].port).toBeLessThanOrEqual(15999);
  });

  it('starts the app on the first request and echoes lambda-web-request-id', async () => {
    const res = await fetch(`${url}/api/health`, { headers: { 'x-lss-web-revision': 'OrdersWebRevision' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channel: string; requestId: string; forwardedProto: string };
    expect(body).toMatchObject({ ok: true, channel: 'stable', forwardedProto: 'https' });
    expect(res.headers.get('lambda-web-request-id')).toBe(body.requestId);
    const canary = (await (await fetch(`${url}/api/health`, { headers: { 'x-lss-web-revision': 'OrdersWebRevisionCanary' } })).json()) as { channel: string };
    expect(canary.channel).toBe('canary');
  });

  it('reads DynamoDB through the engine from inside the app', async () => {
    const created = await fetch(`${API}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: 'acme-web', total: 12.5 }),
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as { id: string };
    const found = await fetch(`${url}/api/orders/${order.id}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id: order.id, customerId: 'acme-web' });
    expect((await fetch(`${url}/api/orders/does-not-exist`)).status).toBe(404);
  });

  it('streams three SSE events incrementally', async () => {
    const arrivals: number[] = [];
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`${url}/api/stream`, res => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        let text = '';
        res.on('data', chunk => { arrivals.push(Date.now()); text += chunk; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body.match(/^event: order-status$/gm)).toHaveLength(3);
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(600);
  });

  it('answers 504 past TimeoutSeconds', async () => {
    const res = await fetch(`${url}/api/slow?ms=12000`, { headers: { 'x-lss-web-revision': 'OrdersWebRevision' } });
    expect(res.status).toBe(504);
    expect(res.headers.get('lambda-web-error-type')).toBe('Runtime.RequestTimeout');
    expect(await res.json()).toMatchObject({ source: 'lss' });
  }, 30000);

  it('is reached by a sibling event function through the resolved DomainName', async () => {
    const res = await fetch(`${API}/orders/web-check`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calledUrl: string; status: number; webFunction: { ok: boolean } };
    expect(body.calledUrl).toBe(url);
    expect(body).toMatchObject({ status: 200, webFunction: { ok: true } });
  });

  it('records the requests', async () => {
    const detail = (await (await fetch(`${BASE}/api/lambdas/web/orders-service/orders-web`)).json()) as {
      state: string; recentRequests: Array<{ status: number }>;
    };
    expect(detail.state).toBe('ready');
    expect(detail.recentRequests.map(r => r.status)).toEqual(expect.arrayContaining([200, 404, 504]));
  });

  it('keeps the same URL across an orchestrator restart', async () => {
    await cli(`stop --config ${CONFIG}`);
    await startStack();
    await waitFor(async () => (await ordersWeb())?.endpoints[0].listener === 'online', 30000);
    expect((await ordersWeb()).endpoints[0].url).toBe(url);
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
  }, 120000);
});
