#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
// Every user-facing string goes through t(). The locale is resolved once, at
// require time, from LSS_LANG / LC_ALL / LC_MESSAGES / LANG — English by
// default. See bin/i18n.js for what is deliberately left untranslated.
const { t } = require('./i18n');

// Default paths used when no config is present. The actual paths are derived
// per-invocation by runtimePaths() below, scoped to the configured serverPort
// so multiple examples (each with their own lss.config.json) can run in parallel.
// The dashboard, the REST API and the AWS wire all answer here by default.
const DEFAULT_PORT = 14566;
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
  if (!port || port === DEFAULT_PORT) {
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
        console.warn(t('config.parseFailed', { path: EXPLICIT_CONFIG }));
      }
    } else {
      console.warn(t('config.notFound', { path: EXPLICIT_CONFIG }));
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
        console.warn(t('config.parseFailed', { path: candidate }));
      }
    }
  }

  return {};
}

// Positive integer from an env var, or undefined when unset/garbage — so a
// typo falls back to the file value instead of yielding NaN.
function envPort(name) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Get configuration values with defaults.
 *
 * Applies the same environment overrides the server does. Without this the CLI
 * printed the file's ports while the server bound the env's — and, worse,
 * runtimePaths() derives the PID/log path from serverPort when no stateDir is
 * set, so `LSS_DASHBOARD_PORT=… lss start` followed by `lss stop` addressed two
 * different files. Running a second instance purely from the environment is a
 * documented workflow (docs/CONFIGURATION.md), so it has to agree end to end.
 */
