// AWS::SSM::Parameter provisioning. The provisioner speaks the SSM wire
// directly (no SDK client), so this drives it against a REAL SelfEngineBackend
// — the parameter it creates is read back over the same wire — plus a stubbed
// fetch for the failure shapes a real engine never produces.
import http from 'http';
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
import type { SsmParameterResource } from '../../../src/server/services/cloudformation-parser';

const ssmResource = (over: Partial<SsmParameterResource> = {}): SsmParameterResource => ({
  type: 'ssm-parameter',
  logicalId: 'TableNameParam',
  name: '/acme/orders/table-name',
  parameterType: 'String',
  value: 'orders',
  tags: [],
  ...over,
});

function ssmCall(endpoint: string, operation: string, payload: unknown, region: string): Promise<Record<string, unknown>> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: '/', method: 'POST', agent: false,
      headers: {
        'x-amz-target': `AmazonSSM.${operation}`,
        'content-type': 'application/x-amz-json-1.1',
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${region}/ssm/aws4_request`,
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

describe('createSsmParameter (via provisionResources)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;
  let provisioner: ResourceProvisioner;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-prov-ssm-'));
    backend = new SelfEngineBackend({
      port: 0, dataDir, account: '000000000000', region: 'us-east-1',
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    });
    await backend.start();
    endpoint = backend.getEndpoint();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({
      endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    provisioner = ResourceProvisioner.getInstance();
    (provisioner as any).currentRegion = 'us-east-1';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates the parameter in the registration region with every declared property', async () => {
    (provisioner as any).currentRegion = 'eu-west-1';
    const outcome = await provisioner.provisionResources('orders', [ssmResource({
      parameterType: 'StringList',
      value: 'orders,orders-archive',
      description: 'Order tables',
      allowedPattern: '^[a-z,-]+$',
      tier: 'Standard',
      dataType: 'text',
      tags: [{ Key: 'team', Value: 'orders' }],
    })], { region: 'eu-west-1' });
    expect(outcome).toEqual({ provisioned: 1, warnings: [] });

    const got = await ssmCall(endpoint, 'GetParameter', { Name: '/acme/orders/table-name' }, 'eu-west-1');
    expect(got.Parameter).toMatchObject({ Type: 'StringList', Value: 'orders,orders-archive', Version: 1 });
    const described = await ssmCall(endpoint, 'DescribeParameters', {}, 'eu-west-1');
    expect((described.Parameters as Array<Record<string, unknown>>)[0]).toMatchObject({
      Description: 'Order tables', AllowedPattern: '^[a-z,-]+$', Tier: 'Standard',
    });
    const tags = await ssmCall(endpoint, 'ListTagsForResource', { ResourceType: 'Parameter', ResourceId: '/acme/orders/table-name' }, 'eu-west-1');
    expect(tags.TagList).toEqual([{ Key: 'team', Value: 'orders' }]);
    expect(console.log).toHaveBeenCalledWith('  ✓ Created SSM parameter: /acme/orders/table-name');
  });

  it('is idempotent: a re-registration keeps the existing value', async () => {
    await provisioner.provisionResources('orders', [ssmResource()]);
    const again = await provisioner.provisionResources('orders', [ssmResource({ value: 'changed' })]);
    expect(again).toEqual({ provisioned: 1, warnings: [] });
    const got = await ssmCall(endpoint, 'GetParameter', { Name: '/acme/orders/table-name' }, 'us-east-1');
    expect(got.Parameter).toMatchObject({ Value: 'orders', Version: 1 });
    expect(console.log).toHaveBeenCalledWith('  ⚠ SSM parameter already exists: /acme/orders/table-name');
  });

  it('reports an engine rejection as a non-fatal warning', async () => {
    const outcome = await provisioner.provisionResources('orders', [ssmResource({ name: '/aws/reserved' })]);
    expect(outcome.provisioned).toBe(0);
    expect(outcome.warnings).toEqual([expect.stringContaining('ssm-parameter "/aws/reserved" was NOT provisioned: ValidationException:')]);
  });

  it('reports a Value that is not a literal instead of storing it', async () => {
    const outcome = await provisioner.provisionResources('orders', [ssmResource({ value: undefined })]);
    expect(outcome.warnings).toEqual([expect.stringContaining('has no literal Value')]);
    const got = await ssmCall(endpoint, 'GetParameter', { Name: '/acme/orders/table-name' }, 'us-east-1');
    expect(got.__type).toBe('ParameterNotFound');
  });

  it('reports a non-JSON failure by HTTP status', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
    const outcome = await provisioner.provisionResources('orders', [ssmResource()]);
    expect(outcome.warnings).toEqual(['ssm-parameter "/acme/orders/table-name" was NOT provisioned: HTTP 502: Bad Gateway']);
  });

  it('falls back to the raw body when a JSON error carries no message', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"__type":"InternalServerError"}', { status: 500 }));
    const outcome = await provisioner.provisionResources('orders', [ssmResource()]);
    expect(outcome.warnings).toEqual([
      'ssm-parameter "/acme/orders/table-name" was NOT provisioned: InternalServerError: {"__type":"InternalServerError"}',
    ]);
  });
});
