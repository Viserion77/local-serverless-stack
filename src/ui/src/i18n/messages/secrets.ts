// Catalogue for the "secrets" area — the Secrets Manager screen and its
// detail modal (versions, staging labels, reveal/copy of the current value).
//
// "Secrets Manager", "CreateSecret", "AWS SDK" and "base64" stay untranslated:
// they are AWS proper nouns / API names the user has to type or look up.
import type { AreaMessages } from './index';

export const secrets: AreaMessages = {
  en: {
    statSecrets: 'Secrets',
    statVersions: 'Versions',

    filterPlaceholder: 'Filter secrets…',
    // Accessible name for the filter field — a placeholder is not a label.
    filterLabel: 'Filter secrets by name or description',
    autoRefresh: 'Refreshes every 15s',
    loadingList: 'Loading secrets…',
    tableLabel: 'Secrets',

    columnSecret: 'Secret',
    columnDescription: 'Description',
    columnVersions: 'Versions',
    columnLastChanged: 'Last changed',

    emptyTitle: 'No secrets',
    emptyBody: 'Create one with the AWS SDK (CreateSecret) against the engine endpoint — e.g. a signing key an identity service reads at boot.',
    noMatchTitle: 'No matching secrets',
    noMatchBody: 'No secrets match "{query}".',

    deletionScheduled: 'deletion scheduled',
    inspect: 'Inspect',

    detailTitle: 'Secret — {name}',
    detailTitleFallback: 'Secret',
    loadingDetail: 'Loading secret…',
    versionsHeading: 'Versions & staging labels',
    columnVersion: 'Version',
    columnStagingLabels: 'Staging labels',
    versionsTableLabel: 'Secret versions and staging labels',

    revealValue: 'Reveal current value',
    refreshValue: 'Refresh value',
    valueLabel: 'Secret value',
    binaryValue: '(binary, base64) {value}',

    loadFailed: 'Failed to load secrets',
    detailFailed: 'Failed to load secret',
    revealFailed: 'Failed to reveal value',
    copiedToClipboard: 'Copied to clipboard',
    copyFailed: 'Copy failed',
  },
  'pt-BR': {
    statSecrets: 'Segredos',
    statVersions: 'Versões',

    filterPlaceholder: 'Filtrar segredos…',
    filterLabel: 'Filtrar segredos por nome ou descrição',
    autoRefresh: 'Atualiza a cada 15s',
    loadingList: 'Carregando segredos…',
    tableLabel: 'Segredos',

    columnSecret: 'Segredo',
    columnDescription: 'Descrição',
    columnVersions: 'Versões',
    columnLastChanged: 'Última alteração',

    emptyTitle: 'Nenhum segredo',
    emptyBody: 'Crie um com o AWS SDK (CreateSecret) apontando para o endpoint da engine — por exemplo, uma chave de assinatura que um serviço de identidade lê no boot.',
    noMatchTitle: 'Nenhum segredo encontrado',
    noMatchBody: 'Nenhum segredo corresponde a "{query}".',

    deletionScheduled: 'exclusão agendada',
    inspect: 'Inspecionar',

    detailTitle: 'Segredo — {name}',
    detailTitleFallback: 'Segredo',
    loadingDetail: 'Carregando segredo…',
    versionsHeading: 'Versões e staging labels',
    columnVersion: 'Versão',
    columnStagingLabels: 'Staging labels',
    versionsTableLabel: 'Versões e staging labels do segredo',

    revealValue: 'Revelar valor atual',
    refreshValue: 'Atualizar valor',
    valueLabel: 'Valor do segredo',
    binaryValue: '(binário, base64) {value}',

    loadFailed: 'Falha ao carregar os segredos',
    detailFailed: 'Falha ao carregar o segredo',
    revealFailed: 'Falha ao revelar o valor',
    copiedToClipboard: 'Copiado para a área de transferência',
    copyFailed: 'Falha ao copiar',
  },
  es: {
    statSecrets: 'Secretos',
    statVersions: 'Versiones',

    filterPlaceholder: 'Filtrar secretos…',
    filterLabel: 'Filtrar secretos por nombre o descripción',
    autoRefresh: 'Se actualiza cada 15s',
    loadingList: 'Cargando secretos…',
    tableLabel: 'Secretos',

    columnSecret: 'Secreto',
    columnDescription: 'Descripción',
    columnVersions: 'Versiones',
    columnLastChanged: 'Último cambio',

    emptyTitle: 'Sin secretos',
    emptyBody: 'Crea uno con el AWS SDK (CreateSecret) apuntando al endpoint del engine — por ejemplo, una clave de firma que un servicio de identidad lee al arrancar.',
    noMatchTitle: 'Ningún secreto coincide',
    noMatchBody: 'Ningún secreto coincide con "{query}".',

    deletionScheduled: 'eliminación programada',
    inspect: 'Inspeccionar',

    detailTitle: 'Secreto — {name}',
    detailTitleFallback: 'Secreto',
    loadingDetail: 'Cargando secreto…',
    versionsHeading: 'Versiones y staging labels',
    columnVersion: 'Versión',
    columnStagingLabels: 'Staging labels',
    versionsTableLabel: 'Versiones y staging labels del secreto',

    revealValue: 'Revelar valor actual',
    refreshValue: 'Actualizar valor',
    valueLabel: 'Valor del secreto',
    binaryValue: '(binario, base64) {value}',

    loadFailed: 'No se pudieron cargar los secretos',
    detailFailed: 'No se pudo cargar el secreto',
    revealFailed: 'No se pudo revelar el valor',
    copiedToClipboard: 'Copiado al portapapeles',
    copyFailed: 'Error al copiar',
  },
};