function getConfig(config) {
  return {
    serverPort: envPort('LSS_DASHBOARD_PORT') || envPort('PORT') || config.serverPort || DEFAULT_PORT,
    enableDynamoProxy: process.env.LSS_ENABLE_DYNAMO_PROXY
      ? process.env.LSS_ENABLE_DYNAMO_PROXY === 'true' || process.env.LSS_ENABLE_DYNAMO_PROXY === '1'
      : config.enableDynamoProxy || false,
    dynamoProxyPort: envPort('LSS_DYNAMO_PROXY_PORT') || config.dynamoProxyPort || 8000,
    mode: config.mode || 'managed',
    stateDir: config.stateDir,
    engine: config.engine,
    selfEnginePort: envPort('LSS_ENGINE_PORT') || (config.selfEngine && config.selfEngine.port) || DEFAULT_PORT,
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
  // Before anything else — including the already-running short-circuit — so a
  // stale v1 flag or config value always fails loudly instead of looking like
  // a successful no-op.

  const { pidFile, logFile } = runtimePaths();

  if (fs.existsSync(pidFile)) {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    try {
      process.kill(pid, 0);
      const config = loadConfig();
      const cfg = getConfig(config);
      console.log(t('start.already', { pid }));
      console.log(t('start.server', { url: `http://localhost:${cfg.serverPort}` }));
      console.log(t('start.engine', { url: `http://localhost:${cfg.selfEnginePort}` }));
      if (cfg.enableDynamoProxy) {
        console.log(t('start.dynamoProxy', { url: `http://localhost:${cfg.dynamoProxyPort}` }));
      }
      return;
    } catch (e) {
      fs.unlinkSync(pidFile);
    }
  }

  const orchestratorPath = getOrchestratorPath();
  
  if (!orchestratorPath) {
    console.error(t('start.notBuilt'));
    console.error('');
    console.error(t('start.notBuiltDev'));
    console.error('  cd /path/to/local-serverless-stack && npm run build');
    console.error('');
    console.error(t('start.notBuiltBug'));
    process.exit(1);
  }

  const logFd = fs.openSync(logFile, 'a');
  
  // Load config
  const config = loadConfig();
  const cfg = getConfig(config);
  
  const enableDynamoProxy = process.argv.includes('--enable-dynamo-proxy') || cfg.enableDynamoProxy;

  // Build environment variables from config
  const env = { ...process.env };
  /* istanbul ignore else: getConfig() always defaults serverPort, so the else is unreachable */
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
  // Hand the same config file to the server so its ConfigManager reads the
  // identical serverPort/seedsDir/region (not just the hand-translated subset
  // above). Keeps the two config loaders in agreement.
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

  console.log(t('start.started', { pid: child.pid }));
  console.log(t('start.server', { url: `http://localhost:${cfg.serverPort}` }));
  console.log(t('start.engine', { url: `http://localhost:${cfg.selfEnginePort}` }));
  if (enableDynamoProxy) {
    console.log(t('start.dynamoProxy', { url: `http://localhost:${cfg.dynamoProxyPort}` }));
  }
  console.log(t('start.logs', { path: logFile }));

  setTimeout(() => {
    try {
      process.kill(child.pid, 0);
      console.log(t('start.running'));
    } catch (e) {
      console.error(t('start.failed', { path: logFile }));
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
    console.log(t('stop.notRunning'));
    return;
  }

  const pid = fs.readFileSync(pidFile, 'utf8').trim();

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.error(t('stop.failed', { error: e.message }));
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    return;
  }

  const exited = await waitForExit(pid);
  fs.unlinkSync(pidFile);
  if (exited) {
    console.log(t('stop.stopped', { pid }));
  } else {
    console.warn(t('stop.timeout', { pid }));
  }
}

function showStatus() {
  const { pidFile, logFile } = runtimePaths();
  if (!fs.existsSync(pidFile)) {
    console.log(t('status.notRunning'));
    return;
  }

  const pid = fs.readFileSync(pidFile, 'utf8').trim();

  try {
    process.kill(pid, 0);
    const config = loadConfig();
    const cfg = getConfig(config);
    console.log(t('status.running', { pid }));
    console.log(t('status.server', { url: `http://localhost:${cfg.serverPort}` }));
    console.log(t('status.engine', { url: `http://localhost:${cfg.selfEnginePort}` }));
    if (cfg.enableDynamoProxy) {
      console.log(t('status.dynamoProxy', { url: `http://localhost:${cfg.dynamoProxyPort}` }));
    }
    console.log(t('status.logs', { path: logFile }));
  } catch (e) {
    console.log(t('status.stale'));
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
  if (!e) return t('error.unknown');
  if (typeof e === 'string') return e.trim() || t('error.unknown');
  if (e.message && String(e.message).trim()) return String(e.message).trim();
  if (e.code) return t('error.io', { code: e.code });
  if (e.name) return e.name;
  const s = String(e);
  return s && s !== '[object Object]' ? s : t('error.unknown');
}

function buildHttpError(res, data) {
  let parsed;
  try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = null; }
  const fromBody = parsed && (parsed.error || parsed.message);
  if (fromBody && String(fromBody).trim()) return new Error(String(fromBody).trim());
  const snippet = data && data.length < 300 ? data.trim() : '';
  const statusText = res.statusMessage ? `${res.statusCode} ${res.statusMessage}` : `${res.statusCode}`;
  // `HTTP <status>: <snippet>` is pure wire detail, so only the "no body at
  // all" variant carries translatable prose.
  return new Error(snippet ? `HTTP ${statusText}: ${snippet}` : t('error.httpNoBody', { status: statusText }));
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
    req.on('error', err => reject(err && err.message ? err : new Error(t('error.httpConnection', { error: formatError(err) }))));
    req.write(payload);
    req.end();
  });
}

function ensureRunningOrExit() {
  const { pidFile } = runtimePaths();
  if (!fs.existsSync(pidFile)) {
    console.error(t('error.notRunning'));
    process.exit(1);
  }
}

function printSeedRunResults(results) {
  let missingTables = 0;
  for (const r of results) {
    if (r.skipped) {
      console.log(t('seed.skipped', { table: r.tableName, reason: r.reason }));
      if (r.reason && r.reason.includes('does not exist in the engine')) {
        missingTables++;
      }
    } else {
      console.log(t('seed.inserted', { table: r.tableName, count: r.inserted }));
    }
  }
  return { missingTables };
}

