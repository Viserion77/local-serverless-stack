// Full-stack wire conformance for SSM Parameter Store: boots the real
// SelfEngineBackend HTTP front door and drives it exactly as
// @aws-sdk/client-ssm does — AWS JSON 1.1, X-Amz-Target `AmazonSSM.<Op>`,
// region taken from the SigV4 credential scope, errors framed as JSON
// `__type`. The SDK client itself is not a dependency of this repo, so the
// requests are built by hand with the same headers it sends.

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
  json: Record<string, unknown>;
}

function ssm(endpoint: string, operation: string, payload: unknown, region?: string): Promise<HttpResult> {
  const url = new URL(endpoint);
  const headers: Record<string, string> = {
    connection: 'close',
    'x-amz-target': `AmazonSSM.${operation}`,
    'content-type': 'application/x-amz-json-1.1',
  };
  // The engine reads {region, service} from the credential scope and never
  // verifies the signature — a scope-shaped header is what the SDK sends.
  if (region) headers.authorization = `AWS4-HMAC-SHA256 Credential=test/20260101/${region}/ssm/aws4_request`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: '/', method: 'POST', headers, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json: body ? JSON.parse(body) : {} });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

function makeConfig(dataDir: string, persistence = false): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: 'us-east-1',
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence,
  };
}

describe('wire conformance: SSM Parameter Store', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-ssm-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
  });

  afterEach(async () => {
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('puts, overwrites and reads parameters over JSON 1.1', async () => {
    const created = await ssm(endpoint, 'PutParameter', {
      Name: '/acme/orders/db-password', Value: 'pw-1', Type: 'SecureString',
    });
    expect(created.status).toBe(200);
    expect(created.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(created.json).toEqual({ Version: 1, Tier: 'Standard' });

    await ssm(endpoint, 'PutParameter', { Name: '/acme/orders/db-password', Value: 'pw-2', Overwrite: true });
    await ssm(endpoint, 'PutParameter', { Name: '/acme/orders/table', Value: 'orders', Type: 'String' });

    const got = await ssm(endpoint, 'GetParameter', { Name: '/acme/orders/db-password', WithDecryption: true });
    expect(got.json.Parameter).toMatchObject({
      Name: '/acme/orders/db-password',
      Type: 'SecureString',
      Value: 'pw-2',
      Version: 2,
      ARN: 'arn:aws:ssm:us-east-1:000000000000:parameter/acme/orders/db-password',
      DataType: 'text',
    });
    const encrypted = await ssm(endpoint, 'GetParameter', { Name: '/acme/orders/db-password' });
    expect((encrypted.json.Parameter as { Value: string }).Value).not.toBe('pw-2');

    const previous = await ssm(endpoint, 'GetParameter', { Name: '/acme/orders/db-password:1', WithDecryption: true });
    expect(previous.json.Parameter).toMatchObject({ Value: 'pw-1', Selector: ':1' });

    const byPath = await ssm(endpoint, 'GetParametersByPath', { Path: '/acme/orders', WithDecryption: true, MaxResults: 1 });
    expect((byPath.json.Parameters as Array<{ Name: string }>).map(p => p.Name)).toEqual(['/acme/orders/db-password']);
    const nextPage = await ssm(endpoint, 'GetParametersByPath', {
      Path: '/acme/orders', WithDecryption: true, MaxResults: 1, NextToken: byPath.json.NextToken,
    });
    expect((nextPage.json.Parameters as Array<{ Name: string }>).map(p => p.Name)).toEqual(['/acme/orders/table']);
    expect(nextPage.json.NextToken).toBeUndefined();

    const batch = await ssm(endpoint, 'GetParameters', { Names: ['/acme/orders/table', '/acme/ghost'] });
    expect(batch.json.InvalidParameters).toEqual(['/acme/ghost']);
  });

  it('frames errors as JSON 1.1 __type the SDK maps', async () => {
    await ssm(endpoint, 'PutParameter', { Name: '/acme/dup', Value: 'a', Type: 'String' });

    const duplicate = await ssm(endpoint, 'PutParameter', { Name: '/acme/dup', Value: 'b', Type: 'String' });
    expect(duplicate.status).toBe(400);
    expect(duplicate.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(duplicate.json.__type).toBe('ParameterAlreadyExists');

    const missing = await ssm(endpoint, 'GetParameter', { Name: '/acme/ghost' });
    expect(missing.status).toBe(400);
    expect(missing.json.__type).toBe('ParameterNotFound');

    const reserved = await ssm(endpoint, 'PutParameter', { Name: '/aws/reserved', Value: 'x', Type: 'String' });
    expect(reserved.json.__type).toBe('ValidationException');

    const malformed = await ssm(endpoint, 'GetParameter', { Name: '/acme/dup:99' });
    expect(malformed.json.__type).toBe('ParameterVersionNotFound');
  });

  it('routes by the credential-scope region', async () => {
    await ssm(endpoint, 'PutParameter', { Name: '/acme/regional', Value: 'eu', Type: 'String' }, 'eu-west-1');
    const inEu = await ssm(endpoint, 'GetParameter', { Name: '/acme/regional' }, 'eu-west-1');
    expect(inEu.json.Parameter).toMatchObject({
      Value: 'eu', ARN: 'arn:aws:ssm:eu-west-1:000000000000:parameter/acme/regional',
    });
    const inDefault = await ssm(endpoint, 'GetParameter', { Name: '/acme/regional' });
    expect(inDefault.json.__type).toBe('ParameterNotFound');
  });

  it('answers an unimplemented SSM operation with an explicit NotImplemented', async () => {
    const res = await ssm(endpoint, 'SendCommand', {});
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe('NotImplemented');
    expect(res.json.message).toContain('ssm.SendCommand');
  });

  it('appears in the health detail and the LocalStack-compat health alias', async () => {
    expect(backend.healthDetail().services).toContain('ssm');
    const url = new URL(endpoint);
    const health = await new Promise<Record<string, unknown>>((resolve, reject) => {
      http.get({ hostname: url.hostname, port: url.port, path: '/_localstack/health', agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }).on('error', reject);
    });
    expect((health.services as Record<string, string>).ssm).toBe('available');
  });
});

describe('wire conformance: SSM persistence across restarts', () => {
  it('keeps parameters and their history when the engine restarts', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-ssm-persist-'));
    try {
      let backend = new SelfEngineBackend(makeConfig(dataDir, true));
      await backend.start();
      await ssm(backend.getEndpoint(), 'PutParameter', { Name: '/acme/kept', Value: 'v1', Type: 'String' });
      await ssm(backend.getEndpoint(), 'PutParameter', { Name: '/acme/kept', Value: 'v2', Overwrite: true });
      await backend.stop();

      backend = new SelfEngineBackend(makeConfig(dataDir, true));
      await backend.start();
      try {
        const history = await ssm(backend.getEndpoint(), 'GetParameterHistory', { Name: '/acme/kept' });
        expect((history.json.Parameters as Array<{ Value: string }>).map(p => p.Value)).toEqual(['v1', 'v2']);
      } finally {
        await backend.stop();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
