// AWS::ApiGateway::UsagePlan / ApiKey / UsagePlanKey provisioning. The
// provisioner speaks the API Gateway rest-json wire directly (no SDK client),
// so this drives it against a REAL SelfEngineBackend — what it creates is read
// back over the same wire — plus a stubbed fetch for the failure shapes a real
// engine never produces. Reconciliation is by tag (`lss:stack`,
// `lss:logical-id`), so the cases here are the ones a re-registration meets:
// drift, removed resources, strays, another stack's items, failures.
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend';
import { EngineManager } from '../../../src/server/engine/engine-manager';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner';
import type {
  ApiKeyResource,
  Resource,
  UsagePlanKeyResource,
  UsagePlanResource,
} from '../../../src/server/services/cloudformation-parser';

type Json = Record<string, any>;
const REGION = 'us-east-1';

const plan = (over: Partial<UsagePlanResource> = {}): UsagePlanResource => ({
  type: 'apigw-usage-plan',
  logicalId: 'PartnersPlan',
  name: 'partners',
  apiStages: [{ apiId: 'lss-local', stage: 'dev' }],
  tags: {},
  ...over,
});

const key = (over: Partial<ApiKeyResource> = {}): ApiKeyResource => ({
  type: 'apigw-api-key',
  logicalId: 'PartnersKey',
  name: 'partners-key',
  enabled: true,
  stageKeys: [],
  tags: {},
  ...over,
});

const member = (over: Partial<UsagePlanKeyResource> = {}): UsagePlanKeyResource => ({
  type: 'apigw-usage-plan-key',
  logicalId: 'PartnersMember',
  name: 'PartnersMember',
  keyRef: 'PartnersKey',
  usagePlanRef: 'PartnersPlan',
  keyType: 'API_KEY',
  ...over,
});

