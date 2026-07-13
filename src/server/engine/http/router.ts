// Engine front door: one listener that resolves {service, region, operation}
// for every AWS SDK request and dispatches to the registered emulators, with
// protocol-correct success/error framing and an optional verbatim fallback
// proxy for anything the engine does not implement. See
// docs/PRD_SELF_ENGINE.md §RF2 for the routing contract.

import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';
import type {
  AnyEmulator,
  AwsRequest,
  AwsResponse,
  EngineContext,
  EngineServiceName,
  QueryEmulator,
  RestEmulator,
} from '../types.js';
import { AwsError, notImplemented } from './errors.js';
import { resolveSigV4Scope } from './sigv4.js';
import { decodeAwsChunkedBody, isAwsChunkedBody } from './aws-chunked.js';
import {
  jsonErrorResponse,
  jsonSuccessResponse,
  lambdaErrorResponse,
  type JsonVersion,
} from './protocols/aws-json.js';
import {
  parseFormBody,
  queryErrorResponse,
  queryXmlSuccessResponse,
  s3ErrorResponse,
} from './protocols/query-xml.js';

export interface EngineRouterDeps {
  ctx: EngineContext;
  emulators: AnyEmulator[];
}

const TARGET_PREFIXES: Record<string, EngineServiceName> = {
  DynamoDB_20120810: 'dynamodb',
  AmazonSQS: 'sqs',
  AWSEvents: 'events',
  OpenSearchServerless: 'aoss',
  secretsmanager: 'secretsmanager',
};

const LEGACY_SQS_MESSAGE =
  'Your SDK predates the SQS JSON protocol. The LSS self engine serves SQS over ' +
  'AWS JSON 1.0 (aws-sdk v3 / recent boto3); set selfEngine.fallbackEndpoint to ' +
  'route legacy SDKs to a LocalStack instance.';

const LOCALSTACK_HEALTH = {
  services: {
    dynamodb: 'available',
    sqs: 'available',
    sns: 'available',
    s3: 'available',
    lambda: 'available',
    events: 'available',
    sts: 'available',
    secretsmanager: 'available',
    aoss: 'available',
  },
  edition: 'self',
  version: 'lss-self-engine',
};

// How an error must be serialized — decided by the resolved service, or
// guessed from request features while resolution is still in flight.
type ErrorShape =
  | { kind: 'json'; service: EngineServiceName | undefined; version: JsonVersion }
  | { kind: 'query' }
  | { kind: 's3' }
  | { kind: 'lambda' };

