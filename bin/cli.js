#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Default paths used when no config is present. The actual paths are derived
// per-invocation by runtimePaths() below, scoped to the configured serverPort
// so multiple examples (each with their own lss.config.json) can run in parallel.
const DEFAULT_PID_FILE = path.join(os.tmpdir(), 'lss-orchestrator.pid');
const DEFAULT_LOG_FILE = path.join(os.tmpdir(), 'lss-orchestrator.log');

// PID/log file paths scoped to the cwd's serverPort. Multiple examples sitting
// in different folders no longer trample each other.
function runtimePaths() {
  const cfg = getConfig(loadConfig());
  const port = cfg.serverPort;
  // Keep the legacy global path when the default port is in use so existing
  // installations don't lose their running process across an upgrade.
  if (!port || port === 3100) {
    return { pidFile: DEFAULT_PID_FILE, logFile: DEFAULT_LOG_FILE };
  }
  return {
    pidFile: path.join(os.tmpdir(), `lss-orchestrator-${port}.pid`),
    logFile: path.join(os.tmpdir(), `lss-orchestrator-${port}.log`),
  };
}

/**
 * Load configuration from lss.config.json or .lssrc
 */
function loadConfig() {
  const candidates = [
    path.join(process.cwd(), 'lss.config.json'),
    path.join(process.cwd(), '.lssrc'),
    path.join(process.env.HOME || '~', 'lss.config.json'),
    path.join(process.env.HOME || '~', '.lssrc'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const content = fs.readFileSync(candidate, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        console.warn(`⚠️  Failed to parse config file ${candidate}`);
      }
    }
  }

  return {};
}

/**
 * Get configuration values with defaults
 */
function getConfig(config) {
  return {
    serverPort: config.serverPort || 3100,
    localstackPort: config.localstackPort || 4566,
    enableDynamoProxy: config.enableDynamoProxy || false,
    dynamoProxyPort: config.dynamoProxyPort || 8000,
    mode: config.mode || 'managed',
    localstackEdition: config.localstackEdition || 'community',
    localstackVersion: config.localstackVersion || 'latest',
    localstackImage: config.localstackImage,
    localstackAuthToken: config.localstackAuthToken,
  };
}

