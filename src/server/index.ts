import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { servicesRouter, processManager } from './routes/services.js';
import { resourcesRouter } from './routes/resources.js';
import { queuesRouter } from './routes/queues.js';
import { bucketsRouter } from './routes/buckets.js';
import { seedsRouter } from './routes/seeds.js';
import { dynamoRouter } from './routes/dynamo.js';
import { opensearchRouter } from './routes/opensearch.js';
import { secretsRouter } from './routes/secrets.js';
import { configRouter } from './routes/config.js';
import { lambdasRouter } from './routes/lambdas.js';
import { apisRouter } from './routes/apis.js';
import { EngineManager } from './engine/engine-manager.js';
import { ConfigManager } from './services/config-manager.js';
import { QueueInspector } from './services/queue-inspector.js';
import { ServiceRegistrar } from './services/service-registrar.js';
import { SeedManager } from './services/seed-manager.js';
import { LambdaRuntimeManager } from './services/lambda-runtime-manager.js';
import { GatewayManager } from './services/gateway-manager.js';
import { SourceWatcher } from './services/source-watcher.js';
import { startDynamoProxy } from './dev/dynamo-proxy.js';
import { applyRegionToExplorers } from './services/explorer-region.js';
import { getBindHost, isOriginAllowed, getExposureWarning } from './services/bind-host.js';
import { isAwsRequest } from './engine/http/is-aws-request.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const configManager = ConfigManager.getInstance();
const PORT = configManager.getDashboardPort();
let dynamoProxyServer: http.Server | null = null;

// Interface the orchestrator listens on. **Loopback by default.**
//
// This API has no authentication and it runs commands on this host — starting a
// service spawns a child process, registering one packages it — so a listener on
// every interface hands the developer's machine to anything that can reach the
// port: another device on a café/hotel Wi-Fi, a colleague on the office LAN, a
// compromised phone on the same router. `listen(PORT)` with no host did exactly
// that, silently.
//
// `LSS_BIND_HOST` is the deliberate opt-in (`LSS_BIND_HOST=0.0.0.0 lss start`).
// It exists because a loopback bind is invisible to Docker port publishing: with
// `docker run -p 14566:14566` the forwarded connection arrives on the container's
// external interface, which a 127.0.0.1 listener refuses. VS Code devcontainer
// port forwarding does NOT need it — the forwarder attaches from inside the
// container, where loopback is the same network stack — so the flow most people
// use here keeps the safe default.
//
// It lives in services/bind-host.ts rather than here because this file is not
// the only place that opens a socket: per-service gateway/invoke listeners, the
// split self-engine front door and the DynamoDB proxy all bind too, and a fence
// that only one of four listeners honours is not a fence. That module owns the
// browser half too (`LSS_CORS_ORIGINS`, below), so the whole posture is one
// decision made in one place.
const BIND_HOST = getBindHost();

// Middleware
//
// `cors()` with no options answered every preflight with
// `Access-Control-Allow-Origin: *`. That is what made an unauthenticated,
// command-running API drive-by reachable: any page the developer happened to
// open could preflight and then POST JSON to `/api/services/:name/start`. The
// wildcard is gone; who may call from a browser is now the single decision in
// services/bind-host.ts — loopback origins by default, widened by
// `LSS_CORS_ORIGINS` (a comma-separated allowlist, or `*`) for the containerised
// setup where the dashboard and the developer's own frontends live on another
// origin. A rejected origin gets no CORS headers at all, which makes the browser
// refuse the preflight and never send the real request.
//
// The AWS wire is unaffected: SDK traffic is demuxed by `isAwsRequestMessage()`
// in the HTTP server below and handed to the engine handler *before* Express
// (and therefore this middleware) ever sees it — and SigV4 clients are not
// browsers, so they send no `Origin` in the first place.
app.use(cors({
  origin(origin, callback) {
    callback(null, isOriginAllowed(origin));
  },
}));
app.use(express.json());

