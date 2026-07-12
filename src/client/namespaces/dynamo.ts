import type { Http } from '../http';
import type {
  DynamoTableDetail,
  DynamoTableSummary,
  ScanQueryInput,
  ScanQueryOutput,
  TtlInfo,
} from '../types';

export interface DynamoApi {
  listTables(region?: string): Promise<{ tables: DynamoTableSummary[] }>;
  describeTable(name: string, region?: string): Promise<DynamoTableDetail>;
  getTtl(name: string, region?: string): Promise<TtlInfo>;
  setTtl(name: string, enabled: boolean, attributeName?: string, region?: string): Promise<TtlInfo>;
  scan(name: string, input?: ScanQueryInput, region?: string): Promise<ScanQueryOutput>;
  query(name: string, input: ScanQueryInput, region?: string): Promise<ScanQueryOutput>;
  getItem(name: string, key: Record<string, unknown>, region?: string): Promise<{ item: Record<string, unknown> | null }>;
  putItem(name: string, item: Record<string, unknown>, region?: string): Promise<{ success: true }>;
  deleteItem(name: string, key: Record<string, unknown>, region?: string): Promise<{ success: true }>;
}

export function createDynamoApi(http: Http, defaultRegion?: string): DynamoApi {
  const reg = (r?: string) => r ?? defaultRegion;
  const table = (name: string) => `/api/dynamo/tables/${encodeURIComponent(name)}`;
  return {
    listTables: (r) => http.json('GET', '/api/dynamo/tables', { query: { region: reg(r) } }),
    describeTable: (name, r) => http.json('GET', table(name), { query: { region: reg(r) } }),
    getTtl: (name, r) => http.json('GET', `${table(name)}/ttl`, { query: { region: reg(r) } }),
    setTtl: (name, enabled, attributeName, r) =>
      http.json('PUT', `${table(name)}/ttl`, {
        body: { enabled, attributeName },
        query: { region: reg(r) },
      }),
    scan: (name, input, r) =>
      http.json('POST', `${table(name)}/scan`, { body: input ?? {}, query: { region: reg(r) } }),
    query: (name, input, r) =>
      http.json('POST', `${table(name)}/query`, { body: input, query: { region: reg(r) } }),
    getItem: (name, key, r) =>
      http.json('POST', `${table(name)}/items/get`, { body: { key }, query: { region: reg(r) } }),
    putItem: (name, item, r) =>
      http.json('POST', `${table(name)}/items`, { body: { item }, query: { region: reg(r) } }),
    deleteItem: (name, key, r) =>
      http.json('POST', `${table(name)}/items/delete`, { body: { key }, query: { region: reg(r) } }),
  };
}
