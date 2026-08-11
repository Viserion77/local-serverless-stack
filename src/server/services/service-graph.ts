// Derives the wiring diagram of a SINGLE registered service: which of its
// declared resources talk to which, and on what evidence.
//
// Why this is a separate module and not an arm of the CloudFormation parser:
// the strongest evidence of "this Lambda may touch that table" lives in
// `AWS::IAM::Role`, which the parser drops on purpose (`default: return null`)
// and which two committed tests pin as dropped. An IAM role is also not a
// provisionable resource — adding it to the parser's `Resource` union would
// force dead arms into both provisioner switches and into the dashboard's
// resource counters. So the graph walks the RAW template for the two carriers
// the parser has no reason to know about (IAM roles, SNS subscriptions) and
// reuses the parsed `Resource[]` for everything else.
//
// The graph is DECLARED, not live. Every node and edge comes from the packaged
// template plus the cached registration metadata, so it answers "what did this
// service ask for" for a stopped service just as well as for a running one. It
// deliberately does not consult the engine: an edge that disappears because a
// worker is cold would be worse than no edge at all.
import type {
  Resource,
  LambdaResource,
  DynamoDBResource,
  SQSResource,
  SNSResource,
  S3Resource,
  SecretsManagerResource,
  EventBusResource,
  EventRuleResource,
  OpenSearchCollectionResource,
  EventSourceMapping,
  ArnResolutionContext,
} from './cloudformation-parser.js';
import { CloudFormationParser } from './cloudformation-parser.js';
import type { RegisteredFunction, HttpRoute, AuthorizerConfig } from './serverless-state-parser.js';

// Same locals the raw API assembler signs with — the engine issues one account
// and one partition, so a graph ARN must reduce to the same string an
// assembler-built ARN does or the two would never match.
const ACCOUNT_ID = '000000000000';
const PARTITION = 'aws';

// The Serverless Framework's own execution role, and the helper role it emits
// for custom resources. The second one is FRAMEWORK plumbing — its statements
// grant `s3:PutBucketNotification` / `lambda:AddPermission` to a helper Lambda
// the user never wrote. Walking it would grow a bogus lambda→bucket edge on
// every service that uses an existing-bucket S3 event.
const CUSTOM_RESOURCES_ROLE = 'IamRoleCustomResourcesLambdaExecution';

/**
 * What a node stands for. `route` and `iam-role` have no counterpart in the
 * parser's `Resource` union: a route is declared in `serverless-state.json`
 * (never as a CFN resource LSS parses), and a role is deliberately not parsed.
 * `external` is anything this service references but does not declare — the
 * cross-service edges, which are the whole reason a monorepo needs one stack.
 */
export type GraphNodeKind =
  | 'lambda'
  | 'dynamodb'
  | 'sqs'
  | 'sns'
  | 's3'
  | 'eventbus'
  | 'event-rule'
  | 'opensearch'
  | 'secret'
  | 'route'
  | 'iam-role'
  | 'external';

export interface GraphNode {
  // Stable within one graph: `<kind>:<logicalId>` for declared resources,
  // `route:<METHOD> <path>` for routes, `external:<arn-or-name>` otherwise.
  // The dashboard keys its hit-testing and its accessible table off this.
  id: string;
  kind: GraphNodeKind;
  // Display name: the declared resource name when there is one, else the
  // logical id. Never assumed to be unique — two services can both declare an
  // `OrdersTable`, and an unresolvable `Fn::Sub` name falls back to the id.
  label: string;
  logicalId?: string;
  // Route nodes only.
  method?: string;
  path?: string;
  // Lambda nodes only: the fully qualified `<service>-<stage>-<fn>` name the
  // SDKs use, so the dashboard can link a node to the Lambda detail screen.
  fullName?: string;
  handler?: string;
  // External nodes only: the ARN (or bare name) that could not be attributed
  // to anything this service declares, plus the AWS service it names.
  arn?: string;
  service?: string;
}

/**
 * How an edge was established. The distinction is the point of the whole
 * payload: `iam` and `env` are far weaker evidence than the rest, and a
 * diagram that draws them identically lies about what it knows.
 */
export type GraphEdgeKind =
  | 'http-route'
  | 'authorizer'
  | 'event-source'
  | 's3-notification'
  | 'event-rule-target'
  | 'event-bus-rule'
  | 'sns-subscription'
  | 'redrive'
  | 'iam'
  | 'env';

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  // The HTTP verb, the S3 event names, the granted IAM actions, the env var
  // name — whatever makes the edge checkable by a human.
  detail?: string;
  // `declared` — CloudFormation (or serverless-state) wires this edge and the
  // provisioner acts on it. `inferred` — LSS deduced it from a name match and
  // could be wrong. Only `env` edges are ever inferred.
  confidence: 'declared' | 'inferred';
  // Set on an env-var edge whose key and value are identical on EVERY function
  // of the service — i.e. it came from `provider.environment`, was copied onto
  // every function by the packager, and says nothing about this one in
  // particular. Without this flag a four-function service draws four identical
  // arrows and the dominant signal on the canvas is an artefact.
  serviceWide?: boolean;
}

export interface ServiceGraph {
  service: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Which kinds actually occur, so the legend and the filters do not have to
  // re-scan the edges (and so an empty kind never renders a dead toggle).
  edgeKinds: GraphEdgeKind[];
  // Non-fatal findings: a reference that pointed at nothing, an unsupported
  // intrinsic. Surfaced rather than swallowed — a missing edge with no
  // explanation is the failure mode this whole payload exists to avoid.
  warnings: string[];
}

