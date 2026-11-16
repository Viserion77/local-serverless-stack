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
  SsmParameterResource,
  ApiResource,
  RestApiResource,
  ApiRouteResource,
  WebFunctionResource,
  WebFunctionRevisionResource,
  WebFunctionEndpointResource,
} from './cloudformation-parser.js';
import { CloudFormationParser } from './cloudformation-parser.js';
import type { RegisteredFunction, HttpRoute, AuthorizerConfig } from './serverless-state-parser.js';
import type { RegisteredWebFunction } from './web-function-assembler.js';

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
 *
 * Graph model v2 (the stack map) added three kinds, all additive:
 * - `api` — one node per API the routes are served by (`AWS::ApiGatewayV2::Api`,
 *   `AWS::ApiGateway::RestApi`, or the implicit Framework API when the template
 *   carries none). It is the "front door" box the architecture diagram puts at
 *   the top of each service frame; the per-route nodes stay for the table and
 *   for the MCP tool, and point at their API through `GraphNode.api`.
 * - `ssm` — an `AWS::SSM::Parameter`, so a `ssm:GetParameter` grant lands on a
 *   box instead of an external stub.
 * - `web-function` — a Lambda Web Function (`AWS::Lambda::WebFunction`): ONE
 *   node per function, its revisions and endpoints folded into the facts
 *   (runtime, revision count, endpoint names, the local URL). It sits in the
 *   compute column next to the event functions it is a sibling of.
 * - `service` — only in the STACK graph: a whole service collapsed into one node
 *   carrying aggregate counts (`stack-graph.ts`). `buildServiceGraph` never
 *   emits it.
 */
export type GraphNodeKind =
  | 'lambda'
  | 'web-function'
  | 'dynamodb'
  | 'sqs'
  | 'sns'
  | 's3'
  | 'eventbus'
  | 'event-rule'
  | 'opensearch'
  | 'secret'
  | 'ssm'
  | 'route'
  | 'api'
  | 'iam-role'
  | 'service'
  | 'external';

/**
 * Which way data moves along an edge, so a diagram can point the arrowhead at
 * the right end: a `read` points at the function (data flows out of the
 * store), a `write` points at the store. The rest describe control rather than
 * data — `invoke` (a synchronous call), `publish` (fire-and-forget into a
 * queue/topic/bus), `consume` (pulling from a queue), `trigger` (the platform
 * calls the function on an event).
 *
 * Derived, never declared by the user: from the granted IAM actions for `iam`
 * edges (`classifyIamAccess`) and from the edge kind for every structural one
 * (`STRUCTURAL_ACCESS`). An `env` edge is a name match and gets none — a guess
 * about WHETHER two things talk cannot also claim to know the direction.
 */
export type EdgeAccess = 'read' | 'write' | 'readwrite' | 'invoke' | 'publish' | 'consume' | 'trigger';

/** A display-only fact a card shows (`runtime: nodejs20.x`, `gsis: 2`). */
export type GraphFactValue = string | number | boolean;

