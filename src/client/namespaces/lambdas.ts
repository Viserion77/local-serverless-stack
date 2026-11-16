import type { Http } from '../http';

export interface LambdaSummary {
  name: string;
  fullName: string;
  service: string;
  handler: string;
  runtime: string;
  memorySize: number;
  timeout: number;
  triggers: string[];
  invokePort?: number;
  status: 'stopped' | 'starting' | 'online' | 'error';
  executionMode?: 'artifact' | 'source';
  invocations: number;
  errors: number;
  lastInvokedAt?: number;
  lastDurationMs?: number;
  lastOk?: boolean;
}

export interface LambdaDetail extends LambdaSummary {
  environment: Record<string, string>;
  routes: Array<{ method: string; path: string; eventType: 'http' | 'httpApi'; authorizerName?: string }>;
}

export interface InvokeLambdaInput {
  payload?: unknown;
  // 'Event' fires and forgets (202); default is synchronous RequestResponse.
  invocationType?: 'RequestResponse' | 'Event';
}

export interface InvokeLambdaResult {
  ok: boolean;
  payload?: unknown;
  functionError?: { errorType?: string; errorMessage?: string; trace?: string[] };
  logs: string[];
  durationMs: number;
}

export interface LambdaInvocationRecord {
  at: number;
  functionName: string;
  ok: boolean;
  // HTTP status of an API-Gateway-shaped payload, when the handler returned one.
  statusCode?: number;
  durationMs: number;
  logs: string[];
}

// --- Lambda Web Functions ---------------------------------------------------

export type WebFunctionState = 'cold' | 'starting' | 'ready' | 'error';

export interface WebFunctionEndpointInfo {
  name: string;
  logicalId: string;
  arn: string;
  authType: 'ApplicationManaged' | 'IamAuth';
  endpointType: string;
  port?: number;
  // `localhost:<port>` — what `Fn::GetAtt <Endpoint>.DomainName` resolves to.
  domainName?: string;
  // The URL to call (plain http locally; TLS ends at the endpoint on AWS).
  url?: string;
  weights: Array<{ revisionId: string; weight: number }>;
  listener: 'online' | 'port-conflict' | 'stopped';
}

export interface WebFunctionRevisionInfo {
  revisionId: string;
  logicalId: string;
  arn: string;
  runtime: string;
  description?: string;
  timeoutSeconds: number;
  maxConcurrency: number;
  // Where the code is loaded from, and why.
  code: { source: 'state-entry' | 'artifact' | 'source' | 'missing'; reason: string; root: string; entry: string; artifact?: string };
  state: WebFunctionState;
  pid?: number;
  innerPort?: number;
  inFlight: number;
  queued: number;
  startedAt?: number;
  readyAt?: number;
  coldStartMs?: number;
  error?: string;
  errorType?: string;
  lastExitCode?: number | null;
}

export interface WebFunctionSummary {
  service: string;
  name: string;
  logicalId: string;
  arn: string;
  state: WebFunctionState;
  endpoints: WebFunctionEndpointInfo[];
  revisions: WebFunctionRevisionInfo[];
  warnings: string[];
  requests: number;
  errors: number;
  lastRequestAt?: number;
}

export interface WebFunctionRequestRecord {
  at: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  revisionId?: string;
  requestId: string;
  endpoint: string;
  coldStart: boolean;
  errorType?: string;
}

export interface WebFunctionLogLine {
  at: number;
  stream: 'stdout' | 'stderr' | 'lss';
  revisionId: string;
  text: string;
}

export interface WebFunctionDetail extends WebFunctionSummary {
  // Resolved environment per revision id.
  environment: Record<string, Record<string, string>>;
  // Newest first.
  recentRequests: WebFunctionRequestRecord[];
  logs: WebFunctionLogLine[];
}

export interface WebFunctionsApi {
  list(): Promise<WebFunctionSummary[]>;
  get(service: string, name: string): Promise<WebFunctionDetail>;
  /** Stop the function's environments; the next request starts them again. */
  restart(service: string, name: string): Promise<{ restarted: boolean }>;
}

export interface LambdasApi {
  list(): Promise<LambdaSummary[]>;
  get(name: string): Promise<LambdaDetail>;
  /** Invoke any registered function — including schedule/queue-only ones. */
  invoke(name: string, input?: InvokeLambdaInput): Promise<InvokeLambdaResult>;
  logs(name: string): Promise<{ invocations: LambdaInvocationRecord[] }>;
  /** Lambda Web Functions — HTTP servers run as functions, each on a stable local URL. */
  web: WebFunctionsApi;
}

export function createLambdasApi(http: Http): LambdasApi {
  const base = (name: string) => `/api/lambdas/${encodeURIComponent(name)}`;
  const webBase = (service: string, name: string) =>
    `/api/lambdas/web/${encodeURIComponent(service)}/${encodeURIComponent(name)}`;
  return {
    list: () => http.json('GET', '/api/lambdas'),
    get: (name) => http.json('GET', base(name)),
    invoke: (name, input) => http.json('POST', `${base(name)}/invoke`, { body: input ?? {} }),
    logs: (name) => http.json('GET', `${base(name)}/logs`),
    web: {
      list: () => http.json('GET', '/api/lambdas/web'),
      get: (service, name) => http.json('GET', webBase(service, name)),
      restart: (service, name) => http.json('POST', `${webBase(service, name)}/restart`, { body: {} }),
    },
  };
}
