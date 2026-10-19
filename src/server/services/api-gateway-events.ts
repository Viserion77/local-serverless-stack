// Pure helpers for the gateway proxy: route matching, API Gateway event
// construction (REST v1.0 and HTTP API v2.0 payloads) and Lambda-result →
// HTTP-response mapping. No I/O here so every AWS-semantics edge case is
// unit-testable against real captured payloads.

import crypto from 'crypto';
import type { HttpRoute } from './serverless-state-parser.js';

export interface IncomingRequest {
  method: string;
  // Path only, no query string, percent-decoded exactly ONCE. This is what
  // API Gateway hands the integration as `path` (REST) and what goes into the
  // authorizer's methodArn.
  path: string;
  // The path as it arrived on the wire, still percent-encoded. Route matching
  // runs on this (decoding each segment once), so an encoded `/` (`%2F`) never
  // splits a segment and `%2525` reaches the handler as `%25`, not `%`. Absent
  // in hand-built requests (tests, callers that only know a decoded path), in
  // which case `path` stands in for it.
  rawPath?: string;
  rawQueryString: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | null;
  sourceIp: string;
}

export interface RouteMatch {
  route: HttpRoute;
  pathParameters: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

// Literal segments beat {param} segments, which beat {proxy+}; the httpApi
// $default route is the catch-all of last resort. An exact method beats ANY.
//
// `requestPath` is the RAW (still percent-encoded) path: every segment is
// decoded exactly once here. Matching on an already-decoded path decoded the
// parameters a second time (`%2525` → `%25` → `%`) and let an encoded slash
// (`%2F`) split one segment into two.
export function matchRoute(routes: HttpRoute[], method: string, requestPath: string): RouteMatch | null {
  const upperMethod = method.toUpperCase();
  const requestSegments = splitPath(requestPath);

  let best: { match: RouteMatch; score: number } | null = null;

  for (const route of routes) {
    if (route.method !== 'ANY' && route.method !== upperMethod) continue;

    let score: number;
    let pathParameters: Record<string, string> | null;

    if (route.path === '$default') {
      score = 0;
      pathParameters = null;
    } else {
      const result = matchSegments(splitPath(route.path), requestSegments);
      if (!result) continue;
      score = result.score;
      pathParameters = Object.keys(result.params).length ? result.params : null;
    }

    // Method specificity is the tie-breaker between equally specific paths.
    if (route.method !== 'ANY') score += 1;

    if (!best || score > best.score) {
      best = { match: { route, pathParameters }, score };
    }
  }

  return best?.match ?? null;
}

function splitPath(p: string): string[] {
  return p.split('/').filter(Boolean);
}

function matchSegments(
  routeSegments: string[],
  requestSegments: string[],
): { score: number; params: Record<string, string> } | null {
  const params: Record<string, string> = {};
  let score = 0;

  for (let i = 0; i < routeSegments.length; i++) {
    const routeSeg = routeSegments[i];
    const greedy = /^\{(.+)\+\}$/.exec(routeSeg);
    if (greedy) {
      const rest = requestSegments.slice(i);
      if (rest.length === 0) return null;
      params[greedy[1]] = safeDecode(rest.join('/'));
      return { score: score + 1, params };
    }

    const reqSeg = requestSegments[i];
    if (reqSeg === undefined) return null;

    const param = /^\{(.+)\}$/.exec(routeSeg);
    if (param) {
      params[param[1]] = safeDecode(reqSeg);
      score += 10;
    } else if (routeSeg === safeDecode(reqSeg)) {
      score += 100;
    } else {
      return null;
    }
  }

  if (requestSegments.length !== routeSegments.length) return null;
  return { score, params };
}

// Percent-decode once, tolerating malformed escapes (`%E0%A4%A`): the raw text
// is kept rather than throwing, so a bad escape is a route miss or a literal
// parameter value instead of a gateway 500.
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Shared request pieces
// ---------------------------------------------------------------------------

interface BodyInfo {
  body: string | null;
  isBase64Encoded: boolean;
}

const TEXTUAL_CONTENT = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+(json|xml)$)/i;

export function encodeBody(body: Buffer | null, contentType: string | undefined): BodyInfo {
  if (!body || body.length === 0) return { body: null, isBase64Encoded: false };
  const type = (contentType || '').split(';')[0].trim();
  if (!type || TEXTUAL_CONTENT.test(type)) {
    return { body: body.toString('utf-8'), isBase64Encoded: false };
  }
  return { body: body.toString('base64'), isBase64Encoded: true };
}

