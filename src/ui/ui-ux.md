# Contrato de UI e UX do dashboard LSS

## Propósito

Este é o contrato **vivo** de UI e UX do frontend do Local Serverless Stack — o dashboard Vue 3 em
`src/ui/`. Ele registra as decisões visuais que o produto deve seguir e é atualizado sempre que uma
nova orientação de UI ou UX for dada.

As lacunas cuja solução correta pertence à biblioteca de componentes (a **TreeUI**, `@treeui/vue`)
ficam no documento irmão [`treeUxPatterns.md`](./treeUxPatterns.md). O app consumidor **não** deve
implementar silenciosamente uma versão local dessas lacunas.

> Contexto do repositório: o LSS tem **um** frontend (`src/ui/`). A TreeUI mora em **outro
> repositório** e é consumida via `@treeui/vue@0.28.0` (`@treeui/tokens@0.28.0`,
> `@treeui/icons@0.18.0`, `@treeui/utils@0.26.0`) — **atualizado de 0.25.0 → 0.27.0 → 0.28.0 em
> 2026-08-05**, que por sua vez veio de 0.14.0 em 2026-07-21. A biblioteca expõe **95 componentes** e um catálogo
> **Branchline com 364 ícones**. Desde 2026-07-31 esse catálogo é estendido **pelo app**: 64 marcas
> oficiais de serviços AWS (`aws-*`) entram no mesmo registry via `registerAwsIcons()` — o registry
> deixou de ser só-TreeUI, o catálogo dela continua sendo (ver regra 3).
>
> **Números de versão vivem aqui e no cabeçalho de [`treeUxPatterns.md`](./treeUxPatterns.md), em
> mais lugar nenhum.** Uma versão cravada no meio de uma regra ou de um passo de processo nasce
> errada no bump seguinte — foi o que aconteceu com a linha que dizia `@treeui/tokens@0.15.0` por
> quatro minors.

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
- Marca não abre exceção: o tamanho e o alinhamento dos tiles AWS (regra 3) são decididos pela
  TreeUI — a prop `size` do `TIcon` e as dimensões dos próprios slots de ícone
  (`.t-nav-menu__icon`, `#icon` de `TTag`/`TStat`/`TEmptyState`). A adoção das marcas AWS não
  introduziu CSS local, `:deep(...)` nem override de classe `t-*`.
- Se a API pública não expressar o resultado necessário, registre a lacuna em
  [`treeUxPatterns.md`](./treeUxPatterns.md) e resolva-a na TreeUI.
- Uma exceção temporária só pode existir com aprovação explícita, motivo, responsável e condição de
  remoção registrados. Ela não vira precedente.

O CSS já existente no `src/ui/` (`style.css` global e blocos `<style scoped>`) é **dívida de
migração**, não uma autorização para adicionar mais. A remoção acontece por superfície, preservando
comportamento e acessibilidade.

#### Exceções temporárias em vigor

Uma exceção só existe se estiver **nesta tabela**. Declará-la em
[`treeUxPatterns.md`](./treeUxPatterns.md) não basta: aquele arquivo é o canal de negociação com a
biblioteca e itens saem dele quando o contrato fecha — uma exceção registrada só lá desaparece junto
e passa a ser CSS local silencioso, que é exatamente o que a regra 2 proíbe.

