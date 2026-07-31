// Multi-port data plane: for every registered service this binds (in the
// orchestrator process — no extra processes) an API Gateway listener on the
// service's apiPort (30xx) and an AWS Lambda Invoke API listener on its
// invokePort (130xx). Existing monorepo callers and the LocalStack event
// proxies keep their ports and contracts; only the process answering changes.

import http from 'http';
import { FunctionRegistry, ServiceEntry } from './function-registry.js';
import { LambdaRuntimeManager } from './lambda-runtime-manager.js';
import { AuthorizerService } from './authorizer-service.js';
import { LAMBDA_INVOKE_PATH } from './lambda-invoke-uri.js';
import {
  IncomingRequest,
  matchRoute,
  buildV1Event,
  buildV2Event,
  mapV1Response,
  mapV2Response,
  errorResponse,
  MappedResponse,
} from './api-gateway-events.js';

export type ListenerStatus = 'online' | 'port-conflict' | 'stopped' | 'disabled';

export interface GatewayInfo {
  api: { port?: number; status: ListenerStatus };
  invoke: { port?: number; status: ListenerStatus };
}

interface ServiceListeners {
  entry: ServiceEntry;
  apiServer?: http.Server;
  apiStatus: ListenerStatus;
  invokeServer?: http.Server;
  invokeStatus: ListenerStatus;
  // Pending EADDRINUSE rebind timers — cancelled on stop/remove so a retry
  // never outlives its service.
  rebindTimers: Set<NodeJS.Timeout>;
}

export class GatewayManager {
  private static instance: GatewayManager;
  private listeners = new Map<string, ServiceListeners>();
  // Delay between rebind attempts after an EADDRINUSE. Overridable so tests
  // don't wait real seconds between retries.
  rebindIntervalMs = 5000;

  static getInstance(): GatewayManager {
    if (!GatewayManager.instance) {
      GatewayManager.instance = new GatewayManager();
    }
    return GatewayManager.instance;
  }

  // (Re)bind listeners for a service after registration or a port change.
  async syncService(entry: ServiceEntry, enabled: boolean): Promise<void> {
    await this.stopService(entry.name);

    const state: ServiceListeners = {
      entry,
      apiStatus: 'disabled',
      invokeStatus: 'disabled',
      rebindTimers: new Set(),
    };
    this.listeners.set(entry.name, state);
    if (!enabled) return;

    if (entry.apiPort && entry.routes.length > 0) {
      state.apiStatus = 'stopped';
      state.apiServer = await this.bind(
        entry.apiPort,
        (req, res) => void this.handleApiRequest(entry.name, req, res),
        status => { state.apiStatus = status; },
        `API gateway for "${entry.name}"`,
        state.rebindTimers,
      );
    }

    if (entry.invokePort && entry.functions.length > 0) {
      state.invokeStatus = 'stopped';
      state.invokeServer = await this.bind(
        entry.invokePort,
        (req, res) => void this.handleInvokeRequest(entry.name, req, res),
        status => { state.invokeStatus = status; },
        `Lambda invoke endpoint for "${entry.name}"`,
        state.rebindTimers,
      );
    }
  }

  async stopService(serviceName: string): Promise<void> {
    const state = this.listeners.get(serviceName);
    if (!state) return;
    // Cancel pending rebind attempts first so a conflicted listener can't
    // come back to life after its service stops.
    for (const timer of state.rebindTimers) clearTimeout(timer);
    state.rebindTimers.clear();
    await Promise.all([
      this.close(state.apiServer),
      this.close(state.invokeServer),
    ]);
    state.apiServer = undefined;
    state.invokeServer = undefined;
    if (state.apiStatus === 'online') state.apiStatus = 'stopped';
    if (state.invokeStatus === 'online') state.invokeStatus = 'stopped';
  }

  async removeService(serviceName: string): Promise<void> {
    await this.stopService(serviceName);
    this.listeners.delete(serviceName);
  }

  async stopAll(): Promise<void> {
    for (const name of this.listeners.keys()) {
      await this.stopService(name);
    }
  }

  getInfo(serviceName: string): GatewayInfo {
    const state = this.listeners.get(serviceName);
    if (!state) {
      return { api: { status: 'stopped' }, invoke: { status: 'stopped' } };
    }
    return {
      api: { port: state.entry.apiPort, status: state.apiStatus },
      invoke: { port: state.entry.invokePort, status: state.invokeStatus },
    };
  }

