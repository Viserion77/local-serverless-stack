// Runs Lambda authorizers for the gateway proxy: extracts the identity source,
// builds the authorizer event (REST v1 TOKEN/REQUEST or HTTP API payload
// 1.0/2.0), invokes the target function — resolving cross-service ARNs through
// the global registry — and caches the authorizer's OUTPUT per
// resultTtlInSeconds.
//
// What is cached is the returned policy (or simple response), never the
// allow/deny decision: like API Gateway, a cached policy is re-evaluated
// against every request's methodArn. That is what makes the classic AWS
// pitfall reproducible locally — an authorizer that returns
// `Resource: event.methodArn` with caching on authorizes the first route it
// saw and 403s the caller's other routes until the TTL runs out.

import crypto from 'crypto';
import { FunctionRegistry } from './function-registry.js';
import { LambdaRuntimeManager } from './lambda-runtime-manager.js';
import type { AuthorizerConfig } from './serverless-state-parser.js';
import {
  DEFAULT_ACCOUNT_ID,
  LOCAL_API_ID,
  type IncomingRequest,
  type AuthorizerOutput,
  type GatewayResponseType,
} from './api-gateway-events.js';
import type { HttpRoute } from './serverless-state-parser.js';

export interface AuthorizerDecision {
  // The gateway response to short-circuit with — UNAUTHORIZED (401: missing
  // identity source, or a REST authorizer that threw "Unauthorized"),
  // ACCESS_DENIED (403: the policy did not allow the methodArn, or a simple
  // response said no), AUTHORIZER_CONFIGURATION_ERROR (500: the authorizer
  // failed or returned a malformed answer). Absent when authorized.
  denial?: Extract<GatewayResponseType, 'UNAUTHORIZED' | 'ACCESS_DENIED' | 'AUTHORIZER_CONFIGURATION_ERROR'>;
  // ACCESS_DENIED only: a Deny statement matched (REST words its 403 body
  // differently for an explicit deny and for "no Allow matched").
  explicitDeny?: boolean;
  authorizer?: AuthorizerOutput;
}

// Per-request facts the gateway knows and the authorizer event needs.
export interface AuthorizeContext {
  // Region / account stamped into the methodArn and requestContext.
  region?: string;
  accountId?: string;
  // Path parameters of the matched route (REQUEST authorizers receive them).
  pathParameters?: Record<string, string> | null;
  // The gateway's per-request id, shared with the integration event.
  requestId?: string;
}

// What an authorizer said, normalized — the unit of caching.
type AuthorizerAnswer =
  | { kind: 'simple'; isAuthorized: boolean; context: Record<string, unknown> }
  | {
    kind: 'policy';
    principalId?: string;
    statements: PolicyStatement[];
    context: Record<string, unknown>;
    // The API key a REST authorizer hands back for an AUTHORIZER-sourced
    // API key check. Cached with the policy, as API Gateway does.
    usageIdentifierKey?: string;
  };

interface PolicyStatement {
  Effect?: unknown;
  Action?: unknown;
  Resource?: unknown;
}

interface CacheEntry {
  expiresAt: number;
  answer: AuthorizerAnswer;
  service: string;
  // Every configured name that resolved to this cache — the serverless
  // shorthand registers one name per route (`<function>:<authorizer>`) for
  // what is a single authorizer on the API; clearCache matches any of them.
  names: Set<string>;
}

export interface AuthorizerCacheStats {
  entries: number;
  hits: number;
  misses: number;
}

export type PolicyVerdict = 'allow' | 'deny' | 'implicit-deny';

export class AuthorizerService {
  private static instance: AuthorizerService;
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  // Clock for TTL bookkeeping — injectable so tests move time instead of
  // sleeping through a resultTtlInSeconds.
  now: () => number = Date.now;

  static getInstance(): AuthorizerService {
    if (!AuthorizerService.instance) {
      AuthorizerService.instance = new AuthorizerService();
    }
    return AuthorizerService.instance;
  }

  clearCache(filter?: { service?: string; authorizer?: string }): number {
    if (!filter?.service && !filter?.authorizer) {
      const size = this.cache.size;
      this.cache.clear();
      return size;
    }
    let removed = 0;
    for (const [key, entry] of [...this.cache.entries()]) {
      if (filter.service && entry.service !== filter.service) continue;
      if (filter.authorizer && !this.nameMatches(entry.names, filter.authorizer)) continue;
      this.cache.delete(key);
      removed++;
    }
    return removed;
  }

