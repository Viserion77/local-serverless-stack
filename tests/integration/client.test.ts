// End-to-end validation of the programmatic client (LssClient), driven entirely
// through the client itself — it boots its OWN isolated LSS + LocalStack via
// `lifecycle.start()` (distinct ports/stateDir from features.test.ts), registers
// the fixture service (tests/integration/fixtures/sample-microservice), and
// exercises every namespace against the live stack, then tears down via
// `lifecycle.stop()`.
//
// IMPORTANT: this imports the BUILT library (dist/client), exactly as a consumer
// would — so it validates the compiled output + public surface, not the TS source.
// Run `npm run build` before `npm run test:integration`.
//
// Requires Docker + a LOCALSTACK_AUTH_TOKEN (community images >= 2026.5 need it).
// Skipped when no token is present, like features.test.ts.
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { LssClient } from '../../dist/client';

const execAsync = promisify(exec);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CONFIG = 'tests/integration/fixtures/lss.client.config.json';
const SERVICE_PATH = path.join(REPO_ROOT, 'tests/integration/fixtures/sample-microservice');

const QUEUE = 'sample-microservice-OrderProcessing';
const BUCKET = 'sample-microservice-uploads';

const HAS_TOKEN = Boolean(process.env.LOCALSTACK_AUTH_TOKEN);
const suite = HAS_TOKEN ? describe : describe.skip;

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

suite('LssClient (integration, built lib)', () => {
  const lss = new LssClient({ configPath: CONFIG, cwd: REPO_ROOT });

  beforeAll(async () => {
    if (!HAS_TOKEN) return;
    await lss.lifecycle.stop().catch(() => undefined);
    await lss.lifecycle.start();
    await lss.lifecycle.waitUntilReady({ timeoutMs: 150000, intervalMs: 2000 });
    // Provision the fixture service by registering it through the client.
    const reg = (await lss.services.register({ servicePath: SERVICE_PATH, invokePort: 3997 })) as {
      success?: boolean;
    };
    expect(reg.success).toBe(true);
  }, 240000);

  afterAll(async () => {
    if (!HAS_TOKEN) return;
    await lss.lifecycle.stop().catch(() => undefined);
    await execAsync('docker rm -f $(docker ps -aq --filter name=lss-localstack-4598) 2>/dev/null || true').catch(() => undefined);
    await execAsync('docker volume rm lss-localstack-4598-data 2>/dev/null || true').catch(() => undefined);
    await execAsync('rm -rf tests/.lss-client-integration 2>/dev/null || true').catch(() => undefined);
  }, 60000);

  describe('config & health', () => {
    it('discovers the isolated instance port from the config file', () => {
      expect(lss.baseUrl).toBe('http://localhost:3398');
    });

    it('reports healthy via health.get() and RUNNING via lifecycle.status()', async () => {
      expect((await lss.health.get()).localstack).toBe(true);
      expect((await lss.lifecycle.status()).running).toBe(true);
    });

    it('exposes the isolated config snapshot (no token leak)', async () => {
      const cfg = (await lss.config.get()) as { serverPort: number; localstack: { port: number } };
      expect(cfg.serverPort).toBe(3398);
      expect(cfg.localstack.port).toBe(4598);
      expect(JSON.stringify(cfg)).not.toContain(process.env.LOCALSTACK_AUTH_TOKEN);
    });

    it('returns a non-empty log tail via lifecycle.logs()', async () => {
      expect((await lss.lifecycle.logs()).raw.length).toBeGreaterThan(0);
    });
  });

  describe('resources', () => {
    it('lists provisioned resources and maps owners', async () => {
      const blob = JSON.stringify(await lss.resources.list());
      for (const name of ['sample-microservice-Users', 'sample-microservice-Orders', QUEUE, BUCKET]) {
        expect(blob).toContain(name);
      }
      expect(JSON.stringify(await lss.resources.owners())).toContain('sample-microservice');
    });
  });

  describe('seeds + dynamo', () => {
    it('seeds via the client and the items are scannable', async () => {
      const run = await lss.seeds.run();
      expect(Array.isArray(run.results)).toBe(true);

      const list = await lss.seeds.list();
      expect(Array.isArray(list.entries)).toBe(true);

      const tables = await lss.dynamo.listTables();
      expect(tables.tables.some((t) => t.name === 'sample-microservice-Users')).toBe(true);

      const scan = await lss.dynamo.scan('sample-microservice-Users');
      expect(scan.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('queues', () => {
    it('lists the queue with its consumer mapping', async () => {
      expect(Array.isArray(await lss.queues.list())).toBe(true);
      const q = await lss.queues.get(QUEUE);
      expect(q.consumers.length).toBeGreaterThanOrEqual(1);
    });

    it('awaits an already-idle queue (drained:true)', async () => {
      const res = await lss.queues.awaitIdle(QUEUE, { timeoutMs: 8000 });
      expect(res.drained).toBe(true);
    });

    it('holds, captures a produced message, then releases', async () => {
      await lss.queues.hold(QUEUE);
      await lss.queues.send(QUEUE, { body: 'client-held' });
      let captured: Awaited<ReturnType<typeof lss.queues.captured>> = [];
      await waitFor(async () => {
        captured = await lss.queues.captured(QUEUE);
        return captured.some((m) => m.body === 'client-held');
      }, 15000, 1000);
      expect(captured.some((m) => m.body === 'client-held')).toBe(true);
      await lss.queues.release(QUEUE);
    });
  });

  describe('s3 object round-trip (getObject returns a Buffer)', () => {
    it('uploads, lists, reads and deletes an object', async () => {
      const key = 'incoming/client.txt';
      await lss.buckets.putObject(BUCKET, { key, body: 'hello-client' });
      expect(JSON.stringify(await lss.buckets.listObjects(BUCKET, { prefix: 'incoming' }))).toContain('client.txt');
      const body = await lss.buckets.getObject(BUCKET, key);
      expect(Buffer.isBuffer(body)).toBe(true);
      expect(body.toString()).toBe('hello-client');
      await lss.buckets.deleteObject(BUCKET, key);
    });
  });
});
