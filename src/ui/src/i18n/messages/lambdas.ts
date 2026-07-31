// The Lambda screens: the function list and the per-function detail (invoke,
// triggers, environment, logs).
//
// AWS vocabulary stays in English on purpose — `Lambda`, `runtime`, `handler`,
// `payload`, `RequestResponse`, `Event`, `http/httpApi` are the names in the
// console, the SDKs and `serverless.yml`, so translating them would make the
// dashboard harder to map onto the code it is emulating.
import type { AreaMessages } from './index';

export const lambdas: AreaMessages = {
  en: {
    // List screen
    statFunctions: 'Functions',
    statOnline: 'Online',
    statInvocations: 'Invocations (session)',
    statErrors: 'Errors',
    listTitle: 'Lambda functions',
    listLive: 'Live · refreshes every 10s',
    loadingList: 'Loading lambdas…',
    emptyTitle: 'No functions registered',
    emptyDescription: 'Register a microservice that defines Lambda functions to see them here.',
    loadFailed: 'Failed to load lambdas',
    errShort: '{count} err',

    // Column / stat labels
    function: 'Function',
    runtime: 'Runtime',
    handler: 'Handler',
    triggers: 'Triggers',
    invocations: 'Invocations',
    last: 'Last',
    memory: 'Memory',
    timeout: 'Timeout',
    mode: 'Mode',
    key: 'Key',
    value: 'Value',
    method: 'Method',
    path: 'Path',
    authorizer: 'Authorizer',

    // Function status
    statusStarting: 'starting',
    statusError: 'error',

    // Detail shell
    loadingDetail: 'Loading function…',
    detailLoadFailed: 'Failed to load function',

    // Tabs
    tabInvoke: 'Invoke',
    tabEnvironment: 'Environment',
    tabLogs: 'Logs',

    // Invoke tab
    invokeTitle: 'Invoke function',
    payloadLabel: 'Event payload',
    payloadHint: 'JSON passed to the handler as the event',
    invocationTypeLabel: 'Invocation type',
    invocationTypeSync: 'RequestResponse (sync)',
    invocationTypeAsync: 'Event (async, fire & forget)',
    invokeAction: 'Invoke',
    resetPayload: 'Reset payload',
    acceptedHint: 'Last invocation accepted as Event — check the Logs tab for output.',
    resultTitle: 'Result',
    errorBadge: 'Error',
    responsePayload: 'Response payload',
    functionError: 'Function error',
    capturedLogs: 'Captured logs',
    noOutput: '— no output —',
    invalidJsonTitle: 'Invalid JSON payload',
    invalidJsonDescription: 'Fix the payload before invoking.',
    acceptedTitle: 'Invocation accepted',
    acceptedDescription: 'Event invocation queued (fire & forget).',
    functionErrorTitle: 'Function returned an error',
    invokeFailed: 'Failed to invoke function',

    // Triggers tab
    triggerSources: 'Trigger sources',
    httpRoutes: 'HTTP routes',
    noRoutesTitle: 'No HTTP routes',
    noRoutesDescription: 'This function has no http/httpApi events pointing at it.',

    // Environment tab
    environmentVariables: 'Environment variables',
    noEnvTitle: 'No environment variables',
    noEnvDescription: 'No environment variables are configured for this function.',

    // Logs tab
    recentInvocations: 'Recent invocations ({count})',
    loadingInvocations: 'Loading invocations…',
    noInvocationsTitle: 'No invocations recorded',
    noInvocationsDescription: 'Invoke the function to see its captured output here.',
    invocationLog: 'Invocation log',
    logsLoadFailed: 'Failed to load invocation logs',
    logLine: '{count} line',
    logLines: '{count} lines',
  },
  'pt-BR': {
    // List screen
    statFunctions: 'Funções',
    statOnline: 'Online',
    statInvocations: 'Invocações (sessão)',
    statErrors: 'Erros',
    listTitle: 'Funções Lambda',
    listLive: 'Ao vivo · atualiza a cada 10s',
    loadingList: 'Carregando lambdas…',
    emptyTitle: 'Nenhuma função registrada',
    emptyDescription: 'Registre um microsserviço que declare funções Lambda para vê-las aqui.',
    loadFailed: 'Falha ao carregar as lambdas',
    errShort: '{count} err',

    // Column / stat labels
    function: 'Função',
    runtime: 'Runtime',
    handler: 'Handler',
    triggers: 'Gatilhos',
    invocations: 'Invocações',
    last: 'Última',
    memory: 'Memória',
    timeout: 'Timeout',
    mode: 'Modo',
    key: 'Chave',
    value: 'Valor',
    method: 'Método',
    path: 'Caminho',
    authorizer: 'Autorizador',

    // Function status
    statusStarting: 'iniciando',
    statusError: 'erro',

    // Detail shell
    loadingDetail: 'Carregando função…',
    detailLoadFailed: 'Falha ao carregar a função',

    // Tabs
    tabInvoke: 'Invocar',
    tabEnvironment: 'Ambiente',
    tabLogs: 'Logs',

    // Invoke tab
    invokeTitle: 'Invocar função',
    payloadLabel: 'Payload do evento',
    payloadHint: 'JSON entregue ao handler como o event',
    invocationTypeLabel: 'Tipo de invocação',
    invocationTypeSync: 'RequestResponse (síncrono)',
    invocationTypeAsync: 'Event (assíncrono, dispara e esquece)',
    invokeAction: 'Invocar',
    resetPayload: 'Limpar payload',
    acceptedHint: 'Última invocação aceita como Event — veja a saída na aba Logs.',
    resultTitle: 'Resultado',
    errorBadge: 'Erro',
    responsePayload: 'Payload da resposta',
    functionError: 'Erro da função',
    capturedLogs: 'Logs capturados',
    noOutput: '— sem saída —',
    invalidJsonTitle: 'Payload JSON inválido',
    invalidJsonDescription: 'Corrija o payload antes de invocar.',
    acceptedTitle: 'Invocação aceita',
    acceptedDescription: 'Invocação Event enfileirada (dispara e esquece).',
    functionErrorTitle: 'A função retornou um erro',
    invokeFailed: 'Falha ao invocar a função',

    // Triggers tab
    triggerSources: 'Origens dos gatilhos',
    httpRoutes: 'Rotas HTTP',
    noRoutesTitle: 'Nenhuma rota HTTP',
    noRoutesDescription: 'Nenhum evento http/httpApi aponta para esta função.',

    // Environment tab
    environmentVariables: 'Variáveis de ambiente',
    noEnvTitle: 'Nenhuma variável de ambiente',
    noEnvDescription: 'Esta função não tem variáveis de ambiente configuradas.',

    // Logs tab
    recentInvocations: 'Invocações recentes ({count})',
    loadingInvocations: 'Carregando invocações…',
    noInvocationsTitle: 'Nenhuma invocação registrada',
    noInvocationsDescription: 'Invoque a função para ver a saída capturada aqui.',
    invocationLog: 'Log da invocação',
    logsLoadFailed: 'Falha ao carregar os logs de invocação',
    logLine: '{count} linha',
    logLines: '{count} linhas',
  },
  es: {
    // List screen
    statFunctions: 'Funciones',
    statOnline: 'En línea',
    statInvocations: 'Invocaciones (sesión)',
    statErrors: 'Errores',
    listTitle: 'Funciones Lambda',
    listLive: 'En vivo · se actualiza cada 10s',
    loadingList: 'Cargando lambdas…',
    emptyTitle: 'Ninguna función registrada',
    emptyDescription: 'Registra un microservicio que declare funciones Lambda para verlas aquí.',
    loadFailed: 'No se pudieron cargar las lambdas',
    errShort: '{count} err',

    // Column / stat labels
    function: 'Función',
    runtime: 'Runtime',
    handler: 'Handler',
    triggers: 'Disparadores',
    invocations: 'Invocaciones',
    last: 'Última',
    memory: 'Memoria',
    timeout: 'Timeout',
    mode: 'Modo',
    key: 'Clave',
    value: 'Valor',
    method: 'Método',
    path: 'Ruta',
    authorizer: 'Autorizador',

    // Function status
    statusStarting: 'iniciando',
    statusError: 'error',

    // Detail shell
    loadingDetail: 'Cargando función…',
    detailLoadFailed: 'No se pudo cargar la función',

    // Tabs
    tabInvoke: 'Invocar',
    tabEnvironment: 'Entorno',
    tabLogs: 'Logs',

    // Invoke tab
    invokeTitle: 'Invocar función',
    payloadLabel: 'Payload del evento',
    payloadHint: 'JSON que se entrega al handler como el event',
    invocationTypeLabel: 'Tipo de invocación',
    invocationTypeSync: 'RequestResponse (síncrono)',
    invocationTypeAsync: 'Event (asíncrono, dispara y olvida)',
    invokeAction: 'Invocar',
    resetPayload: 'Restablecer payload',
    acceptedHint: 'Última invocación aceptada como Event — revisa la salida en la pestaña Logs.',
    resultTitle: 'Resultado',
    errorBadge: 'Error',
    responsePayload: 'Payload de la respuesta',
    functionError: 'Error de la función',
    capturedLogs: 'Logs capturados',
    noOutput: '— sin salida —',
    invalidJsonTitle: 'Payload JSON no válido',
    invalidJsonDescription: 'Corrige el payload antes de invocar.',
    acceptedTitle: 'Invocación aceptada',
    acceptedDescription: 'Invocación Event encolada (dispara y olvida).',
    functionErrorTitle: 'La función devolvió un error',
    invokeFailed: 'No se pudo invocar la función',

    // Triggers tab
    triggerSources: 'Orígenes de los disparadores',
    httpRoutes: 'Rutas HTTP',
    noRoutesTitle: 'Ninguna ruta HTTP',
    noRoutesDescription: 'Ningún evento http/httpApi apunta a esta función.',

    // Environment tab
    environmentVariables: 'Variables de entorno',
    noEnvTitle: 'Ninguna variable de entorno',
    noEnvDescription: 'Esta función no tiene variables de entorno configuradas.',

    // Logs tab
    recentInvocations: 'Invocaciones recientes ({count})',
    loadingInvocations: 'Cargando invocaciones…',
    noInvocationsTitle: 'Ninguna invocación registrada',
    noInvocationsDescription: 'Invoca la función para ver aquí su salida capturada.',
    invocationLog: 'Log de la invocación',
    logsLoadFailed: 'No se pudieron cargar los logs de invocación',
    logLine: '{count} línea',
    logLines: '{count} líneas',
  },
};
