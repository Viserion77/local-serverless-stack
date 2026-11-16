# PRD — Stack map: an architecture diagram derived from CloudFormation, plus clickable README cards

| | |
|---|---|
| **Status** | Ready for implementation |
| **Date** | 2026-11-15 |
| **Area** | `service-graph.ts`, a new stack-graph route, the dashboard graph (`src/ui/src/components/graph/**`), README + docs assets |
| **Branch** | `feat/stack-map` |
| **Release** | minor — `1.4.0 → 1.5.0` (third of three planned PRs; see §10) |
| **Related docs** | [FEATURES.md](FEATURES.md) (*Service wiring graph*), [`src/ui/ui-ux.md`](../src/ui/ui-ux.md) |

---

## 1. Context

LSS already derives a **wiring graph per service** (`GET /api/services/:name/graph`,
`service-graph.ts`) from the packaged template plus registration metadata, and draws it on a canvas
in the service detail screen. It answers *what is connected to what, and on what evidence* — but it
reads as a dependency graph, not as an architecture diagram:

- boxes are uniform 208 × 48 rectangles with a label; nothing tells a route-backed Lambda from a
  queue consumer, or a table that is read from one that is written to;
- links are curves between layers, so a dense service turns into a hairball;
- there is no view of the **whole stack** — the cross-service links, the reason a monorepo wants one
  stack, are only visible as `external` stubs on each service's own graph.

The target is the kind of diagram a team draws by hand for its platform: callers on the left, the
platform boundary in the middle with the API in front, functions as cards that carry their route
(`GET /v1/orders/{id}`), data stores as cards with read/write direction on their links, every queue
with its DLQ tucked underneath, third-party HTTP dependencies on the right, orthogonal (right-angle)
connectors, and a legend. **The constraint that makes it interesting: everything must be derived
programmatically from the CloudFormation JSON** (plus the `serverless-state.json` LSS already reads)
— no hand-placed coordinates, no annotations in the user's templates.

A second, smaller ask rides along: the README should open with **clickable SVG cards** (icon, title,
a monospace subtitle, a chevron) that link into the docs and to each emulated service's section —
the "start here" grid many repositories use, generated rather than hand-drawn.

## 2. Goals

1. **Richer, still declared-only graph model.** Classify every edge's direction (read / write / invoke
   / publish / consume / trigger) and give every node the facts a card needs — all from the template.
2. **Stack-level graph.** One payload for every registered service, with cross-service references
   resolved into real edges between services.
3. **Architecture layout.** Zones, service group frames, DLQ-under-queue, crossing reduction and
   orthogonal routing with non-overlapping channels — deterministic, so a 10 s refetch never shuffles
   the picture.
4. **Card rendering** on TreeUI's `TCanvasSurface`, with pan/zoom, focus-on-hover, a legend, and the
   accessible table kept.
5. **SVG export** of any graph, used once to put the example stack's map in the README.
6. **README cards**: a generated, tested set of SVG link cards.

### Non-goals (explicitly deferred)

- **Live animation and per-request tracing** (a waterfall of the SDK calls one request made, nodes
  pulsing while processing). It needs request-id propagation through every SDK call the runtime
  makes — a feature on its own. This PR leaves the hooks (node ids are stable, a `live` overlay layer
  exists) and shows only counters LSS **already** exposes.
- Manual node placement / saved layouts.
- Editing infrastructure from the diagram.

## 3. Graph model v2 — `src/server/services/service-graph.ts`

Additive changes only; the existing payload stays valid for old dashboards and the MCP tool.

### 3.1 Edge direction from IAM actions (pure CFN)

Add `access?: 'read' | 'write' | 'readwrite' | 'invoke' | 'publish' | 'consume' | 'trigger'` to
`GraphEdge`. Derived from a single classification table (exported and unit-tested), e.g.:

