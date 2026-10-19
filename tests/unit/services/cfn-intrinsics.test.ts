// Unit tests for the static CloudFormation intrinsic pass (cfn-intrinsics.ts).
// Pure module: no I/O, no mocks. Every intrinsic is driven through its
// resolvable, partially-resolvable and malformed shapes, because the contract
// is two-sided — resolve what is knowable, and leave a still-valid intrinsic
// (never a half-substituted object or an invented value) for what is not.
import {
  IntrinsicResolver,
  IntrinsicContext,
  NO_VALUE,
  intrinsicName,
  createIntrinsicContext,
  resolveTemplate,
  restApiAttribute,
  LOCAL_ROOT_RESOURCE_ID,
} from '../../../src/server/services/cfn-intrinsics';
import { LOCAL_API_ID } from '../../../src/server/services/api-gateway-events';

const MAPPINGS = {
  StageConfig: {
    dev: { TableSuffix: 'dev-tbl', Capacity: 5 },
    prod: { TableSuffix: 'prod-tbl' },
  },
  Flat: 'not-an-object',
};

const CONDITIONS = {
  IsDev: { 'Fn::Equals': [{ Ref: 'Stage' }, 'dev'] },
  IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] },
  NotProd: { 'Fn::Not': [{ Condition: 'IsProd' }] },
  DevAndNotProd: { 'Fn::And': [{ Condition: 'IsDev' }, { Condition: 'NotProd' }] },
  DevOrProd: { 'Fn::Or': [{ Condition: 'IsProd' }, { Condition: 'IsDev' }] },
  NumericEquals: { 'Fn::Equals': [{ Ref: 'Count' }, 3] },
  Unknowable: { 'Fn::Equals': [{ Ref: 'SomeResource' }, 'x'] },
  SelfRef: { 'Fn::Not': [{ Condition: 'SelfRef' }] },
};

function make(over: Partial<IntrinsicContext> = {}) {
  const warnings: string[] = [];
  const ctx: IntrinsicContext = {
    region: 'sa-east-1',
    accountId: '000000000000',
    partition: 'aws',
    stackName: 'orders-dev',
    parameters: new Map<string, unknown>([
      ['Stage', 'dev'],
      ['Count', '3'],
      ['Zones', ['a', 'b']],
      ['Weird', '${tricky}'],
    ]),
    mappings: MAPPINGS,
    conditions: CONDITIONS,
    warn: message => warnings.push(message),
    ...over,
  };
  return { r: new IntrinsicResolver(ctx), warnings, ctx };
}

describe('intrinsicName', () => {
  it('recognizes Ref and Fn::* single-key objects only', () => {
    expect(intrinsicName({ Ref: 'X' })).toBe('Ref');
    expect(intrinsicName({ 'Fn::Sub': 'x' })).toBe('Fn::Sub');
    expect(intrinsicName({ Ref: 'X', Other: 1 })).toBeUndefined();
    expect(intrinsicName({ Name: 'x' })).toBeUndefined();
    expect(intrinsicName('Ref')).toBeUndefined();
    expect(intrinsicName(['Ref'])).toBeUndefined();
    expect(intrinsicName(null)).toBeUndefined();
  });
});

describe('IntrinsicResolver.resolve — structure', () => {
  it('walks objects and arrays, dropping AWS::NoValue keys and elements', () => {
    const { r } = make();
    expect(r.resolve({
      A: { Ref: 'Stage' },
      B: { Ref: 'AWS::NoValue' },
      C: [1, { Ref: 'AWS::NoValue' }, { Ref: 'Count' }],
      D: { nested: { Ref: 'AWS::Region' } },
    })).toEqual({ A: 'dev', C: [1, '3'], D: { nested: 'sa-east-1' } });
    expect(r.resolve('plain')).toBe('plain');
    expect(r.resolve(42)).toBe(42);
    expect(r.resolve(null)).toBeNull();
  });
});

