# PRD — DynamoDB vector indexes and `SearchVectors` on the self engine

| | |
|---|---|
| **Status** | Ready for implementation |
| **Date** | 2026-11-15 |
| **Area** | Self engine (`emulators/dynamodb`), CFN parser + provisioner, explorer routes, dashboard, `LssClient`, MCP |
| **Branch** | `feat/dynamodb-vector-search` |
| **Release** | minor — `1.2.2 → 1.3.0` (first of three planned PRs; see §11) |
| **Related docs** | [SELF_ENGINE.md](SELF_ENGINE.md), [FEATURES.md](FEATURES.md), [PRD_SELF_ENGINE.md](PRD_SELF_ENGINE.md) |

---

## 1. Context

On 2026-08-05 AWS made **vector indexes** generally available on DynamoDB: a fourth index kind (next to
the table key, GSIs and LSIs) that answers *approximate nearest neighbour* queries over an embedding
stored on the item, through a new read API, **`SearchVectors`**. A service that adopts it declares the
index in its CloudFormation (`AWS::DynamoDB::Table.VectorIndexes`) and calls `SearchVectors` from its
handlers. Today LSS drops the property on the floor and answers `SearchVectors` with
`UnknownOperationException`, so such a service cannot run locally at all.

The goal is the usual LSS promise: **declare it in the template, run it locally, unchanged.**

## 2. What AWS shipped (the contract to emulate)

Sources: DynamoDB Developer Guide (*Using vector indexes*, *Creating and searching vector indexes*,
*Requirements and limitations*, *Quotas → Vector indexes*), API Reference (`SearchVectors`), CFN
Template Reference (`AWS::DynamoDB::Table`), and the `@aws-sdk/client-dynamodb@3.1169.0` model.

### 2.1 Index definition — `CreateTable.VectorIndexes[]`, `UpdateTable.VectorIndexUpdates[]`

```jsonc
{
  "IndexName": "ProductEmbeddingIndex",            // [a-zA-Z0-9_.-]{3,255}
  "VectorAttribute": { "AttributeName": "Embedding" },
  "SearchSchema": [                                 // optional
    { "AttributeName": "Category", "SearchSchemaElementType": "HASH" },          // ≤ 1
    { "AttributeName": "Brand",    "SearchSchemaElementType": "INLINE_FILTER" }  // ≤ 18
  ],
  "Projection": { "ProjectionType": "ALL" },        // ALL | KEYS_ONLY | INCLUDE (+ NonKeyAttributes)
  "Dimensions": 1536,                               // 1..4096
  "DistanceFunction": "COSINE"                      // COSINE | EUCLIDEAN | DOT_PRODUCT
}
```

- `UpdateTable.VectorIndexUpdates: [{ Create: {…same shape…} } | { Delete: { IndexName } }]`.
- `DescribeTable.Table.VectorIndexes[]` (`VectorIndexDescription`): the fields above plus
  `IndexStatus`, `Backfilling`, `IndexSizeBytes`, `ItemCount`, `IndexArn`
  (`arn:aws:dynamodb:<region>:<account>:table/<table>/index/<index>`).
- CFN: `AWS::DynamoDB::Table` gained `VectorIndexes: [VectorIndex]` with the same field names.

**Validation rules AWS enforces** (each must be an AWS-shaped `ValidationException` unless noted):

| Rule | AWS behaviour |
|---|---|
| Table must be `PAY_PER_REQUEST` | Vector indexes are on-demand only. |
| ≤ 5 vector indexes per table (adjustable to 20; they also count toward the 20-GSI quota) | `ValidationException: One or more parameter values were invalid: VectorIndex count exceeds the per-table limit of 5` |
| `Dimensions` 1..4096 | reject |
| ≤ 1 `HASH`, ≤ 18 `INLINE_FILTER` per index | reject |
| Every `SearchSchema` attribute must be in `AttributeDefinitions` (like a GSI key) | reject |
| One index create/delete per table at a time, also per `UpdateTable` call (two `Create`s in one call fail) | `LimitExceededException: Subscriber limit exceeded: Only 1 online index can be created or deleted simultaneously per table` |
| Vector indexes don't serve `Query`/`Scan`/PartiQL | reject a `Query`/`Scan` whose `IndexName` is a vector index |

