// The front door of Lambda Web Functions: one HTTP listener per endpoint, on
// its stable local port (web-function-ports.ts), standing in for the managed
// HTTPS endpoint AWS puts in front of the app.
//
// Per request it does what the documented endpoint does, in order:
//
//   1. stamp a `lambda-web-request-id` (UUID) on the request it forwards and on
//      the response it returns;
//   2. `IamAuth`: require a SigV4 request signed for service `lambda` carrying
//      `X-Amz-Content-SHA256`, else 403 — the signature itself is not verified,
//      which is the engine's credential policy everywhere (engine/http/sigv4.ts);
//      the Authorization header is removed before forwarding, as AWS does;
//   3. pick the revision — `x-lss-web-revision: <revisionId>` pins one (an LSS
//      header, so a canary split is testable), otherwise the endpoint's
//      RevisionWeights decide;
//   4. get a slot in that revision's environment (web-function-manager.ts),
//      starting the process on a cold start;
//   5. PIPE the request to AWS_LAMBDA_HTTP_ENDPOINT and the response back —
//      never buffered, so SSE, chunked uploads and long polls behave as they do
//      against the app directly. `x-forwarded-for/-host/-proto` are added;
//      `-proto` is `https`, because on AWS the app sits behind TLS termination
//      and that is what it sees there (the local listener itself is http);
//   6. bound the request by the revision's TimeoutSeconds: before the response
//      head, 504 with `lambda-web-error-type: Runtime.RequestTimeout`; once a
//      response is streaming, the connection is cut (AWS ends the stream and
//      the client keeps the status it already got, with a truncated body).
//
// Every error LSS generates itself carries a small JSON body naming LSS as its
// source, plus the documented `lambda-web-error-type` header where AWS sends
// one — so nobody mistakes the front door's 502 for the app's.

import http from 'http';
import crypto from 'crypto';
import { getBindHost } from './bind-host.js';
import { resolveSigV4Scope } from '../engine/http/sigv4.js';
import { InvocationActivity } from './invocation-activity.js';
import { pickRevision, type RegisteredWebFunction, type WebAuthType } from './web-function-assembler.js';
import { WebFunctionManager, WebFunctionError, type WebLease } from './web-function-manager.js';

export type WebListenerStatus = 'online' | 'port-conflict' | 'stopped';

export const REQUEST_ID_HEADER = 'lambda-web-request-id';
export const ERROR_TYPE_HEADER = 'lambda-web-error-type';
export const PIN_HEADER = 'x-lss-web-revision';

interface Listener {
  service: string;
  fnName: string;
  endpoint: string;
  port: number;
  server: http.Server;
  status: WebListenerStatus;
  rebindTimer?: NodeJS.Timeout;
}

// Connection-scoped headers a proxy must not forward (RFC 9110 §7.6.1).
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

function listenerKey(service: string, fnName: string, endpoint: string): string {
  return `${service}\u0000${fnName}\u0000${endpoint}`;
}

/**
 * Why an `IamAuth` request is refused, or null when it passes. Mirrors the
 * documented failure modes ("Lambda Web Function endpoint access control" →
 * Signing requests): unsigned, missing the content hash header, or signed for
 * another service. Credentials and the signature are not checked locally.
 */
export function iamAuthFailure(headers: http.IncomingHttpHeaders): string | null {
  const authorization = typeof headers.authorization === 'string' ? headers.authorization : '';
  if (!authorization.startsWith('AWS4-HMAC-SHA256')) {
    return 'the request is not signed with AWS Signature Version 4 (this endpoint has AuthType IamAuth)';
  }
  const scope = resolveSigV4Scope({ authorization }, {});
  if (!scope) return 'the Authorization header carries no valid SigV4 credential scope';
  if (scope.service !== 'lambda') {
    return `the request is signed for service "${scope.service}" — web function endpoints are signed with service "lambda"`;
  }
  if (!headers['x-amz-content-sha256']) {
    return 'the signed request has no X-Amz-Content-SHA256 header (use UNSIGNED-PAYLOAD when not signing the body)';
  }
  return null;
}

/**
 * The headers forwarded to the app: hop-by-hop and LSS's own pin header
 * dropped, AWS credentials stripped the way the endpoint strips them, and the
 * request id plus the x-forwarded-* trio added.
 */
export function forwardedHeaders(
  incoming: http.IncomingHttpHeaders,
  options: { authType: WebAuthType; requestId: string; remoteAddress?: string; port: number },
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...incoming };
  for (const name of [...HOP_BY_HOP, PIN_HEADER]) delete headers[name];
  // IamAuth: Lambda removes the Authorization header once it has validated it.
  // ApplicationManaged: the app's own Authorization (a JWT, a cookie scheme)
  // passes through, but an AWS signature and its session token never reach it.
  const authorization = typeof incoming.authorization === 'string' ? incoming.authorization : '';
  if (options.authType === 'IamAuth') {
    delete headers.authorization;
  } else if (authorization.startsWith('AWS4-')) {
    delete headers.authorization;
    delete headers['x-amz-security-token'];
  }
  const client = options.remoteAddress?.replace(/^::ffff:/, '') ?? '127.0.0.1';
  const previous = incoming['x-forwarded-for'];
  headers['x-forwarded-for'] = previous ? `${previous}, ${client}` : client;
  headers['x-forwarded-host'] = incoming.host ?? `localhost:${options.port}`;
  headers['x-forwarded-proto'] = 'https';
  headers[REQUEST_ID_HEADER] = options.requestId;
  return headers;
}

