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
import type { AossSidecarHandle } from './engine/aoss-sidecar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const configManager = ConfigManager.getInstance();
const PORT = configManager.getDashboardPort();
let dynamoProxyServer: http.Server | null = null;
let aossSidecar: AossSidecarHandle | null = null;

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
    // Kept for client/UI compatibility: truthy when the ACTIVE engine
    // (LocalStack or self) is healthy.
    localstack: engine.isRunning(),
    engine: engine.healthDetail(),
    dynamoProxy: {
      enabled: configManager.isEnableDynamoProxy(),
      running: Boolean(dynamoProxyServer?.listening),
      port: configManager.getDynamoProxyPort(),
    },
    aossSidecar: {
      enabled: configManager.getAossSidecarConfig().enabled,
      running: aossSidecar !== null,
      port: configManager.getAossSidecarConfig().port,
    },
  });
});

// Serve frontend build (fallback for SPA)
// __dirname is dist/server, so ../ui points to dist/ui
const uiBuildPath = path.join(__dirname, '../ui');
app.use(express.static(uiBuildPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(uiBuildPath, 'index.html'));
});

// Start server and LocalStack
async function start() {
  try {
    console.log('🚀 Starting Orchestrator Server...');

    // Initialize the AWS engine (LocalStack container or in-process self engine)
    const engine = EngineManager.getInstance();
    await engine.start();

    // OpenSearch Serverless (aoss) sidecar: no LocalStack edition provides
    // aoss, so LSS serves the self-engine emulator in-process next to it.
    // Dynamic import keeps the LocalStack-mode memory profile lean, matching
    // how the self backend is loaded. Failure is non-fatal — everything but
    // aoss still works.
    const aossConfig = configManager.getAossSidecarConfig();
    if (aossConfig.enabled) {
      try {
        const { startAossSidecar } = await import('./engine/aoss-sidecar.js');
        aossSidecar = await startAossSidecar({
          port: aossConfig.port,
          dataDir: aossConfig.dataDir,
          region: configManager.getRegion(),
        });
        console.log(
          `🔎 OpenSearch Serverless (aoss) sidecar on ${aossSidecar.endpoint} — ` +
            'LocalStack does not provide aoss; LSS serves it in-process',
        );
      } catch (error) {
        console.warn(
          '⚠️  Failed to start the aoss sidecar (OpenSearch Serverless will be unavailable):',
          error instanceof Error ? error.message : error,
        );
      }
    }

    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log(`✅ Engine (${engine.getKind()}) running on ${engine.getEndpoint()}`);
    });

    QueueInspector.getInstance().startPolling();

    // Hot reload: source changes restart the service worker; serverless.yml
    // changes re-package + re-register.
    SourceWatcher.getInstance().setHandlers({
      onRuntimeReload: name => LambdaRuntimeManager.getInstance().restartRuntime(name),
      onFullReload: name => ServiceRegistrar.getInstance().reregister(name),
    });

    // Seed Secrets Manager BEFORE reactivating services so any handler that
    // reads a secret on its first invocation (including relay-triggered handlers
    // that fire during rehydrate) already finds an AWSCURRENT version. Non-fatal
    // — a seed failure must not abort startup (matches the aoss-sidecar block).
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

// Graceful shutdown
async function shutdown() {
  console.log('\n🛑 Shutting down gracefully...');
  QueueInspector.getInstance().stopPolling();
  SourceWatcher.getInstance().unwatchAll();
  await GatewayManager.getInstance().stopAll();
  await LambdaRuntimeManager.getInstance().stopAll();
  processManager.stopAll();
  await processManager.cleanup();
  await aossSidecar?.close();
  aossSidecar = null;
  await EngineManager.getInstance().stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
// The CLI stops the daemonized server with SIGTERM — same cleanup path.
process.on('SIGTERM', shutdown);

start();