/** One route a function serves, folded onto its card (`GET /orders/{id}`). */
export interface GraphRouteFact {
  method: string;
  path: string;
}

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
  // to anything this service declares, plus the AWS service it names. A
  // third-party HTTP dependency (an env var holding `https://api.example.com/…`)
  // is an external with `service: 'http'` and the host as its label.
  arn?: string;
  service?: string;
  // The owning service, or `external` for an external node. The stack map turns
  // it into a frame; a single-service graph sets it too, so one layout code
  // path serves both screens.
  group?: string;
  // Route nodes only: the id of the `api` node that serves the route. The
  // architecture layout folds route nodes into that API box plus the function
  // card, and this is the join it folds along.
  api?: string;
  // Lambda nodes only: every route the function serves, so its card can carry
  // `GET /orders/{id}` without a separate box. A list does not fit `facts`
  // (scalars only), so it is a field of its own.
  routes?: GraphRouteFact[];
  // What a card prints under the title — small, display-only, derived from the
  // template (runtime/timeout/memory, key schema, FIFO, visibility timeout…).
  // Never something a consumer should branch on: the keys are documented per
  // kind in `docs/FEATURES.md`, the values are for humans.
  facts?: Record<string, GraphFactValue>;
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
  | 'env'
  // Stack graph only: an edge whose far end is a resource ANOTHER service
  // declares, resolved from the external stub a single-service graph draws.
  // `via` keeps the kind of evidence it was resolved from.
  | 'cross-service';

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
  // Direction of the data/control flow — see `EdgeAccess`.
  access?: EdgeAccess;
  // Stack graph only. `via`: the original kind of a `cross-service` edge (an
  // event-source mapping, an IAM grant…), so the diagram can still draw it
  // solid or dashed. `weight`: how many underlying edges an aggregated edge
  // between collapsed services stands for.
  via?: GraphEdgeKind;
  weight?: number;
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
  // Registration metadata for the service's web functions — only read for the
  // endpoint ports (the local URL a card shows); everything else comes from
  // the template.
  webFunctions?: RegisteredWebFunction[];
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
  // A secret's name may itself contain slashes (`acme/orders/hmac`), and the
  // colon form puts the WHOLE name after the discriminator — splitting it on
  // `/` like a table ARN would cut it down to its first path segment.
  if (colonSegments.length > 1 && colonSegments[0] === 'secret') return { service, name: tail };

  const segments = tail.split('/');
  // `table/Orders`, `event-bus/billing`, `collection/abc`, `domain/search`: the
  // first segment is the discriminator, the second is the name. SQS and SNS
  // have neither form, and S3 puts the bucket first.
  // `function` appears in BOTH lists on purpose: AWS accepts `function:name`
  // and `function/name`, and templates in the wild carry each.
  const prefixed = ['table', 'event-bus', 'rule', 'collection', 'domain', 'stream', 'function'];
  // An SSM parameter name is itself a path (`/acme/orders/db-url`), so the
  // whole rest of the ARN is the name — and AWS drops the name's leading slash
  // when it builds the ARN (`parameter/acme/orders/db-url`), which
  // `kindNameKey` undoes on the declared side so the two still meet.
  if (segments[0] === 'parameter') {
    const parameter = segments.slice(1).join('/');
    return parameter ? { service, name: parameter } : null;
  }
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
  ssm: 'ssm',
};

// The ARN service segment uses the same vocabulary as the action prefix, with
// one exception: an `execute-api` ARN is an API Gateway grant, which the graph
// models as routes rather than as a node kind of its own.
function kindForAwsService(service: string): GraphNodeKind | null {
  return ACTION_SERVICE_TO_KIND[service] ?? null;
}

// --- Access direction ----------------------------------------------------------

type AccessCategory = 'read' | 'write' | 'publish' | 'consume' | 'invoke';

/**
 * The single classification table behind `EdgeAccess` for IAM edges: per
 * action prefix, which actions READ, WRITE, PUBLISH, CONSUME or INVOKE.
 *
 * Exported so the unit suite can walk it row by row, and so the table is the
 * documentation — `docs/FEATURES.md` points here rather than restating it.
 *
 * Deliberately an allowlist of the data-plane verbs that say which way data
 * moves. Everything absent is NEUTRAL, not an error: `sqs:GetQueueAttributes`,
 * `sqs:GetQueueUrl`, `dynamodb:DescribeStream` are plumbing every consumer
 * carries, and counting them would turn every grant into `readwrite`.
 *
 * Two entries look odd and are not:
 * - `aoss:APIAccessAll` appears under BOTH read and write. It is the one action
 *   OpenSearch Serverless has for its whole data plane, so it genuinely means
 *   both, and listing it twice is how the combiner below says `readwrite`.
 * - `dynamodb:SearchVectors` is a read: the vector-search API queries an index,
 *   it never writes one.
 */
export const IAM_ACCESS_TABLE: Readonly<Record<string, Readonly<Partial<Record<AccessCategory, readonly string[]>>>>> = {
  dynamodb: {
    read: [
      'GetItem', 'BatchGetItem', 'Query', 'Scan', 'SearchVectors', 'DescribeTable',
      'TransactGetItems', 'ConditionCheckItem', 'PartiQLSelect', 'GetRecords', 'GetShardIterator',
    ],
    write: [
      'PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem', 'TransactWriteItems',
      'PartiQLInsert', 'PartiQLUpdate', 'PartiQLDelete',
    ],
  },
  s3: {
    read: [
      'GetObject', 'GetObjectVersion', 'GetObjectAcl', 'GetObjectTagging', 'GetObjectAttributes',
      'ListBucket', 'ListBucketVersions', 'GetBucketLocation',
    ],
    write: [
      'PutObject', 'PutObjectAcl', 'PutObjectTagging', 'DeleteObject', 'DeleteObjectVersion',
      'DeleteObjectTagging', 'AbortMultipartUpload',
    ],
  },
  sqs: {
    publish: ['SendMessage', 'SendMessageBatch'],
    consume: [
      'ReceiveMessage', 'DeleteMessage', 'DeleteMessageBatch',
      'ChangeMessageVisibility', 'ChangeMessageVisibilityBatch',
    ],
  },
  sns: { publish: ['Publish', 'PublishBatch'] },
  events: { publish: ['PutEvents'] },
  secretsmanager: {
    read: ['GetSecretValue', 'BatchGetSecretValue', 'DescribeSecret'],
    write: ['PutSecretValue', 'UpdateSecret', 'CreateSecret', 'DeleteSecret'],
  },
  ssm: {
    read: ['GetParameter', 'GetParameters', 'GetParametersByPath', 'GetParameterHistory', 'DescribeParameters'],
    write: ['PutParameter', 'DeleteParameter', 'DeleteParameters', 'LabelParameterVersion'],
  },
  lambda: { invoke: ['InvokeFunction', 'InvokeFunctionUrl', 'InvokeAsync'] },
  aoss: { read: ['APIAccessAll'], write: ['APIAccessAll'] },
  es: {
    read: ['ESHttpGet', 'ESHttpHead'],
    write: ['ESHttpPut', 'ESHttpPost', 'ESHttpDelete', 'ESHttpPatch'],
  },
};