  // Hit/miss counters since boot (a cache-disabled authorizer counts neither)
  // and the number of live entries.
  getCacheStats(): AuthorizerCacheStats {
    const now = this.now();
    let entries = 0;
    for (const entry of this.cache.values()) if (entry.expiresAt > now) entries++;
    return { entries, hits: this.hits, misses: this.misses };
  }

  // A filter matches the registered name itself or its bare authorizer part
  // (`users:auth` answers to both "users:auth" and "auth").
  private nameMatches(names: Set<string>, filter: string): boolean {
    for (const name of names) {
      if (name === filter || name.endsWith(`:${filter}`)) return true;
    }
    return false;
  }

  async authorize(
    serviceName: string,
    stage: string,
    route: HttpRoute,
    config: AuthorizerConfig,
    request: IncomingRequest,
    context: AuthorizeContext = {},
  ): Promise<AuthorizerDecision> {
    const identityValues = this.extractIdentity(config, request);
    if (identityValues === null) {
      return { denial: 'UNAUTHORIZED' };
    }

    const region = context.region || 'us-east-1';
    const accountId = context.accountId || DEFAULT_ACCOUNT_ID;
    const methodArn = `arn:aws:execute-api:${region}:${accountId}:${LOCAL_API_ID}/${stage}/${request.method.toUpperCase()}${request.path}`;

    const caching = config.resultTtlInSeconds > 0;
    const cacheKey = this.cacheKey(serviceName, config, identityValues);
    if (caching) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > this.now()) {
        this.hits++;
        cached.names.add(config.name);
        return this.decide(cached.answer, methodArn);
      }
      this.cache.delete(cacheKey);
      this.misses++;
    }

    const target = config.functionName || config.arn;
    const resolved = target
      ? FunctionRegistry.getInstance().resolve(target, config.functionName ? serviceName : undefined)
      : undefined;
    if (!resolved) {
      const hint = config.arn
        ? `authorizer ARN "${config.arn}" does not match any registered function — register the owning service with LSS first`
        : `authorizer function "${target}" not found in service "${serviceName}"`;
      console.error(`❌ Authorizer "${config.name}": ${hint}`);
      return { denial: 'AUTHORIZER_CONFIGURATION_ERROR' };
    }

    const event = this.buildAuthorizerEvent(config, route, request, identityValues, stage, {
      ...context, region, accountId, methodArn,
    });
    const result = await LambdaRuntimeManager.getInstance().invoke(resolved.service.name, resolved.fn, event);

    if (!result.ok) {
      // REST convention: an authorizer that fails with exactly "Unauthorized"
      // (`throw new Error('Unauthorized')` / `callback('Unauthorized')`) is a
      // 401. Any other failure is AuthorizerConfigurationException — a 500.
      // HTTP APIs have no such convention: every authorizer failure is a 500
      // (only a missing identity source yields their 401).
      if (config.eventType === 'http' && result.errorMessage === 'Unauthorized') {
        return { denial: 'UNAUTHORIZED' };
      }
      console.error(`❌ Authorizer "${config.name}" failed: ${result.errorType}: ${result.errorMessage}`);
      return { denial: 'AUTHORIZER_CONFIGURATION_ERROR' };
    }

    const answer = this.parseAnswer(config, result.payload);
    if (!answer) {
      console.error(`❌ Authorizer "${config.name}" returned a malformed response (${this.describe(result.payload)}) — expected ${config.enableSimpleResponses ? '{isAuthorized, context}' : '{principalId, policyDocument: {Statement: [...]}, context}'}`);
      return { denial: 'AUTHORIZER_CONFIGURATION_ERROR' };
    }
    if (caching) {
      this.cache.set(cacheKey, {
        expiresAt: this.now() + config.resultTtlInSeconds * 1000,
        answer,
        service: serviceName,
        names: new Set([config.name]),
      });
    }
    return this.decide(answer, methodArn);
  }

  // One cache per authorizer on an API, not per route. The API is the
  // service (all of a service's `http` events share one REST API, its
  // `httpApi` events one HTTP API); the authorizer is identified by what
  // defines it — flavor, type, payload/response format, target function,
  // identity sources and TTL — because the serverless shorthand registers it
  // under a per-route name. The identity VALUES complete the key, as in AWS.
  private cacheKey(serviceName: string, config: AuthorizerConfig, identityValues: string[]): string {
    return JSON.stringify([
      serviceName,
      config.eventType,
      config.type,
      config.payloadVersion,
      config.enableSimpleResponses,
      config.functionName ?? config.arn,
      config.identitySource,
      config.resultTtlInSeconds,
      identityValues,
    ]);
  }

  private describe(payload: unknown): string {
    if (payload === null || typeof payload !== 'object') return String(payload);
    return `keys: ${Object.keys(payload).join(', ') || 'none'}`;
  }

  // Returns the ordered identity values, or null when any source is missing
  // (API Gateway responds 401 without invoking the authorizer in that case).
  private extractIdentity(config: AuthorizerConfig, request: IncomingRequest): string[] | null {
    const values: string[] = [];
    for (const source of config.identitySource) {
      const value = this.extractIdentityValue(source, request);
      if (!value) return null;
      values.push(value);
    }
    return values;
  }

  private extractIdentityValue(source: string, request: IncomingRequest): string | undefined {
    // v2 style: $request.header.name / $request.querystring.name
    let match = /^\$request\.header\.(.+)$/i.exec(source);
    if (match) return this.header(request, match[1]);
    match = /^\$request\.querystring\.(.+)$/i.exec(source);
    if (match) return new URLSearchParams(request.rawQueryString).get(match[1]) ?? undefined;

    // v1 style: method.request.header.name / method.request.querystring.name
    match = /^method\.request\.header\.(.+)$/i.exec(source);
    if (match) return this.header(request, match[1]);
    match = /^method\.request\.querystring\.(.+)$/i.exec(source);
    if (match) return new URLSearchParams(request.rawQueryString).get(match[1]) ?? undefined;

    // Bare header name fallback.
    return this.header(request, source);
  }

  private header(request: IncomingRequest, name: string): string | undefined {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private buildAuthorizerEvent(
    config: AuthorizerConfig,
    route: HttpRoute,
    request: IncomingRequest,
    identityValues: string[],
    stage: string,
    context: AuthorizeContext & { region: string; accountId: string; methodArn: string },
  ): Record<string, unknown> {
    const { methodArn, accountId } = context;
    const method = request.method.toUpperCase();
    const headers = this.flattenHeaders(request);
    const params = new URLSearchParams(request.rawQueryString);
    const query = Object.fromEntries(params);
    const requestId = context.requestId || crypto.randomUUID();
    const pathParameters = context.pathParameters || {};
    const now = this.now();

    if (config.eventType === 'http' && config.type === 'token') {
      return {
        type: 'TOKEN',
        methodArn,
        authorizationToken: identityValues[0],
      };
    }

    if (config.eventType === 'http' || config.payloadVersion === '1.0') {
      // REST REQUEST authorizer / HTTP API payload 1.0: the request as the
      // integration will see it (headers, query, path parameters, stage
      // variables, requestContext) plus the methodArn.
      const multiValueQuery: Record<string, string[]> = {};
      for (const key of new Set(params.keys())) multiValueQuery[key] = params.getAll(key);
      return {
        type: 'REQUEST',
        methodArn,
        resource: route.path,
        path: request.path,
        httpMethod: method,
        headers,
        multiValueHeaders: this.multiValueHeaders(request),
        queryStringParameters: query,
        multiValueQueryStringParameters: multiValueQuery,
        pathParameters,
        // LSS has no stage variables to offer; AWS sends an empty map then.
        stageVariables: {},
        requestContext: {
          accountId,
          apiId: LOCAL_API_ID,
          domainName: headers['host'] || 'localhost',
          protocol: 'HTTP/1.1',
          stage,
          requestId,
          requestTimeEpoch: now,
          identity: {
            sourceIp: request.sourceIp,
            userAgent: headers['user-agent'] || null,
          },
          httpMethod: method,
          resourcePath: route.path,
          path: request.path,
        },
      };
    }

    // HTTP API payload 2.0.
    const routeKey = route.path === '$default' ? '$default' : `${route.method} ${route.path}`;
    const cookieHeader = headers['cookie'];
    const cookies = cookieHeader ? cookieHeader.split(/;\s*/).filter(Boolean) : undefined;
    return {
      version: '2.0',
      type: 'REQUEST',
      routeArn: methodArn,
      identitySource: identityValues,
      routeKey,
      rawPath: request.rawPath ?? request.path,
      rawQueryString: request.rawQueryString,
      ...(cookies ? { cookies } : {}),
      headers,
      queryStringParameters: query,
      pathParameters,
      stageVariables: {},
      requestContext: {
        accountId,
        apiId: LOCAL_API_ID,
        domainName: headers['host'] || 'localhost',
        http: {
          method,
          path: request.path,
          protocol: 'HTTP/1.1',
          sourceIp: request.sourceIp,
          userAgent: headers['user-agent'] || '',
        },
        requestId,
        routeKey,
        stage,
        time: new Date(now).toISOString(),
        timeEpoch: now,
      },
    };
  }

  private flattenHeaders(request: IncomingRequest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      out[key] = Array.isArray(value) ? value.join(',') : value;
    }
    return out;
  }

  private multiValueHeaders(request: IncomingRequest): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      out[key] = Array.isArray(value) ? value : [value];
    }
    return out;
  }

  // Normalize the authorizer's payload; null when it is malformed (API Gateway
  // answers those with a 500 rather than guessing).
  private parseAnswer(config: AuthorizerConfig, payload: unknown): AuthorizerAnswer | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const response = payload as Record<string, unknown>;
    const context = this.contextOf(response.context);

    if (config.enableSimpleResponses) {
      // Only the literal boolean true authorizes; a missing or truthy
      // non-boolean isAuthorized is a denial, not a malformed answer.
      return { kind: 'simple', isAuthorized: response.isAuthorized === true, context };
    }

    // IAM policy response: a policyDocument with a Statement (a list, or a
    // single statement object as IAM also accepts) is mandatory.
    const policy = response.policyDocument;
    if (!policy || typeof policy !== 'object') return null;
    const statement = (policy as Record<string, unknown>).Statement;
    let statements: PolicyStatement[];
    if (Array.isArray(statement)) statements = statement as PolicyStatement[];
    else if (statement && typeof statement === 'object') statements = [statement as PolicyStatement];
    else return null;

    return {
      kind: 'policy',
      principalId: typeof response.principalId === 'string' ? response.principalId : undefined,
      statements,
      context,
      ...(typeof response.usageIdentifierKey === 'string' && response.usageIdentifierKey
        ? { usageIdentifierKey: response.usageIdentifierKey }
        : {}),
    };
  }

  private contextOf(raw: unknown): Record<string, unknown> {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  }

  // Apply a (possibly cached) answer to THIS request.
  private decide(answer: AuthorizerAnswer, methodArn: string): AuthorizerDecision {
    if (answer.kind === 'simple') {
      return answer.isAuthorized
        ? { authorizer: { context: answer.context } }
        : { denial: 'ACCESS_DENIED' };
    }
    const verdict = evaluatePolicy(answer.statements, methodArn);
    if (verdict !== 'allow') {
      return { denial: 'ACCESS_DENIED', explicitDeny: verdict === 'deny' };
    }
    return {
      authorizer: {
        principalId: answer.principalId,
        context: answer.context,
        ...(answer.usageIdentifierKey ? { usageIdentifierKey: answer.usageIdentifierKey } : {}),
      },
    };
  }
}