  // Bind a listener, resolving on the first outcome (listening or failed). An
  // EADDRINUSE never fails the registration: the listener reports
  // 'port-conflict' and rebinding is retried every `rebindIntervalMs` until
  // the port frees up or the service stops.
  private bind(
    port: number,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    setStatus: (status: ListenerStatus) => void,
    label: string,
    rebindTimers: Set<NodeJS.Timeout>,
  ): Promise<http.Server> {
    return new Promise(resolve => {
      const server = http.createServer(handler);
      let hadConflict = false;
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Port conflicts are first-class: another process (or another LSS instance)
          // may own the port — flag it, never fail the registration.
          setStatus('port-conflict');
          if (!hadConflict) {
            hadConflict = true;
            console.warn(`⚠️  ${label}: port ${port} already in use — retrying every ${this.rebindIntervalMs}ms (another process owns it)`);
          }
          this.scheduleRebind(server, port, rebindTimers);
        } else {
          setStatus('stopped');
          console.error(`❌ ${label}: ${err.message}`);
        }
        resolve(server);
      });
      server.on('listening', () => {
        setStatus('online');
        if (hadConflict) {
          console.log(`✅ ${label} recovered from port conflict — listening on http://localhost:${port}`);
        } else {
          console.log(`✅ ${label} listening on http://localhost:${port}`);
        }
        resolve(server);
      });
      server.listen(port);
    });
  }

  // Queue a single rebind attempt after an EADDRINUSE. unref() keeps retries
  // from holding the process open; the timer is tracked in the service's set
  // so stop/remove/shutdown paths can cancel it.
  private scheduleRebind(server: http.Server, port: number, rebindTimers: Set<NodeJS.Timeout>): void {
    const timer = setTimeout(() => {
      rebindTimers.delete(timer);
      // A failed retry re-enters the server's 'error' handler and reschedules.
      if (!server.listening) {
        server.listen(port);
      }
    }, this.rebindIntervalMs);
    timer.unref();
    rebindTimers.add(timer);
  }

  private close(server?: http.Server): Promise<void> {
    return new Promise(resolve => {
      if (!server || !server.listening) return resolve();
      server.close(() => resolve());
    });
  }

  private async readRequest(req: http.IncomingMessage): Promise<IncomingRequest> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const url = new URL(req.url || '/', 'http://localhost');
    return {
      method: req.method || 'GET',
      path: decodeURIComponent(url.pathname),
      rawQueryString: url.search.replace(/^\?/, ''),
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : null,
      sourceIp: req.socket.remoteAddress || '127.0.0.1',
    };
  }

  private send(res: http.ServerResponse, mapped: MappedResponse, extraHeaders?: Record<string, string>): void {
    const headers: Record<string, string | string[]> = { ...extraHeaders, ...mapped.headers };
    if (mapped.cookies.length) headers['set-cookie'] = mapped.cookies;
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    res.writeHead(mapped.statusCode, headers);
    res.end(mapped.body);
  }

  // -------------------------------------------------------------------------
  // API Gateway emulation (apiPort)
  // -------------------------------------------------------------------------

  private async handleApiRequest(serviceName: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const entry = FunctionRegistry.getInstance().getService(serviceName);
    if (!entry) {
      return this.send(res, errorResponse(404, 'Not Found'));
    }

    try {
      const request = await this.readRequest(req);
      const corsHeaders = this.corsHeaders(entry, request);

      // CORS preflight is answered by the gateway itself (as API Gateway does
      // for configured CORS), so browsers work without handler involvement.
      if (request.method.toUpperCase() === 'OPTIONS') {
        res.writeHead(204, {
          ...corsHeaders,
          'access-control-allow-methods': this.allowedMethods(entry, request.path),
          'access-control-allow-headers': String(request.headers['access-control-request-headers'] || 'Content-Type,Authorization,X-Api-Key'),
          'access-control-max-age': '300',
        });
        res.end();
        return;
      }

      const match = matchRoute(entry.routes, request.method, request.path);
      if (!match) {
        console.log(`↪️  [${serviceName}:${entry.apiPort}] ${request.method} ${request.path} → no route`);
        return this.send(res, errorResponse(404, 'Not Found'), corsHeaders);
      }

      const { route, pathParameters } = match;
      const stage = entry.stage || 'dev';

      // Lambda authorizer, when the route has one.
      let authorizer;
      if (route.authorizerName) {
        const config = FunctionRegistry.getInstance().getAuthorizer(serviceName, route.authorizerName);
        if (!config) {
          console.error(`❌ [${serviceName}] route ${route.method} ${route.path}: authorizer "${route.authorizerName}" is not registered (unsupported type?)`);
          return this.send(res, errorResponse(500, 'Internal Server Error'), corsHeaders);
        }
        const decision = await AuthorizerService.getInstance().authorize(serviceName, stage, route, config, request);
        if (decision.deniedStatus) {
          return this.send(res, errorResponse(decision.deniedStatus, decision.message || 'Forbidden'), corsHeaders);
        }
        authorizer = decision.authorizer;
      }

      // Resolve the route's target: a local function by short name first, then
      // (for a cross-stack raw route, or any local miss) the global registry by
      // ARN/name — the same mechanism the cross-service authorizer uses, so
      // registration order does not matter.
      let fn = entry.functions.find(f => f.name === route.functionName);
      let targetService = serviceName;
      if (!fn || route.functionArn) {
        const resolved = FunctionRegistry.getInstance().resolve(route.functionArn ?? route.functionName, serviceName);
        if (resolved) {
          fn = resolved.fn;
          targetService = resolved.service.name;
        }
      }
      if (!fn) {
        return this.send(res, errorResponse(500, 'Internal Server Error'), corsHeaders);
      }

      const eventOptions = { request, route, pathParameters, stage, authorizer };
      const event = route.eventType === 'httpApi' ? buildV2Event(eventOptions) : buildV1Event(eventOptions);

      const result = await LambdaRuntimeManager.getInstance().invoke(targetService, fn, event);
      if (!result.ok) {
        console.error(`❌ [${serviceName}] ${request.method} ${request.path} → ${fn.name}: ${result.errorType}: ${result.errorMessage}`);
        return this.send(res, errorResponse(route.eventType === 'httpApi' ? 500 : 502, 'Internal server error'), corsHeaders);
      }

      const mapped = route.eventType === 'httpApi' ? mapV2Response(result.payload) : mapV1Response(result.payload);
      return this.send(res, mapped, corsHeaders);
    } catch (err) {
      console.error(`❌ Gateway error for "${serviceName}":`, err);
      return this.send(res, errorResponse(500, 'Internal Server Error'));
    }
  }

  private corsHeaders(entry: ServiceEntry, request: IncomingRequest): Record<string, string> {
    const anyCors = entry.routes.some(r => r.cors);
    if (!anyCors) return {};
    const origin = request.headers['origin'];
    return {
      'access-control-allow-origin': typeof origin === 'string' && origin ? origin : '*',
      'access-control-allow-credentials': 'true',
    };
  }

  private allowedMethods(entry: ServiceEntry, path: string): string {
    const methods = new Set<string>(['OPTIONS']);
    for (const route of entry.routes) {
      const match = matchRoute([route], route.method === 'ANY' ? 'GET' : route.method, path);
      if (match || route.path === '$default') {
        if (route.method === 'ANY') ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].forEach(m => methods.add(m));
        else methods.add(route.method);
      }
    }
    return [...methods].join(',');
  }

  // -------------------------------------------------------------------------
  // AWS Lambda Invoke API emulation (invokePort)
  // -------------------------------------------------------------------------

  private async handleInvokeRequest(serviceName: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const request = await this.readRequest(req);
      const match = LAMBDA_INVOKE_PATH.exec(request.path);
      if (!match || request.method.toUpperCase() !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Message: `Unsupported path: ${request.path}` }));
        return;
      }

      const functionName = decodeURIComponent(match[1]);
      // Scope to this port's service first; fall back to the global registry so
      // any registered function is reachable from any invoke port.
      const resolved = FunctionRegistry.getInstance().resolve(functionName, serviceName);
      if (!resolved) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          Message: `Function not found: ${functionName}`,
          Type: 'User',
        }));
        return;
      }

      const invocationType = String(request.headers['x-amz-invocation-type'] || 'RequestResponse');
      let event: unknown = {};
      if (request.body && request.body.length) {
        try {
          event = JSON.parse(request.body.toString('utf-8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ Type: 'User', Message: 'Invalid JSON payload' }));
          return;
        }
      }

      if (invocationType === 'DryRun') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (invocationType === 'Event') {
        // Fire and forget — errors only show up in the runtime logs/UI.
        void LambdaRuntimeManager.getInstance().invoke(resolved.service.name, resolved.fn, event);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('');
        return;
      }

      const result = await LambdaRuntimeManager.getInstance().invoke(resolved.service.name, resolved.fn, event);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-amz-executed-version': '$LATEST',
        'x-amz-log-result': Buffer.from(result.logs.slice(-32).join('\n')).toString('base64'),
      };
      if (!result.ok) {
        // Lambda semantics: handler errors are 200 + X-Amz-Function-Error.
        headers['x-amz-function-error'] = 'Unhandled';
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          errorType: result.errorType,
          errorMessage: result.errorMessage,
          trace: result.trace,
        }));
        return;
      }
      res.writeHead(200, headers);
      res.end(result.payload === undefined || result.payload === null ? 'null' : JSON.stringify(result.payload));
      return;
    } catch (err) {
      console.error(`❌ Invoke endpoint error for "${serviceName}":`, err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Type: 'Server', Message: 'Internal Server Error' }));
      return;
    }
  }
}
