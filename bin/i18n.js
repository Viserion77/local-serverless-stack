// CLI internationalisation — English, Brazilian Portuguese and Spanish.
//
// Hand-rolled and dependency-free, like the dashboard's (src/ui/src/i18n): the
// CLI is a plain CommonJS file with no build step, and a translation layer is
// not worth an npm dependency every user installs.
//
// Locale resolution, most specific first:
//   LSS_LANG  — explicit opt-in, the one a script should set
//   LC_ALL / LC_MESSAGES / LANG — the POSIX chain the shell already exports
// Anything unrecognised falls back to English rather than guessing.

const LOCALES = ['en', 'pt-BR', 'es'];
const DEFAULT_LOCALE = 'en';

/** Best match for a locale-ish tag: exact, then the language subtag. */
function matchLocale(tag) {
  if (!tag) return null;
  // Strip the POSIX charset/modifier suffix: `pt_BR.UTF-8@euro` → `pt_BR`.
  const cleaned = String(tag).split('.')[0].split('@')[0];
  if (LOCALES.includes(cleaned)) return cleaned;
  const language = cleaned.split(/[-_]/)[0].toLowerCase();
  if (language === 'pt') return 'pt-BR';
  if (language === 'es') return 'es';
  if (language === 'en') return 'en';
  return null;
}

