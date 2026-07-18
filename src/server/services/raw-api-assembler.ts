// Folds hand-authored AWS::ApiGatewayV2 resources (declared under CFN
// `resources:`) into the SAME route/authorizer registry that serverless-state
// feeds. A raw ::Route selects its ::Integration (→ target Lambda ARN) and,
// when AuthorizationType is CUSTOM, its ::Authorizer (→ authorizer Lambda ARN);
// both ARNs are reduced through the parser's intrinsic resolver (cross-stack
// aware) and resolved to a live function at REQUEST time via
// FunctionRegistry.resolve(). Routes whose (method, normalized path) already
// exist in serverless-state are skipped — the Serverless framework compiles
// every httpApi event into a mirror ::Route, so state must win to avoid
// double-registration. AWS::Lambda::Permission (Principal apigateway.amazonaws.com)
// is the advisory invoke grant: absent it we still register and warn.

import type {
  Resource,
  ApiResource,
  ApiIntegrationResource,
  ApiRouteResource,
  ApiAuthorizerResource,
  LambdaPermissionResource,
  LambdaResource,
  CloudFormationParser,
  ArnResolutionContext,
} from './cloudformation-parser.js';
import type { HttpRoute, AuthorizerConfig, RegisteredFunction } from './serverless-state-parser.js';

const ACCOUNT_ID = '000000000000';
const PARTITION = 'aws';
const APIGW_PRINCIPAL = 'apigateway.amazonaws.com';

export interface AssembleInput {
  // Every parsed resource for the service (raw API resources are filtered out here).
  resources: Resource[];
  // Registered region — feeds the AWS::Region pseudo-param.
  region: string;
  // The service's own functions, to detect a same-service (local) target.
  localFunctions: RegisteredFunction[];
  // Routes already sourced from serverless-state — the dedup baseline.
  stateRoutes: HttpRoute[];
  // Cross-service export map for Fn::ImportValue resolution.
  exports?: Map<string, string>;
  // Non-fatal findings sink (unsupported types, missing grants, unresolved imports).
  warnings: string[];
}

export interface AssembleResult {
  routes: HttpRoute[];
  authorizers: AuthorizerConfig[];
}

interface ResolvedTarget {
  // Value stored on HttpRoute.functionName (local short name or the ARN's fn name).
  functionName: string;
  // Set only when the target is NOT a local function (cross-stack ARN).
  arn?: string;
  // The function name extracted from the ARN — used to match Lambda::Permission.
  fnName: string;
}

// Stable (method, normalized path) key shared with serverless-state routes.
function dedupKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function mapByLogicalId<T extends { logicalId: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.logicalId, item);
  return map;
}

// The function name inside a Lambda ARN, or the value unchanged when it is not
// an ARN (a bare name). Mirrors FunctionRegistry.resolve()'s ARN regex.
function functionNameFromArn(value: string): string {
  const match = /^arn:aws:lambda:[^:]*:[^:]*:function:([^:]+)/.exec(value);
  return match ? match[1] : value;
}

// A concrete ARN/name → a local short name (when the service owns it) or a
// cross-stack ARN carried on the route/authorizer for request-time resolution.
function resolveTarget(arnOrName: string, localFunctions: RegisteredFunction[]): ResolvedTarget {
  const fnName = functionNameFromArn(arnOrName);
  const local = localFunctions.find(f => f.fullName === fnName || f.name === fnName);
  if (local) return { functionName: local.name, fnName };
  return { functionName: fnName, arn: arnOrName, fnName };
}

function buildAuthorizer(
  parser: CloudFormationParser,
  authRes: ApiAuthorizerResource,
  ctx: ArnResolutionContext,
  localFunctions: RegisteredFunction[],
): AuthorizerConfig {
  const target = resolveTarget(parser.resolveArnLike(authRes.authorizerUri, ctx).value, localFunctions);
  const config: AuthorizerConfig = {
    name: authRes.name,
    type: 'request',
    eventType: 'httpApi',
    payloadVersion: authRes.authorizerPayloadFormatVersion as '1.0' | '2.0',
    enableSimpleResponses: authRes.enableSimpleResponses,
    identitySource: authRes.identitySource,
    resultTtlInSeconds: authRes.resultTtlInSeconds,
  };
  if (target.arn) config.arn = target.arn;
  else config.functionName = target.functionName;
  return config;
}