| Service prefix | read | write | other |
|---|---|---|---|
| `dynamodb:` | `GetItem`, `BatchGetItem`, `Query`, `Scan`, `SearchVectors`, `DescribeTable` | `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `TransactWriteItems` | `*` / mixed → `readwrite` |
| `s3:` | `GetObject*`, `ListBucket` | `PutObject*`, `DeleteObject*` | |
| `sqs:` | — | — | `SendMessage*` → `publish`; `ReceiveMessage`/`DeleteMessage` → `consume` |
| `sns:` / `events:` | — | — | `Publish` / `PutEvents` → `publish` |
| `secretsmanager:` / `ssm:` | `GetSecretValue`, `GetParameter*` | `PutSecretValue`, `PutParameter` | |
| `lambda:` | — | — | `InvokeFunction` → `invoke` |
| `aoss:` / `es:` | `ESHttpGet`, `APIAccessAll` (→ `readwrite`) | `ESHttpPut`/`Post`/`Delete` | |

Structural edges get their access from their kind (`http-route` → `invoke`, `event-source` →
`trigger`, `s3-notification` → `trigger`, `sns-subscription` → `trigger`, `redrive` → `publish`).
`env` edges keep `confidence: 'inferred'` and get no access.

### 3.2 Card facts per node

Add `facts?: Record<string, string | number | boolean>` (display-only, small):

- **lambda**: runtime, timeout, memory, and its **routes** (`[{method, path}]`) — so the card can show
  `GET /v1/orders/{id}` without a separate route box. Route nodes stay in the payload for the
  existing table and for the MCP tool; the new layout folds them into the API node + the function card.
- **dynamodb**: key schema (`pk`/`sk` names), GSI count, stream view type, TTL attribute, vector-index
  count (PR A ships the property — read it from the raw template so this PR doesn't depend on A).
- **sqs**: FIFO, visibility timeout, `maxReceiveCount`, `dlqOf` (the source queue's node id).
- **s3**: notification event names. **eventbus/rule**: pattern summary. **secret**: none.
- **api** (new kind): one node per API (`AWS::ApiGatewayV2::Api`, `AWS::ApiGateway::RestApi`, or the
  implicit Framework API), with route count and authorizer names.
- **web-function** (new kind, only once the Lambda Web Functions PR has merged): runtime, endpoint
  names, revision count.

### 3.3 External HTTP dependencies

An environment value that is an absolute `http(s)://` URL whose host is not LSS (not `localhost` /
the orchestrator / a 30xx-130xx port) becomes an `external` node with `service: 'http'` and the host as
label — the "third-party provider" box. Still `inferred`, still one node per host.

### 3.4 Group membership

`GraphNode.group?: string` — the owning service (and `external` for externals), which the layout
turns into frames. Single-service graphs set it too, so one layout code path serves both.

## 4. Stack graph — new route `GET /api/stack/graph`

- Build each registered service's graph (reuse `buildServiceGraph`), then **resolve** every `external`
  node whose ARN / physical name matches a resource another service declares — the same index behind
  `GET /api/resources/owners` — into a `cross-service` edge between the two real nodes.
  Unresolved externals stay external.
- Query `?expand=<svc>,<svc>`: services not listed are **collapsed** to one `service` node carrying
  aggregate counts (`lambdas: 58, tables: 9, queues: 6…`) and aggregated cross-service edges with a
  `weight`. Default: everything collapsed when there are more than 8 services, everything expanded
  otherwise.
- Scale budget (40 services × ~60 lambdas × ~10 tables): collapsed payload ≤ 200 KB, response ≤ 300 ms
  on the reference machine; an expanded single service unchanged from today. Add a unit benchmark with
  a synthetic 40-service fixture asserting node/edge counts and a generous time bound.
- Client: `client.stack.graph({ expand })`; MCP: `lss_stack_graph`.

## 5. Layout v2 — `src/ui/src/components/graph/graphLayout.ts` (pure)

Keep the module pure and synchronous (it is the unit under test). Pipeline:

1. **Zones** (columns): *entry* (api, schedules, external callers) → *compute* (lambda, web-function)
   → *data & messaging* (dynamodb, s3, sqs, sns, eventbus, opensearch, secret) → *external*. Within
   *compute* and *data*, keep the current longest-path layering (and its IAM-role handling) to order
   sub-columns along causality.
2. **Groups**: nodes of one service are laid out inside a frame; frames stack vertically in the
   stack view; externals share one right-hand column outside every frame.
3. **Crossing reduction**: barycenter ordering, a fixed number of down/up sweeps (e.g. 8), ties broken
   by `(kind rank, label)` so the result is stable across refetches.
4. **Constraints**: a DLQ is placed directly below the queue it serves; a function's API stays at the
   top of the entry column; the role hub (when drawn) sits between compute and data.
5. **Coordinates**: variable card heights (a card with three routes is taller); compact row packing.
6. **Orthogonal routing**: every edge leaves its source's right side and enters the target's left
   side through **ports** spread along the side; between two columns it runs in a vertical **channel**,
   and channels are assigned by interval colouring so parallel edges never overlap. Back-edges (target
   at or left of source) route around the column top. Edges with the same source port and kind bundle.
