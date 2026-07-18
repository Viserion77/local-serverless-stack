// Full-stack wire conformance for AWS::S3::Bucket CorsConfiguration applied at
// provision time. Boots the real SelfEngineBackend and drives exactly what
// ResourceProvisioner.createS3Bucket now does — CreateBucket then a single
// PutBucketCors with the template-derived rule, with NO other CORS/bootstrap
// call — then sends a raw browser OPTIONS preflight and asserts the configured
// rule (not the dev-permissive fallback) is in effect on first boot.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { S3Client, CreateBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(
  endpoint: string,
  method: string,
  pathName: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<HttpResult> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: pathName, method, headers: { connection: 'close', ...headers }, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: 'us-east-1',
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

describe('wire: S3 CorsConfiguration provisioned at boot (no bootstrap PutBucketCors)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-cors-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();

    const s3 = new S3Client({
      endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    // Exactly the two calls createS3Bucket issues for a CORS bucket — no
    // separate bootstrap PutBucketCors.
    await s3.send(new CreateBucketCommand({ Bucket: 'billing-receipts' }));
    await s3.send(new PutBucketCorsCommand({
      Bucket: 'billing-receipts',
      CORSConfiguration: {
        CORSRules: [{
          ID: 'receipts-cors',
          AllowedHeaders: ['*'],
          AllowedMethods: ['GET', 'PUT', 'POST'],
          AllowedOrigins: ['https://receipts.example.com'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 600,
        }],
      },
    }));
  });

  afterEach(async () => {
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the template rule on a preflight (allow-origin/methods/max-age)', async () => {
    const preflight = await request(endpoint, 'OPTIONS', '/billing-receipts', {
      origin: 'https://receipts.example.com',
      'access-control-request-method': 'POST',
    });
    expect(preflight.status).toBe(200);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://receipts.example.com');
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, PUT, POST');
    expect(preflight.headers['access-control-max-age']).toBe('600');
  });

  it('falls back to the dev-permissive default for an origin outside the rule', async () => {
    const preflight = await request(endpoint, 'OPTIONS', '/billing-receipts', {
      origin: 'https://evil.example.com',
      'access-control-request-method': 'POST',
    });
    expect(preflight.status).toBe(200);
    // Differs from the configured rule → proves the rule (not a blanket echo) matched.
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, PUT, POST, DELETE, HEAD');
    expect(preflight.headers['access-control-max-age']).toBe('3600');
  });
});