### 2.2 Writes

Vectors are plain items: an `L` of `N` on the attribute named by `VectorAttribute`, written with the
usual `PutItem` / `UpdateItem` / `BatchWriteItem` / `TransactWriteItems`.

| Condition on a write to a table with a vector index | AWS behaviour |
|---|---|
| Vector attribute has the wrong number of dimensions | **write rejected** |
| Vector-index `HASH` attribute missing | write succeeds; item **silently not indexed** |
| Vector-index `HASH` attribute of the wrong type | **write rejected** |
| Inline-filter attribute missing | write succeeds and the item **is** indexed |
| Values more precise than f32 | write succeeds; base table keeps the value, index stores f32 |
| Vector attribute removed from the item | index entry removed |

### 2.3 `SearchVectors` (`X-Amz-Target: DynamoDB_20120810.SearchVectors`, JSON 1.0)

Request: `TableName`, `IndexName`, `SearchVector` (a **plain list** of `{N}` — not wrapped in `L`),
`TopK` (1..100), optional `SearchConditionExpression`, `ExpressionAttributeNames`,
`ExpressionAttributeValues`, `ProjectionExpression`, `ReturnConsumedCapacity`.
Response: `{ SearchResults: [{ Item, Score }], ConsumedCapacity?: { VectorSearchRequestBytes } }`,
most similar first.

- **Scores.** `COSINE` = cosine *distance* (`1 − cos`, 0..2, ascending). `EUCLIDEAN` = L2 distance
  (ascending). `DOT_PRODUCT` = dot product (descending, may be negative). The guide's worked example
  (query `[1,0,0,0]`) is the golden test: `[10,0,0,0]` → 0.0 / 9.0 / 10.0, `[0.7071,0.7071,0,0]` →
  0.29 / 0.77 / 0.71, `[-1,0,0,0]` → 2.0 / 2.0 / −1.0.
- **`SearchConditionExpression`.** Only `=` comparisons joined by `AND`, only top-level attributes
  that are in the index's `SearchSchema`. The `HASH` attribute is **mandatory** when the index
  defines one; inline filters are optional.
- **Projection.** Only projected attributes can be returned. By default the **vector attribute is
  excluded** from results; it is returned only if named in `ProjectionExpression`.
- **Errors.** Unknown table → `ResourceNotFoundException`; index not searchable →
  `ValidationException` (`The table does not have the specified index`).
- **Endpoint.** Real SDKs send `SearchVectors` to a dedicated `search-ddb` host, **but a configured
  `endpoint` overrides it**. Verified on 2026-11-15 with `@aws-sdk/client-dynamodb@3.1169.0` against a
  local listener: the request arrives at the custom endpoint as an ordinary JSON 1.0 POST with
  `X-Amz-Target: DynamoDB_20120810.SearchVectors`. So the engine's existing DynamoDB route is enough —
  no new listener, no host rewriting.
- **Consistency.** On AWS indexing is asynchronous (eventually consistent), a new index goes
  `CREATING` → (`Backfilling: true`) → `ACTIVE`, and the first searches after `ACTIVE` may still fail.

## 3. Goals

1. A template declaring `VectorIndexes` provisions the table **with** its indexes on boot; adding an
   index to an existing table on re-register applies it through `UpdateTable` (idempotent, non-fatal).
2. `CreateTable` / `UpdateTable` / `DescribeTable` accept and report vector indexes with AWS shapes and
   AWS validation.
3. Writes are validated per §2.2.
4. `SearchVectors` answers with AWS-faithful ranking, scores, filtering, projection and errors.
5. Dashboard, `LssClient` and MCP can run a similarity search, so a developer can see that their
   embeddings actually retrieve what they expect.