describe('Ref', () => {
  it('resolves every pseudo parameter', () => {
    const { r } = make();
    expect(r.resolve({ Ref: 'AWS::Region' })).toBe('sa-east-1');
    expect(r.resolve({ Ref: 'AWS::AccountId' })).toBe('000000000000');
    expect(r.resolve({ Ref: 'AWS::Partition' })).toBe('aws');
    expect(r.resolve({ Ref: 'AWS::URLSuffix' })).toBe('amazonaws.com');
    expect(r.resolve({ Ref: 'AWS::NotificationARNs' })).toEqual([]);
    expect(r.resolve({ Ref: 'AWS::NoValue' })).toBe(NO_VALUE);
    expect(r.resolve({ Ref: 'AWS::StackName' })).toBe('orders-dev');
    expect(r.resolve({ Ref: 'AWS::StackId' })).toBe(
      'arn:aws:cloudformation:sa-east-1:000000000000:stack/orders-dev/00000000-0000-0000-0000-000000000000',
    );
  });

  it('leaves StackName/StackId/Region unresolved when the caller cannot know them', () => {
    const { r } = make({ stackName: undefined, region: undefined });
    expect(r.resolve({ Ref: 'AWS::StackName' })).toEqual({ Ref: 'AWS::StackName' });
    expect(r.resolve({ Ref: 'AWS::StackId' })).toEqual({ Ref: 'AWS::StackId' });
    expect(r.resolve({ Ref: 'AWS::Region' })).toEqual({ Ref: 'AWS::Region' });
    const noRegion = make({ region: undefined });
    expect(noRegion.r.resolve({ Ref: 'AWS::StackId' })).toEqual({ Ref: 'AWS::StackId' });
  });

  it('resolves parameters, and resources only through resolveResource', () => {
    const { r } = make();
    expect(r.resolve({ Ref: 'Stage' })).toBe('dev');
    expect(r.resolve({ Ref: 'Zones' })).toEqual(['a', 'b']);
    // A resource Ref stays in place for the parser / a later physical pass.
    expect(r.resolve({ Ref: 'OrdersTable' })).toEqual({ Ref: 'OrdersTable' });

    const physical = make({ resolveResource: (id, attr) => (id === 'OrdersTable' && !attr ? 'orders-dev' : undefined) });
    expect(physical.r.resolve({ Ref: 'OrdersTable' })).toBe('orders-dev');
    expect(physical.r.resolve({ Ref: 'Other' })).toEqual({ Ref: 'Other' });
  });

  it('keeps a malformed Ref untouched', () => {
    const { r } = make();
    expect(r.resolve({ Ref: ['x'] })).toEqual({ Ref: ['x'] });
  });
});

describe('Fn::GetAtt', () => {
  const resolveResource = (id: string, attr?: string) =>
    id === 'Queue' && attr === 'Arn' ? 'arn:aws:sqs:sa-east-1:000000000000:q'
      : id === 'Db' && attr === 'Endpoint.Address' ? 'db.local'
        : undefined;

  it('resolves the array form, the dotted form and an attribute given by Ref', () => {
    const { r } = make({
      resolveResource,
      parameters: new Map([['AttrName', 'Arn']]),
    });
    expect(r.resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] })).toBe('arn:aws:sqs:sa-east-1:000000000000:q');
    expect(r.resolve({ 'Fn::GetAtt': 'Db.Endpoint.Address' })).toBe('db.local');
    expect(r.resolve({ 'Fn::GetAtt': ['Queue', { Ref: 'AttrName' }] })).toBe('arn:aws:sqs:sa-east-1:000000000000:q');
  });

  it('keeps unresolvable and malformed GetAtts', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] })).toEqual({ 'Fn::GetAtt': ['Queue', 'Arn'] });
    expect(r.resolve({ 'Fn::GetAtt': 'Queue.Arn' })).toEqual({ 'Fn::GetAtt': 'Queue.Arn' });
    expect(r.resolve({ 'Fn::GetAtt': 'NoDot' })).toEqual({ 'Fn::GetAtt': 'NoDot' });
    expect(r.resolve({ 'Fn::GetAtt': '.Arn' })).toEqual({ 'Fn::GetAtt': '.Arn' });
    expect(r.resolve({ 'Fn::GetAtt': [1, 'Arn'] })).toEqual({ 'Fn::GetAtt': [1, 'Arn'] });
    expect(r.resolve({ 'Fn::GetAtt': 7 })).toEqual({ 'Fn::GetAtt': 7 });
  });
});

