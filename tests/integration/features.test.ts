// End-to-end validation of LSS's promised features (see docs/FEATURES.md).
// Boots an ISOLATED LSS + LocalStack instance (own ports + stateDir, managed
// mode, token from LOCALSTACK_AUTH_TOKEN), provisions examples/sample-microservice,
// and asserts each capability against the live HTTP API.
//
// Requires Docker + a LOCALSTACK_AUTH_TOKEN (community images >= 2026.5 need it).
// The whole suite is skipped when no token is present, so it never fails a
// token-less local run or a CI job without the secret.
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CONFIG = 'tests/integration/fixtures/lss.integration.config.json';
const BASE = 'http://localhost:3399';
const SERVICE_PATH = path.join(REPO_ROOT, 'examples/sample-microservice');
const STATE_PID = path.join(REPO_ROOT, 'tests/.lss-integration/orchestrator.pid');

const QUEUE = 'sample-microservice-OrderProcessing';
const BUCKET = 'sample-microservice-uploads';

const HAS_TOKEN = Boolean(process.env.LOCALSTACK_AUTH_TOKEN);
const suite = HAS_TOKEN ? describe : describe.skip;

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

suite('LSS promised features (integration)', () => {
  beforeAll(async () => {
    if (!HAS_TOKEN) return;
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
    await cli(`start --config ${CONFIG}`);
    // Wait for the orchestrator + LocalStack to come up.
    await waitFor(async () => {
      const res = await fetch(`${BASE}/api/health`);
      const j = await res.json();
      return j.localstack === true;
    }, 150000);
    // Register the example — provisioning runs within the request.
    const reg = await api('POST', '/api/services/register', { servicePath: SERVICE_PATH, invokePort: 3998 });
    expect(reg.status).toBe(200);
  }, 240000);

  afterAll(async () => {
    if (!HAS_TOKEN) return;
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
    // Remove the main LocalStack container AND any Lambda child containers it spawned
    // (named lss-localstack-4599-lambda-…), plus the scoped volume.
    await execAsync('docker rm -f $(docker ps -aq --filter name=lss-localstack-4599) 2>/dev/null || true').catch(() => undefined);
    await execAsync('docker volume rm lss-localstack-4599-data 2>/dev/null || true').catch(() => undefined);
    await execAsync('rm -rf tests/.lss-integration 2>/dev/null || true').catch(() => undefined);
  }, 60000);

  describe('config & isolation', () => {
    it('exposes the isolated instance config (no token leak)', async () => {
      const { status, data } = await api('GET', '/api/config');
      expect(status).toBe(200);
      expect(data.serverPort).toBe(3399);
      expect(data.localstack.port).toBe(4599);
      expect(data.configPath).toContain('lss.integration.config.json');
      expect(JSON.stringify(data)).not.toContain(process.env.LOCALSTACK_AUTH_TOKEN);
    });

    it('keeps PID/log under the stateDir, not /tmp', () => {
      expect(fs.existsSync(STATE_PID)).toBe(true);
      expect(fs.existsSync('/tmp/lss-orchestrator.pid')).toBe(false);
    });
  });

  describe('resource provisioning', () => {
    it('provisions the DynamoDB tables, SQS queue, SNS topic and S3 bucket', async () => {
      const { data } = await api('GET', '/api/resources');
      const blob = JSON.stringify(data);
      for (const name of [
        'sample-microservice-Users',
        'sample-microservice-Sessions',
        'sample-microservice-Orders',
        QUEUE,
        'sample-microservice-OrderEvents',
        BUCKET,
      ]) {
        expect(blob).toContain(name);
      }
    });

    it('describes the Orders table with its composite key / GSI / stream', async () => {
      const { status, data } = await api('GET', '/api/dynamo/tables/sample-microservice-Orders');
      expect(status).toBe(200);
      expect(JSON.stringify(data)).toContain('userId');
    });

    it('lists the queue with its consumer event source mapping', async () => {
      const { status, data } = await api('GET', `/api/queues/${QUEUE}`);
      expect(status).toBe(200);
      expect(Array.isArray(data.consumers)).toBe(true);
      expect(data.consumers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('seeds + dynamo', () => {
    it('applies seed files and the items are scannable', async () => {
      const run = await api('POST', '/api/seeds/run', {});
      expect(run.status).toBe(200);
      const scan = await api('POST', '/api/dynamo/tables/sample-microservice-Users/scan', {});
      expect(scan.status).toBe(200);
      const items = scan.data.items ?? scan.data.Items ?? scan.data;
      expect(Array.isArray(items) ? items.length : 0).toBeGreaterThanOrEqual(1);
    });
  });

  describe('queue await-idle', () => {
    it('returns drained:true on an already-empty queue', async () => {
      const { status, data } = await api('POST', `/api/queues/${QUEUE}/await-idle`, { timeoutMs: 8000 });
      expect(status).toBe(200);
      expect(data.drained).toBe(true);
    });
  });

  describe('queue hold / captured / release', () => {
    it('holds the consumer, captures a produced message, then releases', async () => {
      const hold = await api('POST', `/api/queues/${QUEUE}/hold`);
      expect(hold.status).toBe(200);
      expect(hold.data.held).toBe(true);

      const send = await api('POST', `/api/queues/${QUEUE}/messages`, { body: 'integration-held' });
      expect(send.status).toBe(200);

      // capture is pull-based; poll until the produced message shows up
      let captured: any[] = [];
      await waitFor(async () => {
        const res = await api('GET', `/api/queues/${QUEUE}/captured`);
        captured = res.data;
        return Array.isArray(captured) && captured.some(m => m.body === 'integration-held');
      }, 15000, 1000);
      expect(captured.some(m => m.body === 'integration-held')).toBe(true);

      const release = await api('POST', `/api/queues/${QUEUE}/release`);
      expect(release.status).toBe(200);
      expect(release.data.released).toBe(true);
    });
  });

  describe('s3 object round-trip', () => {
    it('uploads, lists, reads and deletes an object', async () => {
      const key = 'incoming/integration.txt';
      const up = await api('POST', `/api/buckets/${BUCKET}/objects`, { key, body: 'hello-s3' });
      expect(up.status).toBe(200);

      const list = await api('GET', `/api/buckets/${BUCKET}/objects?prefix=incoming`);
      expect(JSON.stringify(list.data)).toContain('integration.txt');

      const content = await fetch(`${BASE}/api/buckets/${BUCKET}/objects/content?key=${encodeURIComponent(key)}`);
      expect(await content.text()).toBe('hello-s3');

      const del = await fetch(`${BASE}/api/buckets/${BUCKET}/objects?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
    });
  });
});
