// AWS::ApiGateway (REST v1) RestApi / UsagePlan / ApiKey / UsagePlanKey
// parsing. Pure parser: no I/O, no mocking — the templates are the shape
// `serverless package` emits for `provider.apiGateway.apiKeys` / `usagePlan`,
// plus the malformed and defaulted variants each reader has to survive.
import {
  CloudFormationParser,
  type ApiKeyResource,
  type Resource,
  type UsagePlanKeyResource,
  type UsagePlanResource,
} from '../../../src/server/services/cloudformation-parser';
import { LOCAL_API_ID } from '../../../src/server/services/api-gateway-events';

const parser = new CloudFormationParser();

function parse(resources: Record<string, unknown>, warnings: string[] = []): Resource[] {
  return parser.parse({ Resources: resources } as never, warnings);
}

describe('API Gateway keys and usage plans', () => {
  it('parses the serverless-packaged shape, with every Ref to the RestApi resolved to the local API id', () => {
    const warnings: string[] = [];
    const resources = parse({
      ApiGatewayRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'dev-acme-partners' } },
      ApiGatewayDeployment1: { Type: 'AWS::ApiGateway::Deployment', Properties: { RestApiId: { Ref: 'ApiGatewayRestApi' } } },
      ApiGatewayApiKey1: {
        Type: 'AWS::ApiGateway::ApiKey',
        DependsOn: 'ApiGatewayDeployment1',
        Properties: {
          Enabled: true,
          Name: 'partners-key',
          Description: 'Partner access',
          CustomerId: 'acme-partner-1',
          Value: 'a-literal-key-value-of-some-length',
          StageKeys: [{ RestApiId: { Ref: 'ApiGatewayRestApi' }, StageName: 'dev' }],
          Tags: [{ Key: 'team', Value: 'partners' }],
        },
      },
      ApiGatewayUsagePlan: {
        Type: 'AWS::ApiGateway::UsagePlan',
        DependsOn: 'ApiGatewayDeployment1',
        Properties: {
          UsagePlanName: 'acme-partners-dev',
          Description: 'Partner plan',
          ApiStages: [{
            ApiId: { Ref: 'ApiGatewayRestApi' },
            Stage: 'dev',
            Throttle: { '/quote/GET': { BurstLimit: 5, RateLimit: 2.5 }, '/broken/GET': 'nope' },
          }],
          Quota: { Limit: 5000, Offset: 2, Period: 'MONTH' },
          Throttle: { BurstLimit: 200, RateLimit: 100 },
          Tags: [{ Key: 'tier', Value: 'partners' }],
        },
      },
      ApiGatewayUsagePlanKey1: {
        Type: 'AWS::ApiGateway::UsagePlanKey',
        Properties: { KeyId: { Ref: 'ApiGatewayApiKey1' }, KeyType: 'API_KEY', UsagePlanId: { Ref: 'ApiGatewayUsagePlan' } },
      },
    }, warnings);

    expect(resources).toEqual([
      { type: 'apigw-rest-api', logicalId: 'ApiGatewayRestApi', name: 'dev-acme-partners' },
      {
        type: 'apigw-api-key',
        logicalId: 'ApiGatewayApiKey1',
        name: 'partners-key',
        description: 'Partner access',
        enabled: true,
        value: 'a-literal-key-value-of-some-length',
        customerId: 'acme-partner-1',
        stageKeys: [{ restApiId: LOCAL_API_ID, stageName: 'dev' }],
        tags: { team: 'partners' },
      },
      {
        type: 'apigw-usage-plan',
        logicalId: 'ApiGatewayUsagePlan',
        name: 'acme-partners-dev',
        description: 'Partner plan',
        apiStages: [{
          apiId: LOCAL_API_ID,
          stage: 'dev',
          throttle: { '/quote/GET': { burstLimit: 5, rateLimit: 2.5 }, '/broken/GET': {} },
        }],
        throttle: { burstLimit: 200, rateLimit: 100 },
        quota: { limit: 5000, offset: 2, period: 'MONTH' },
        tags: { tier: 'partners' },
      },
      {
        type: 'apigw-usage-plan-key',
        logicalId: 'ApiGatewayUsagePlanKey1',
        name: 'ApiGatewayUsagePlanKey1',
        keyRef: 'ApiGatewayApiKey1',
        usagePlanRef: 'ApiGatewayUsagePlan',
        keyType: 'API_KEY',
      },
    ]);
    // Only the deployment is left for the skipped-types summary.
    expect(warnings).toEqual([expect.stringMatching(/^Skipped 1 of 5 resource\(s\) .*: AWS::ApiGateway::Deployment ×1\. /)]);
  });

  it('defaults the names to the logical id and everything else to AWS defaults', () => {
    const warnings: string[] = [];
    const resources = parse({
      Api: { Type: 'AWS::ApiGateway::RestApi' },
      SubNamedApi: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: { 'Fn::ImportValue': 'x' } } },
      Plan: { Type: 'AWS::ApiGateway::UsagePlan' },
      EmptyNamePlan: { Type: 'AWS::ApiGateway::UsagePlan', Properties: { UsagePlanName: '', ApiStages: 'nope', Throttle: 'fast', Quota: [] } },
      Key: { Type: 'AWS::ApiGateway::ApiKey' },
      EmptyNameKey: { Type: 'AWS::ApiGateway::ApiKey', Properties: { Name: '', Enabled: 'true', StageKeys: 'nope', Tags: 'nope' } },
      Member: { Type: 'AWS::ApiGateway::UsagePlanKey' },
    }, warnings);
    expect(resources).toEqual([
      { type: 'apigw-rest-api', logicalId: 'Api', name: 'Api' },
      { type: 'apigw-rest-api', logicalId: 'SubNamedApi', name: 'SubNamedApi' },
      { type: 'apigw-usage-plan', logicalId: 'Plan', name: 'Plan', apiStages: [], tags: {} },
      { type: 'apigw-usage-plan', logicalId: 'EmptyNamePlan', name: 'EmptyNamePlan', apiStages: [], tags: {} },
      { type: 'apigw-api-key', logicalId: 'Key', name: 'Key', enabled: false, stageKeys: [], tags: {} },
      { type: 'apigw-api-key', logicalId: 'EmptyNameKey', name: 'EmptyNameKey', enabled: true, stageKeys: [], tags: {} },
      { type: 'apigw-usage-plan-key', logicalId: 'Member', name: 'Member', keyRef: '', usagePlanRef: '', keyType: 'API_KEY' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('drops stages and stage keys that name no resolvable API, and never sends an unresolved Value', () => {
    const warnings: string[] = [];
    const [plan, key] = parse({
      Plan: {
        Type: 'AWS::ApiGateway::UsagePlan',
        Properties: {
          ApiStages: [
            null,
            { ApiId: { 'Fn::ImportValue': 'shared-api-id' }, Stage: 'dev' },
            { ApiId: 'abc123', Stage: { Ref: 'Stage' } },
            { ApiId: 'abc123', Stage: 'prod', Throttle: 'nope' },
          ],
          Quota: { Limit: '100', Offset: '', Period: 7 },
          Throttle: { BurstLimit: 'x', RateLimit: true },
        },
      },
      Key: {
        Type: 'AWS::ApiGateway::ApiKey',
        Properties: {
          Value: { 'Fn::GetAtt': ['Secret', 'Value'] },
          StageKeys: [null, { RestApiId: 'abc123', StageName: 'dev' }, { RestApiId: { 'Fn::ImportValue': 'x' }, StageName: 'dev' }],
          Tags: [null, { Key: 7, Value: 'x' }, { Key: 'empty' }, { Key: 'n', Value: 3 }],
        },
      },
    }, warnings) as [UsagePlanResource, ApiKeyResource];
    expect(plan.apiStages).toEqual([{ apiId: 'abc123', stage: 'prod' }]);
    expect(plan.quota).toEqual({ limit: 100, offset: undefined, period: undefined });
    expect(plan.throttle).toEqual({ burstLimit: undefined, rateLimit: undefined });
    expect(key.stageKeys).toEqual([{ restApiId: 'abc123', stageName: 'dev' }]);
    expect(key.tags).toEqual({ empty: '', n: '3' });
    expect(key.value).toBeUndefined();
    expect(warnings).toEqual([
      'AWS::ApiGateway::UsagePlan "Plan": ApiStages entry null does not resolve to an API id and a stage — skipped.',
      'AWS::ApiGateway::UsagePlan "Plan": ApiStages entry {"ApiId":{"Fn::ImportValue":"shared-api-id"},"Stage":"dev"} does not resolve to an API id and a stage — skipped.',
      'AWS::ApiGateway::UsagePlan "Plan": ApiStages entry {"ApiId":"abc123","Stage":{"Ref":"Stage"}} does not resolve to an API id and a stage — skipped.',
      'AWS::ApiGateway::ApiKey "Key": StageKeys entry null does not resolve to an API id and a stage — skipped.',
      'AWS::ApiGateway::ApiKey "Key": StageKeys entry {"RestApiId":{"Fn::ImportValue":"x"},"StageName":"dev"} does not resolve to an API id and a stage — skipped.',
      'AWS::ApiGateway::ApiKey "Key": Value {"Fn::GetAtt":["Secret","Value"]} is not a literal — the engine generates the key value instead.',
    ]);
  });

  it('keeps literal physical ids in a UsagePlanKey', () => {
    const [member] = parse({
      Member: { Type: 'AWS::ApiGateway::UsagePlanKey', Properties: { KeyId: 'k3y0000001', UsagePlanId: 'pl4n01', KeyType: 'API_KEY' } },
    }) as UsagePlanKeyResource[];
    expect(member).toMatchObject({ keyRef: 'k3y0000001', usagePlanRef: 'pl4n01' });
  });
});
