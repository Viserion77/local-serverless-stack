# Contrato de UI e UX do dashboard LSS

## Propósito

Este é o contrato **vivo** de UI e UX do frontend do Local Serverless Stack — o dashboard Vue 3 em
`src/ui/`. Ele registra as decisões visuais que o produto deve seguir e é atualizado sempre que uma
nova orientação de UI ou UX for dada.

As lacunas cuja solução correta pertence à biblioteca de componentes (a **TreeUI**, `@treeui/vue`)
ficam no documento irmão [`treeUxPatterns.md`](./treeUxPatterns.md). O app consumidor **não** deve
implementar silenciosamente uma versão local dessas lacunas.

> Contexto do repositório: o LSS tem **um** frontend (`src/ui/`). A TreeUI mora em **outro
> repositório** e é consumida via `@treeui/vue@0.25.0` (`@treeui/icons@0.18.0`,
> `@treeui/tokens@0.15.0`) — **atualizado de 0.14.0 em 2026-07-21**. A biblioteca expõe **69+
> componentes** e um catálogo **Branchline com ~364 ícones**. O upgrade trouxe (e a migração vai
> adotar): `TText`, `TStackItem`, `TSpacer`, `TPage`/`TContainer`, `TPageHeader`, `TAvatar`, o slot
> `#header-start` do `TAppShell` e `TButton icon-only`.

## Direção inicial — 2026-07-21

O trabalho começou pelo dashboard do LSS com os seguintes objetivos:

- estudar a UI e a UX da aplicação (Overview, Services, Lambdas, APIs, Queues, S3, DynamoDB,
  OpenSearch, Secrets);
- tornar a home (Overview) completa, limpa e compreensível em uma leitura rápida;
- aproveitar bem monitores grandes, sem espremer o conteúdo numa coluna central cercada por grandes
  áreas cinzas;
- adotar a TreeUI como fonte única de componentes, ícones e decisões visuais;
- manter TreeUI e o dashboard alinhados por meio de um backlog explícito
  ([`treeUxPatterns.md`](./treeUxPatterns.md)), em vez de acumular correções locais de CSS.

Primeiro ajuste concreto: o **header do `TAppShell`** aparecia com marca e controles empilhados à
esquerda (ver §4). Foi corrigido só com layout TreeUI, sem CSS novo.

## Regras obrigatórias

### 1. TreeUI é a fonte única de primitivas visuais

- Use somente componentes e APIs públicas de `@treeui/vue` para controles, superfícies, tipografia,
  feedback, navegação e layout visual.
- Não copie um componente da TreeUI para dentro do produto.
- Não adote outra biblioteca de componentes em paralelo.
- Um componente local pode existir quando representa uma **composição de domínio** ou agrupa partes
  de uma tela (ex.: `OverviewPage`, `ServicesList`). Ele deve ser composto por TreeUI e não pode
  criar uma linguagem visual própria.

### 2. CSS local não é ferramenta de correção de layout

- Não crie CSS no produto para ajustar largura, alinhamento, espaçamento, responsividade, densidade,
  tipografia, borda, cor ou estado visual.
- Use props, slots e componentes de layout da TreeUI: `TStack` (com `direction`/`gap`/`align`/
  `justify`/`wrap`), `TGrid` (`columns`/`gap`), `TContainer`, `TCard`, `TPage`, `TPageHeader`,
  `TDivider`, `TAppShell`.
- Não faça override de seletores internos da biblioteca, inclusive com `:deep(...)` nem
  sobrescrevendo classes `t-*`.
- Se a API pública não expressar o resultado necessário, registre a lacuna em
  [`treeUxPatterns.md`](./treeUxPatterns.md) e resolva-a na TreeUI.
- Uma exceção temporária só pode existir com aprovação explícita, motivo, responsável e condição de
  remoção registrados. Ela não vira precedente.

O CSS já existente no `src/ui/` (`style.css` global e blocos `<style scoped>`) é **dívida de
migração**, não uma autorização para adicionar mais. A remoção acontece por superfície, preservando
comportamento e acessibilidade.

### 3. Ícones de interface e marcas têm fontes diferentes

- **Ícones funcionais de interface** — ações, navegação, status, objetos e layout — vêm
  exclusivamente da API oficial da TreeUI (`TIcon`, slots de ícone, props tipadas).
- Quando faltar um ícone funcional, comunique a necessidade com nome sugerido e propósito e
  registre-a em [`treeUxPatterns.md`](./treeUxPatterns.md). Ele deve ser criado na TreeUI antes do
  consumo. **Proibido** emoji, caractere Unicode (`⚡ ✓ ⏳ → ← ▶ ▼ ⋮ ⚠ …`), desenho em CSS ou SVG
  copiado à mão como ícone.
