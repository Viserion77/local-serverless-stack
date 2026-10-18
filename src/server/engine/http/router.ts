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
import { isLoopbackAddress, RESET_CONFIRM_HEADER, RESET_PATH } from './reset.js';
import { resolveSigV4Scope } from './sigv4.js';
import { decodeAwsChunkedBody, isAwsChunkedBody } from './aws-chunked.js';
import {
  jsonErrorResponse,
  jsonSuccessResponse,
  lambdaErrorResponse,
  restJsonErrorResponse,
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
  // Wipes every emulator's state (POST /_lss/reset). Absent → the route
  // answers 404, which is what a bare router in a unit test should do.
  onReset?: () => Promise<void>;
}

// Prefixes that do not belong to a TargetEmulator (OpenSearch Serverless is a
// RestEmulator whose control plane still speaks JSON 1.0 by target). Every
// TargetEmulator's own `targetPrefix` is merged in at handler creation, so a
// new JSON-protocol emulator routes unsigned calls without touching this map.
const TARGET_PREFIXES: Record<string, EngineServiceName> = {
  DynamoDB_20120810: 'dynamodb',
  AmazonSQS: 'sqs',
  AWSEvents: 'events',
  OpenSearchServerless: 'aoss',
  secretsmanager: 'secretsmanager',
  AmazonSSM: 'ssm',
};

const LEGACY_SQS_MESSAGE =
  'Your SDK predates the SQS JSON protocol. The LSS self engine serves SQS over ' +
  'AWS JSON 1.0 (aws-sdk v3 / recent boto3); set selfEngine.fallbackEndpoints.sqs (or selfEngine.fallbackEndpoint) to ' +
  'route legacy SDKs to an endpoint that still speaks Query.';

// Compatibility alias, not a dependency: plenty of third-party tooling (wait-for
// scripts, IDE plugins, docker-compose healthchecks) probes GET
// /_localstack/health to decide whether a local AWS is up. Answering it in the
// shape they expect — with `edition: "self"`, so nothing pretends otherwise —
// lets that tooling keep working unchanged. `/_lss/health` above is the native
// endpoint.
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
    ssm: 'available',
    aoss: 'available',
  },
  edition: 'self',
  version: 'lss-self-engine',
};

// How an error must be serialized — decided by the resolved service, or
// guessed from request features while resolution is still in flight.
type ErrorShape =
  | { kind: 'json'; service: EngineServiceName | undefined; version: JsonVersion }
  | { kind: 'restJson' }
  | { kind: 'query' }
  | { kind: 's3' }
  | { kind: 'lambda' };

// Signing names of the rest-xml services, the only unknown services whose SDK
// parses an XML error. Every other unknown service with no X-Amz-Target and no
// Action= is rest-json (API Gateway, AppSync, Kinesis Video, IoT…), and an
// XML body there surfaces as a bare `SyntaxError` in the SDK instead of the
// error code.
const REST_XML_SERVICES = new Set(['s3', 's3control', 'route53', 'cloudfront']);

// Query-protocol operation names are PascalCase identifiers. Checked before an
// unsigned `?Action=` is trusted as an operation name.
const QUERY_ACTION = /^[A-Z][A-Za-z0-9]*$/;

