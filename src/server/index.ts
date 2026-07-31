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
import { isAwsRequest } from './engine/http/is-aws-request.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const configManager = ConfigManager.getInstance();
const PORT = configManager.getDashboardPort();
let dynamoProxyServer: http.Server | null = null;

// Middleware
app.use(cors());
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
    httpServer.listen(PORT, () => {
      if (single) {
        console.log(`✅ LSS on http://localhost:${PORT} — dashboard, REST API and AWS wire`);
      } else {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        console.log(`✅ Self engine running on ${engine.getEndpoint()}`);
      }
    });
    httpServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(
          `❌ Orchestrator could not bind port ${PORT}: address already in use. ` +
            'Another LSS instance (or another process) is listening there — stop it, ' +
            'or set serverPort in lss.config.json to a free port.',
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

    // Optional DynamoDB proxy
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
