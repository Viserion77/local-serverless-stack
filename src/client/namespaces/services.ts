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

export interface ServicesApi {
  register(input: RegisterServiceInput): Promise<unknown>;
  list(): Promise<unknown[]>;
  get(name: string): Promise<unknown>;
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
    list: () => http.json('GET', '/api/services'),
    get: (name) => http.json('GET', base(name)),
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
