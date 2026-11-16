// Lambda Web Functions, template side: the three parser arms (every spelling in
// tests/fixtures/web-functions-template.json), the Ref / Fn::GetAtt return
// values of the three types, and the environment pass that turns a sibling's
// `!Sub 'https://${Endpoint.DomainName}'` into the endpoint's local URL.
import fs from 'fs';
import path from 'path';
import {
  CloudFormationParser,
  webRevisionId,
  type Resource,
  type WebFunctionRevisionResource,
  type WebFunctionEndpointResource,
} from '../../../src/server/services/cloudformation-parser';
import {
  physicalValue,
  createPhysicalResolver,
  emptyRuntimeAttributes,
  EnvironmentResolver,
} from '../../../src/server/services/cfn-physical-values';

const template = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../fixtures/web-functions-template.json'), 'utf-8'),
);
const REGION = 'us-east-1';
const FN_ARN = 'arn:aws:lambda:us-east-1:000000000000:web-function/orders-web';

function parse(t: Record<string, unknown> = template, warnings: string[] = []): Resource[] {
  return new CloudFormationParser().parse(t as never, warnings, { region: REGION });
}

function byId<T extends Resource>(resources: Resource[], id: string): T {
  return resources.find(r => 'logicalId' in r && r.logicalId === id) as T;
}