describe('API Gateway usage plans and keys (via provisionResources)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  let provisioner: ResourceProvisioner;
  const realFetch = globalThis.fetch;

  async function call(method: string, requestPath: string, body?: unknown): Promise<Json> {
    const response = await realFetch(new URL(requestPath, endpoint), {
      method,
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=test/20261019/${REGION}/apigateway/aws4_request, SignedHeaders=host, Signature=x`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return text ? JSON.parse(text) as Json : {};
  }
  const plans = async (): Promise<Json[]> => (await call('GET', '/usageplans')).item;
  const keys = async (): Promise<Json[]> => (await call('GET', '/apikeys?includeValues=true')).item;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-prov-apigw-'));
    backend = new SelfEngineBackend({
      port: 0, dataDir, account: '000000000000', region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    });
    await backend.start();
    endpoint = backend.getEndpoint();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({
      endpoint, region: REGION, credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    provisioner = ResourceProvisioner.getInstance();
    (provisioner as any).currentRegion = REGION;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('makes no API Gateway call for a template without keys or plans', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const outcome = await provisioner.provisionResources('orders', [], { region: REGION });
    expect(outcome).toEqual({ provisioned: 0, warnings: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await provisioner.lookupRuntimeAttributes([plan()])).toMatchObject({ usagePlanIds: new Map() });
    expect(await provisioner.lookupRuntimeAttributes([member()], 'partners')).toMatchObject({ usagePlanIds: new Map() });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates plans and keys tagged with their stack and logical id, and the membership', async () => {
    const outcome = await provisioner.provisionResources('partners', [
      plan({ throttle: { burstLimit: 10, rateLimit: 5 }, quota: { limit: 100, period: 'DAY' }, tags: { tier: 'gold' }, description: 'Gold' }),
      key({ value: 'a-literal-key-value-of-some-length', customerId: 'acme-1', stageKeys: [{ restApiId: 'lss-local', stageName: 'dev' }] }),
      member(),
    ]);
    expect(outcome).toEqual({ provisioned: 3, warnings: [] });
    const [created] = await plans();
    expect(created).toMatchObject({
      name: 'partners',
      description: 'Gold',
      throttle: { burstLimit: 10, rateLimit: 5 },
      quota: { limit: 100, offset: 0, period: 'DAY' },
      tags: { tier: 'gold', 'lss:stack': 'partners', 'lss:logical-id': 'PartnersPlan' },
    });
    const [createdKey] = await keys();
    expect(createdKey).toMatchObject({
      value: 'a-literal-key-value-of-some-length', customerId: 'acme-1', enabled: true, stageKeys: ['lss-local/dev'],
    });
    expect((await call('GET', `/usageplans/${created.id}/keys`)).item.map((k: Json) => k.id)).toEqual([createdKey.id]);

    // The ids are found again by tag for the function environment.
    const attrs = await provisioner.lookupRuntimeAttributes([plan(), key()], 'partners');
    expect(attrs.usagePlanIds).toEqual(new Map([['PartnersPlan', created.id]]));
    expect(attrs.apiKeyIds).toEqual(new Map([['PartnersKey', createdKey.id]]));
    expect(console.log).toHaveBeenCalledWith(`  ✓ Created usage plan: partners (${created.id})`);
  });

  it('reuses what it created and patches drift back to the template', async () => {
    await provisioner.provisionResources('partners', [
      plan({ throttle: { burstLimit: 10, rateLimit: 5 }, quota: { limit: 100, period: 'DAY' } }),
      plan({ logicalId: 'OpenPlan', name: 'open' }),
      key({ stageKeys: [{ restApiId: 'lss-local', stageName: 'dev' }] }),
      member(),
    ]);
    const [before] = await keys();

    const outcome = await provisioner.provisionResources('partners', [
      plan({
        name: 'partners-v2',
        description: 'Now described',
        apiStages: [{ apiId: 'lss-local', stage: 'prod' }],
        throttle: { burstLimit: 20 },
        quota: { limit: 100, period: 'WEEK' },
      }),
      // Limits added where there were none.
      plan({ logicalId: 'OpenPlan', name: 'open', throttle: { rateLimit: 1 }, quota: { limit: 5, period: 'DAY' } }),
      key({ name: 'renamed', enabled: false, description: 'd', customerId: 'c', stageKeys: [{ restApiId: 'lss-local', stageName: 'prod' }] }),
      member(),
    ]);
    expect(outcome).toEqual({ provisioned: 4, warnings: [] });

    const after = await plans();
    expect(after).toHaveLength(2);
    expect(after.find(p => p.tags['lss:logical-id'] === 'PartnersPlan')).toMatchObject({
      name: 'partners-v2',
      description: 'Now described',
      apiStages: [{ apiId: 'lss-local', stage: 'prod' }],
      throttle: { burstLimit: 20, rateLimit: 5 },
      quota: { limit: 100, offset: 0, period: 'WEEK' },
    });
    expect(after.find(p => p.tags['lss:logical-id'] === 'OpenPlan')).toMatchObject({
      throttle: { rateLimit: 1 }, quota: { limit: 5, period: 'DAY' },
    });
    const [afterKey] = await keys();
    expect(afterKey).toMatchObject({
      id: before.id, value: before.value, name: 'renamed', enabled: false, description: 'd', customerId: 'c', stageKeys: ['lss-local/prod'],
    });

    // Limits the template drops are removed; nothing left to patch is logged as such.
    await provisioner.provisionResources('partners', [
      plan({ name: 'partners-v2', description: 'Now described', apiStages: [{ apiId: 'lss-local', stage: 'prod' }] }),
      plan({ logicalId: 'OpenPlan', name: 'open', throttle: { rateLimit: 1 }, quota: { limit: 5, period: 'DAY' } }),
      key({ name: 'renamed', enabled: false, description: 'd', customerId: 'c', stageKeys: [{ restApiId: 'lss-local', stageName: 'prod' }] }),
    ]);
    const stripped = (await plans()).find(p => p.tags['lss:logical-id'] === 'PartnersPlan')!;
    expect(stripped.throttle).toBeUndefined();
    expect(stripped.quota).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^ {2}⚠ Usage plan already exists: open \(/));
    expect(console.log).toHaveBeenCalledWith(`  ⚠ API key already exists: renamed (${before.id})`);
  });

  it('keeps the existing key value when the template Value changes, and says so', async () => {
    await provisioner.provisionResources('partners', [key({ value: 'a-literal-key-value-of-some-length' })]);
    const same = await provisioner.provisionResources('partners', [key({ value: 'a-literal-key-value-of-some-length' })]);
    expect(same.warnings).toEqual([]);
    const changed = await provisioner.provisionResources('partners', [key({ value: 'another-literal-key-value-entirely' })]);
    expect(changed.warnings).toEqual([expect.stringContaining('apigw-api-key "partners-key": the template\'s Value differs')]);
    expect((await keys()).map(k => k.value)).toEqual(['a-literal-key-value-of-some-length']);
  });

  it('removes what the template no longer declares and strays, never another stack\'s or untagged items', async () => {
    await provisioner.provisionResources('partners', [plan(), plan({ logicalId: 'Gone', name: 'gone' }), key(), key({ logicalId: 'GoneKey', name: 'gone-key' })]);
    // A stray sharing a logical id (a duplicate from an interrupted run), a
    // nameless orphan key, another stack's plan and a hand-made one.
    await call('POST', '/usageplans', { name: 'stray', tags: { 'lss:stack': 'partners', 'lss:logical-id': 'PartnersPlan' } });
    await call('POST', '/apikeys', { tags: { 'lss:stack': 'partners', 'lss:logical-id': 'Nameless' } });
    await call('POST', '/usageplans', { name: 'other', tags: { 'lss:stack': 'orders', 'lss:logical-id': 'PartnersPlan' } });
    await call('POST', '/usageplans', { name: 'manual', tags: { 'lss:stack': 'partners' } });
    const attrs = await provisioner.lookupRuntimeAttributes([plan()], 'partners');
    // With a stray present the first in id order is the one that is kept.
    const firstTagged = (await plans()).filter(p => p.tags['lss:stack'] === 'partners' && p.tags['lss:logical-id'] === 'PartnersPlan')[0];
    expect(attrs.usagePlanIds.get('PartnersPlan')).toBe(firstTagged.id);

    const outcome = await provisioner.provisionResources('partners', [plan(), key()]);
    expect(outcome).toEqual({ provisioned: 2, warnings: [] });
    expect((await plans()).map(p => p.name).sort()).toEqual(['manual', 'other', 'partners']);
    expect((await keys()).map(k => k.name)).toEqual(['partners-key']);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^Deleted API key "\w+" \(\w+, Nameless\)$/));
    // Whichever of the two survived, it now matches the template.
    expect((await plans()).find(p => p.id === firstTagged.id)!.name).toBe('partners');
  });

  it('reports creation failures and the memberships they leave unresolvable', async () => {
    const outcome = await provisioner.provisionResources('partners', [
      // No quota period: CreateUsagePlan rejects it.
      plan({ quota: { limit: 10 } }),
      key({ value: 'short' }),
      member(),
      member({ logicalId: 'Blank', keyRef: '', usagePlanRef: '' }),
      // Literal ids that do not exist.
      member({ logicalId: 'Literal', keyRef: 'k3y0000001', usagePlanRef: 'pl4n01' }),
    ]);
    expect(outcome.provisioned).toBe(0);
    expect(outcome.warnings).toEqual([
      expect.stringMatching(/^apigw-usage-plan "partners" was NOT provisioned: BadRequestException: Invalid quota period/),
      expect.stringMatching(/^apigw-api-key "partners-key" was NOT provisioned: BadRequestException: API Key value should be at least 20/),
      'apigw-usage-plan-key "PartnersMember" was NOT provisioned: its usage plan or API key (PartnersPlan / PartnersKey) is not available',
      'apigw-usage-plan-key "Blank" was NOT provisioned: its usage plan or API key (? / ?) is not available',
      'apigw-usage-plan-key "Literal" was NOT provisioned: NotFoundException: Invalid Usage Plan ID specified',
    ]);
  });

  it('keeps a reused plan and key when updating them fails', async () => {
    await provisioner.provisionResources('partners', [plan(), key()]);
    const [existingPlan] = await plans();
    // A quota period the engine rejects makes the PATCH fail.
    const outcome = await provisioner.provisionResources('partners', [plan({ quota: { period: 'YEAR' } }), key({ stageKeys: [{ restApiId: 'a/b', stageName: 'c' }] })]);
    expect(outcome.warnings).toEqual([
      expect.stringMatching(/^apigw-usage-plan "partners" was NOT provisioned: BadRequestException:/),
      expect.stringMatching(/^apigw-api-key "partners-key" was NOT provisioned: BadRequestException:/),
    ]);
    expect((await plans()).map(p => p.id)).toEqual([existingPlan.id]);
    expect(await keys()).toHaveLength(1);
  });

  it('skips the whole pass when the existing items cannot be listed', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const outcome = await provisioner.provisionResources('partners', [plan()]);
    expect(outcome).toEqual({
      provisioned: 0,
      warnings: ['API Gateway usage plans and keys were NOT provisioned (could not list the existing ones): connect ECONNREFUSED'],
    });
    // The lookup for the environment is best-effort too.
    const attrs = await provisioner.lookupRuntimeAttributes([key()], 'partners');
    expect(attrs.apiKeyIds.size).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not look up the API Gateway usage plans and keys of "partners"'));
  });

  it('frames non rest-json failures by HTTP status and body', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    expect((await provisioner.provisionResources('partners', [plan()])).warnings)
      .toEqual(['API Gateway usage plans and keys were NOT provisioned (could not list the existing ones): HTTP 502: Bad Gateway']);
    fetchSpy.mockResolvedValueOnce(new Response('{"code":"X"}', { status: 500, headers: { 'x-amzn-errortype': 'InternalFailure:http://internal' } }));
    expect((await provisioner.provisionResources('partners', [plan()])).warnings)
      .toEqual(['API Gateway usage plans and keys were NOT provisioned (could not list the existing ones): InternalFailure: {"code":"X"}']);
  });

  it('follows `position` through every page of a list', async () => {
    const apiCall = jest.spyOn(provisioner as any, 'apiGatewayCall')
      .mockResolvedValueOnce({ item: [{ id: 'a' }], position: 'cG9z' })
      .mockResolvedValueOnce({});
    expect(await (provisioner as any).listApiGateway('/usageplans', {})).toEqual([{ id: 'a' }]);
    expect(apiCall).toHaveBeenNthCalledWith(1, 'GET', '/usageplans', { query: { limit: '500' } });
    expect(apiCall).toHaveBeenNthCalledWith(2, 'GET', '/usageplans', { query: { limit: '500', position: 'cG9z' } });
  });

  describe('cleanupResources', () => {
    it('deletes every plan and key tagged for the service', async () => {
      await provisioner.provisionResources('partners', [plan(), key(), member()]);
      await call('POST', '/usageplans', { name: 'other', tags: { 'lss:stack': 'orders', 'lss:logical-id': 'PartnersPlan' } });
      await provisioner.cleanupResources('partners', [plan(), key(), member()] as Resource[]);
      expect((await plans()).map(p => p.name)).toEqual(['other']);
      expect(await keys()).toEqual([]);
      expect(console.log).toHaveBeenCalledWith('✅ Cleaned up 2 resources for partners');
    });

    it('reports listing and deletion failures without throwing', async () => {
      await provisioner.provisionResources('partners', [plan()]);
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      fetchSpy.mockRejectedValueOnce(new Error('down'));
      await provisioner.cleanupResources('partners', [member()]);
      expect(console.error).toHaveBeenCalledWith('Failed to cleanup the API Gateway usage plans and keys of partners:', 'down');

      fetchSpy.mockImplementation(async (input, init) => (init?.method === 'DELETE'
        ? new Response('{"message":"locked"}', { status: 409, headers: { 'x-amzn-errortype': 'ConflictException' } })
        : realFetch(input, init)));
      await provisioner.cleanupResources('partners', [plan()]);
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(
        /^Failed to cleanup usage plan "partners" \(\w+, PartnersPlan\) could not be removed: ConflictException: locked$/,
      ));
    });
  });
});