// API routes
app.use('/api/services', servicesRouter);
app.use('/api/resources', resourcesRouter);
app.use('/api/queues', queuesRouter);
app.use('/api/buckets', bucketsRouter);
app.use('/api/seeds', seedsRouter);
app.use('/api/dynamo', dynamoRouter);
app.use('/api/opensearch', opensearchRouter);
app.use('/api/secrets', secretsRouter);
app.use('/api/config', configRouter);
app.use('/api/lambdas', lambdasRouter);
app.use('/api/apis', apisRouter);

// Health check
app.get('/api/health', (_req, res) => {
  const engine = EngineManager.getInstance();
  res.json({
    status: 'ok',
    engineRunning: engine.isRunning(),
    engine: engine.healthDetail(),
    dynamoProxy: {
      enabled: configManager.isEnableDynamoProxy(),
      running: Boolean(dynamoProxyServer?.listening),
      port: configManager.getDynamoProxyPort(),
    },
  });
});

// Anything under /api that no router claimed is a 404 in JSON, not the SPA.
// Without this the catch-all below answers 200 text/html for a mistyped API
// path, which reads as success to curl, to the LssClient and to any test
// asserting on the response — the single most confusing failure mode when
// driving LSS from an automated suite.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} /api${req.path}` });
});

// Serve frontend build (fallback for SPA)
// __dirname is dist/server, so ../ui points to dist/ui
const uiBuildPath = path.join(__dirname, '../ui');
app.use(express.static(uiBuildPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(uiBuildPath, 'index.html'));
});