- **Marcas e logotipos** de empresas, produtos e serviços **não** são ícones funcionais e **não**
  pertencem ao catálogo da TreeUI. No LSS isso inclui **AWS e seus serviços** (DynamoDB, S3, SQS,
  SNS, Lambda, EventBridge, OpenSearch, Secrets Manager, API Gateway), **LocalStack** e **Serverless
  Framework**.
- Para marcas, use [`https://simpleicons.org/`](https://simpleicons.org/) (ou o pacote oficial Simple
  Icons) como fonte padronizada, quando o logo existir lá.
- Simple Icons é uma exceção **exclusiva** para identidade de marca. Não o use como substituto de
  ação, navegação, status ou qualquer conceito genérico de interface.
- Atenção ao caso da lista de serviços (`ServicesList.vue`), que hoje usa emojis (`🪣 🗄 📨 📣 🎯 🔀`)
  para tipos de recurso: os que representam **um serviço AWS** viram marca (Simple Icons); os
  genéricos (busca, alvo) viram ícone funcional (TreeUI).

### 4. O AppShell entrega espaço; não decide uma coluna estreita

- O `main` do `TAppShell` deve ocupar toda a área restante do viewport e não impor `max-width`,
  centralização ou grandes gutters externos.
- Não sobrescreva `.t-app-shell__main` no produto.
- Uma largura limitada de leitura, quando fizer sentido, é uma **decisão semântica da superfície**
  expressa pela TreeUI (ex.: `TContainer`/`TPage` com largura), não um default indiscriminado nem
  CSS local.
- Em telas largas, prefira grids responsivos (`TGrid`) e divisões principal/apoio para transformar
  espaço em informação útil.

Diagnóstico do LSS (TreeUI 0.14): o `main` **já** é full-width — `t-app-shell__main` ocupa a coluna
inteira do grid e `.app-main` só aplica padding de página, sem `max-width`. Aqui o problema **não**
era a coluna central (como em outros produtos), e sim o **header**: o `TAppShell` embrulha o slot
`#header` num único bloco `flex:auto` (`.t-app-shell__header-content`, `display:block`), então marca
e controles, sendo dois blocos irmãos, **empilhavam**. O `.app-header-controls { margin-inline-start:
auto }` que existia dependia de o slot ser uma linha flex — o que deixou de ser verdade. Correção
adotada: um único `TStack direction="horizontal" justify="space-between"` como raiz do slot fixa a
marca no início e os controles no fim, sem CSS. As lacunas de componente que isso revelou (controle
de largura por item no `TStack`; layout de duas regiões nativo no header do `TAppShell`) estão em
[`treeUxPatterns.md`](./treeUxPatterns.md).

### 5. A home é uma visão de decisão, não só um relatório

A Overview deve permitir entender rapidamente:

- se o backend (LocalStack ou self engine) está de pé e saudável;
- quantos serviços/lambdas estão rodando e quantas rotas/recursos existem;
- a configuração ativa (região, endpoint, modo, auto-package, persistência);
- o que o LSS cobre hoje e o atalho para cada área;
- estados de carregamento, vazio e erro sem ambiguidade.

No LSS, a hierarquia atual é: cabeçalho de marca + status → hero de contexto → status do servidor e
configuração LESC lado a lado → totalizadores (`TStat`) → cobertura de recursos.

### 6. Estados e acessibilidade são parte do componente

- Toda busca assíncrona deve apresentar carregamento e erro de forma explícita. Hoje o padrão é um
  `TSpinner` centralizado à mão (`display:flex;justify-content:center`) — isso é dívida e vira item
  na TreeUI (estado de tela).
- Estados vazios devem explicar o estado e, quando aplicável, oferecer a próxima ação (`TEmptyState`).
- Controles somente com ícone precisam de nome acessível (`aria-label`).
- Ordem de foco, retorno de foco, `Escape` e alvos de toque não podem depender de correções frágeis
  no produto — pertencem ao componente TreeUI.
- A UI do LSS é **single-locale (inglês)**; não há catálogo i18n. Ainda assim, texto de interface não
  deve ser congelado fora de uma reação/computação quando depender de estado.

## Primeira adoção — dashboard LSS (upgrade 0.14 → 0.22 + sweep, 2026-07-21…23)

Migramos o `src/ui/` para a TreeUI ao longo de `0.14 → 0.19 → 0.20 → 0.21 → 0.22`:

- **Tipografia:** ~197 `TText` (tone/size/weight/`family`) no lugar de `<span class="muted">`,
  `<strong>` estilizado, `style="font-size"` e `class="mono"`. As classes `.muted` e o stack
  hardcoded de `.mono` saíram; o mono de texto usa `TText family="mono"` (0.20). `.mono` só resta nos
  `<textarea>` de input (código editável, não é `TText`).
- **Ícones:** ~24 `TIcon` no lugar dos glyphs Unicode (`⚡→zap`, `⏳→clock`, `←→arrow-left`,
  `→→arrow-right`, `▶/▼→chevron-*`, `⋮→ellipsis-vertical`, `⚠→triangle-alert`, emojis de recurso →
  `database/inbox/megaphone/archive/shuffle/target`, Lambda → `code`). Nenhum ícone local criado.