export interface BuildServiceGraphInput {
  serviceName: string;
  // The raw packaged template, exactly as `CacheManager.getTemplate` returns it.
  template: unknown;
  // The same template already through `CloudFormationParser.parse`.
  resources: Resource[];
  region?: string;
  functions?: RegisteredFunction[];
  routes?: HttpRoute[];
  authorizers?: AuthorizerConfig[];
}

// --- Raw-template shapes -----------------------------------------------------
// Declared locally because the parser keeps its own equivalents unexported.

interface RawTemplate {
  Resources?: Record<string, RawResource>;
}

interface RawResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

interface PolicyStatement {
  Effect?: unknown;
  Action?: unknown;
  Resource?: unknown;
  NotResource?: unknown;
  NotAction?: unknown;
}

// --- Small shared helpers ----------------------------------------------------

// CFN lists are routinely written as a lone scalar (`Action: 'logs:PutLogEvents'`,
// `Resource: {Fn::Join: […]}`). Coerce before iterating, and keep objects — an
// IAM Resource entry is usually an intrinsic, not a string.
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/**
 * The logical id inside a `{Ref}` / `{Fn::GetAtt}`, or null for anything else.
 *
 * Both JSON spellings of Fn::GetAtt are handled. The parser's own private
 * `extractFunctionName`/`extractArn` assume the array form and misbehave on
 * the dotted string (`{"Fn::GetAtt": "X.Arn"}`) — one returns the first
 * character, the other throws — so this does not reuse them.
 */
function refLogicalId(ref: unknown): string | null {
  if (typeof ref === 'string') {
    // Already reduced by the parser: `X::Arn` (extractArn) or `X.Arn`
    // (resolveArnLike / sanitizeEnvironmentValues). Three encodings of the same
    // reference coexist in this codebase; normalise all of them here.
    if (ref.startsWith('arn:')) return null;
    return ref.split(/[:.]/)[0] || null;
  }
  if (typeof ref !== 'object' || ref === null) return null;
  const obj = ref as Record<string, unknown>;
  if ('Ref' in obj) return String(obj.Ref);
  if ('Fn::GetAtt' in obj) {
    const raw = obj['Fn::GetAtt'];
    const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split('.');
    return parts[0] || null;
  }
  return null;
}

/**
 * Reduce an ARN to the (aws service, resource name) pair a declared resource
 * would be indexed under.
 *
 * The sub-resource suffixes matter: a policy that grants `dynamodb:Query` on
 * `…:table/Orders/index/*` is about the Orders TABLE, and a stream ARN carries
 * a creation timestamp nobody can predict at synth time. Secrets are the one
 * kind that cannot be matched exactly — AWS appends six random characters at
 * create time — so they match by prefix at the call site.
 */
export function parseResourceArn(arn: string): { service: string; name: string } | null {
  if (!arn.startsWith('arn:')) return null;
  const parts = arn.split(':');
  if (parts.length < 6) return null;
  const service = parts[2];
  const raw = parts.slice(5).join(':');
  if (!raw) return null;

  // AWS spells the resource-type discriminator two ways, and BOTH have to go or
  // the name never matches a declared resource. Secrets Manager and Lambda use
  // a COLON (`secret:app-db-AbCdEf`, `function:svc-dev-worker`) — which the
  // rejoin above has just put back — while DynamoDB, EventBridge and OpenSearch
  // use a SLASH (`table/Orders`). Missing the colon form is not theoretical:
  // the engine's own Secrets Manager emits `…:secret:<name>-<6 chars>`, so an
  // IAM grant on a secret this service declares would have drawn an external
  // node sitting next to the real one.
  const colonPrefixed = ['secret', 'function', 'layer', 'event-source-mapping'];
  const colonSegments = raw.split(':');
  const tail = colonSegments.length > 1 && colonPrefixed.includes(colonSegments[0])
    ? colonSegments.slice(1).join(':')
    : raw;
  if (!tail) return null;

  const segments = tail.split('/');
  // `table/Orders`, `event-bus/billing`, `collection/abc`, `domain/search`: the
  // first segment is the discriminator, the second is the name. SQS and SNS
  // have neither form, and S3 puts the bucket first.
  // `function` appears in BOTH lists on purpose: AWS accepts `function:name`
  // and `function/name`, and templates in the wild carry each.
  const prefixed = ['table', 'event-bus', 'rule', 'collection', 'domain', 'stream', 'function'];
  if (segments.length > 1 && prefixed.includes(segments[0])) {
    return segments[1] ? { service, name: segments[1] } : null;
  }
  return segments[0] ? { service, name: segments[0] } : null;
}

// Which declared node kind an IAM action grants against. Driven entirely by the
// prefix before the colon — the action space in play is small and closed.
// Everything absent from this map is deliberately noise: `logs:*` is on every
// osls role by construction, and `xray`/`sts`/`ec2`/`elasticfilesystem`/
// `cloudwatch` are VPC and tracing plumbing that say nothing about wiring.
const ACTION_SERVICE_TO_KIND: Readonly<Record<string, GraphNodeKind>> = {
  dynamodb: 'dynamodb',
  sqs: 'sqs',
  sns: 'sns',
  s3: 's3',
  secretsmanager: 'secret',
  es: 'opensearch',
  aoss: 'opensearch',
  events: 'eventbus',
  lambda: 'lambda',
};

// The ARN service segment uses the same vocabulary as the action prefix, with
// one exception: an `execute-api` ARN is an API Gateway grant, which the graph
// models as routes rather than as a node kind of its own.
function kindForAwsService(service: string): GraphNodeKind | null {
  return ACTION_SERVICE_TO_KIND[service] ?? null;
}

