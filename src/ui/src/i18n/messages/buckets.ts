// Catalogue for the "buckets" area — the S3 list screen and the bucket detail
// screen (stats, upload form, object browser).
//
// Deliberately left in English in every language: `Key`, `Body` and
// `Content-Type` are the PutObject parameter names the upload form maps onto
// one-to-one, and `bucket`/`prefix` are the S3 nouns developers type into the
// SDK — translating them would make the form harder to match against the API.
import type { AreaMessages } from './index';

export const buckets: AreaMessages = {
  en: {
    // List screen
    title: 'S3 Buckets',
    refreshHint: 'Refreshes every 10s',
    statBuckets: 'Buckets',
    statObjects: 'Objects',
    statTotalSize: 'Total size',
    colBucket: 'Bucket',
    colObjects: 'Objects',
    colVersioning: 'Versioning',
    colNotifications: 'Notifications',
    loading: 'Loading buckets…',
    loadFailed: 'Failed to load buckets',
    emptyTitle: 'No buckets found',
    emptyDescription: 'Register a microservice that defines S3 resources, or create buckets directly on the {engine}.',
    tableLabel: 'S3 buckets',
    unmanaged: 'unmanaged',
    enabled: 'Enabled',
    disabled: 'Disabled',
    open: 'Open',

    // Detail screen
    backToBuckets: 'Buckets',
    versioning: 'Versioning',
    detailLoading: 'Loading bucket…',
    detailLoadFailed: 'Failed to load bucket',
    statNotifications: 'Notifications',

    // Upload form
    uploadTitle: 'Upload object',
    keyLabel: 'Key',
    contentTypeLabel: 'Content-Type',
    bodyLabel: 'Body',
    bodyPlaceholder: 'Hello, world!',
    upload: 'Upload',
    uploadMissingFields: 'Key and body are required',
    uploadSuccess: 'Object uploaded',
    uploadFailed: 'Failed to upload object',

    // Object browser
    objectsHeader: 'Objects ({count} · {size})',
    prefixPlaceholder: 'prefix filter',
    prefixLabel: 'Filter objects by prefix',
    apply: 'Apply',
    objectsLoading: 'Loading objects…',
    objectsLoadFailed: 'Failed to load objects',
    objectsEmptyTitle: 'No objects',
    objectsEmptyDescription: 'This bucket is empty (or the prefix filter excluded everything).',
    objectsTableLabel: 'Bucket objects',
    colKey: 'Key',
    colModified: 'Modified',
    download: 'Download',
    deleteConfirm: 'Delete object "{key}"?',
    deleteSuccess: 'Object deleted',
    deleteFailed: 'Failed to delete object',
  },
  'pt-BR': {
    // List screen
    title: 'Buckets S3',
    refreshHint: 'Atualiza a cada 10s',
    statBuckets: 'Buckets',
    statObjects: 'Objetos',
    statTotalSize: 'Tamanho total',
    colBucket: 'Bucket',
    colObjects: 'Objetos',
    colVersioning: 'Versionamento',
    colNotifications: 'Notificações',
    loading: 'Carregando buckets…',
    loadFailed: 'Falha ao carregar os buckets',
    emptyTitle: 'Nenhum bucket encontrado',
    emptyDescription: 'Registre um microsserviço que declare recursos S3, ou crie buckets direto no {engine}.',
    tableLabel: 'Buckets S3',
    unmanaged: 'sem serviço',
    enabled: 'Ativado',
    disabled: 'Desativado',
    open: 'Abrir',

    // Detail screen
    backToBuckets: 'Buckets',
    versioning: 'Versionamento',
    detailLoading: 'Carregando bucket…',
    detailLoadFailed: 'Falha ao carregar o bucket',
    statNotifications: 'Notificações',

    // Upload form
    uploadTitle: 'Enviar objeto',
    keyLabel: 'Key',
    contentTypeLabel: 'Content-Type',
    bodyLabel: 'Body',
    bodyPlaceholder: 'Olá, mundo!',
    upload: 'Enviar',
    uploadMissingFields: 'Key e Body são obrigatórios',
    uploadSuccess: 'Objeto enviado',
    uploadFailed: 'Falha ao enviar o objeto',

    // Object browser
    objectsHeader: 'Objetos ({count} · {size})',
    prefixPlaceholder: 'filtro por prefixo',
    prefixLabel: 'Filtrar objetos por prefixo',
    apply: 'Aplicar',
    objectsLoading: 'Carregando objetos…',
    objectsLoadFailed: 'Falha ao carregar os objetos',
    objectsEmptyTitle: 'Nenhum objeto',
    objectsEmptyDescription: 'Este bucket está vazio (ou o filtro de prefixo excluiu tudo).',
    objectsTableLabel: 'Objetos do bucket',
    colKey: 'Key',
    colModified: 'Modificado em',
    download: 'Baixar',
    deleteConfirm: 'Excluir o objeto "{key}"?',
    deleteSuccess: 'Objeto excluído',
    deleteFailed: 'Falha ao excluir o objeto',
  },
  es: {
    // List screen
    title: 'Buckets de S3',
    refreshHint: 'Se actualiza cada 10s',
    statBuckets: 'Buckets',
    statObjects: 'Objetos',
    statTotalSize: 'Tamaño total',
    colBucket: 'Bucket',
    colObjects: 'Objetos',
    colVersioning: 'Versionado',
    colNotifications: 'Notificaciones',
    loading: 'Cargando buckets…',
    loadFailed: 'Error al cargar los buckets',
    emptyTitle: 'No se encontraron buckets',
    emptyDescription: 'Registra un microservicio que defina recursos S3, o crea buckets directamente en el {engine}.',
    tableLabel: 'Buckets de S3',
    unmanaged: 'sin servicio',
    enabled: 'Activado',
    disabled: 'Desactivado',
    open: 'Abrir',

    // Detail screen
    backToBuckets: 'Buckets',
    versioning: 'Versionado',
    detailLoading: 'Cargando bucket…',
    detailLoadFailed: 'Error al cargar el bucket',
    statNotifications: 'Notificaciones',

    // Upload form
    uploadTitle: 'Subir objeto',
    keyLabel: 'Key',
    contentTypeLabel: 'Content-Type',
    bodyLabel: 'Body',
    bodyPlaceholder: '¡Hola, mundo!',
    upload: 'Subir',
    uploadMissingFields: 'Key y Body son obligatorios',
    uploadSuccess: 'Objeto subido',
    uploadFailed: 'Error al subir el objeto',

    // Object browser
    objectsHeader: 'Objetos ({count} · {size})',
    prefixPlaceholder: 'filtro por prefijo',
    prefixLabel: 'Filtrar objetos por prefijo',
    apply: 'Aplicar',
    objectsLoading: 'Cargando objetos…',
    objectsLoadFailed: 'Error al cargar los objetos',
    objectsEmptyTitle: 'Sin objetos',
    objectsEmptyDescription: 'Este bucket está vacío (o el filtro de prefijo excluyó todo).',
    objectsTableLabel: 'Objetos del bucket',
    colKey: 'Key',
    colModified: 'Modificado',
    download: 'Descargar',
    deleteConfirm: '¿Eliminar el objeto "{key}"?',
    deleteSuccess: 'Objeto eliminado',
    deleteFailed: 'Error al eliminar el objeto',
  },
};