describe('Fn::Sub', () => {
  it('substitutes pseudo parameters, parameters and variables (both forms)', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Sub': '${AWS::StackName}-${Stage}-orders' })).toBe('orders-dev-dev-orders');
    expect(r.resolve({ 'Fn::Sub': ['${Prefix}-${AWS::Region}-${ Count }', { Prefix: { Ref: 'Stage' } }] })).toBe('dev-sa-east-1-3');
    // A list form whose second element is not a map is just the template.
    expect(r.resolve({ 'Fn::Sub': ['${Stage}', 'junk'] })).toBe('dev');
  });

  it('unescapes ${!Literal} once the whole string is known', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Sub': '${!Literal}-${Stage}' })).toBe('${Literal}-dev');
  });

  it('resolves resource tokens through resolveResource (plain and dotted)', () => {
    const { r } = make({
      resolveResource: (id, attr) => (id === 'Topic' ? (attr ? `${id}:${attr}` : 'topic-arn') : undefined),
    });
    expect(r.resolve({ 'Fn::Sub': '${Topic}|${Topic.TopicName}' })).toBe('topic-arn|Topic:TopicName');
  });

  it('keeps unresolved tokens in a still-valid Fn::Sub, escapes and all', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Sub': 'arn:${AWS::Partition}:lambda:${AWS::Region}:${Fn.Arn}/${!Lit}' }))
      .toEqual({ 'Fn::Sub': 'arn:aws:lambda:sa-east-1:${Fn.Arn}/${!Lit}' });
    // A substituted value that itself contains "${" is escaped so a later
    // pass cannot mistake it for a token.
    expect(r.resolve({ 'Fn::Sub': '${Weird}-${Res}' })).toEqual({ 'Fn::Sub': '${!tricky}-${Res}' });
    // Unresolved variables survive in the list form; resolved ones are inlined.
    expect(r.resolve({ 'Fn::Sub': ['${A}-${B}', { A: { Ref: 'Stage' }, B: { Ref: 'Res' } }] }))
      .toEqual({ 'Fn::Sub': ['dev-${B}', { B: { Ref: 'Res' } }] });
    // No resolver at all: a dotted resource token stays.
    expect(r.resolve({ 'Fn::Sub': '${Res.Arn}' })).toEqual({ 'Fn::Sub': '${Res.Arn}' });
  });

  it('keeps a Sub whose template is not a string', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Sub': [{ Ref: 'X' }] })).toEqual({ 'Fn::Sub': [{ Ref: 'X' }] });
    expect(r.resolve({ 'Fn::Sub': 5 })).toEqual({ 'Fn::Sub': 5 });
  });
});

describe('Fn::Join', () => {
  it('joins scalar parts, including a list produced by another function', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Join': ['-', [{ Ref: 'Stage' }, 'orders', 1, true]] })).toBe('dev-orders-1-true');
    expect(r.resolve({ 'Fn::Join': [':', { 'Fn::Split': [',', 'a,b,c'] }] })).toBe('a:b:c');
    expect(r.resolve({ 'Fn::Join': ['', { Ref: 'Zones' }] })).toBe('ab');
  });

  it('keeps the unresolved parts in place', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':', { 'Fn::GetAtt': ['Fn', 'Arn'] }]] }))
      .toEqual({ 'Fn::Join': ['', ['arn:', 'aws', ':', { 'Fn::GetAtt': ['Fn', 'Arn'] }]] });
    expect(r.resolve({ 'Fn::Join': ['-', { Ref: 'Res' }] })).toEqual({ 'Fn::Join': ['-', { Ref: 'Res' }] });
  });

  it('keeps a malformed Join', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Join': 'nope' })).toEqual({ 'Fn::Join': 'nope' });
    expect(r.resolve({ 'Fn::Join': [1, ['a']] })).toEqual({ 'Fn::Join': [1, ['a']] });
  });
});