7. **Budget**: ≤ 50 ms for 600 nodes / 1 500 edges, asserted in a unit test.

Recommendation: implement in-house. ELK (`elkjs`) would do it but adds ~1.4 MB, EPL-2.0 notice
obligations and an async worker to a pure module; revisit only if crossing quality is unacceptable on
the bundled examples.

## 6. Rendering — `graphCanvas.ts` + `ServiceGraphCard.vue` + a new stack page

- **Adopt `TCanvasSurface` / `useCanvasSurface`** from `@treeui/vue` (published in the 0.34 line;
  the dashboard is on `^0.31.0`). It owns sizing, device-pixel ratio, coalesced `requestRedraw()`,
  `toCanvasPoint()` hit-testing, a `cursor` prop and an accessible default slot rendered inside the
  `<canvas>`. Adopting it removes the canvas width/height and cursor declarations from rule 2's
  exception table in `src/ui/ui-ux.md`; implementing pan/zoom **inside** the surface removes the
  host `overflowX`/`maxWidth` pair as well — then delete the table row (or shrink it to whatever truly
  remains) in the same PR.
- **Cards** (all colours from TreeUI tokens via `getComputedStyle`, icons from the vendored AWS
  Architecture set, reproduced unmodified): icon tile · monospace title · subtitle chip (method colour
  + path for functions; key schema for tables; `FIFO` / `DLQ` for queues) · optional counters row.
