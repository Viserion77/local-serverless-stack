// End-to-end validation of raw cross-stack AWS::ApiGatewayV2 routes against the
// localstack-free example: `gateway-stack` owns NO Lambdas and declares its
// ::Api/::Route/::Integration/::Authorizer (+ Lambda::Permission) purely under
// CFN `resources:`, all targeting users-service's functions by ARN.
//
// Asserts the whole promise: the raw route resolves across the stack boundary,
// the cross-stack authorizer is enforced, a payload-v2 invoke crosses the
// service boundary, and NOTHING falls back to an /api/{proxy+} or $default
// catch-all.
//
// Requires Docker + LOCALSTACK_AUTH_TOKEN *and* an installed example
// (`npm run setup` inside examples/localstack-free, which each service needs for
// `serverless package`). The suite skips cleanly when either is missing, so it
// never fails a token-less or un-provisioned checkout.
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);
const REPO_ROOT = path.resolve(__dirname, '../..');
const EXAMPLE = path.join(REPO_ROOT, 'examples/localstack-free');
const CONFIG = path.join(EXAMPLE, 'lss.config.json');
const BASE = 'http://localhost:3120';
const GATEWAY_API = 'http://localhost:3613';

const USERS_PATH = path.join(EXAMPLE, 'users-service');
const GATEWAY_PATH = path.join(EXAMPLE, 'gateway-stack');

const LIST_USERS_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-listUsers';

// The example must be installed for `serverless package` to run in each service.
const EXAMPLE_READY = fs.existsSync(path.join(USERS_PATH, 'node_modules'))
  && fs.existsSync(path.join(GATEWAY_PATH, 'node_modules'));
const HAS_TOKEN = Boolean(process.env.LOCALSTACK_AUTH_TOKEN);
const suite = HAS_TOKEN && EXAMPLE_READY ? describe : describe.skip;

function cli(args: string) {
  return execAsync(`node bin/cli.js ${args}`, { cwd: REPO_ROOT, env: process.env });
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, intervalMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond().catch(() => false)) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

suite('raw cross-stack ApiGatewayV2 routes (integration)', () => {
  beforeAll(async () => {
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
    await cli(`start --config ${CONFIG}`);
    await waitFor(async () => {
      const res = await fetch(`${BASE}/api/health`);
      const j = await res.json() as { localstack?: boolean };
      return j.localstack === true;
    }, 150000);

    // Register the GATEWAY FIRST, while its target Lambdas are still unknown —
    // resolution happens at request time, so order must not matter.
    const gw = await api('POST', '/api/services/register', { servicePath: GATEWAY_PATH });
    expect(gw.status).toBe(200);
    const users = await api('POST', '/api/services/register', { servicePath: USERS_PATH });
    expect(users.status).toBe(200);

    // Seed users-Users so listUsers has something to return.
    await api('POST', '/api/seeds/run', {});
  }, 300000);

  afterAll(async () => {
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
  }, 60000);

  it('serves the raw route by resolving a Lambda owned by ANOTHER service', async () => {
    const res = await fetch(`${GATEWAY_API}/gw/users`, {
      headers: { authorization: 'Bearer lss-secret' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items?: unknown[] };
    // listUsers returns a bare object; payload v2 infers the 200 JSON response.
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('enforces the cross-stack authorizer (401 without identity source, 403 on deny)', async () => {
    // Flush the authorizer cache so a previous allow does not mask the deny.
    await api('POST', '/api/apis/authorizer-cache/clear');

    const missing = await fetch(`${GATEWAY_API}/gw/users`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${GATEWAY_API}/gw/users`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(403);
  });

  it('lists the raw route with its resolved cross-service functionArn and no catch-all anywhere', async () => {
    const { status, data } = await api('GET', '/api/apis');
    expect(status).toBe(200);

    const gateway = data.find((s: any) => s.service === 'gateway-stack');
    expect(gateway).toBeDefined();
    expect(gateway.apiPort).toBe(3613);

    const raw = gateway.routes.find((r: any) => r.path === '/gw/users');
    expect(raw).toMatchObject({
      method: 'GET',
      path: '/gw/users',
      eventType: 'httpApi',
      payloadVersion: '2.0',
      raw: true,
      functionArn: LIST_USERS_ARN,
    });
    expect(raw.authorizerName).toBeTruthy();

    // The whole example resolves its topology natively — no stand-ins.
    const allPaths = data.flatMap((s: any) => s.routes.map((r: any) => r.path));
    expect(allPaths).not.toContain('/api/{proxy+}');
    expect(allPaths).not.toContain('$default');
  });

  it('does not double-register users-service routes (raw ::Route mirrors are deduped)', async () => {
    const { data } = await api('GET', '/api/apis');
    const users = data.find((s: any) => s.service === 'users-service');
    // Its three httpApi events, not six: the serverless-compiled ::Route mirrors
    // of the same (method, path) pairs are skipped in favor of the state routes.
    // The two genuinely-raw /api/identity/spaces routes — declared under
    // `resources:` on the framework's OWN HttpApi — are the only additions.
    const paths = users.routes.map((r: any) => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual([
      'GET /api/identity/spaces',
      'GET /users',
      'GET /users/{id}',
      'POST /api/identity/spaces',
      'POST /users',
    ]);
    expect(users.routes.filter((r: any) => r.raw).map((r: any) => r.path))
      .toEqual(['/api/identity/spaces', '/api/identity/spaces']);
  });

  it('serves a raw route declared on the framework\'s own HttpApi (the !Sub idiom)', async () => {
    // Target: !Sub 'integrations/${SpacesIntegration}' and an AuthorizerUri that
    // is the apigateway invocation-URI wrapper, not a bare Lambda ARN.
    const res = await fetch('http://localhost:3610/api/identity/spaces', {
      headers: { authorization: 'Bearer lss-secret' },
    });
    expect(res.status).toBe(200);
    // Unauthenticated it is the raw route's own authorizer that rejects it.
    const denied = await fetch('http://localhost:3610/api/identity/spaces');
    expect(denied.status).toBe(401);
  });
});
