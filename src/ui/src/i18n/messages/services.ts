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
  },
};