export function createEngineRequestHandler(
  deps: EngineRouterDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const byService = new Map<EngineServiceName, AnyEmulator>();
  for (const emulator of deps.emulators) byService.set(emulator.service, emulator);
  return (req, res) => {
    handleRequest(deps, byService, req, res).catch(err => {
      // The inner handler serializes every failure; this only guards against
      // bugs in the serialization path itself.
      console.error('[engine] request handler crashed:', err instanceof Error ? err.stack : err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else {
        res.destroy();
      }
    });
  };
}

async function handleRequest(
  deps: EngineRouterDeps,
  byService: Map<EngineServiceName, AnyEmulator>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const requestId = randomUUID();
  const method = (req.method ?? 'GET').toUpperCase();
  const urlValue = req.url ?? '/';
  const queryIndex = urlValue.indexOf('?');
  // Raw (still-encoded) path: S3 keys must keep encoded slashes intact.
  let rawPath = queryIndex === -1 ? urlValue : urlValue.slice(0, queryIndex);
  const query: Record<string, string> = {};
  if (queryIndex !== -1) {
    for (const [key, value] of new URLSearchParams(urlValue.slice(queryIndex + 1))) query[key] = value;
  }

  if (method === 'GET' && rawPath === '/_lss/health') {
    finish(res, requestId, false, jsonBody(200, { status: 'ok', engine: 'self' }));
    return;
  }
  if (method === 'GET' && rawPath === '/_localstack/health') {
    finish(res, requestId, false, jsonBody(200, LOCALSTACK_HEALTH));
    return;
  }

  const headers = collectHeaders(req);
  // Kept as first received for the fallback proxy, which must forward the
  // original bytes (including aws-chunked framing) verbatim.
  const rawBody = await readBody(req);

  let shape: ErrorShape = guessShape(headers, undefined);
  let serviceLabel = 'unknown';
  let operationLabel = `${method} ${rawPath}`;

  try {
    let body = rawBody;
    if (isAwsChunkedBody(headers)) {
      body = decodeAwsChunkedBody(rawBody);
      stripAwsChunkedHeaders(headers, body.length);
    }

    // ---- service resolution, in precedence order (RF2.1) ----
    const scope = resolveSigV4Scope(headers, query);
    const region = scope?.region ?? deps.ctx.config.region;
    const target = headers['x-amz-target'];
    const contentType = headers['content-type'] ?? '';
    let service: string | undefined = scope?.service;
    let formParams: Record<string, string> | undefined;
    if (
      contentType.includes('x-www-form-urlencoded') &&
      (!service || service === 'sns' || service === 'sts' || service === 'sqs')
    ) {
      formParams = parseFormBody(body);
    }
    const formAction = formParams?.Action;

    let legacySqs = false;
    if (!service) {
      if (target) {
        service = TARGET_PREFIXES[target.split('.')[0]];
        if (!service) {
          shape = { kind: 'json', service: undefined, version: '1.0' };
          operationLabel = target;
          await respondUnknown(deps, req, res, rawBody, requestId, method, shape, serviceLabel, operationLabel);
          return;
        }
      } else if (formAction) {
        // Legacy SQS Query SDKs post data-plane calls to the QueueUrl path
        // (/<account>/<queue>); everything Query-shaped at the root is SNS,
        // except the STS bootstrap call.
        if (rawPath !== '/') legacySqs = true;
        else service = formAction === 'GetCallerIdentity' ? 'sts' : 'sns';
      } else if (rawPath.startsWith('/2015-03-31/')) {
        service = 'lambda';
      } else if (rawPath === '/_aoss' || rawPath.startsWith('/_aoss/')) {
        // Unsigned OpenSearch data-plane calls (curl against a collection
        // endpoint) carry no scope — the /_aoss prefix is the marker.
        service = 'aoss';
      } else {
        service = 's3';
      }
    }
    // A SigV4-scoped SQS request without X-Amz-Target that carries a Query
    // form body is a legacy SDK too, whatever path it posted to.
    if (service === 'sqs' && !target && formAction) legacySqs = true;

    if (legacySqs) {
      shape = { kind: 'query' };
      serviceLabel = 'sqs';
      if (deps.ctx.config.fallbackEndpoint) {
        await proxyToFallback(deps.ctx.config.fallbackEndpoint, req, rawBody, res, shape, requestId, method);
        return;
      }
      throw new AwsError('InvalidAction', LEGACY_SQS_MESSAGE, { status: 400 });
    }

    if (service === 's3') rawPath = peelVirtualHostBucket(rawPath, headers['host']);

    serviceLabel = service ?? 'unknown';
    shape = shapeForService(service, byService) ?? guessShape(headers, formAction);

    const emulator = byService.get(service as EngineServiceName);
    if (!emulator) {
      await respondUnknown(deps, req, res, rawBody, requestId, method, shape, serviceLabel, operationLabel);
      return;
    }

    const awsReq: AwsRequest = {
      method,
      rawPath,
      query,
      headers,
      body,
      service: emulator.service,
      region,
      requestId,
    };

    // ---- dispatch by emulator flavor ----
    let response: AwsResponse;
    if ('targetPrefix' in emulator) {
      if (!target) {
        // No JSON operation on a JSON-protocol service: unknown op, and
        // therefore fallback-eligible (caught below).
        throw new AwsError('UnknownOperationException', `Missing X-Amz-Target header for ${emulator.service}`);
      }
      const dot = target.indexOf('.');
      const operation = dot === -1 ? target : target.slice(dot + 1);
      operationLabel = operation;
      let input: Record<string, unknown> = {};
      if (body.length > 0) {
        try {
          input = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          throw new AwsError('SerializationException', 'Could not parse the request body as JSON');
        }
      }
      response = jsonSuccessResponse(await emulator.handle(operation, input, awsReq), emulator.jsonVersion);
    } else if (emulator.service === 'sns' || emulator.service === 'sts') {
      // QueryEmulator vs RestEmulator is not structurally narrowable; SNS and
      // STS are the engine's Query-protocol services by contract.
      const queryEmulator = emulator as QueryEmulator;
      const action = formAction ?? query['Action'];
      if (!action) throw new AwsError('MissingAction', 'The request must contain the parameter Action.');
      operationLabel = action;
      response = queryXmlSuccessResponse(await queryEmulator.handle(action, formParams ?? query, awsReq));
    } else {
      const restEmulator = emulator as RestEmulator;
      response = await restEmulator.handle(awsReq);
    }
    finish(res, requestId, emulator.service === 's3', response);
  } catch (err) {
    const awsErr = err instanceof AwsError ? err : internalError(err);
    if (awsErr.code === 'UnknownOperationException') {
      await respondUnknown(deps, req, res, rawBody, requestId, method, shape, serviceLabel, operationLabel);
      return;
    }
    finish(res, requestId, shape.kind === 's3', serializeError(awsErr, shape, requestId, method));
  }
}

// ---------------------------------------------------------------------------
// Unknown service/operation: verbatim fallback proxy or explicit 400 — the
// engine never silently succeeds (RF2.2).
// ---------------------------------------------------------------------------

async function respondUnknown(
  deps: EngineRouterDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: Buffer,
  requestId: string,
  method: string,
  shape: ErrorShape,
  serviceLabel: string,
  operationLabel: string,
): Promise<void> {
  const fallback = deps.ctx.config.fallbackEndpoint;
  if (fallback) {
    await proxyToFallback(fallback, req, rawBody, res, shape, requestId, method);
    return;
  }
  const err = notImplemented(serviceLabel, operationLabel);
  finish(res, requestId, shape.kind === 's3', serializeError(err, shape, requestId, method));
}

function proxyToFallback(
  endpoint: string,
  req: http.IncomingMessage,
  rawBody: Buffer,
  res: http.ServerResponse,
  shape: ErrorShape,
  requestId: string,
  method: string,
): Promise<void> {
  return new Promise(resolve => {
    const url = new URL(endpoint);
    const transport = url.protocol === 'https:' ? https : http;
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers['host'];
    // The body was fully buffered (any HTTP chunking already undone), so the
    // proxied request carries an explicit length.
    delete headers['transfer-encoding'];
    headers['content-length'] = String(rawBody.length);
    const proxyReq = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: req.url,
        method: req.method,
        headers,
      },
      proxyRes => {
        const responseHeaders = { ...proxyRes.headers };
        // Node re-frames the piped body itself.
        delete responseHeaders['transfer-encoding'];
        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res);
        proxyRes.on('end', () => resolve());
        proxyRes.on('error', () => {
          res.destroy();
          resolve();
        });
      },
    );
    proxyReq.on('error', err => {
      if (res.headersSent) {
        res.destroy();
      } else {
        const unreachable = new AwsError(
          'ServiceUnavailable',
          `selfEngine.fallbackEndpoint (${endpoint}) is unreachable: ${err.message}`,
          { status: 502, fault: 'Receiver' },
        );
        finish(res, requestId, shape.kind === 's3', serializeError(unreachable, shape, requestId, method));
      }
      resolve();
    });
    proxyReq.end(rawBody);
  });
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