function responseHeaders(incoming: http.IncomingHttpHeaders, requestId: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...incoming };
  for (const name of HOP_BY_HOP) delete headers[name];
  headers[REQUEST_ID_HEADER] = requestId;
  return headers;
}

/** An answer LSS gives on the app's behalf: JSON body, labelled as LSS's. */
export function sendLssError(
  res: http.ServerResponse,
  status: number,
  errorType: string | undefined,
  message: string,
): void {
  const body = JSON.stringify({
    message,
    ...(errorType ? { errorType } : {}),
    source: 'lss',
    note: 'Generated by Local Serverless Stack (the local Lambda Web Function endpoint), not by your application.',
  });
  const headers: http.OutgoingHttpHeaders = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  };
  if (errorType) headers[ERROR_TYPE_HEADER] = errorType;
  res.writeHead(status, headers);
  res.end(body);
}

export class WebFunctionGateway {
  private static instance: WebFunctionGateway;
  private listeners = new Map<string, Listener>();
  // Delay between rebind attempts after an EADDRINUSE (tests shorten it).
  rebindIntervalMs = 5000;

  constructor(private readonly manager: WebFunctionManager = WebFunctionManager.getInstance()) {}

  static getInstance(): WebFunctionGateway {
    if (!WebFunctionGateway.instance) {
      WebFunctionGateway.instance = new WebFunctionGateway();
    }
    return WebFunctionGateway.instance;
  }

  /**
   * Bind (or keep) one listener per endpoint of the service's web functions.
   * A listener whose port did not change is kept as is — it resolves the
   * function definition per request, so a re-registration never drops a
   * connection it does not have to.
   */
  async syncService(serviceName: string, functions: RegisteredWebFunction[], enabled = true): Promise<void> {
    const wanted = new Map<string, { fnName: string; endpoint: string; port: number }>();
    if (enabled) {
      for (const fn of functions) {
        for (const ep of fn.endpoints) {
          if (ep.port !== undefined) wanted.set(listenerKey(serviceName, fn.name, ep.name), { fnName: fn.name, endpoint: ep.name, port: ep.port });
        }
      }
    }
    for (const [key, listener] of this.listeners) {
      if (listener.service !== serviceName) continue;
      const next = wanted.get(key);
      if (next && next.port === listener.port) {
        wanted.delete(key);
        continue;
      }
      await this.close(key);
    }
    for (const [key, target] of wanted) {
      await this.bind(key, serviceName, target.fnName, target.endpoint, target.port);
    }
  }

  async removeService(serviceName: string): Promise<void> {
    for (const [key, listener] of this.listeners) {
      if (listener.service === serviceName) await this.close(key);
    }
  }

  async stopAll(): Promise<void> {
    for (const key of [...this.listeners.keys()]) await this.close(key);
  }

  getListenerStatus(serviceName: string, fnName: string, endpoint: string): WebListenerStatus {
    return this.listeners.get(listenerKey(serviceName, fnName, endpoint))?.status ?? 'stopped';
  }