// `lambda:CheckpointDurableExecution` and its sibling are an osls self-grant
// pointing the function at itself; drawing them would put a self-loop on every
// Lambda of a durable-execution service.
const IGNORED_ACTIONS = new Set([
  'lambda:CheckpointDurableExecution',
  'lambda:GetDurableExecutionState',
]);

// Env vars whose value is infrastructure, not a resource reference. Without
// this list `AWS_ENDPOINT=http://localhost:14566` matches a "resource" called
// `14566` on three of the four bundled examples.
const ENV_KEY_DENYLIST = new Set([
  'AWS_ENDPOINT',
  'AWS_ENDPOINT_URL',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCOUNT_ID',
  'AWS_LAMBDA_EXEC_WRAPPER',
  'NODE_OPTIONS',
  'STAGE',
  'NODE_ENV',
  'LOG_LEVEL',
]);

/**
 * Builds the wiring graph for one service.
 *
 * Pure: no I/O, no engine calls, no clock. Everything it needs is the template
 * the registrar cached and the metadata that came with it — which is what lets
 * the unit suite cover every edge kind from hand-written templates.
 */
export function buildServiceGraph(input: BuildServiceGraphInput): ServiceGraph {
  const warnings: string[] = [];
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const raw = (input.template ?? {}) as RawTemplate;
  const rawResources = raw.Resources ?? {};

  // --- Index the declared resources ------------------------------------------
  // Two indexes, because references arrive in two currencies: a logical id
  // (every intra-template intrinsic) and a concrete name (every literal ARN,
  // every env-var value). The provisioner builds the first one exactly this way.
  const byLogicalId = new Map<string, Resource>();
  const byKindAndName = new Map<string, Resource>();
  const lambdas = new Map<string, LambdaResource>();

  for (const resource of input.resources) {
    if ('logicalId' in resource && resource.logicalId) {
      byLogicalId.set(resource.logicalId, resource);
      if (resource.type === 'lambda') lambdas.set(resource.logicalId, resource);
    }
    const kind = nodeKindFor(resource);
    if (kind && 'name' in resource && typeof resource.name === 'string') {
      byKindAndName.set(kindNameKey(kind, resource.name), resource);
    }
  }

  // --- Nodes: one per declared resource --------------------------------------
  // Order matters only for readability of the payload; the dashboard lays out
  // by kind, not by array position.
  for (const resource of input.resources) {
    const kind = nodeKindFor(resource);
    if (!kind) continue;
    addResourceNode(nodes, resource, kind, input.functions);
  }

  // --- Nodes: one per declared HTTP route ------------------------------------
  // Routes are the granular entry point — "POST /orders" is what a developer
  // actually calls, and collapsing them into a single API node would hide which
  // function serves which path, which is the first thing this screen is for.
  const routes = input.routes ?? [];
  const functions = input.functions ?? [];
  for (const route of routes) {
    const node = routeNode(route);
    nodes.set(node.id, node);
    const target = lambdaNodeIdForShortName(route.functionName, functions, byLogicalId);
    if (target && nodes.has(target)) {
      addEdge(edges, {
        from: node.id,
        to: target,
        kind: 'http-route',
        detail: route.eventType === 'http' ? 'REST' : 'HTTP API',
        confidence: 'declared',
      });
    } else {
      // A route whose function is not a local Lambda is a cross-service or raw
      // ::Integration route; the assembler keeps its ARN precisely for this.
      const external = externalNodeFromArn(nodes, route.functionArn, 'lambda');
      if (external) {
        addEdge(edges, {
          from: node.id,
          to: external,
          kind: 'http-route',
          detail: route.eventType === 'http' ? 'REST' : 'HTTP API',
          confidence: 'declared',
        });
      } else {
        warnings.push(`Route ${route.method} ${route.path} names function "${route.functionName}", which this service does not declare`);
      }
    }
  }

  // --- Edges: authorizer Lambda guards a route -------------------------------
  const authorizers = new Map<string, AuthorizerConfig>();
  for (const authorizer of input.authorizers ?? []) authorizers.set(authorizer.name, authorizer);
  for (const route of routes) {
    if (!route.authorizerName) continue;
    const authorizer = authorizers.get(route.authorizerName);
    if (!authorizer) {
      warnings.push(`Route ${route.method} ${route.path} names authorizer "${route.authorizerName}", which this service does not declare`);
      continue;
    }
    const routeId = routeNode(route).id;
    const local = authorizer.functionName
      ? lambdaNodeIdForShortName(authorizer.functionName, functions, byLogicalId)
      : null;
    const source = local && nodes.has(local)
      ? local
      : externalNodeFromArn(nodes, authorizer.arn, 'lambda');
    if (!source) {
      warnings.push(`Authorizer "${authorizer.name}" resolves to neither a local function nor an ARN`);
      continue;
    }
    addEdge(edges, {
      from: source,
      to: routeId,
      kind: 'authorizer',
      detail: authorizer.type,
      confidence: 'declared',
    });
  }

  // --- Edges: event-source mappings (SQS → Lambda, DynamoDB stream → Lambda) --
  for (const resource of input.resources) {
    if (resource.type !== 'event-source') continue;
    addEventSourceEdge(resource, { nodes, edges, byLogicalId, byKindAndName, warnings });
  }

  // --- Edges: S3 notifications, EventBridge rules, SQS redrive ---------------
  for (const resource of input.resources) {
    if (resource.type === 's3') addS3NotificationEdges(resource, { nodes, edges, byLogicalId, byKindAndName, warnings });
    if (resource.type === 'event-rule') addEventRuleEdges(resource, { nodes, edges, byLogicalId, byKindAndName, warnings });
    if (resource.type === 'sqs') addRedriveEdge(resource, { nodes, edges, byLogicalId, byKindAndName, warnings });
  }

  // --- Edges: SNS subscriptions (raw template — the parser has no arm) -------
  addSnsSubscriptionEdges(rawResources, { nodes, edges, byLogicalId, byKindAndName, warnings });

  // --- Edges: IAM grants (raw template — the parser drops IAM roles) ---------
  const parser = new CloudFormationParser();
  const ctx: ArnResolutionContext = {
    region: input.region || 'us-east-1',
    accountId: ACCOUNT_ID,
    partition: PARTITION,
    lambdas,
  };
  addIamEdges(rawResources, {
    nodes, edges, byLogicalId, byKindAndName, warnings, parser, ctx,
  });

  // --- Edges: environment variables naming a declared resource ---------------
  addEnvEdges(functions, { nodes, edges, byKindAndName, byLogicalId, warnings });

  const edgeList = [...edges.values()];
  return {
    service: input.serviceName,
    nodes: [...nodes.values()],
    edges: edgeList,
    edgeKinds: [...new Set(edgeList.map(edge => edge.kind))],
    warnings,
  };
}