function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  const prefix = `${name}=`;
  const inline = process.argv.find(a => a.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

// Resolve orchestrator path - works both in development and when installed via npm
function getOrchestratorPath() {
  // Try to find the orchestrator relative to this script
  // When installed via npm: node_modules/local-serverless-stack/bin/cli.js
  // In development: /workspaces/local-serverless-stack/bin/cli.js
  const candidates = [
    // Installed via npm in node_modules
    path.join(__dirname, '../dist/server/index.js'),
    // Development mode
    path.join(__dirname, '..', 'dist', 'server', 'index.js')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function startOrchestrator() {
  const { pidFile, logFile } = runtimePaths();

  if (fs.existsSync(pidFile)) {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    try {
      process.kill(pid, 0);
      const config = loadConfig();
      const cfg = getConfig(config);
      console.log('✅ LSS Orchestrator already running (PID:', pid + ')');
      console.log(`📊 Server: http://localhost:${cfg.serverPort}`);
      console.log(`🔧 LocalStack: http://localhost:${cfg.localstackPort}`);
      if (cfg.enableDynamoProxy) {
        console.log(`🔄 DynamoDB Proxy: http://localhost:${cfg.dynamoProxyPort} (enabled)`);
      }
      return;
    } catch (e) {
      fs.unlinkSync(pidFile);
    }
  }

  const orchestratorPath = getOrchestratorPath();
  
  if (!orchestratorPath) {
    console.error('❌ Orchestrator not found or not built.');
    console.error('');
    console.error('If you are developing LSS, run:');
    console.error('  cd /path/to/local-serverless-stack && npm run build');
    console.error('');
    console.error('If you installed via npm, please report this as a bug.');
    process.exit(1);
  }

  const logFd = fs.openSync(logFile, 'a');
  
  // Load config
  const config = loadConfig();
  const cfg = getConfig(config);
  
  // Check for flags
  const enableDynamoProxy = process.argv.includes('--enable-dynamo-proxy') || cfg.enableDynamoProxy;
  const useExternal = process.argv.includes('--external');
  const usePro = process.argv.includes('--pro');
  const cliToken = getArgValue('--localstack-token');

  const mode = useExternal ? 'external' : cfg.mode;
  const edition = usePro ? 'pro' : cfg.localstackEdition;
  const authToken = cliToken || cfg.localstackAuthToken || process.env.LOCALSTACK_AUTH_TOKEN;

  // Build environment variables from config
  const env = { ...process.env };
  if (cfg.serverPort) {
    env.PORT = cfg.serverPort;
  }
  if (cfg.localstackPort) {
    env.LSS_LOCALSTACK_PORT = cfg.localstackPort;
  }
  if (enableDynamoProxy) {
    env.LSS_ENABLE_DYNAMO_PROXY = 'true';
  }
  if (cfg.dynamoProxyPort) {
    env.LSS_DYNAMO_PROXY_PORT = cfg.dynamoProxyPort;
  }
  if (mode) {
    env.LSS_LOCALSTACK_MODE = mode;
  }
  if (edition) {
    env.LSS_LOCALSTACK_EDITION = edition;
  }
  if (cfg.localstackVersion) {
    env.LSS_LOCALSTACK_VERSION = cfg.localstackVersion;
  }
  if (cfg.localstackImage) {
    env.LSS_LOCALSTACK_IMAGE = cfg.localstackImage;
  }
  if (authToken) {
    env.LOCALSTACK_AUTH_TOKEN = authToken;
  }
  
  const child = spawn('node', [orchestratorPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env
  });

  child.unref();
  
  fs.closeSync(logFd);
  fs.writeFileSync(pidFile, child.pid.toString());

  console.log('🚀 LSS Orchestrator started (PID:', child.pid + ')');
  console.log(`📊 Server: http://localhost:${cfg.serverPort}`);
  console.log(`🔧 LocalStack: http://localhost:${cfg.localstackPort} (mode: ${mode}, edition: ${edition})`);
  if (enableDynamoProxy) {
    console.log(`🔄 DynamoDB Proxy: http://localhost:${cfg.dynamoProxyPort} (enabled)`);
  }
  console.log('📝 Logs:', logFile);

  setTimeout(() => {
    try {
      process.kill(child.pid, 0);
      console.log('✅ Service is running');
    } catch (e) {
      console.error('❌ Service failed to start. Check logs:', logFile);
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    }
  }, 2000);
}

function stopOrchestrator() {
  const { pidFile } = runtimePaths();
  if (!fs.existsSync(pidFile)) {
    console.log('⚠️  LSS Orchestrator is not running');
    return;
  }

  const pid = fs.readFileSync(pidFile, 'utf8').trim();

  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(pidFile);
    console.log('🛑 LSS Orchestrator stopped (PID:', pid + ')');
  } catch (e) {
    console.error('❌ Failed to stop process:', e.message);
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }
}

function showStatus() {
  const { pidFile, logFile } = runtimePaths();
  if (!fs.existsSync(pidFile)) {
    console.log('⚪ LSS Orchestrator: NOT RUNNING');
    return;
  }

  const pid = fs.readFileSync(pidFile, 'utf8').trim();

  try {
    process.kill(pid, 0);
    const config = loadConfig();
    const cfg = getConfig(config);
    console.log('🟢 LSS Orchestrator: RUNNING (PID:', pid + ')');
    console.log(`📊 Server: http://localhost:${cfg.serverPort}`);
    console.log(`🔧 LocalStack: http://localhost:${cfg.localstackPort}`);
    if (cfg.enableDynamoProxy) {
      console.log(`🔄 DynamoDB Proxy: http://localhost:${cfg.dynamoProxyPort} (enabled)`);
    }
    console.log('📝 Logs:', logFile);
  } catch (e) {
    console.log('⚪ LSS Orchestrator: NOT RUNNING (stale PID file)');
    fs.unlinkSync(pidFile);
  }
}

function getServerPort() {
  const cfg = getConfig(loadConfig());
  return cfg.serverPort;
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: 'localhost',
        port: getServerPort(),
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          let parsed;
          try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function ensureRunningOrExit() {
  const { pidFile } = runtimePaths();
  if (!fs.existsSync(pidFile)) {
    console.error('❌ LSS Orchestrator is not running. Start it with: npx lss start');
    process.exit(1);
  }
}

function printSeedRunResults(results) {
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⚠ ${r.tableName}: skipped (${r.reason})`);
    } else {
      console.log(`  ✓ ${r.tableName}: ${r.inserted} item(s) inserted`);
    }
  }
}

function printSeedClearResults(results) {
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⚠ ${r.tableName}: skipped (${r.reason})`);
    } else {
      console.log(`  ✓ ${r.tableName}: ${r.deleted} item(s) deleted`);
    }
  }
}

