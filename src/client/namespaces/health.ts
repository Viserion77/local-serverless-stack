import type { Http } from '../http';
import type { HealthStatus } from '../types';

export interface HealthApi {
  /** GET /api/health — orchestrator + LocalStack + dynamo-proxy status. */
  get(): Promise<HealthStatus>;
}

export function createHealthApi(http: Http): HealthApi {
  return {
    get: () => http.json('GET', '/api/health'),
  };
}
