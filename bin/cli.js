#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

// Default paths used when no config is present. The actual paths are derived
// per-invocation by runtimePaths() below, scoped to the configured serverPort
// so multiple examples (each with their own lss.config.json) can run in parallel.
const DEFAULT_PID_FILE = path.join(os.tmpdir(), 'lss-orchestrator.pid');
const DEFAULT_LOG_FILE = path.join(os.tmpdir(), 'lss-orchestrator.log');

// PID/log file paths for the instance addressed by this invocation.
//   - When the config provides a `stateDir`, PID/log live inside it. This gives
//     an explicitly isolated instance (e.g. an e2e test stack) its own state so
//     `lss stop --config <path>` targets it and never the dev instance.
//   - Otherwise the paths are scoped to the cwd's serverPort, so multiple
//     examples sitting in different folders don't trample each other.
function runtimePaths() {
  const cfg = getConfig(loadConfig());

  if (cfg.stateDir) {
    const dir = path.resolve(process.cwd(), cfg.stateDir);
    fs.mkdirSync(dir, { recursive: true });
    return {
      pidFile: path.join(dir, 'orchestrator.pid'),
      logFile: path.join(dir, 'orchestrator.log'),
    };
  }

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
 * Load configuration. An explicit `--config <path>` (or LSS_CONFIG env) wins over
 * the cwd/home search so an isolated instance can point at its own config file.
 * A missing or unparseable explicit file warns and falls back to the search,
 * rather than hard-exiting, so stop/status/logs never orphan a running instance.
 */
function loadConfig() {
  if (EXPLICIT_CONFIG) {
    if (fs.existsSync(EXPLICIT_CONFIG)) {
      try {
        return JSON.parse(fs.readFileSync(EXPLICIT_CONFIG, 'utf-8'));
      } catch (error) {
        console.warn(`⚠️  Failed to parse config file ${EXPLICIT_CONFIG}`);
      }
    } else {
      console.warn(`⚠️  Config file not found: ${EXPLICIT_CONFIG}`);
    }
  }

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
    stateDir: config.stateDir,
    engine: config.engine || 'localstack',
    selfEnginePort: (config.selfEngine && config.selfEngine.port) || 14566,
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

// Resolved once per invocation: an explicit config file from `--config <path>`
// (or the LSS_CONFIG env var), resolved to an absolute path so it's found
// regardless of cwd. Every argument-less loadConfig() call honors it because
// process.argv is fixed for the lifetime of the invocation.
const EXPLICIT_CONFIG = (() => {
  const v = getArgValue('--config') || process.env.LSS_CONFIG;
  return v ? path.resolve(v) : undefined;
})();

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
      if (cfg.engine === 'self') {
        console.log(`🔧 Self Engine: http://localhost:${cfg.selfEnginePort}`);
      } else {
        console.log(`🔧 LocalStack: http://localhost:${cfg.localstackPort}`);
      }
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
  const useSelfEngine = process.argv.includes('--self-engine');

  const engine = useSelfEngine ? 'self' : cfg.engine;
  if (engine === 'self' && (useExternal || usePro || cliToken)) {
    console.error('❌ --self-engine cannot be combined with --external, --pro or --localstack-token (those are LocalStack options).');
    process.exit(1);
  }

  const mode = useExternal ? 'external' : cfg.mode;
  const edition = usePro ? 'pro' : cfg.localstackEdition;
  const authToken = cliToken || cfg.localstackAuthToken || process.env.LOCALSTACK_AUTH_TOKEN;

  // Build environment variables from config
  const env = { ...process.env };
  /* istanbul ignore else: getConfig() always defaults serverPort to 3100, so the else is unreachable */
  if (cfg.serverPort) {
    env.PORT = cfg.serverPort;
  }
  if (enableDynamoProxy) {
    env.LSS_ENABLE_DYNAMO_PROXY = 'true';
  }
  /* istanbul ignore else: getConfig() always defaults dynamoProxyPort to 8000, so the else is unreachable */
  if (cfg.dynamoProxyPort) {
    env.LSS_DYNAMO_PROXY_PORT = cfg.dynamoProxyPort;
  }
  if (engine === 'self') {
    // Self engine: not one LocalStack variable is exported. They would be dead
    // weight in the child's environment, they leak "there is a LocalStack here"
    // into a mode whose whole point is that there isn't, and every key exported
    // this way is reported by GET /api/config as env-overridden — which greys
    // it out in the dashboard's Settings tab for a value the user never set.
    env.LSS_ENGINE = 'self';
  } else {
    /* istanbul ignore else: getConfig() always defaults localstackPort to 4566, so the else is unreachable */
    if (cfg.localstackPort) {
      env.LSS_LOCALSTACK_PORT = cfg.localstackPort;
    }
    /* istanbul ignore else: mode resolves to cfg.mode which getConfig() defaults to 'managed', so the else is unreachable */
    if (mode) {
      env.LSS_LOCALSTACK_MODE = mode;
    }
    /* istanbul ignore else: edition resolves to localstackEdition which getConfig() defaults to 'community', so the else is unreachable */
    if (edition) {
      env.LSS_LOCALSTACK_EDITION = edition;
    }
    /* istanbul ignore else: getConfig() always defaults localstackVersion to 'latest', so the else is unreachable */
    if (cfg.localstackVersion) {
      env.LSS_LOCALSTACK_VERSION = cfg.localstackVersion;
    }
    if (cfg.localstackImage) {
      env.LSS_LOCALSTACK_IMAGE = cfg.localstackImage;
    }
    if (authToken) {
      env.LOCALSTACK_AUTH_TOKEN = authToken;
    }
  }
  // Hand the same config file to the server so its ConfigManager reads the
  // identical serverPort/localstackPort/seedsDir/region/mode (not just the
  // hand-translated subset above). Keeps the two config loaders in agreement.
  if (EXPLICIT_CONFIG) {
    env.LSS_CONFIG_PATH = EXPLICIT_CONFIG;
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
  if (engine === 'self') {
    console.log(`🔧 Self Engine: http://localhost:${cfg.selfEnginePort} (no Docker)`);
  } else {
    console.log(`🔧 LocalStack: http://localhost:${cfg.localstackPort} (mode: ${mode}, edition: ${edition})`);
  }
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

// Poll kill(pid, 0) until the process is gone. SIGTERM alone isn't enough to
// return from `stop`: an immediate `lss start` would race the dying orchestrator
// for the server port and crash with EADDRINUSE.
function waitForExit(pid, timeoutMs = 10000, intervalMs = 200) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    let timer;
    let done = false;
    const finish = (value) => {
      done = true;
      if (timer) clearInterval(timer);
      resolve(value);
    };
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch (e) {
        finish(true);
        return;
      }
      if (Date.now() >= deadline) {
        finish(false);
      }
    };
    // Fast path: the process is often already gone — check synchronously so
    // `stop` resolves without ever scheduling (and leaking) an interval.
    check();
    if (!done) {
      timer = setInterval(check, intervalMs);
    }
  });
}