export function createEngineRequestHandler(
  deps: EngineRouterDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const byService = new Map<EngineServiceName, AnyEmulator>();
  const byTarget: Record<string, EngineServiceName> = { ...TARGET_PREFIXES };
  for (const emulator of deps.emulators) {
    byService.set(emulator.service, emulator);
    if ('targetPrefix' in emulator) byTarget[emulator.targetPrefix] = emulator.service;
  }
  return (req, res) => {
    handleRequest(deps, byService, byTarget, req, res).catch(err => {
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
  byTarget: Record<string, EngineServiceName>,
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
  if (rawPath === RESET_PATH) {
    await handleReset(deps, req, res, requestId, method);
    return;
  }

  const headers = collectHeaders(req);
  // Kept as first received for the fallback proxy, which must forward the
  // original bytes (including aws-chunked framing) verbatim.
  const rawBody = await readBody(req);

  let shape: ErrorShape = guessShape(headers, undefined, undefined);
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
      // A scoped service the engine does not emulate (IAM, CloudFormation…)
      // is parsed too, so its NotImplemented names the Action and answers
      // in Query XML. Never for S3, where a form-typed body is object data.
      (!service || service === 'sns' || service === 'sts' || service === 'sqs' ||
        (service !== 's3' && !byService.has(service as EngineServiceName)))
    ) {
      formParams = parseFormBody(body);
    }
    const formAction = formParams?.Action;
    // `GET /?Action=ListTopics&Version=…` is a valid Query-protocol call too
    // (the parameters may travel in the query string instead of a form body).
    const queryAction =
      formAction ?? (query['Action'] && QUERY_ACTION.test(query['Action']) ? query['Action'] : undefined);

    let legacySqs = false;
    if (!service) {
      if (target) {
        const prefix = target.split('.')[0];
        service = byTarget[prefix];
        if (!service) {
          // No signature, so no signing name: the target prefix is the most
          // precise service name the wire offers ("Kinesis_20131202",
          // "AWSCognitoIdentityProviderService"). Only the default fallback
          // applies.
          shape = guessShape(headers, undefined, undefined);
          serviceLabel = prefix;
          operationLabel = targetOperation(target);
          await respondUnknown(deps, req, res, rawBody, requestId, method, shape, serviceLabel, operationLabel);
          return;
        }
      } else if (formAction || (queryAction && rawPath === '/')) {
        // Legacy SQS Query SDKs post data-plane calls to the QueueUrl path
        // (/<account>/<queue>); everything Query-shaped at the root is SNS,
        // except the STS bootstrap call. A query-string Action only counts at
        // the root: off it, an unsigned GET is far likelier an S3 object URL.
        if (rawPath !== '/') legacySqs = true;
        else service = queryAction === 'GetCallerIdentity' ? 'sts' : 'sns';
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
      const fallback = fallbackFor(deps, 'sqs');
      if (fallback) {
        await proxyToFallback(fallback, req, rawBody, res, shape, requestId, method);
        return;
      }
      throw new AwsError('InvalidAction', LEGACY_SQS_MESSAGE, { status: 400 });
    }

    if (service === 's3') rawPath = peelVirtualHostBucket(rawPath, headers['host']);

    // Always set by now: every unscoped branch above assigns or returns.
    serviceLabel = service as string;
    shape = shapeForService(service, byService) ?? guessShape(headers, queryAction, service);

    const emulator = byService.get(service as EngineServiceName);
    if (!emulator) {
      // Name the operation the way the SDK user knows it, not `POST /`.
      if (target) operationLabel = targetOperation(target);
      else if (queryAction) operationLabel = queryAction;
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
      const operation = targetOperation(target);
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
  const fallback = fallbackFor(deps, serviceLabel);
  if (fallback) {
    await proxyToFallback(fallback, req, rawBody, res, shape, requestId, method);
    return;
  }
  const err = notImplemented(serviceLabel, operationLabel);
  finish(res, requestId, shape.kind === 's3', serializeError(err, shape, requestId, method));
}

// Per-service fallback first (`selfEngine.fallbackEndpoints.<signing name>`),
// then the catch-all `selfEngine.fallbackEndpoint`. One emulator per service
// is the norm — a Kinesis-only container next to an IAM-only one — so a
// single URL for everything was the wrong granularity.
function fallbackFor(deps: EngineRouterDeps, service: string): string | null {
  const { fallbackEndpoints, fallbackEndpoint } = deps.ctx.config;
  return fallbackEndpoints?.[service] || fallbackEndpoint || null;
}

function targetOperation(target: string): string {
  const dot = target.indexOf('.');
  return dot === -1 ? target : target.slice(dot + 1);
}

// POST /_lss/reset — wipe every emulator's state in place. Destructive and
// unauthenticated by nature (the engine never verifies SigV4), so it is fenced
// twice: the socket must be loopback (a stack bound to 0.0.0.0 still refuses
// the LAN), and the request must carry a custom header. The header is what
// stops a web page in the developer's own browser — which IS loopback — from
// firing it cross-site: a custom header forces a CORS preflight, and this
// route never answers one.
async function handleReset(
  deps: EngineRouterDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  method: string,
): Promise<void> {
  // Drain the body first; nothing in it is read.
  await readBody(req);
  const fail = (status: number, code: string, message: string): void =>
    finish(res, requestId, false, jsonBody(status, { __type: code, message }));
  if (!deps.onReset) {
    fail(404, 'NotFound', 'This engine does not expose a reset endpoint');
    return;
  }
  if (method !== 'POST') {
    fail(405, 'MethodNotAllowed', `${RESET_PATH} accepts POST only`);
    return;
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    fail(403, 'AccessDeniedException', `${RESET_PATH} is only accepted from the local machine`);
    return;
  }
  if (req.headers[RESET_CONFIRM_HEADER] !== 'true') {
    fail(400, 'MissingConfirmation', `${RESET_PATH} requires the header "${RESET_CONFIRM_HEADER}: true"`);
    return;
  }
  try {
    await deps.onReset();
  } catch (err) {
    console.error('[engine] reset failed:', err instanceof Error ? err.stack : err);
    fail(500, 'InternalFailure', `Engine reset failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  finish(res, requestId, false, jsonBody(200, { status: 'reset', engine: 'self', persistence: deps.ctx.config.persistence }));
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
        const responseHeaders = upstreamResponseHeaders(proxyRes.rawHeaders);
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

// Headers that may appear only once in a response. Some emulators behind a
// fallback (and some frameworks they are built on) emit `Date` twice; Node
// joins repeated headers into "a, b", and the AWS SDK's clock-skew correction
// reads that as an unparseable server time — every call after the first then
// fails with a signature/skew error. The first value wins, as a browser would.
const SINGLE_VALUED_RESPONSE_HEADERS = new Set([
  'age',
  'content-encoding',
  'content-length',
  'content-md5',
  'content-range',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'location',
  'retry-after',
  'server',
  'x-amz-id-2',
  'x-amz-request-id',
  'x-amzn-errortype',
  'x-amzn-requestid',
]);

// Rebuild the upstream response headers from rawHeaders rather than trusting
// IncomingMessage.headers, which has already merged duplicates. Single-valued
// headers keep their first value; any other repeated header drops exact
// duplicates and keeps distinct values as an array (set-cookie and friends).
function upstreamResponseHeaders(rawHeaders: string[]): http.OutgoingHttpHeaders {
  const values = new Map<string, { name: string; values: string[] }>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const key = name.toLowerCase();
    // Node re-frames the piped body itself.
    if (key === 'transfer-encoding') continue;
    const entry = values.get(key);
    if (!entry) values.set(key, { name, values: [rawHeaders[i + 1]] });
    else if (!SINGLE_VALUED_RESPONSE_HEADERS.has(key) && !entry.values.includes(rawHeaders[i + 1])) {
      entry.values.push(rawHeaders[i + 1]);
    }
  }
  const out: http.OutgoingHttpHeaders = {};
  for (const { name, values: list } of values.values()) out[name] = list.length === 1 ? list[0] : list;
  return out;
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

function shapeForService(
  service: string | undefined,
  byService: Map<EngineServiceName, AnyEmulator>,
): ErrorShape | undefined {
  // Any JSON-protocol emulator declares its own version, so a registered one
  // gets correct error framing even without a case below.
  const emulator = byService.get(service as EngineServiceName);
  if (emulator && 'jsonVersion' in emulator) {
    return { kind: 'json', service: emulator.service, version: emulator.jsonVersion };
  }
  switch (service) {
    case 'secretsmanager':
    case 'ssm':
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

// Error framing for a service the engine does not emulate (or before one is
// resolved), read off the request in the order the protocols are
// distinguishable: X-Amz-Target → AWS JSON; Action= → Query XML; a rest-xml
// signing name, or no signing name at all (the unscoped S3 default) → S3 XML;
// any other signing name → rest-json.
function guessShape(
  headers: Record<string, string>,
  action: string | undefined,
  service: string | undefined,
): ErrorShape {
  const contentType = headers['content-type'] ?? '';
  if (headers['x-amz-target']) {
    return { kind: 'json', service: undefined, version: contentType.includes('1.1') ? '1.1' : '1.0' };
  }
  if (action) return { kind: 'query' };
  if (service && !REST_XML_SERVICES.has(service)) return { kind: 'restJson' };
  if (contentType.includes('json')) return { kind: 'json', service: undefined, version: '1.0' };
  return { kind: 's3' };
}

function serializeError(err: AwsError, shape: ErrorShape, requestId: string, method: string): AwsResponse {
  switch (shape.kind) {
    case 'json':
      return jsonErrorResponse(err, shape.service, shape.version);
    case 'restJson':
      return restJsonErrorResponse(err);
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