function detectLocale(env = process.env) {
  for (const name of ['LSS_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const matched = matchLocale(env[name]);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}

const MESSAGES = {
  en: {
    // --- lifecycle ---------------------------------------------------------
    'start.already': '⚠️  LSS Orchestrator is already running (PID: {pid})',
    'start.starting': '🚀 Starting LSS Orchestrator...',
    'start.started': '🚀 LSS Orchestrator started (PID: {pid})',
    'start.server': '📊 Server: {url}',
    'start.engine': '🔧 Self Engine: {url} (no Docker)',
    'start.dynamoProxy': '🔌 DynamoDB Proxy: {url}',
    'start.logs': '📝 Logs: {path}',
    'start.running': '✅ Service is running',
    'start.failed': '❌ Service failed to start. Check logs: {path}',
    'stop.notRunning': '⚠️  LSS Orchestrator is not running',
    'stop.stopped': '🛑 LSS Orchestrator stopped (PID: {pid})',
    'stop.failed': '❌ Failed to stop the orchestrator: {error}',
    'status.running': '🟢 LSS Orchestrator: RUNNING (PID: {pid})',
    'status.notRunning': '⚪ LSS Orchestrator: NOT RUNNING',
    'status.server': '   Server: {url}',
    'status.logs': '   Logs: {path}',
    'logs.missing': '⚠️  No log file at {path}',
    'error.notRunning': '❌ LSS Orchestrator is not running. Start it with: npx lss start',

    // --- register / scan ---------------------------------------------------
    'register.notFound': '✗ {target}: directory not found',
    'register.ok': '✓ {name}: {resources} resource(s), {functions} function(s), {routes} route(s)',
    'register.failed': '✗ {target}: {error}',
    'scan.none': 'No Serverless/osls services found under {root}',
    'scan.header': '{count} service(s) under {root}:',
    'scan.registered': 'registered',
    'scan.notRegistered': 'not registered',
    'scan.installed': 'installed',
    'scan.notInstalled': 'not installed',
    'scan.packaged': 'packaged',
    'scan.notPackaged': 'not packaged',
    'scan.packageCommand': 'package: {command}',
    'scan.hint': '\nRegister with: npx lss register <path...>  (or through the dashboard onboarding)',
    'scan.failed': '❌ Scan failed:',

    // --- seeds -------------------------------------------------------------
    'seed.confirmPrompt': 'Type "{word}" to continue: ',
    'seed.aborted': 'Aborted.',
    'seed.clearing': '🧹 Clearing seeded tables…',
    'seed.running': '🌱 Applying seeds…',

    // --- misc --------------------------------------------------------------
    'mcp.missing': '❌ MCP server build not found. Run `npm run build` first.',
    'help.unknown': 'Unknown command: {command}',
  },

  'pt-BR': {
    'start.already': '⚠️  O orquestrador LSS já está rodando (PID: {pid})',
    'start.starting': '🚀 Iniciando o orquestrador LSS...',
    'start.started': '🚀 Orquestrador LSS iniciado (PID: {pid})',
    'start.server': '📊 Servidor: {url}',
    'start.engine': '🔧 Self Engine: {url} (sem Docker)',
    'start.dynamoProxy': '🔌 Proxy DynamoDB: {url}',
    'start.logs': '📝 Logs: {path}',
    'start.running': '✅ Serviço no ar',
    'start.failed': '❌ O serviço não subiu. Veja os logs: {path}',
    'stop.notRunning': '⚠️  O orquestrador LSS não está rodando',
    'stop.stopped': '🛑 Orquestrador LSS parado (PID: {pid})',
    'stop.failed': '❌ Não foi possível parar o orquestrador: {error}',
    'status.running': '🟢 Orquestrador LSS: NO AR (PID: {pid})',
    'status.notRunning': '⚪ Orquestrador LSS: FORA DO AR',
    'status.server': '   Servidor: {url}',
    'status.logs': '   Logs: {path}',
    'logs.missing': '⚠️  Nenhum arquivo de log em {path}',
    'error.notRunning': '❌ O orquestrador LSS não está rodando. Suba com: npx lss start',

    'register.notFound': '✗ {target}: diretório não encontrado',
    'register.ok': '✓ {name}: {resources} recurso(s), {functions} função(ões), {routes} rota(s)',
    'register.failed': '✗ {target}: {error}',
    'scan.none': 'Nenhum serviço Serverless/osls encontrado sob {root}',
    'scan.header': '{count} serviço(s) sob {root}:',
    'scan.registered': 'registrado',
    'scan.notRegistered': 'não registrado',
    'scan.installed': 'instalado',
    'scan.notInstalled': 'não instalado',
    'scan.packaged': 'empacotado',
    'scan.notPackaged': 'não empacotado',
    'scan.packageCommand': 'package: {command}',
    'scan.hint': '\nRegistre com: npx lss register <path...>  (ou pelo onboarding do dashboard)',
    'scan.failed': '❌ O scan falhou:',

    'seed.confirmPrompt': 'Digite "{word}" para continuar: ',
    'seed.aborted': 'Cancelado.',
    'seed.clearing': '🧹 Limpando as tabelas semeadas…',
    'seed.running': '🌱 Aplicando os seeds…',

    'mcp.missing': '❌ Build do servidor MCP não encontrado. Rode `npm run build` antes.',
    'help.unknown': 'Comando desconhecido: {command}',
  },

  es: {
    'start.already': '⚠️  El orquestador LSS ya está en marcha (PID: {pid})',
    'start.starting': '🚀 Iniciando el orquestador LSS...',
    'start.started': '🚀 Orquestador LSS iniciado (PID: {pid})',
    'start.server': '📊 Servidor: {url}',
    'start.engine': '🔧 Self Engine: {url} (sin Docker)',
    'start.dynamoProxy': '🔌 Proxy de DynamoDB: {url}',
    'start.logs': '📝 Registros: {path}',
    'start.running': '✅ El servicio está en marcha',
    'start.failed': '❌ El servicio no arrancó. Revisa los registros: {path}',
    'stop.notRunning': '⚠️  El orquestador LSS no está en marcha',
    'stop.stopped': '🛑 Orquestador LSS detenido (PID: {pid})',
    'stop.failed': '❌ No se pudo detener el orquestador: {error}',
    'status.running': '🟢 Orquestador LSS: EN MARCHA (PID: {pid})',
    'status.notRunning': '⚪ Orquestador LSS: DETENIDO',
    'status.server': '   Servidor: {url}',
    'status.logs': '   Registros: {path}',
    'logs.missing': '⚠️  No hay archivo de registro en {path}',
    'error.notRunning': '❌ El orquestador LSS no está en marcha. Inícialo con: npx lss start',

    'register.notFound': '✗ {target}: directorio no encontrado',
    'register.ok': '✓ {name}: {resources} recurso(s), {functions} función(es), {routes} ruta(s)',
    'register.failed': '✗ {target}: {error}',
    'scan.none': 'No se encontraron servicios Serverless/osls en {root}',
    'scan.header': '{count} servicio(s) en {root}:',
    'scan.registered': 'registrado',
    'scan.notRegistered': 'sin registrar',
    'scan.installed': 'instalado',
    'scan.notInstalled': 'sin instalar',
    'scan.packaged': 'empaquetado',
    'scan.notPackaged': 'sin empaquetar',
    'scan.packageCommand': 'package: {command}',
    'scan.hint': '\nRegístralos con: npx lss register <path...>  (o desde el onboarding del panel)',
    'scan.failed': '❌ El escaneo falló:',

    'seed.confirmPrompt': 'Escribe "{word}" para continuar: ',
    'seed.aborted': 'Cancelado.',
    'seed.clearing': '🧹 Vaciando las tablas sembradas…',
    'seed.running': '🌱 Aplicando los seeds…',

    'mcp.missing': '❌ No se encontró el build del servidor MCP. Ejecuta `npm run build` primero.',
    'help.unknown': 'Comando desconocido: {command}',
  },
};

let locale = detectLocale();

function setLocale(next) {
  locale = LOCALES.includes(next) ? next : DEFAULT_LOCALE;
  return locale;
}

function getLocale() {
  return locale;
}

/**
 * Translate `key`, interpolating `{placeholder}` params. A missing key falls
 * back to English and then to the key itself — an untranslated line must still
 * tell the operator something, and a visible `scan.header` is a better bug
 * report than a blank line.
 */
function t(key, params) {
  const template = MESSAGES[locale][key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    (name in params ? String(params[name]) : match));
}

module.exports = { LOCALES, DEFAULT_LOCALE, matchLocale, detectLocale, setLocale, getLocale, t, MESSAGES };
