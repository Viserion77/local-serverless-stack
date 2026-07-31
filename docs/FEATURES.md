# LSS — Promised Features

This is the canonical inventory of what `local-serverless-stack` (LSS) promises. It doubles as the
checklist for the integration suite (`tests/integration/features.test.ts`), which boots a real isolated
LSS instance on the self engine — no Docker, no auth token — and asserts each capability against the live HTTP API.

> **⚠️ Keep this document current.** Every new capability MUST be recorded here as part of shipping
> the change — never after the fact. Keep it in sync with the **Features** section of
> [../README.md](../README.md) and, for self-engine work, with [SELF_ENGINE.md](SELF_ENGINE.md). A
> feature that isn't in this inventory is treated as one that doesn't exist (and won't be covered by
> the suite). When you add a row, wire it to a `unit`/`integration` assertion in the same PR.

Legend for "Asserted by": `unit` = covered by the unit suite (`npm run test:unit`); `integration` = covered
by the live integration suite (`npm run test:integration`).

---

## 1. CLI (`npx lss …`)

| Feature | Promise | Asserted by |
|---|---|---|
| `lss start` | Starts the orchestrator + engine in the background; writes a PID file and logs. | integration (`features.test.ts` boots via `lss start --config`) + unit (`cli`) |
| `lss stop` | Gracefully stops the orchestrator addressed by the active config. | integration (`features.test.ts` teardown) + unit (`cli`) |
| `lss status` | Reports RUNNING/NOT RUNNING + ports for the addressed instance. | unit (`cli`) |
| `lss logs` | Prints the tail of the instance log. | unit (`cli`) |
| `lss mcp` | Runs the MCP server on stdio for an AI coding agent. Requires a running orchestrator. | unit (`cli`, `mcp/*`) |
| `lss seed [table]` | Applies `{table}.json` seed files from `seedsDir` into DynamoDB (all matching tables, or one). | unit (`cli-seed`) + integration |
| `lss seed:clear [table]` | Deletes seeded items after an interactive `confirmar` prompt (or `--yes`); refuses any non-local endpoint. | unit (`cli-seed`, `seed-manager-guard`) |
| `--config <path>` | Loads config from an explicit file, taking precedence over the cwd/home search; also via `LSS_CONFIG`. | unit (`cli`) + integration |
| v1 flag guard | `--self-engine` / `--external` / `--pro` / `--localstack-token`, and `engine: "localstack"` in a config file, exit 1 naming `docs/MIGRATION-v2.md` — a stale script fails visibly instead of quietly starting the wrong thing. | unit (`cli`, `config-manager`) |

## 2. Configuration & instance isolation

| Feature | Promise | Asserted by |
|---|---|---|
| `lss.config.json` / `.lssrc` | File config for ports, mode, edition, services, seeds, etc.; env vars override. | unit (`config-manager`, `cli`) |
| `stateDir` | Per-instance PID/log directory so an isolated test instance never collides with the dev instance. | unit (`cli`, `config-manager`) + integration |
| `LSS_ENGINE_DATA_DIR` | Points the self engine's state at an explicit directory from the environment. With `LSS_DASHBOARD_PORT` and `LSS_ENGINE_PORT` it is everything a second instance needs — no config file to write, nothing shared with the dev stack. | unit (`config-manager`) |
| `LSS_CONFIG_PATH` passthrough | The CLI hands the chosen config to the spawned server so both loaders agree on ports/seedsDir/region/mode. | unit (`config-manager`) + integration |
| Per-project state, no `stateDir` | With no `stateDir`, the engine `dataDir`, the aoss sidecar data dir and the artifact-extraction dir all fall back to `~/.lss/projects/<project-slug>-<hash>/…` instead of one shared path — two checkouts (or two examples) never read each other's tables, and re-registering in one no longer `rm -rf`s the code another instance's worker is running from. | unit (`config-manager`, `cache-manager`) |
| No LocalStack env | `lss start` exports **no** `LSS_LOCALSTACK_*` / `LOCALSTACK_AUTH_TOKEN` to the orchestrator (and therefore to every forked worker). Each key exported this way was also reported by `GET /api/config` as env-overridden, greying out a Settings field for a value the user never set. | unit (`cli`) |
| Edition / version / image / services / persistence / region | All configurable; sensible defaults (community/latest, us-east-1, dynamodb+sqs+sns+s3+lambda+events). | unit (`config-manager`) |
| `GET /api/config` | Public-safe full config snapshot for the UI: engine kind/endpoint, self-engine + aoss sidecar + lambda-runtime blocks, packaging, `envOverrides` (keys masked by env vars). Secret values never appear — auth token → `hasAuthToken`, `packageEnv` → key names, `secrets` → count. | unit (`routes/config`) + integration |
| `PUT /api/config` | Edit the config from the dashboard Settings tab: writes only the patched keys into the loaded config file (creating `lss.config.json` when none is loaded), `null` deletes, object blocks merge one level deep; hot-reloads and reports `restartRequired` (boot-materialized keys) + `envOverridden` (file value masked by env). `secrets` is rejected. | unit (`config-manager`, `routes/config`) |
| `POST /api/config/reload` | Re-read the config file from disk after a hand edit, without restarting; same `restartRequired` classification. | unit (`config-manager`, `routes/config`) |
| `GET /api/config/ports` | Every local port the stack exposes (orchestrator, active engine, aoss sidecar, DynamoDB proxy, per-service HTTP API + invoke listeners) — backs the Overview "Exposed ports" card. | unit (`routes/config`) |