describe('Fn::Select / Fn::Split / Fn::GetAZs', () => {
  it('selects by (resolved) index', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Select': [1, ['a', 'b']] })).toBe('b');
    expect(r.resolve({ 'Fn::Select': ['0', { 'Fn::Split': ['/', 'x/y'] }] })).toBe('x');
    expect(r.resolve({ 'Fn::Select': [0, { 'Fn::GetAZs': '' }] })).toBe('sa-east-1a');
  });

  it('warns on an out-of-range index and keeps unresolvable selects', () => {
    const { r, warnings } = make();
    expect(r.resolve({ 'Fn::Select': [5, ['a']] })).toEqual({ 'Fn::Select': [5, ['a']] });
    expect(r.resolve({ 'Fn::Select': [-1, ['a']] })).toEqual({ 'Fn::Select': [-1, ['a']] });
    expect(warnings).toEqual([
      'Fn::Select index 5 is out of range for a list of 1 element(s).',
      'Fn::Select index -1 is out of range for a list of 1 element(s).',
    ]);
    expect(r.resolve({ 'Fn::Select': [0, { Ref: 'Res' }] })).toEqual({ 'Fn::Select': [0, { Ref: 'Res' }] });
    expect(r.resolve({ 'Fn::Select': [{ Ref: 'Res' }, ['a']] })).toEqual({ 'Fn::Select': [{ Ref: 'Res' }, ['a']] });
    expect(r.resolve({ 'Fn::Select': ['x', ['a']] })).toEqual({ 'Fn::Select': ['x', ['a']] });
    expect(r.resolve({ 'Fn::Select': 'nope' })).toEqual({ 'Fn::Select': 'nope' });
  });

  it('splits strings and keeps the rest', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Split': ['-', { 'Fn::Sub': '${Stage}-x' }] })).toEqual(['dev', 'x']);
    expect(r.resolve({ 'Fn::Split': ['-', { Ref: 'Res' }] })).toEqual({ 'Fn::Split': ['-', { Ref: 'Res' }] });
    expect(r.resolve({ 'Fn::Split': [1, 'a'] })).toEqual({ 'Fn::Split': [1, 'a'] });
    expect(r.resolve({ 'Fn::Split': 'a' })).toEqual({ 'Fn::Split': 'a' });
  });

  it('answers Fn::GetAZs with three zones of the requested or current region', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::GetAZs': '' })).toEqual(['sa-east-1a', 'sa-east-1b', 'sa-east-1c']);
    expect(r.resolve({ 'Fn::GetAZs': { Ref: 'AWS::Region' } })).toEqual(['sa-east-1a', 'sa-east-1b', 'sa-east-1c']);
    expect(r.resolve({ 'Fn::GetAZs': 'eu-west-1' })).toEqual(['eu-west-1a', 'eu-west-1b', 'eu-west-1c']);
    expect(r.resolve({ 'Fn::GetAZs': { Ref: 'Res' } })).toEqual({ 'Fn::GetAZs': { Ref: 'Res' } });
    const noRegion = make({ region: undefined });
    expect(noRegion.r.resolve({ 'Fn::GetAZs': '' })).toEqual({ 'Fn::GetAZs': '' });
  });
});

describe('Fn::If and Conditions', () => {
  it('picks the branch of a decidable condition, honouring AWS::NoValue', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::If': ['IsDev', { Ref: 'Stage' }, 'other'] })).toBe('dev');
    expect(r.resolve({ 'Fn::If': ['IsProd', 'yes', { 'Fn::Sub': 'no-${Stage}' }] })).toBe('no-dev');
    expect(r.resolve({ A: { 'Fn::If': ['IsProd', 'x', { Ref: 'AWS::NoValue' }] }, B: 1 })).toEqual({ B: 1 });
  });

  it('evaluates Equals (string-wise), Not, And, Or and Condition references', () => {
    const { r } = make();
    expect(r.evaluateCondition('IsDev')).toBe(true);
    expect(r.evaluateCondition('NotProd')).toBe(true);
    expect(r.evaluateCondition('DevAndNotProd')).toBe(true);
    expect(r.evaluateCondition('DevOrProd')).toBe(true);
    expect(r.evaluateCondition('NumericEquals')).toBe(true);
    // Memoized: a second ask is answered from the cache.
    expect(r.evaluateCondition('IsDev')).toBe(true);
  });

  it('reports undecidable conditions once each and keeps the Fn::If', () => {
    const { r, warnings } = make();
    expect(r.resolve({ 'Fn::If': ['Unknowable', { Ref: 'Stage' }, 'b'] })).toEqual({ 'Fn::If': ['Unknowable', 'dev', 'b'] });
    expect(r.evaluateCondition('Unknowable')).toBeUndefined();
    expect(r.evaluateCondition('Missing')).toBeUndefined();
    expect(r.evaluateCondition('SelfRef')).toBeUndefined();
    expect(warnings).toEqual([
      'Condition "Unknowable" could not be evaluated statically (an operand is not a known value).',
      'Condition "Missing" is not declared in the template\'s Conditions — treating it as undecidable.',
      'Condition "SelfRef" references itself — treating it as undecidable.',
      'Condition "SelfRef" could not be evaluated statically (an operand is not a known value).',
    ]);
  });

  it('treats malformed condition expressions as undecidable', () => {
    const conditions: Record<string, unknown> = {
      NotObject: 'true',
      BadConditionRef: { Condition: 42 },
      EqualsNotList: { 'Fn::Equals': 'x' },
      EqualsWrongArity: { 'Fn::Equals': ['a'] },
      NotNotList: { 'Fn::Not': { Condition: 'IsDev' } },
      NotOfUnknown: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'Res' }, 'x'] }] },
      AndNotList: { 'Fn::And': 'x' },
      OrWithUnknown: { 'Fn::Or': [{ Condition: 'IsDev' }, { 'Fn::Equals': [{ Ref: 'Res' }, 1] }] },
      UnknownFn: { 'Fn::Whatever': [] },
      ConditionPlusKey: { Condition: 'IsDev', extra: 1 },
      IsDev: CONDITIONS.IsDev,
    };
    const { r } = make({ conditions });
    for (const name of Object.keys(conditions).filter(n => n !== 'IsDev')) {
      expect(r.evaluateCondition(name)).toBeUndefined();
    }
  });

  it('keeps a malformed Fn::If', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::If': 'IsDev' })).toEqual({ 'Fn::If': 'IsDev' });
    expect(r.resolve({ 'Fn::If': [1, 'a', 'b'] })).toEqual({ 'Fn::If': [1, 'a', 'b'] });
  });
});