function shapeForService(
  service: string | undefined,
  byService: Map<EngineServiceName, AnyEmulator>,
): ErrorShape | undefined {
  switch (service) {
    case 'dynamodb':
    case 'sqs':
    case 'events': {
      const emulator = byService.get(service);
      const version: JsonVersion =
        emulator && 'jsonVersion' in emulator ? emulator.jsonVersion : service === 'events' ? '1.1' : '1.0';
      return { kind: 'json', service, version };
    }
    case 'secretsmanager':
      return { kind: 'json', service, version: '1.1' };
    case 'aoss':
      // Control-plane failures; the emulator serializes data-plane errors in
      // the OpenSearch JSON shape itself, without throwing.
      return { kind: 'json', service, version: '1.0' };
    case 'sns':
    case 'sts':
      return { kind: 'query' };
    case 'lambda':
      return { kind: 'lambda' };
    case 's3':
      return { kind: 's3' };
    default:
      return undefined;
  }
}

function guessShape(headers: Record<string, string>, formAction: string | undefined): ErrorShape {
  if (headers['x-amz-target'] || (headers['content-type'] ?? '').includes('json')) {
    return { kind: 'json', service: undefined, version: '1.0' };
  }
  if (formAction) return { kind: 'query' };
  return { kind: 's3' };
}