## 3. Resource provisioning (from CloudFormation)

LSS parses the CloudFormation template produced by `serverless package` and provisions the resources in
the engine. `autoPackage` can run the packaging command on demand when the template is missing.

| Resource | Promise | Asserted by |
|---|---|---|
| DynamoDB tables | Created with key schema, GSIs/LSIs, streams, TTL. | unit (`cloudformation-parser`, `resource-provisioner`, `dynamo-explorer`) + integration |
| SQS queues | Created (incl. FIFO), with visibility timeout / retention, and `RedrivePolicy` (dead-letter queue + `maxReceiveCount`) — the `deadLetterTargetArn` intrinsic is resolved from the template, so the DLQ may be declared after the queue that points at it; a policy added to an existing queue is applied with `SetQueueAttributes`. | unit (`cloudformation-parser`, `resource-provisioner`) + integration |
| SNS topics | Created and discoverable. | unit + integration |
| S3 buckets | Created with versioning, `s3:ObjectCreated:*` notifications (prefix/suffix filters) and `CorsConfiguration` — `CorsRules[]` (`AllowedOrigins`/`AllowedMethods`/`AllowedHeaders`, `ExposedHeaders` or the wire spelling `ExposeHeaders`, `MaxAge` or `MaxAgeSeconds` with a literal `0` preserved, `Id`; a rule declaring no origins or no methods is skipped, as AWS requires both) applied with `PutBucketCors` when the bucket is created, so a browser preflight succeeds on the first boot with no bootstrap step. | unit (`cloudformation-parser`, `resource-provisioner`, `engine/wire-s3-cors-cfn`) + integration |
| Lambda event source mappings | SQS→Lambda and DynamoDB Stream→Lambda wired through the engine's in-process dispatch. | unit (`resource-provisioner`) + integration |
| EventBridge buses & rules | `AWS::Events::EventBus` created on the engine; `AWS::Events::Rule` (pattern or schedule) wired to Lambda targets; `AWS::Events::Archive` skipped with a warning (never listed or replayable). | unit (`cloudformation-parser`, `resource-provisioner`) |
| OpenSearch Serverless collections | `AWS::OpenSearchServerless::Collection` created via the `aoss` control plane (idempotent on `ConflictException`); `SecurityPolicy`/`AccessPolicy`/`VpcEndpoint` accepted and skipped with a warning (nothing enforces them locally). | unit (`cloudformation-parser`, `resource-provisioner`) |
| Secrets Manager secrets | `AWS::SecretsManager::Secret` created at registration — `SecretString` verbatim, or `GenerateSecretString` expanded through the engine's `GetRandomPassword` with the AWS defaults (`PasswordLength` 32, `RequireEachIncludedType` true) and injected into `SecretStringTemplate` at `GenerateStringKey` when both are present — carrying `Description`/`KmsKeyId`/`Tags`. Idempotent (an existing active secret is skipped, never clobbered) and non-fatal. | unit (`cloudformation-parser`, `resource-provisioner`, `secret-value`) |
| Lambda proxies | Generated proxy functions forward events to the service's Lambda Invoke API endpoint (the LSS invoke listener, contract-compatible with serverless-offline's `lambdaPort`). | unit (`resource-provisioner`) |
| `GET /api/resources` / `…/owners` | List provisioned resources (tables/queues/topics/buckets/collections) and map them to owning services. | unit (`routes/resources`) + integration |