export function assembleRawApiResources(parser: CloudFormationParser, input: AssembleInput): AssembleResult {
  const { resources, region, localFunctions, stateRoutes, exports, warnings } = input;

  const routeResources = resources.filter((r): r is ApiRouteResource => r.type === 'apigw-route');
  if (routeResources.length === 0) return { routes: [], authorizers: [] };

  const integrations = mapByLogicalId(resources.filter((r): r is ApiIntegrationResource => r.type === 'apigw-integration'));
  const authResources = mapByLogicalId(resources.filter((r): r is ApiAuthorizerResource => r.type === 'apigw-authorizer'));
  const apis = mapByLogicalId(resources.filter((r): r is ApiResource => r.type === 'apigw-api'));
  const lambdas = mapByLogicalId(resources.filter((r): r is LambdaResource => r.type === 'lambda'));
  const permissions = resources.filter((r): r is LambdaPermissionResource => r.type === 'lambda-permission');

  const ctx: ArnResolutionContext = { region, accountId: ACCOUNT_ID, partition: PARTITION, lambdas, exports, warnings };

  // Pre-reduce each apigateway-principal permission to (grantedFnName, sourceArn).
  const apigwGrants = permissions
    .filter(p => p.principal === APIGW_PRINCIPAL)
    .map(p => ({
      fnName: functionNameFromArn(parser.resolveArnLike(p.functionRef, ctx).value),
      sourceArn: parser.resolveArnLike(p.sourceArn, ctx).value,
    }));

  const routes: HttpRoute[] = [];
  const authorizers: AuthorizerConfig[] = [];
  const authByName = new Map<string, AuthorizerConfig>();
  // Seeded with the state routes so they win; also blocks duplicate raw routes.
  const seen = new Set<string>(stateRoutes.map(r => dedupKey(r.method, r.path)));

  for (const rr of routeResources) {
    const key = dedupKey(rr.method, rr.path);
    if (seen.has(key)) continue;
    seen.add(key);

    const integration = rr.integrationRef ? integrations.get(rr.integrationRef) : undefined;
    if (!integration) {
      warnings.push(`Raw route "${rr.routeKey}": no ::Integration for Target "${rr.integrationRef ?? '(none)'}"; route skipped.`);
      continue;
    }
    const integrationType = integration.integrationType ?? 'AWS_PROXY';
    if (integrationType !== 'AWS_PROXY') {
      warnings.push(`Raw route "${rr.routeKey}": unsupported IntegrationType "${integrationType}" (only AWS_PROXY is emulated); route skipped.`);
      continue;
    }
    const uri = parser.resolveArnLike(integration.integrationUri, ctx);
    if (!uri.value) {
      warnings.push(`Raw route "${rr.routeKey}": IntegrationUri did not reduce to a Lambda ARN; route skipped.`);
      continue;
    }
    const target = resolveTarget(uri.value, localFunctions);

    let authorizerName: string | undefined;
    const authType = rr.authorizationType.toUpperCase();
    if (authType === 'CUSTOM') {
      const authRes = rr.authorizerRef ? authResources.get(rr.authorizerRef) : undefined;
      if (!authRes) {
        warnings.push(`Raw route "${rr.routeKey}": AuthorizationType CUSTOM but ::Authorizer "${rr.authorizerRef ?? '(none)'}" was not found; registering the route unauthorized.`);
      } else if ((authRes.authorizerType ?? 'REQUEST').toUpperCase() !== 'REQUEST') {
        warnings.push(`Raw route "${rr.routeKey}": authorizer "${authRes.name}" type "${authRes.authorizerType}" is not supported locally (only REQUEST); registering the route unauthorized.`);
      } else {
        const config = authByName.get(authRes.name) ?? buildAuthorizer(parser, authRes, ctx, localFunctions);
        if (!authByName.has(authRes.name)) {
          authByName.set(authRes.name, config);
          authorizers.push(config);
        }
        authorizerName = config.name;
      }
    } else if (authType !== 'NONE') {
      warnings.push(`Raw route "${rr.routeKey}": AuthorizationType "${rr.authorizationType}" is not supported locally (only NONE and CUSTOM); registering the route unauthorized.`);
    }

    let sourceArn: string | undefined;
    const grant = apigwGrants.find(g => g.fnName === target.fnName);
    if (grant) {
      sourceArn = grant.sourceArn;
    } else {
      warnings.push(`Raw route "${rr.routeKey}": no AWS::Lambda::Permission (Principal ${APIGW_PRINCIPAL}) grants apigateway invoke on "${target.arn ?? target.functionName}"; registering anyway (the grant is advisory locally).`);
    }

    const api = rr.apiRef ? apis.get(rr.apiRef) : undefined;
    const route: HttpRoute = {
      functionName: target.functionName,
      method: rr.method,
      path: rr.path,
      eventType: 'httpApi',
      cors: Boolean(api?.cors),
      raw: true,
      payloadVersion: (integration.payloadFormatVersion as '1.0' | '2.0') || '2.0',
    };
    if (authorizerName) route.authorizerName = authorizerName;
    if (target.arn) route.functionArn = target.arn;
    if (sourceArn) route.sourceArn = sourceArn;
    routes.push(route);
  }

  return { routes, authorizers };
}

// Records a stack's Outputs[].Export.Name → resolved value into a shared map so
// a later service's Fn::ImportValue reduces to a concrete ARN. Values that are
// intrinsics resolvable to a same-template Lambda ARN (QualifiedArn exports) are
// reduced; unresolvable ones are skipped.
export function collectStackExports(
  parser: CloudFormationParser,
  resources: Resource[],
  outputs: Record<string, unknown> | undefined,
  region: string,
  target: Map<string, string>,
): void {
  if (!outputs) return;
  const lambdas = mapByLogicalId(resources.filter((r): r is LambdaResource => r.type === 'lambda'));
  const ctx: ArnResolutionContext = { region, accountId: ACCOUNT_ID, partition: PARTITION, lambdas };
  for (const out of Object.values(outputs)) {
    if (!out || typeof out !== 'object') continue;
    const entry = out as { Value?: unknown; Export?: { Name?: unknown } };
    const name = entry.Export?.Name;
    if (typeof name !== 'string') continue;
    const resolved = parser.resolveArnLike(entry.Value, ctx);
    if (resolved.resolved) target.set(name, resolved.value);
  }
}