// Show the user both sides of the comparison: the seed files we found, and
// the DynamoDB tables actually living in the engine. This is the difference
// between "I didn't deploy yet" (no live tables at all) and "my seed file
// name doesn't match the CFN TableName" (live tables exist, just not those).
function printSeedMismatchDiagnostic({ entries, liveTables, focusTable }) {
  const seedNames = entries.map(e => e.tableName);
  const focusList = focusTable ? [focusTable] : seedNames;

  console.log('');
  if (focusTable) {
    console.log(t('seed.diagFile', { table: focusTable }));
  } else if (focusList.length > 0) {
    console.log(t('seed.diagFiles'));
    for (const name of focusList) console.log(`     - ${name}`);
  } else {
    console.log(t('seed.diagNoFiles'));
  }

  if (liveTables && liveTables.length > 0) {
    console.log('');
    console.log(t('seed.diagLiveTables', { count: liveTables.length }));
    for (const name of liveTables) console.log(`     - ${name}`);
    console.log('');
    console.log(t('seed.diagMatchHint'));
    console.log(t('seed.diagPrefixHint'));
  } else {
    console.log('');
    console.log(t('seed.diagNoLiveTables'));
    console.log(t('seed.diagNotProvisioned'));
    // The commands themselves are never translated — only the comment that
    // explains what each one buys you.
    console.log(`     npx lss start                # ${t('seed.diagStepStart')}`);
    console.log(`     npx serverless deploy        # ${t('seed.diagStepDeploy')}`);
    console.log(t('seed.diagRetry'));
  }
}

function printSeedClearResults(results) {
  for (const r of results) {
    if (r.skipped) {
      console.log(t('seed.skipped', { table: r.tableName, reason: r.reason }));
    } else {
      console.log(t('seed.deleted', { table: r.tableName, count: r.deleted }));
    }
  }
}