// Boot: engine → HTTP → services.
async function start() {
  try {
    console.log('🚀 Starting Orchestrator Server...');

    // In-process AWS engine: no Docker, no container, no auth token.
    //
    // By default it shares this process's listener instead of binding its own,
    // so the REST API, the dashboard and the AWS wire are all one port and one
    // URL. `isAwsRequest` decides per request which handler answers; give
    // `serverPort` and `selfEngine.port` different values to split them again.
    //
    // Embedded is also what puts the AWS wire on this listener's socket for
    // free. The split-listener branch binds inside
    // engine/backends/self-backend.ts — which now reads the same
    // services/bind-host.ts this file does, so splitting the ports no longer
    // splits the exposure (it used to ask for '0.0.0.0' outright, publishing
    // the entire AWS data plane while the dashboard sat on loopback).
    const engine = EngineManager.getInstance();
    const single = configManager.isSingleListener();
    let awsHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;
    if (single) {
      awsHandler = await engine.startEmbedded();
    } else {
      await engine.start();
    }

    // An EADDRINUSE on the dashboard port has to be a named, actionable
    // failure: without an 'error' listener it surfaces as an unhandled
    // exception AFTER the engine has already bound its own port and started
    // its delivery loops, leaving a half-alive process behind.
    // One server, two handlers: an AWS SDK call goes to the engine, everything
    // else to Express. The engine's own dispatcher falls back to S3 for
    // anything it cannot classify, so `GET /assets/app.js` would be read as a
    // bucket — the split has to happen here, in front of it.
    const httpServer = http.createServer((req, res) => {
      if (awsHandler && isAwsRequestMessage(req)) {
        awsHandler(req, res);
        return;
      }
      app(req, res);
    });
    // `localhost` in the log lines stays correct under both binds: it is the
    // address a loopback listener answers on, and an all-interfaces listener
    // answers there too.
    httpServer.listen(PORT, BIND_HOST, () => {
      if (single) {
        console.log(`✅ LSS on http://localhost:${PORT} — dashboard, REST API and AWS wire`);
      } else {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        console.log(`✅ Self engine running on ${engine.getEndpoint()}`);
      }
      // Widening the exposure must never be something you did and did not
      // notice. One warning covers the whole process, both halves of the
      // posture: every other listener (per-service gateway/invoke ports, the
      // split engine front door, the DynamoDB proxy) binds the address resolved
      // once in services/bind-host.ts, and the same module decides which browser
      // origins may call the API. It returns null when neither knob was widened.
      const exposure = getExposureWarning();
      if (exposure) console.warn(exposure);
    });
    httpServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(
          `❌ Orchestrator could not bind port ${PORT}: address already in use. ` +
            'Another LSS instance (or another process) is listening there — stop it, ' +
            'or set serverPort in lss.config.json to a free port.',
        );
      } else if (error.code === 'EADDRNOTAVAIL') {
        // Only reachable through LSS_BIND_HOST: the default 127.0.0.1 always
        // exists. Name the variable, or the failure reads as a port problem.
        console.error(
          `❌ Orchestrator could not bind ${BIND_HOST}:${PORT}: that address does not belong to ` +
            'this host. LSS_BIND_HOST must name an interface of this machine — 127.0.0.1 (the ' +
            'default), 0.0.0.0, or one of its own addresses.',
        );
      } else {
        console.error('❌ Orchestrator HTTP server failed:', error);
      }
      void shutdown(1);
    });

    QueueInspector.getInstance().startPolling();

    // Hot reload: source changes restart the service worker; serverless.yml
    // changes re-package + re-register.
    SourceWatcher.getInstance().setHandlers({
      onRuntimeReload: name => LambdaRuntimeManager.getInstance().restartRuntime(name),
      onFullReload: name => ServiceRegistrar.getInstance().reregister(name),
    });

    // Every explorer answers requests that omit `?region=` — the CLI, the
    // LssClient and plain curl all do. Pin their default to the configured
    // region here so those callers see the same resources the dashboard does
    // (which only worked because it always sends the region from /api/config).
    applyRegionToExplorers(configManager.getRegion());

    // Seed Secrets Manager BEFORE reactivating services so any handler that
    // reads a secret on its first invocation (including relay-triggered handlers
    // that fire during rehydrate) already finds an AWSCURRENT version. Non-fatal
    // — a seed failure must not abort startup.
    try {
      SeedManager.getInstance().setDefaultRegion(configManager.getRegion());
      await SeedManager.getInstance().seedAllSecrets(configManager.getRegion());
    } catch (error) {
      console.warn(
        '⚠️  Failed to seed Secrets Manager on boot:',
        error instanceof Error ? error.message : error,
      );
    }

    // Reactivate cached services (runtime workers + gateway/invoke listeners)
    // so registrations survive orchestrator restarts.
    await ServiceRegistrar.getInstance().rehydrateAll();

    // Optional DynamoDB proxy (off by default). Its listener is created and
    // bound inside dev/dynamo-proxy.ts, which reads the same bind host — turning
    // the proxy on re-publishes the engine's DynamoDB surface on :8000, but only
    // to whoever the rest of the stack is already offered to.
    if (configManager.isEnableDynamoProxy()) {
      const proxyPort = configManager.getDynamoProxyPort();
      dynamoProxyServer = startDynamoProxy(engine.getEndpoint(), proxyPort);
    }

    // Print configuration summary
    configManager.printSummary();
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Adapts a raw request to the probe `isAwsRequest` takes.
function isAwsRequestMessage(req: http.IncomingMessage): boolean {
  const url = req.url ?? '/';
  const queryIndex = url.indexOf('?');
  return isAwsRequest({
    method: (req.method ?? 'GET').toUpperCase(),
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    headers: req.headers,
    query: new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1)),
  });
}

// Graceful shutdown. `code` is non-zero when a fatal boot problem (e.g. the
// dashboard port already taken) triggers the teardown, so the CLI reports the
// failure instead of a clean stop.
async function shutdown(code = 0) {
  console.log('\n🛑 Shutting down gracefully...');
  QueueInspector.getInstance().stopPolling();
  SourceWatcher.getInstance().unwatchAll();
  await GatewayManager.getInstance().stopAll();
  await LambdaRuntimeManager.getInstance().stopAll();
  processManager.stopAll();
  await processManager.cleanup();
  await EngineManager.getInstance().stop();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown());
// The CLI stops the daemonized server with SIGTERM — same cleanup path.
process.on('SIGTERM', () => void shutdown());

start();
