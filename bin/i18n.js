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
//
// What is deliberately NOT translated, in any catalogue: AWS proper nouns
// (DynamoDB, SQS, Lambda, CloudFormation, TableName…), command names (`start`,
// `seed:clear`, `scan`…), flags (`--config`, `--yes`), config keys
// (`lss.config.json`, `seedsDir`, `serverPort`, `selfEngine.port`), file paths,
// URLs and the `confirmar` word `seed:clear` asks the operator to type — that
// one is a magic token CI scripts and docs already depend on.

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
    'scan.warning.not-installed': 'dependencies not installed — packaging needs an install first',
    // Two codes for one fact, because the fact depends on `autoPackage`: the
    // single string that promised packaging was read as a promise by operators
    // whose config had it off, and registering answered 400 instead.
    'scan.warning.not-packaged': 'not packaged yet — registering packages it for you (autoPackage)',
    'scan.warning.not-packaged-manual': 'not packaged yet — autoPackage is off, so run `serverless package` before registering',
    'scan.warning.ts-config': 'TypeScript service config — name, region and ports resolve at packaging time',
    'scan.warning.unreadable-config': 'could not read {file}',
    'scan.warning.invalid-json': 'serverless.json is not valid JSON',
    // --- config discovery --------------------------------------------------
    'config.parseFailed': '⚠️  Failed to parse config file {path}',
    'config.notFound': '⚠️  Config file not found: {path}',

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
    'start.waiting': '⏳ Waiting for the orchestrator to answer (up to {seconds}s)...',
    'start.waitTimeout': '❌ The orchestrator did not answer within {seconds}s',
    'start.logTail': '--- last lines of the log ---',
    'start.notBuilt': '❌ Orchestrator not found or not built.',
    'start.notBuiltDev': 'If you are developing LSS, run:',
    'start.notBuiltBug': 'If you installed via npm, please report this as a bug.',
    'stop.notRunning': '⚠️  LSS Orchestrator is not running',
    'stop.stopped': '🛑 LSS Orchestrator stopped (PID: {pid})',
    'stop.failed': '❌ Failed to stop the orchestrator: {error}',
    'stop.timeout': '⚠️  Process {pid} did not exit within 10s of SIGTERM — the server port may still be busy. Check `lss status` before starting again.',
    'status.running': '🟢 LSS Orchestrator: RUNNING (PID: {pid})',
    'status.notRunning': '⚪ LSS Orchestrator: NOT RUNNING',
    'status.stale': '⚪ LSS Orchestrator: NOT RUNNING (stale PID file)',
    'status.server': '   Server: {url}',
    'status.engine': '   Self Engine: {url}',
    'status.dynamoProxy': '   DynamoDB Proxy: {url}',
    'status.logs': '   Logs: {path}',
    // A port answering from another checkout is the routine outcome under
    // `--net=host`, and reporting it as NOT RUNNING sent people looking in the
    // wrong place. `projectRoot` comes from GET /api/config on that port.
    'status.portOwnedByOther': '🔶 Port {port} is in use by the orchestrator of {root}',
    'status.portAnsweringHere': '🔶 Port {port} answers for this project, but no PID file is registered here (started from another shell?)',
    'logs.missing': '⚠️  No log file at {path}',
    'logs.from': '📝 Logs from: {path}',


    // --- errors ------------------------------------------------------------
    'error.notRunning': '❌ LSS Orchestrator is not running. Start it with: npx lss start',
    'error.unknown': 'unknown error (no details)',
    'error.io': 'I/O error ({code})',
    'error.httpNoBody': 'HTTP {status} (no error body)',
    'error.httpConnection': 'HTTP connection to the orchestrator failed: {error}',

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
    'seed.clearingTable': '🧹 Clearing {table}…',
    'seed.running': '🌱 Applying seeds…',
    'seed.runningTable': '🌱 Seeding {table}…',
    'seed.inserted': '  ✓ {table}: {count} item(s) inserted',
    'seed.deleted': '  ✓ {table}: {count} item(s) deleted',
    'seed.skipped': '  ⚠ {table}: skipped ({reason})',
    'seed.failed': '❌ Seed failed:',

    // Both sides of the "why did nothing get seeded?" comparison: the seed
    // files we found, and the tables actually living in the engine.
    'seed.diagFile': '📂 Seed file inspected: {table}.json',
    'seed.diagFiles': '📂 Seed files inspected (expected table):',
    'seed.diagNoFiles': '📂 No *.json file found in seedsDir.',
    'seed.diagLiveTables': '🗂️  Live tables in the engine ({count}):',
    'seed.diagMatchHint': '💡 Seed file names must match the `TableName` in CloudFormation EXACTLY.',
    'seed.diagPrefixHint': '   Check whether the file and the table disagree on a prefix/suffix.',
    'seed.diagNoLiveTables': '🗂️  No live tables in the engine yet.',
    'seed.diagNotProvisioned': '💡 The stack has probably not been provisioned yet. Try:',
    'seed.diagStepStart': 'makes sure the orchestrator is running',
    'seed.diagStepDeploy': 'creates the tables',
    'seed.diagRetry': '   Then run `npx lss seed` again.',
    'seed.diagFailed': '(could not detail the live tables: {error})',

    // --- seed:clear (destructive, so it explains itself first) -------------
    'clear.noSuchTable': '⚠️  No table "{table}" exists in the engine to clear.',
    'clear.noSeedFiles': '⚠️  No seed file (*.json) found in seedsDir — nothing to clear.',
    'clear.noneLive': '⚠️  {count} seed file(s) found, but NONE of the matching tables exist in the engine.',
    'clear.warning': '⚠️  WARNING: destructive operation',
    'clear.target': '   Target:    {scope}',
    'clear.engine': '   Engine:    {url}',
    'clear.noAws': '   This action does NOT touch any AWS account — only the local engine above.',
    'clear.scopeTable': 'the "{table}" table',
    'clear.scopeTables': '{count} table(s): {tables}',
    'clear.skipPrompt': '↳ --yes given, skipping the interactive confirmation.',
    'clear.listFailed': '❌ Could not list the tables before clearing:',
    'clear.failed': '❌ Clear failed:',

    // --- mcp ---------------------------------------------------------------
    'mcp.missing': '❌ MCP server build not found. Run `npm run build` first.',
    'mcp.startFailed': '❌ Failed to start the MCP server:',

    // --- help --------------------------------------------------------------
    // Only the prose lives here: the layout, command names, flags, env var
    // names and the JSON template stay in showHelp().
    'help.unknown': 'Unknown command: {command}',
    'help.usage': 'Usage: npx lss <command> [options]',
    'help.commands': 'Commands:',
    'help.options': 'Options:',
    'help.environment': 'Environment:',
    'help.configuration': 'Configuration:',
    'help.examples': 'Examples:',
    'help.cmd.start': 'Start the LSS Orchestrator in the background',
    'help.cmd.stop': 'Stop the LSS Orchestrator',
    'help.cmd.status': 'Check whether the orchestrator is running',
    'help.cmd.logs': 'Show the logs',
    'help.cmd.seed': 'Apply seed file(s) from seedsDir into DynamoDB (no argument = every matching table)',
    'help.cmd.scan': 'List every Serverless/osls service found under the project root (registered/installed/packaged flags, ports and package command)',
    'help.cmd.register': 'Register services with the running orchestrator (defaults to the current directory; packaging runs on demand via autoPackage)',
    'help.cmd.seedClear': 'Delete every item from the given table (or from every table that has a seed file). Asks for interactive confirmation (type "confirmar") before any write.',
    'help.cmd.mcp': 'Run the Model Context Protocol server on stdio, so an MCP client can drive this stack with tools. Requires a running orchestrator; see docs/MCP.md.',
    'help.cmd.help': 'Show this help message',
    'help.opt.config': 'Load config from this file (precedes the cwd/home search). Applies to start/stop/status/logs, so an isolated instance can be addressed without cd-ing into its folder.',
    'help.opt.dynamoProxy': 'Enable the DynamoDB proxy on port 8000 (for the start command)',
    'help.opt.wait': 'On start, block until the orchestrator answers GET /api/health (default 30s) and exit non-zero — with the log tail — if it never does. What a sequential chain needs so the next step is not run against a stack that is not up.',
    'help.opt.yes': 'Skip the interactive confirmation on seed:clear (use only in CI)',
    'help.env.dashboardPort': 'Orchestrator port (overrides serverPort)',
    'help.env.enginePort': 'Self engine port (overrides selfEngine.port)',
    'help.env.engineDataDir': 'Self engine state directory (overrides selfEngine.dataDir)',
    'help.env.awsRegion': 'Default region for provisioning and the explorers',
    'help.env.lang': 'CLI language: en, pt-BR or es (falls back to LC_ALL/LC_MESSAGES/LANG)',
    'help.config.intro': 'Create a lss.config.json or .lssrc file in your project root to customize:',
    'help.config.example': 'Example lss.config.json:',
    'help.config.stateDir': 'stateDir (optional): directory for this instance\'s PID/log files. Set it (e.g. ".lss-e2e") together with --config to run a fully isolated instance alongside the dev one. When omitted, PID/log live in the OS temp dir scoped by serverPort.',
    'help.ex.start': 'Start the orchestrator + self engine (no Docker)',
    'help.ex.startProxy': 'Start with the DynamoDB proxy enabled',
    'help.ex.mcp': 'Serve MCP tools to an AI agent on stdio',
    'help.ex.stop': 'Stop the orchestrator',
    'help.ex.status': 'Check the status',
    'help.ex.logs': 'View the logs',
    'help.ex.scan': 'List the services found under the project root',
    'help.ex.register': 'Register the service in the current directory',
    'help.ex.seed': 'Seed every table that has a <table>.json file',
    'help.ex.seedTable': 'Seed only the "users" table',
    'help.ex.seedClear': 'Delete every item from "users" (with confirmation)',
    'help.ex.seedClearYes': 'Same thing, without the prompt (CI)',
  },

  'pt-BR': {
    'scan.warning.not-installed': 'dependências não instaladas — empacotar exige instalar antes',
    'scan.warning.not-packaged': 'ainda não empacotado — registrar empacota para você (autoPackage)',
    'scan.warning.not-packaged-manual': 'ainda não empacotado — autoPackage está desligado, rode `serverless package` antes de registrar',
    'scan.warning.ts-config': 'config em TypeScript — nome, região e portas só resolvem no empacotamento',
    'scan.warning.unreadable-config': 'não consegui ler {file}',
    'scan.warning.invalid-json': 'serverless.json não é um JSON válido',
    'config.parseFailed': '⚠️  Não consegui ler o arquivo de config {path}',
    'config.notFound': '⚠️  Arquivo de config não encontrado: {path}',

    'start.already': '⚠️  O orquestrador LSS já está rodando (PID: {pid})',
    'start.starting': '🚀 Iniciando o orquestrador LSS...',
    'start.started': '🚀 Orquestrador LSS iniciado (PID: {pid})',
    'start.server': '📊 Servidor: {url}',
    'start.engine': '🔧 Self Engine: {url} (sem Docker)',
    'start.dynamoProxy': '🔌 Proxy DynamoDB: {url}',
    'start.logs': '📝 Logs: {path}',
    'start.running': '✅ Serviço no ar',
    'start.failed': '❌ O serviço não subiu. Veja os logs: {path}',
    'start.waiting': '⏳ Esperando o orquestrador responder (até {seconds}s)...',
    'start.waitTimeout': '❌ O orquestrador não respondeu em {seconds}s',
    'start.logTail': '--- últimas linhas do log ---',
    'start.notBuilt': '❌ Orquestrador não encontrado ou sem build.',
    'start.notBuiltDev': 'Se você está desenvolvendo o LSS, rode:',
    'start.notBuiltBug': 'Se você instalou via npm, por favor abra um bug.',
    'stop.notRunning': '⚠️  O orquestrador LSS não está rodando',
    'stop.stopped': '🛑 Orquestrador LSS parado (PID: {pid})',
    'stop.failed': '❌ Não foi possível parar o orquestrador: {error}',
    'stop.timeout': '⚠️  O processo {pid} não saiu em 10s depois do SIGTERM — a porta do servidor pode continuar ocupada. Confira `lss status` antes de subir de novo.',
    'status.running': '🟢 Orquestrador LSS: NO AR (PID: {pid})',
    'status.notRunning': '⚪ Orquestrador LSS: FORA DO AR',
    'status.stale': '⚪ Orquestrador LSS: FORA DO AR (arquivo de PID órfão)',
    'status.server': '   Servidor: {url}',
    'status.engine': '   Self Engine: {url}',
    'status.dynamoProxy': '   Proxy DynamoDB: {url}',
    'status.logs': '   Logs: {path}',
    'status.portOwnedByOther': '🔶 A porta {port} está em uso pelo orquestrador de {root}',
    'status.portAnsweringHere': '🔶 A porta {port} responde por este projeto, mas não há arquivo de PID registrado aqui (subiu de outro shell?)',
    'logs.missing': '⚠️  Nenhum arquivo de log em {path}',
    'logs.from': '📝 Logs de: {path}',


    'error.notRunning': '❌ O orquestrador LSS não está rodando. Suba com: npx lss start',
    'error.unknown': 'erro desconhecido (sem detalhes)',
    'error.io': 'erro de I/O ({code})',
    'error.httpNoBody': 'HTTP {status} (sem corpo de erro)',
    'error.httpConnection': 'falha na conexão HTTP com o orquestrador: {error}',

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
    'seed.clearingTable': '🧹 Limpando {table}…',
    'seed.running': '🌱 Aplicando os seeds…',
    'seed.runningTable': '🌱 Semeando {table}…',
    'seed.inserted': '  ✓ {table}: {count} item(ns) inserido(s)',
    'seed.deleted': '  ✓ {table}: {count} item(ns) removido(s)',
    'seed.skipped': '  ⚠ {table}: pulada ({reason})',
    'seed.failed': '❌ O seed falhou:',

    'seed.diagFile': '📂 Arquivo de seed inspecionado: {table}.json',
    'seed.diagFiles': '📂 Arquivos de seed inspecionados (tabela esperada):',
    'seed.diagNoFiles': '📂 Nenhum arquivo *.json encontrado no seedsDir.',
    'seed.diagLiveTables': '🗂️  Tabelas vivas no engine ({count}):',
    'seed.diagMatchHint': '💡 Os nomes dos arquivos de seed precisam bater EXATAMENTE com o `TableName` no CloudFormation.',
    'seed.diagPrefixHint': '   Confira se há prefixo/sufixo divergente entre o arquivo e a tabela.',
    'seed.diagNoLiveTables': '🗂️  Nenhuma tabela viva no engine ainda.',
    'seed.diagNotProvisioned': '💡 Provavelmente o stack ainda não foi provisionado. Tente:',
    'seed.diagStepStart': 'garante o orquestrador rodando',
    'seed.diagStepDeploy': 'cria as tabelas',
    'seed.diagRetry': '   E rode `npx lss seed` de novo.',
    'seed.diagFailed': '(não consegui detalhar as tabelas vivas: {error})',

    'clear.noSuchTable': '⚠️  Nenhuma tabela "{table}" existe no engine para limpar.',
    'clear.noSeedFiles': '⚠️  Nenhum arquivo de seed (*.json) encontrado no seedsDir — nada para limpar.',
    'clear.noneLive': '⚠️  {count} arquivo(s) de seed encontrado(s), mas NENHUMA das tabelas correspondentes existe no engine.',
    'clear.warning': '⚠️  ATENÇÃO: operação destrutiva',
    'clear.target': '   Alvo:      {scope}',
    'clear.engine': '   Engine:    {url}',
    'clear.noAws': '   Esta ação NÃO toca em nenhuma conta AWS — apenas o engine local acima.',
    'clear.scopeTable': 'a tabela "{table}"',
    'clear.scopeTables': '{count} tabela(s): {tables}',
    'clear.skipPrompt': '↳ --yes informado, pulando a confirmação interativa.',
    'clear.listFailed': '❌ Não consegui listar as tabelas antes de limpar:',
    'clear.failed': '❌ A limpeza falhou:',

    'mcp.missing': '❌ Build do servidor MCP não encontrado. Rode `npm run build` antes.',
    'mcp.startFailed': '❌ Não consegui subir o servidor MCP:',

    'help.unknown': 'Comando desconhecido: {command}',
    'help.usage': 'Uso: npx lss <command> [options]',
    'help.commands': 'Comandos:',
    'help.options': 'Opções:',
    'help.environment': 'Ambiente:',
    'help.configuration': 'Configuração:',
    'help.examples': 'Exemplos:',
    'help.cmd.start': 'Sobe o orquestrador LSS em background',
    'help.cmd.stop': 'Para o orquestrador LSS',
    'help.cmd.status': 'Mostra se o orquestrador está rodando',
    'help.cmd.logs': 'Mostra os logs',
    'help.cmd.seed': 'Aplica o(s) arquivo(s) de seed do seedsDir no DynamoDB (sem argumento = todas as tabelas com arquivo)',
    'help.cmd.scan': 'Lista todo serviço Serverless/osls encontrado sob a raiz do projeto (flags registrado/instalado/empacotado, portas e comando de package)',
    'help.cmd.register': 'Registra serviços no orquestrador que está rodando (usa o diretório atual por padrão; o empacotamento roda sob demanda via autoPackage)',
    'help.cmd.seedClear': 'Apaga todos os itens da tabela informada (ou de todas as tabelas com arquivo de seed). Pede confirmação interativa (digitar "confirmar") antes de qualquer escrita.',
    'help.cmd.mcp': 'Roda o servidor Model Context Protocol no stdio, para um cliente MCP dirigir esta stack com tools. Precisa do orquestrador rodando; veja docs/MCP.md.',
    'help.cmd.help': 'Mostra esta ajuda',
    'help.opt.config': 'Carrega a config deste arquivo (tem precedência sobre a busca em cwd/home). Vale para start/stop/status/logs, então dá para endereçar uma instância isolada sem entrar na pasta dela.',
    'help.opt.dynamoProxy': 'Liga o proxy DynamoDB na porta 8000 (para o comando start)',
    'help.opt.wait': 'No start, bloqueia até o orquestrador responder GET /api/health (padrão 30s) e sai com código diferente de zero — mostrando o fim do log — se ele não responder. É o que uma cadeia sequencial precisa para não rodar o passo seguinte contra um stack que não subiu.',
    'help.opt.yes': 'Pula a confirmação interativa do seed:clear (use só em CI)',
    'help.env.dashboardPort': 'Porta do orquestrador (sobrepõe serverPort)',
    'help.env.enginePort': 'Porta do self engine (sobrepõe selfEngine.port)',
    'help.env.engineDataDir': 'Diretório de estado do self engine (sobrepõe selfEngine.dataDir)',
    'help.env.awsRegion': 'Região padrão para o provisionamento e para os explorers',
    'help.env.lang': 'Idioma da CLI: en, pt-BR ou es (cai para LC_ALL/LC_MESSAGES/LANG)',
    'help.config.intro': 'Crie um lss.config.json ou .lssrc na raiz do projeto para customizar:',
    'help.config.example': 'Exemplo de lss.config.json:',
    'help.config.stateDir': 'stateDir (opcional): diretório para os arquivos de PID/log desta instância. Use junto com --config (ex.: ".lss-e2e") para rodar uma instância totalmente isolada ao lado da de dev. Sem ele, PID/log ficam no diretório temporário do SO, separados por serverPort.',
    'help.ex.start': 'Sobe o orquestrador + self engine (sem Docker)',
    'help.ex.startProxy': 'Sobe com o proxy DynamoDB ligado',
    'help.ex.mcp': 'Serve as tools MCP para um agente de IA no stdio',
    'help.ex.stop': 'Para o orquestrador',
    'help.ex.status': 'Mostra o status',
    'help.ex.logs': 'Mostra os logs',
    'help.ex.scan': 'Lista os serviços encontrados sob a raiz do projeto',
    'help.ex.register': 'Registra o serviço do diretório atual',
    'help.ex.seed': 'Semeia toda tabela que tem um arquivo <table>.json',
    'help.ex.seedTable': 'Semeia só a tabela "users"',
    'help.ex.seedClear': 'Apaga todos os itens de "users" (com confirmação)',
    'help.ex.seedClearYes': 'Mesma coisa, sem prompt (CI)',
  },

  es: {
    'scan.warning.not-installed': 'dependencias sin instalar — empaquetar requiere instalarlas antes',
    'scan.warning.not-packaged': 'aún sin empaquetar — registrar lo empaqueta por ti (autoPackage)',
    'scan.warning.not-packaged-manual': 'aún sin empaquetar — autoPackage está desactivado, ejecuta `serverless package` antes de registrar',
    'scan.warning.ts-config': 'config en TypeScript — nombre, región y puertos se resuelven al empaquetar',
    'scan.warning.unreadable-config': 'no se pudo leer {file}',
    'scan.warning.invalid-json': 'serverless.json no es un JSON válido',
    'config.parseFailed': '⚠️  No se pudo leer el archivo de configuración {path}',
    'config.notFound': '⚠️  Archivo de configuración no encontrado: {path}',

    'start.already': '⚠️  El orquestador LSS ya está en marcha (PID: {pid})',
    'start.starting': '🚀 Iniciando el orquestador LSS...',
    'start.started': '🚀 Orquestador LSS iniciado (PID: {pid})',
    'start.server': '📊 Servidor: {url}',
    'start.engine': '🔧 Self Engine: {url} (sin Docker)',
    'start.dynamoProxy': '🔌 Proxy de DynamoDB: {url}',
    'start.logs': '📝 Registros: {path}',
    'start.running': '✅ El servicio está en marcha',
    'start.failed': '❌ El servicio no arrancó. Revisa los registros: {path}',
    'start.waiting': '⏳ Esperando a que el orquestador responda (hasta {seconds}s)...',
    'start.waitTimeout': '❌ El orquestador no respondió en {seconds}s',
    'start.logTail': '--- últimas líneas del registro ---',
    'start.notBuilt': '❌ Orquestador no encontrado o sin compilar.',
    'start.notBuiltDev': 'Si estás desarrollando LSS, ejecuta:',
    'start.notBuiltBug': 'Si lo instalaste con npm, por favor repórtalo como un bug.',
    'stop.notRunning': '⚠️  El orquestador LSS no está en marcha',
    'stop.stopped': '🛑 Orquestador LSS detenido (PID: {pid})',
    'stop.failed': '❌ No se pudo detener el orquestador: {error}',
    'stop.timeout': '⚠️  El proceso {pid} no terminó en 10s tras el SIGTERM — el puerto del servidor puede seguir ocupado. Revisa `lss status` antes de volver a iniciar.',
    'status.running': '🟢 Orquestador LSS: EN MARCHA (PID: {pid})',
    'status.notRunning': '⚪ Orquestador LSS: DETENIDO',
    'status.stale': '⚪ Orquestador LSS: DETENIDO (archivo PID huérfano)',
    'status.server': '   Servidor: {url}',
    'status.engine': '   Self Engine: {url}',
    'status.dynamoProxy': '   Proxy de DynamoDB: {url}',
    'status.logs': '   Registros: {path}',
    'status.portOwnedByOther': '🔶 El puerto {port} lo ocupa el orquestador de {root}',
    'status.portAnsweringHere': '🔶 El puerto {port} responde por este proyecto, pero no hay archivo PID registrado aquí (¿arrancó desde otra terminal?)',
    'logs.missing': '⚠️  No hay archivo de registro en {path}',
    'logs.from': '📝 Registros de: {path}',


    'error.notRunning': '❌ El orquestador LSS no está en marcha. Inícialo con: npx lss start',
    'error.unknown': 'error desconocido (sin detalles)',
    'error.io': 'error de E/S ({code})',
    'error.httpNoBody': 'HTTP {status} (sin cuerpo de error)',
    'error.httpConnection': 'falló la conexión HTTP con el orquestador: {error}',

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
    'seed.clearingTable': '🧹 Vaciando {table}…',
    'seed.running': '🌱 Aplicando los seeds…',
    'seed.runningTable': '🌱 Sembrando {table}…',
    'seed.inserted': '  ✓ {table}: {count} ítem(s) insertado(s)',
    'seed.deleted': '  ✓ {table}: {count} ítem(s) eliminado(s)',
    'seed.skipped': '  ⚠ {table}: omitida ({reason})',
    'seed.failed': '❌ El seed falló:',

    'seed.diagFile': '📂 Archivo de seed inspeccionado: {table}.json',
    'seed.diagFiles': '📂 Archivos de seed inspeccionados (tabla esperada):',
    'seed.diagNoFiles': '📂 No se encontró ningún archivo *.json en seedsDir.',
    'seed.diagLiveTables': '🗂️  Tablas vivas en el engine ({count}):',
    'seed.diagMatchHint': '💡 Los nombres de los archivos de seed deben coincidir EXACTAMENTE con el `TableName` de CloudFormation.',
    'seed.diagPrefixHint': '   Fíjate si el archivo y la tabla difieren en algún prefijo/sufijo.',
    'seed.diagNoLiveTables': '🗂️  Todavía no hay tablas vivas en el engine.',
    'seed.diagNotProvisioned': '💡 Probablemente el stack aún no se aprovisionó. Prueba:',
    'seed.diagStepStart': 'asegura que el orquestador esté en marcha',
    'seed.diagStepDeploy': 'crea las tablas',
    'seed.diagRetry': '   Y ejecuta `npx lss seed` de nuevo.',
    'seed.diagFailed': '(no se pudieron detallar las tablas vivas: {error})',

    'clear.noSuchTable': '⚠️  No existe ninguna tabla "{table}" en el engine para vaciar.',
    'clear.noSeedFiles': '⚠️  No se encontró ningún archivo de seed (*.json) en seedsDir — nada que vaciar.',
    'clear.noneLive': '⚠️  Se encontraron {count} archivo(s) de seed, pero NINGUNA de las tablas correspondientes existe en el engine.',
    'clear.warning': '⚠️  ATENCIÓN: operación destructiva',
    'clear.target': '   Objetivo:  {scope}',
    'clear.engine': '   Engine:    {url}',
    'clear.noAws': '   Esta acción NO toca ninguna cuenta de AWS — solo el engine local de arriba.',
    'clear.scopeTable': 'la tabla "{table}"',
    'clear.scopeTables': '{count} tabla(s): {tables}',
    'clear.skipPrompt': '↳ --yes indicado, saltando la confirmación interactiva.',
    'clear.listFailed': '❌ No se pudieron listar las tablas antes de vaciar:',
    'clear.failed': '❌ El vaciado falló:',

    'mcp.missing': '❌ No se encontró el build del servidor MCP. Ejecuta `npm run build` primero.',
    'mcp.startFailed': '❌ No se pudo iniciar el servidor MCP:',

    'help.unknown': 'Comando desconocido: {command}',
    'help.usage': 'Uso: npx lss <command> [options]',
    'help.commands': 'Comandos:',
    'help.options': 'Opciones:',
    'help.environment': 'Entorno:',
    'help.configuration': 'Configuración:',
    'help.examples': 'Ejemplos:',
    'help.cmd.start': 'Inicia el orquestador LSS en segundo plano',
    'help.cmd.stop': 'Detiene el orquestador LSS',
    'help.cmd.status': 'Muestra si el orquestador está en marcha',
    'help.cmd.logs': 'Muestra los registros',
    'help.cmd.seed': 'Aplica el/los archivo(s) de seed de seedsDir en DynamoDB (sin argumento = todas las tablas que coincidan)',
    'help.cmd.scan': 'Lista cada servicio Serverless/osls encontrado bajo la raíz del proyecto (banderas registrado/instalado/empaquetado, puertos y comando de package)',
    'help.cmd.register': 'Registra servicios en el orquestador en marcha (usa el directorio actual por defecto; el empaquetado corre a demanda con autoPackage)',
    'help.cmd.seedClear': 'Elimina todos los ítems de la tabla indicada (o de todas las tablas con archivo de seed). Pide confirmación interactiva (escribir "confirmar") antes de cualquier escritura.',
    'help.cmd.mcp': 'Ejecuta el servidor Model Context Protocol en stdio, para que un cliente MCP maneje este stack con tools. Requiere el orquestador en marcha; mira docs/MCP.md.',
    'help.cmd.help': 'Muestra esta ayuda',
    'help.opt.config': 'Carga la configuración de este archivo (tiene precedencia sobre la búsqueda en cwd/home). Aplica a start/stop/status/logs, así una instancia aislada se puede direccionar sin entrar a su carpeta.',
    'help.opt.dynamoProxy': 'Habilita el proxy de DynamoDB en el puerto 8000 (para el comando start)',
    'help.opt.wait': 'En start, bloquea hasta que el orquestador responda GET /api/health (30s por defecto) y sale con código distinto de cero — mostrando el final del registro — si no responde. Es lo que necesita una cadena secuencial para no ejecutar el paso siguiente contra un stack que no arrancó.',
    'help.opt.yes': 'Salta la confirmación interactiva de seed:clear (úsalo solo en CI)',
    'help.env.dashboardPort': 'Puerto del orquestador (sobrescribe serverPort)',
    'help.env.enginePort': 'Puerto del self engine (sobrescribe selfEngine.port)',
    'help.env.engineDataDir': 'Directorio de estado del self engine (sobrescribe selfEngine.dataDir)',
    'help.env.awsRegion': 'Región por defecto para el aprovisionamiento y los exploradores',
    'help.env.lang': 'Idioma de la CLI: en, pt-BR o es (cae a LC_ALL/LC_MESSAGES/LANG)',
    'help.config.intro': 'Crea un lss.config.json o .lssrc en la raíz del proyecto para personalizar:',
    'help.config.example': 'Ejemplo de lss.config.json:',
    'help.config.stateDir': 'stateDir (opcional): directorio para los archivos PID/log de esta instancia. Úsalo junto con --config (p. ej. ".lss-e2e") para correr una instancia totalmente aislada al lado de la de desarrollo. Si se omite, PID/log viven en el directorio temporal del SO separados por serverPort.',
    'help.ex.start': 'Inicia el orquestador + self engine (sin Docker)',
    'help.ex.startProxy': 'Inicia con el proxy de DynamoDB habilitado',
    'help.ex.mcp': 'Sirve las tools MCP a un agente de IA por stdio',
    'help.ex.stop': 'Detiene el orquestador',
    'help.ex.status': 'Muestra el estado',
    'help.ex.logs': 'Muestra los registros',
    'help.ex.scan': 'Lista los servicios encontrados bajo la raíz del proyecto',
    'help.ex.register': 'Registra el servicio del directorio actual',
    'help.ex.seed': 'Siembra cada tabla que tenga un archivo <table>.json',
    'help.ex.seedTable': 'Siembra solo la tabla "users"',
    'help.ex.seedClear': 'Elimina todos los ítems de "users" (con confirmación)',
    'help.ex.seedClearYes': 'Lo mismo, sin prompt (CI)',
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