describe('Fn::FindInMap', () => {
  it('looks up (resolved) keys, resolving the value it finds', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::FindInMap': ['StageConfig', { Ref: 'Stage' }, 'TableSuffix'] })).toBe('dev-tbl');
    expect(r.resolve({ 'Fn::FindInMap': ['StageConfig', 'dev', 'Capacity'] })).toBe(5);
  });

  it('warns on a miss and keeps unresolvable or malformed lookups', () => {
    const { r, warnings } = make();
    expect(r.resolve({ 'Fn::FindInMap': ['StageConfig', 'prod', 'Capacity'] }))
      .toEqual({ 'Fn::FindInMap': ['StageConfig', 'prod', 'Capacity'] });
    expect(r.resolve({ 'Fn::FindInMap': ['Flat', 'a', 'b'] })).toEqual({ 'Fn::FindInMap': ['Flat', 'a', 'b'] });
    expect(r.resolve({ 'Fn::FindInMap': ['Nope', 'a', 'b'] })).toEqual({ 'Fn::FindInMap': ['Nope', 'a', 'b'] });
    expect(warnings).toEqual([
      'Fn::FindInMap [StageConfig, prod, Capacity] matches nothing in the template\'s Mappings.',
      'Fn::FindInMap [Flat, a, b] matches nothing in the template\'s Mappings.',
      'Fn::FindInMap [Nope, a, b] matches nothing in the template\'s Mappings.',
    ]);
    expect(r.resolve({ 'Fn::FindInMap': ['StageConfig', { Ref: 'Res' }, 'x'] }))
      .toEqual({ 'Fn::FindInMap': ['StageConfig', { Ref: 'Res' }, 'x'] });
    expect(r.resolve({ 'Fn::FindInMap': ['StageConfig', 'dev'] })).toEqual({ 'Fn::FindInMap': ['StageConfig', 'dev'] });
    expect(r.resolve({ 'Fn::FindInMap': 'x' })).toEqual({ 'Fn::FindInMap': 'x' });
  });
});