- **Header (`App.vue`):** marca via `TBrandLockup` (0.21 — slot `#logo` preserva a proporção do logo,
  sem recorte) no `#header-start`; controles no `#header-end` (0.20); `⋮` → `TButton icon-only` +
  `TIcon`; `min-width` do select → `TStackItem`.
- **Blocos de código/log:** os 9 `<pre>` (logs de serviço/Lambda, payloads, corpo de mensagem SQS,
  JSON do OpenSearch, valor de secret) → `TCodeBlock` (0.21 — `wrap`/`copyable`/`max-block-size`).
- **Layout/estado:** conteúdo em `<TPage width="full">` (0.20, aposentou o `.app-main`); ~20 loadings
  → `TStack justify/align="center"`; tabelas com `aria-label`; linha atenuada via `TTable rowState`/
  `rowKey` (0.20, aposentou o `.dim-row`) + sinal não-cromático (tag "seed only").
- **Links:** ~8 `TLink` (`underline`/`weight`) + `TCard interactive` (0.20) no lugar de
  `RouterLink`/`<a>` estilizados; wrappers de `TTag`/`TButton`/toggles seguem como estão.
- **Listas de definição:** as **22** linhas rótulo⟷valor (status/config da Overview + telas de
  detalhe) viraram **7** `TDescriptionList`/`TDescriptionItem` (0.22 — `<dl>` real, rótulo-acima no
  estreito, slot de ações), aposentando o interim `TStack + TText`.
- **Gate `validate: pre-prod` verde:** lint 0 erros, `vue-tsc`, build, 2345 testes / 100%.

**Backlog da TreeUI zerado** — todas as necessidades (001–012) foram atendidas em `0.14 → 0.22` (ver
[`treeUxPatterns.md`](./treeUxPatterns.md)). O `style.css` do produto ficou no reset + `.mono` (só nos
`<textarea>` de input); o único `<style scoped>` restante é o gradiente decorativo `.overview-hero`.
Eliminados ao longo das rodadas: `.muted`, `.app-main` (011), `.dim-row` (012), `.logs-pre` (003),
`.brand-logo` (009), o mono de texto (001) e as linhas rótulo⟷valor manuais (005).

## Fluxo para novas solicitações

1. Registrar a orientação neste documento se for uma regra transversal.
2. Verificar a API pública da versão instalada da TreeUI (`@treeui/vue@0.25.0`).
3. Compor a solução com componentes existentes quando a API já for suficiente.
4. Registrar em [`treeUxPatterns.md`](./treeUxPatterns.md) somente o que realmente pertence à TreeUI.
5. Sincronizar o arquivo com a TreeUI e responder no próprio item às perguntas/refutações do agente
   da biblioteca.
6. Validar no produto toda API entregue pela TreeUI; se aceita, consumir a API oficial e **remover**
   o item. Se recusada, registrar a réplica e sincronizar de novo.
7. Validar comportamento, acessibilidade, responsividade e telas largas — e passar o gate
   `validate: pre-prod` do repositório (lint, `vue-tsc`, build).

## Situação inicial observada

- Único frontend: `src/ui/`, sobre `@treeui/vue@0.25.0` (atualizado de 0.14.0). Catálogo Branchline
  com ~364 ícones.
- Há CSS local legado a migrar: `style.css` global (`muted`, `mono`, `logs-pre`, `brand-logo`,
  `dim-row`, `app-main`) e dois `<style scoped>` (`OverviewPage` hero, `SecretsList`). Migração
  incremental, guiada pelas superfícies revisadas — agora com as APIs 0.19 disponíveis para removê-las.
- Tipografia é feita com CSS: `class="muted"` (74×), `class="mono"` (39×), `muted mono` (14×) e
  `style="font-size:…"`. O `TText` (tom/tamanho/peso) já existe desde 0.15 e absorve isso; sobra só o
  `mono` (sem prop de família hoje — ver TREEUX-001).
- Vários glyphs Unicode fazem papel de ícone (`⚡ ⏳ → ← ▶ ▼ ⋮ ⚠ …`) e emojis marcam tipos de recurso
  em `ServicesList.vue`. Com o catálogo 0.18 quase todos têm equivalente (`zap`, `clock`,
  `arrow-right`, `arrow-left`, `chevron-*`, `ellipsis-vertical`, `triangle-alert`, `database`,
  `inbox`, `megaphone`, `archive`, `shuffle`, `target`) — migração glyph→`TIcon` pendente.
- Blocos `<pre>` / `.logs-pre` (9×) exibem logs/código sem componente dedicado, e há um `<textarea>`
  cru em `BucketDetail.vue` (deveria ser `TTextarea`).
- O `main` já é full-width; o ponto de compressão do LSS era o header (corrigido).
