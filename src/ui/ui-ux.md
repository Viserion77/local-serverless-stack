# UI and UX contract for the LSS dashboard

## Purpose

This is the **living** UI and UX contract for the Local Serverless Stack frontend — the Vue 3
dashboard in `src/ui/`. It records the visual decisions the product must follow, and it is updated
whenever new UI or UX guidance is given.

Gaps whose correct solution belongs to the component library (**TreeUI**, `@treeui/vue`) are taken
to the library and solved there. The consuming app must **not** silently implement a local version
of those gaps.

> Repository context: LSS has **one** frontend (`src/ui/`). TreeUI lives in **another repository**
> and is consumed through `@treeui/vue@0.29.0` (`@treeui/icons@0.29.0`, `@treeui/utils@0.29.0`,
> `@treeui/tokens@0.28.0`) — **upgraded 0.25.0 → 0.27.0 → 0.28.0 → 0.29.0 between 2026-08-05 and
> 06**, which in turn came from 0.14.0 on 2026-07-21. The library exposes **95 components** and a
> **Branchline catalogue of 364 icons**. Since 2026-07-31 that catalogue is extended **by the app**:
> 64 official AWS service marks (`aws-*`) enter the same registry through `registerAwsIcons()` — the
> registry stopped being TreeUI-only, its catalogue has not (see rule 3).
>
> **Version numbers live here and nowhere else.** A version pinned inside a rule or a process step
> is born wrong at the next bump — which is exactly what happened to the line that said
> `@treeui/tokens@0.15.0` for four minors.

## Initial direction — 2026-07-21

The work started with the LSS dashboard and these goals:

- study the application's UI and UX (Overview, Services, Lambdas, APIs, Queues, S3, DynamoDB,
  OpenSearch, Secrets);
- make the home (Overview) complete, clean and understandable at a glance;
- make good use of large monitors, instead of squeezing the content into a central column
  surrounded by large grey areas;
- adopt TreeUI as the single source of components, icons and visual decisions;
- keep TreeUI and the dashboard aligned by taking every gap to the library, rather than
  accumulating local CSS fixes.

The first concrete fix: the **`TAppShell` header** showed the brand and the controls stacked on the
left (see §4). It was corrected with TreeUI layout alone, with no new CSS.

## Mandatory rules

### 1. TreeUI is the single source of visual primitives

- Use only components and public APIs from `@treeui/vue` for controls, surfaces, typography,
  feedback, navigation and visual layout.
- Do not copy a TreeUI component into the product.
- Do not adopt a second component library alongside it.
- A local component may exist when it represents a **domain composition** or groups parts of one
  screen (e.g. `OverviewPage`, `ServicesList`). It must be composed of TreeUI and must not invent a
  visual language of its own.

### 2. Local CSS is not a layout-fixing tool

- Do not write CSS in the product to adjust width, alignment, spacing, responsiveness, density,
  typography, border, colour or visual state.
- Use TreeUI's props, slots and layout components: `TStack` (with `direction`/`gap`/`align`/
  `justify`/`wrap`), `TGrid` (`columns`/`gap`), `TContainer`, `TCard`, `TPage`, `TPageHeader`,
  `TDivider`, `TAppShell`.
- Do not override the library's internal selectors, including through `:deep(...)` or by
  overwriting `t-*` classes.
- Brands are no exception: the size and alignment of the AWS tiles (rule 3) are decided by TreeUI —
  `TIcon`'s `size` prop and the dimensions of the icon slots themselves (`.t-nav-menu__icon`,
  `TTag`/`TStat`/`TEmptyState`'s `#icon`). Adopting the AWS marks introduced no local CSS, no
  `:deep(...)` and no `t-*` class override.
- If the public API cannot express the required result, take the gap to TreeUI and solve it there.
- A temporary exception may only exist with explicit approval, a recorded reason, an owner and a
  removal condition. It does not become a precedent.

The CSS already present in `src/ui/` (the global `style.css` and `<style scoped>` blocks) is
**migration debt**, not permission to add more. Removal happens surface by surface, preserving
behaviour and accessibility.

#### Temporary exceptions in force

An exception exists only if it is **in this table**. Having the gap recorded with the library is not
enough: that record closes when the contract does, and an exception noted only there disappears with
it and turns into silent local CSS — precisely what rule 2 forbids.