async function stopOrchestrator() {
  const { pidFile } = runtimePaths();
  if (!fs.existsSync(pidFile)) {
    console.log('⚠️  LSS Orchestrator is not running');
    return;
  }

  const pid = fs.readFileSync(pidFile, 'utf8').trim();

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.error('❌ Failed to stop process:', e.message);
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    return;
  }

  const exited = await waitForExit(pid);
  fs.unlinkSync(pidFile);
  if (exited) {
    console.log('🛑 LSS Orchestrator stopped (PID:', pid + ')');
  } else {
    console.warn(`⚠️  Process ${pid} did not exit within 10s of SIGTERM — the server port may still be busy. Check \`lss status\` before starting again.`);
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

// Produce a usable error string for the user. Errors from the http stack
// occasionally carry an empty `.message` (e.g. socket resets during the
// orchestrator startup window) — fall back through every signal we have so
// `formatError` is guaranteed not to return an empty string.
function formatError(e) {
  if (!e) return 'erro desconhecido (sem detalhes)';
  if (typeof e === 'string') return e.trim() || 'erro desconhecido (sem detalhes)';
  if (e.message && String(e.message).trim()) return String(e.message).trim();
  if (e.code) return `erro de I/O (${e.code})`;
  if (e.name) return e.name;
  const s = String(e);
  return s && s !== '[object Object]' ? s : 'erro desconhecido (sem detalhes)';
}

function buildHttpError(res, data) {
  let parsed;
  try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = null; }
  const fromBody = parsed && (parsed.error || parsed.message);
  if (fromBody && String(fromBody).trim()) return new Error(String(fromBody).trim());
  const snippet = data && data.length < 300 ? data.trim() : '';
  const statusText = res.statusMessage ? `${res.statusCode} ${res.statusMessage}` : `${res.statusCode}`;
  return new Error(snippet ? `HTTP ${statusText}: ${snippet}` : `HTTP ${statusText} (sem corpo de erro)`);
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
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed;
            try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
            resolve(parsed);
          } else {
            reject(buildHttpError(res, data));
          }
        });
      },
    );
    req.on('error', err => reject(err && err.message ? err : new Error(`falha na conexão HTTP com o orchestrator: ${formatError(err)}`)));
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
  let missingTables = 0;
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⚠ ${r.tableName}: skipped (${r.reason})`);
      if (r.reason && r.reason.includes('does not exist in LocalStack')) {
        missingTables++;
      }
    } else {
      console.log(`  ✓ ${r.tableName}: ${r.inserted} item(s) inserted`);
    }
  }
  return { missingTables };
}

// Show the user both sides of the comparison: the seed files we found, and
// the DynamoDB tables actually living in LocalStack. This is the difference
// between "I didn't deploy yet" (no live tables at all) and "my seed file
// name doesn't match the CFN TableName" (live tables exist, just not those).
function printSeedMismatchDiagnostic({ entries, liveTables, focusTable }) {
  const seedNames = entries.map(e => e.tableName);
  const focusList = focusTable ? [focusTable] : seedNames;

  console.log('');
  if (focusTable) {
    console.log(`📂 Arquivo de seed inspecionado: ${focusTable}.json`);
  } else if (focusList.length > 0) {
    console.log('📂 Arquivos de seed inspecionados (tabela esperada):');
    for (const name of focusList) console.log(`     - ${name}`);
  } else {
    console.log('📂 Nenhum arquivo *.json encontrado no seedsDir.');
  }

  if (liveTables && liveTables.length > 0) {
    console.log('');
    console.log(`🗂️  Tabelas vivas no LocalStack (${liveTables.length}):`);
    for (const name of liveTables) console.log(`     - ${name}`);
    console.log('');
    console.log('💡 Os nomes dos arquivos de seed precisam bater EXATAMENTE com o `TableName` no CloudFormation.');
    console.log('   Confira se há prefixo/sufixo divergente entre o arquivo e a tabela.');
  } else {
    console.log('');
    console.log('🗂️  Nenhuma tabela viva no LocalStack ainda.');
    console.log('💡 Provavelmente o stack ainda não foi provisionado. Tente:');
    console.log('     npx lss start                # garante LocalStack rodando');
    console.log('     npx serverless deploy        # cria as tabelas');
    console.log('   E rode `npx lss seed` novamente.');
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
    const { missingTables } = printSeedRunResults(res.results || []);
    if (missingTables > 0) {
      try {
        const list = await getJson('/api/seeds');
        printSeedMismatchDiagnostic({
          entries: (list.entries || []).filter(e => !e.tableExists),
          liveTables: list.liveTables || [],
          focusTable: tableName,
        });
      } catch (diagErr) {
        // Diagnostic is best-effort; don't fail the seed because the hint failed.
        console.log(`(não consegui detalhar tabelas vivas: ${formatError(diagErr)})`);
      }
    }
  } catch (e) {
    console.error('❌ Seed failed:', formatError(e));
    process.exit(1);
  }
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      {
        hostname: 'localhost',
        port: getServerPort(),
        path,
        method: 'GET',
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed;
            try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
            resolve(parsed);
          } else {
            reject(buildHttpError(res, data));
          }
        });
      },
    );
    req.on('error', err => reject(err && err.message ? err : new Error(`falha na conexão HTTP com o orchestrator: ${formatError(err)}`)));
    req.end();
  });
}

function promptConfirmation(expectedWord) {
  return new Promise(resolve => {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`Digite "${expectedWord}" para prosseguir (ou qualquer outra coisa para cancelar): `, answer => {
      rl.close();
      resolve(answer.trim() === expectedWord);
    });
  });
}

async function clearSeed(tableName) {
  ensureRunningOrExit();

  const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');
  const cfg = getConfig(loadConfig());

  // Show the user exactly what's about to be wiped before they confirm.
  // Hitting the orchestrator's GET /api/seeds also implicitly proves we're
  // talking to LocalStack and not AWS — the orchestrator only ever connects
  // to the configured local LocalStack endpoint.
  let scopeDescription;
  try {
    const list = await getJson('/api/seeds');
    const entries = list.entries || [];
    const liveTables = list.liveTables || [];
    const targets = tableName ? entries.filter(e => e.tableName === tableName) : entries;
    const liveTargets = targets.filter(e => e.tableExists);

    if (liveTargets.length === 0) {
      if (tableName) {
        console.log(`⚠️  Nenhuma tabela "${tableName}" existente no LocalStack para limpar.`);
      } else if (entries.length === 0) {
        console.log('⚠️  Nenhum arquivo de seed (*.json) encontrado no seedsDir — nada para limpar.');
      } else {
        console.log(`⚠️  ${entries.length} arquivo(s) de seed encontrados, mas NENHUMA das tabelas correspondentes existe no LocalStack.`);
      }
      printSeedMismatchDiagnostic({ entries, liveTables, focusTable: tableName });
      return;
    }

    scopeDescription = tableName
      ? `a tabela "${tableName}"`
      : `${liveTargets.length} tabela(s): ${liveTargets.map(e => e.tableName).join(', ')}`;

    console.log('');
    console.log('⚠️  ATENÇÃO: operação destrutiva');
    console.log(`   Alvo:      ${scopeDescription}`);
    console.log(`   LocalStack: http://localhost:${cfg.localstackPort}`);
    console.log('   Esta ação NÃO toca em nenhuma conta AWS — apenas o LocalStack acima.');
    console.log('');
  } catch (e) {
    console.error('❌ Não consegui listar as tabelas antes de limpar:', formatError(e));
    process.exit(1);
  }

  if (!skipConfirm) {
    const ok = await promptConfirmation('confirmar');
    if (!ok) {
      console.log('🚫 Cancelado — nenhuma alteração feita.');
      return;
    }
  } else {
    console.log('↳ --yes informado, pulando confirmação interativa.');
  }

  try {
    console.log(tableName ? `🧹 Clearing ${tableName}...` : '🧹 Clearing all seeded tables...');
    const res = await postJson('/api/seeds/clear', tableName ? { tableName } : {});
    printSeedClearResults(res.results || []);
  } catch (e) {
    console.error('❌ Clear failed:', formatError(e));
    process.exit(1);
  }
}