// --- Node construction -------------------------------------------------------

// Which parsed resources become nodes. The API Gateway v2 plumbing
// (`apigw-api`/`-integration`/`-route`/`-authorizer`) and `lambda-permission`
// are deliberately absent: they are how a route is WIRED, not something a
// developer reasons about, and drawing them would bury the four real nodes of a
// small service under a dozen framework boxes. Their information reaches the
// graph as route nodes instead.
function nodeKindFor(resource: Resource): GraphNodeKind | null {
  switch (resource.type) {
    case 'lambda': return 'lambda';
    case 'dynamodb': return 'dynamodb';
    case 'sqs': return 'sqs';
    case 'sns': return 'sns';
    case 's3': return 's3';
    case 'secret': return 'secret';
    case 'eventbus': return 'eventbus';
    case 'event-rule': return 'event-rule';
    case 'opensearch': return 'opensearch';
    default: return null;
  }
}

type DeclaredResource =
  | LambdaResource | DynamoDBResource | SQSResource | SNSResource | S3Resource
  | SecretsManagerResource | EventBusResource | EventRuleResource | OpenSearchCollectionResource;

function nodeId(kind: GraphNodeKind, key: string): string {
  return `${kind}:${key}`;
}

// Key for the (kind, declared name) index. The separator is a NUL rather than a
// space because it must never occur inside an AWS resource name — splitting on
// a space would truncate any name that contains one.
function kindNameKey(kind: GraphNodeKind, name: string): string {
  return `${kind}\u0000${name}`;
}

function addResourceNode(
  nodes: Map<string, GraphNode>,
  resource: Resource,
  kind: GraphNodeKind,
  functions?: RegisteredFunction[],
): void {
  const declared = resource as DeclaredResource;
  const id = nodeId(kind, declared.logicalId);
  const node: GraphNode = {
    id,
    kind,
    // A `TableName: {Fn::Sub: …}` reaches the parser as an object cast to
    // string, so the label falls back to the logical id rather than rendering
    // "[object Object]" on the canvas.
    label: typeof declared.name === 'string' && declared.name ? declared.name : declared.logicalId,
    logicalId: declared.logicalId,
  };
  if (kind === 'lambda') {
    const lambda = resource as LambdaResource;
    node.fullName = lambda.name;
    node.handler = lambda.handler;
  }
  if (kind === 'lambda' && functions) {
    // The dashboard links a Lambda node to its detail screen by SHORT name,
    // which only serverless-state knows; the template carries the full name.
    const match = functions.find(fn => fn.fullName === (resource as LambdaResource).name);
    if (match) node.label = match.name;
  }
  nodes.set(id, node);
}

function routeNode(route: HttpRoute): GraphNode {
  return {
    id: nodeId('route', `${route.method} ${route.path}`),
    kind: 'route',
    label: `${route.method} ${route.path}`,
    method: route.method,
    path: route.path,
  };
}

// A referenced ARN that this service does not declare still deserves a node —
// the billing example's grant on the orders service's queue is exactly the
// cross-service link a per-service view would otherwise hide.
function externalNodeFromArn(
  nodes: Map<string, GraphNode>,
  arn: string | undefined,
  fallbackKind: GraphNodeKind,
): string | null {
  if (!arn) return null;
  const parsed = parseResourceArn(arn);
  const label = parsed ? parsed.name : arn;
  const service = parsed ? parsed.service : undefined;
  const id = nodeId('external', arn);
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      kind: 'external',
      label,
      arn,
      service: service ?? fallbackKind,
    });
  }
  return id;
}

// A reference that names — rather than Refs — a resource owned by another
// service. It has no ARN and no logical id here, only a name.
function externalNodeByName(
  nodes: Map<string, GraphNode>,
  name: string,
  kind: GraphNodeKind,
): string {
  const id = nodeId('external', name);
  if (!nodes.has(id)) {
    nodes.set(id, { id, kind: 'external', label: name, service: kind });
  }
  return id;
}

// serverless-state speaks SHORT function names; the template speaks logical ids
// and FULL names. This is the join between the two vocabularies.
function lambdaNodeIdForShortName(
  shortName: string,
  functions: RegisteredFunction[],
  byLogicalId: Map<string, Resource>,
): string | null {
  const fn = functions.find(candidate => candidate.name === shortName);
  if (!fn) return null;
  for (const [logicalId, resource] of byLogicalId) {
    if (resource.type === 'lambda' && resource.name === fn.fullName) return nodeId('lambda', logicalId);
  }
  return null;
}