| # | Surface | What it is | Reason | Owner | Removal condition |
|---|---|---|---|---|---|
| 1 | `pages/OverviewPage.vue` — `<style scoped> .overview-hero { background: linear-gradient(…) }` | The decorative gradient of the Overview hero | The last remnant of pre-migration CSS. 0.27's `THero` is a candidate, but it is a **`<section>` band with no card border** while the current hero is a `TCard variant="outline"` — swapping changes both appearance and container semantics | human (a design decision, not a refactor) | An explicit decision to adopt `THero` (or to keep the `TCard` and ask TreeUI for a decorative background axis) |
| 2 | `components/graph/graphCanvas.ts` — `canvas.style.width/height`, `host.style.overflowX/maxWidth`, `canvas.style.cursor` | Sizing the connection diagram's `<canvas>` (5 declarations, all **imperative and on an element the module creates and owns** — no stylesheet, no class, no `:deep`, no `t-*` selector) | TreeUI 0.29.0 **has no node-and-edge primitive** (`TChart` is categorical `number[]` aligned to `labels` with no slot inside the SVG; `TSpanLanes` is a 1-D bar inside a lane; `TTreeView` is a DOM list) and **no component has a prop that stretches a child**: `height` exists only on `TChart`/`TPane`/`TSkeleton`/`TEmptyState`/`TCodeBlock`/`TTag`. `useDecorativeCanvas` **measures** (`getBoundingClientRect`) but never sizes, is contractually `pointer-events: none`, exposes no `requestRedraw()` and is gated on `(pointer: coarse)`/reduced-motion — on a tablet it draws **one** frame and never repaints. A diagram whose nodes are click targets and whose data is refetched needs the opposite of all three. `cursor` is the one case where the affordance **cannot** come from CSS: the sensitive area is a rectangle inside the canvas and no stylesheet knows where it is | the LSS dashboard agent | TreeUI shipping a **node-and-edge primitive** — or an interactive canvas host with a height axis, `requestRedraw()` and hit-testing. Once the official API is adopted, this file loses the 5 declarations and the row leaves the table |

**Those are the two live exceptions.** The first is a pending design decision; the second is an API
gap, with an open item and a removal condition tied to it. Outside these two rows `src/ui/` has
**zero** inline `style` and **zero** `<style>` block — the product no longer writes CSS.

> **Why the canvas did not become a silent fallback.** Rule 1 allows a local component when it is a
> **domain composition**; `ServiceGraphCard.vue` is exactly that — `TCard`, `TTabs`, `TTable`,
> `TCheckbox`, `TBadge`, `TAlert`, `TEmptyState`, `TSpinner`, `TTag`, `TIcon`, and **not one** line
> of CSS. What the library does not have is only the **drawing surface**, and that stayed confined
> to two `.ts` modules (`graphLayout.ts`, pure; `graphCanvas.ts`, with the DOM), with the colours
> read from the `--tree-*` tokens through `getComputedStyle` — so the theme, `branding.colors` and
> the theme toggle still hold inside the drawing. The AWS marks are the vendored artwork, reproduced
> **unmodified** (uniform scaling only), as rule 3 and `NOTICE.md` require; the functional glyph
> that the `external` node would have needed was **not** hand-drawn — that node is labelled, not
> iconised, on the canvas.
>
> **Accessibility got no exception.** A canvas is opaque to a screen reader, and rule 6 puts that on
> the component. `TChart` solves it by emitting a visually hidden table; hiding one would require CSS
> the product cannot write, so the table became a **sibling tab** (`Connections`), carrying the same
> data in a `TTable`, translated into all three languages — and the `<canvas>` carries `role="img"`
> with an accessible name pointing at it.

*Left the table:*

- **2026-08-05** — `style="word-break:break-all"` on the ARN (`SecretsList`), thanks to `TText
  wrap="anywhere"` in `0.28.0` (TREEUX-006).
- **2026-08-06** — the **three** SVG-sizing `style`s in `ActivityPanel`, thanks to `TSpanLanes` and
  `TChart interpolation="step"` in `0.29.0` (TREEUX-003); and the **two**
  `style="cursor:pointer;…"` row affordances (`SecretsList`, `OpenSearchCollectionsList`), thanks to
  `rowTo`/`rowActivatable` in `0.29.0` (TREEUX-004).

An exception leaves here when the API arrives — over three rounds the table went from four rows to
one, and none of them left by giving up. That is the proof it is a commitment and not a dumping
ground.

### 3. Interface icons and brand marks come from different sources

- **Functional interface icons** — actions, navigation, status, objects and layout — come
  exclusively from TreeUI's official API (`TIcon`, icon slots, typed props).
