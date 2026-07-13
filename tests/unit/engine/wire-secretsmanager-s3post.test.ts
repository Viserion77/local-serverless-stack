// Full-stack wire conformance for the two features that let a project retire
// LocalStack: Secrets Manager (JSON 1.1, X-Amz-Target routing, __type error
// framing) and S3 presigned POST (multipart/form-data to a bucket). These
// boot the real SelfEngineBackend HTTP front door and drive it exactly as the
// AWS SDK / a browser would — the layer no unit test covered before, which is
// why gaps like this used to reach users.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function sm(endpoint: string, operation: string, payload: unknown): Promise<HttpResult> {
  return request(endpoint, 'POST', '/', {
    'x-amz-target': `secretsmanager.${operation}`,
    'content-type': 'application/x-amz-json-1.1',
  }, Buffer.from(JSON.stringify(payload)));
}

function s3Auth(): Record<string, string> {
  // SigV4-shaped credential scope so the router resolves service=s3 for
  // signed operations (bucket create / object get).
  return { authorization: 'AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request' };
}

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: 'us-east-1',
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

describe('wire conformance: Secrets Manager', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-sm-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
  });

  afterEach(async () => {
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates, reads and rotates a secret over JSON 1.1', async () => {
    const created = await sm(endpoint, 'CreateSecret', { Name: 'app/signing-key', SecretString: 'key-v1' });
    expect(created.status).toBe(200);
    expect(created.headers['content-type']).toBe('application/x-amz-json-1.1');
    const createdJson = JSON.parse(created.body.toString());
    expect(createdJson.ARN).toContain(':secret:app/signing-key-');

    const got = JSON.parse((await sm(endpoint, 'GetSecretValue', { SecretId: 'app/signing-key' })).body.toString());
    expect(got.SecretString).toBe('key-v1');
    expect(got.VersionStages).toEqual(['AWSCURRENT']);

    await sm(endpoint, 'PutSecretValue', { SecretId: 'app/signing-key', SecretString: 'key-v2' });
    const current = JSON.parse((await sm(endpoint, 'GetSecretValue', { SecretId: 'app/signing-key' })).body.toString());
    expect(current.SecretString).toBe('key-v2');
    const previous = JSON.parse((await sm(endpoint, 'GetSecretValue', { SecretId: 'app/signing-key', VersionStage: 'AWSPREVIOUS' })).body.toString());
    expect(previous.SecretString).toBe('key-v1');
  });

  it('frames errors as JSON 1.1 __type the SDK maps', async () => {
    await sm(endpoint, 'CreateSecret', { Name: 'dup', SecretString: 'a' });

    const duplicate = await sm(endpoint, 'CreateSecret', { Name: 'dup', SecretString: 'b' });
    expect(duplicate.status).toBe(400);
    expect(JSON.parse(duplicate.body.toString()).__type).toContain('ResourceExistsException');

    const missing = await sm(endpoint, 'GetSecretValue', { SecretId: 'ghost' });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body.toString()).__type).toContain('ResourceNotFoundException');
  });

  it('appears in the LocalStack-compat health alias', async () => {
    const health = await request(endpoint, 'GET', '/_localstack/health');
    expect(JSON.parse(health.body.toString()).services.secretsmanager).toBe('available');
  });
});

describe('wire conformance: S3 presigned POST', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-post-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
    await request(endpoint, 'PUT', '/user-uploads', s3Auth());
  });

  afterEach(async () => {
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts a browser form upload and stores the object', async () => {
    const boundary = '----lssWireBoundary';
    const head = [
      `--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\navatars/\${filename}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="Content-Type"\r\n\r\nimage/png\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="success_action_status"\r\n\r\n201\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="x-amz-meta-owner"\r\n\r\nalice\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`,
    ].join('');
    const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const body = Buffer.concat([Buffer.from(head), fileBytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);

    const post = await request(endpoint, 'POST', '/user-uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    }, body);
    expect(post.status).toBe(201);
    expect(post.body.toString()).toContain('<Key>avatars/me.png</Key>');

    const got = await request(endpoint, 'GET', '/user-uploads/avatars/me.png', s3Auth());
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-amz-meta-owner']).toBe('alice');
    expect(Buffer.compare(got.body, fileBytes)).toBe(0);
  });

  it('303-redirects to success_action_redirect with bucket/key/etag', async () => {
    const boundary = '----lssRedirect';
    const head = [
      `--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\ndoc.txt\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="success_action_redirect"\r\n\r\nhttps://app.example.com/ok\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.txt"\r\n\r\n`,
    ].join('');
    const body = Buffer.concat([Buffer.from(head), Buffer.from('hello'), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const post = await request(endpoint, 'POST', '/user-uploads', {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    }, body);
    expect(post.status).toBe(303);
    const location = new URL(String(post.headers.location));
    expect(location.origin + location.pathname).toBe('https://app.example.com/ok');
    expect(location.searchParams.get('key')).toBe('doc.txt');
    expect(location.searchParams.get('bucket')).toBe('user-uploads');
  });
});