// --- Edge construction -------------------------------------------------------

interface EdgeContext {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  byLogicalId: Map<string, Resource>;
  byKindAndName?: Map<string, Resource>;
  warnings: string[];
}

/**
 * Adds an edge, keyed by (from, to, kind) so the same wiring described twice
 * lands once.
 *
 * The de-duplication is load-bearing, not hygiene: osls pushes an
 * `sqs:ReceiveMessage` / `dynamodb:GetRecords` statement onto the execution
 * role for every event-source mapping it compiles, aimed at the very same ARN.
 * Without this the canvas draws a doubled arrow on every event source. The
 * structural edge wins because it carries batch size and filters; the IAM
 * statement only re-states it.
 */
function addEdge(edges: Map<string, GraphEdge>, edge: Omit<GraphEdge, 'id'>): void {
  const id = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
  if (edges.has(id)) return;
  edges.set(id, { ...edge, id });
}

// True when some edge already connects this pair, whatever its kind — used to
// keep an IAM grant from restating a structural edge in a second line.
function connected(edges: Map<string, GraphEdge>, from: string, to: string): boolean {
  for (const edge of edges.values()) {
    if ((edge.from === from && edge.to === to) || (edge.from === to && edge.to === from)) return true;
  }
  return false;
}

/**
 * Resolve an intra-template reference (logical id, `X::Arn`, `X.Arn`) or a
 * literal ARN to a node id, creating an external node when it points outside.
 *
 * `nameKind` opts a carrier into name-addressed cross-service resolution. Most
 * references are logical ids and a miss means a broken template — but a few
 * CloudFormation properties take a plain NAME that legitimately belongs to
 * another stack. `EventBusName: billing-events` is the bundled demo's own
 * pipeline: the notifications rule listens on the bus the billing service
 * declares. Dropping that reference silently would hide the single most
 * interesting arrow on the screen, so those carriers pass the kind they expect
 * and get an external node instead of a warning.
 */
function resolveRefToNode(ref: unknown, ctx: EdgeContext, nameKind?: GraphNodeKind): string | null {
  if (typeof ref === 'string' && ref.startsWith('arn:')) {
    const parsed = parseResourceArn(ref);
    if (parsed) {
      const kind = kindForAwsService(parsed.service);
      if (kind && ctx.byKindAndName) {
        const local = ctx.byKindAndName.get(kindNameKey(kind, parsed.name));
        if (local && 'logicalId' in local && local.logicalId) return nodeId(kind, local.logicalId);
      }
    }
    return externalNodeFromArn(ctx.nodes, ref, 'lambda');
  }
  const logicalId = refLogicalId(ref);
  if (!logicalId) return null;
  const resource = ctx.byLogicalId.get(logicalId);
  if (!resource) {
    if (!nameKind || typeof ref !== 'string') return null;
    // Not a logical id in this template, so the string is a name owned
    // elsewhere. Match a same-named local resource first — a service is allowed
    // to name its own bus in prose — then fall back to an external node.
    const local = ctx.byKindAndName?.get(kindNameKey(nameKind, ref));
    if (local && 'logicalId' in local && local.logicalId) return nodeId(nameKind, local.logicalId);
    return externalNodeByName(ctx.nodes, ref, nameKind);
  }
  const kind = nodeKindFor(resource);
  if (!kind) return null;
  // No `nodes.has` guard: the node pass created a node for every resource
  // `nodeKindFor` accepts, under the very key `byLogicalId` is indexed by, so a
  // kind-ful hit here always has one.
  return nodeId(kind, logicalId);
}

function addEventSourceEdge(mapping: EventSourceMapping, ctx: EdgeContext): void {
  const target = resolveRefToNode(mapping.functionName, ctx);
  const source = resolveRefToNode(mapping.eventSourceArn, ctx);
  if (!target || !source) {
    warnUnresolved(ctx, `Event-source mapping ${mapping.eventSourceArn || '(unnamed)'} → ${mapping.functionName || '(unnamed)'}`);
    return;
  }
  // A DynamoDB source is the table's STREAM, not the table itself. Saying so in
  // the label keeps the arrow honest: a stream edge does not mean the function
  // reads the table through the data plane.
  const isStream = typeof mapping.eventSourceArn === 'string'
    && (mapping.eventSourceArn.includes('StreamArn') || mapping.eventSourceArn.includes('/stream/'));
  const detail = isStream ? 'stream' : 'poll';
  addEdge(ctx.edges, {
    from: source,
    to: target,
    kind: 'event-source',
    detail: mapping.batchSize ? `${detail} ×${mapping.batchSize}` : detail,
    confidence: 'declared',
  });
}

function addS3NotificationEdges(bucket: S3Resource, ctx: EdgeContext): void {
  for (const notification of bucket.notifications) {
    const target = resolveRefToNode(notification.functionRef, ctx);
    if (!target) {
      warnUnresolved(ctx, `S3 notification on ${bucket.name} → ${notification.functionRef}`);
      continue;
    }
    addEdge(ctx.edges, {
      from: nodeId('s3', bucket.logicalId),
      to: target,
      kind: 's3-notification',
      detail: notification.events.join(', '),
      confidence: 'declared',
    });
  }
}