| # | Superfície | O que é | Motivo | Responsável | Condição de remoção |
|---|---|---|---|---|---|
| 1 | `components/ActivityPanel.vue` — três `style` inline de dimensionamento (`width:100%;height:64px` na área de paralelismo, `min-width:9rem` no rótulo da faixa, `width:100%;height:14px` em cada faixa) | SVG desenhado no produto: área em degraus do paralelismo + uma faixa de spans por serviço | A TreeUI tem `TChart`/`TSparkline`, mas nenhuma primitiva de **faixas em eixo temporal comum**, e nenhum modo `step` de área — uma curva interpolada desenharia paralelismo que nunca existiu | agente do dashboard LSS | Entrega do **TREEUX-003** |
| 2 | `components/secrets/SecretsList.vue` e `components/opensearch/OpenSearchCollectionsList.vue` — `style="cursor:pointer; text-decoration:underline dotted; …"` na célula de nome | Afordância de "a linha é clicável" numa tabela cuja linha navega | `TTable` não tem `rowHref`/`rowTo`/`@row-activate`. Toda alternativa local é pior: um `<TLink href="#">` mente sobre o destino (ctrl-clique abre `#`) e um `role="button"` à mão é reimplementar o componente | agente do dashboard LSS | Entrega do **TREEUX-004**. Enquanto isso, as duas telas mantêm um `TButton` real na coluna de ações — o teclado nunca fica sem saída |
| 3 | `pages/OverviewPage.vue` — `<style scoped> .overview-hero { background: linear-gradient(…) }` | Gradiente decorativo do hero da Overview | Último resquício do CSS pré-migração. O `THero` do 0.27 é candidato, mas é uma **banda `<section>` sem borda de card** e o hero atual é um `TCard variant="outline"` — trocar muda aparência e semântica de container | humano (decisão de design, não de refactor) | Decisão explícita de adotar `THero` (ou de manter o `TCard` e pedir um eixo de fundo decorativo à TreeUI) |

Aprovadas em 2026-08-05, depois de confirmar **nos `.d.ts` instalados** que a versão em uso não
expressa nenhuma delas. **Não são precedente**: são as três exceções vivas, cada uma amarrada a um
item do backlog, e **nenhuma superfície nova pode copiar esses padrões**. Fora desta tabela o
`src/ui/` tem **zero** `style` inline e **zero** bloco `<style>`.

*Saiu da tabela em 2026-08-05:* o `style="word-break:break-all"` do ARN em `SecretsList`, com a
entrega do `TText wrap="anywhere"` na `0.28.0` (TREEUX-006). Uma exceção sai daqui quando a API
chega — é o teste de que a tabela é um compromisso e não um depósito.

### 3. Ícones de interface e marcas têm fontes diferentes

- **Ícones funcionais de interface** — ações, navegação, status, objetos e layout — vêm
  exclusivamente da API oficial da TreeUI (`TIcon`, slots de ícone, props tipadas).
- Quando faltar um ícone funcional, comunique a necessidade com nome sugerido e propósito e
  registre-a em [`treeUxPatterns.md`](./treeUxPatterns.md). Ele deve ser criado na TreeUI antes do
  consumo. **Proibido** emoji, caractere Unicode (`⚡ ✓ ⏳ → ← ▶ ▼ ⋮ ⚠ …`), desenho em CSS ou SVG
  copiado à mão como ícone.
- **Marcas e logotipos** de empresas, produtos e serviços **não** são ícones funcionais e **não**
  pertencem ao catálogo da TreeUI. No LSS isso inclui **AWS e seus serviços** (DynamoDB, S3, SQS,
  SNS, Lambda, EventBridge, OpenSearch, Secrets Manager, API Gateway) e o **Serverless Framework**.
  (A marca do **LocalStack** saiu desta lista em 2026-08-05: o engine deixou de existir no produto
  no v1.0.0, quando o self engine passou a ser o único.)