  // Same posture as every other listener in the process: the bind host from
  // bind-host.ts, and a port conflict is reported and retried, never fatal.
  private bind(key: string, service: string, fnName: string, endpoint: string, port: number): Promise<void> {
    return new Promise(resolve => {
      const server = http.createServer((req, res) => void this.handle(service, fnName, endpoint, port, req, res));
      const listener: Listener = { service, fnName, endpoint, port, server, status: 'stopped' };
      this.listeners.set(key, listener);
      let warned = false;
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          listener.status = 'port-conflict';
          if (!warned) {
            warned = true;
            console.warn(`⚠️  Web function ${service}/${fnName} endpoint ${endpoint}: port ${port} already in use — retrying every ${this.rebindIntervalMs}ms`);
          }
          listener.rebindTimer = setTimeout(() => {
            listener.rebindTimer = undefined;
            // close() cancels this timer, so a listener that fires is current.
            server.listen(port, getBindHost());
          }, this.rebindIntervalMs);
          listener.rebindTimer.unref();
        } else {
          listener.status = 'stopped';
          console.error(`❌ Web function ${service}/${fnName} endpoint ${endpoint}: ${err.message}`);
        }
        resolve();
      });
      server.on('listening', () => {
        listener.status = 'online';
        console.log(`✅ Web function ${service}/${fnName} endpoint ${endpoint} listening on http://localhost:${port}`);
        resolve();
      });
      server.listen(port, getBindHost());
    });
  }

  private async close(key: string): Promise<void> {
    const listener = this.listeners.get(key) as Listener;
    this.listeners.delete(key);
    if (listener.rebindTimer) clearTimeout(listener.rebindTimer);
    listener.status = 'stopped';
    if (!listener.server.listening) return;
    await new Promise<void>(resolve => {
      listener.server.close(() => resolve());
      // Open keep-alive / streaming connections would hold close() forever.
      listener.server.closeAllConnections();
    });
  }

  private async handle(
    service: string,
    fnName: string,
    endpointName: string,
    port: number,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    // Always set on a server-side request.
    const method = req.method as string;
    const urlPath = req.url as string;
    let revisionId: string | undefined;
    let coldStart = false;
    let errorType: string | undefined;
    let lease: WebLease | undefined;

    res.on('close', () => {
      lease?.release();
      const durationMs = Date.now() - startedAt;
      // A client that hung up before any response head got nothing: recorded
      // as 499 (the de-facto "client closed request" code), not as Node's
      // default 200.
      const status = res.headersSent ? res.statusCode : 499;
      this.manager.recordRequest(service, fnName, {
        at: startedAt,
        method,
        path: urlPath,
        status,
        durationMs,
        revisionId,
        requestId,
        endpoint: endpointName,
        coldStart,
        errorType,
      });
      InvocationActivity.getInstance().record({
        service,
        functionName: fnName,
        startedAt,
        durationMs,
        ok: status < 500,
        coldStart,
      });
    });
    const fail = (status: number, type: string | undefined, message: string, label = type): void => {
      errorType = label;
      sendLssError(res, status, type, message);
    };

    const fn = this.manager.getFunction(service, fnName);
    const endpoint = fn?.endpoints.find(ep => ep.name === endpointName);
    if (!fn || !endpoint) {
      fail(404, 'Platform.InvalidEndpoint', `web function endpoint ${service}/${fnName}/${endpointName} is no longer registered`);
      return;
    }
    if (endpoint.authType === 'IamAuth') {
      const failure = iamAuthFailure(req.headers);
      if (failure) {
        // AWS omits lambda-web-error-type on authorization failures.
        fail(403, undefined, `Forbidden: ${failure}`, 'Forbidden');
        return;
      }
    }
    const pinHeader = req.headers[PIN_HEADER];
    const pin = typeof pinHeader === 'string' && pinHeader ? pinHeader : undefined;
    const revision = pickRevision(fn, endpoint, pin);
    if (!revision) {
      if (pin) {
        fail(400, undefined, `${PIN_HEADER}: "${pin}" is not a revision of ${fnName} (known: ${fn.revisions.map(r => `${r.revisionId} (${r.logicalId})`).join(', ') || 'none'})`, 'LSS.UnknownRevision');
      } else {
        fail(409, 'Platform.RevisionNotActive', `${fnName} has no revision to route to`);
      }
      return;
    }
    revisionId = revision.revisionId;

    try {
      lease = await this.manager.acquire(service, fnName, revision.revisionId);
    } catch (err) {
      const failure = err as WebFunctionError;
      // The client may have hung up while the environment started.
      if (!res.destroyed) fail(failure.status, failure.errorType, failure.message);
      return;
    }
    coldStart = lease.coldStart;
    if (res.destroyed) return;
    this.proxy(req, res, lease, endpoint.authType, requestId, port, type => { errorType = type; });
  }

  private proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    lease: WebLease,
    authType: WebAuthType,
    requestId: string,
    port: number,
    setErrorType: (type: string) => void,
  ): void {
    const upstream = http.request({
      host: lease.host,
      port: lease.port,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req.headers, { authType, requestId, remoteAddress: req.socket.remoteAddress, port }),
      // A fresh connection per request: a pooled socket to a process that was
      // just restarted would fail the next request for no reason of its own.
      agent: false,
    });

    const timeoutSeconds = lease.revision.timeoutSeconds;
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        setErrorType('Runtime.RequestTimeout');
        sendLssError(res, 504, 'Runtime.RequestTimeout', `the application did not respond within TimeoutSeconds (${timeoutSeconds} s)`);
      } else {
        res.destroy();
      }
      upstream.destroy();
    }, timeoutSeconds * 1000);

    upstream.on('response', upstreamRes => {
      res.writeHead(upstreamRes.statusCode as number, responseHeaders(upstreamRes.headers, requestId));
      // Headers out now, not with the first body chunk: an SSE client must see
      // the 200 before the first event.
      res.flushHeaders();
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      // Already answered (the 504 above): leave that answer alone.
      if (res.writableEnded) return;
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      // Refused: the process is gone. Reset mid-request: it failed while
      // handling this one. AWS answers both with 503.
      const type = err.code === 'ECONNREFUSED' ? 'Runtime.Unreachable' : 'Runtime.OriginRequestError';
      setErrorType(type);
      sendLssError(res, 503, type, `the application failed while handling the request (${err.code})`);
    });
    res.on('close', () => {
      clearTimeout(timer);
      // The client hung up (or the response was cut): stop the app's side too.
      if (!upstream.destroyed) upstream.destroy();
    });
    req.pipe(upstream);
  }
}