## 4. Service registration (the `serverless-lss` plugin)

| Feature | Promise | Asserted by |
|---|---|---|
| Auto-registration | On `sls package`/`offline`, the plugin POSTs the service to `POST /api/services/register`. | unit (`plugin`, `routes/services`) + integration |
| `LSS_DASHBOARD_PORT` | The plugin registers against the orchestrator on that port (precedence: `ORCHESTRATOR_URL` > `LSS_DASHBOARD_PORT` > `custom.orchestrator` > 3100). | unit (`plugin`) |
| Service lifecycle API | `GET/DELETE /api/services`, `PATCH /:name/status`, `POST /:name/start|stop`, `GET /:name/logs`. | unit (`routes/services`) |

## 5. SQS inspection & testing primitives (`/api/queues`)

| Endpoint | Promise | Asserted by |
|---|---|---|
| `GET /` / `GET /:name` | List queues / one queue with metrics (available, inFlight, processed, delayed) and consumers. | unit (`queue-inspector`, `routes/queues`) + integration |
| `POST /:name/messages` (+ `/messages/receive`, `/messages/delete`) and `POST /:name/purge` | Send/receive/delete/purge messages (FIFO group/dedup supported). | unit + integration |
| `POST /:name/reset-processed` | Reset the processed counter. | unit |
| `POST /:name/await-idle` | **Block until the queue drains** (`available===0 && inFlight===0`, optional `sinceProcessed`); 200 drained / 408 timeout. | unit (`queue-inspector`, `routes/queues`) + integration |
| `POST /:name/hold` · `GET /:name/captured` · `POST /:name/release` | Disable the consumer mapping and capture messages, inspect them, then re-enable and re-dispatch. | unit (`queue-inspector`, `routes/queues`) + integration |

## 6. DynamoDB explorer (`/api/dynamo`)

`GET /tables`, `GET /tables/:name`, `GET|PUT /tables/:name/ttl`, `POST /tables/:name/scan|query`,
`POST /tables/:name/items{,/get,/delete}` — list/describe (key schema, GSI/LSI, stream, TTL), scan/query with
filters, and item CRUD. Asserted by: unit (`dynamo-explorer`, `routes/dynamo`) + integration.

**Region default and paging.** Every explorer (`dynamo`, `buckets`, `secrets`, `opensearch`, `queues`) accepts
`?region=`; when it is omitted the configured `region` is used, not a hardcoded `us-east-1`. The dashboard
always sends the region it read from `/api/config`, so a wrong default only ever hit the callers that omit it —
the CLI, the `LssClient` and plain curl — which silently saw an empty stack on any project outside us-east-1.
Table and queue listings follow their pagination tokens (`ListTables` caps a page at 100 names, `ListQueues` at
1000), so a monorepo with 40 services × 10 tables lists all 400 instead of the first 100. Asserted by: unit
(`explorer-region`, `dynamo-explorer`, `seed-manager`, `queue-inspector`, `resource-provisioner`).

## 7. S3 explorer (`/api/buckets`)

`GET /`, `GET /:name`, `GET /:name/objects`, `GET /:name/objects/content`, `POST /:name/objects`,
`DELETE /:name/objects` — list buckets (with object/size totals, versioning, notifications), list/stream/upload
(base64 or utf8)/delete objects. Asserted by: unit (`s3-explorer`, `routes/buckets`) + integration.

## 8. Seeds (`/api/seeds`)

