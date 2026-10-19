// End-to-end against the REAL SelfEngineBackend: the API keys and usage plans
// `serverless package` emits for `provider.apiGateway` are parsed, provisioned
// and resolved into a function environment exactly as the registrar does it,
// then read back over the API Gateway rest-json wire and through the
// in-process contract the local gateway calls for `private: true` routes.
// Re-provisioning the same template must reuse every plan and key (same ids,
// same generated value, no duplicate memberships).

import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke: jest.fn() }) },
}));

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import { EngineManager } from '../../../src/server/engine/engine-manager.js';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner.js';
import { CloudFormationParser, type LambdaResource } from '../../../src/server/services/cloudformation-parser.js';
import { EnvironmentResolver } from '../../../src/server/services/cfn-physical-values.js';
import { LOCAL_API_ID } from '../../../src/server/services/api-gateway-events.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'eu-west-1';
const SERVICE = 'acme-partners';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };
const FIXTURE = path.resolve(__dirname, '../../fixtures/apigw-usage-plans-template.json');

type Json = Record<string, any>;

async function apigw(endpoint: string, requestPath: string, region = REGION): Promise<Json> {
  const response = await fetch(new URL(requestPath, endpoint), {
    headers: { authorization: `AWS4-HMAC-SHA256 Credential=test/20261019/${region}/apigateway/aws4_request, SignedHeaders=host, Signature=x` },
  });
  return response.json() as Promise<Json>;
}

describe('wire: API Gateway keys and usage plans from a packaged template (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  const provisioner = ResourceProvisioner.getInstance();

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-cfn-apigw-'));
    backend = new SelfEngineBackend({
      port: 0, dataDir, account: '000000000000', region: 'us-east-1',
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    } as Partial<ResolvedSelfEngineConfig>);
    await backend.start();
    endpoint = backend.getEndpoint();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({ endpoint, region: 'us-east-1', credentials: CREDS });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // parse → provision → env, the registrar's sequence.
  async function register(): Promise<{ env: Record<string, string>; warnings: string[] }> {
    const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const warnings: string[] = [];
    const context = { region: REGION, stackName: `${SERVICE}-dev` };
    const { resources } = new CloudFormationParser().parseTemplate(template, warnings, context);
    const outcome = await provisioner.provisionResources(SERVICE, resources, { region: REGION });
    warnings.push(...outcome.warnings);
    expect(outcome.provisioned).toBe(5);
    const lambda = resources.find(r => r.type === 'lambda') as LambdaResource;
    const env = new EnvironmentResolver({
      template,
      ...context,
      resources,
      runtime: await provisioner.lookupRuntimeAttributes(resources, SERVICE),
      warnings,
    }).resolve(lambda.environment);
    return { env, warnings };
  }

  it('provisions the plans, the key and its membership, and hands the function their ids', async () => {
    const { env, warnings } = await register();
    // The skipped summary no longer counts keys / plans (only the REST API
    // plumbing LSS serves from serverless-state.json).
    expect(warnings).toEqual([
      expect.stringMatching(/^Skipped 2 of 10 resource\(s\).*AWS::ApiGateway::Deployment ×1, AWS::ApiGateway::Resource ×1\./),
    ]);

    const plans = (await apigw(endpoint, '/usageplans')).item as Json[];
    expect(plans).toHaveLength(3);
    const byName = new Map(plans.map(p => [p.name, p]));
    const partners = byName.get('acme-partners-partners-dev')!;
    const internal = byName.get('acme-partners-internal-dev')!;
    const free = byName.get('acme-partners-free-dev')!;
    for (const plan of [partners, internal, free]) {
      expect(plan.apiStages).toEqual([{ apiId: LOCAL_API_ID, stage: 'dev' }]);
      expect(plan.tags).toMatchObject({ 'lss:stack': SERVICE });
    }
    expect(partners).toMatchObject({
      quota: { limit: 5000, offset: 2, period: 'MONTH' },
      throttle: { burstLimit: 200, rateLimit: 100 },
      tags: { tier: 'partners', 'lss:logical-id': 'ApiGatewayUsagePlanPartners' },
    });
    expect(internal.throttle).toEqual({ burstLimit: 50, rateLimit: 20 });
    expect(internal.quota).toBeUndefined();
    expect(free.throttle).toBeUndefined();
    expect(free.quota).toBeUndefined();

    const keys = (await apigw(endpoint, '/apikeys?includeValues=true')).item as Json[];
    expect(keys).toHaveLength(1);
    const [key] = keys;
    expect(key).toMatchObject({
      name: 'partners-key',
      enabled: true,
      stageKeys: [`${LOCAL_API_ID}/dev`],
      tags: { team: 'partners', 'lss:stack': SERVICE, 'lss:logical-id': 'ApiGatewayApiKeyPartners1' },
    });
    expect(key.value).toMatch(/^[A-Za-z0-9]{40}$/);

    expect(((await apigw(endpoint, `/usageplans/${partners.id}/keys`)).item as Json[]).map(k => k.id)).toEqual([key.id]);
    expect((await apigw(endpoint, `/usageplans?keyId=${key.id}`)).item.map((p: Json) => p.id)).toEqual([partners.id]);

    expect(env).toEqual({
      PARTNERS_USAGE_PLAN_ID: partners.id,
      INTERNAL_USAGE_PLAN_ID: internal.id,
      FREE_USAGE_PLAN_ID: free.id,
      PARTNERS_KEY_ID: key.id,
      REST_API_ID: LOCAL_API_ID,
    });

    // What the gateway sees on a request carrying the key — in this region only.
    const apiGateway = backend.getApiGateway();
    expect(await apiGateway.resolveApiKeyByValue(REGION, key.value)).toEqual({
      id: key.id,
      name: 'partners-key',
      enabled: true,
      usagePlans: [{ id: partners.id, name: 'acme-partners-partners-dev', apiStages: [{ apiId: LOCAL_API_ID, stage: 'dev' }] }],
    });
    expect(await apiGateway.resolveApiKeyByValue('us-east-1', key.value)).toBeUndefined();
  });

  it('is idempotent: re-provisioning reuses every id, the value and the membership', async () => {
    const before = {
      plans: (await apigw(endpoint, '/usageplans')).item as Json[],
      keys: (await apigw(endpoint, '/apikeys?includeValues=true')).item as Json[],
    };
    const partnersId = before.plans.find(p => p.name === 'acme-partners-partners-dev')!.id;
    const membersBefore = (await apigw(endpoint, `/usageplans/${partnersId}/keys`)).item;

    const { env } = await register();

    expect((await apigw(endpoint, '/usageplans')).item).toEqual(before.plans);
    expect((await apigw(endpoint, '/apikeys?includeValues=true')).item).toEqual(
      before.keys.map(k => ({ ...k, lastUpdatedDate: expect.any(Number) })),
    );
    expect((await apigw(endpoint, `/usageplans/${partnersId}/keys`)).item).toEqual(membersBefore);
    expect(env.PARTNERS_USAGE_PLAN_ID).toBe(partnersId);
    expect(env.PARTNERS_KEY_ID).toBe(before.keys[0].id);
  });

  it('removes everything tagged for the stack on teardown', async () => {
    const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const resources = new CloudFormationParser().parse(template, [], { region: REGION });
    (provisioner as any).currentRegion = REGION;
    await provisioner.cleanupResources(SERVICE, resources);
    expect((await apigw(endpoint, '/usageplans')).item).toEqual([]);
    expect((await apigw(endpoint, '/apikeys')).item).toEqual([]);
  });
});
