// aoss sidecar boot/shutdown: the OpenSearch Serverless emulator behind the
// engine router on its own listener. Real HTTP on an ephemeral port — the
// control plane (X-Amz-Target OpenSearchServerless.*), the data plane under
// /_aoss/<collection>, health aliases, port hygiene on close() and collection
// metadata persistence across restarts on the same dataDir.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { startAossSidecar } from '../../../src/server/engine/aoss-sidecar.js';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// Plain node:http with no agent so no keep-alive socket outlives a test.
function request(
  endpoint: string,
  method: string,
  pathName: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: pathName,
        method,
        headers: { connection: 'close', ...headers },
        agent: false,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function target(endpoint: string, operation: string, payload: unknown): Promise<HttpResult> {
  return request(
    endpoint,
    'POST',
    '/',
    { 'x-amz-target': `OpenSearchServerless.${operation}`, 'content-type': 'application/x-amz-json-1.0' },
    JSON.stringify(payload),
  );
}

function json(endpoint: string, method: string, pathName: string, payload: unknown): Promise<HttpResult> {
  return request(endpoint, method, pathName, { 'content-type': 'application/json' }, JSON.stringify(payload));
}

describe('aoss sidecar', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-aoss-sidecar-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  test('serves the aoss control plane and OpenSearch data plane end to end', async () => {
    const sidecar = await startAossSidecar({ port: 0, dataDir, region: 'us-east-1' });
    try {
      // The handle reflects the actually bound port, never the requested 0.
      expect(sidecar.port).toBeGreaterThan(0);
      expect(sidecar.endpoint).toBe(`http://localhost:${sidecar.port}`);

      // Health aliases the router serves for every engine listener.
      const health = await request(sidecar.endpoint, 'GET', '/_localstack/health');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body).services.aoss).toBe('available');
      const lssHealth = await request(sidecar.endpoint, 'GET', '/_lss/health');
      expect(lssHealth.status).toBe(200);

      // Control plane: CreateCollection → BatchGetCollection hands out a
      // collectionEndpoint on the ACTUAL bound port under /_aoss/<name>.
      const created = await target(sidecar.endpoint, 'CreateCollection', { name: 'products', type: 'SEARCH' });
      expect(created.status).toBe(200);
      expect(JSON.parse(created.body).createCollectionDetail.status).toBe('ACTIVE');

      const got = await target(sidecar.endpoint, 'BatchGetCollection', { names: ['products'] });
      expect(got.status).toBe(200);
      const detail = JSON.parse(got.body).collectionDetails[0];
      expect(detail.collectionEndpoint).toBe(`http://localhost:${sidecar.port}/_aoss/products`);

      // Data plane: index two docs, match one, aggregate over both.
      const indexed = await json(sidecar.endpoint, 'PUT', '/_aoss/products/catalog/_doc/1', {
        name: 'mechanical keyboard',
        price: 49,
      });
      expect(indexed.status).toBe(201);
      expect(JSON.parse(indexed.body).result).toBe('created');
      const indexed2 = await json(sidecar.endpoint, 'PUT', '/_aoss/products/catalog/_doc/2', {
        name: 'wireless mouse',
        price: 25,
      });
      expect(indexed2.status).toBe(201);

      const search = await json(sidecar.endpoint, 'POST', '/_aoss/products/catalog/_search', {
        query: { match: { name: 'keyboard' } },
      });
      expect(search.status).toBe(200);
      const searchBody = JSON.parse(search.body);
      expect(searchBody.hits.total.value).toBe(1);
      expect(searchBody.hits.hits[0]._source).toEqual({ name: 'mechanical keyboard', price: 49 });

      const agg = await json(sidecar.endpoint, 'POST', '/_aoss/products/catalog/_search', {
        size: 0,
        aggs: { avg_price: { avg: { field: 'price' } } },
      });
      expect(agg.status).toBe(200);
      expect(JSON.parse(agg.body).aggregations.avg_price.value).toBe(37);

      // Control plane again: DeleteCollection by the id BatchGetCollection returned.
      const deleted = await target(sidecar.endpoint, 'DeleteCollection', { id: detail.id });
      expect(deleted.status).toBe(200);
      expect(JSON.parse(deleted.body).deleteCollectionDetail.name).toBe('products');
    } finally {
      await sidecar.close();
    }

    // close() frees the port: the listener is gone and the port is bindable again.
    await expect(request(sidecar.endpoint, 'GET', '/_lss/health')).rejects.toThrow();
    const rebind = http.createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      rebind.once('error', reject);
      rebind.listen(sidecar.port, resolve);
    });
    expect((rebind.address() as AddressInfo).port).toBe(sidecar.port);
    await new Promise<void>(resolve => rebind.close(() => resolve()));
  });

  test('a second start on the same dataDir still sees persisted collection metadata', async () => {
    const first = await startAossSidecar({ port: 0, dataDir, region: 'us-east-1' });
    const created = await target(first.endpoint, 'CreateCollection', { name: 'survivors', type: 'TIMESERIES' });
    expect(created.status).toBe(200);
    await first.close();

    const second = await startAossSidecar({ port: 0, dataDir, region: 'us-east-1' });
    try {
      const got = await target(second.endpoint, 'BatchGetCollection', { names: ['survivors'] });
      expect(got.status).toBe(200);
      const details = JSON.parse(got.body).collectionDetails;
      expect(details).toHaveLength(1);
      expect(details[0].name).toBe('survivors');
      // The endpoint follows the NEW listener, not the closed one.
      expect(details[0].collectionEndpoint).toBe(`http://localhost:${second.port}/_aoss/survivors`);
    } finally {
      await second.close();
    }
  });

  test('EADDRINUSE fails fast naming the port and the aossSidecar.port knob', async () => {
    const squatter = http.createServer(() => undefined);
    await new Promise<void>(resolve => squatter.listen(0, resolve));
    const port = (squatter.address() as AddressInfo).port;
    try {
      await expect(startAossSidecar({ port, dataDir, region: 'us-east-1' })).rejects.toThrow(
        new RegExp(`port ${port}.*aossSidecar\\.port`, 's'),
      );
    } finally {
      await new Promise<void>(resolve => squatter.close(() => resolve()));
    }
  });
});