function headerValue(headers: IncomingRequest['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(',');
  return value;
}

function singleValueHeaders(headers: IncomingRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

function multiValueHeaders(headers: IncomingRequest['headers']): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value : [value];
  }
  return out;
}

function parseQuery(rawQueryString: string): {
  single: Record<string, string> | null;
  multi: Record<string, string[]> | null;
} {
  if (!rawQueryString) return { single: null, multi: null };
  const params = new URLSearchParams(rawQueryString);
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    single[key] = all[all.length - 1];
    multi[key] = all;
  }
  return { single, multi };
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export const DEFAULT_ACCOUNT_ID = '000000000000';
// The synthetic API id every local API answers as (methodArn, requestContext).
// Also the REST API id a usage plan's apiStages must name to cover a local
// API (checkApiKey) — a template's `Ref ApiGatewayRestApi` is to resolve to
// this same value so template-declared usage plans match.
export const LOCAL_API_ID = 'lss-local';

export interface AuthorizerOutput {
  principalId?: string;
  context?: Record<string, unknown>;
  // REST policy responses only: the API key value the authorizer vouches for,
  // used instead of the x-api-key header when the API's apiKeySourceType is
  // AUTHORIZER. Never surfaced in requestContext.authorizer (AWS does not).
  usageIdentifierKey?: string;
}

// The API key identity a request passed the key check with — stamped into the
// REST event as requestContext.identity.apiKey / apiKeyId.
export interface ApiKeyIdentity {
  apiKey: string;
  apiKeyId: string;
}

export interface EventOptions {
  request: IncomingRequest;
  route: HttpRoute;
  pathParameters: Record<string, string> | null;
  stage: string;
  authorizer?: AuthorizerOutput;
  // The gateway's per-request id. The gateway generates one per request and
  // reuses it for the authorizer event, this event's requestContext.requestId
  // and the x-amzn-RequestId / apigw-requestid response header — the id a
  // client quotes is the id the handler logged. Generated here when absent.
  requestId?: string;
  // Account id stamped into requestContext (the self engine's account).
  accountId?: string;
  // REST only: the API key the request was admitted with (key-protected
  // routes). Absent → identity.apiKey / apiKeyId stay null, as in AWS.
  apiKey?: ApiKeyIdentity;
}

// REST API (Lambda proxy integration, payload format 1.0).
export function buildV1Event(options: EventOptions): Record<string, unknown> {
  const { request, route, pathParameters, stage, authorizer } = options;
  const requestId = options.requestId || crypto.randomUUID();
  const accountId = options.accountId || DEFAULT_ACCOUNT_ID;
  const { single, multi } = parseQuery(request.rawQueryString);
  const { body, isBase64Encoded } = encodeBody(request.body, headerValue(request.headers, 'content-type'));

  return {
    resource: route.path,
    path: request.path,
    httpMethod: request.method.toUpperCase(),
    headers: singleValueHeaders(request.headers),
    multiValueHeaders: multiValueHeaders(request.headers),
    queryStringParameters: single,
    multiValueQueryStringParameters: multi,
    pathParameters,
    stageVariables: null,
    requestContext: {
      accountId,
      apiId: LOCAL_API_ID,
      protocol: 'HTTP/1.1',
      httpMethod: request.method.toUpperCase(),
      path: request.path,
      resourcePath: route.path,
      stage,
      requestId,
      requestTimeEpoch: Date.now(),
      identity: {
        sourceIp: request.sourceIp,
        userAgent: headerValue(request.headers, 'user-agent') || null,
        accountId: null,
        apiKey: options.apiKey?.apiKey ?? null,
        ...(options.apiKey ? { apiKeyId: options.apiKey.apiKeyId } : {}),
        caller: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        user: null,
        userArn: null,
      },
      ...(authorizer
        ? { authorizer: { principalId: authorizer.principalId, ...stringifyContext(authorizer.context) } }
        : {}),
    },
    body,
    isBase64Encoded,
  };
}

