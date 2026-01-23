import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { servicesRouter, processManager } from './routes/services.js';
import { resourcesRouter } from './routes/resources.js';
import { LocalStackManager } from './services/localstack-manager.js';
import { startDynamoProxy } from './dev/dynamo-proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3100;

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api/services', servicesRouter);
app.use('/api/resources', resourcesRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    localstack: LocalStackManager.getInstance().isRunning(),
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

    // Optional temporary DynamoDB proxy (port 8000) -> LocalStack (4566)
    // Enable by setting ENABLE_DYNAMO_PROXY=true|1
    const DYNAMO_PROXY_ENABLED =
      String(process.env.ENABLE_DYNAMO_PROXY || '').toLowerCase() === 'true' || process.env.ENABLE_DYNAMO_PROXY === '1';
    if (DYNAMO_PROXY_ENABLED) {
      const port = Number(process.env.DYNAMO_PROXY_PORT || 8000);
      startDynamoProxy(localstack.getEndpoint(), port);
    }
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  processManager.stopAll();
  await processManager.cleanup();
  const localstack = LocalStackManager.getInstance();
  await localstack.stop();
  process.exit(0);
});

start();