6. Proven end to end through `examples/self-hosted` and a `wire-*` test.

### Non-goals

- Generating embeddings (DynamoDB doesn't either). Examples use a deterministic toy embedding.
- An ANN data structure (HNSW, IVF…). See §4.2 — exact search is the right local trade-off.
- Global tables / replicas, PITR restore backfill, import-from-S3, DAX.
- Emulating capacity throttling or the per-partition GBps quotas.

## 4. Design

### 4.1 Index metadata — `emulators/dynamodb/schema.ts`

- New `VectorIndexRecord { indexName, vectorAttribute, dimensions, distanceFunction,
  hashAttribute?: KeyAttribute, inlineFilters: string[], projection: ProjectionRecord, createdAtMs }`.
- `TableRecord.vectorIndexes?: VectorIndexRecord[]` — **optional**, so snapshots written by 1.2.x load
  unchanged (missing ⇒ `[]`). No store-format migration.
- Validation lives next to the existing GSI validation in `validateCreateTable`; add a reusable
  `validateVectorIndex(definition, table)` that `UpdateTable` also calls. Name uniqueness is checked
  across GSIs, LSIs and vector indexes.
- `describeTable` emits `VectorIndexes[]` with `IndexStatus: 'ACTIVE'`, no `Backfilling`, `IndexArn`,
  `ItemCount` (indexed items) and `IndexSizeBytes` (≈ `ItemCount × dims × 4` + projected bytes).

### 4.2 Search — new `emulators/dynamodb/vector.ts`

**Exact k-NN by brute force.** Recall is 100 % — a superset of AWS's "99 %+", so no test that passes
on AWS can fail locally because of recall. At local-dev sizes it is fast: 10 000 items × 1 536 dims
is ~15 M multiply-adds, a few milliseconds.

To avoid re-parsing `N` strings on every search, each vector index keeps a **lazy derived cache**:
`Map<itemKey, { vec: Float32Array, norm: number, hash?: string, filters: Record<string,string> }>`,

- built on the first `SearchVectors` against the index (one pass over the table), then
- maintained **incrementally** from the same write funnel the stream recorder uses (put / update /
  delete / TTL expiry / transactions / batch), and
- **never persisted** — it is rebuilt from the base table after a restart, exactly like AWS rebuilds
  an index after a restore.

Scale check (40 services × ~10 tables): a table that is never searched costs nothing — the cache only
exists once someone searches. Partitioned indexes keep a second-level `Map<hashValue, Set<itemKey>>`
so a `HASH`-scoped search scans only its partition, which mirrors AWS's own scaling advice.

Ranking: compute the score per §2.3 with f32 components (`Math.fround` when filling the cache), keep
a bounded top-K (sorted insert is fine for K ≤ 100), tie-break on the canonical item-key encoding
so results are deterministic across runs. Zero-norm vectors under `COSINE` score `1` (orthogonal)
instead of producing `NaN` — record it in *Known divergences*.

### 4.3 Write validation — `emulators/dynamodb/index.ts`

Hook the single place where an item is committed (the funnel shared by `PutItem`, `UpdateItem`,
`BatchWriteItem` and `TransactWriteItems`; find it via the stream recorder). For every vector index
on the table: vector present ⇒ must be `L` of `N` with `length === dimensions`; `HASH` present ⇒
type must match its `AttributeDefinitions` entry. Reject with `ValidationException` and leave the
item unwritten. A transaction with one bad item cancels the whole transaction the way existing
validation failures already do (`TransactionCanceledException` with a `ValidationError` reason).

### 4.4 `UpdateTable` — `emulators/dynamodb/index.ts`

The emulator has **no `UpdateTable` today**. Implement the subset this feature needs:

- `VectorIndexUpdates` with exactly one `Create` **or** one `Delete` per call (§2.1 limit error
  otherwise); `AttributeDefinitions` merged when a `Create` references new attributes.
- Any other mutable field (`BillingMode`, `StreamSpecification`, `GlobalSecondaryIndexUpdates`, …) is
  **out of scope**: answer `ValidationException` with a message that names the unsupported field so
  nobody mistakes a no-op for success. Document it in *Known divergences*.
- Index operations complete synchronously; `DescribeTable` shows `ACTIVE` immediately.

### 4.5 `SearchVectors` dispatch

- New `case 'SearchVectors'` in the operation switch.
- Parse `SearchConditionExpression` with the **existing** expression parser
  (`expressions/parser.ts`), then walk the AST and reject anything that is not `path = :value`
  conjunctions over `SearchSchema` attributes. Reuse the existing unused-name / unused-value
  validation helpers so error texts match `Query`.
- Reuse the existing `ProjectionExpression` evaluation; restrict it to projected attributes; strip the
  vector attribute unless explicitly requested.
- `Query` / `Scan` with `IndexName` = a vector index → `ValidationException`.

### 4.6 CFN parser + provisioner

- `cloudformation-parser.ts`: `DynamoDBResource.vectorIndexes?` parsed from `VectorIndexes`
  (resolve intrinsics like the GSI arm does).
- `resource-provisioner.ts`:
  - `CreateTable` passes `VectorIndexes`.
  - Table already exists ⇒ `DescribeTable`, diff declared vs present vector indexes, apply missing
    ones **one `UpdateTable` per index**; never delete an index the template no longer declares
    (warn instead — matches the provisioner's additive policy). Swallow "already exists".
  - Table declared `PROVISIONED` (or without `BillingMode`, which defaults to `PROVISIONED`) **with**
    vector indexes: AWS rejects it, so the engine does too; the provisioner logs an actionable warning
    and retries `CreateTable` **without** `VectorIndexes`, so the boot continues (non-fatal rule).
- `service-graph.ts`: none in this PR (the stack-map PR adds a vector badge on table nodes).

### 4.7 Explorer, client, MCP, dashboard

- Route: `POST /api/dynamo/tables/:name/vector-search` (body = `SearchVectors` input minus
  `TableName`; also accepts `{ similarTo: <key> }` to reuse an existing item's vector — the most
  useful debugging move). `GET /api/dynamo/tables/:name` already returns `DescribeTable`; make sure the
  vector indexes flow through `dynamo-explorer.ts`.
- `LssClient`: `client.dynamo.searchVectors(table, input)`.
- MCP: `lss_dynamo_vector_search` (table, index, vector | similarTo, topK, filter).
- Dashboard (`DynamoTablePage.vue`): an *Indexes* block listing vector indexes (dims, distance, schema,
  item count) and a *Vector search* panel: index picker, "similar to item…" picker or pasted vector,
  Top-K, equality filters generated from the index's `SearchSchema`, results table with `Score`.
  **TreeUI components only** (see `src/ui/ui-ux.md`), strings in all three catalogs (en, pt-BR, es).

## 5. Dependency prerequisite (human step)

`@aws-sdk/client-dynamodb` is pinned at `3.974.0` in the lockfile, which **predates** the feature:
its serializers silently drop `VectorIndexes` and it has no `SearchVectorsCommand`. The provisioner
creates tables through that SDK, so the bump is required, not optional. Agents may not run
`npm install` (AGENTS.md rule 1), so before implementation starts the maintainer runs, in this branch:

```bash
npm install @aws-sdk/client-dynamodb@^3.1169.0 @aws-sdk/lib-dynamodb@^3.1169.0 @aws-sdk/util-dynamodb@3.1169.0
# recommended: keep every @aws-sdk/* on the same release so @smithy/* isn't duplicated
```

Then check how Lambda handlers resolve `@aws-sdk/*` (`worker-runtime.ts` → `linkArtifactNodeModules`).
If the runtime lends the orchestrator's SDK, the root bump covers the example handler; if not, the
example service needs its own dependency (another `npm install`, again a human step).

## 6. Example — `examples/self-hosted/catalog-service`

Add a `catalog-embeddings` table (`PAY_PER_REQUEST`, key `productId`, attribute `category`) with a
vector index `ProductEmbeddingIndex` (`Dimensions: 8`, `COSINE`, `HASH: category`), plus two handlers:

- `PUT /products/{id}/embedding` — derives a **deterministic toy embedding** from the product text
  (feature hashing into 8 buckets, L2-normalised; no model call, no network) and stores it.
- `GET /products/{id}/similar?k=5` — `SearchVectors` scoped to the product's category, excluding
  itself.

Seed a handful of products whose expected neighbours are obvious, and assert the ranking in the demo
task and in the integration suite. Keep the "four microservices" shape — this extends a service, it
doesn't add one.

## 7. Tests (100 % coverage gate applies)

- `tests/unit/engine/dynamodb/vector-*.test.ts` — schema validation (every row of §2.1), write
  validation (every row of §2.2), score math (the guide's golden table, all three functions),
  top-K bound and deterministic tie-break, partition scoping, inline filters, projection rules
  (vector excluded by default, unprojected attribute refused), cache incrementality (put → update →
  delete → TTL → transaction), `UpdateTable` create/delete/limit errors, `Query`/`Scan` refusal.
- `tests/unit/engine/wire-dynamodb-vector-search.test.ts` — real `SelfEngineBackend` driven **through
  the bumped AWS SDK** (`CreateTableCommand` with `VectorIndexes`, `SearchVectorsCommand`, the
  DocumentClient's `SearchVectorsCommand`).
- Parser + provisioner unit tests (create, add-to-existing, PROVISIONED fallback warning).
- Route, client and MCP tests mirroring their neighbours.
- `tests/integration/` — the catalog example's similarity assertion.

## 8. Documentation (AGENTS.md rule 4)

- `README.md` — feature entry under *The self engine* and *Resource provisioning*.
- `docs/FEATURES.md` — rows for vector indexes, `SearchVectors`, the explorer/client/MCP surface.
- `docs/SELF_ENGINE.md` — coverage table + **Known divergences**: exact (not approximate) search;
  indexes `ACTIVE` immediately and searchable synchronously (no eventual-consistency lag);
  zero-norm cosine; `UpdateTable` limited to `VectorIndexUpdates`; no throughput quotas.
- `CHANGELOG.md` — `## [1.3.0]` *Added*.

## 9. Acceptance

- [ ] `validate: pre-prod` green (lint 0 errors, all `tsc`, `vue-tsc`, coverage 100 %, build).
- [ ] The catalog example returns the expected neighbours through `SearchVectors`, both from the demo
      task and from `npm run test:integration`.
- [ ] A template with `VectorIndexes` on a `PROVISIONED` table boots with a clear warning, not a crash.
- [ ] Restart the orchestrator: indexes are still described and searches still work (cache rebuilt).

## 10. Work breakdown (suggested commit-sized steps)

1. Schema: `VectorIndexRecord`, validation, `DescribeTable` output.
2. `UpdateTable` (vector subset) + limits.
3. Write validation in the commit funnel.
4. `vector.ts`: cache, scoring, top-K; `SearchVectors` dispatch; `Query`/`Scan` refusal.
5. Parser + provisioner (+ PROVISIONED fallback).
6. Explorer route, client, MCP.
7. Dashboard panel + i18n.
8. Example + wire test + integration assertion.
9. Docs, CHANGELOG, version `1.3.0` (edit `package.json` **and** the two root `version` fields of
   `package-lock.json` by hand — `npm version` is off-limits to agents).

## 11. Coordination with the two sibling PRs

Three PRs are planned in this order: **(A) this one → (B) Lambda Web Functions → (C) stack map +
README cards**. Each bumps the minor version on merge (`1.3.0`, `1.4.0`, `1.5.0`). Files more than one
of them touch — `README.md`, `docs/FEATURES.md`, `docs/SELF_ENGINE.md`, `CHANGELOG.md`,
`package.json`, `cloudformation-parser.ts` — are append-only edits in separate sections, so the
later PR rebases with trivial conflicts. This PR owns `emulators/dynamodb/**` exclusively.