- **Frames** with the service name; the **API** node at the frame's top-left.
- **Edges**: solid = synchronous (invoke / http-route), dashed = asynchronous (trigger / publish /
  consume), arrowhead direction from `access` (read points **at the function**, write points **at the
  store**), `inferred` drawn thinner and dotted. A **legend** strip at the bottom lists only the kinds
  present (the payload's `edgeKinds` already exists for this).
- **Interaction**: wheel/pinch zoom, drag to pan, "fit" button; hover dims everything outside the
  node's neighbourhood; click navigates (existing behaviour); keyboard focus cycles nodes and the
  accessible `TTable` stays in the slot.
- **Live counters (optional, cheap)**: only what LSS already serves — invocations/errors from
  `GET /api/lambdas/activity`, queue depth from the queue inspector — polled on the existing 10 s
  cadence. **No new timers per resource** (scale target). No animation in this PR.
- **Where**: the service detail card (upgraded in place) and a new **Stack map** page (`/stack`, nav
  entry), with an expand/collapse control per service frame. All strings in en / pt-BR / es.

## 7. SVG export — new `src/ui/src/components/graph/graphSvg.ts`

A pure `renderGraphSvg(layout, theme): string` that paints the same layout as the canvas (cards,
frames, edges, legend) with inline styles and no external fonts. Exposed as *Download SVG* on both
graph screens. Used once in this PR to export the `examples/self-hosted` stack map to
`docs/readme/stack-map.svg` for the README hero image (commit the file; re-export when the example
changes — note this in `docs/RELEASE.md`'s checklist).

## 8. README cards

- **Generator**: `scripts/readme-cards.mjs` (same spirit as `scripts/generate-aws-icons.mjs`) reads
  `scripts/readme-cards.json` and writes `docs/readme/cards/<id>-dark.svg` and `<id>-light.svg`.
  Each card: 296 × 64, rounded, coloured tile with an icon, bold title, monospace subtitle, chevron.
  System font stack only (an `<img>`-embedded SVG can't load web fonts); the generator measures text
  with a per-glyph width table and **fails** when a title/subtitle would overflow.
- **Icons**: AWS service cards reuse the vendored AWS Architecture artwork (unmodified, per its
  terms and `src/ui/src/icons/aws/NOTICE.md`); "start here" cards reuse an icon source the repo
  already carries — no new artwork source without a licence check.
- **Assets live under `docs/readme/`**, not `assets/`, so they are **not** shipped in the npm tarball
  (`package.json#files` includes `assets/`).
- **README layout**: right under the tagline, two grids of `<a href="…"><picture><source
  media="(prefers-color-scheme: dark)" srcset="…-dark.svg"><img src="…-light.svg" alt="…"
  width="296" height="64"></picture></a>`, three per row:
  - *Start here*: Quick start · CLI · Configuration · Self engine · Feature inventory
    (`docs/FEATURES.md`) · MCP (`docs/MCP.md`) · Migrating to 1.x (`docs/MIGRATION-v1.md`) · Releasing.
  - *What the engine emulates*: DynamoDB · Lambda · API Gateway · SQS · SNS · S3 · EventBridge ·
    Secrets Manager · SSM · OpenSearch Serverless — each linking to its README/`SELF_ENGINE.md` anchor
    (plus *Web Functions* and *Vector search* once A and B have merged).
  - The stack-map SVG from §7 under them, linking to the dashboard section.
  - npm renders README images from the repository URL, so relative paths work on both GitHub and
    npmjs.com — verify on the PR preview.
- **Guard test** `tests/unit/docs/readme-cards.test.ts`: every card referenced by the README exists in
  both variants; every card's link target exists (file, or a heading anchor in the target file);
  regenerating from the manifest in memory produces byte-identical files (stale cards fail CI).
- The generator itself sits outside `collectCoverageFrom` (like the icon generator); keep its logic in
  a small pure module that the guard test imports, so the important part is still exercised.

## 9. Tests (100 % coverage gate applies)

- `service-graph`: the IAM classification table row by row; access on structural edges; card facts per
  kind; HTTP externals (and the LSS-host exclusions); group membership.
- Stack graph: cross-service resolution, collapse/expand aggregation and weights, the 40-service
  benchmark.
- Layout (pure): zones, DLQ-under-queue, deterministic order across shuffled input, no overlapping
  channel segments, back-edge routing, the 50 ms budget.
- SVG export: snapshot of a small graph; no external references in the output.
- Route/client/MCP tests mirroring neighbours; `vue-tsc` covers the page.
- README guard test (§8).

## 10. Coordination, prerequisites and order

- **Dependency (human step)** — agents may not run `npm install`:
  `npm install -w src/ui @treeui/vue@^0.34.3`, then check the changelog between 0.31 and 0.34 for
  breaking changes the dashboard must absorb (fix them in this PR).
- **Order**: (A) DynamoDB vector search → (B) Lambda Web Functions → **(C) this PR**. Work can start
  in parallel: §3.1–3.4, §4, §5, §7 and §8 don't depend on A or B. The `web-function` node kind and
  the *Web Functions* / *Vector search* README cards land **after rebasing on B** (the table vector
  badge reads the raw template, so it doesn't need A merged).
- Files shared with A/B (`README.md`, `docs/FEATURES.md`, `CHANGELOG.md`, `package.json`) — append in
  separate sections; this PR **owns** `service-graph.ts` and `src/ui/src/components/graph/**`.
- **Docs**: `README.md` (dashboard + the cards themselves), `docs/FEATURES.md` (*Service wiring
  graph* row updated, new *Stack map* and *README cards* rows), `src/ui/ui-ux.md` (exception table),
  `CHANGELOG.md` `## [1.5.0]`, version `1.5.0` (edit `package.json` + the lockfile's two root `version`
  fields by hand).

## 11. Acceptance

- [ ] `validate: pre-prod` green.
- [ ] The `examples/self-hosted` stack renders as four framed services with cross-service edges, API
      nodes in front, route chips on function cards, DLQs under their queues, read/write arrows on
      table links, no overlapping connector segments, and the same picture after a refetch.
- [ ] A synthetic 40-service registration opens the stack page collapsed, and expanding one service
      stays interactive.
- [ ] The canvas rows in `src/ui/ui-ux.md`'s exception table are gone (or reduced to what is justified).
- [ ] The README shows the two card grids and the stack-map SVG on GitHub (dark and light) and on the
      npm page; every card link resolves.

## 12. Work breakdown (suggested commit-sized steps)

1. Graph model v2 (access, facts, api kind, HTTP externals, groups) + tests.
2. Stack graph route + collapse/expand + client/MCP + benchmark.
3. Layout v2 (zones → crossing reduction → constraints → orthogonal channels) + tests.
4. TreeUI bump; canvas on `TCanvasSurface`; cards, frames, edges, legend, pan/zoom, hover focus.
5. Stack page + nav + i18n; optional live counters.
6. `graphSvg.ts` + *Download SVG*; export the example's map.
7. README card generator + manifest + guard test; README restructure.
8. Rebase on B: `web-function` kind + the two extra cards.
9. Docs, `ui-ux.md` table, CHANGELOG, version `1.5.0`.
