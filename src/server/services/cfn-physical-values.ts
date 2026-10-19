// Physical values for CloudFormation resource references — what `Ref` and
// `Fn::GetAtt` on a resource return in AWS, computed for the local stack.
//
// The static intrinsic pass (cfn-intrinsics.ts) deliberately leaves a
// Ref/GetAtt to a RESOURCE in place: before provisioning there is no queue URL,
// no stream label, no secret suffix. A function's environment, though, is
// exactly where templates put those references (`TABLE_NAME: !Ref OrdersTable`,
// `QUEUE_URL: !Ref OrdersQueue`, `STREAM_ARN: !GetAtt OrdersTable.StreamArn`),
// and before this module the runtime got the logical id — `TABLE_NAME=OrdersTable`
// — or a JSON blob for anything fancier. The handler then talked to a table
// that does not exist.
//
// Values follow AWS's documented return values per type. The few that only
// exist once the resource does (queue URL, stream ARN, secret ARN, collection
// id/endpoint) come from `RuntimeAttributes`, which the provisioner looks up
// after its pass (ResourceProvisioner.lookupRuntimeAttributes).

import type { Resource, EventRuleResource } from './cloudformation-parser.js';
import {
  ACCOUNT_ID,
  PARTITION,
  NO_VALUE,
  IntrinsicResolver,
  restApiAttribute,
  createIntrinsicContext,
  intrinsicName,
  type TemplateResolveOptions,
} from './cfn-intrinsics.js';

export interface CollectionAttributes {
  id?: string;
  arn?: string;
  endpoint?: string;
}

// Attributes only the live engine can answer, keyed by PHYSICAL name.
export interface RuntimeAttributes {
  queueUrls: Map<string, string>;
  streamArns: Map<string, string>;
  secretArns: Map<string, string>;
  collections: Map<string, CollectionAttributes>;
  // API Gateway usage plans and API keys have no unique physical name (names
  // may repeat) — their engine-minted ids are keyed by LOGICAL id instead.
  usagePlanIds: Map<string, string>;
  apiKeyIds: Map<string, string>;
}

export function emptyRuntimeAttributes(): RuntimeAttributes {
  return {
    queueUrls: new Map(),
    streamArns: new Map(),
    secretArns: new Map(),
    collections: new Map(),
    usagePlanIds: new Map(),
    apiKeyIds: new Map(),
  };
}

export interface PhysicalContext {
  region: string;
  accountId?: string;
  partition?: string;
  runtime?: RuntimeAttributes;
}

type Resolver = (logicalId: string, attribute?: string) => string | undefined;

// The event bus a rule lives on, for its ARN: a same-template bus logical id,
// the tail of a bus ARN, or a literal name. The default bus has no segment.
function ruleBusSegment(rule: EventRuleResource, byLogicalId: Map<string, Resource>): string {
  const ref = rule.eventBusRef;
  if (!ref || ref === 'default') return '';
  const bus = byLogicalId.get(ref);
  if (bus?.type === 'eventbus') return `${bus.name}/`;
  const name = ref.startsWith('arn:') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  return name === 'default' ? '' : `${name}/`;
}

/**
 * The value `Ref` (attribute undefined) or `Fn::GetAtt` returns for a parsed
 * resource, or undefined when LSS cannot know it — an unsupported attribute,
 * or a runtime attribute the engine did not report.
 */
export function physicalValue(
  resource: Resource,
  attribute: string | undefined,
  ctx: PhysicalContext,
  byLogicalId: Map<string, Resource> = new Map(),
): string | undefined {
  const region = ctx.region;
  const account = ctx.accountId ?? ACCOUNT_ID;
  const partition = ctx.partition ?? PARTITION;
  const runtime = ctx.runtime ?? emptyRuntimeAttributes();
  const attr = attribute ?? 'Ref';

  switch (resource.type) {
    case 'lambda': {
      const arn = `arn:${partition}:lambda:${region}:${account}:function:${resource.name}`;
      return ({ Ref: resource.name, Arn: arn } as Record<string, string>)[attr];
    }
    case 'dynamodb': {
      const arn = `arn:${partition}:dynamodb:${region}:${account}:table/${resource.name}`;
      if (attr === 'StreamArn') return runtime.streamArns.get(resource.name);
      return ({ Ref: resource.name, Arn: arn } as Record<string, string>)[attr];
    }
    case 'sqs': {
      // Ref on a queue is its URL — the single most surprising return value in
      // CloudFormation, and the one handlers most often get wrong when faked.
      if (attr === 'Ref' || attr === 'QueueUrl') return runtime.queueUrls.get(resource.name);
      const arn = `arn:${partition}:sqs:${region}:${account}:${resource.name}`;
      return ({ Arn: arn, QueueName: resource.name } as Record<string, string>)[attr];
    }
    case 'sns': {
      const arn = `arn:${partition}:sns:${region}:${account}:${resource.name}`;
      return ({ Ref: arn, TopicArn: arn, TopicName: resource.name } as Record<string, string>)[attr];
    }
    case 's3':
      return ({
        Ref: resource.name,
        Arn: `arn:${partition}:s3:::${resource.name}`,
        DomainName: `${resource.name}.s3.amazonaws.com`,
        RegionalDomainName: `${resource.name}.s3.${region}.amazonaws.com`,
      } as Record<string, string>)[attr];
    case 'secret':
      // Ref and GetAtt Id are the ARN, whose six-character suffix is minted at
      // creation — only the engine knows it.
      return attr === 'Ref' || attr === 'Id' ? runtime.secretArns.get(resource.name) : undefined;
    case 'eventbus':
      return ({
        Ref: resource.name,
        Name: resource.name,
        Arn: `arn:${partition}:events:${region}:${account}:event-bus/${resource.name}`,
      } as Record<string, string>)[attr];
    case 'event-rule':
      return ({
        Ref: resource.name,
        Arn: `arn:${partition}:events:${region}:${account}:rule/${ruleBusSegment(resource, byLogicalId)}${resource.name}`,
      } as Record<string, string>)[attr];
    case 'ssm-parameter':
      return ({
        Ref: resource.name,
        Type: resource.parameterType,
        Value: resource.value,
      } as Record<string, string | undefined>)[attr];
    case 'opensearch': {
      const collection = runtime.collections.get(resource.name) ?? {};
      return ({
        Ref: collection.id,
        Id: collection.id,
        Arn: collection.arn,
        CollectionEndpoint: collection.endpoint,
      } as Record<string, string | undefined>)[attr];
    }
    case 'apigw-rest-api':
      // Every local REST API answers as LOCAL_API_ID (see cfn-intrinsics.ts).
      return restApiAttribute(attribute);
    case 'apigw-usage-plan':
      // Ref and GetAtt Id are the plan id, minted at CreateUsagePlan.
      return attr === 'Ref' || attr === 'Id' ? runtime.usagePlanIds.get(resource.logicalId) : undefined;
    case 'apigw-api-key':
      // Ref and GetAtt APIKeyId are the key id (never the key VALUE).
      return attr === 'Ref' || attr === 'APIKeyId' ? runtime.apiKeyIds.get(resource.logicalId) : undefined;
    default:
      return undefined;
  }
}