// HTTP API (payload format 2.0).
export function buildV2Event(options: EventOptions): Record<string, unknown> {
  const { request, route, pathParameters, stage, authorizer } = options;
  const requestId = options.requestId || crypto.randomUUID();
  const accountId = options.accountId || DEFAULT_ACCOUNT_ID;
  const { single } = parseQuery(request.rawQueryString);
  const { body, isBase64Encoded } = encodeBody(request.body, headerValue(request.headers, 'content-type'));

  const headers = singleValueHeaders(request.headers);
  const cookies = multiValueHeaders(request.headers)['cookie']?.flatMap(c => c.split(/;\s*/)) ?? undefined;
  delete headers['cookie'];

  const routeKey = route.path === '$default' ? '$default' : `${route.method} ${route.path}`;

  return {
    version: '2.0',
    routeKey,
    // HTTP API hands the path over as received (still percent-encoded);
    // requestContext.http.path carries the decoded form.
    rawPath: request.rawPath ?? request.path,
    rawQueryString: request.rawQueryString,
    ...(cookies && cookies.length ? { cookies } : {}),
    headers,
    queryStringParameters: single ?? undefined,
    pathParameters: pathParameters ?? undefined,
    stageVariables: undefined,
    requestContext: {
      accountId,
      apiId: LOCAL_API_ID,
      domainName: headerValue(request.headers, 'host') || 'localhost',
      domainPrefix: 'lss',
      http: {
        method: request.method.toUpperCase(),
        path: request.path,
        protocol: 'HTTP/1.1',
        sourceIp: request.sourceIp,
        userAgent: headerValue(request.headers, 'user-agent') || '',
      },
      requestId,
      routeKey,
      stage,
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      ...(authorizer
        ? { authorizer: { lambda: { principalId: authorizer.principalId, ...(authorizer.context || {}) } } }
        : {}),
    },
    body: body ?? undefined,
    isBase64Encoded,
  };
}

// REST API authorizer context values are stringified by API Gateway.
function stringifyContext(context: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

export interface MappedResponse {
  statusCode: number;
  headers: Record<string, string>;
  // Cookie values need discrete Set-Cookie headers.
  cookies: string[];
  body: Buffer;
}

interface HandlerHttpResponse {
  statusCode?: unknown;
  headers?: Record<string, unknown>;
  multiValueHeaders?: Record<string, unknown[]>;
  cookies?: unknown[];
  body?: unknown;
  isBase64Encoded?: unknown;
}

// REST API: the handler must return a well-formed {statusCode,...}; anything
// else is a 502, matching API Gateway's "Internal server error" for malformed
// proxy responses.
export function mapV1Response(payload: unknown): MappedResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return malformed();
  }
  const response = payload as HandlerHttpResponse;
  const statusCode = Number(response.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return malformed();
  }
  return {
    statusCode,
    headers: collectHeaders(response),
    cookies: [],
    body: decodeHandlerBody(response),
  };
}

// HTTP API: same shape accepted, but a bare return value is inferred as a 200
// JSON response.
export function mapV2Response(payload: unknown): MappedResponse {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'statusCode' in (payload as object)) {
    const response = payload as HandlerHttpResponse;
    const statusCode = Number(response.statusCode);
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      return malformed();
    }
    return {
      statusCode,
      headers: collectHeaders(response),
      cookies: (response.cookies || []).map(String),
      body: decodeHandlerBody(response),
    };
  }

  // Inferred response.
  const body = payload === undefined || payload === null
    ? ''
    : typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    cookies: [],
    body: Buffer.from(body, 'utf-8'),
  };
}

export function errorResponse(statusCode: number, message: string): MappedResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    cookies: [],
    body: Buffer.from(JSON.stringify({ message }), 'utf-8'),
  };
}

// ---------------------------------------------------------------------------
// Gateway-generated responses
// ---------------------------------------------------------------------------

// REST APIs (v1, `http` events) and HTTP APIs (v2, `httpApi` events) answer
// the same failure with different status codes and bodies, so every response
// the gateway produces on its own is keyed by flavor.
export type ApiFlavor = 'rest' | 'http';

export function routeFlavor(route: Pick<HttpRoute, 'eventType'>): ApiFlavor {
  return route.eventType === 'http' ? 'rest' : 'http';
}