- **Marcas de serviços AWS** vêm do pacote oficial **AWS Architecture Service Icons**
  ([`https://aws.amazon.com/architecture/icons/`](https://aws.amazon.com/architecture/icons/)),
  variante de tamanho **16** — cujo `viewBox` é `0 0 24 24`, exatamente a grade em que os ícones
  Branchline são desenhados. A arte curada está **vendorizada** em `src/ui/src/icons/aws/` (gerada
  por `scripts/generate-aws-icons.mjs`, `npm run icons:aws`); o pacote de 41 MB não é commitado e o
  build não depende dele. Isso é **garantido**, não pedido: o destino padrão do unzip (`temp/`) está
  no `.gitignore`, então nenhum `git add -A` redistribui a marca registrada da AWS a partir deste
  repositório público.
- Essas marcas são **registradas no próprio registry da TreeUI** — `registerAwsIcons()` em
  `main.ts` (que por dentro chama o `registerTreeIcons()` da lib), antes do `createApp`, mais uma
  augmentation de `TIconRegistry`
  (`registry.generated.d.ts`). O consumo é o de qualquer ícone da biblioteca:
  `<TIcon name="aws-lambda" />`, `icon="aws-sqs"` em qualquer prop `TIconInput`, tipado pelo
  `vue-tsc`, sem import por call site e sem componente local.
- Por que o pacote oficial e não Simple Icons para AWS: é a fonte **canônica** (publicada pela
  própria AWS), cobre **todos** os serviços — inclusive os que Simple Icons não tem (EventBridge,
  Secrets Manager, OpenSearch, Step Functions) — e mantém uma família visual única (tile colorido
  por categoria + glifo). A arte é marca registrada da AWS e entra **sem modificação**: é
  full-color, não usa `currentColor` e deliberadamente **não** segue tema nem os overrides de
  `branding.colors`. Corrigir isso com CSS é violar a regra 2 e os termos do pacote — ver
  [`NOTICE.md`](./src/icons/aws/NOTICE.md) do diretório.
- Para marcas **não-AWS** (hoje, apenas o Serverless Framework), a fonte padronizada continua sendo
  [`https://simpleicons.org/`](https://simpleicons.org/) (ou o pacote oficial Simple Icons), quando
  o logo existir lá.
- Nada disso é exceção à regra 3 — **é** a regra 3. Ícone funcional continua vindo só da TreeUI, e o
  prefixo `aws-` é o que mantém os dois vocabulários separados dentro do mesmo registry: nome sem
  prefixo é ícone funcional da TreeUI, `aws-*` é marca. Marca não substitui ação, navegação ou
  status; ícone funcional não substitui marca. Uma marca ausente **não** vira item em
  [`treeUxPatterns.md`](./treeUxPatterns.md) — vira uma linha no catálogo do gerador.
- Cobertura registrada hoje: **64 marcas** — 12 dos serviços que o LSS entrega (Lambda, DynamoDB,
  S3, SQS, SNS, EventBridge, OpenSearch, Secrets Manager, API Gateway, CloudFormation, IAM,
  CloudWatch) e 52 de reserva, já importadas para uso futuro. Dois apelidos documentados, porque a
  AWS não publica marca própria para eles: **STS usa a marca do IAM** e **CloudWatch Logs usa a do
  CloudWatch**.
- **Feito** no caso da lista de serviços (`ServicesList.vue`): os emojis de tipo de recurso
  (`🪣 🗄 📨 📣 🎯 🔀`) já haviam virado ícone funcional no sweep 0.14 → 0.22, e agora os que
  representam **um serviço AWS** viraram marca. Nenhum glifo genérico segue no lugar de um serviço
  em `ServicesList.vue`, `ServiceDetailPage.vue`, `LambdasList.vue`/`LambdaDetail.vue` nem nas
  telas de recurso. O mapa tipo-de-recurso → marca é único
  (`src/ui/src/icons/resourceIcons.ts`, chaveado pelos tipos do contrato da API), para tabela e
  detalhe não divergirem.

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

- se o self engine está de pé e saudável;
- quantos serviços/lambdas estão rodando e quantas rotas/recursos existem;
- a configuração ativa (região, endpoint, modo, auto-package, persistência);
- o que o LSS cobre hoje e o atalho para cada área;
- estados de carregamento, vazio e erro sem ambiguidade.

No LSS, a hierarquia atual é: cabeçalho de marca + status → hero de contexto → status do servidor e
configuração LESC lado a lado → totalizadores (`TStat`) → cobertura de recursos.

### 6. Estados e acessibilidade são parte do componente

- Toda busca assíncrona deve apresentar carregamento e erro de forma explícita. O padrão é
  `TSpinner` dentro de um `TStack justify="center" align="center"` — a centralização à mão
  (`display:flex;justify-content:center`) que existia aqui foi eliminada no sweep 0.14 → 0.22 e
  **não** deve voltar.
- Estados vazios devem explicar o estado e, quando aplicável, oferecer a próxima ação (`TEmptyState`).
- Controles somente com ícone precisam de nome acessível (`aria-label`).
- Ordem de foco, retorno de foco, `Escape` e alvos de toque não podem depender de correções frágeis
  no produto — pertencem ao componente TreeUI.
- A UI do LSS é **trilíngue (en / pt-BR / es)**, com catálogo em `src/ui/src/i18n/messages/`. Todo
  texto de interface passa por `t()` — inclusive o nome acessível de um controle só com ícone e o
  `label` de uma marca que aparece sozinha. Nomes de serviço da AWS ficam **sem tradução**: é assim
  que eles se chamam em qualquer console ou SDK.
- Texto de interface não deve ser congelado fora de uma reação/computação quando depender de estado —
  o mesmo vale para a troca de idioma: um rótulo lido uma vez no `setup` mantém o idioma antigo.

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

**Backlog da TreeUI zerado nesta rodada** — as doze necessidades daquele ciclo foram atendidas em
`0.14 → 0.22`. O `style.css` do produto ficou no reset + `.mono`; o único `<style scoped>` restante é
o gradiente decorativo `.overview-hero`. Eliminados ao longo das rodadas: `.muted`, `.app-main`,
`.dim-row`, `.logs-pre`, `.brand-logo`, o mono de texto e as linhas rótulo⟷valor manuais.

> **Cuidado com os IDs deste parágrafo.** Os `TREEUX-NNN` daquele ciclo foram removidos do backlog
> quando aceitos, como o protocolo manda — e a numeração **foi reciclada** depois. `TREEUX-001` aqui
> significa "fonte mono no `TText`"; em [`treeUxPatterns.md`](./treeUxPatterns.md) hoje significa
> `TTagInput`. Por isso este parágrafo passou a descrever as entregas **pelo nome**, sem ID: um ID
> só é confiável dentro do backlog vivo. Zerado aqui não quer dizer zerado hoje — o backlog atual
> tem itens abertos.

## Adoção — marcas de serviço AWS (2026-07-31)

Aplicação da regra 3 à parte que faltava: identificar serviço AWS por marca oficial, não por glifo
genérico.

- **Fonte e vendorização:** 64 SVGs do pacote oficial (variante 16, `viewBox 0 0 24 24`) convertidos
  por `scripts/generate-aws-icons.mjs` para `src/ui/src/icons/aws/artwork.generated.ts` +
  `registry.generated.d.ts`. O gerador falha (não "conserta") diante de `viewBox` diferente,
  `<defs>`/`<use>`/gradiente/`<style>`, referência externa ou elemento pintado sem `fill` resolvível
  — a arte não pode ser alterada.
- **Registro:** `registerAwsIcons()` na `main.ts`, entre `applyTheme(...)` e `createApp(App)`, uma
  vez. Cada marca é um componente (a arte tem `<g>` com `fill`/`transform`, que o `TIconNodes` plano
  não expressa) armazenado verbatim pelo `registerTreeIcons`, respeitando as props do `TIcon`
  (`size`/`strokeWidth`/`absoluteStrokeWidth`) e os defaults da própria TreeUI.
- **Split:** 12 marcas *core* (serviços que o LSS entrega) já consumidas na UI; 52 de reserva
  registradas e prontas (Step Functions, Kinesis, Cognito, KMS, ECS/EKS/Fargate, RDS/Aurora,
  CloudFront, Route 53, SES, X-Ray, Bedrock, IoT…), para o próximo recurso não voltar ao emoji.
- **Onde entrou:** nav do `App.vue` (as dez entradas — sem ícone, o `TNavMenu` colapsado vira quatro
  tiles "S" iguais), `TStat` da Overview e do detalhe de serviço, tags de recurso e de trigger,
  cabeçalhos de card e `TEmptyState` das telas de Lambdas, APIs, Queues, S3, DynamoDB, OpenSearch e
  Secrets.
- **Acessibilidade:** as marcas são decorativas (sem `label`) porque sempre acompanham o texto que
  nomeia o serviço. A exceção é o breakdown do `ServicesList.vue`, onde a tag mostra só marca +
  número: lá a marca fica no slot padrão do `TTag` (o `#icon` é `aria-hidden`) e recebe `label` com
  a chave i18n já existente, o que também distingue "buses" de "rules" na leitura.
- **Sem dívida nova:** zero `<style>`, zero classe, zero `:deep(...)`, zero string fora do `t()`,
  zero item novo em [`treeUxPatterns.md`](./treeUxPatterns.md) — marca nunca gera item. Gate
  `validate: pre-prod`: lint 0 erros, `vue-tsc` limpo.

## Adoção — `@treeui/vue` 0.27.0 e quitação do CSS local (2026-08-05)

Subimos de `0.25.0` direto para `0.27.0` (pulando o 0.26.0 — ver TREEUX-001 em
[`treeUxPatterns.md`](./treeUxPatterns.md)) e usamos a rodada para pagar a dívida da regra 2, que
nunca tinha sido quantificada.

- **CSS local: 79 → 6.** Havia **79** `style="…"` inline em **18** arquivos e um `<style scoped>`.
  Sobraram **6 declarações em 3 arquivos**, e as quatro superfícies estão na tabela de exceções da
  regra 2, cada uma amarrada a um item do backlog. Nenhuma das 73 removidas exigiu API nova da
  TreeUI — todas eram expressáveis com o que já existia:
  `style="flex:N"` → `TStackItem :grow basis="0"` (24×), `text-decoration:none` → `TLink
  underline="none"` / `TButton as="a"` (15×), `font-size` → `TText size` (9×), `min-width` →
  `TStackItem min-width` (6×), `font-weight` → `TLink weight` (5×), `<p>` cru → `TText as="p"
  measure="prose"`.
- **Padding duplicado, 11×.** Um `<div style="padding-top:1rem">` como filho único de `TTabPanel`
  somava ao `padding: var(--tree-space-4) 0` que o próprio painel já aplica: **2rem em vez de 1rem**,
  em Lambdas, DynamoDB e Filas. As onze `div` saíram.
- **Seis props que não existem, 19 ocorrências.** `TTag clickable` (9×), `TStat :hint` (4×),
  `TInput :label` (2×), `TButton tone` (2×), `TCheckbox :label` (1×), `TConfirmDialog tone` (1×).
  O Vue aceita todas em silêncio; duas matavam nome acessível e uma matava copy traduzida nos três
  idiomas. É a origem da regra "confira no `.d.ts`" no passo 2 do fluxo abaixo, e do TREEUX-008.
- **Cinco glifos Unicode fazendo papel de ícone** (`⚠` ×2, `✕`, `✓`, `→`) viraram `TIcon` ou saíram.
  A regra 3 já os proibia e este documento os dava como migrados desde 0.22 — não estavam.
- **Ganhos do 0.27 adotados:** `TAppShell skipLinkLabel` — **o app não tinha skip link nenhum**, e a
  mesma mudança levou ao `t()` as cinco strings de a11y da shell, que eram os defaults ingleses da
  lib (`"Open menu"`, `"Sidebar"`, …); `TTag tone`, que aposentou um `TBadge tone="danger"` intruso
  no meio de uma fileira de `TTag` no `ActivityPanel` (a troca de componente só existia porque o
  `TTag` não tinha eixo de cor); `TTag removeLabel`, que torna localizável o nome acessível do `x`.
- **Dois tokens escritos errado**, silenciosamente caindo no fallback: `--tree-font-mono` (o token é
  `--tree-font-family-mono`) e `--tree-color-border` (é `--tree-color-border-default`, e o fallback
  `#e5e7eb` renderizava claro no tema escuro).
- **Um bug de tema global:** o `body { font-family: … 'Segoe UI' … }` do `style.css` do produto vencia
  o da TreeUI (o `main.ts` importa a folha da lib **antes** da nossa) e, como nenhuma regra
  `.t-modal*` declara família e o `TModal` usa `Teleport`, **todo conteúdo de modal renderizava em
  Segoe UI**. A declaração saiu: `html` já recebe `--tree-font-family-sans` da própria lib.
- **Uma regressão declarada, não mascarada:** três CTAs que eram `<RouterLink><TButton/></RouterLink>`
  (`<a><button>` aninhado, markup inválido, dois tab stops, mais `text-decoration:none`) viraram
  `<TButton @click="router.push(…)">`. Ganhamos markup válido; **perdemos ctrl/meio-clique e "abrir
  em nova aba"**. Reimplementar o guard de modificadores do `RouterLink` à mão seria a versão local
  silenciosa da lacuna que a regra 2 proíbe — então foi registrada como **TREEUX-007**.
  *(Desfeita na rodada seguinte: o `TButton to` saiu na 0.28.0 e os CTAs voltaram a ser `<a>` de
  verdade — ver a seção 0.28.0 abaixo. O parágrafo fica porque o padrão vale: quando a saída certa
  não existe, a escolha se declara, não se disfarça.)*
- **Não adotamos** `TTagInput` nem `TKeyValueEditor`, apesar de terem sido entregues nesta faixa de
  versões: os dois falharam na validação contra o caso real (TREEUX-001 e TREEUX-002). Adotar
  qualquer um exigiria um contorno no consumidor, que é justamente o que este contrato não permite.
- Gate `validate: pre-prod` verde: lint **0 erros** (2181 warnings, abaixo do baseline), os quatro
  typechecks, `vue-tsc` limpo, **2601 testes / 100% de cobertura**, build.

## Adoção — `@treeui/vue` 0.28.0: os dois editores e o fim da tipografia local (2026-08-05)

Segunda rodada no mesmo dia. A 0.28.0 trouxe as correções dos dois componentes que tínhamos
**rejeitado na validação** e mais cinco eixos; adotamos tudo.

- **O dashboard passou a editar `packageArgs` e os tokens de cor.** Eram os dois alvos que os
  TREEUX-001 e 002 perseguiam desde o começo, e ambos exigiam correção na lib antes de existirem:
  - `packageArgs` ganhou um `TTagInput` com `:allow-duplicates="true"` e `:separator="null"`. **Os
    dois são obrigatórios e o motivo é o produto, não o gosto**: a lista é appendada verbatim ao
    `argv` de um `spawn()`, então repetir `--param` é significativo e `--param=tags=a,b` precisa
    continuar sendo um argumento só.
  - `branding.colors`, `branding.themeColors.dark` e `branding.themeColors.light` ganharam três
    `TKeyValueEditor`, e o card Branding deixou de ser file-only para tokens de cor (logo e favicon
    continuam). O `LssConfigUpdate` do dashboard foi alargado para aceitá-los — o servidor já
    aceitava desde antes.
  - **Duas armadilhas do nosso próprio backend, agora documentadas no código**: o `PUT /api/config`
    faz merge de um nível só, então `themeColors` é **substituído inteiro** e o formulário tem de
    mandar os dois temas juntos; e remover uma chave é mandar o mapa completo sem ela, porque `null`
    por chave é recusado com 400.
- **A tipografia local acabou.** `TLink` ganhou `family`/`size` e `TTextarea` ganhou `family`
  (TREEUX-005), então a classe `.mono` saiu do `src/ui/src/style.css`. **O produto não tem mais
  nenhuma classe de tipografia própria** — que era o alvo declarado desde a primeira rodada. O
  `style.css` ficou em três regras: reset de margem/padding, cor e `line-height` do `body`.
- **A regressão da rodada anterior foi desfeita.** `TButton to` (TREEUX-007) chegou, e os CTAs de
  navegação voltaram a ser `<a>` de verdade — com ctrl/meio-clique, "abrir em nova aba" e papel
  `link`. A revisão encontrou mais dois sítios do mesmo padrão que a rodada anterior não tinha
  listado; foram junto. Consequência correta e registrada: **Espaço deixa de ativá-los**, porque é
  assim que um link se comporta.
- **Identidade e rotulagem de formulário** (TREEUX-009): `TCheckbox` ganhou `label`, o `TFormField`
  passou a gerar o `id` e provê-lo ao controle — os ids escritos à mão saíram do `BucketDetail` — e
  o item de `TDropdown` ganhou `selected`, que virou `role="menuitemradio"` + `aria-checked` no
  seletor de idioma. **O ícone do item não foi adotado**: a calha não é reservada e o menu desalinha
  quando só alguns itens têm ícone (TREEUX-014).
- **O ARN quebra** (TREEUX-006) e **o slot `#icon` herda a escala do `TTag`** (TREEUX-010): saíram o
  último `style` de tipografia e os quatro `size="14"` mágicos.
- **`strictTemplates` continua desligado, e agora com motivo escrito.** A 0.28.0 trouxe um augment de
  `GlobalComponents` para o `vue-tsc` pegar prop inexistente — o conserto que pedimos no TREEUX-008.
  Ele só age com `vueCompilerOptions.strictTemplates: true`, e medimos o que acontece ao ligar:
  **89 erros, 2 reais e 87 falsos positivos** (`aria-label` e atributo nativo em componente com
  `inheritAttrs: false`, `modelModifiers` não declarado, `modelValue` largo emitindo para ref
  estreita). Não vamos remover nome acessível para satisfazer typecheck. A decisão e os números
  estão em `src/ui/tsconfig.json`, e o que falta virou TREEUX-011.
- **Uma regressão da lib, reportada:** o `TFormField` da 0.28 emite `for` **sempre**, mas só cinco
  controles adotam o id gerado — `TSelect` não. Três campos ficaram com `<label for>` apontando para
  um id inexistente. Não corrigimos localmente (seria reintroduzir exatamente o que o TREEUX-009
  matou); virou TREEUX-012.
- Gate `validate: pre-prod` verde: lint **0 erros** (2160 warnings, abaixo do baseline), os quatro
  typechecks, `vue-tsc` limpo, **2601 testes / 100% de cobertura**, build.

**Placar do CSS local nas duas rodadas:** 79 `style` inline em 18 arquivos → **5 em 3 arquivos**,
todos na tabela de exceções da regra 2; um `<style scoped>`, também na tabela; e zero classe de
tipografia no produto.

## Fluxo para novas solicitações

1. Registrar a orientação neste documento se for uma regra transversal.
2. Verificar a API pública da versão instalada da TreeUI — **lendo os `.d.ts` de
   `node_modules/@treeui/vue/dist/components/`**, não de memória nem do que um documento afirma.
   Prop que não existe é descartada em silêncio pelo Vue: já perdemos copy traduzida assim
   (`TStat :hint`) e carregamos uma prop inexistente por três minors (`TTag clickable`).
3. Compor a solução com componentes existentes quando a API já for suficiente.
4. Registrar em [`treeUxPatterns.md`](./treeUxPatterns.md) somente o que realmente pertence à TreeUI.
5. Sincronizar o arquivo com a TreeUI e responder no próprio item às perguntas/refutações do agente
   da biblioteca.
6. Validar no produto toda API entregue pela TreeUI; se aceita, consumir a API oficial e **remover**
   o item. Se recusada, registrar a réplica e sincronizar de novo.
7. Validar comportamento, acessibilidade, responsividade e telas largas — e passar o gate
   `validate: pre-prod` do repositório (lint, `vue-tsc`, build).

## Situação inicial observada — snapshot de 2026-07-21 (histórico, **não** é o estado atual)

> Esta seção é o diagnóstico que abriu o trabalho. Ficou aqui porque explica *por que* as regras
> existem — mas é uma foto de 2026-07-21, e quase tudo nela já foi resolvido. **Não use como
> inventário de pendências**: um agente que a leia como estado atual refaz trabalho feito. O que
> ainda está aberto vive em [`treeUxPatterns.md`](./treeUxPatterns.md) e nas seções de adoção acima.

- Único frontend: `src/ui/`, então sobre `@treeui/vue@0.14.0`. Catálogo Branchline com 364 ícones.
- Havia CSS local legado a migrar: `style.css` global (`muted`, `mono`, `logs-pre`, `brand-logo`,
  `dim-row`, `app-main`) e dois `<style scoped>` (`OverviewPage` hero, `SecretsList`).
  *Hoje: resta um só `<style scoped>` (`OverviewPage`, exceção #3 da regra 2) e nenhuma classe de
  tipografia — `.mono` saiu com a 0.28.0.*
- Tipografia era feita com CSS: `class="muted"` (74×), `class="mono"` (39×), `muted mono` (14×) e
  `style="font-size:…"`. *Hoje: zero classe de tipografia — texto usa `TText family="mono"`, link
  usa `TLink family="mono"` e textarea usa `TTextarea family="mono"`.*
- Vários glyphs Unicode faziam papel de ícone (`⚡ ⏳ → ← ▶ ▼ ⋮ ⚠ …`) e emojis marcavam tipos de
  recurso em `ServicesList.vue`. *Hoje: migrados para `TIcon` e para as marcas `aws-*`.*
- Blocos `<pre>` / `.logs-pre` (9×) exibiam logs/código sem componente dedicado, e havia um
  `<textarea>` cru em `BucketDetail.vue`. *Hoje: `TCodeBlock` e `TTextarea`.*
- O `main` já era full-width; o ponto de compressão do LSS era o header (corrigido).
