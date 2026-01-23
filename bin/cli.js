#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PID_FILE = path.join(os.tmpdir(), 'lss-orchestrator.pid');
const LOG_FILE = path.join(os.tmpdir(), 'lss-orchestrator.log');

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
  if (fs.existsSync(PID_FILE)) {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    try {
      process.kill(pid, 0);
      console.log('✅ LSS Orchestrator already running (PID:', pid + ')');
      console.log('📊 Dashboard: http://localhost:3100');
      console.log('🔧 LocalStack: http://localhost:4566');
      return;
    } catch (e) {
      fs.unlinkSync(PID_FILE);
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

  const logFd = fs.openSync(LOG_FILE, 'a');
  
  // Check for flags
  const enableDynamoProxy = process.argv.includes('--enable-dynamo-proxy');
  
  // Build environment variables
  const env = { ...process.env };
  if (enableDynamoProxy) {
    env.ENABLE_DYNAMO_PROXY = 'true';
  }
  
  const child = spawn('node', [orchestratorPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env
  });

  child.unref();
  
  fs.closeSync(logFd);
  fs.writeFileSync(PID_FILE, child.pid.toString());
  
  console.log('🚀 LSS Orchestrator started (PID:', child.pid + ')');
  console.log('📊 Dashboard: http://localhost:3100');
  console.log('🔧 LocalStack: http://localhost:4566');
  if (enableDynamoProxy) {
    console.log('🔄 DynamoDB Proxy: http://localhost:8000 (enabled)');
  }
  console.log('📝 Logs:', LOG_FILE);
  
  setTimeout(() => {
    try {
      process.kill(child.pid, 0);
      console.log('✅ Service is running');
    } catch (e) {
      console.error('❌ Service failed to start. Check logs:', LOG_FILE);
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
      }
    }
  }, 2000);
}

function stopOrchestrator() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('⚠️  LSS Orchestrator is not running');
    return;
  }

  const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
  
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log('🛑 LSS Orchestrator stopped (PID:', pid + ')');
  } catch (e) {
    console.error('❌ Failed to stop process:', e.message);
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  }
}

function showStatus() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('⚪ LSS Orchestrator: NOT RUNNING');
    return;
  }

  const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
  
  try {
    process.kill(pid, 0);
    console.log('🟢 LSS Orchestrator: RUNNING (PID:', pid + ')');
    console.log('📊 Dashboard: http://localhost:3100');
    console.log('🔧 LocalStack: http://localhost:4566');
    console.log('📝 Logs:', LOG_FILE);
  } catch (e) {
    console.log('⚪ LSS Orchestrator: NOT RUNNING (stale PID file)');
    fs.unlinkSync(PID_FILE);
  }
}

function showHelp() {
  console.log(`
Local Serverless Stack (LSS) CLI

Usage: npx lss <command> [options]

Commands:
  start    Start the LSS Orchestrator in background
  stop     Stop the LSS Orchestrator
  status   Check if the orchestrator is running
  logs     Show the logs
  help     Show this help message

Options:
  --enable-dynamo-proxy    Enable DynamoDB proxy on port 8000 (for start command)

Examples:
  npx lss start                      # Start the orchestrator
  npx lss start --enable-dynamo-proxy # Start with DynamoDB proxy enabled
  npx lss stop                       # Stop the orchestrator
  npx lss status                     # Check status
  npx lss logs                       # View logs
`);
}

function showLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log('⚠️  No logs found');
    return;
  }
  
  console.log('📝 Logs from:', LOG_FILE);
  console.log('---');
  const logs = fs.readFileSync(LOG_FILE, 'utf8');
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
