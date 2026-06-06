import type { Http } from '../http';
import type { BucketSnapshot, ListObjectsInput, ListObjectsResult, PutObjectInput } from '../types';

export interface BucketsApi {
  list(region?: string): Promise<BucketSnapshot[]>;
  get(name: string, region?: string): Promise<BucketSnapshot>;
  listObjects(name: string, input?: ListObjectsInput, region?: string): Promise<ListObjectsResult>;
  /** GET /api/buckets/:name/objects/content — returns the raw object body as a Buffer. */
  getObject(name: string, key: string, opts?: { download?: boolean }, region?: string): Promise<Buffer>;
  putObject(name: string, input: PutObjectInput, region?: string): Promise<{ success: true }>;
  deleteObject(name: string, key: string, region?: string): Promise<{ success: true }>;
}

export function createBucketsApi(http: Http, defaultRegion?: string): BucketsApi {
  const reg = (r?: string) => r ?? defaultRegion;
  const base = (name: string) => `/api/buckets/${encodeURIComponent(name)}`;
  return {
    list: (r) => http.json('GET', '/api/buckets', { query: { region: reg(r) } }),
    get: (name, r) => http.json('GET', base(name), { query: { region: reg(r) } }),
    listObjects: (name, input, r) =>
      http.json('GET', `${base(name)}/objects`, {
        query: {
          prefix: input?.prefix,
          continuationToken: input?.continuationToken,
          delimiter: input?.delimiter,
          maxKeys: input?.maxKeys,
          region: reg(r),
        },
      }),
    getObject: (name, key, opts, r) =>
      http.raw('GET', `${base(name)}/objects/content`, {
        query: { key, download: opts?.download ? '1' : undefined, region: reg(r) },
      }),
    putObject: (name, input, r) =>
      http.json('POST', `${base(name)}/objects`, { body: input, query: { region: reg(r) } }),
    deleteObject: (name, key, r) =>
      http.json('DELETE', `${base(name)}/objects`, { query: { key, region: reg(r) } }),
  };
}
