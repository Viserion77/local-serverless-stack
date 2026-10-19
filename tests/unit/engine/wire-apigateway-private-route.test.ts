// End-to-end on the REAL SelfEngineBackend and the REAL local gateway: a
// packaged template's usage plans and API key are provisioned into the engine's
// API Gateway control plane, and a `private: true` REST route then accepts
// exactly the keys AWS would — the one the template declared (generated value,
// in a plan covering this API and stage) — and refuses a missing key, a key in
// no plan, and the template key once it is disabled over the control-plane wire.
// Only the Lambda runtime is mocked (it forks workers); the key lookup goes
// through EngineManager.getApiGateway() exactly as in production.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import { EngineManager } from '../../../src/server/engine/engine-manager.js';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner.js';
import { CloudFormationParser } from '../../../src/server/services/cloudformation-parser.js';
import { GatewayManager } from '../../../src/server/services/gateway-manager.js';
import { FunctionRegistry } from '../../../src/server/services/function-registry.js';
import { LambdaRuntimeManager } from '../../../src/server/services/lambda-runtime-manager.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';
import type { RegisteredFunction } from '../../../src/server/services/serverless-state-parser.js';

const REGION = 'eu-west-1';
const SERVICE = 'acme-partners';
const FIXTURE = path.resolve(__dirname, '../../fixtures/apigw-usage-plans-template.json');
const invokeMock = (LambdaRuntimeManager.getInstance() as unknown as { invoke: jest.Mock }).invoke;

type Json = Record<string, any>;

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = http.createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const fnDef = (name: string): RegisteredFunction => ({
  name, fullName: `${SERVICE}-dev-${name}`, handler: `${name}.handler`, runtime: 'nodejs20.x',
  memorySize: 128, timeout: 6, environment: {}, triggers: [],
});

describe('wire: API keys on a private REST route (real engine + real gateway)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  let gatewayPort: number;
  let templateKey: Json;
  const gateway = new GatewayManager();
  const managerInternals = EngineManager.getInstance() as unknown as { backend: unknown };
  let savedBackend: unknown;

  const apigw = async (method: string, requestPath: string, body?: unknown): Promise<Json> => {
    const response = await fetch(new URL(requestPath, endpoint), {
      method,
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=test/20261019/${REGION}/apigateway/aws4_request, SignedHeaders=host, Signature=x`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return text ? JSON.parse(text) as Json : {};
  };

  const call = (headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${gatewayPort}/orders`, { headers });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-apigw-private-'));
    backend = new SelfEngineBackend({
      port: 0, dataDir, account: '000000000000', region: 'us-east-1',
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    } as Partial<ResolvedSelfEngineConfig>);
    await backend.start();
    endpoint = backend.getEndpoint();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({
      endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    // The production seam: the gateway reaches the emulator through the
    // EngineManager singleton, so point it at this backend.
    savedBackend = managerInternals.backend;
    managerInternals.backend = backend;

    // Provision the template exactly as registration does.
    const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const { resources } = new CloudFormationParser().parseTemplate(template, [], { region: REGION, stackName: `${SERVICE}-dev` });
    await ResourceProvisioner.getInstance().provisionResources(SERVICE, resources, { region: REGION });
    templateKey = ((await apigw('GET', '/apikeys?includeValues=true')).item as Json[])[0];

    // Serve one private REST route (HEADER key source) for the same region/stage.
    gatewayPort = await freePort();
    (FunctionRegistry as unknown as { instance: unknown }).instance = undefined;
    const entry = FunctionRegistry.getInstance().registerService({
      name: SERVICE, root: `/proj/${SERVICE}`, templateHash: 'h', lastUpdated: 1, status: 'registered',
      stage: 'dev', region: REGION, apiPort: gatewayPort,
      functions: [fnDef('listOrders')],
      routes: [{
        functionName: 'listOrders', method: 'GET', path: '/orders', eventType: 'http', cors: false,
        apiKeyRequired: true, apiKeySourceType: 'HEADER',
      }],
      authorizers: [],
    });
    await gateway.syncService(entry, true);
  });

  afterAll(async () => {
    await gateway.stopService(SERVICE);
    managerInternals.backend = savedBackend;
    (FunctionRegistry as unknown as { instance: unknown }).instance = undefined;
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true, payload: { statusCode: 200, body: 'orders' }, logs: [], durationMs: 1 });
  });

  const expectForbidden = async (response: Response) => {
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: 'Forbidden' });
    expect(invokeMock).not.toHaveBeenCalled();
  };

  it('refuses a request without a key', async () => {
    await expectForbidden(await call());
  });

  it('accepts the template key and stamps its identity on the event', async () => {
    const response = await call({ 'x-api-key': templateKey.value });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('orders');
    const event = invokeMock.mock.calls[0][2];
    expect(event.requestContext.identity).toEqual(
      expect.objectContaining({ apiKey: templateKey.value, apiKeyId: templateKey.id }),
    );
  });

  it('refuses a real key that is in no usage plan', async () => {
    const loose = await apigw('POST', '/apikeys', { name: 'loose', enabled: true, value: 'loose-key-0123456789abcdef' });
    expect(loose.id).toEqual(expect.any(String));
    await expectForbidden(await call({ 'x-api-key': 'loose-key-0123456789abcdef' }));
  });

  it('refuses the template key on the very next request once it is disabled, and accepts it again when re-enabled', async () => {
    await apigw('PATCH', `/apikeys/${templateKey.id}`, { patchOperations: [{ op: 'replace', path: '/enabled', value: 'false' }] });
    await expectForbidden(await call({ 'x-api-key': templateKey.value }));

    await apigw('PATCH', `/apikeys/${templateKey.id}`, { patchOperations: [{ op: 'replace', path: '/enabled', value: 'true' }] });
    expect((await call({ 'x-api-key': templateKey.value })).status).toBe(200);
  });

  it('answers 403 rather than 500 while the engine is unavailable', async () => {
    managerInternals.backend = null;
    try {
      await expectForbidden(await call({ 'x-api-key': templateKey.value }));
    } finally {
      managerInternals.backend = backend;
    }
  });
});
