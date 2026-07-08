// Programmatic client for the Local Serverless Stack orchestrator.
//
//   import { LssClient } from 'local-serverless-stack';
//   const lss = new LssClient({ configPath: 'lss.e2e.config.json' });
//   // or, pure-ENV (LSS_CONFIG / LSS_BASE_URL / AWS_REGION): new LssClient();
//
// Everything the `lss` CLI does, callable from Jest at runtime. The data-plane
// (seeds/queues/dynamo/buckets/resources/services/config/health) is HTTP against
// a running orchestrator; lifecycle (start/stop/status/logs) shells out to the CLI.

import { resolveConfig } from './config-discovery';
import { Http, type QueryValue } from './http';
import { Lifecycle, type LifecycleApi } from './lifecycle';
import { createSeedsApi, type SeedsApi } from './namespaces/seeds';
import { createQueuesApi, type QueuesApi } from './namespaces/queues';
import { createDynamoApi, type DynamoApi } from './namespaces/dynamo';
import { createBucketsApi, type BucketsApi } from './namespaces/buckets';
import { createResourcesApi, type ResourcesApi } from './namespaces/resources';
import { createServicesApi, type ServicesApi } from './namespaces/services';
import { createConfigApi, type ConfigApi } from './namespaces/config';
import { createHealthApi, type HealthApi } from './namespaces/health';
import { createLambdasApi, type LambdasApi } from './namespaces/lambdas';
import { createApisApi, type ApisApi } from './namespaces/apis';
import type { LssClientOptions } from './types';

export class LssClient {
  /** Resolved base URL the data-plane talks to. */
  readonly baseUrl: string;
  readonly seeds: SeedsApi;
  readonly queues: QueuesApi;
  readonly dynamo: DynamoApi;
  readonly buckets: BucketsApi;
  readonly resources: ResourcesApi;
  readonly services: ServicesApi;
  readonly config: ConfigApi;
  readonly health: HealthApi;
  readonly lambdas: LambdasApi;
  readonly apis: ApisApi;
  readonly lifecycle: LifecycleApi;

  private readonly http: Http;

  constructor(options: LssClientOptions = {}) {
    const cfg = resolveConfig(options);
    this.http = new Http({ baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
    this.baseUrl = cfg.baseUrl;

    this.seeds = createSeedsApi(this.http, cfg.region);
    this.queues = createQueuesApi(this.http, cfg.region);
    this.dynamo = createDynamoApi(this.http, cfg.region);
    this.buckets = createBucketsApi(this.http, cfg.region);
    this.resources = createResourcesApi(this.http, cfg.region);
    this.services = createServicesApi(this.http);
    this.config = createConfigApi(this.http);
    this.health = createHealthApi(this.http);
    this.lambdas = createLambdasApi(this.http);
    this.apis = createApisApi(this.http);
    this.lifecycle = new Lifecycle({ health: this.health, cwd: cfg.cwd, configPath: cfg.configPath });
  }

  /** Escape hatch for an arbitrary orchestrator call not covered by a namespace. */
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    return this.http.json<T>(method, path, { body, query });
  }
}

export { LssHttpError } from './http';
export type { SeedsApi } from './namespaces/seeds';
export type { QueuesApi } from './namespaces/queues';
export type { DynamoApi } from './namespaces/dynamo';
export type { BucketsApi } from './namespaces/buckets';
export type { ResourcesApi } from './namespaces/resources';
export type { ServicesApi } from './namespaces/services';
export type { ConfigApi } from './namespaces/config';
export type { HealthApi } from './namespaces/health';
export type {
  LambdasApi,
  LambdaSummary,
  LambdaDetail,
  InvokeLambdaInput,
  InvokeLambdaResult,
  LambdaInvocationRecord,
} from './namespaces/lambdas';
export type {
  ApisApi,
  ServiceApiInfo,
  ApiRouteInfo,
  ApiAuthorizerInfo,
  GatewayListenerStatus,
} from './namespaces/apis';
export type { ServiceRuntimeStatus } from './namespaces/services';
export type {
  LifecycleApi,
  StartOptions,
  StartResult,
  StopResult,
  StatusResult,
  LogsResult,
  WaitUntilReadyOptions,
} from './lifecycle';
export type * from './types';
