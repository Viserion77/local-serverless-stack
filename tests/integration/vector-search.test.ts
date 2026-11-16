// DynamoDB vector search end to end, through the real example: registers
// examples/self-hosted/catalog-service on an ISOLATED orchestrator (own ports
// + stateDir), lets the provisioner create `catalog-embeddings` with its
// vector index from CloudFormation (seeded from examples/self-hosted/seeds),
// then drives the service's own handlers — which call SearchVectors through
// the AWS SDK — and the explorer route the dashboard uses.
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CONFIG = 'tests/integration/fixtures/lss.vectors.config.json';
const BASE = 'http://localhost:14597';
const SERVICE_PATH = path.join(REPO_ROOT, 'examples/self-hosted/catalog-service');
// Not the example's committed 3634/13634, so a running demo stack never collides.
const API = 'http://localhost:3996';

function cli(args: string) {
  return execAsync(`node bin/cli.js ${args}`, { cwd: REPO_ROOT, env: process.env });
}

async function json(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(url, {
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

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond().catch(() => false)) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

describe('DynamoDB vector search (catalog example, integration)', () => {
  beforeAll(async () => {
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
    await cli(`start --config ${CONFIG}`);
    await waitFor(async () => (await json('GET', `${BASE}/api/health`)).data?.engineRunning === true, 60000, 250);
    const reg = await json('POST', `${BASE}/api/services/register`, { servicePath: SERVICE_PATH, apiPort: 3996, invokePort: 13996 });
    expect(reg.status).toBe(200);
    // The seed lands asynchronously after CreateTable.
    await waitFor(async () => (await json('GET', `${BASE}/api/dynamo/tables/catalog-embeddings`)).data?.itemCount === 8, 30000);
  }, 300000);

  afterAll(async () => {
    await cli(`stop --config ${CONFIG}`).catch(() => undefined);
    await execAsync('rm -rf tests/.lss-vectors-integration 2>/dev/null || true').catch(() => undefined);
  }, 60000);

  it('provisions the table with its vector index from the template', async () => {
    const { status, data } = await json('GET', `${BASE}/api/dynamo/tables/catalog-embeddings`);
    expect(status).toBe(200);
    expect(data.hasVectorIndex).toBe(true);
    expect(data.vectorIndexes[0]).toMatchObject({
      IndexName: 'ProductEmbeddingIndex', Dimensions: 8, DistanceFunction: 'COSINE', IndexStatus: 'ACTIVE', ItemCount: 8,
    });
  });

  it('returns the expected neighbours from the service handler, scoped to the category', async () => {
    const mouse = await json('GET', `${API}/products/p-100/similar?k=3`);
    expect(mouse.status).toBe(200);
    expect(mouse.data.similar[0].productId).toBe('p-101');
    // "Wireless Earbuds" shares the word "wireless" but lives in another partition.
    expect(mouse.data.similar.map((s: any) => s.productId)).not.toContain('p-201');
    const keyboard = await json('GET', `${API}/products/p-102/similar?k=1`);
    expect(keyboard.data.similar.map((s: any) => s.productId)).toEqual(['p-103']);
    const headphones = await json('GET', `${API}/products/p-200/similar?k=1`);
    expect(headphones.data.similar.map((s: any) => s.productId)).toEqual(['p-202']);
  });

  it('indexes a product written through the PUT handler', async () => {
    const put = await json('PUT', `${API}/products/p-105/embedding`, {
      name: 'Ergonomic Wireless Mouse', category: 'peripherals', description: 'wireless optical mouse with usb receiver',
    });
    expect(put.status).toBe(200);
    expect(put.data.embedding).toHaveLength(8);
    const similar = await json('GET', `${API}/products/p-105/similar?k=2`);
    expect(similar.data.similar.map((s: any) => s.productId)).toEqual(expect.arrayContaining(['p-100', 'p-101']));
  });

  it('answers the dashboard route with similarTo (item excluded) and a raw vector', async () => {
    const like = await json('POST', `${BASE}/api/dynamo/tables/catalog-embeddings/vector-search`, { similarTo: { productId: 'p-102' }, topK: 1 });
    expect(like.status).toBe(200);
    expect(like.data).toMatchObject({ indexName: 'ProductEmbeddingIndex', source: 'similarTo' });
    expect(like.data.results.map((r: any) => r.item.productId)).toEqual(['p-103']);

    const raw = await json('POST', `${BASE}/api/dynamo/tables/catalog-embeddings/vector-search`, {
      vector: [0, 0, 0, 0, 0, 0, 0, 1], topK: 2, filter: { category: 'audio' },
    });
    expect(raw.status).toBe(200);
    expect(raw.data.results.every((r: any) => r.item.category === 'audio')).toBe(true);

    const bad = await json('POST', `${BASE}/api/dynamo/tables/catalog-embeddings/vector-search`, { vector: [1, 2], filter: { category: 'audio' } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/SearchVector has 2 dimensions/);
  });
});
