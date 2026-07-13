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

export interface LambdasApi {
  list(): Promise<LambdaSummary[]>;
  get(name: string): Promise<LambdaDetail>;
  /** Invoke any registered function — including schedule/queue-only ones. */
  invoke(name: string, input?: InvokeLambdaInput): Promise<InvokeLambdaResult>;
  logs(name: string): Promise<{ invocations: LambdaInvocationRecord[] }>;
}

export function createLambdasApi(http: Http): LambdasApi {
  const base = (name: string) => `/api/lambdas/${encodeURIComponent(name)}`;
  return {
    list: () => http.json('GET', '/api/lambdas'),
    get: (name) => http.json('GET', base(name)),
    invoke: (name, input) => http.json('POST', `${base(name)}/invoke`, { body: input ?? {} }),
    logs: (name) => http.json('GET', `${base(name)}/logs`),
  };
}