function serializeError(err: AwsError, shape: ErrorShape, requestId: string, method: string): AwsResponse {
  switch (shape.kind) {
    case 'json':
      return jsonErrorResponse(err, shape.service, shape.version);
    case 'query':
      return queryErrorResponse(err, requestId);
    case 'lambda':
      return lambdaErrorResponse(err);
    case 's3':
      return s3ErrorResponse(err, requestId, method);
  }
}

function internalError(err: unknown): AwsError {
  console.error('[engine] unexpected error:', err instanceof Error ? err.stack : err);
  return new AwsError('InternalFailure', 'The LSS self engine encountered an internal error', {
    status: 500,
    fault: 'Receiver',
  });
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function collectHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stripAwsChunkedHeaders(headers: Record<string, string>, decodedLength: number): void {
  const encoding = headers['content-encoding'];
  if (encoding) {
    const remaining = encoding
      .split(',')
      .map(token => token.trim())
      .filter(token => token && token !== 'aws-chunked');
    if (remaining.length > 0) headers['content-encoding'] = remaining.join(', ');
    else delete headers['content-encoding'];
  }
  delete headers['x-amz-trailer'];
  delete headers['x-amz-decoded-content-length'];
  headers['content-length'] = String(decodedLength);
}

// Virtual-host-style S3 (bucket in the Host header) → path-style. Kept
// conservative: never peel plain localhost, loopback or IP hosts, so
// path-style requests (every LSS client sets forcePathStyle) are untouched.
function peelVirtualHostBucket(rawPath: string, host: string | undefined): string {
  if (!host || host.startsWith('[')) return rawPath;
  const hostname = host.split(':')[0];
  const dot = hostname.indexOf('.');
  if (dot <= 0) return rawPath;
  if (hostname.startsWith('localhost') || hostname.startsWith('127.')) return rawPath;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return rawPath;
  const bucket = hostname.slice(0, dot);
  return `/${bucket}${rawPath === '/' ? '' : rawPath}`;
}

function jsonBody(status: number, payload: unknown): AwsResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

function finish(res: http.ServerResponse, requestId: string, s3Ids: boolean, response: AwsResponse): void {
  const body =
    response.body === undefined
      ? Buffer.alloc(0)
      : typeof response.body === 'string'
        ? Buffer.from(response.body, 'utf8')
        : response.body;
  for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value);
  if (!res.hasHeader('date')) res.setHeader('Date', new Date().toUTCString());
  if (s3Ids) {
    if (!res.hasHeader('x-amz-request-id')) res.setHeader('x-amz-request-id', requestId);
    if (!res.hasHeader('x-amz-id-2')) res.setHeader('x-amz-id-2', Buffer.from(requestId).toString('base64'));
  } else if (!res.hasHeader('x-amzn-requestid')) {
    res.setHeader('x-amzn-RequestId', requestId);
  }
  if (!res.hasHeader('content-length') && response.status !== 204 && response.status !== 304) {
    res.setHeader('Content-Length', body.length);
  }
  res.statusCode = response.status;
  res.end(body.length > 0 ? body : undefined);
}
