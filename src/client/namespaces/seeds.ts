import type { Http } from '../http';
import type { ClearResult, SeedResult, SeedsListResult } from '../types';

export interface SeedsApi {
  /** GET /api/seeds — seed files on disk + the tables currently live in the engine. */
  list(region?: string): Promise<SeedsListResult>;
  /** POST /api/seeds/run — apply seed file(s). No tableName seeds every matching table. */
  run(tableName?: string, region?: string): Promise<{ results: SeedResult[] }>;
  /** POST /api/seeds/clear — delete seeded items (server enforces a local-endpoint guard). */
  clear(tableName?: string, region?: string): Promise<{ results: ClearResult[] }>;
}

export function createSeedsApi(http: Http, defaultRegion?: string): SeedsApi {
  const reg = (r?: string) => r ?? defaultRegion;
  return {
    list: (r) => http.json('GET', '/api/seeds', { query: { region: reg(r) } }),
    run: (tableName, r) =>
      http.json('POST', '/api/seeds/run', {
        body: tableName ? { tableName } : {},
        query: { region: reg(r) },
      }),
    clear: (tableName, r) =>
      http.json('POST', '/api/seeds/clear', {
        body: tableName ? { tableName } : {},
        query: { region: reg(r) },
      }),
  };
}