// IAM action names are case-insensitive and may carry `*`/`?` wildcards. A
// wildcard is EXPANDED against the table's vocabulary for that prefix, so
// `dynamodb:Get*` is a read, `dynamodb:*` hits both columns and comes out
// `readwrite`, and `sqs:*` (publish + consume) comes out `readwrite` too.
function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * The direction a set of granted actions implies, or undefined when none of
 * them is a data-plane verb the table knows.
 *
 * One category → that category. More than one → `readwrite`: a function that
 * both reads and writes a table, or both sends to and consumes a queue, moves
 * data both ways and the diagram draws a double-headed arrow.
 */
export function classifyIamAccess(actions: readonly string[]): EdgeAccess | undefined {
  const categories = new Set<AccessCategory>();
  for (const action of actions) {
    const colon = action.indexOf(':');
    if (colon <= 0) continue;
    const row = IAM_ACCESS_TABLE[action.slice(0, colon).toLowerCase()];
    if (!row) continue;
    const matcher = globToRegExp(action.slice(colon + 1));
    for (const [category, verbs] of Object.entries(row) as Array<[AccessCategory, readonly string[]]>) {
      if (verbs.some(verb => matcher.test(verb))) categories.add(category);
    }
  }
  if (categories.size === 0) return undefined;
  if (categories.size === 1) return [...categories][0];
  return 'readwrite';
}

/**
 * Access implied by the KIND of a structural edge — no IAM involved. A route
 * invokes its function synchronously; an event-source mapping, a notification,
 * a rule target and a subscription are the platform triggering it; a redrive is
 * the queue publishing into its DLQ. `iam` is computed per edge, `env` and
 * `cross-service` carry whatever they were built with.
 */
export const STRUCTURAL_ACCESS: Readonly<Partial<Record<GraphEdgeKind, EdgeAccess>>> = {
  'http-route': 'invoke',
  authorizer: 'invoke',
  'event-source': 'trigger',
  's3-notification': 'trigger',
  'event-rule-target': 'trigger',
  'event-bus-rule': 'trigger',
  'sns-subscription': 'trigger',
  redrive: 'publish',
};

/**
 * The (kind, name) an external node stands for, so the stack graph can look it
 * up among the resources the OTHER services declare. Two spellings exist: an
 * ARN-built external carries the AWS service prefix (`events`, `sqs`), a
 * name-built one carries the graph kind (`eventbus`); both reduce here.
 * Third-party HTTP hosts (`service: 'http'`) are never resolvable.
 */
export function externalTarget(node: GraphNode): { kind: GraphNodeKind; name: string } | null {
  if (node.kind !== 'external' || !node.service || node.service === 'http') return null;
  const parsed = node.arn ? parseResourceArn(node.arn) : null;
  const kind = kindForAwsService(parsed?.service ?? node.service)
    ?? (RESOLVABLE_KINDS.has(node.service as GraphNodeKind) ? node.service as GraphNodeKind : null);
  if (!kind) return null;
  return { kind, name: parsed?.name ?? node.label };
}

// The kinds a name or an ARN can point at — what the stack graph indexes.
const RESOLVABLE_KINDS: ReadonlySet<GraphNodeKind> = new Set<GraphNodeKind>([
  'lambda', 'dynamodb', 'sqs', 'sns', 's3', 'eventbus', 'opensearch', 'secret', 'ssm',
]);

/**
 * The name another service would use to reference a declared node — the
 * physical name, which for a Lambda is the full `<service>-<stage>-<fn>` name
 * (its label is the short one). Null for kinds nothing references by name.
 */
export function physicalName(node: GraphNode): string | null {
  if (!RESOLVABLE_KINDS.has(node.kind)) return null;
  return node.kind === 'lambda' ? node.fullName ?? node.label : node.label;
}