describe('CloudFormationParser — web function arms', () => {
  it('parses the function, both revisions and the endpoint', () => {
    const warnings: string[] = [];
    const resources = parse(template, warnings);
    expect(byId(resources, 'OrdersWeb')).toEqual({
      type: 'web-function', logicalId: 'OrdersWeb', name: 'orders-web', tags: { team: 'orders' },
    });
    const stable = byId<WebFunctionRevisionResource>(resources, 'OrdersWebStable');
    expect(stable).toEqual({
      type: 'web-function-revision',
      logicalId: 'OrdersWebStable',
      name: 'OrdersWebStable',
      functionRef: 'OrdersWeb',
      revisionId: webRevisionId('OrdersWebStable', 'builds/orders-web.zip'),
      codeBucket: 'acme-artifacts',
      codeKey: 'builds/orders-web.zip',
      runtime: 'nodejs24.x',
      environment: { AWS_LAMBDA_NODEJS_ENTRYPOINT: 'app.js', ORDERS_TABLE: { Ref: 'OrdersTable' }, RELEASE: 'stable' },
      timeoutSeconds: 10,
      maxConcurrency: 8,
      description: 'stable',
    });
    // Literal FunctionName and AWS's defaults for an empty ServiceConfig.
    const canary = byId<WebFunctionRevisionResource>(resources, 'OrdersWebCanary');
    expect(canary.functionRef).toBe('orders-web');
    expect(canary.timeoutSeconds).toBe(30);
    expect(canary.maxConcurrency).toBe(64);
    expect(canary.environment).toEqual({});
    expect(byId<WebFunctionEndpointResource>(resources, 'OrdersWebLive')).toEqual({
      type: 'web-function-endpoint',
      logicalId: 'OrdersWebLive',
      name: 'live',
      functionRef: 'OrdersWeb',
      endpointType: 'HomeRegion',
      authType: 'IamAuth',
      // Fn::GetAtt as an array and as a dotted string both reduce to the logical id.
      revisionWeights: [
        { revisionRef: 'OrdersWebStable', weight: 90 },
        { revisionRef: 'OrdersWebCanary', weight: 10 },
      ],
    });
    expect(warnings.join('\n')).not.toMatch(/WebFunction/);
  });

  it('falls back to the logical id and AWS defaults for bare resources', () => {
    const resources = parse({
      Resources: {
        Fn: { Type: 'AWS::Lambda::WebFunction' },
        Rev: { Type: 'AWS::Lambda::WebFunctionRevision' },
        Ep: { Type: 'AWS::Lambda::WebFunctionEndpoint' },
      },
    });
    expect(byId(resources, 'Fn')).toEqual({ type: 'web-function', logicalId: 'Fn', name: 'Fn', tags: {} });
    expect(byId(resources, 'Rev')).toMatchObject({ functionRef: '', runtime: 'nodejs24.x', revisionId: webRevisionId('Rev', undefined) });
    expect(byId(resources, 'Rev')).not.toHaveProperty('codeKey');
    expect(byId(resources, 'Ep')).toMatchObject({ name: 'Ep', functionRef: '', endpointType: 'HomeRegion', authType: 'ApplicationManaged', revisionWeights: [] });
  });

  it('clamps out-of-range settings, skips malformed weights and ignores unreducible references', () => {
    const warnings: string[] = [];
    const resources = parse({
      Resources: {
        Rev: {
          Type: 'AWS::Lambda::WebFunctionRevision',
          Properties: {
            FunctionName: { 'Fn::ImportValue': 'other' },
            ServiceConfig: { TimeoutSeconds: 1000, MaxConcurrencyPerEnvironment: '0' },
          },
        },
        Ep: {
          Type: 'AWS::Lambda::WebFunctionEndpoint',
          Properties: {
            FunctionName: { Ref: 'Fn' },
            RevisionWeights: [{ RevisionId: 'abc' }, 'junk', { RevisionId: { 'Fn::GetAtt': [1] }, Weight: 5 }, { RevisionId: 'r1', Weight: '50' }],
          },
        },
      },
    }, warnings);
    expect(byId(resources, 'Rev')).toMatchObject({ functionRef: '', timeoutSeconds: 900, maxConcurrency: 1 });
    expect(byId<WebFunctionEndpointResource>(resources, 'Ep').revisionWeights).toEqual([{ revisionRef: 'r1', weight: 50 }]);
    expect(warnings.filter(w => w.includes('outside'))).toHaveLength(2);
    expect(warnings.filter(w => w.includes('RevisionWeights entry'))).toHaveLength(3);
  });

  it('derives a stable revision id that moves with the code key', () => {
    expect(webRevisionId('Rev', 'a.zip')).toBe(webRevisionId('Rev', 'a.zip'));
    expect(webRevisionId('Rev', 'a.zip')).not.toBe(webRevisionId('Rev', 'b.zip'));
    expect(webRevisionId('Rev', 'a.zip')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('physical values — web functions', () => {
  const resources = parse();
  const byLogicalId = new Map(resources.filter(r => 'logicalId' in r).map(r => [(r as { logicalId: string }).logicalId, r]));
  const runtime = emptyRuntimeAttributes();
  runtime.webEndpointPorts.set('OrdersWebLive', 15007);
  const value = (id: string, attr?: string) => physicalValue(byId(resources, id), attr, { region: REGION, runtime }, byLogicalId);
  const stableId = webRevisionId('OrdersWebStable', 'builds/orders-web.zip');

  it('answers every documented return value', () => {
    expect(value('OrdersWeb')).toBe(FN_ARN);
    expect(value('OrdersWeb', 'FunctionArn')).toBe(FN_ARN);
    expect(value('OrdersWeb', 'State')).toBe('Active');
    expect(value('OrdersWebStable')).toBe(`${FN_ARN}/revision/${stableId}`);
    expect(value('OrdersWebStable', 'RevisionArn')).toBe(`${FN_ARN}/revision/${stableId}`);
    expect(value('OrdersWebStable', 'RevisionId')).toBe(stableId);
    expect(value('OrdersWebStable', 'FunctionArn')).toBe(FN_ARN);
    expect(value('OrdersWebStable', 'State')).toBe('Active');
    expect(value('OrdersWebLive')).toBe(`${FN_ARN}/endpoint/live`);
    expect(value('OrdersWebLive', 'EndpointArn')).toBe(`${FN_ARN}/endpoint/live`);
    expect(value('OrdersWebLive', 'FunctionArn')).toBe(FN_ARN);
    expect(value('OrdersWebLive', 'DomainName')).toBe('localhost:15007');
    expect(value('OrdersWebLive', 'State')).toBe('Active');
    expect(value('OrdersWebLive', 'RegionalEndpoints')).toBeUndefined();
  });

  it('builds the function ARN from a literal name or ARN, and leaves DomainName unknown without a port', () => {
    const rev = byId<WebFunctionRevisionResource>(resources, 'OrdersWebCanary');
    expect(physicalValue(rev, 'FunctionArn', { region: REGION })).toBe(FN_ARN);
    const fromArn = { ...rev, functionRef: 'arn:aws:lambda:eu-west-1:1:web-function/x' };
    expect(physicalValue(fromArn, 'FunctionArn', { region: REGION })).toBe('arn:aws:lambda:eu-west-1:1:web-function/x');
    expect(physicalValue(byId(resources, 'OrdersWebLive'), 'DomainName', { region: REGION })).toBeUndefined();
  });

  it('resolves a sibling function environment to the local endpoint', () => {
    const warnings: string[] = [];
    const resolver = new EnvironmentResolver({ template, region: REGION, resources, runtime, warnings });
    const lambda = byId<Resource & { environment: Record<string, unknown> }>(resources, 'CheckWebFunction');
    expect(resolver.resolve(lambda.environment)).toEqual({
      ORDERS_WEB_URL: 'https://localhost:15007',
      ORDERS_WEB_ARN: FN_ARN,
      ORDERS_WEB_ENDPOINT_ARN: `${FN_ARN}/endpoint/live`,
      STABLE_REVISION: stableId,
      STABLE_REVISION_ARN: `${FN_ARN}/revision/${stableId}`,
    });
    expect(warnings).toEqual([]);
    expect(createPhysicalResolver(resources, { region: REGION, runtime })('OrdersWebLive', 'DomainName')).toBe('localhost:15007');
  });
});