function addEventRuleEdges(rule: EventRuleResource, ctx: EdgeContext): void {
  const ruleNode = nodeId('event-rule', rule.logicalId);
  // A rule with no `EventBusName` listens on the default bus, which no template
  // declares — there is nothing to point at, so no edge is drawn rather than
  // inventing a node for a bus this service does not own.
  if (rule.eventBusRef) {
    const bus = resolveRefToNode(rule.eventBusRef, ctx, 'eventbus');
    if (bus) {
      addEdge(ctx.edges, {
        from: bus,
        to: ruleNode,
        kind: 'event-bus-rule',
        detail: rule.scheduleExpression || undefined,
        confidence: 'declared',
      });
    } else {
      warnUnresolved(ctx, `EventBridge rule ${rule.name} names bus "${rule.eventBusRef}"`);
    }
  }
  for (const target of rule.targets) {
    const node = resolveRefToNode(target.functionRef, ctx);
    if (!node) {
      warnUnresolved(ctx, `EventBridge rule ${rule.name} targets ${target.functionRef}`);
      continue;
    }
    addEdge(ctx.edges, {
      from: ruleNode,
      to: node,
      kind: 'event-rule-target',
      detail: rule.scheduleExpression || undefined,
      confidence: 'declared',
    });
  }
}

function addRedriveEdge(queue: SQSResource, ctx: EdgeContext): void {
  if (!queue.redrivePolicy) return;
  const dlq = resolveRefToNode(queue.redrivePolicy.deadLetterTargetRef, ctx);
  if (!dlq) {
    warnUnresolved(ctx, `Queue ${queue.name} redrives to ${queue.redrivePolicy.deadLetterTargetRef}`);
    return;
  }
  addEdge(ctx.edges, {
    from: nodeId('sqs', queue.logicalId),
    to: dlq,
    kind: 'redrive',
    detail: `after ${queue.redrivePolicy.maxReceiveCount}`,
    confidence: 'declared',
  });
}

/**
 * SNS subscriptions, read straight from the raw template.
 *
 * `AWS::SNS::Subscription` has no arm in the CloudFormation parser, so without
 * this every declared topic renders as an orphan box — a node with no edges is
 * a question the diagram raises and does not answer.
 */
function addSnsSubscriptionEdges(rawResources: Record<string, RawResource>, ctx: EdgeContext): void {
  for (const resource of Object.values(rawResources)) {
    if (resource.Type !== 'AWS::SNS::Subscription') continue;
    const props = resource.Properties ?? {};
    const topic = resolveRefToNode(props.TopicArn, ctx);
    const endpoint = resolveRefToNode(props.Endpoint, ctx);
    if (!topic || !endpoint) {
      warnUnresolved(ctx, 'SNS subscription with an unresolvable topic or endpoint');
      continue;
    }
    addEdge(ctx.edges, {
      from: topic,
      to: endpoint,
      kind: 'sns-subscription',
      detail: typeof props.Protocol === 'string' ? props.Protocol : undefined,
      confidence: 'declared',
    });
  }
}

// --- IAM ---------------------------------------------------------------------

interface IamContext extends EdgeContext {
  byKindAndName: Map<string, Resource>;
  parser: CloudFormationParser;
  ctx: ArnResolutionContext;
}

/**
 * Turns the execution role's inline policies into edges.
 *
 * The shape of the answer is dictated by how the Serverless Framework writes
 * roles: ONE `IamRoleLambdaExecution` shared by every function of the service,
 * with a single PolicyDocument that carries no per-function attribution
 * whatsoever. So "this Lambda may touch that table" is, truthfully, "every
 * Lambda bound to this role may touch that table".
 *
 * Two renderings follow from that, and the rule between them is the number of
 * functions on the role:
 *
 * - ONE function on the role → the fan-out is a fan-out of one, so the edge is
 *   drawn `lambda → resource` directly. That is the arrow a developer means.
 * - MORE than one → the role becomes a node, and the graph draws N + M edges
 *   (each function → role, role → each grant) instead of N × M. At the stack
 *   sizes LSS targets (≈60 functions × ≈10 tables) the product form is 600
 *   arrows of pure noise; the hub form is 70 and is also what the template
 *   literally says.
 */
