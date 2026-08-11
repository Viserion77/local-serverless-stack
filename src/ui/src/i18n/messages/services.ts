// The "services" area: the registered-microservices table and a single
// service's detail screen.
//
// AWS nouns stay in English (DynamoDB, SQS, SNS, S3, Lambda, EventBridge,
// OpenSearch, CloudFormation, PID) — they are proper nouns in every console and
// SDK; only the surrounding words are translated. `event source` likewise keeps
// its AWS spelling inside "event-source mappings".
import type { AreaMessages } from './index';

export const services: AreaMessages = {
  en: {
    title: 'Microservices',

    // Registration form (list header).
    register: 'Register',
    registerHint: 'Absolute path to a Serverless project',
    registerPlaceholder: '/path/to/microservice',

    // List states.
    loadingList: 'Loading services…',
    loadingOne: 'Loading service…',
    emptyTitle: 'No services registered',
    emptyDescription: 'Register your first microservice using the form above.',
    tableLabel: 'Registered microservices',
    notFound: 'Service not found',

    // Columns / metadata labels.
    path: 'Path',
    resources: 'Resources',
    lastUpdated: 'Last updated',
    metadata: 'Metadata',
    invokePort: 'Invoke port',

    // Lifecycle status, as reported by the orchestrator.
    statusRegistered: 'registered',
    statusRunning: 'running',
    statusError: 'error',
    statusFailed: 'failed',

    // Row / header actions.
    start: 'Start',
    stop: 'Stop',
    logs: 'Logs',

    // Logs modal.
    logsTitle: 'Logs',
    logsTitleFor: 'Logs — {name}',
    logsStatus: 'Status: {status}',
    logsLabel: 'Service log',
    logsEmpty: '— no output yet —',

    // Delete confirmation.
    deleteTitle: 'Delete service?',
    deleteTitleNamed: 'Delete service “{name}”?',
    deleteDescription:
      'This removes the service from the cache and cleans up its provisioned resources on the {engine}.',

    // Toasts.
    startedToast: 'Service started',
    startFailedToast: 'Failed to start service',
    stoppedToast: 'Service stopped',
    stopFailedToast: 'Failed to stop service',
    registeredToast: 'Service registered',
    registerFailedToast: 'Failed to register service',
    deletedToast: 'Service deleted',
    deleteFailedToast: 'Failed to delete service',

    // Detail stats.
    statLambdas: 'Lambdas',
    statTables: 'Tables',
    statQueues: 'Queues',
    statTopics: 'Topics',
    statBuckets: 'Buckets',

    // Declared resources.
    declaredResources: 'Declared resources',
    resourcesTotal: '{count} total',
    noResourcesTitle: 'No resources declared',
    noResourcesDescription: "This service's CloudFormation template has no resources LSS understands yet.",
    groupTables: 'DynamoDB tables',
    groupQueues: 'SQS queues',
    groupTopics: 'SNS topics',
    groupBuckets: 'S3 buckets',
    groupLambdas: 'Lambda functions',
    groupBuses: 'EventBridge buses',
    groupRules: 'EventBridge rules',
    groupCollections: 'OpenSearch collections',
    groupEventSources: 'Event-source mappings',

    // Wiring graph (service detail). AWS nouns stay in English; so do the
    // evidence words' meanings — "declared" vs "inferred" is the whole point of
    // the column and must not blur in translation.
    graphTitle: 'Wiring',
    graphDescription: 'How this service\u2019s declared resources are connected, derived from its packaged CloudFormation template. Click a box to open that resource.',
    graphCounts: '{nodes} resources · {edges} links',
    graphLoading: 'Building the wiring graph\u2026',
    graphFailed: 'Failed to load the wiring graph',
    graphEmptyTitle: 'No connections declared',
    graphEmptyDescription: 'This service declares resources but nothing that links them \u2014 no routes, event sources, notifications or IAM grants.',
    graphTabDiagram: 'Diagram',
    graphTabTable: 'Connections',
    graphAriaLabel: 'Wiring diagram for {name}: {nodes} resources connected by {edges} links. The Connections tab lists the same links as a table.',
    graphTableLabel: 'Connections declared by {name}',
    graphHint: 'Point at a box to isolate what it is connected to.',
    graphFilterLabel: 'Show',
    graphExternal: 'declared by another service',
    graphWarnings: 'References that could not be resolved',
    graphColSource: 'From',
    graphColLink: 'Link',
    graphColTarget: 'To',
    graphColEvidence: 'Evidence',
    graphEvidenceDeclared: 'declared',
    graphEvidenceInferred: 'inferred',
    graphServiceWide: 'service-wide',
    graphKindHttpRoute: 'HTTP route',
    graphKindAuthorizer: 'authorizer',
    graphKindEventSource: 'event source',
    graphKindS3Notification: 'S3 notification',
    graphKindEventRuleTarget: 'rule target',
    graphKindEventBusRule: 'bus rule',
    graphKindSnsSubscription: 'SNS subscription',
    graphKindRedrive: 'dead-letter redrive',
    graphKindIam: 'IAM grant',
    graphKindEnv: 'environment variable',
  },
  'pt-BR': {
    title: 'Microsserviços',

    register: 'Registrar',
    registerHint: 'Caminho absoluto para um projeto Serverless',
    registerPlaceholder: '/caminho/para/microsservico',

    loadingList: 'Carregando serviços…',
    loadingOne: 'Carregando serviço…',
    emptyTitle: 'Nenhum serviço registrado',
    emptyDescription: 'Registre seu primeiro microsserviço no formulário acima.',
    tableLabel: 'Microsserviços registrados',
    notFound: 'Serviço não encontrado',

    path: 'Caminho',
    resources: 'Recursos',
    lastUpdated: 'Última atualização',
    metadata: 'Metadados',
    invokePort: 'Porta de invocação',

    statusRegistered: 'registrado',
    statusRunning: 'em execução',
    statusError: 'erro',
    statusFailed: 'falhou',

    start: 'Iniciar',
    stop: 'Parar',
    logs: 'Logs',

    logsTitle: 'Logs',
    logsTitleFor: 'Logs — {name}',
    logsStatus: 'Status: {status}',
    logsLabel: 'Log do serviço',
    logsEmpty: '— nada na saída ainda —',

    deleteTitle: 'Excluir o serviço?',
    deleteTitleNamed: 'Excluir o serviço “{name}”?',
    deleteDescription:
      'Isso remove o serviço do cache e limpa os recursos que ele provisionou no {engine}.',

    startedToast: 'Serviço iniciado',
    startFailedToast: 'Falha ao iniciar o serviço',
    stoppedToast: 'Serviço parado',
    stopFailedToast: 'Falha ao parar o serviço',
    registeredToast: 'Serviço registrado',
    registerFailedToast: 'Falha ao registrar o serviço',
    deletedToast: 'Serviço excluído',
    deleteFailedToast: 'Falha ao excluir o serviço',

    statLambdas: 'Lambdas',
    statTables: 'Tabelas',
    statQueues: 'Filas',
    statTopics: 'Tópicos',
    statBuckets: 'Buckets',

    declaredResources: 'Recursos declarados',
    resourcesTotal: '{count} no total',
    noResourcesTitle: 'Nenhum recurso declarado',
    noResourcesDescription: 'O template CloudFormation deste serviço não tem nenhum recurso que o LSS já entenda.',
    groupTables: 'Tabelas DynamoDB',
    groupQueues: 'Filas SQS',
    groupTopics: 'Tópicos SNS',
    groupBuckets: 'Buckets S3',
    groupLambdas: 'Funções Lambda',
    groupBuses: 'Barramentos EventBridge',
    groupRules: 'Regras EventBridge',
    groupCollections: 'Coleções OpenSearch',
    groupEventSources: 'Mapeamentos de event source',

    // Wiring graph (service detail). AWS nouns stay in English; so do the
    // evidence words' meanings — "declared" vs "inferred" is the whole point of
    // the column and must not blur in translation.
    graphTitle: 'Ligações',
    graphDescription: 'Como os recursos declarados por este serviço se conectam, derivado do template CloudFormation empacotado. Clique numa caixa para abrir o recurso.',
    graphCounts: '{nodes} recursos · {edges} ligações',
    graphLoading: 'Montando o grafo de ligações\u2026',
    graphFailed: 'Falha ao carregar o grafo de ligações',
    graphEmptyTitle: 'Nenhuma ligação declarada',
    graphEmptyDescription: 'Este serviço declara recursos, mas nada que os ligue \u2014 sem rotas, event sources, notificações ou permissões IAM.',
    graphTabDiagram: 'Diagrama',
    graphTabTable: 'Ligações',
    graphAriaLabel: 'Diagrama de ligações de {name}: {nodes} recursos conectados por {edges} ligações. A aba Ligações lista as mesmas ligações em tabela.',
    graphTableLabel: 'Ligações declaradas por {name}',
    graphHint: 'Aponte para uma caixa para isolar o que está ligado a ela.',
    graphFilterLabel: 'Mostrar',
    graphExternal: 'declarado por outro serviço',
    graphWarnings: 'Referências que não puderam ser resolvidas',
    graphColSource: 'De',
    graphColLink: 'Ligação',
    graphColTarget: 'Para',
    graphColEvidence: 'Evidência',
    graphEvidenceDeclared: 'declarado',
    graphEvidenceInferred: 'inferido',
    graphServiceWide: 'vale para o serviço todo',
    graphKindHttpRoute: 'rota HTTP',
    graphKindAuthorizer: 'authorizer',
    graphKindEventSource: 'event source',
    graphKindS3Notification: 'notificação do S3',
    graphKindEventRuleTarget: 'alvo da rule',
    graphKindEventBusRule: 'rule do barramento',
    graphKindSnsSubscription: 'assinatura SNS',
    graphKindRedrive: 'redrive para DLQ',
    graphKindEnv: 'variável de ambiente',
    graphKindIam: 'permissão IAM',
  },
  es: {
    title: 'Microservicios',

    register: 'Registrar',
    registerHint: 'Ruta absoluta a un proyecto Serverless',
    registerPlaceholder: '/ruta/al/microservicio',

    loadingList: 'Cargando servicios…',
    loadingOne: 'Cargando servicio…',
    emptyTitle: 'No hay servicios registrados',
    emptyDescription: 'Registra tu primer microservicio con el formulario de arriba.',
    tableLabel: 'Microservicios registrados',
    notFound: 'Servicio no encontrado',

    path: 'Ruta',
    resources: 'Recursos',
    lastUpdated: 'Última actualización',
    metadata: 'Metadatos',
    invokePort: 'Puerto de invocación',

    statusRegistered: 'registrado',
    statusRunning: 'en ejecución',
    statusError: 'error',
    statusFailed: 'falló',

    start: 'Iniciar',
    stop: 'Detener',
    logs: 'Logs',

    logsTitle: 'Logs',
    logsTitleFor: 'Logs — {name}',
    logsStatus: 'Estado: {status}',
    logsLabel: 'Log del servicio',
    logsEmpty: '— todavía sin salida —',

    deleteTitle: '¿Eliminar el servicio?',
    deleteTitleNamed: '¿Eliminar el servicio “{name}”?',
    deleteDescription:
      'Esto quita el servicio de la caché y limpia los recursos que aprovisionó en el {engine}.',

    startedToast: 'Servicio iniciado',
    startFailedToast: 'No se pudo iniciar el servicio',
    stoppedToast: 'Servicio detenido',
    stopFailedToast: 'No se pudo detener el servicio',
    registeredToast: 'Servicio registrado',
    registerFailedToast: 'No se pudo registrar el servicio',
    deletedToast: 'Servicio eliminado',
    deleteFailedToast: 'No se pudo eliminar el servicio',

    statLambdas: 'Lambdas',
    statTables: 'Tablas',
    statQueues: 'Colas',
    statTopics: 'Tópicos',
    statBuckets: 'Buckets',

    declaredResources: 'Recursos declarados',
    resourcesTotal: '{count} en total',
    noResourcesTitle: 'No hay recursos declarados',
    noResourcesDescription: 'La plantilla de CloudFormation de este servicio no tiene recursos que LSS entienda todavía.',
    groupTables: 'Tablas DynamoDB',
    groupQueues: 'Colas SQS',
    groupTopics: 'Tópicos SNS',
    groupBuckets: 'Buckets S3',
    groupLambdas: 'Funciones Lambda',
    groupBuses: 'Buses de EventBridge',
    groupRules: 'Reglas de EventBridge',
    groupCollections: 'Colecciones de OpenSearch',
    groupEventSources: 'Asignaciones de event source',

    // Wiring graph (service detail). AWS nouns stay in English; so do the
    // evidence words' meanings — "declared" vs "inferred" is the whole point of
    // the column and must not blur in translation.
    graphTitle: 'Conexiones',
    graphDescription: 'Cómo se conectan los recursos declarados por este servicio, derivado de su plantilla CloudFormation empaquetada. Haz clic en una caja para abrir el recurso.',
    graphCounts: '{nodes} recursos · {edges} conexiones',
    graphLoading: 'Construyendo el grafo de conexiones\u2026',
    graphFailed: 'No se pudo cargar el grafo de conexiones',
    graphEmptyTitle: 'Ninguna conexión declarada',
    graphEmptyDescription: 'Este servicio declara recursos, pero nada que los conecte: sin rutas, event sources, notificaciones ni permisos IAM.',
    graphTabDiagram: 'Diagrama',
    graphTabTable: 'Conexiones',
    graphAriaLabel: 'Diagrama de conexiones de {name}: {nodes} recursos conectados por {edges} conexiones. La pestaña Conexiones lista las mismas conexiones en una tabla.',
    graphTableLabel: 'Conexiones declaradas por {name}',
    graphHint: 'Apunta a una caja para aislar aquello con lo que está conectada.',
    graphFilterLabel: 'Mostrar',
    graphExternal: 'declarado por otro servicio',
    graphWarnings: 'Referencias que no se pudieron resolver',
    graphColSource: 'Desde',
    graphColLink: 'Conexión',
    graphColTarget: 'Hacia',
    graphColEvidence: 'Evidencia',
    graphEvidenceDeclared: 'declarado',
    graphEvidenceInferred: 'inferido',
    graphServiceWide: 'vale para todo el servicio',
    graphKindHttpRoute: 'ruta HTTP',
    graphKindAuthorizer: 'authorizer',
    graphKindEventSource: 'event source',
    graphKindS3Notification: 'notificación de S3',
    graphKindEventRuleTarget: 'destino de la rule',
    graphKindEventBusRule: 'rule del bus',
    graphKindSnsSubscription: 'suscripción SNS',
    graphKindRedrive: 'redrive a DLQ',
    graphKindIam: 'permiso IAM',
    graphKindEnv: 'variable de entorno',
  },
};