async function runSeed(tableName) {
  ensureRunningOrExit();
  try {
    console.log(tableName ? t('seed.runningTable', { table: tableName }) : t('seed.running'));
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
        console.log(t('seed.diagFailed', { error: formatError(diagErr) }));
      }
    }
  } catch (e) {
    console.error(t('seed.failed'), formatError(e));
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
    req.on('error', err => reject(err && err.message ? err : new Error(t('error.httpConnection', { error: formatError(err) }))));
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
    rl.question(t('seed.confirmPrompt', { word: expectedWord }), answer => {
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
  // talking to the local engine and not AWS — the orchestrator only ever
  // connects to the configured local engine endpoint.
  let scopeDescription;
  try {
    const list = await getJson('/api/seeds');
    const entries = list.entries || [];
    const liveTables = list.liveTables || [];
    const targets = tableName ? entries.filter(e => e.tableName === tableName) : entries;
    const liveTargets = targets.filter(e => e.tableExists);

    if (liveTargets.length === 0) {
      if (tableName) {
        console.log(t('clear.noSuchTable', { table: tableName }));
      } else if (entries.length === 0) {
        console.log(t('clear.noSeedFiles'));
      } else {
        console.log(t('clear.noneLive', { count: entries.length }));
      }
      printSeedMismatchDiagnostic({ entries, liveTables, focusTable: tableName });
      return;
    }

    scopeDescription = tableName
      ? t('clear.scopeTable', { table: tableName })
      : t('clear.scopeTables', {
        count: liveTargets.length,
        tables: liveTargets.map(e => e.tableName).join(', '),
      });

    console.log('');
    console.log(t('clear.warning'));
    console.log(t('clear.target', { scope: scopeDescription }));
    console.log(t('clear.engine', { url: `http://localhost:${cfg.selfEnginePort}` }));
    console.log(t('clear.noAws'));
    console.log('');
  } catch (e) {
    console.error(t('clear.listFailed'), formatError(e));
    process.exit(1);
  }

  if (!skipConfirm) {
    // The word itself is NOT translated: it is a magic token CI scripts and the
    // docs already depend on, so it stays `confirmar` in every locale.
    const ok = await promptConfirmation('confirmar');
    if (!ok) {
      console.log(t('seed.aborted'));
      return;
    }
  } else {
    console.log(t('clear.skipPrompt'));
  }

  try {
    console.log(tableName ? t('seed.clearingTable', { table: tableName }) : t('seed.clearing'));
    const res = await postJson('/api/seeds/clear', tableName ? { tableName } : {});
    printSeedClearResults(res.results || []);
  } catch (e) {
    console.error(t('clear.failed'), formatError(e));
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
/**
 * `lss register [path...]` — register services with the running orchestrator.
 *
 * This replaces the retired serverless-lss plugin: registration is a plain
 * POST of { servicePath }, and the orchestrator resolves everything else
 * (packaging via autoPackage when needed, then name/region/custom.lss ports
 * from the packaged serverless-state.json).
 */
async function registerServices(paths) {
  ensureRunningOrExit();
  const targets = paths.length > 0 ? paths : ['.'];
  let failed = 0;
  for (const target of targets) {
    const servicePath = path.resolve(target);
    if (!fs.existsSync(servicePath)) {
      console.error(t('register.notFound', { target }));
      failed++;
      continue;
    }
    try {
      const result = await postJson('/api/services/register', { servicePath });
      console.log(t('register.ok', {
        name: result.serviceName,
        resources: result.resourcesCount,
        functions: result.functionsCount,
        routes: result.routesCount,
      }));
      // Warnings come from the orchestrator already worded; only the bullet is ours.
      for (const warning of result.warnings || []) {
        console.log(`  ⚠ ${warning}`);
      }
    } catch (e) {
      console.error(t('register.failed', { target, error: formatError(e) }));
      failed++;
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
}

/**
 * `lss scan` — list every Serverless/osls service found under the project
 * root, with the same flags onboarding shows.
 *
 * The three flags mirror the checklist: `registered` (known to this
 * orchestrator), `installed` (node_modules resolvable, so packaging can run
 * without an install first) and `packaged` (a template already exists). The
 * effective package command gets its own line because it is per-service
 * configurable (`servicePackaging`) and is what the install→package→register
 * buttons would run.
 */
/**
 * Render one scan warning. The orchestrator sends a stable `code` plus the
 * English `message` it produced; the code is what gets localised, and the
 * message is the fallback for a code this CLI has not been taught yet — a
 * newer server's warning still prints instead of disappearing.
 */
function scanWarningText(warning) {
  if (!warning || typeof warning !== 'object') return String(warning);
  const key = `scan.warning.${warning.code}`;
  const translated = t(key, warning.params);
  return translated === key ? warning.message : translated;
}

async function scanServices() {
  ensureRunningOrExit();
  try {
    const result = await getJson('/api/services/scan');
    const services = result.services || [];
    if (services.length === 0) {
      console.log(t('scan.none', { root: result.projectRoot }));
      return;
    }
    console.log(`${t('scan.header', { count: services.length, root: result.projectRoot })}\n`);
    for (const svc of services) {
      const flags = [
        svc.registered ? t('scan.registered') : t('scan.notRegistered'),
        svc.installed ? t('scan.installed') : t('scan.notInstalled'),
        svc.packaged ? t('scan.packaged') : t('scan.notPackaged'),
      ].join(', ');
      const ports = svc.apiPort ? ` api:${svc.apiPort}${svc.invokePort ? ` invoke:${svc.invokePort}` : ''}` : '';
      console.log(`  ${svc.registered ? '✓' : '·'} ${svc.name}  (${svc.relPath}) — ${flags}${ports}`);
      if (svc.packageCommand) {
        console.log(`      ${t('scan.packageCommand', { command: svc.packageCommand })}`);
      }
      for (const warning of svc.warnings || []) {
        console.log(`      ⚠ ${scanWarningText(warning)}`);
      }
    }
    console.log(t('scan.hint'));
  } catch (e) {
    console.error(t('scan.failed'), formatError(e));
    process.exit(1);
  }
}

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
    console.error(t('mcp.missing'));
    process.exit(1); // never returns
  }
  // Dynamic import: the MCP build is ESM, and loading it only for this command
  // keeps every other CLI invocation free of it.
  /* istanbul ignore next: process entry point — loads the ESM build and binds this process's stdio */
  import(pathToFileURL(serverPath).href)
    .then(mod => mod.main(version))
    .catch(error => {
      console.error(t('mcp.startFailed'), error && error.message ? error.message : error);
      process.exit(1);
    });
}

// One `  <name>   <description>` row of the help screen. The description is
// wrapped and hanging-indented under itself so a translation can be longer than
// the English original without shredding the column — the reason the help text
// is assembled here instead of living in the catalogue as one pre-formatted blob.
function helpRow(name, description, nameWidth, textWidth) {
  const gutter = ' '.repeat(2 + nameWidth);
  const wrapped = [];
  let current = '';
  for (const word of description.split(' ')) {
    if (current && current.length + 1 + word.length > textWidth) {
      wrapped.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  wrapped.push(current);
  return [`  ${name.padEnd(nameWidth)}${wrapped[0]}`, ...wrapped.slice(1).map(line => gutter + line)]
    .join('\n');
}

// A `  npx lss …   # what it does` example line. The command is never translated.
function helpExample(command, comment) {
  return `  ${command.padEnd(43)}# ${comment}`;
}

function showHelp() {
  // Command names, flags, env var names, paths and the JSON template are
  // identifiers — they stay here, untranslated. Only prose goes through t().
  const cmd = (name, key) => helpRow(name, t(key), 19, 56);
  const opt = (name, key) => helpRow(name, t(key), 29, 46);

  console.log([
    '',
    'Local Serverless Stack (LSS) CLI',
    '',
    t('help.usage'),
    '',
    t('help.commands'),
    cmd('start', 'help.cmd.start'),
    cmd('stop', 'help.cmd.stop'),
    cmd('status', 'help.cmd.status'),
    cmd('logs', 'help.cmd.logs'),
    cmd('seed [table]', 'help.cmd.seed'),
    cmd('scan', 'help.cmd.scan'),
    cmd('register [path...]', 'help.cmd.register'),
    cmd('seed:clear [table]', 'help.cmd.seedClear'),
    cmd('mcp', 'help.cmd.mcp'),
    cmd('help', 'help.cmd.help'),
    '',
    t('help.options'),
    opt('--config <path>', 'help.opt.config'),
    opt('--enable-dynamo-proxy', 'help.opt.dynamoProxy'),
    opt('--yes, -y', 'help.opt.yes'),
    '',
    t('help.environment'),
    opt('LSS_DASHBOARD_PORT', 'help.env.dashboardPort'),
    opt('LSS_ENGINE_PORT', 'help.env.enginePort'),
    opt('LSS_ENGINE_DATA_DIR', 'help.env.engineDataDir'),
    opt('AWS_REGION', 'help.env.awsRegion'),
    opt('LSS_LANG', 'help.env.lang'),
    '',
    t('help.configuration'),
    `  ${t('help.config.intro')}`,
    '',
    `  ${t('help.config.example')}`,
    '  {',
    '    "serverPort": 3100,',
    '    "selfEngine": { "port": 14566 },',
    '    "enableDynamoProxy": false,',
    '    "dynamoProxyPort": 8000,',
    '    "region": "us-east-1",',
    '    "persistence": true,',
    '    "debug": false,',
    '    "stateDir": ".lss"',
    '  }',
    '',
    helpRow('', t('help.config.stateDir'), 0, 76),
    '',
    t('help.examples'),
    helpExample('npx lss start', t('help.ex.start')),
    helpExample('npx lss start --enable-dynamo-proxy', t('help.ex.startProxy')),
    helpExample('npx lss mcp', t('help.ex.mcp')),
    helpExample('npx lss stop', t('help.ex.stop')),
    helpExample('npx lss status', t('help.ex.status')),
    helpExample('npx lss logs', t('help.ex.logs')),
    helpExample('npx lss scan', t('help.ex.scan')),
    helpExample('npx lss register', t('help.ex.register')),
    helpExample('npx lss seed', t('help.ex.seed')),
    helpExample('npx lss seed users', t('help.ex.seedTable')),
    helpExample('npx lss seed:clear users', t('help.ex.seedClear')),
    helpExample('npx lss seed:clear users --yes', t('help.ex.seedClearYes')),
    '',
  ].join('\n'));
}

function showLogs() {
  const { logFile } = runtimePaths();
  if (!fs.existsSync(logFile)) {
    console.log(t('logs.missing', { path: logFile }));
    return;
  }

  console.log(t('logs.from', { path: logFile }));
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
  return allPositionals()[0];
}

// Every non-flag argument after the command, skipping flag VALUES too
// (`--config <path>` consumes the next token).
function allPositionals() {
  const flagsWithValue = new Set(['--config']);
  const out = [];
  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('-')) {
      if (flagsWithValue.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

// Exported so the pure/in-process helpers can be unit-tested by requiring this
// module. The command dispatch below only runs when the file is executed
// directly (the `lss` bin), never when required, so requiring it has no side
// effects.
module.exports = {
  loadConfig,
  getConfig,
  allPositionals,
  registerServices,
  scanServices,
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
    case 'register':
      registerServices(allPositionals());
      break;
    case 'scan':
      scanServices();
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
      console.log(t('help.unknown', { command }));
      showHelp();
      process.exit(1);
  }
}
