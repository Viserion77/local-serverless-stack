// Full-stack wire conformance for the API Gateway (REST v1) control plane:
// boots the real SelfEngineBackend HTTP front door and drives it exactly as
// @aws-sdk/client-api-gateway does — rest-json paths and bodies, region and
// service taken from the SigV4 credential scope (signing name `apigateway`),
// errors framed as `x-amzn-ErrorType` + `{ message }`. The SDK client itself
// is not a dependency of this repo, so the requests are built by hand with the
// same headers it sends.

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
  rawHeaders: string[];
  text: string;
  json: Record<string, unknown>;
}

type Json = Record<string, unknown>;

function send(
  endpoint: string,
  method: string,
  requestPath: string,
  options: { body?: unknown; service?: string; region?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const url = new URL(endpoint);
  const service = options.service ?? 'apigateway';
  const region = options.region ?? 'us-east-1';
  const headers: Record<string, string> = {
    connection: 'close',
    // The engine reads {region, service} from the credential scope and never
    // verifies the signature — a scope-shaped header is what the SDK sends.
    authorization: `AWS4-HMAC-SHA256 Credential=test/20261018/${region}/${service}/aws4_request, SignedHeaders=host, Signature=x`,
    ...options.headers,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: requestPath, method, headers, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Json = {};
          try {
            json = text ? JSON.parse(text) as Json : {};
          } catch {
            // XML (S3) bodies are asserted through `text`.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

function reset(endpoint: string, query = ''): Promise<HttpResult> {
  return send(endpoint, 'POST', `/_lss/reset${query}`, { headers: { 'x-lss-confirm-reset': 'true' } });
}

function makeConfig(dataDir: string, persistence = false): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: 'us-east-1',
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence,
  };
}

describe('wire conformance: API Gateway control plane', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-apigw-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
  });

  afterEach(async () => {
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('drives keys, plans and plan membership end to end', async () => {
    const created = await send(endpoint, 'POST', '/apikeys', { body: { name: 'acme-partner', enabled: true } });
    expect(created.status).toBe(201);
    expect(created.headers['content-type']).toBe('application/json');
    const key = created.json;
    expect(key.id).toMatch(/^[a-z0-9]{10}$/);
    expect(key.value).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(typeof key.createdDate).toBe('number');

    const plan = await send(endpoint, 'POST', '/usageplans', {
      body: {
        name: 'partners', apiStages: [{ apiId: 'orders-api', stage: 'dev' }],
        throttle: { burstLimit: 10, rateLimit: 5.5 }, quota: { limit: 1000, period: 'DAY' },
      },
    });
    expect(plan.status).toBe(201);
    expect(plan.json.id).toMatch(/^[a-z0-9]{6}$/);
    await send(endpoint, 'POST', '/usageplans', { body: { name: 'unrelated' } });

    const member = await send(endpoint, 'POST', `/usageplans/${plan.json.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
    expect(member.status).toBe(201);
    expect(member.json).toEqual({ id: key.id, type: 'API_KEY', name: 'acme-partner', value: key.value });

    const byKey = await send(endpoint, 'GET', `/usageplans?keyId=${key.id}`);
    expect(byKey.status).toBe(200);
    expect((byKey.json.item as Json[]).map(p => p.id)).toEqual([plan.json.id]);
    expect(byKey.json.items).toBeUndefined();

    const disabled = await send(endpoint, 'PATCH', `/apikeys/${key.id}`, {
      body: { patchOperations: [{ op: 'replace', path: '/enabled', value: 'false' }] },
    });
    expect([disabled.status, disabled.json.enabled]).toEqual([200, false]);

    const withValues = await send(endpoint, 'GET', '/apikeys?includeValues=true&name=acme');
    expect((withValues.json.item as Json[])[0]).toMatchObject({ id: key.id, value: key.value, enabled: false });
    const withoutValues = await send(endpoint, 'GET', '/apikeys');
    expect((withoutValues.json.item as Json[])[0].value).toBeUndefined();
    const planKeys = await send(endpoint, 'GET', `/usageplans/${plan.json.id}/keys`);
    expect((planKeys.json.item as Json[])[0].value).toBe(key.value);

    // The in-process contract the local gateway enforces with.
    expect(await backend.getApiGateway().resolveApiKeyByValue('us-east-1', key.value as string)).toEqual({
      id: key.id, name: 'acme-partner', enabled: false,
      usagePlans: [{ id: plan.json.id, name: 'partners', apiStages: [{ apiId: 'orders-api', stage: 'dev' }] }],
    });

    const deleted = await send(endpoint, 'DELETE', `/apikeys/${key.id}`);
    expect([deleted.status, deleted.text]).toEqual([202, '']);
    expect((await send(endpoint, 'GET', `/usageplans?keyId=${key.id}`)).json.item).toEqual([]);
    expect((await send(endpoint, 'GET', `/usageplans/${plan.json.id}/keys`)).json.item).toEqual([]);

    expect((await send(endpoint, 'DELETE', `/usageplans/${plan.json.id}`)).status).toBe(202);
  });

  it('frames errors as rest-json with x-amzn-ErrorType and a single Date header', async () => {
    const missing = await send(endpoint, 'GET', '/apikeys/nosuchkey0');
    expect(missing.status).toBe(404);
    expect(missing.headers['x-amzn-errortype']).toBe('NotFoundException');
    expect(missing.headers['content-type']).toBe('application/json');
    expect(typeof missing.json.message).toBe('string');
    expect(missing.rawHeaders.filter(name => name.toLowerCase() === 'date')).toHaveLength(1);

    await send(endpoint, 'POST', '/apikeys', { body: { value: 'acme-orders-value-000000' } });
    const duplicate = await send(endpoint, 'POST', '/apikeys', { body: { value: 'acme-orders-value-000000' } });
    expect([duplicate.status, duplicate.headers['x-amzn-errortype']]).toEqual([409, 'ConflictException']);

    const badLimit = await send(endpoint, 'GET', '/apikeys?limit=501');
    expect([badLimit.status, badLimit.headers['x-amzn-errortype']]).toEqual([400, 'BadRequestException']);

    const restApis = await send(endpoint, 'GET', '/restapis');
    expect([restApis.status, restApis.headers['x-amzn-errortype']]).toEqual([501, 'NotImplemented']);
    expect(restApis.json.message).toContain('apigateway.GET /restapis');
  });

  it('pages with a stable cursor and omits position on the last page', async () => {
    for (let i = 0; i < 5; i += 1) await send(endpoint, 'POST', '/apikeys', { body: { name: `orders-${i}` } });
    const seen: string[] = [];
    let position: string | undefined;
    do {
      const page = await send(endpoint, 'GET', `/apikeys?limit=2${position ? `&position=${encodeURIComponent(position)}` : ''}`);
      const ids = (page.json.item as Json[]).map(k => k.id as string);
      seen.push(...ids);
      for (const id of ids) await send(endpoint, 'DELETE', `/apikeys/${id}`);
      position = page.json.position as string | undefined;
    } while (position);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('tags a key by its ARN, with repeated tagKeys on untag', async () => {
    const key = (await send(endpoint, 'POST', '/apikeys', { body: { tags: { team: 'orders' } } })).json;
    const arn = encodeURIComponent(`arn:aws:apigateway:us-east-1::/apikeys/${key.id}`);
    expect((await send(endpoint, 'PUT', `/tags/${arn}`, { body: { tags: { env: 'dev', tier: 'gold' } } })).status).toBe(204);
    expect((await send(endpoint, 'DELETE', `/tags/${arn}?tagKeys=team&tagKeys=tier`)).status).toBe(204);
    expect((await send(endpoint, 'GET', `/tags/${arn}`)).json).toEqual({ tags: { env: 'dev' } });
  });

  it('leaves S3 and the Lambda REST paths routed as before', async () => {
    const bucket = await send(endpoint, 'GET', '/apikeys?list-type=2', { service: 's3' });
    expect(bucket.status).toBe(404);
    expect(bucket.text).toContain('<Code>NoSuchBucket</Code>');
    const fn = await send(endpoint, 'GET', '/2015-03-31/functions/acme-ghost', { service: 'lambda' });
    expect(fn.status).toBe(404);
    expect(fn.headers['x-amzn-errortype']).toBe('ResourceNotFoundException');
  });

  it('is wiped by POST /_lss/reset, and alone by ?service=apigateway', async () => {
    const before = backend.getApiGateway();
    await send(endpoint, 'POST', '/apikeys', { body: { value: 'acme-reset-value-0000000' } });
    expect((await reset(endpoint)).status).toBe(200);
    expect((await send(endpoint, 'GET', '/apikeys')).json.item).toEqual([]);
    // reset() rebuilds the emulators: the accessor hands out the new one.
    expect(backend.getApiGateway()).not.toBe(before);
    expect(await backend.getApiGateway().resolveApiKeyByValue('us-east-1', 'acme-reset-value-0000000')).toBeUndefined();

    // Per-service: API Gateway goes, a Secrets Manager secret stays.
    await send(endpoint, 'POST', '/apikeys', { body: { name: 'gone' } });
    const sm = (op: string, body: Json) => new Promise<HttpResult>((resolve, reject) => {
      const url = new URL(endpoint);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: '/', method: 'POST', agent: false,
        headers: { 'x-amz-target': `secretsmanager.${op}`, 'content-type': 'application/x-amz-json-1.1', connection: 'close' },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, text, json: JSON.parse(text) as Json });
        });
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    expect((await sm('CreateSecret', { Name: 'acme/db', SecretString: 'x' })).status).toBe(200);

    const scoped = await reset(endpoint, '?service=apigateway');
    expect(scoped.status).toBe(200);
    expect(scoped.json).toEqual({ status: 'reset', engine: 'self', persistence: false, service: 'apigateway' });
    expect((await send(endpoint, 'GET', '/apikeys')).json.item).toEqual([]);
    expect(((await sm('ListSecrets', {})).json.SecretList as Json[]).map(s => s.Name)).toEqual(['acme/db']);

    const unsupported = await reset(endpoint, '?service=dynamodb');
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.__type).toBe('InvalidParameterValue');
    expect(unsupported.json.message).toContain('supported: apigateway');
    expect((await reset(endpoint, '?service=nope')).status).toBe(400);
  });

  it('appears in the health detail and the LocalStack-compat health alias', async () => {
    expect(backend.healthDetail().services).toContain('apigateway');
    const health = await send(endpoint, 'GET', '/_localstack/health');
    expect((health.json.services as Record<string, string>).apigateway).toBe('available');
  });
});

describe('SelfEngineBackend.resetService', () => {
  it('refuses while stopped and waits for a whole-engine reset in flight', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-apigw-reset-'));
    const backend = new SelfEngineBackend(makeConfig(dataDir));
    try {
      await expect(backend.resetService('apigateway')).rejects.toThrow('The self engine is not running');
      await backend.start();
      await send(backend.getEndpoint(), 'POST', '/apikeys', { body: { name: 'pending' } });
      const full = backend.reset();
      await backend.resetService('apigateway');
      await full;
      expect((await send(backend.getEndpoint(), 'GET', '/apikeys')).json.item).toEqual([]);
    } finally {
      await backend.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('wire conformance: API Gateway persistence across restarts', () => {
  it('keeps keys, plans and memberships when the engine restarts', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-apigw-persist-'));
    try {
      let backend = new SelfEngineBackend(makeConfig(dataDir, true));
      expect(() => backend.getApiGateway()).toThrow('The self engine is not running');
      await backend.start();
      const key = (await send(backend.getEndpoint(), 'POST', '/apikeys', {
        body: { name: 'kept', enabled: true, value: 'acme-kept-value-00000000' },
      })).json;
      const plan = (await send(backend.getEndpoint(), 'POST', '/usageplans', { body: { name: 'kept-plan' } })).json;
      await send(backend.getEndpoint(), 'POST', `/usageplans/${plan.id}/keys`, { body: { keyId: key.id, keyType: 'API_KEY' } });
      await backend.stop();

      backend = new SelfEngineBackend(makeConfig(dataDir, true));
      await backend.start();
      try {
        const got = await send(backend.getEndpoint(), 'GET', `/apikeys/${key.id}?includeValue=true`);
        expect(got.json).toMatchObject({ name: 'kept', enabled: true, value: 'acme-kept-value-00000000' });
        expect(await backend.getApiGateway().resolveApiKeyByValue('us-east-1', 'acme-kept-value-00000000')).toMatchObject({
          id: key.id, usagePlans: [{ id: plan.id, name: 'kept-plan' }],
        });
        // The uniqueness index was rebuilt before the first write.
        const duplicate = await send(backend.getEndpoint(), 'POST', '/apikeys', { body: { value: 'acme-kept-value-00000000' } });
        expect(duplicate.status).toBe(409);

        expect((await reset(backend.getEndpoint())).status).toBe(200);
        expect((await send(backend.getEndpoint(), 'GET', '/apikeys')).json.item).toEqual([]);
      } finally {
        await backend.stop();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