- When a functional icon is missing, raise the need with TreeUI along with a suggested name and
  purpose. It must be created in TreeUI before it is consumed. **Forbidden**: emoji, Unicode
  characters (`⚡ ✓ ⏳ → ← ▶ ▼ ⋮ ⚠ …`), CSS drawings or hand-copied SVG used as an icon.
- **Brands and logos** of companies, products and services are **not** functional icons and do
  **not** belong in TreeUI's catalogue. In LSS that includes **AWS and its services** (DynamoDB, S3,
  SQS, SNS, Lambda, EventBridge, OpenSearch, Secrets Manager, API Gateway) and the **Serverless
  Framework**. (The **LocalStack** mark left this list on 2026-08-05: that engine stopped existing
  in the product at v1.0.0, when the self engine became the only one.)
- **AWS service marks** come from the official **AWS Architecture Service Icons** package
  ([`https://aws.amazon.com/architecture/icons/`](https://aws.amazon.com/architecture/icons/)), the
  size-**16** variant — whose `viewBox` is `0 0 24 24`, exactly the grid the Branchline icons are
  drawn on. The curated artwork is **vendored** in `src/ui/src/icons/aws/` (generated by
  `scripts/generate-aws-icons.mjs`, `npm run icons:aws`); the 41 MB package is not committed and the
  build does not depend on it. That is **guaranteed**, not requested: the unzip's default target
  (`temp/`) is in `.gitignore`, so no `git add -A` redistributes AWS's trademark from this public
  repository.
- Those marks are **registered in TreeUI's own registry** — `registerAwsIcons()` in `main.ts` (which
  internally calls the library's `registerTreeIcons()`), before `createApp`, plus a `TIconRegistry`
  augmentation (`registry.generated.d.ts`). Consumption is the same as for any library icon:
  `<TIcon name="aws-lambda" />`, `icon="aws-sqs"` on any `TIconInput` prop, typed by `vue-tsc`, with
  no per-call-site import and no local component.
- Why the official package and not Simple Icons for AWS: it is the **canonical** source (published
  by AWS itself), it covers **every** service — including the ones Simple Icons lacks (EventBridge,
  Secrets Manager, OpenSearch, Step Functions) — and it keeps one visual family (a category-coloured
  tile + glyph). The artwork is AWS's trademark and goes in **unmodified**: it is full-colour, does
  not use `currentColor` and deliberately does **not** follow the theme or the `branding.colors`
  overrides. "Fixing" that with CSS violates both rule 2 and the package's terms — see the
  directory's [`NOTICE.md`](./src/icons/aws/NOTICE.md).
- For **non-AWS** brands (today, only the Serverless Framework) the standard source remains
  [`https://simpleicons.org/`](https://simpleicons.org/) (or the official Simple Icons package),
  when the logo exists there.
- None of this is an exception to rule 3 — it **is** rule 3. A functional icon still comes only from
  TreeUI, and the `aws-` prefix is what keeps the two vocabularies apart inside the same registry: a
  name without a prefix is a functional TreeUI icon, `aws-*` is a brand. A brand never replaces an
  action, navigation or a status; a functional icon never replaces a brand. A missing brand does
  **not** become a request to TreeUI — it becomes a line in the generator's catalogue.
- Coverage registered today: **64 marks** — 12 for the services LSS ships (Lambda, DynamoDB, S3,
  SQS, SNS, EventBridge, OpenSearch, Secrets Manager, API Gateway, CloudFormation, IAM, CloudWatch)
  and 52 in reserve, already imported for future use. Two documented aliases, because AWS publishes
  no mark of their own: **STS uses the IAM mark** and **CloudWatch Logs uses CloudWatch's**.
- **Done** for the services list (`ServicesList.vue`): the resource-type emoji (`🪣 🗄 📨 📣 🎯 🔀`)
  had already become functional icons in the 0.14 → 0.22 sweep, and now the ones that represent **an
  AWS service** became brands. No generic glyph stands in for a service any more in
  `ServicesList.vue`, `ServiceDetailPage.vue`, `LambdasList.vue`/`LambdaDetail.vue` or the resource
  screens. The resource-type → brand map is single
  (`src/ui/src/icons/resourceIcons.ts`, keyed by the API contract's types), so a table and a detail
  screen cannot drift apart.

### 4. The AppShell hands over space; it does not decide on a narrow column

- `TAppShell`'s `main` must occupy the whole remaining viewport area and must not impose a
  `max-width`, centring or large outer gutters.
- Do not override `.t-app-shell__main` in the product.
- A limited reading width, where it makes sense, is a **semantic decision of the surface** expressed
  through TreeUI (e.g. `TContainer`/`TPage` with a width), not an indiscriminate default and not
  local CSS.
- On wide screens, prefer responsive grids (`TGrid`) and main/support splits to turn space into
  useful information.

The LSS diagnosis (TreeUI 0.14): `main` **already** is full-width — `t-app-shell__main` occupies the
grid's whole column and `.app-main` only applies page padding, with no `max-width`. Here the problem
was **not** the central column (as it is in other products) but the **header**: `TAppShell` wraps the
`#header` slot in a single `flex:auto` block (`.t-app-shell__header-content`, `display:block`), so
the brand and the controls, being two sibling blocks, **stacked**. The `.app-header-controls
{ margin-inline-start: auto }` that existed depended on the slot being a flex row — which had
stopped being true. The fix adopted: a single `TStack direction="horizontal"
justify="space-between"` as the slot's root, pinning the brand to the start and the controls to the
end, with no CSS. The component gaps this exposed (per-item width control in `TStack`; a native
two-region layout in `TAppShell`'s header) were taken to TreeUI.

### 5. The home is a decision view, not just a report

The Overview must let you quickly understand:

- whether the self engine is up and healthy;
- how many services/lambdas are running and how many routes/resources exist;
- the active configuration (region, endpoint, mode, auto-package, persistence);
- what LSS covers today, and the shortcut to each area;
- loading, empty and error states, unambiguously.

In LSS the current hierarchy is: brand header + status → context hero → server status and
configuration side by side → totals (`TStat`) → resource coverage.

### 6. States and accessibility are part of the component

- Every asynchronous fetch must present loading and error explicitly. The pattern is `TSpinner`
  inside a `TStack justify="center" align="center"` — the hand-rolled centring
  (`display:flex;justify-content:center`) that used to live here was eliminated in the 0.14 → 0.22
  sweep and must **not** come back.
- Empty states must explain the state and, where applicable, offer the next action (`TEmptyState`).
- Icon-only controls need an accessible name (`aria-label`).
- Focus order, focus return, `Escape` and touch targets must not depend on fragile fixes in the
  product — they belong to the TreeUI component.
- The LSS UI is **trilingual (en / pt-BR / es)**, with the catalogue in `src/ui/src/i18n/messages/`.
  Every interface string goes through `t()` — including the accessible name of an icon-only control
  and the `label` of a brand that appears on its own. AWS service names stay **untranslated**: that
  is what they are called in any console or SDK.
- Interface text must not be frozen outside a reactive/computed context when it depends on state —
  the same goes for switching language: a label read once in `setup` keeps the old language.

## First adoption — the LSS dashboard (0.14 → 0.22 upgrade + sweep, 2026-07-21…23)

We migrated `src/ui/` to TreeUI across `0.14 → 0.19 → 0.20 → 0.21 → 0.22`:

- **Typography:** ~197 `TText` (tone/size/weight/`family`) replacing `<span class="muted">`, styled
  `<strong>`, `style="font-size"` and `class="mono"`. The `.muted` class and the hardcoded `.mono`
  stack went away; text mono uses `TText family="mono"` (0.20). `.mono` survives only on the input
  `<textarea>`s (editable code, not a `TText`).
- **Icons:** ~24 `TIcon` replacing Unicode glyphs (`⚡→zap`, `⏳→clock`, `←→arrow-left`,
  `→→arrow-right`, `▶/▼→chevron-*`, `⋮→ellipsis-vertical`, `⚠→triangle-alert`, resource emoji →
  `database/inbox/megaphone/archive/shuffle/target`, Lambda → `code`). No local icon was created.
- **Header (`App.vue`):** the brand through `TBrandLockup` (0.21 — the `#logo` slot preserves the
  logo's aspect ratio, no cropping) in `#header-start`; the controls in `#header-end` (0.20); `⋮` →
  `TButton icon-only` + `TIcon`; the select's `min-width` → `TStackItem`.
- **Code/log blocks:** the 9 `<pre>` (service/Lambda logs, payloads, SQS message body, OpenSearch
  JSON, secret value) → `TCodeBlock` (0.21 — `wrap`/`copyable`/`max-block-size`).
- **Layout/state:** content inside `<TPage width="full">` (0.20, which retired `.app-main`); ~20
  loading states → `TStack justify/align="center"`; tables with `aria-label`; dimmed rows through
  `TTable rowState`/`rowKey` (0.20, which retired `.dim-row`) + a non-chromatic signal (a "seed
  only" tag).
- **Links:** ~8 `TLink` (`underline`/`weight`) + `TCard interactive` (0.20) replacing styled
  `RouterLink`/`<a>`; the `TTag`/`TButton`/toggle wrappers stay as they are.
- **Description lists:** the **22** label⟷value rows (Overview status/config + the detail screens)
  became **7** `TDescriptionList`/`TDescriptionItem` (0.22 — a real `<dl>`, label-above when narrow,
  an actions slot), retiring the interim `TStack + TText`.
- **The `validate: pre-prod` gate green:** lint 0 errors, `vue-tsc`, build, 2345 tests / 100%.

**TreeUI's backlog emptied in that round** — the twelve needs of that cycle were met across
`0.14 → 0.22`. The product's `style.css` was left with the reset + `.mono`; the only remaining
`<style scoped>` was the decorative `.overview-hero` gradient. Eliminated along the way: `.muted`,
`.app-main`, `.dim-row`, `.logs-pre`, `.brand-logo`, text mono and the manual label⟷value rows.

> **Careful with this paragraph's IDs.** That cycle's identifiers were removed when a delivery was
> accepted, and the numbering **was recycled** afterwards — the same ID meant two different things
> at different moments. That is why this paragraph describes the deliveries **by name**, with no ID.
> "Emptied" here does not mean empty today: there are still open gaps with the library.

## Adoption — AWS service marks (2026-07-31)

Applying rule 3 to the part that was missing: identify an AWS service by its official mark, not by a
generic glyph.

- **Source and vendoring:** 64 SVGs from the official package (the 16 variant, `viewBox 0 0 24 24`)
  converted by `scripts/generate-aws-icons.mjs` into `src/ui/src/icons/aws/artwork.generated.ts` +
  `registry.generated.d.ts`. The generator fails (it does not "fix") on a different `viewBox`,
  `<defs>`/`<use>`/gradients/`<style>`, an external reference or a painted element with no
  resolvable `fill` — the artwork must not be altered.
- **Registration:** `registerAwsIcons()` in `main.ts`, between `applyTheme(...)` and
  `createApp(App)`, once. Each mark is a component (the artwork has `<g>` with `fill`/`transform`,
  which the flat `TIconNodes` cannot express) stored verbatim by `registerTreeIcons`, honouring
  `TIcon`'s props (`size`/`strokeWidth`/`absoluteStrokeWidth`) and TreeUI's own defaults.
- **The split:** 12 *core* marks (the services LSS ships) already consumed in the UI; 52 in reserve,
  registered and ready (Step Functions, Kinesis, Cognito, KMS, ECS/EKS/Fargate, RDS/Aurora,
  CloudFront, Route 53, SES, X-Ray, Bedrock, IoT…), so the next resource does not fall back to an
  emoji.
- **Where they landed:** `App.vue`'s nav (all ten entries — without icons, a collapsed `TNavMenu`
  becomes four identical "S" tiles), the Overview's and the service detail's `TStat`, resource and
  trigger tags, card headers and the `TEmptyState` of the Lambdas, APIs, Queues, S3, DynamoDB,
  OpenSearch and Secrets screens.
- **Accessibility:** the marks are decorative (no `label`) because they always accompany the text
  that names the service. The exception is `ServicesList.vue`'s breakdown, where the tag shows only
  a mark + a number: there the mark sits in `TTag`'s default slot (`#icon` is `aria-hidden`) and
  gets a `label` with the existing i18n key, which also tells "buses" from "rules" when read aloud.
- **No new debt:** zero `<style>`, zero classes, zero `:deep(...)`, zero strings outside `t()`, zero
  new gaps taken to TreeUI — a brand never generates a request. The `validate: pre-prod` gate: lint
  0 errors, `vue-tsc` clean.

## Adoption — `@treeui/vue` 0.27.0 and paying off the local CSS (2026-08-05)

We went from `0.25.0` straight to `0.27.0` (skipping 0.26.0) and used the round to pay down rule 2's
debt, which had never been quantified.

- **Local CSS: 79 → 6.** There were **79** inline `style="…"` across **18** files plus one
  `<style scoped>`. **6 declarations in 3 files** survived, and all four surfaces are in rule 2's
  exception table, each tied to a backlog item. None of the 73 removed needed a new TreeUI API —
  every one was expressible with what already existed: `style="flex:N"` → `TStackItem :grow
  basis="0"` (24×), `text-decoration:none` → `TLink underline="none"` / `TButton as="a"` (15×),
  `font-size` → `TText size` (9×), `min-width` → `TStackItem min-width` (6×), `font-weight` →
  `TLink weight` (5×), a raw `<p>` → `TText as="p" measure="prose"`.
- **Doubled padding, 11×.** A `<div style="padding-top:1rem">` as the only child of a `TTabPanel`
  added to the `padding: var(--tree-space-4) 0` the panel already applies: **2rem instead of 1rem**,
  in Lambdas, DynamoDB and Queues. The eleven `div`s went.
- **Six props that do not exist, 19 occurrences.** `TTag clickable` (9×), `TStat :hint` (4×),
  `TInput :label` (2×), `TButton tone` (2×), `TCheckbox :label` (1×), `TConfirmDialog tone` (1×).
  Vue accepts every one of them silently; two killed an accessible name and one killed copy
  translated into all three languages. This is the origin of the "check the `.d.ts`" rule in step 2
  of the flow below, and of TREEUX-008.
- **Five Unicode glyphs acting as icons** (`⚠` ×2, `✕`, `✓`, `→`) became `TIcon` or were removed.
  Rule 3 already forbade them and this document claimed they had been migrated since 0.22 — they
  had not.
- **0.27 gains adopted:** `TAppShell skipLinkLabel` — **the app had no skip link at all**, and the
  same change moved the shell's five a11y strings into `t()`, where they had been the library's
  English defaults (`"Open menu"`, `"Sidebar"`, …); `TTag tone`, which retired a `TBadge
  tone="danger"` intruder in the middle of a row of `TTag`s in `ActivityPanel` (the component swap
  only existed because `TTag` had no colour axis); and `TTag removeLabel`, which makes the `x`'s
  accessible name localisable.
- **Two tokens written wrong**, silently falling back: `--tree-font-mono` (the token is
  `--tree-font-family-mono`) and `--tree-color-border` (it is `--tree-color-border-default`, and the
  `#e5e7eb` fallback rendered light in the dark theme).
- **One global theme bug:** the product `style.css`'s `body { font-family: … 'Segoe UI' … }` beat
  TreeUI's (`main.ts` imports the library's stylesheet **before** ours) and, since no `.t-modal*`
  rule declares a family and `TModal` uses `Teleport`, **every modal's content rendered in Segoe
  UI**. The declaration was removed: `html` already receives `--tree-font-family-sans` from the
  library itself.
- **One regression declared, not masked:** three CTAs that were `<RouterLink><TButton/></RouterLink>`
  (a nested `<a><button>`, invalid markup, two tab stops, plus `text-decoration:none`) became
  `<TButton @click="router.push(…)">`. We gained valid markup; **we lost ctrl/middle-click and "open
  in a new tab"**. Reimplementing `RouterLink`'s modifier guard by hand would have been the silent
  local version of the gap rule 2 forbids — so it was filed as **TREEUX-007**. *(Undone in the next
  round: `TButton to` shipped in 0.28.0 and the CTAs went back to being real `<a>`s — see the 0.28.0
  section below. The paragraph stays because the pattern holds: when the right way out does not
  exist, the choice is declared, not disguised.)*
- **We did not adopt** `TTagInput` or `TKeyValueEditor`, despite both shipping in this version
  range: they failed validation against the real case (TREEUX-001 and TREEUX-002). Adopting either
  would have required a workaround in the consumer, which is exactly what this contract forbids.
- The `validate: pre-prod` gate green: lint **0 errors** (2181 warnings, below the baseline), all
  four typechecks, `vue-tsc` clean, **2601 tests / 100% coverage**, build.

## Adoption — `@treeui/vue` 0.28.0: the two editors and the end of local typography (2026-08-05)

A second round on the same day. 0.28.0 brought the fixes for the two components we had **rejected at
validation** plus five more axes; we adopted all of it.

- **The dashboard can now edit `packageArgs` and the colour tokens.** These were the two targets
  TREEUX-001 and 002 had been chasing from the start, and both needed a library fix before they
  could exist:
  - `packageArgs` got a `TTagInput` with `:allow-duplicates="true"` and `:separator="null"`. **Both
    are mandatory and the reason is the product, not taste**: the list is appended verbatim to a
    `spawn()`'s `argv`, so repeating `--param` is meaningful and `--param=tags=a,b` has to stay a
    single argument.
  - `branding.colors`, `branding.themeColors.dark` and `branding.themeColors.light` got three
    `TKeyValueEditor`s, and the Branding card stopped being file-only for colour tokens (logo and
    favicon remain). The dashboard's `LssConfigUpdate` was widened to accept them — the server
    already did.
  - **Two traps in our own backend, now documented in the code**: `PUT /api/config` merges one level
    only, so `themeColors` is **replaced wholesale** and the form has to send both themes together;
    and removing a key means sending the complete map without it, because a per-key `null` is
    refused with a 400.
- **Local typography is gone.** `TLink` got `family`/`size` and `TTextarea` got `family`
  (TREEUX-005), so the `.mono` class left `src/ui/src/style.css`. **The product no longer has any
  typography class of its own** — the declared target since the first round. `style.css` is down to
  three rules: the margin/padding reset, and the `body`'s colour and `line-height`.
- **The previous round's regression was undone.** `TButton to` (TREEUX-007) arrived, and the
  navigation CTAs went back to being real `<a>`s — with ctrl/middle-click, "open in a new tab" and
  the `link` role. The review found two more sites of the same pattern the previous round had not
  listed; they went along. A correct, recorded consequence: **Space no longer activates them**,
  because that is how a link behaves.
- **Form identity and labelling** (TREEUX-009): `TCheckbox` got `label`, `TFormField` started
  generating the `id` and providing it to the control — the hand-written ids left `BucketDetail` —
  and the `TDropdown` item got `selected`, which became `role="menuitemradio"` + `aria-checked` in
  the language picker. **The item icon was not adopted**: the gutter is not reserved and the menu
  misaligns when only some items have an icon (TREEUX-014).
- **The ARN wraps** (TREEUX-006) and **the `#icon` slot inherits `TTag`'s scale** (TREEUX-010): the
  last typography `style` and the four magic `size="14"`s went.
- **`strictTemplates` stays off, and now with a written reason.** 0.28.0 brought a `GlobalComponents`
  augment so `vue-tsc` catches a nonexistent prop — the fix we asked for in TREEUX-008. It only acts
  with `vueCompilerOptions.strictTemplates: true`, and we measured what happens when it is on: **89
  errors, 2 real and 87 false positives** (`aria-label` and a native attribute on a component with
  `inheritAttrs: false`, an undeclared `modelModifiers`, a wide `modelValue` emitting into a narrow
  ref). We are not removing an accessible name to satisfy a typecheck. The decision and the numbers
  are in `src/ui/tsconfig.json`, and what remains became TREEUX-011.
- **One library regression, reported:** 0.28's `TFormField` emits `for` **always**, but only five
  controls adopt the generated id — `TSelect` does not. Three fields were left with a `<label for>`
  pointing at a nonexistent id. We did not fix it locally (that would reintroduce exactly what
  TREEUX-009 killed); it became TREEUX-012.
- The `validate: pre-prod` gate green: lint **0 errors** (2160 warnings, below the baseline), all
  four typechecks, `vue-tsc` clean, **2601 tests / 100% coverage**, build.

**Local CSS scoreboard across the two rounds:** 79 inline `style`s in 18 files → **5 in 3 files**,
all in rule 2's exception table; one `<style scoped>`, also in the table; and zero typography
classes in the product.

## Adoption — `@treeui/vue` 0.29.0: local CSS is gone (2026-08-06)

TreeUI emptied the whole queue in one version. We adopted everything, and the result is that **the
product no longer writes CSS**: of rule 2's four exceptions, one remains, and it is a design
decision, not an API gap.

- **`packageEnv` became editable from the dashboard — and that needed server work.**
  `TKeyValueEditor mode="secret"` does half the screen (the row shows the key plus a `•••` state,
  never the value, which still never leaves the process). The other half was ours: `PUT /api/config`
  treated `packageEnv` as a wholesale replacement, which is incompatible with write-only — the
  client only receives `packageEnvKeys`, so it cannot resend the whole map. It is now a **per-
  variable patch** (a string sets, `null` removes, a top-level `null` clears the block), globally and
  per service, with the injection-key screen (`NODE_OPTIONS`, `LD_PRELOAD`, …) intact and tested
  against case variation.
- **`ActivityPanel` stopped drawing SVG.** `TChart interpolation="step"` for the parallelism area —
  and with a real `step` the code stopped emitting two points per bucket to fake the stair — and
  `TSpanLanes` for the lanes. The non-chromatic failure marker improved along the way: the old mark
  was red on a red bar; it is now an icon in `currentColor`.
- **Table rows became real targets.** `rowTo` where activation is a route (DynamoDB, OpenSearch) and
  `rowActivatable` + `@row-activate` where it is a modal (Secrets, the item explorer) — the
  distinction four screens had been guessing at. And the Queues' message detail became a `<tr>`
  adjacent to its own row, instead of stacking below the whole table.
- **Quiet destructive buttons are quiet again.** `TButton tone` arrived orthogonal to `variant`,
  `variant="danger"` is deprecated, and the two sites that had `ghost tone="danger"` hand-written
  with the dead prop now really have it.
- **`TSelect` started adopting `TFormField`'s id**, which fixed three orphaned `<label for>`s
  **without a line from us** — the regression we reported in the previous round.
- **`strictTemplates` stays off, and now with numbers from two versions.** 0.28.0 gave 89 errors;
  0.29.0 gives **50**. Two of the three groups closed. What remains is 33 from the wide `modelValue`
  (a repro handed to TreeUI) and 17 from an HTML attribute *of the element* — `min` on an
  `<input type="number">`, 15 times. We are not stripping `min` from a numeric field to satisfy a
  typecheck.
- The `validate: pre-prod` gate green: lint **0 errors**, all four typechecks, `vue-tsc`, **2662
  tests / 100% coverage**, build.

**Three rounds, one scoreboard:** 79 inline `style`s in 18 files → **zero**; one decorative
`<style scoped>`; no typography classes; and a backlog that went from 10 items to 4, none of them
closed by giving up.

## Flow for new requests

1. Record the guidance in this document if it is a cross-cutting rule.
2. Check the public API of the installed TreeUI version — **by reading the `.d.ts` files in
   `node_modules/@treeui/vue/dist/components/`**, not from memory and not from what some document
   claims. A prop that does not exist is discarded silently by Vue: we have already lost translated
   copy that way (`TStat :hint`) and carried a nonexistent prop for three minors (`TTag clickable`).
3. Compose the solution from existing components when the API is already sufficient.
4. Take to TreeUI only what genuinely belongs to it, with the need, the evidence (file:line and a
   count) and an exit criterion — and answer the library's questions or rebuttals.
5. Validate every API TreeUI delivers against the product; if accepted, consume the official API and
   remove the corresponding exception. If rejected, reply with what was measured on the real case.
6. Validate behaviour, accessibility, responsiveness and wide screens — and pass the repository's
   `validate: pre-prod` gate (lint, `vue-tsc`, build).

## Initial situation observed — a 2026-07-21 snapshot (historical, **not** the current state)

> This section is the diagnosis that opened the work. It stayed because it explains *why* the rules
> exist — but it is a photograph from 2026-07-21, and almost everything in it has been resolved.
> **Do not use it as a list of pending work**: an agent that reads it as the current state redoes
> finished work. What is still open lives in the adoption sections above.

- A single frontend: `src/ui/`, then on `@treeui/vue@0.14.0`. A Branchline catalogue of 364 icons.
- There was legacy local CSS to migrate: the global `style.css` (`muted`, `mono`, `logs-pre`,
  `brand-logo`, `dim-row`, `app-main`) and two `<style scoped>` blocks (`OverviewPage`'s hero,
  `SecretsList`). *Today: one `<style scoped>` remains (`OverviewPage`, rule 2's exception #3) and
  no typography class — `.mono` left with 0.28.0.*
- Typography was done with CSS: `class="muted"` (74×), `class="mono"` (39×), `muted mono` (14×) and
  `style="font-size:…"`. *Today: zero typography classes — text uses `TText family="mono"`, links
  use `TLink family="mono"` and textareas use `TTextarea family="mono"`.*
- Several Unicode glyphs acted as icons (`⚡ ⏳ → ← ▶ ▼ ⋮ ⚠ …`) and emoji marked resource types in
  `ServicesList.vue`. *Today: migrated to `TIcon` and to the `aws-*` marks.*
- `<pre>` / `.logs-pre` blocks (9×) displayed logs/code with no dedicated component, and there was a
  raw `<textarea>` in `BucketDetail.vue`. *Today: `TCodeBlock` and `TTextarea`.*
- `main` was already full-width; LSS's compression point was the header (fixed).
