import type { Http } from '../http';
import type { ResourceOwners } from '../types';

export interface ResourcesApi {
  /** GET /api/resources — all provisioned resources for a region. */
  list(region?: string): Promise<unknown>;
  /** GET /api/resources/owners — map each resource to the service that declared it. */
  owners(region?: string): Promise<ResourceOwners>;
}

export function createResourcesApi(http: Http, defaultRegion?: string): ResourcesApi {
  const reg = (r?: string) => r ?? defaultRegion;
  return {
    list: (r) => http.json('GET', '/api/resources', { query: { region: reg(r) } }),
    owners: (r) => http.json('GET', '/api/resources/owners', { query: { region: reg(r) } }),
  };
}