`GET /` (seed files + live tables), `POST /run`, `POST /clear` — auto-seed on table creation and on-demand
seed/clear, with a seed-file ↔ live-table mismatch diagnostic and a hard local-endpoint guard on clear.
Asserted by: unit (`seed-manager`, `routes/seeds`, `cli-seed`, `seed-manager-guard`) + integration.

**Secret seeds (boot).** Beyond DynamoDB fixtures, secrets are seeded on startup so a handler's first
`GetSecretValue` finds an `AWSCURRENT` version even when no template declares the secret. Two sources are
merged: `seeds/secrets/<name>.json` files under `seedsDir` (walked recursively — nested directories map to
`/`-separated secret names, e.g. `seeds/secrets/billing/receipt-signing-key.json` → `billing/receipt-signing-key`)
and an optional `secrets:` map in `lss.config.json` (the config map wins a name collision, with a warning). A
value is either the `SecretString` itself (a bare string, or a bare JSON object that *is* the payload) or a
descriptor with `secretString`/`generateSecretString` plus `description`/`kmsKeyId`/`tags` — `generateSecretString`
expands exactly like the CloudFormation path. Applied **before** cached services are reactivated, idempotently
(an existing active secret is skipped, never clobbered; one scheduled for deletion is warned and skipped) and
non-fatally (a failure warns, boot continues). Asserted by: unit (`seed-manager`, `secret-value`,
`config-manager`, `engine/wire-secret-seed-on-boot`).

## 9. DynamoDB proxy (dev)

Optional reverse proxy (`enableDynamoProxy` / `dynamoProxyPort`, default 8000) forwarding to the active AWS
engine, for tools that expect DynamoDB on the standard
port. Asserted by: unit (`dev/dynamo-proxy`).

## 10. Health & dashboard