// Flavor of a whole listener, for answers that have no route to key off (a
// miss). AWS keeps the two kinds of API on separate hosts; LSS serves both of
// a service's APIs on one port, so a listener answers as a REST API only when
// every route on it is REST — a port carrying any HTTP API route keeps the
// HTTP API answers.
export function apiFlavor(routes: Array<Pick<HttpRoute, 'eventType'>>): ApiFlavor {
  return routes.length > 0 && routes.every(r => r.eventType === 'http') ? 'rest' : 'http';
}

// The API Gateway response types the local gateway can raise itself. Named
// after the REST API GatewayResponse types so a template's overrides can be
// keyed by them.
export type GatewayResponseType =
  | 'MISSING_AUTHENTICATION_TOKEN'
  | 'UNAUTHORIZED'
  | 'ACCESS_DENIED'
  | 'AUTHORIZER_CONFIGURATION_ERROR'
  | 'INVALID_API_KEY'
  | 'INTEGRATION_FAILURE'
  | 'DEFAULT_5XX';

interface GatewayResponseDefault {
  status: number;
  body: Record<string, unknown>;
  // REST only: the x-amzn-ErrorType header API Gateway sets on its own errors.
  errorType?: string;
}

// AWS defaults, verbatim. REST quirks worth knowing:
// - an unmatched path OR method is a 403 "Missing Authentication Token", not a
//   404 — API Gateway cannot tell a missing resource from an unsigned call;
// - an authorizer that fails or returns garbage is a 500 whose body is the
//   literal `{"message":null}` (AuthorizerConfigurationException);
// - the two policy denials use a capital-M `Message` key.
// HTTP APIs answer with plain, lowercase-key messages.
function gatewayDefault(type: GatewayResponseType, flavor: ApiFlavor, explicitDeny: boolean): GatewayResponseDefault {
  if (flavor === 'http') {
    switch (type) {
      case 'MISSING_AUTHENTICATION_TOKEN': return { status: 404, body: { message: 'Not Found' } };
      case 'UNAUTHORIZED': return { status: 401, body: { message: 'Unauthorized' } };
      case 'ACCESS_DENIED':
      case 'INVALID_API_KEY': return { status: 403, body: { message: 'Forbidden' } };
      default: return { status: 500, body: { message: 'Internal Server Error' } };
    }
  }
  switch (type) {
    case 'MISSING_AUTHENTICATION_TOKEN':
      return { status: 403, body: { message: 'Missing Authentication Token' }, errorType: 'MissingAuthenticationTokenException' };
    case 'UNAUTHORIZED':
      return { status: 401, body: { message: 'Unauthorized' }, errorType: 'UnauthorizedException' };
    case 'ACCESS_DENIED':
      return {
        status: 403,
        body: {
          Message: explicitDeny
            ? 'User is not authorized to access this resource with an explicit deny'
            : 'User is not authorized to access this resource',
        },
        errorType: 'AccessDeniedException',
      };
    case 'AUTHORIZER_CONFIGURATION_ERROR':
      return { status: 500, body: { message: null }, errorType: 'AuthorizerConfigurationException' };
    case 'INVALID_API_KEY':
      // Missing, unknown or disabled key, or a key in no usage plan that
      // covers the stage — AWS answers all four identically.
      return { status: 403, body: { message: 'Forbidden' }, errorType: 'ForbiddenException' };
    case 'INTEGRATION_FAILURE':
      // A Lambda proxy integration that crashed or answered a malformed shape.
      return { status: 502, body: { message: 'Internal server error' }, errorType: 'InternalServerErrorException' };
    default:
      return { status: 500, body: { message: 'Internal server error' }, errorType: 'InternalServerErrorException' };
  }
}

export function gatewayErrorResponse(
  type: GatewayResponseType,
  flavor: ApiFlavor,
  options: { explicitDeny?: boolean } = {},
): MappedResponse {
  const def = gatewayDefault(type, flavor, options.explicitDeny === true);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (def.errorType) headers['x-amzn-errortype'] = def.errorType;
  return {
    statusCode: def.status,
    headers,
    cookies: [],
    body: Buffer.from(JSON.stringify(def.body), 'utf-8'),
  };
}

// The response header carrying the gateway's request id: REST APIs send
// x-amzn-RequestId, HTTP APIs apigw-requestid. Same value as the event's
// requestContext.requestId.
export function requestIdHeader(flavor: ApiFlavor, requestId: string): Record<string, string> {
  return flavor === 'rest' ? { 'x-amzn-requestid': requestId } : { 'apigw-requestid': requestId };
}

