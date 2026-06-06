import type { Http } from '../http';

export interface ConfigApi {
  /** GET /api/config — public-safe orchestrator config snapshot (never leaks the auth token). */
  get(): Promise<unknown>;
}

export function createConfigApi(http: Http): ConfigApi {
  return {
    get: () => http.json('GET', '/api/config'),
  };
}