export function createPhysicalResolver(resources: Resource[], ctx: PhysicalContext): Resolver {
  const byLogicalId = new Map<string, Resource>();
  for (const r of resources) {
    if ('logicalId' in r && r.logicalId) byLogicalId.set(r.logicalId, r);
  }
  return (logicalId, attribute) => {
    const resource = byLogicalId.get(logicalId);
    return resource ? physicalValue(resource, attribute, ctx, byLogicalId) : undefined;
  };
}

// The value an unresolvable env entry falls back to: the logical id for a Ref
// (what LSS always used to produce), `Id.Attr` for a GetAtt, JSON otherwise.
function fallbackString(value: unknown): string {
  const fn = intrinsicName(value);
  const args = fn ? (value as Record<string, unknown>)[fn] : undefined;
  if (fn === 'Ref' && typeof args === 'string') return args;
  if (fn === 'Fn::GetAtt') return Array.isArray(args) ? args.map(String).join('.') : String(args);
  return JSON.stringify(value);
}

export interface EnvironmentResolverOptions extends TemplateResolveOptions {
  // The template the functions come from — its Parameters, Mappings and
  // Conditions also apply to environment taken from serverless-state.json,
  // which never went through the static pass.
  template: Record<string, unknown>;
  resources: Resource[];
  runtime?: RuntimeAttributes;
  exports?: Map<string, string>;
  // Each distinct finding is pushed once — a provider-level variable is copied
  // onto every function, and 60 identical warnings help nobody.
  warnings: string[];
}

/**
 * Turns a function's raw Environment.Variables into the strings the runtime
 * injects: intrinsics resolved (statically, then to physical values), numbers
 * and booleans stringified, `AWS::NoValue` dropped. A value that still cannot
 * be resolved gets a recognizable fallback AND a warning naming it — never a
 * silent JSON blob in an env var.
 */
export class EnvironmentResolver {
  private readonly resolver: IntrinsicResolver;
  private readonly warnings: string[];

  constructor(options: EnvironmentResolverOptions) {
    this.warnings = options.warnings;
    const ctx = createIntrinsicContext(options.template, options, options.warnings);
    ctx.resolveResource = createPhysicalResolver(options.resources, {
      region: options.region ?? 'us-east-1',
      accountId: options.accountId,
      partition: options.partition,
      runtime: options.runtime,
    });
    ctx.exports = options.exports;
    this.resolver = new IntrinsicResolver(ctx);
  }

  // One value → its concrete string form, or undefined while anything in it is
  // still unresolved (no fallback, no warning — for the stack export map).
  resolveValue(raw: unknown): string | undefined {
    const value = this.resolver.resolve(raw);
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined;
  }

  resolve(env: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, raw] of Object.entries(env)) {
      const value = this.resolver.resolve(raw);
      if (value === undefined || value === null || value === NO_VALUE) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = String(value);
      } else if (Array.isArray(value) && value.every(v => typeof v === 'string' || typeof v === 'number')) {
        // A list (Fn::Split, Fn::GetAZs, a list parameter): CloudFormation would
        // reject it outright; the comma-joined form is what such a value is
        // almost always meant to be read as.
        result[key] = value.join(',');
      } else {
        const fallback = fallbackString(value);
        result[key] = fallback;
        const message = `Environment variable ${key}: ${JSON.stringify(raw)} could not be resolved to a physical value — set to "${fallback}".`;
        if (!this.warnings.includes(message)) this.warnings.push(message);
      }
    }
    return result;
  }
}