// `lambda:CheckpointDurableExecution` and its sibling are an osls self-grant
// pointing the function at itself; drawing them would put a self-loop on every
// Lambda of a durable-execution service.
const IGNORED_ACTIONS = new Set([
  'lambda:CheckpointDurableExecution',
  'lambda:GetDurableExecutionState',
]);

// What osls grants a function for each event-source mapping it compiles: the
// poller's own rights on the queue or the stream, never a data-plane intent.
const EVENT_SOURCE_PLUMBING = new Set([
  'sqs:ReceiveMessage',
  'sqs:DeleteMessage',
  'sqs:GetQueueAttributes',
  'sqs:ChangeMessageVisibility',
  'dynamodb:GetRecords',
  'dynamodb:GetShardIterator',
  'dynamodb:DescribeStream',
  'dynamodb:ListStreams',
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
  const web = indexWebFunctions(input.resources, nodes, input.webFunctions ?? []);

  // --- Nodes: one per declared HTTP route ------------------------------------
  // Routes are the granular entry point — "POST /orders" is what a developer
  // actually calls, and collapsing them into a single API node would hide which
  // function serves which path, which is the first thing this screen is for.
  const routes = input.routes ?? [];
  const functions = input.functions ?? [];
  const apis = new ApiIndex(input.resources);
  // Routes per local function, folded onto its card afterwards.
  const routesByLambda = new Map<string, GraphRouteFact[]>();
  for (const route of routes) {
    const node = routeNode(route);
    node.api = apis.nodeFor(route, nodes);
    nodes.set(node.id, node);
    const target = lambdaNodeIdForShortName(route.functionName, functions, byLogicalId);
    if (target && nodes.has(target)) {
      const served = routesByLambda.get(target) ?? [];
      served.push({ method: route.method, path: route.path });
      routesByLambda.set(target, served);
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

  for (const [lambdaId, served] of routesByLambda) {
    // Path first, then verb: the card lists `/orders` GET above `/orders` POST
    // above `/orders/{id}` GET — reading order, and stable across refetches.
    nodes.get(lambdaId)!.routes = served.sort((a, b) =>
      a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }
  apis.finish(nodes, routes);

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
  // (function, resource) pairs a SHARED role grants. Drawn as role-hub edges,
  // never as direct arrows, but they are still a CloudFormation-wired link —
  // so the env pass below must not restate them as a weaker guess.
  const implied = new Set<string>();
  addIamEdges(rawResources, {
    nodes, edges, byLogicalId, byKindAndName, warnings, parser, ctx, implied, web,
  });

  // --- Edges: what the web functions' environments, and the event functions'
  // references to a web endpoint, say (before the inferred env pass, so a
  // declared reference suppresses the weaker name match) ----------------------
  addWebEnvEdges(rawResources, { nodes, edges, byKindAndName, byLogicalId, warnings, implied, web });

  // --- Edges: environment variables naming a declared resource ---------------
  addEnvEdges(functions, { nodes, edges, byKindAndName, byLogicalId, warnings, implied, web });

  // --- Group membership --------------------------------------------------------
  // Every node of this graph belongs to this service's frame, except the
  // externals, which the layout gathers into one column outside every frame.
  for (const node of nodes.values()) {
    node.group = node.kind === 'external' ? 'external' : input.serviceName;
  }

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
    case 'ssm-parameter': return 'ssm';
    case 'web-function': return 'web-function';
    default: return null;
  }
}

type DeclaredResource =
  | LambdaResource | DynamoDBResource | SQSResource | SNSResource | S3Resource
  | SecretsManagerResource | EventBusResource | EventRuleResource | OpenSearchCollectionResource
  | SsmParameterResource | WebFunctionResource;

function nodeId(kind: GraphNodeKind, key: string): string {
  return `${kind}:${key}`;
}

// Key for the (kind, declared name) index. The separator is a NUL rather than a
// space because it must never occur inside an AWS resource name — splitting on
// a space would truncate any name that contains one.
function kindNameKey(kind: GraphNodeKind, name: string): string {
  return `${kind}\u0000${normaliseName(kind, name)}`;
}

// SSM is the one service whose ARN and declared name disagree by construction:
// `/acme/db-url` is `…:parameter/acme/db-url`. Both sides drop the slash.
function normaliseName(kind: GraphNodeKind, name: string): string {
  return kind === 'ssm' ? name.replace(/^\//, '') : name;
}

function addResourceNode(
  nodes: Map<string, GraphNode>,
  resource: Resource,
  kind: GraphNodeKind,
  functions: RegisteredFunction[] | undefined,
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
  const facts = factsFor(declared);
  if (facts) node.facts = facts;
  nodes.set(id, node);
}

/**
 * The few facts a card prints under its title, read from what the template
 * declares. Display-only and deliberately small — the detail screens own the
 * full picture; a card answers "what kind of X is this" at a glance.
 *
 * Absent values are omitted rather than written as `undefined`, so an empty
 * set of facts leaves the node without the field at all.
 */
function factsFor(resource: DeclaredResource): Record<string, GraphFactValue> | undefined {
  const facts: Record<string, GraphFactValue | undefined> = {};
  switch (resource.type) {
    case 'lambda':
      facts.runtime = resource.runtime || undefined;
      facts.timeout = resource.timeout || undefined;
      facts.memory = resource.memorySize || undefined;
      break;
    case 'dynamodb': {
      facts.pk = resource.keySchema.find(key => key.KeyType === 'HASH')?.AttributeName;
      facts.sk = resource.keySchema.find(key => key.KeyType === 'RANGE')?.AttributeName;
      facts.gsis = resource.globalSecondaryIndexes?.length || undefined;
      facts.lsis = resource.localSecondaryIndexes?.length || undefined;
      facts.stream = resource.streamEnabled ? resource.streamViewType ?? true : undefined;
      facts.ttl = resource.ttl?.enabled ? resource.ttl.attributeName : undefined;
      // The parser keeps `vectorIndexes` only when the template declares at
      // least one, so its length is the badge.
      facts.vectorIndexes = resource.vectorIndexes?.length;
      break;
    }
    case 'sqs':
      facts.fifo = resource.fifoQueue || undefined;
      facts.visibilityTimeout = resource.visibilityTimeout;
      facts.maxReceiveCount = resource.redrivePolicy?.maxReceiveCount;
      break;
    case 's3': {
      const events = [...new Set(resource.notifications.flatMap(notification => notification.events))];
      facts.events = events.length ? events.join(', ') : undefined;
      break;
    }
    case 'event-rule':
      facts.schedule = resource.scheduleExpression || undefined;
      facts.pattern = resource.eventPattern ? summarisePattern(resource.eventPattern) : undefined;
      break;
    case 'opensearch':
      facts.type = resource.collectionType;
      break;
    case 'ssm-parameter':
      facts.type = resource.parameterType;
      break;
    default:
      break;
  }
  const present = Object.entries(facts).filter((entry): entry is [string, GraphFactValue] => entry[1] !== undefined);
  return present.length ? Object.fromEntries(present) : undefined;
}

/**
 * `{source: ['billing'], 'detail-type': ['OrderBilled']}` →
 * `source=billing · detail-type=OrderBilled`. Nested objects (a `detail`
 * filter) are summarised by key only — the card has one line, and the rule's
 * own screen is where the full pattern belongs.
 */
export function summarisePattern(pattern: Record<string, unknown>): string {
  return Object.entries(pattern).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}=${value.map(item => (typeof item === 'object' && item !== null ? '{…}' : String(item))).join('|')}`;
    }
    if (typeof value === 'object' && value !== null) return `${key}={…}`;
    return `${key}=${String(value)}`;
  }).join(' · ');
}

/**
 * Which API each route is served by, and the `api` nodes that stand for them.
 *
 * Three sources, in order of how much they prove:
 *  1. a parsed `AWS::ApiGatewayV2::Route` with the same verb and path names its
 *     `ApiId` — osls compiles every `httpApi` event to one, and hand-written
 *     topologies declare them directly;
 *  2. the template's first API of the matching flavour (`AWS::ApiGateway::RestApi`
 *     for a REST `http` route, `AWS::ApiGatewayV2::Api` for an `httpApi` one);
 *  3. the implicit Framework API, when the template carries none of either —
 *     the routes are still served by SOMETHING, and the diagram needs the box.
 *
 * Only APIs that serve at least one route become nodes: an API with nothing
 * behind it is plumbing, and the node pass drops plumbing.
 */
class ApiIndex {
  private readonly apis = new Map<string, ApiResource | RestApiResource>();
  private readonly httpApis: ApiResource[] = [];
  private readonly restApis: RestApiResource[] = [];
  private readonly declaredRoutes: ApiRouteResource[] = [];

  constructor(resources: Resource[]) {
    for (const resource of resources) {
      if (resource.type === 'apigw-api') {
        this.apis.set(resource.logicalId, resource);
        this.httpApis.push(resource);
      } else if (resource.type === 'apigw-rest-api') {
        this.apis.set(resource.logicalId, resource);
        this.restApis.push(resource);
      } else if (resource.type === 'apigw-route') {
        this.declaredRoutes.push(resource);
      }
    }
  }

  /** The api node id for a route, creating the node on first use. */
  nodeFor(route: HttpRoute, nodes: Map<string, GraphNode>): string {
    const declared = this.declaredRoutes.find(candidate =>
      candidate.method === route.method && candidate.path === route.path
      && candidate.apiRef !== undefined && this.apis.has(candidate.apiRef));
    const rest = route.eventType === 'http';
    const resource = declared
      ? this.apis.get(declared.apiRef!)!
      : (rest ? this.restApis[0] : this.httpApis[0]);
    const id = resource ? nodeId('api', resource.logicalId) : nodeId('api', rest ? 'implicit-rest' : 'implicit-http');
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: 'api',
        // The declared `Name` (osls writes `<stage>-<service>`), else a plain
        // "HTTP API" / "REST API" — the frame around it already names the
        // service, so repeating it here would only crowd the card.
        label: resource ? resource.name : (rest ? 'REST API' : 'HTTP API'),
        logicalId: resource?.logicalId,
        facts: { protocol: rest ? 'REST' : 'HTTP' },
      });
    }
    return id;
  }

  /** Route counts and authorizer names, once every route is assigned. */
  finish(nodes: Map<string, GraphNode>, routes: HttpRoute[]): void {
    for (const node of nodes.values()) {
      if (node.kind !== 'api') continue;
      const served = routes.filter(route => nodes.get(routeNode(route).id)?.api === node.id);
      node.facts!.routes = served.length;
      const authorizers = [...new Set(served.map(route => route.authorizerName).filter(Boolean))].sort();
      if (authorizers.length) node.facts!.authorizers = authorizers.join(', ');
    }
  }
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
  // A structural edge's direction follows from its kind; an IAM edge brings its
  // own (or none, when no granted action is a data-plane verb). The key is left
  // off entirely rather than written as `undefined`, so the payload stays as
  // small as v1's for an edge that has nothing to say.
  const { access: own, ...rest } = edge;
  const access = own ?? STRUCTURAL_ACCESS[edge.kind];
  edges.set(id, access ? { ...rest, id, access } : { ...rest, id });
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
  const source = nodeId('sqs', queue.logicalId);
  addEdge(ctx.edges, {
    from: source,
    to: dlq,
    kind: 'redrive',
    detail: `after ${queue.redrivePolicy.maxReceiveCount}`,
    confidence: 'declared',
  });
  // Tell the DLQ which queue it serves: the layout tucks it directly under
  // that queue, and its card says `DLQ` instead of repeating its settings.
  // Only a LOCAL queue gets the fact — an external DLQ is another service's
  // card, and annotating it from here would be writing on someone else's box.
  const target = ctx.nodes.get(dlq)!;
  if (target.kind === 'sqs') target.facts = { ...target.facts, dlqOf: source };
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
  implied: Set<string>;
  web: WebIndex;
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
  // A web function's role is on each REVISION (`ServiceConfig.ExecutionRoleArn`);
  // the grants are drawn from the one web-function node, once per role however
  // many revisions share it.
  for (const [logicalId, resource] of Object.entries(rawResources)) {
    if (resource.Type !== 'AWS::Lambda::WebFunctionRevision') continue;
    const service = resource.Properties?.ServiceConfig as Record<string, unknown> | undefined;
    const roleId = refLogicalId(service?.ExecutionRoleArn);
    const node = iam.web.byRevision.get(logicalId);
    if (!roleId || !node) continue;
    const list = lambdasByRole.get(roleId) ?? [];
    if (!list.includes(node)) list.push(node);
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
          access: classifyIamAccess(grant.actions),
        });
      }
      continue;
    }

    // The statements osls writes FOR an event-source mapping (the poller's
    // receive/stream-read rights) restate that mapping; on a shared role the
    // single-function `connected` check above never runs, so without this the
    // hub would draw a second arrow to every queue or stream that already
    // triggers one of its functions.
    const meaningful = grants.filter(grant => !(
      grant.actions.every(action => EVENT_SOURCE_PLUMBING.has(action))
      && bound.some(lambda => connected(iam.edges, lambda, grant.node))));
    if (meaningful.length === 0) continue;

    const roleNode = nodeId('iam-role', roleLogicalId);
    iam.nodes.set(roleNode, {
      id: roleNode,
      kind: 'iam-role',
      label: roleLogicalId,
      logicalId: roleLogicalId,
      facts: { functions: bound.length },
    });
    for (const lambda of bound) {
      addEdge(iam.edges, { from: lambda, to: roleNode, kind: 'iam', confidence: 'declared' });
    }
    for (const grant of meaningful) {
      addEdge(iam.edges, {
        from: roleNode,
        to: grant.node,
        kind: 'iam',
        detail: grant.actions.join(', '),
        confidence: 'declared',
        access: classifyIamAccess(grant.actions),
      });
      for (const lambda of bound) iam.implied.add(`${lambda}\u0000${grant.node}`);
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
  implied: Set<string>;
  web: WebIndex;
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
  const linked = new Set<string>(env.implied);
  for (const edge of env.edges.values()) {
    linked.add(`${edge.from}\u0000${edge.to}`);
    linked.add(`${edge.to}\u0000${edge.from}`);
  }

  for (const fn of functions) {
    const source = lambdaNodeIdForFullName(fn.fullName, env.byLogicalId);
    if (!source || !env.nodes.has(source)) continue;
    for (const [key, value] of Object.entries(fn.environment ?? {})) {
      if (ENV_KEY_DENYLIST.has(key)) continue;
      const target = matchEnvValue(value, env) ?? webByUrl(value, env.web) ?? httpExternalNode(value, env.nodes);
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

// --- Lambda Web Functions ------------------------------------------------------

interface WebIndex {
  // Revision / endpoint / function logical id → the web-function node.
  byRevision: Map<string, string>;
  byLogicalId: Map<string, string>;
  // Local endpoint port → node: a registered event function's environment
  // carries the endpoint's DomainName resolved to `http://localhost:<port>`.
  byPort: Map<number, string>;
  revisions: WebFunctionRevisionResource[];
}

/**
 * Fold each web function's revisions and endpoints into its node's facts, and
 * index every logical id that stands for it.
 *
 * A revision or an endpoint names its function by logical id (`Ref`), by
 * `FunctionName`, or by ARN — the parser has already reduced the first to the
 * logical id, so matching on id, name or ARN tail covers all three.
 */
function indexWebFunctions(
  resources: Resource[],
  nodes: Map<string, GraphNode>,
  registered: RegisteredWebFunction[],
): WebIndex {
  const index: WebIndex = { byRevision: new Map(), byLogicalId: new Map(), byPort: new Map(), revisions: [] };
  const functions = resources.filter((r): r is WebFunctionResource => r.type === 'web-function');
  const owner = (ref: string): WebFunctionResource | undefined => functions.find(fn =>
    fn.logicalId === ref || fn.name === ref || ref.endsWith(`:web-function/${fn.name}`));
  const revisions = new Map<string, WebFunctionRevisionResource[]>();
  const endpoints = new Map<string, WebFunctionEndpointResource[]>();
  for (const resource of resources) {
    if (resource.type !== 'web-function-revision' && resource.type !== 'web-function-endpoint') continue;
    const fn = owner(resource.functionRef);
    if (!fn) continue;
    const id = nodeId('web-function', fn.logicalId);
    index.byLogicalId.set(resource.logicalId, id);
    if (resource.type === 'web-function-revision') {
      index.byRevision.set(resource.logicalId, id);
      index.revisions.push(resource);
      revisions.set(fn.logicalId, [...(revisions.get(fn.logicalId) ?? []), resource]);
    } else {
      endpoints.set(fn.logicalId, [...(endpoints.get(fn.logicalId) ?? []), resource]);
    }
  }
  for (const fn of functions) {
    const id = nodeId('web-function', fn.logicalId);
    index.byLogicalId.set(fn.logicalId, id);
    const ownRevisions = revisions.get(fn.logicalId) ?? [];
    const ownEndpoints = (endpoints.get(fn.logicalId) ?? []).map(endpoint => endpoint.name).sort();
    const facts: Record<string, GraphFactValue> = { revisions: ownRevisions.length };
    if (ownRevisions.length) facts.runtime = ownRevisions[0].runtime;
    if (ownEndpoints.length) facts.endpoints = ownEndpoints.join(', ');
    const live = registered.find(candidate => candidate.logicalId === fn.logicalId);
    const ports = (live?.endpoints ?? [])
      .filter((endpoint): endpoint is typeof endpoint & { port: number } => typeof endpoint.port === 'number')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const endpoint of ports) index.byPort.set(endpoint.port, id);
    if (ports.length) facts.url = `http://localhost:${ports[0].port}`;
    nodes.get(id)!.facts = facts;
  }
  return index;
}

// The node a CloudFormation reference inside an environment value points at:
// `{Ref}` / `{Fn::GetAtt}` directly, or anywhere inside a `Fn::Join` /
// `Fn::Sub` argument list (`https://` + the endpoint's DomainName). Web
// functions first — an endpoint or a revision stands for its function.
function intrinsicTarget(value: unknown, web: WebIndex, ctx: EdgeContext): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const logicalId = refLogicalId(value);
  if (logicalId) {
    const webNode = web.byLogicalId.get(logicalId);
    if (webNode) return webNode;
    const resource = ctx.byLogicalId.get(logicalId);
    const kind = resource ? nodeKindFor(resource) : null;
    return kind ? nodeId(kind, logicalId) : null;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = intrinsicTarget(nested, web, ctx);
    if (found) return found;
  }
  return null;
}

/**
 * The environment edges web functions add.
 *
 * - A web function's own environment (each revision's `EnvironmentVariables`):
 *   a CloudFormation reference is a DECLARED edge, a plain string goes through
 *   the same name/ARN/URL matching as an event function's (inferred).
 * - An event function whose environment references a web endpoint (the
 *   `https://${Endpoint.DomainName}` idiom) gets a declared `invoke` edge to
 *   the web function — it calls it over HTTP. Read from the raw template,
 *   because serverless-state only keeps the resolved string.
 */
function addWebEnvEdges(rawResources: Record<string, RawResource>, env: EnvContext): void {
  const { web } = env;
  for (const revision of web.revisions) {
    const source = web.byRevision.get(revision.logicalId)!;
    for (const [key, value] of Object.entries(revision.environment)) {
      if (ENV_KEY_DENYLIST.has(key)) continue;
      const declared = intrinsicTarget(value, web, env);
      const target = declared
        ?? (typeof value === 'string' ? matchEnvValue(value, env) ?? httpExternalNode(value, env.nodes) : null);
      if (!target || target === source) continue;
      addEdge(env.edges, { from: source, to: target, kind: 'env', detail: key, confidence: declared ? 'declared' : 'inferred' });
    }
  }
  for (const [logicalId, resource] of Object.entries(rawResources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const source = nodeId('lambda', logicalId);
    if (!env.nodes.has(source)) continue;
    const variables = (resource.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {};
    for (const [key, value] of Object.entries(variables)) {
      const target = intrinsicTarget(value, web, env);
      if (!target || !target.startsWith('web-function:')) continue;
      addEdge(env.edges, { from: source, to: target, kind: 'env', detail: key, confidence: 'declared', access: 'invoke' });
    }
  }
}

// An env value that is a web endpoint's local URL (`http://localhost:<port>`,
// what the registrar resolves its DomainName to).
function webByUrl(value: string, web: WebIndex): string | null {
  const match = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?/i.exec(value);
  return match ? web.byPort.get(Number(match[1])) ?? null : null;
}

/**
 * A third-party HTTP dependency: an env value that is an absolute `http(s)://`
 * URL to a host that is neither LSS nor AWS. One node per HOST, labelled with
 * it, `service: 'http'` — the "payment provider" box on the right of an
 * architecture diagram. Like every env edge it is `inferred`: the variable
 * proves the function KNOWS the URL, not that it calls it.
 *
 * Only reached when `matchEnvValue` found no declared resource, so a queue URL
 * served by the engine never gets here; the host test below is for the URLs
 * that name nothing declared.
 */
function httpExternalNode(value: string, nodes: Map<string, GraphNode>): string | null {
  if (!/^https?:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // `new URL` refuses an http(s) URL with an empty host, so a parsed one
  // always has a hostname.
  const host = url.hostname.toLowerCase();
  if (isLssOrAwsHost(host, url.port)) return null;
  const id = nodeId('external', `http:${host}`);
  if (!nodes.has(id)) nodes.set(id, { id, kind: 'external', label: host, service: 'http' });
  return id;
}

// LSS itself (the loopback names, the docker host alias, and the two port
// blocks the per-service listeners are allocated from: 3xxx for the API
// gateway, 13xxx for the invoke API) and AWS (`*.amazonaws.com`, a real
// endpoint for a resource rather than a third party). Everything else is
// somebody else's service.
function isLssOrAwsHost(host: string, port: string): boolean {
  if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'host.docker.internal'].includes(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.amazonaws.com')) return true;
  const portNumber = Number(port);
  return (portNumber >= 3000 && portNumber <= 3999) || (portNumber >= 13000 && portNumber <= 13999);
}

// A name is matched against every kind, because an env var does not say which
// service it points at. A name colliding across two kinds is vanishingly rare
// and the first match is deterministic (insertion order = template order).
function findByName(byKindAndName: Map<string, Resource>, name: string): string | null {
  for (const [key, resource] of byKindAndName) {
    const [kind, declared] = key.split('\u0000');
    if (declared === normaliseName(kind as GraphNodeKind, name) && 'logicalId' in resource && resource.logicalId) {
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