// Whether an OPTIONS request is a preflight the gateway answers by itself.
// API Gateway only does that when CORS is configured: an HTTP API's CORS is
// API-wide (and, once configured, answers preflights even over an ANY or
// OPTIONS route), a REST API's is per resource (the framework's `cors: true`
// mock OPTIONS method). Without it, OPTIONS is an ordinary method — it reaches
// an OPTIONS/ANY route's handler or is a missing route.
export function answersPreflight(routes: HttpRoute[], rawPath: string): boolean {
  if (routes.some(r => r.eventType === 'httpApi' && r.cors)) return true;
  return routes.some(r =>
    r.eventType === 'http' && r.cors && matchRoute([{ ...r, method: 'ANY' }], 'OPTIONS', rawPath) !== null);
}

// ---------------------------------------------------------------------------
// API keys (REST APIs)
// ---------------------------------------------------------------------------

// An API key as the engine's API Gateway control plane resolves it from its
// value: the key and every usage plan it is attached to. Declared here
// structurally so the gateway does not import the engine.
export interface ResolvedApiKey {
  id: string;
  name: string;
  enabled: boolean;
  usagePlans: Array<{ id: string; name: string; apiStages: Array<{ apiId: string; stage: string }> }>;
}

// Looks a key up by its value in the engine, per region. Undefined = no such key.
export type ApiKeyLookup = (region: string, value: string) => Promise<ResolvedApiKey | undefined>;

export interface ApiKeyCheckOptions {
  route: Pick<HttpRoute, 'apiKeySourceType'>;
  request: Pick<IncomingRequest, 'headers'>;
  stage: string;
  region: string;
  // The authorizer's output, when the route ran one (AUTHORIZER source).
  authorizer?: AuthorizerOutput;
  lookup: ApiKeyLookup;
}

export type ApiKeyCheckResult =
  | { ok: true; identity: ApiKeyIdentity }
  | { ok: false; reason: 'missing' | 'unknown' | 'disabled' | 'no-usage-plan' };

/**
 * The API key check of a REST method with ApiKeyRequired, run AFTER the
 * authorizer and its policy evaluation, as API Gateway orders it — and on
 * every request: only the authorizer's answer (with its usageIdentifierKey)
 * is cached, the key lookup is live, so a key disabled a moment ago is
 * refused on the very next call even with a warm authorizer cache.
 *
 * The key value comes from the authorizer's `usageIdentifierKey` (AUTHORIZER
 * source) or the `x-api-key` header (HEADER source, case-insensitive like
 * every header). It passes when the key exists, is enabled, and sits in a
 * usage plan with an apiStage naming exactly this API and stage — apiId
 * equal to LOCAL_API_ID (the id in the methodArn) AND stage equal to the
 * route's stage, as AWS matches them. A plan with no apiStages covers
 * nothing. Usage plan throttle and quota limits are not enforced.
 */
export async function checkApiKey(options: ApiKeyCheckOptions): Promise<ApiKeyCheckResult> {
  const value = options.route.apiKeySourceType === 'AUTHORIZER'
    ? options.authorizer?.usageIdentifierKey
    : headerValue(options.request.headers, 'x-api-key');
  if (!value) return { ok: false, reason: 'missing' };
  const key = await options.lookup(options.region, value);
  if (!key) return { ok: false, reason: 'unknown' };
  if (!key.enabled) return { ok: false, reason: 'disabled' };
  const covered = key.usagePlans.some(plan => plan.apiStages.some(s => s.apiId === LOCAL_API_ID && s.stage === options.stage));
  if (!covered) return { ok: false, reason: 'no-usage-plan' };
  return { ok: true, identity: { apiKey: value, apiKeyId: key.id } };
}

function malformed(): MappedResponse {
  return errorResponse(502, 'Internal server error');
}

function collectHeaders(response: HandlerHttpResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.multiValueHeaders || {})) {
    headers[key.toLowerCase()] = value.map(String).join(',');
  }
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (value === undefined || value === null) continue;
    headers[key.toLowerCase()] = String(value);
  }
  return headers;
}

function decodeHandlerBody(response: HandlerHttpResponse): Buffer {
  if (response.body === undefined || response.body === null) return Buffer.alloc(0);
  const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  return response.isBase64Encoded === true ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf-8');
}
