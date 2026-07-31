// Guided first-run flow: ports → branding → scan & register.
//
// AWS wire vocabulary and config spellings stay in English on purpose —
// `serverPort`, `selfEngine.port`, `custom.lss`, `lss.config.json`,
// `serviceRuntime` and `servicePackaging` are the literal keys the user types
// into a file, and "package" is the `serverless package` step, not a noun we
// are free to rename per language.
import type { AreaMessages } from './index';

export const onboarding: AreaMessages = {
  en: {
    'warning.not-installed': 'dependencies not installed — packaging needs an install first',
    'warning.not-packaged': 'not packaged yet — registering packages it for you (autoPackage)',
    'warning.ts-config': 'TypeScript service config — name, region and ports resolve at packaging time',
    'warning.unreadable-config': 'could not read {file}',
    'warning.invalid-json': 'serverless.json is not valid JSON',
    welcome: 'Welcome to LSS',
    guidedSetup: 'guided setup',
    intro: 'Three steps: confirm the port layout, brand the dashboard, then scan this project for '
      + 'Serverless/osls services and register the ones you want. Everything here is editable later '
      + 'in Settings.',

    stepPorts: 'Ports',
    stepPortsDescription: 'One port for everything',
    stepBrand: 'Brand',
    stepBrandDescription: 'Make the dashboard yours',
    stepServices: 'Services',
    stepServicesDescription: 'Scan and register',

    // Split around the inline <code>AWS_ENDPOINT</code> span.
    portsIntroBefore: 'By default the dashboard, the REST API and the AWS wire share one port — '
      + 'your services point',
    portsIntroAfter: 'at the same URL you are looking at now. Give the two values below different '
      + 'ports to split them.',
    serverPortLabel: 'Stack port (serverPort)',
    serverPortHint: 'Dashboard + REST API',
    enginePortLabel: 'Engine port (selfEngine.port)',
    enginePortHint: 'AWS wire — equal means one listener',
    singleListener: 'single listener — one port for everything',
    twoListeners: 'two listeners',
    restartRequired: 'restart required:',
    portsSaveFailed: 'Failed to save ports',

    brandIntro: 'Title, subtitle and colors show on every screen — teams usually put the product or '
      + 'squad name here. Applied live, no restart.',
    titleLabel: 'Title',
    titleHint: 'Blank keeps the default',
    subtitleLabel: 'Subtitle',
    subtitlePlaceholder: 'Local development control plane',
    themeLabel: 'Default theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    brandColorLabel: 'Brand color',
    brandColorHint: 'Any CSS color — blank keeps the default',
    brandSaveFailed: 'Failed to save branding',

    rescan: 'Rescan',
    servicesIntro: 'Already-registered services stay editable: change a port or the package command '
      + 'and register again to apply it.',
    // Split around the project root and the lss.config.json spans.
    scanIntroBefore: 'Every Serverless/osls service found under',
    scanIntroAfter: 'Pick the ones to bring into LSS — install dependencies and package right here '
      + 'if needed, then register: registration provisions the declared AWS resources and wires the '
      + 'event sources. Edited ports and package commands are saved to',
    scanning: 'Scanning project…',
    emptyScan: 'No Serverless/osls services found. Create one with a serverless.yml and hit Rescan '
      + '— or register a path directly with',
    selectAll: 'select all',
    selectedCount: '{count} selected',

    apiPortLabel: 'API port',
    apiPortHint: "blank = the service's own custom.lss port",
    invokePortLabel: 'Invoke port',
    invokePortHint: 'blank = api port + 10000',
    packageCommandLabel: 'Package command',
    packageCommandHint: 'blank restores the global one',

    installSelected: 'Install selected',
    packageSelected: 'Package selected',
    register: 'Register',
    registerCount: 'Register {count} service(s)',
    reRegisterCount: 'Re-register {count} service(s)',

    scanFailed: 'Scan failed',
    portRangeError: '{name}: ports must be integers between 1024 and 65535',
    serviceSettingsSaveFailed: 'Failed to save service settings',
    configLoadFailed: 'Could not load the configuration',
    installFailed: 'install failed',
    packageFailed: 'package failed',
    registerFailed: 'register failed',
    installedIn: 'dependencies installed in {seconds}s',
    packagedIn: 'packaged in {seconds}s',
    registerSummary: '{resources} resource(s), {functions} function(s), {routes} route(s)',

    statusRegistered: 'registered',
    statusFailed: 'failed',
    statusInstalling: 'installing…',
    statusPackaging: 'packaging…',
    statusRegistering: 'registering…',
    statusNotInstalled: 'not installed',
    statusPackaged: 'packaged',
    statusNotPackaged: 'not packaged',
  },
  'pt-BR': {
    'warning.not-installed': 'dependências não instaladas — empacotar exige instalar antes',
    'warning.not-packaged': 'ainda não empacotado — registrar empacota para você (autoPackage)',
    'warning.ts-config': 'config em TypeScript — nome, região e portas só resolvem no empacotamento',
    'warning.unreadable-config': 'não consegui ler {file}',
    'warning.invalid-json': 'serverless.json não é um JSON válido',
    welcome: 'Bem-vindo ao LSS',
    guidedSetup: 'configuração guiada',
    intro: 'Três passos: confirme o layout de portas, personalize a marca do dashboard e depois '
      + 'escaneie este projeto atrás de serviços Serverless/osls para registrar os que você quiser. '
      + 'Tudo aqui pode ser editado depois em Configurações.',

    stepPorts: 'Portas',
    stepPortsDescription: 'Uma porta para tudo',
    stepBrand: 'Marca',
    stepBrandDescription: 'Deixe o dashboard com a sua cara',
    stepServices: 'Serviços',
    stepServicesDescription: 'Escanear e registrar',

    portsIntroBefore: 'Por padrão o dashboard, a API REST e o protocolo AWS dividem uma única '
      + 'porta — seus serviços apontam',
    portsIntroAfter: 'para a mesma URL que você está vendo agora. Use portas diferentes nos dois '
      + 'campos abaixo para separá-los.',
    serverPortLabel: 'Porta da stack (serverPort)',
    serverPortHint: 'Dashboard + API REST',
    enginePortLabel: 'Porta da engine (selfEngine.port)',
    enginePortHint: 'Protocolo AWS — iguais significa um listener só',
    singleListener: 'um listener só — uma porta para tudo',
    twoListeners: 'dois listeners',
    restartRequired: 'precisa reiniciar:',
    portsSaveFailed: 'Não foi possível salvar as portas',

    brandIntro: 'Título, subtítulo e cores aparecem em todas as telas — os times costumam colocar '
      + 'aqui o nome do produto ou do squad. Aplicado na hora, sem reiniciar.',
    titleLabel: 'Título',
    titleHint: 'Em branco mantém o padrão',
    subtitleLabel: 'Subtítulo',
    subtitlePlaceholder: 'Control plane de desenvolvimento local',
    themeLabel: 'Tema padrão',
    themeDark: 'Escuro',
    themeLight: 'Claro',
    brandColorLabel: 'Cor da marca',
    brandColorHint: 'Qualquer cor CSS — em branco mantém o padrão',
    brandSaveFailed: 'Não foi possível salvar a marca',

    rescan: 'Escanear de novo',
    servicesIntro: 'Serviços já registrados continuam editáveis: mude uma porta ou o comando de '
      + 'package e registre de novo para aplicar.',
    scanIntroBefore: 'Todo serviço Serverless/osls encontrado em',
    scanIntroAfter: 'Escolha os que você quer trazer para o LSS — instale as dependências e rode o '
      + 'package aqui mesmo se precisar, depois registre: o registro provisiona os recursos AWS '
      + 'declarados e conecta as event sources. Portas e comandos de package editados são salvos em',
    scanning: 'Escaneando o projeto…',
    emptyScan: 'Nenhum serviço Serverless/osls encontrado. Crie um com um serverless.yml e clique '
      + 'em Escanear de novo — ou registre um caminho direto com',
    selectAll: 'selecionar todos',
    selectedCount: '{count} selecionado(s)',

    apiPortLabel: 'Porta da API',
    apiPortHint: 'em branco = a porta custom.lss do próprio serviço',
    invokePortLabel: 'Porta de invoke',
    invokePortHint: 'em branco = porta da API + 10000',
    packageCommandLabel: 'Comando de package',
    packageCommandHint: 'em branco restaura o global',

    installSelected: 'Instalar selecionados',
    packageSelected: 'Empacotar selecionados',
    register: 'Registrar',
    registerCount: 'Registrar {count} serviço(s)',
    reRegisterCount: 'Registrar de novo {count} serviço(s)',

    scanFailed: 'Falha ao escanear',
    portRangeError: '{name}: as portas precisam ser inteiros entre 1024 e 65535',
    serviceSettingsSaveFailed: 'Não foi possível salvar as configurações do serviço',
    configLoadFailed: 'Não foi possível carregar a configuração',
    installFailed: 'falha ao instalar',
    packageFailed: 'falha ao empacotar',
    registerFailed: 'falha ao registrar',
    installedIn: 'dependências instaladas em {seconds}s',
    packagedIn: 'empacotado em {seconds}s',
    registerSummary: '{resources} recurso(s), {functions} função(ões), {routes} rota(s)',

    statusRegistered: 'registrado',
    statusFailed: 'falhou',
    statusInstalling: 'instalando…',
    statusPackaging: 'empacotando…',
    statusRegistering: 'registrando…',
    statusNotInstalled: 'não instalado',
    statusPackaged: 'empacotado',
    statusNotPackaged: 'não empacotado',
  },
  es: {
    'warning.not-installed': 'dependencias sin instalar — empaquetar requiere instalarlas antes',
    'warning.not-packaged': 'aún sin empaquetar — registrar lo empaqueta por ti (autoPackage)',
    'warning.ts-config': 'config en TypeScript — nombre, región y puertos se resuelven al empaquetar',
    'warning.unreadable-config': 'no se pudo leer {file}',
    'warning.invalid-json': 'serverless.json no es un JSON válido',
    welcome: 'Bienvenido a LSS',
    guidedSetup: 'configuración guiada',
    intro: 'Tres pasos: confirma el esquema de puertos, personaliza la marca del panel y luego '
      + 'escanea este proyecto en busca de servicios Serverless/osls para registrar los que quieras. '
      + 'Todo esto se puede editar después en Configuración.',

    stepPorts: 'Puertos',
    stepPortsDescription: 'Un puerto para todo',
    stepBrand: 'Marca',
    stepBrandDescription: 'Haz tuyo el panel',
    stepServices: 'Servicios',
    stepServicesDescription: 'Escanear y registrar',

    portsIntroBefore: 'Por defecto el panel, la API REST y el protocolo AWS comparten un mismo '
      + 'puerto — tus servicios apuntan',
    portsIntroAfter: 'a la misma URL que estás viendo ahora. Usa puertos distintos en los dos '
      + 'campos de abajo para separarlos.',
    serverPortLabel: 'Puerto del stack (serverPort)',
    serverPortHint: 'Panel + API REST',
    enginePortLabel: 'Puerto del engine (selfEngine.port)',
    enginePortHint: 'Protocolo AWS — iguales significa un solo listener',
    singleListener: 'un solo listener — un puerto para todo',
    twoListeners: 'dos listeners',
    restartRequired: 'hay que reiniciar:',
    portsSaveFailed: 'No se pudieron guardar los puertos',

    brandIntro: 'El título, el subtítulo y los colores se ven en todas las pantallas — los equipos '
      + 'suelen poner aquí el nombre del producto o del squad. Se aplica al instante, sin reiniciar.',
    titleLabel: 'Título',
    titleHint: 'En blanco mantiene el valor por defecto',
    subtitleLabel: 'Subtítulo',
    subtitlePlaceholder: 'Control plane de desarrollo local',
    themeLabel: 'Tema por defecto',
    themeDark: 'Oscuro',
    themeLight: 'Claro',
    brandColorLabel: 'Color de marca',
    brandColorHint: 'Cualquier color CSS — en blanco mantiene el valor por defecto',
    brandSaveFailed: 'No se pudo guardar la marca',

    rescan: 'Volver a escanear',
    servicesIntro: 'Los servicios ya registrados siguen siendo editables: cambia un puerto o el '
      + 'comando de package y regístralo de nuevo para aplicarlo.',
    scanIntroBefore: 'Todos los servicios Serverless/osls encontrados en',
    scanIntroAfter: 'Elige los que quieras traer a LSS — instala las dependencias y haz el package '
      + 'aquí mismo si hace falta, y luego regístralos: el registro aprovisiona los recursos AWS '
      + 'declarados y conecta las event sources. Los puertos y comandos de package editados se '
      + 'guardan en',
    scanning: 'Escaneando el proyecto…',
    emptyScan: 'No se encontraron servicios Serverless/osls. Crea uno con un serverless.yml y pulsa '
      + 'Volver a escanear — o registra una ruta directamente con',
    selectAll: 'seleccionar todos',
    selectedCount: '{count} seleccionado(s)',

    apiPortLabel: 'Puerto de la API',
    apiPortHint: 'en blanco = el puerto custom.lss del propio servicio',
    invokePortLabel: 'Puerto de invoke',
    invokePortHint: 'en blanco = puerto de la API + 10000',
    packageCommandLabel: 'Comando de package',
    packageCommandHint: 'en blanco restaura el global',

    installSelected: 'Instalar seleccionados',
    packageSelected: 'Empaquetar seleccionados',
    register: 'Registrar',
    registerCount: 'Registrar {count} servicio(s)',
    reRegisterCount: 'Volver a registrar {count} servicio(s)',

    scanFailed: 'Falló el escaneo',
    portRangeError: '{name}: los puertos deben ser enteros entre 1024 y 65535',
    serviceSettingsSaveFailed: 'No se pudo guardar la configuración del servicio',
    configLoadFailed: 'No se pudo cargar la configuración',
    installFailed: 'falló la instalación',
    packageFailed: 'falló el package',
    registerFailed: 'falló el registro',
    installedIn: 'dependencias instaladas en {seconds}s',
    packagedIn: 'empaquetado en {seconds}s',
    registerSummary: '{resources} recurso(s), {functions} función(es), {routes} ruta(s)',

    statusRegistered: 'registrado',
    statusFailed: 'falló',
    statusInstalling: 'instalando…',
    statusPackaging: 'empaquetando…',
    statusRegistering: 'registrando…',
    statusNotInstalled: 'sin instalar',
    statusPackaged: 'empaquetado',
    statusNotPackaged: 'sin empaquetar',
  },
};
