import type { Http } from '../http';

export type GatewayListenerStatus = 'online' | 'port-conflict' | 'stopped' | 'disabled';

export interface ApiRouteInfo {
  method: string;
  path: string;
  functionName: string;
  eventType: 'http' | 'httpApi';
  payloadVersion: '1.0' | '2.0';
  cors: boolean;
  authorizerName?: string;
}

export interface ApiAuthorizerInfo {
  name: string;
  type: 'request' | 'token';
  eventType: 'http' | 'httpApi';
  payloadVersion: '1.0' | '2.0';
  enableSimpleResponses: boolean;
  identitySource: string[];
  resultTtlInSeconds: number;
  functionName?: string;
  arn?: string;
}

export interface ServiceApiInfo {
  service: string;
  apiPort?: number;
  invokePort?: number;
  stage?: string;
  status: GatewayListenerStatus;
  invokeStatus: GatewayListenerStatus;
  routes: ApiRouteInfo[];
  authorizers: ApiAuthorizerInfo[];
}

export interface ApisApi {
  list(): Promise<ServiceApiInfo[]>;
  /**
   * Flush cached authorizer results (all, per service, or per authorizer) —
   * lets e2e suites switch identities without waiting out resultTtlInSeconds.
   */
  clearAuthorizerCache(filter?: { service?: string; authorizer?: string }): Promise<{ success: true; removed: number }>;
}

export function createApisApi(http: Http): ApisApi {
  return {
    list: () => http.json('GET', '/api/apis'),
    clearAuthorizerCache: (filter) =>
      http.json('POST', '/api/apis/authorizer-cache/clear', {
        query: { service: filter?.service, authorizer: filter?.authorizer },
      }),
  };
}
