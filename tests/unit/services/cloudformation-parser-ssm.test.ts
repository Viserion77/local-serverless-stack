// AWS::SSM::Parameter parsing. Pure parser: no I/O, no mocking — templates are
// crafted to hit the defaults (Name → logical id, Type → String), the flat
// Tags map and an unresolved Value intrinsic.
import { CloudFormationParser, SsmParameterResource } from '../../../src/server/services/cloudformation-parser';

const parser = new CloudFormationParser();

describe('parseSsmParameter (AWS::SSM::Parameter)', () => {
  it('parses name, type, value, description, pattern, tier, data type and the tag map', () => {
    const [res] = parser.parse({
      Resources: {
        TableNameParam: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/acme/orders/table-name',
            Type: 'StringList',
            Value: 'orders,orders-archive',
            Description: 'Order tables',
            AllowedPattern: '^[a-z,-]+$',
            Tier: 'Standard',
            DataType: 'text',
            Tags: { team: 'orders', cost: 42 },
          },
        },
      },
    } as never) as SsmParameterResource[];
    expect(res).toEqual({
      type: 'ssm-parameter',
      logicalId: 'TableNameParam',
      name: '/acme/orders/table-name',
      parameterType: 'StringList',
      value: 'orders,orders-archive',
      description: 'Order tables',
      allowedPattern: '^[a-z,-]+$',
      tier: 'Standard',
      dataType: 'text',
      tags: [{ Key: 'team', Value: 'orders' }, { Key: 'cost', Value: '42' }],
    });
  });

  it('defaults Name to the logical id and Type to String, and stringifies scalar values', () => {
    const [numeric, flag] = parser.parse({
      Resources: {
        RetryCount: { Type: 'AWS::SSM::Parameter', Properties: { Value: 3 } },
        FeatureFlag: { Type: 'AWS::SSM::Parameter', Properties: { Value: true, Tags: [{ Key: 'ignored', Value: 'list' }] } },
      },
    } as never) as SsmParameterResource[];
    expect(numeric).toEqual({ type: 'ssm-parameter', logicalId: 'RetryCount', name: 'RetryCount', parameterType: 'String', value: '3', tags: [] });
    // A Key/Value list is not the AWS::SSM::Parameter tag shape — ignored.
    expect(flag).toMatchObject({ name: 'FeatureFlag', value: 'true', tags: [] });
  });

  it('leaves value undefined when it is still an unresolved intrinsic, and tolerates no Properties', () => {
    const [unresolved, bare] = parser.parse({
      Resources: {
        Orders: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'orders' } },
        TableArnParam: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/acme/orders/table-arn', Value: { 'Fn::GetAtt': ['Orders', 'Arn'] } } },
        Bare: { Type: 'AWS::SSM::Parameter' },
      },
    } as never).filter((r) => r.type === 'ssm-parameter') as SsmParameterResource[];
    expect(unresolved.value).toBeUndefined();
    expect(unresolved.name).toBe('/acme/orders/table-arn');
    expect(bare).toEqual({ type: 'ssm-parameter', logicalId: 'Bare', name: 'Bare', parameterType: 'String', tags: [] });
  });
});
