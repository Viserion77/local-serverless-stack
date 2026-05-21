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
import { configRouter } from './routes/config.js';
import { LocalStackManager } from './services/localstack-manager.js';
import { ConfigManager } from './services/config-manager.js';
import { QueueInspector } from './services/queue-inspector.js';
import { startDynamoProxy } from './dev/dynamo-proxy.js';

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
app.use('/api/config', configRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    localstack: LocalStackManager.getInstance().isRunning(),
    dynamoProxy: {
      enabled: configManager.isEnableDynamoProxy(),
      running: Boolean(dynamoProxyServer?.listening),
      port: configManager.getDynamoProxyPort(),
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

    // Initialize LocalStack
    const localstack = LocalStackManager.getInstance();
    await localstack.start();

    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log(`✅ LocalStack running on ${localstack.getEndpoint()}`);
    });

    QueueInspector.getInstance().startPolling();

    // Optional DynamoDB proxy
    if (configManager.isEnableDynamoProxy()) {
      const proxyPort = configManager.getDynamoProxyPort();
      dynamoProxyServer = startDynamoProxy(localstack.getEndpoint(), proxyPort);
    }

    // Print configuration summary
    configManager.printSummary();
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  QueueInspector.getInstance().stopPolling();
  processManager.stopAll();
  await processManager.cleanup();
  const localstack = LocalStackManager.getInstance();
  await localstack.stop();
  process.exit(0);
});

start();
