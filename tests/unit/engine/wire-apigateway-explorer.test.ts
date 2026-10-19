// End-to-end proof for the dashboard's API Gateway explorer: boots a real
// SelfEngineBackend, writes keys and usage plans through the rest-json control
// plane exactly as @aws-sdk/client-api-gateway would (the SDK itself is not a
// dependency of this repo), then reads them back through ApiGatewayExplorer —
// pagination past one 500-item page, plan membership, values kept out of the
// lists, the reveal path and region isolation all against the real emulator.

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import { EngineManager } from '../../../src/server/engine/engine-manager.js';
import { ApiGatewayExplorer } from '../../../src/server/services/apigateway-explorer.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

type Json = Record<string, unknown>;

async function send(endpoint: string, method: string, requestPath: string, body?: unknown, region = 'us-east-1'): Promise<Json> {
  const response = await fetch(`${endpoint}${requestPath}`, {
    method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=test/20261019/${region}/apigateway/aws4_request, SignedHeaders=host, Signature=x`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${requestPath} → ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as Json;
}

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: 'us-east-1',
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

describe('wire: ApiGatewayExplorer against the self engine', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  const explorer = ApiGatewayExplorer.getInstance();

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-apigw-explorer-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({
      endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    (explorer as any).defaultRegion = 'us-east-1';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists keys with their plans, plans with their stages, and reveals only on request', async () => {
    const partner = await send(endpoint, 'POST', '/apikeys', { name: 'acme-partner', enabled: true, customerId: 'acme' });
    const internal = await send(endpoint, 'POST', '/apikeys', { name: 'acme-internal' });
    const plan = await send(endpoint, 'POST', '/usageplans', {
      name: 'partners',
      apiStages: [{ apiId: 'orders-api', stage: 'dev' }],
      throttle: { burstLimit: 10, rateLimit: 5 },
      quota: { limit: 1000, period: 'DAY' },
    });
    await send(endpoint, 'POST', '/usageplans', { name: 'empty-plan' });
    await send(endpoint, 'POST', `/usageplans/${plan.id}/keys`, { keyId: partner.id, keyType: 'API_KEY' });

    const keys = await explorer.listApiKeys();
    expect(keys.map(k => [k.name, k.enabled, k.usagePlans.map(p => p.name)])).toEqual([
      ['acme-internal', false, []],
      ['acme-partner', true, ['partners']],
    ]);
    expect(keys[1].customerId).toBe('acme');
    expect(typeof keys[1].createdDate).toBe('string');
    // Neither list carries key material.
    const listed = JSON.stringify(keys) + JSON.stringify(await explorer.listUsagePlans());
    expect(listed).not.toContain(String(partner.value));
    expect(listed).not.toContain(String(internal.value));

    const plans = await explorer.listUsagePlans();
    expect(plans.map(p => [p.name, p.keyCount])).toEqual([['empty-plan', 0], ['partners', 1]]);
    expect(plans[1]).toMatchObject({
      apiStages: [{ apiId: 'orders-api', stage: 'dev' }],
      throttle: { burstLimit: 10, rateLimit: 5 },
      quota: { limit: 1000, period: 'DAY' },
    });

    expect(await explorer.getApiKeyValue(String(partner.id))).toEqual({
      id: partner.id, name: 'acme-partner', value: partner.value,
    });
    expect(await explorer.getApiKeyValue('nosuchkey0')).toBeNull();
  });

  it('follows position past one 500-item page', async () => {
    for (let i = 0; i < 503; i++) await send(endpoint, 'POST', '/apikeys', { name: `acme-${String(i).padStart(3, '0')}` });
    const keys = await explorer.listApiKeys();
    expect(keys).toHaveLength(503);
    expect(new Set(keys.map(k => k.id)).size).toBe(503);
  });

  it('scopes reads to the requested region', async () => {
    await send(endpoint, 'POST', '/apikeys', { name: 'acme-eu' }, 'eu-west-1');
    expect(await explorer.listApiKeys()).toEqual([]);
    expect((await explorer.listApiKeys('eu-west-1')).map(k => k.name)).toEqual(['acme-eu']);
  });
});