// IAM evaluation of an authorizer policy against the request's methodArn
// (arn:aws:execute-api:<region>:<account>:<apiId>/<stage>/<METHOD>/<path>):
// a statement applies when one of its Actions matches execute-api:Invoke and
// one of its Resources matches the methodArn, `*` and `?` being wildcards
// (`*` crosses `/`, so `.../dev/*` covers every method and path). An applying
// Deny wins over any Allow; nothing applying is an implicit deny. Effect is
// read case-insensitively (lenient — IAM itself is strict), Action
// case-insensitively (as IAM does), Resource case-sensitively.
export function evaluatePolicy(statements: PolicyStatement[], methodArn: string): PolicyVerdict {
  let allowed = false;
  for (const statement of statements) {
    if (!statement || typeof statement !== 'object') continue;
    const effect = String(statement.Effect).toLowerCase();
    if (effect !== 'allow' && effect !== 'deny') continue;
    const actionMatches = asList(statement.Action).some(a => wildcardMatch(a, 'execute-api:Invoke', true));
    const resourceMatches = asList(statement.Resource).some(r => wildcardMatch(r, methodArn, false));
    if (!actionMatches || !resourceMatches) continue;
    if (effect === 'deny') return 'deny';
    allowed = true;
  }
  return allowed ? 'allow' : 'implicit-deny';
}

function asList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function wildcardMatch(pattern: string, value: string, ignoreCase: boolean): boolean {
  const source = pattern
    .split('')
    .map(ch => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, ignoreCase ? 'is' : 's').test(value);
}