async function runSeed(tableName) {
  ensureRunningOrExit();
  try {
    console.log(tableName ? `🌱 Seeding ${tableName}...` : '🌱 Seeding all tables with seed files...');
    const res = await postJson('/api/seeds/run', tableName ? { tableName } : {});
    printSeedRunResults(res.results || []);
  } catch (e) {
    console.error('❌ Seed failed:', e.message);
    process.exit(1);
  }
}

async function clearSeed(tableName) {
  ensureRunningOrExit();
  try {
    console.log(tableName ? `🧹 Clearing ${tableName}...` : '🧹 Clearing all seeded tables...');
    const res = await postJson('/api/seeds/clear', tableName ? { tableName } : {});
    printSeedClearResults(res.results || []);
  } catch (e) {
    console.error('❌ Clear failed:', e.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Local Serverless Stack (LSS) CLI

Usage: npx lss <command> [options]

Commands:
  start              Start the LSS Orchestrator in background
  stop               Stop the LSS Orchestrator
  status             Check if the orchestrator is running
  logs               Show the logs
  seed [table]       Apply seed file(s) from seedsDir into DynamoDB
                     (no args = all matching tables)
  seed:clear [table] Delete all items from the given table (or all
                     tables with a seed file when no arg is given)
  help               Show this help message

Options:
  --enable-dynamo-proxy        Enable DynamoDB proxy on port 8000 (for start command)
  --external                   Connect to a LocalStack already running, do not spawn a container
  --pro                        Use the LocalStack Pro image (requires LOCALSTACK_AUTH_TOKEN)
  --localstack-token <token>   Pass a LOCALSTACK_AUTH_TOKEN to the container

Environment:
  LOCALSTACK_AUTH_TOKEN        Token forwarded to LocalStack (Pro and >=2026.5 community)

Configuration:
  Create a lss.config.json or .lssrc file in your project root to customize:

  Example lss.config.json:
  {
    "serverPort": 3100,
    "localstackPort": 4566,
    "mode": "managed",
    "localstackEdition": "community",
    "localstackVersion": "latest",
    "enableDynamoProxy": false,
    "dynamoProxyPort": 8000,
    "region": "us-east-1",
    "services": ["dynamodb", "sqs", "sns", "lambda"],
    "persistence": true,
    "debug": false
  }

  For the Serverless Plugin, add to serverless.yml:
  custom:
    orchestrator:
      enabled: true
      orchestratorUrl: http://localhost:3100

Examples:
  npx lss start                              # Start the orchestrator (managed LocalStack)
  npx lss start --enable-dynamo-proxy        # Start with DynamoDB proxy enabled
  npx lss start --external                   # Connect to an external LocalStack
  npx lss start --pro                        # Use LocalStack Pro (token required)
  LOCALSTACK_AUTH_TOKEN=xxx npx lss start    # Inject a token via env var
  npx lss stop                               # Stop the orchestrator
  npx lss status                             # Check status
  npx lss logs                               # View logs
  npx lss seed                               # Seed every table that has a {name}.json file
  npx lss seed users                         # Seed only the "users" table
  npx lss seed:clear users                   # Delete all items from "users"
`);
}

function showLogs() {
  const { logFile } = runtimePaths();
  if (!fs.existsSync(logFile)) {
    console.log('⚠️  No logs found');
    return;
  }

  console.log('📝 Logs from:', logFile);
  console.log('---');
  const logs = fs.readFileSync(logFile, 'utf8');
  const lines = logs.split('\n');
  const lastLines = lines.slice(-50).join('\n');
  console.log(lastLines);
}

const command = process.argv[2];

switch (command) {
  case 'start':
    startOrchestrator();
    break;
  case 'stop':
    stopOrchestrator();
    break;
  case 'status':
    showStatus();
    break;
  case 'logs':
    showLogs();
    break;
  case 'seed':
    runSeed(process.argv[3]);
    break;
  case 'seed:clear':
    clearSeed(process.argv[3]);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    console.log('❌ Unknown command:', command);
    showHelp();
    process.exit(1);
}
