import type { Http } from '../http';
import type { RegisterServiceInput, StartServiceInput } from '../types';

export interface ServiceRuntimeStatus {
  runtime: {
    status: 'stopped' | 'starting' | 'online' | 'error';
    executionMode?: 'auto' | 'artifact' | 'source';
    resolvedMode?: 'artifact' | 'source';
    handlerRoot?: string;
    pid?: number;
    startedAt?: number;
    error?: string;
    invocations: number;
    errors: number;
    lastInvokedAt?: number;
  };
  gateway: {
    api: { port?: number; status: 'online' | 'port-conflict' | 'stopped' | 'disabled' };
    invoke: { port?: number; status: 'online' | 'port-conflict' | 'stopped' | 'disabled' };
  };
  watch: {
    watching: boolean;
    lastReloadAt?: number;
    lastReloadKind?: 'runtime' | 'full';
    lastError?: string;
  };
}

// One row of GET /api/services/scan — a discovered (not necessarily
// registered) Serverless/osls service under the project root.
export interface ScannedService {
  name: string;
  root: string;
  relPath: string;
  configFile: string;
  installed: boolean;
  packaged: boolean;
  registered: boolean;
  region?: string;
  // Effective values: `serviceRuntime` config overrides win over yml hints.
  apiPort?: number;
  invokePort?: number;
  // Effective package command for this service (servicePackaging else global).
  packageCommand: string;
  // `code` is what a localised surface translates; `message` is the English
  // fallback and what a non-localised consumer (log, script) reads.
  warnings: ScanWarning[];
}

export interface ScanWarning {
  code: string;
  message: string;
  params?: Record<string, string>;
}

// Result of the preparation endpoints (install/package).
export interface PrepareServiceResult {
  success: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

// --- GET /api/services/:name/graph -------------------------------------------
// The wiring of one service, mirrored from the orchestrator's own shape rather
// than imported from it: `rootDir` for this build is `src/client`, so a
// `src/server` import would not compile into dist/client at all — the same
// reason `ApiRouteInfo` is redeclared in namespaces/apis.ts instead of reusing
// the parser's `HttpRoute`.

/**
 * What a node stands for. `route` and `iam-role` have no counterpart among the
 * provisioned resource types: a route is declared in `serverless-state.json`,
 * and a role is never provisioned. `external` is anything the service
 * references but does not declare — the cross-service links.
 */
export type ServiceGraphNodeKind =
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

/**
 * How an edge was established. The distinction is the point of the payload:
 * `iam` and `env` are far weaker evidence than the rest.
 */
export type ServiceGraphEdgeKind =
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

export interface ServiceGraphNode {
  // Stable within one graph: `<kind>:<logicalId>` for declared resources,
  // `route:<METHOD> <path>` for routes, `external:<arn-or-name>` otherwise.
  id: string;
  kind: ServiceGraphNodeKind;
  // Never assumed to be unique — two services can both declare an `OrdersTable`.
  label: string;
  logicalId?: string;
  // Route nodes only.
  method?: string;
  path?: string;
  // Lambda nodes only: the fully qualified `<service>-<stage>-<fn>` name.
  fullName?: string;
  handler?: string;
  // External nodes only: the ARN (or bare name) that could not be attributed to
  // anything this service declares, plus the AWS service it names.
  arn?: string;
  service?: string;
}

export interface ServiceGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: ServiceGraphEdgeKind;
  // The HTTP verb, the S3 event names, the granted IAM actions, the env var
  // name — whatever makes the edge checkable by a human.
  detail?: string;
  // `declared` — CloudFormation (or serverless-state) wires this edge.
  // `inferred` — LSS deduced it from a name match and could be wrong. Only
  // `env` edges are ever inferred.
  confidence: 'declared' | 'inferred';
  // Set on an env-var edge identical on EVERY function of the service — it came
  // from `provider.environment` and says nothing about this function in
  // particular, so a consumer should subordinate it.
  serviceWide?: boolean;
}

export interface ServiceGraph {
  service: string;
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
  // Which kinds actually occur, so a legend never has to re-scan the edges.
  edgeKinds: ServiceGraphEdgeKind[];
  // Non-fatal findings: a reference that pointed at nothing, an unsupported
  // intrinsic — surfaced rather than swallowed. A service with no cached
  // template answers an empty graph carrying one of these.
  warnings: string[];
}

export interface ServicesApi {
  register(input: RegisterServiceInput): Promise<unknown>;
  /** GET /api/services/scan — discover Serverless/osls services under the project root. */
  scan(): Promise<{ projectRoot: string; services: ScannedService[] }>;
  /** POST /api/services/install — install a service's dependencies (default `npm install`). */
  install(servicePath: string, command?: string): Promise<PrepareServiceResult>;
  /** POST /api/services/package — package a service with its effective package command. */
  package(servicePath: string): Promise<PrepareServiceResult>;
  list(): Promise<unknown[]>;
  get(name: string): Promise<unknown>;
  /**
   * GET /api/services/:name/graph — the service's DECLARED wiring (nodes,
   * edges and the evidence for each), derived from the packaged template. It
   * answers for a stopped service too: nothing here is read from the engine.
   */
  graph(name: string): Promise<ServiceGraph>;
  remove(name: string): Promise<{ success: true }>;
  setStatus(name: string, body: { status?: string; pid?: number }): Promise<{ success: true }>;
  start(name: string, input?: StartServiceInput): Promise<{ success: boolean; pid?: number; status?: string }>;
  stop(name: string): Promise<{ success: boolean }>;
  logs(name: string): Promise<unknown>;
  /** Lambda runtime + gateway/invoke listener status for one service. */
  runtime(name: string): Promise<ServiceRuntimeStatus>;
  /** Start (or restart) the service's Lambda runtime worker and listeners. */
  startRuntime(name: string): Promise<{ success: boolean }>;
  /** Stop the service's Lambda runtime worker and listeners. */
  stopRuntime(name: string): Promise<{ success: boolean }>;
}

export function createServicesApi(http: Http): ServicesApi {
  const base = (name: string) => `/api/services/${encodeURIComponent(name)}`;
  return {
    register: (input) => http.json('POST', '/api/services/register', { body: input }),
    scan: () => http.json('GET', '/api/services/scan'),
    install: (servicePath, command) => http.json('POST', '/api/services/install', { body: { servicePath, command } }),
    package: (servicePath) => http.json('POST', '/api/services/package', { body: { servicePath } }),
    list: () => http.json('GET', '/api/services'),
    get: (name) => http.json('GET', base(name)),
    graph: (name) => http.json('GET', `${base(name)}/graph`),
    remove: (name) => http.json('DELETE', base(name)),
    setStatus: (name, body) => http.json('PATCH', `${base(name)}/status`, { body }),
    start: (name, input) => http.json('POST', `${base(name)}/start`, { body: input ?? {} }),
    stop: (name) => http.json('POST', `${base(name)}/stop`),
    logs: (name) => http.json('GET', `${base(name)}/logs`),
    runtime: (name) => http.json('GET', `${base(name)}/runtime`),
    startRuntime: (name) => http.json('POST', `${base(name)}/runtime/start`),
    stopRuntime: (name) => http.json('POST', `${base(name)}/runtime/stop`),
  };
}