/**
 * `lss mcp` — run the Model Context Protocol server on stdio.
 *
 * Started by an MCP client (Claude Code reads .mcp.json), never by a human at a
 * prompt: stdout is the JSON-RPC frame stream, so nothing else may be written
 * there. This process only talks HTTP to an already-running orchestrator — it
 * never boots one — so `lss start` has to have happened first.
 */
function getMcpServerPath() {
  const candidates = [
    path.join(__dirname, '../dist/mcp/server.js'),
    path.join(__dirname, '..', 'dist', 'mcp', 'server.js'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function getPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function runMcpServer() {
  const serverPath = getMcpServerPath();
  const version = getPackageVersion();
  /* istanbul ignore else: the "found" path falls through to the dynamic import below, which is the process entry point (it binds this process's stdio) and so is not unit-testable */
  if (!serverPath) {
    console.error('❌ MCP server build not found. Run `npm run build` first.');
    process.exit(1); // never returns
  }
  // Dynamic import: the MCP build is ESM, and loading it only for this command
  // keeps every other CLI invocation free of it.
  /* istanbul ignore next: process entry point — loads the ESM build and binds this process's stdio */
  import(pathToFileURL(serverPath).href)
    .then(mod => mod.main(version))
    .catch(error => {
      console.error('❌ Failed to start the MCP server:', error && error.message ? error.message : error);
      process.exit(1);
    });
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
                     tables with a seed file when no arg is given).
                     Pede confirmação interativa (digitar "confirmar")
                     antes de qualquer escrita.
  mcp                Run the Model Context Protocol server on stdio, so an MCP
                     client (Claude Code) can drive this stack with tools.
                     Requires a running orchestrator; see docs/MCP.md.
  help               Show this help message

Options:
  --config <path>              Load config from this file (precedes the cwd/home search).
                               Applies to start/stop/status/logs so an isolated instance
                               can be addressed without cd-ing into its folder.
  --enable-dynamo-proxy        Enable DynamoDB proxy on port 8000 (for start command)
  --self-engine                Use the in-process AWS engine instead of LocalStack (no Docker)
  --external                   Connect to a LocalStack already running, do not spawn a container
  --pro                        Use the LocalStack Pro image (requires LOCALSTACK_AUTH_TOKEN)
  --localstack-token <token>   Pass a LOCALSTACK_AUTH_TOKEN to the container
  --yes, -y                    Skip interactive confirmation on seed:clear (use only in CI)

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
    "debug": false,
    "stateDir": ".lss"
  }

  stateDir (optional): directory for this instance's PID/log files. Set it (e.g.
  ".lss-e2e") together with --config to run a fully isolated instance alongside
  the dev one. When omitted, PID/log live in the OS temp dir scoped by serverPort.

  For the Serverless Plugin, add to serverless.yml:
  custom:
    orchestrator:
      enabled: true
      orchestratorUrl: http://localhost:3100

Examples:
  npx lss start                              # Start the orchestrator (managed LocalStack)
  npx lss start --self-engine                # Use the in-process engine (no Docker, port 14566)
  npx lss start --enable-dynamo-proxy        # Start with DynamoDB proxy enabled
  npx lss start --external                   # Connect to an external LocalStack
  npx lss start --pro                        # Use LocalStack Pro (token required)
  LOCALSTACK_AUTH_TOKEN=xxx npx lss start    # Inject a token via env var
  npx lss stop                               # Stop the orchestrator
  npx lss status                             # Check status
  npx lss logs                               # View logs
  npx lss seed                               # Seed every table that has a {name}.json file
  npx lss seed users                         # Seed only the "users" table
  npx lss seed:clear users                   # Delete all items from "users" (com confirmação)
  npx lss seed:clear users --yes             # Mesma coisa, sem prompt (CI)
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

// First positional arg after the command (e.g. table name for `seed`/`seed:clear`).
// Skip anything that looks like a flag so `seed:clear --yes` doesn't pass
// "--yes" as the table name.
function firstPositional() {
  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

// Exported so the pure/in-process helpers can be unit-tested by requiring this
// module. The command dispatch below only runs when the file is executed
// directly (the `lss` bin), never when required, so requiring it has no side
// effects.
module.exports = {
  loadConfig,
  getConfig,
  getMcpServerPath,
  getPackageVersion,
  runMcpServer,
  getArgValue,
  runtimePaths,
  getOrchestratorPath,
  waitForExit,
  formatError,
  buildHttpError,
  firstPositional,
  getServerPort,
  printSeedRunResults,
  printSeedMismatchDiagnostic,
  printSeedClearResults,
  getJson,
  postJson,
  ensureRunningOrExit,
  promptConfirmation,
  startOrchestrator,
  stopOrchestrator,
  showStatus,
  showLogs,
  runSeed,
  clearSeed,
  showHelp,
};

/* istanbul ignore next: CLI dispatch runs only when executed directly, not when required in tests */
if (require.main === module) {
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
      runSeed(firstPositional());
      break;
    case 'seed:clear':
      clearSeed(firstPositional());
      break;
    case 'mcp':
      runMcpServer();
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
}