`GET /api/health` reports orchestrator + engine + dynamo-proxy status. Liveness of the **active** engine
is `engineRunning`; `engine.kind` is always `"self"`, and `engine.services` lists what the engine answers for.
(v1's `localstack` boolean is gone — see [MIGRATION-v2.md](MIGRATION-v2.md).)

Any `/api/*` path no router claims answers **404 with a JSON body**, not the SPA's `200 text/html` — a mistyped
API path used to read as success to curl, to the `LssClient` and to any test asserting on the response. The Vue dashboard
(served as a SPA) surfaces ten tabs — Overview / Services / Lambdas / APIs / Queues / S3 / DynamoDB /
OpenSearch / Secrets / **Settings** — with a region selector and theme toggle; the Services list and service
detail pages include the per-service resource breakdown with EventBridge buses & rules and OpenSearch
collections (UI is exercised manually, not in the automated suites). The Overview shows an **Exposed ports**
card (`GET /api/config/ports`); the Settings tab edits `lss.config.json` via `PUT /api/config` (dirty fields
only, restart-required and env-masked keys flagged) and re-reads it via `POST /api/config/reload`.

The **OpenSearch explorer** (`GET /api/opensearch/collections`, `…/collections/:name/indices`,
`POST /…/collections/:name/search`) and the **Secrets explorer** (`GET /api/secrets`, `GET /api/secrets/:name`,
`GET /api/secrets/:name/value` — the value lives behind a separate endpoint so a plain list never carries
secret material) back the corresponding tabs. Asserted by: unit (`opensearch-explorer`, `secrets-explorer`,
`routes/opensearch`, `routes/secrets`).

Dashboard branding: an optional `branding` key in `lss.config.json` (title, subtitle, logo,
favicon, defaultTheme, plus `colors`/`themeColors` as TreeUI token overrides) customizes the dashboard. Served
at `GET /api/config/branding`; local logo/favicon files are exposed at `GET /api/config/branding/logo|favicon`.
A working showcase (logo file + per-theme colors) ships with `examples/self-hosted` — every project under
`examples/` carries its own branding block. Asserted by: unit (`config-manager` "branding" block).

## 11. Programmatic client (`LssClient`)

Everything the CLI/orchestrator exposes, importable for Jest e2e at runtime instead of shelling out to `npx lss`:
`import { LssClient } from 'local-serverless-stack'`. The data-plane (`seeds`, `queues`, `dynamo`, `buckets`,
`resources`, `services`, `lambdas`, `apis`, `config`, `health`) is HTTP against the running orchestrator; `lifecycle`
(`start`/`stop`/`status`/`logs`) shells out to `bin/cli.js`, and `lifecycle.waitUntilReady()` polls `/api/health`
until the engine is serving. The constructor resolves the target from options → env (`LSS_CONFIG`, `LSS_BASE_URL`,
`LSS_SERVER_PORT`, `AWS_REGION`) → config file, so `new LssClient()` works purely from the environment; options
also include `timeoutMs` (HTTP timeout per request, default 15000 — raise it for long `awaitIdle` waits). Shipped as
a self-contained CommonJS build (`dist/client`, package `main`/`exports`). Asserted by: unit (`client/*`) +
integration (`features.test.ts` "programmatic client" block).

| Endpoint | Promise | Asserted by |
|---|---|---|
| `seeds.run` / `seeds.clear` / `seeds.list` | Same as `lss seed` / `lss seed:clear`, returning the raw `results`. | unit + integration |
| `queues.awaitIdle` | Resolves on both 200 (drained) and 408 (timeout) — inspect `drained`. | unit + integration |
| `buckets.getObject` | Returns the raw object body as a `Buffer` (not JSON). | unit + integration |
| `lifecycle.*` | Programmatic `start`/`stop`/`status`/`logs` + `waitUntilReady` health gate. | unit + integration |

## 12. API Gateway & Lambda runtime emulation (serverless-offline replacement)

LSS registers every function and HTTP route from the `sls package` artifacts
(`cloudformation-template-update-stack.json` + `serverless-state.json`), runs handlers in
per-service worker processes, and binds two listeners per service: an API Gateway emulator on
the service's `apiPort` (30xx) and an AWS Lambda Invoke API on its `invokePort` (130xx) —
so monorepo callers keep their ports and contracts with no
serverless-offline process running. See `docs/PRD_API_LAMBDA_EMULATION.md` for the full design.

| Feature | Promise | Asserted by |
|---|---|---|
| Function & route registry | `sls package` registers functions, REST (`http`, payload v1) and HTTP API (`httpApi`, payload v2) routes and authorizers; persisted in the service cache and rehydrated on restart. | unit (`serverless-state-parser`, `function-registry`, `cache-manager`) |
| Lambda runtime workers | One worker per service loads handlers lazily (warm starts), applies function env/timeout/context, captures per-invocation logs, restarts on crash. | unit (`api-gateway-events` helpers) + integration |
| Lazy workers, idle unload and a warm ceiling | A worker is a Node process costing ~48 MB resident, and LSS is a development stack — a handler only needs to be resident while it is being used. `lambdaRuntime.lazy` (default **true**) forks on the first invocation instead of at registration; `idleTimeoutMs` (default **60000**) unloads a worker that has served nothing for a minute; `maxWarmWorkers` (default: one per GB of RAM, clamped 2..12) caps how many may be resident at once, evicting the least-recently-invoked. Together they make host memory a function of the services *in flight*, not the services *registered*. Handler resolution (and artifact extraction) still runs at registration, so broken packaging still fails there, and an in-flight invocation is never interrupted. Measured on 40 services / 400 lambdas / 400 tables: **2.0 GB → 128 MB** at rest, 329 MB right after invoking all 40 with a ceiling of 4, back to 132 MB once idle — next request still 23 ms. `GET /api/services` reports `runtimeWarm`, `GET /api/lambdas` reports `warm`; `status` stays `online` either way, because the service serves an invoke regardless. | unit (`config-manager`, `routes/lambdas`, `routes/services`) |
| Execution modes | `artifact` (extracted `sls package` zip — TS/JS uniform), `source` (direct require/import; TS uses Node native type stripping when available, then `esbuild-register`/`tsx`/`ts-node`), `auto` picks artifact when present. | unit (`config-manager`) + integration |
| Invoke API (130xx) | `POST /2015-03-31/functions/{name}/invocations` with `X-Amz-Invocation-Type` (RequestResponse 200 / Event 202 / DryRun 204) and `X-Amz-Function-Error` — the same contract a monorepo's existing callers already use. | integration |
| Gateway proxy (30xx) | Multi-port routing (literal > `{param}` > `{proxy+}` > `$default`; exact method > ANY), API Gateway payload v1/v2 events, v1 malformed → 502, v2 inferred responses, CORS preflight, `port-conflict` status instead of failing registration. | unit (`api-gateway-events`) + integration |
| Lambda authorizers | REST `token`/`request` (payload 1.0) and HTTP API `request` (payload 1.0/2.0, `enableSimpleResponses`), identity-source extraction (missing → 401), TTL cache + `POST /api/apis/authorizer-cache/clear`, cross-service resolution by ARN through the global registry. | unit (`authorizer-service`) + integration |
| Raw `AWS::ApiGatewayV2::*` routes | `::Api`/`::Route`/`::Integration`/`::Authorizer` (+ the advisory `AWS::Lambda::Permission` grant) declared under CFN `resources:` register into the same route registry `httpApi:` events feed, whether they hang off their own `::Api` or the framework's `HttpApi`. `Target` (`integrations/<id>`, `Fn::Join`, `!Sub 'integrations/${Id}'`), `IntegrationUri`/`AuthorizerUri` (literal ARN, `Fn::GetAtt`, `Fn::Sub` incl. `${Id.Arn}`, `Fn::Join`, `Fn::ImportValue`, and the API Gateway *invocation-URI* wrapper `arn:aws:apigateway:…:lambda:path/2015-03-31/functions/<arn>/invocations`), pseudo-parameters via `Ref` **and** `Fn::Sub`, and `Permission.FunctionName` as `{Ref}`/ARN/bare name (matched by name **or** ARN) all reduce. De-duplicated against serverless-state by `(METHOD, normalized path)` — state wins. | unit (`cloudformation-parser`, `raw-api-assembler`, `raw-api-serverless-idiom`, `raw-api-cross-stack`) + integration |
| Hot reload | Watched services restart their worker on source changes; `serverless.yml` changes re-package + re-register (with `autoPackage`). | integration |
| Lambdas/APIs HTTP API | `GET /api/lambdas`, `GET /api/lambdas/:name`, `POST /api/lambdas/:name/invoke`, `GET /api/lambdas/:name/logs`, `GET /api/apis`, `GET/POST /api/services/:name/runtime{,/start,/stop}`. | unit (`routes/lambdas`, `routes/apis`) + integration |
| `LssClient` namespaces | `lambdas.list/get/invoke/logs`, `apis.list/clearAuthorizerCache`, `services.runtime/startRuntime/stopRuntime`. | unit (`client/*`) |
| Dashboard menus | Lambdas (list/detail with invoke + logs) and APIs (routes per service with listener status) sections in the Vue UI. | manual (like the rest of the UI) |

## 12b. MCP server (`npx lss mcp`)

Exposes the running orchestrator to any [Model Context Protocol](https://modelcontextprotocol.io) client
(Claude Code included) as **23 tools**, so an AI agent drives the stack directly instead of being handed
`curl` output: health/config/ports, services, resources and owners, lambdas + per-invocation logs, invoke,
HTTP routes, DynamoDB tables/scan/query/put, queues + send + **await-idle**, buckets + object listings,
secrets (names only, never values), OpenSearch search, and seeds.

JSON-RPC 2.0 over stdio, protocol revision `2024-11-05`, `tools` capability only — implemented in
`src/mcp/` with **no new runtime dependency**. It is a wrapper over this same REST API, so there is no
second source of truth. It never boots an orchestrator: a stack must already be running, and when none
answers, every tool returns one actionable error naming `npx lss start`. Mutating tools say `MUTATES` in
their description so a client can surface that before a human approves. Failures come back as error
*results* carrying the orchestrator's own message, not as transport errors. Off until a client is
configured; `.mcp.json` (project-scoped) plus the client's own toggle are the on/off switch.
Full guide: [MCP.md](MCP.md). Asserted by: unit (`mcp/protocol`, `mcp/tools`, `mcp/http`, `mcp/server`, `cli`).

## 13. Self engine (the in-process AWS emulator)

Opt-in via `engine: "self"` / `lss start --self-engine`: the orchestrator serves the AWS wire API
itself on one port (default 14566) — no Docker, no auth token. The provisioner, explorers, seeds and
application SDKs work unchanged (the endpoint is the seam); events are delivered in-process to the
LSS Lambda runtime. Coverage matrix and storage model: `docs/SELF_ENGINE.md`; design:
`docs/PRD_SELF_ENGINE.md`. Status: the only engine as of v2 — the integration suite is
the next milestone and rows below will gain integration assertions with it.

| Feature | Promise | Asserted by |
|---|---|---|
| Engine configuration | `selfEngine` config block; `LSS_ENGINE_PORT` / `LSS_ENGINE_DATA_DIR` env overrides — with `LSS_DASHBOARD_PORT`, everything a second instance needs without writing a config file. | unit (`config-manager`, `cli`) |
| Wire front door | SigV4-scope/X-Amz-Target/path routing on one port; per-protocol error shapes (`__type`, Query XML, S3 XML with body-less HEAD, Lambda + `x-amzn-ErrorType`); `x-amzn-query-error` SQS compat header; aws-chunked PutObject decoding; `fallbackEndpoint` verbatim reverse proxy for anything unimplemented. | unit (`engine/http`) |
| Storage & footprint | JSONL snapshot + WAL per table (torn-tail-safe replay, compaction), atomic JSON catalogs, content-addressed S3 blobs (never in heap), hydrate-on-first-touch + idle dehydrate + `memoryBudgetMb` LRU, debounced flushes with opt-in fsync. | unit (`engine/store`) |
| DynamoDB emulation | Full expression language (KeyCondition/Condition/Filter/Update/Projection, decimal-exact `N` arithmetic), GSI/LSI with projection + sparse semantics, Limit-before-filter parity, LEK paging, streams records, lazy TTL, `TransactWriteItems`/`TransactGetItems` (all-or-nothing, `CancellationReasons`, `ClientRequestToken` idempotency, stream records for committed writes only), AWS error names the provisioner relies on. | unit (`engine/dynamodb`, `engine/dynamodb/transactions`) |
| SQS emulation | Queues (FIFO groups/dedup), event-driven long poll, visibility redelivery, **queue-level redrive** (`RedrivePolicy` → DLQ once `ApproximateReceiveCount` exceeds `maxReceiveCount`, preserving `MessageId`/body/MD5s and releasing the FIFO `MessageGroupId`), live counters for QueueInspector, MD5 digests, CreateQueue idempotency duality. | unit (`engine/sqs`, `wire-sqs-redrive`) |
| S3 emulation | Buckets, binary-exact object round trips, Range reads, ListObjectsV2 pagination/delimiter/encoding, DeleteObjects, CopyObject, presigned POST (browser multipart form upload: `${filename}`, `success_action_status`/`redirect`, `x-amz-meta-*`), presigned GET/HEAD `response-*` header overrides (content-disposition/type/…), CORS (`Put`/`Get`/`DeleteBucketCors`, preflight `OPTIONS`, `Access-Control-Allow-Origin` on responses; matching rule or dev-permissive default), notification configuration (incl. legacy XML names), versioning flag. | unit (`engine/s3`, `engine/s3/s3-post`, `engine/s3/multipart`, `engine/s3/s3-cors`) |
| EventBridge + SNS + STS | Buses/rules/targets, PutEvents per-entry results, pattern matcher (exact/array-OR/prefix/exists/nested; unsupported operators rejected at PutRule), minimal SNS, `GetCallerIdentity`. | unit (`engine/events`, `engine/sns-sts`) |
| OpenSearch Serverless emulation | `aoss` control plane (Create/BatchGet/List/DeleteCollection, deterministic ids, `collectionEndpoint` handed out) + the OpenSearch REST data plane under `/_aoss/<collection>`: index/document CRUD with versioning, `_bulk` NDJSON, `_search` (match/term/terms/range/prefix/wildcard/exists/ids/bool, sort, `_source` filtering, `terms`+metric aggregations), `_count`, `_mapping`, `_cat/indices`; OpenSearch-shaped errors; unsupported operators rejected loudly. | unit (`engine/opensearch`, `engine/http/router`) |
| Secrets Manager emulation | Create/Get/Put/Update/DescribeSecret, DeleteSecret (recovery window + `ForceDeleteWithoutRecovery`), RestoreSecret, ListSecrets, Tag/UntagResource, GetRandomPassword — real `AWSCURRENT`/`AWSPREVIOUS` staging, `SecretString`/`SecretBinary`, `ClientRequestToken` idempotency, per-region scoping (values persisted, not encrypted; `KmsKeyId` accepted and ignored). Rotation/replication/resource-policies rejected. Secrets exist before the first read: CFN `AWS::SecretsManager::Secret` is provisioned at registration and boot seeds (`seeds/secrets/<name>.json` + the config `secrets:` map, §8) are applied before services are reactivated — both idempotent and non-fatal. Backs the Secrets explorer/tab. | unit (`engine/secretsmanager`, `secrets-explorer`, `secret-value`, `engine/wire-secret-seed-on-boot`) |
| Lambda control plane | Proxy absorption as metadata (INVOKE_URL kept as HTTP fallback), ESM lifecycle with `Enabled` toggle (QueueInspector hold/release), Invoke passthrough (`X-Amz-Invocation-Type`). | unit (`engine/lambda-ctl`) |
| In-process event delivery | SQS→Lambda loops (batch size/window, visibility semantics), DynamoDB stream tailers (TRIM_HORIZON/LATEST, retry-then-advance, OnFailure destination), S3 notification fan-out (globs + prefix/suffix), EventBridge rule/schedule targets to **Lambda (invoke) or SQS (enqueue; FIFO `MessageGroupId`)** with `Input`/`InputPath`, schedules (`rate` + 6-field cron) — no proxies, no polling loops. | unit (`engine/dispatch`, `engine/self-backend`) |
| Event source mapping semantics | `FilterCriteria` **enforced** on stream and SQS mappings (it used to be stored and echoed but ignored): each `Filters[].Pattern` is a JSON-encoded EventBridge-style content filter, patterns OR'd and sibling keys inside a pattern AND'd through the engine's own matcher; absent/empty criteria filter nothing; structurally invalid criteria are rejected at write time (`InvalidArgumentException`, AWS limit of 5 patterns, unsupported operators); filtered-out stream records still advance the cursor (dropped once, never replayed) and filtered-out SQS messages leave the batch before the handler runs. `maximumRetryAttempts` follows AWS: omitted or `-1` retries until the record **ages out of the stream** (no 5-attempt cap, and an explicit `-1` no longer skips the invocation entirely), a positive N means N retries, and the ending condition (`RetryAttemptsExhausted`/`RecordAgeExpired`) is logged and carried on the `OnFailure` envelope. `ReportBatchItemFailures` honored on both: streams checkpoint just before the **earliest** still-failing record and forward only that suffix to the destination (empty list commits the batch, a malformed response retries it, the attempt budget is not reset when the suffix shrinks); SQS deletes only the receipt handles **not** reported as failures, so the rest redeliver on visibility timeout. | unit (`engine/dispatch/filter-criteria`, `engine/dispatch/stream-tailer`, `engine/dispatch/sqs-poller`, `engine/wire-esm-partial-batch`) |

---

### How the integration suite boots

`tests/integration/features.test.ts` uses an isolated config fixture
(`tests/integration/fixtures/lss.integration.config.json`: distinct ports, its own `stateDir`,
`persistence: false`, `autoPackage`), runs `npx lss start --config <fixture>`, registers
the `tests/integration/fixtures/sample-microservice` rig, asserts the rows above via the HTTP API, then
`npx lss stop --config <fixture>` and removes the state dir — there is no container or volume to reap.
It runs **unconditionally**, locally and in CI: no Docker, no secret, ~20 seconds. (Under v1 the same
suite skipped itself whenever the LocalStack auth token was absent, which was most of the time.)