describe('Fn::Base64 / Fn::ImportValue / unknown functions', () => {
  it('base64-encodes a resolved string and keeps anything else', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Base64': { 'Fn::Sub': '${Stage}' } })).toBe(Buffer.from('dev').toString('base64'));
    expect(r.resolve({ 'Fn::Base64': { Ref: 'Res' } })).toEqual({ 'Fn::Base64': { Ref: 'Res' } });
  });

  it('answers Fn::ImportValue from the export map, else keeps it with its name resolved', () => {
    const { r } = make({ exports: new Map([['billing-dev-TableName', 'billing-dev-invoices']]) });
    expect(r.resolve({ 'Fn::ImportValue': { 'Fn::Sub': 'billing-${Stage}-TableName' } })).toBe('billing-dev-invoices');
    expect(r.resolve({ 'Fn::ImportValue': 'other' })).toEqual({ 'Fn::ImportValue': 'other' });
    expect(r.resolve({ 'Fn::ImportValue': { Ref: 'Res' } })).toEqual({ 'Fn::ImportValue': { Ref: 'Res' } });
    const noExports = make();
    expect(noExports.r.resolve({ 'Fn::ImportValue': 'x' })).toEqual({ 'Fn::ImportValue': 'x' });
  });

  it('keeps functions it does not evaluate, with their arguments substituted', () => {
    const { r } = make();
    expect(r.resolve({ 'Fn::Cidr': [{ Ref: 'Stage' }, 6, 5] })).toEqual({ 'Fn::Cidr': ['dev', 6, 5] });
  });
});

describe('createIntrinsicContext (Parameters)', () => {
  it('applies overrides, Defaults and list splitting; refuses SSM paths', () => {
    const warnings: string[] = [];
    const ctx = createIntrinsicContext({
      Parameters: {
        Stage: { Type: 'String', Default: 'dev' },
        Overridden: { Type: 'String', Default: 'a' },
        Subnets: { Type: 'CommaDelimitedList', Default: 'x,y' },
        Ids: { Type: 'List<AWS::EC2::Subnet::Id>', Default: 'p,q' },
        ListOverride: { Type: 'CommaDelimitedList' },
        NoTypeNoDefault: {},
        Ssm: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/acme/orders/table' },
        SsmOverridden: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/acme/x' },
        NotAnObject: 'junk',
      },
    }, {
      region: 'us-east-1',
      parameterOverrides: { Overridden: 'b', ListOverride: ['m', 'n'], SsmOverridden: 'real' },
    }, warnings);

    expect(Object.fromEntries(ctx.parameters)).toEqual({
      Stage: 'dev',
      Overridden: 'b',
      Subnets: ['x', 'y'],
      Ids: ['p', 'q'],
      ListOverride: ['m', 'n'],
      SsmOverridden: 'real',
    });
    expect(ctx.accountId).toBe('000000000000');
    expect(ctx.partition).toBe('aws');
    expect(warnings).toEqual([
      'Parameter "NoTypeNoDefault" has no Default and no override — Refs to it stay unresolved.',
      'Parameter "Ssm" is an SSM parameter (AWS::SSM::Parameter::Value<String>) — its value lives in the parameter store, not the template; Refs to it stay unresolved.',
      'Parameter "NotAnObject" has no Default and no override — Refs to it stay unresolved.',
    ]);
  });

  it('works without Parameters/Mappings/Conditions and without a warnings sink', () => {
    const ctx = createIntrinsicContext({ Parameters: { P: {} } }, { accountId: '111111111111', partition: 'aws-cn' });
    expect(ctx.parameters.size).toBe(0);
    expect(ctx.mappings).toEqual({});
    expect(ctx.conditions).toEqual({});
    expect(ctx.accountId).toBe('111111111111');
    expect(ctx.partition).toBe('aws-cn');
    expect(ctx.region).toBeUndefined();
  });

  it('pushes each distinct warning once', () => {
    const warnings: string[] = [];
    const ctx = createIntrinsicContext({}, {}, warnings);
    ctx.warn('same');
    ctx.warn('same');
    expect(warnings).toEqual(['same']);
  });
});

