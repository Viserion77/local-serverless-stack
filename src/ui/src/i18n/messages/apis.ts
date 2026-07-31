// The APIs screen: gateway listeners, their routes and their authorizers.
//
// AWS/Serverless vocabulary stays in English on purpose — `http`, `httpApi`,
// `curl`, `stage`, `ARN`, `TTL`, `payload v1/v2` are the names a developer sees
// in serverless.yml, the SDKs and the AWS console, so translating them would
// make the screen harder to map onto the config it reflects.
import type { AreaMessages } from './index';

export const apis: AreaMessages = {
  en: {
    statServices: 'Services with APIs',
    statRoutes: 'Routes',
    statListenersOnline: 'Listeners online',

    loadingApis: 'Loading APIs…',
    loadError: 'Failed to load APIs',
    emptyTitle: 'No APIs registered',
    emptyDescription:
      'Register a microservice that defines http or httpApi events to see its routes here.',

    statusPortConflict: 'port conflict',

    clearCache: 'Clear authorizer cache',
    cacheCleared: 'Authorizer cache cleared',
    cacheClearedOne: '{count} cached result removed',
    cacheClearedMany: '{count} cached results removed',
    cacheClearFailed: 'Failed to clear authorizer cache',

    routesTableLabel: 'API routes',
    colMethod: 'Method',
    colPath: 'Path',
    colFunction: 'Function',
    colAuth: 'Auth',
    copyCurl: 'Copy curl',
    curlCopied: 'curl command copied',

    noRoutesTitle: 'No routes',
    noRoutesDescription: 'This service exposes no http or httpApi routes.',

    authorizers: 'Authorizers',
    colPayload: 'Payload',
    colIdentitySource: 'Identity source',
    colTarget: 'Function / ARN',
  },
  'pt-BR': {
    statServices: 'Serviços com APIs',
    statRoutes: 'Rotas',
    statListenersOnline: 'Listeners no ar',

    loadingApis: 'Carregando APIs…',
    loadError: 'Não foi possível carregar as APIs',
    emptyTitle: 'Nenhuma API registrada',
    emptyDescription:
      'Registre um microsserviço que declare eventos http ou httpApi para ver as rotas dele aqui.',

    statusPortConflict: 'conflito de porta',

    clearCache: 'Limpar cache do authorizer',
    cacheCleared: 'Cache do authorizer limpo',
    cacheClearedOne: '{count} resultado em cache removido',
    cacheClearedMany: '{count} resultados em cache removidos',
    cacheClearFailed: 'Falha ao limpar o cache do authorizer',

    routesTableLabel: 'Rotas da API',
    colMethod: 'Método',
    colPath: 'Caminho',
    colFunction: 'Função',
    colAuth: 'Auth',
    copyCurl: 'Copiar curl',
    curlCopied: 'Comando curl copiado',

    noRoutesTitle: 'Nenhuma rota',
    noRoutesDescription: 'Este serviço não expõe rotas http nem httpApi.',

    authorizers: 'Authorizers',
    colPayload: 'Payload',
    colIdentitySource: 'Identity source',
    colTarget: 'Função / ARN',
  },
  es: {
    statServices: 'Servicios con APIs',
    statRoutes: 'Rutas',
    statListenersOnline: 'Listeners en línea',

    loadingApis: 'Cargando APIs…',
    loadError: 'No se pudieron cargar las APIs',
    emptyTitle: 'No hay APIs registradas',
    emptyDescription:
      'Registra un microservicio que declare eventos http o httpApi para ver sus rutas aquí.',

    statusPortConflict: 'conflicto de puerto',

    clearCache: 'Limpiar caché del authorizer',
    cacheCleared: 'Caché del authorizer limpiada',
    cacheClearedOne: '{count} resultado en caché eliminado',
    cacheClearedMany: '{count} resultados en caché eliminados',
    cacheClearFailed: 'No se pudo limpiar la caché del authorizer',

    routesTableLabel: 'Rutas de la API',
    colMethod: 'Método',
    colPath: 'Ruta',
    colFunction: 'Función',
    colAuth: 'Auth',
    copyCurl: 'Copiar curl',
    curlCopied: 'Comando curl copiado',

    noRoutesTitle: 'Sin rutas',
    noRoutesDescription: 'Este servicio no expone rutas http ni httpApi.',

    authorizers: 'Authorizers',
    colPayload: 'Payload',
    colIdentitySource: 'Identity source',
    colTarget: 'Función / ARN',
  },
};