function addIamEdges(rawResources: Record<string, RawResource>, iam: IamContext): void {
  // Which functions sit on which role. `Properties.Role` is
  // `{Fn::GetAtt: [<RoleId>, 'Arn']}` for an in-template role; an ARN string or
  // an ImportValue means the role lives outside the stack and carries no
  // statements we can read.
  const lambdasByRole = new Map<string, string[]>();
  for (const [logicalId, resource] of Object.entries(rawResources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const roleId = refLogicalId(resource.Properties?.Role);
    if (!roleId) continue;
    const node = nodeId('lambda', logicalId);
    if (!iam.nodes.has(node)) continue;
    const list = lambdasByRole.get(roleId) ?? [];
    list.push(node);
    lambdasByRole.set(roleId, list);
  }

  for (const [roleLogicalId, resource] of Object.entries(rawResources)) {
    if (resource.Type !== 'AWS::IAM::Role') continue;
    // Framework plumbing: its statements are about a helper Lambda osls
    // generates, not about anything the developer wrote.
    if (roleLogicalId === CUSTOM_RESOURCES_ROLE) continue;

    const bound = lambdasByRole.get(roleLogicalId) ?? [];
    if (bound.length === 0) continue;

    const grants = collectGrants(resource, iam);
    if (grants.length === 0) continue;

    if (bound.length === 1) {
      for (const grant of grants) {
        // Do not restate a structural edge. The queue→lambda arrow already
        // exists from the event-source mapping and carries more information.
        if (connected(iam.edges, bound[0], grant.node)) continue;
        addEdge(iam.edges, {
          from: bound[0],
          to: grant.node,
          kind: 'iam',
          detail: grant.actions.join(', '),
          confidence: 'declared',
        });
      }
      continue;
    }

    const roleNode = nodeId('iam-role', roleLogicalId);
    iam.nodes.set(roleNode, {
      id: roleNode,
      kind: 'iam-role',
      label: roleLogicalId,
      logicalId: roleLogicalId,
    });
    for (const lambda of bound) {
      addEdge(iam.edges, { from: lambda, to: roleNode, kind: 'iam', confidence: 'declared' });
    }
    for (const grant of grants) {
      addEdge(iam.edges, {
        from: roleNode,
        to: grant.node,
        kind: 'iam',
        detail: grant.actions.join(', '),
        confidence: 'declared',
      });
    }
  }
}

interface Grant {
  node: string;
  actions: string[];
}

/** Every (resource, actions) pair an `Allow` statement of this role grants. */
function collectGrants(role: RawResource, iam: IamContext): Grant[] {
  const grants = new Map<string, Set<string>>();
  for (const policy of toArray(role.Properties?.Policies)) {
    const document = (policy as Record<string, unknown> | null)?.PolicyDocument as Record<string, unknown> | undefined;
    for (const entry of toArray(document?.Statement)) {
      const statement = entry as PolicyStatement;
      // `Deny` is emitted by osls for `disableLogs`; `NotResource`/`NotAction`
      // describe a complement that cannot be turned into an arrow. Neither is
      // evidence that this function talks to that resource.
      if (statement.Effect !== 'Allow') continue;
      if (statement.NotResource !== undefined || statement.NotAction !== undefined) continue;

      const actions = toArray(statement.Action)
        .filter((action): action is string => typeof action === 'string')
        .filter(action => !IGNORED_ACTIONS.has(action));
      const kinds = new Set(
        actions
          .map(action => ACTION_SERVICE_TO_KIND[action.split(':')[0]])
          .filter((kind): kind is GraphNodeKind => Boolean(kind)),
      );
      if (kinds.size === 0) continue;

      for (const target of toArray(statement.Resource)) {
        // `Resource: "*"` is a blanket grant. It is true of everything and
        // therefore evidence of nothing — an arrow to every node would be the
        // least useful drawing this screen could produce.
        if (target === '*') continue;
        const node = resolveGrantTarget(target, kinds, iam);
        if (!node) continue;
        const bucket = grants.get(node) ?? new Set<string>();
        for (const action of actions) bucket.add(action);
        grants.set(node, bucket);
      }
    }
  }
  return [...grants.entries()].map(([node, actions]) => ({ node, actions: [...actions] }));
}

/**
 * Resolve one policy `Resource` entry to a node.
 *
 * Order matters. A `Ref`/`Fn::GetAtt` is tried FIRST, because its unresolved
 * form already IS the logical id — going through `resolveArnLike` would reduce
 * it to a string that then has to be reverse-matched for no gain.
 * `Fn::Sub`/`Fn::Join`/`Fn::ImportValue` and literal ARNs take the reducer.
 */
function resolveGrantTarget(target: unknown, kinds: Set<GraphNodeKind>, iam: IamContext): string | null {
  const logicalId = refLogicalId(target);
  if (logicalId) {
    const resource = iam.byLogicalId.get(logicalId);
    if (resource) {
      const kind = nodeKindFor(resource);
      if (kind && iam.nodes.has(nodeId(kind, logicalId))) return nodeId(kind, logicalId);
    }
    return null;
  }

  const reduced = iam.parser.resolveArnLike(target, iam.ctx);
  if (!reduced.value || !reduced.value.startsWith('arn:')) return null;
  const parsed = parseResourceArn(reduced.value);
  if (!parsed) return null;
  const kind = kindForAwsService(parsed.service);
  // The action list and the ARN must agree on what kind of thing this is;
  // disagreement means the reduction went wrong and an arrow would be a guess.
  if (!kind || !kinds.has(kind)) return null;

  const local = iam.byKindAndName.get(kindNameKey(kind, parsed.name))
    // Secrets Manager appends six random characters at create time, so the ARN
    // in a policy never matches the declared name exactly — match by prefix.
    ?? (kind === 'secret' ? findSecretByPrefix(iam.byKindAndName, parsed.name) : undefined)
    // …and if it is not a declared NAME, it may be a declared LOGICAL ID that
    // survived the reduction. `resolveArnLike` only turns Lambda and API Refs
    // into real values, so the most common S3 grant the Serverless Framework
    // writes — `Fn::Join: ['', ['arn:aws:s3:::', {Ref: UploadsBucket}, '/*']]`
    // — reduces to `arn:aws:s3:::UploadsBucket/*`, carrying the logical id
    // where the bucket name should be. Without this branch that grant draws an
    // external node for a bucket declared three lines further down the same
    // template.
    ?? localByLogicalId(iam.byLogicalId, kind, parsed.name);
  if (local && 'logicalId' in local && local.logicalId) return nodeId(kind, local.logicalId);
  return externalNodeFromArn(iam.nodes, reduced.value, kind);
}

// A declared resource whose LOGICAL ID is `name` and whose kind matches — the
// shape left behind when an intrinsic reduced only halfway.
function localByLogicalId(
  byLogicalId: Map<string, Resource>,
  kind: GraphNodeKind,
  name: string,
): Resource | undefined {
  const resource = byLogicalId.get(name);
  return resource && nodeKindFor(resource) === kind ? resource : undefined;
}

function findSecretByPrefix(byKindAndName: Map<string, Resource>, name: string): Resource | undefined {
  for (const [key, resource] of byKindAndName) {
    const [kind, declared] = key.split('\u0000');
    if (kind === 'secret' && name.startsWith(declared)) return resource;
  }
  return undefined;
}

// --- Environment variables ---------------------------------------------------

interface EnvContext {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  byKindAndName: Map<string, Resource>;
  byLogicalId: Map<string, Resource>;
  warnings: string[];
}

/**
 * The weakest edge kind, and the one that needs the loudest caveat.
 *
 * `provider.environment` is copied onto EVERY function of the service by the
 * packager, so a variable naming a table proves the service uses it, not that
 * this function does. Those edges are flagged `serviceWide` so the dashboard
 * can subordinate them; the whole class is `inferred`, because a name match is
 * a guess no matter how good.
 *
 * Matching is exact-first and never substring: `PRODUCTS_INDEX=products` must
 * NOT match a collection called `products-catalog`, which a substring matcher
 * happily invents.
 */
function addEnvEdges(functions: RegisteredFunction[], env: EnvContext): void {
  // A key/value pair present on every function came from provider-level
  // configuration, not from this function's own declaration.
  const occurrences = new Map<string, number>();
  for (const fn of functions) {
    for (const [key, value] of Object.entries(fn.environment ?? {})) {
      const pair = `${key}\u0000${value}`;
      occurrences.set(pair, (occurrences.get(pair) ?? 0) + 1);
    }
  }

  // Which pairs are already linked, in either direction. Built once and kept
  // up to date rather than re-scanned per variable: this is the innermost loop
  // of the whole builder (functions x variables), and at the scale LSS targets
  // — 60 functions, each carrying the provider's environment — a linear scan
  // per check would be the only quadratic thing here.
  const linked = new Set<string>();
  for (const edge of env.edges.values()) {
    linked.add(`${edge.from}\u0000${edge.to}`);
    linked.add(`${edge.to}\u0000${edge.from}`);
  }

  for (const fn of functions) {
    const source = lambdaNodeIdForFullName(fn.fullName, env.byLogicalId);
    if (!source || !env.nodes.has(source)) continue;
    for (const [key, value] of Object.entries(fn.environment ?? {})) {
      if (ENV_KEY_DENYLIST.has(key)) continue;
      const target = matchEnvValue(value, env);
      if (!target || target === source) continue;
      // An env var that merely restates a link CloudFormation already wires
      // adds a weaker duplicate of a stronger fact.
      if (linked.has(`${source}\u0000${target}`)) continue;
      linked.add(`${source}\u0000${target}`);
      linked.add(`${target}\u0000${source}`);
      addEdge(env.edges, {
        from: source,
        to: target,
        kind: 'env',
        detail: key,
        confidence: 'inferred',
        serviceWide: functions.length > 1 && occurrences.get(`${key}\u0000${value}`) === functions.length,
      });
    }
  }
}

function lambdaNodeIdForFullName(fullName: string, byLogicalId: Map<string, Resource>): string | null {
  for (const [logicalId, resource] of byLogicalId) {
    if (resource.type === 'lambda' && resource.name === fullName) return nodeId('lambda', logicalId);
  }
  return null;
}

/**
 * Which declared resource, if any, an environment value names.
 *
 * Four grammars, tried in order of how much they prove:
 *  1. the value IS a declared name (`ORDERS_TABLE=orders-Orders`);
 *  2. the value is an ARN;
 *  3. the value is an unresolved intrinsic the packager left as `X.Arn` /
 *     `X::Arn` — the logical id is right there;
 *  4. the value is a service URL whose LAST path segment is the name
 *     (`…/000000000000/orders-to-process`, `…/_aoss/products-catalog`).
 *
 * Never a substring match, and never a bare last-path-segment match on a value
 * that is not a URL — that is how `http://localhost:14566` becomes a resource
 * called `14566`.
 */
function matchEnvValue(value: string, env: EnvContext): string | null {
  if (!value) return null;

  const direct = findByName(env.byKindAndName, value);
  if (direct) return direct;

  if (value.startsWith('arn:')) {
    const parsed = parseResourceArn(value);
    if (!parsed) return null;
    const kind = kindForAwsService(parsed.service);
    if (!kind) return null;
    const local = env.byKindAndName.get(kindNameKey(kind, parsed.name));
    if (local && 'logicalId' in local && local.logicalId) return nodeId(kind, local.logicalId);
    return null;
  }

  if (!value.includes('/') && (value.includes('::') || value.includes('.'))) {
    const logicalId = refLogicalId(value);
    if (logicalId) {
      const resource = env.byLogicalId.get(logicalId);
      const kind = resource ? nodeKindFor(resource) : null;
      if (kind && env.nodes.has(nodeId(kind, logicalId))) return nodeId(kind, logicalId);
    }
    return null;
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    const path = value.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    return findByName(env.byKindAndName, segments[segments.length - 1]);
  }

  return null;
}

// A name is matched against every kind, because an env var does not say which
// service it points at. A name colliding across two kinds is vanishingly rare
// and the first match is deterministic (insertion order = template order).
function findByName(byKindAndName: Map<string, Resource>, name: string): string | null {
  for (const [key, resource] of byKindAndName) {
    const [kind, declared] = key.split('\u0000');
    if (declared === name && 'logicalId' in resource && resource.logicalId) {
      return nodeId(kind as GraphNodeKind, resource.logicalId);
    }
  }
  return null;
}

// One phrasing for every "reference pointed at nothing" warning, so the
// dashboard can show them as a single list without classifying them.
function warnUnresolved(ctx: EdgeContext, what: string): void {
  ctx.warnings.push(`${what} could not be resolved to a declared resource`);
}