describe('resolveTemplate', () => {
  const template = {
    AWSTemplateFormatVersion: '2010-09-09',
    Parameters: { Stage: { Type: 'String', Default: 'dev' } },
    Mappings: { Names: { dev: { Queue: 'jobs-dev' } } },
    Conditions: {
      IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] },
      Unknowable: { 'Fn::Equals': [{ Ref: 'SomeTable' }, 'x'] },
    },
    Resources: {
      Table: {
        Type: 'AWS::DynamoDB::Table',
        Properties: { TableName: { 'Fn::Sub': '${AWS::StackName}-orders' } },
      },
      Queue: {
        Type: 'AWS::SQS::Queue',
        Properties: { QueueName: { 'Fn::FindInMap': ['Names', { Ref: 'Stage' }, 'Queue'] } },
      },
      ProdOnly: { Type: 'AWS::SNS::Topic', Condition: 'IsProd' },
      Kept: { Type: 'AWS::SNS::Topic', Condition: 'Unknowable' },
      NotAnObject: 'junk',
    },
    Outputs: {
      TableName: { Value: { Ref: 'Table' }, Export: { Name: { 'Fn::Sub': '${AWS::StackName}-TableName' } } },
      ProdOutput: { Value: 'x', Condition: 'IsProd' },
    },
  };

  it('resolves Resources and Outputs and drops conditioned-out entries', () => {
    const warnings: string[] = [];
    const { template: resolved, droppedByCondition } = resolveTemplate(
      template,
      { region: 'us-east-1', stackName: 'orders-dev' },
      warnings,
    );
    const resources = resolved.Resources as Record<string, any>;
    expect(resources.Table.Properties.TableName).toBe('orders-dev-orders');
    expect(resources.Queue.Properties.QueueName).toBe('jobs-dev');
    expect(resources.ProdOnly).toBeUndefined();
    // An undecidable condition keeps its resource.
    expect(resources.Kept).toEqual({ Type: 'AWS::SNS::Topic', Condition: 'Unknowable' });
    expect(resources.NotAnObject).toBe('junk');
    expect(droppedByCondition).toEqual(['ProdOnly']);

    const outputs = resolved.Outputs as Record<string, any>;
    // The resource Ref is left for a physical pass; the export name resolves.
    expect(outputs.TableName).toEqual({ Value: { Ref: 'Table' }, Export: { Name: 'orders-dev-TableName' } });
    expect(outputs.ProdOutput).toBeUndefined();
    // Untouched sections are carried over; the input is not mutated.
    expect(resolved.AWSTemplateFormatVersion).toBe('2010-09-09');
    expect((template.Resources.Table.Properties.TableName as any)['Fn::Sub']).toBe('${AWS::StackName}-orders');
    expect(warnings).toEqual(['Condition "Unknowable" could not be evaluated statically (an operand is not a known value).']);
  });

  it('tolerates a template without Resources or Outputs', () => {
    const { template: resolved, droppedByCondition } = resolveTemplate({ Description: 'empty' }, {});
    expect(resolved).toEqual({ Description: 'empty' });
    expect(droppedByCondition).toEqual([]);
  });
});

describe('resolveTemplate — the template\'s REST API', () => {
  it('resolves Ref / GetAtt on an AWS::ApiGateway::RestApi to the local API id everywhere', () => {
    const { template: resolved } = resolveTemplate({
      Resources: {
        ApiGatewayRestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'dev-acme' } },
        Plan: {
          Type: 'AWS::ApiGateway::UsagePlan',
          Properties: { ApiStages: [{ ApiId: { Ref: 'ApiGatewayRestApi' }, Stage: 'dev' }] },
        },
        Resource: {
          Type: 'AWS::ApiGateway::Resource',
          Properties: {
            ParentId: { 'Fn::GetAtt': ['ApiGatewayRestApi', 'RootResourceId'] },
            Id: { 'Fn::GetAtt': 'ApiGatewayRestApi.RestApiId' },
            Other: { 'Fn::GetAtt': ['ApiGatewayRestApi', 'Nope'] },
            Url: { 'Fn::Sub': 'https://${ApiGatewayRestApi}.execute-api' },
            Queue: { Ref: 'Queue' },
          },
        },
        Queue: { Type: 'AWS::SQS::Queue' },
      },
    }, {});
    const resources = resolved.Resources as Record<string, any>;
    expect(resources.Plan.Properties.ApiStages).toEqual([{ ApiId: LOCAL_API_ID, Stage: 'dev' }]);
    expect(resources.Resource.Properties).toEqual({
      ParentId: LOCAL_ROOT_RESOURCE_ID,
      Id: LOCAL_API_ID,
      // An attribute AWS does not document, and any other resource, stay in place.
      Other: { 'Fn::GetAtt': ['ApiGatewayRestApi', 'Nope'] },
      Url: `https://${LOCAL_API_ID}.execute-api`,
      Queue: { Ref: 'Queue' },
    });
  });

  it('restApiAttribute answers Ref, RestApiId and RootResourceId only', () => {
    expect(restApiAttribute()).toBe('lss-local');
    expect(restApiAttribute('RestApiId')).toBe('lss-local');
    expect(restApiAttribute('RootResourceId')).toBe('lss-local-root');
    expect(restApiAttribute('Arn')).toBeUndefined();
  });
});
