// Pure helpers for the gateway proxy: route matching, API Gateway event
// construction (REST v1.0 and HTTP API v2.0 payloads) and Lambda-result →
// HTTP-response mapping. No I/O here so every AWS-semantics edge case is
// unit-testable against real captured payloads.

import crypto from 'crypto';
import type { HttpRoute } from './serverless-state-parser.js';

export interface IncomingRequest {
  method: string;
  // Path only, no query string.
  path: string;
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
      params[greedy[1]] = rest.join('/');
      return { score: score + 1, params };
    }

    const reqSeg = requestSegments[i];
    if (reqSeg === undefined) return null;

    const param = /^\{(.+)\}$/.exec(routeSeg);
    if (param) {
      params[param[1]] = decodeURIComponent(reqSeg);
      score += 10;
    } else if (routeSeg === reqSeg) {
      score += 100;
    } else {
      return null;
    }
  }

  if (requestSegments.length !== routeSegments.length) return null;
  return { score, params };
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

export interface AuthorizerOutput {
  principalId?: string;
  context?: Record<string, unknown>;
}

export interface EventOptions {
  request: IncomingRequest;
  route: HttpRoute;
  pathParameters: Record<string, string> | null;
  stage: string;
  authorizer?: AuthorizerOutput;
  requestId?: string;
}

// REST API (Lambda proxy integration, payload format 1.0).
export function buildV1Event(options: EventOptions): Record<string, unknown> {
  const { request, route, pathParameters, stage, authorizer } = options;
  const requestId = options.requestId || crypto.randomUUID();
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
      accountId: '000000000000',
      apiId: 'lss-local',
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
        apiKey: null,
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
  const { single } = parseQuery(request.rawQueryString);
  const { body, isBase64Encoded } = encodeBody(request.body, headerValue(request.headers, 'content-type'));

  const headers = singleValueHeaders(request.headers);
  const cookies = multiValueHeaders(request.headers)['cookie']?.flatMap(c => c.split(/;\s*/)) ?? undefined;
  delete headers['cookie'];

  const routeKey = route.path === '$default' ? '$default' : `${route.method} ${route.path}`;

  return {
    version: '2.0',
    routeKey,
    rawPath: request.path,
    rawQueryString: request.rawQueryString,
    ...(cookies && cookies.length ? { cookies } : {}),
    headers,
    queryStringParameters: single ?? undefined,
    pathParameters: pathParameters ?? undefined,
    stageVariables: undefined,
    requestContext: {
      accountId: '000000000000',
      apiId: 'lss-local',
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
