import type { Http } from '../http';
import type { RegisterServiceInput, StartServiceInput } from '../types';

export interface ServicesApi {
  register(input: RegisterServiceInput): Promise<unknown>;
  list(): Promise<unknown[]>;
  get(name: string): Promise<unknown>;
  remove(name: string): Promise<{ success: true }>;
  setStatus(name: string, body: { status?: string; pid?: number }): Promise<{ success: true }>;
  start(name: string, input?: StartServiceInput): Promise<{ success: boolean; pid?: number; status?: string }>;
  stop(name: string): Promise<{ success: boolean }>;
  logs(name: string): Promise<unknown>;
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
  };
}
