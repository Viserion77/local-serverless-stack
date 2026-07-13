# LSS — Promised Features

This is the canonical inventory of what `local-serverless-stack` (LSS) promises. It doubles as the
checklist for the integration suite (`tests/integration/features.test.ts`), which boots a real isolated
LSS + LocalStack and asserts each capability against the live HTTP API.

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
| `lss start` | Starts the orchestrator (managed LocalStack by default) in the background; writes a PID file and logs. | integration (`features.test.ts` boots via `lss start --config`) + unit (`cli`) |
| `lss stop` | Gracefully stops the orchestrator addressed by the active config. | integration (`features.test.ts` teardown) + unit (`cli`) |
| `lss status` | Reports RUNNING/NOT RUNNING + ports for the addressed instance. | unit (`cli`) |
| `lss logs` | Prints the tail of the instance log. | unit (`cli`) |
| `lss seed [table]` | Applies `{table}.json` seed files from `seedsDir` into DynamoDB (all matching tables, or one). | unit (`cli-seed`) + integration |
| `lss seed:clear [table]` | Deletes seeded items after an interactive `confirmar` prompt (or `--yes`); refuses any non-local endpoint. | unit (`cli-seed`, `seed-manager-guard`) |
| `--config <path>` | Loads config from an explicit file, taking precedence over the cwd/home search; also via `LSS_CONFIG`. | unit (`cli`) + integration |
| `--external` / `--pro` / `--localstack-token` | Connect to an external LocalStack / use the Pro image / pass an auth token. | unit (`cli`) |

## 2. Configuration & instance isolation

| Feature | Promise | Asserted by |
|---|---|---|
| `lss.config.json` / `.lssrc` | File config for ports, mode, edition, services, seeds, etc.; env vars override. | unit (`config-manager`, `cli`) |
| `stateDir` | Per-instance PID/log directory so an isolated test instance never collides with the dev instance. | unit (`cli`, `config-manager`) + integration |
| `LSS_CONFIG_PATH` passthrough | The CLI hands the chosen config to the spawned server so both loaders agree on ports/seedsDir/region/mode. | unit (`config-manager`) + integration |
| Managed vs external mode | `mode: managed` runs a LocalStack container; `external` connects to a running one. | unit (`config-manager`) |
| Edition / version / image / services / persistence / region | All configurable; sensible defaults (community/latest, us-east-1, dynamodb+sqs+sns+s3+lambda+events). | unit (`config-manager`) |
| `GET /api/config` | Public-safe config snapshot for the UI (never leaks the auth token — only `hasAuthToken`). | unit (`routes/config`) + integration |

## 3. Resource provisioning (from CloudFormation)

LSS parses the CloudFormation template produced by `serverless package` and provisions the resources in
LocalStack. `autoPackage` can run the packaging command on demand when the template is missing.

| Resource | Promise | Asserted by |
|---|---|---|
| DynamoDB tables | Created with key schema, GSIs/LSIs, streams, TTL. | unit (`cloudformation-parser`, `resource-provisioner`, `dynamo-explorer`) + integration |
| SQS queues | Created (incl. FIFO), with visibility timeout / retention. | unit + integration |
| SNS topics | Created and discoverable. | unit + integration |
| S3 buckets | Created with versioning and `s3:ObjectCreated:*` notifications (prefix/suffix filters). | unit + integration |
| Lambda event source mappings | SQS→Lambda and DynamoDB Stream→Lambda wired via LocalStack. | unit (`resource-provisioner`) + integration |
| EventBridge buses & rules | `AWS::Events::EventBus` created in LocalStack; `AWS::Events::Rule` (pattern or schedule) wired to Lambda targets through the same proxy → invoke-API model; `AWS::Events::Archive` skipped with a warning (LocalStack mocks it). | unit (`cloudformation-parser`, `resource-provisioner`) |
| OpenSearch Serverless collections | `AWS::OpenSearchServerless::Collection` created via the `aoss` control plane (idempotent on `ConflictException`); `SecurityPolicy`/`AccessPolicy`/`VpcEndpoint` accepted and skipped with a warning (nothing enforces them locally); on engines without an aoss provider (community LocalStack) the failure names the self engine as the fix. | unit (`cloudformation-parser`, `resource-provisioner`) |
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

## 7. S3 explorer (`/api/buckets`)

`GET /`, `GET /:name`, `GET /:name/objects`, `GET /:name/objects/content`, `POST /:name/objects`,
`DELETE /:name/objects` — list buckets (with object/size totals, versioning, notifications), list/stream/upload
(base64 or utf8)/delete objects. Asserted by: unit (`s3-explorer`, `routes/buckets`) + integration.

## 8. Seeds (`/api/seeds`)

`GET /` (seed files + live tables), `POST /run`, `POST /clear` — auto-seed on table creation and on-demand
seed/clear, with a seed-file ↔ live-table mismatch diagnostic and a hard local-endpoint guard on clear.
Asserted by: unit (`seed-manager`, `routes/seeds`, `cli-seed`, `seed-manager-guard`) + integration.

## 9. DynamoDB proxy (dev)

Optional reverse proxy (`enableDynamoProxy` / `dynamoProxyPort`, default 8000) forwarding to the active AWS
engine (LocalStack, or the self engine when `engine: "self"`), for tools that expect DynamoDB on the standard
port. Asserted by: unit (`dev/dynamo-proxy`).

## 10. Health & dashboard

`GET /api/health` reports orchestrator + engine + dynamo-proxy status (the `localstack` field reports the
active engine's health — LocalStack or self — kept under that name for compatibility). The Vue dashboard
(served as a SPA) surfaces nine tabs — Overview / Services / Lambdas / APIs / Queues / S3 / DynamoDB /
OpenSearch / Secrets — with a region selector and theme toggle; the Services list and service detail pages
include the per-service resource breakdown with EventBridge buses & rules and OpenSearch collections (UI is
exercised manually, not in the automated suites).

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
until LocalStack is up. The constructor resolves the target from options → env (`LSS_CONFIG`, `LSS_BASE_URL`,
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
so monorepo callers and the LocalStack event proxies keep their ports and contracts with no
serverless-offline process running. See `docs/PRD_API_LAMBDA_EMULATION.md` for the full design.

| Feature | Promise | Asserted by |
|---|---|---|
| Function & route registry | `sls package` registers functions, REST (`http`, payload v1) and HTTP API (`httpApi`, payload v2) routes and authorizers; persisted in the service cache and rehydrated on restart. | unit (`serverless-state-parser`, `function-registry`, `cache-manager`) |
| Lambda runtime workers | One worker per service loads handlers lazily (warm starts), applies function env/timeout/context, captures per-invocation logs, restarts on crash. | unit (`api-gateway-events` helpers) + integration |
| Execution modes | `artifact` (extracted `sls package` zip — TS/JS uniform), `source` (direct require/import; TS uses Node native type stripping when available, then `esbuild-register`/`tsx`/`ts-node`), `auto` picks artifact when present. | unit (`config-manager`) + integration |
| Invoke API (130xx) | `POST /2015-03-31/functions/{name}/invocations` with `X-Amz-Invocation-Type` (RequestResponse 200 / Event 202 / DryRun 204) and `X-Amz-Function-Error` — same contract the LocalStack event proxies already call. | integration |
| Gateway proxy (30xx) | Multi-port routing (literal > `{param}` > `{proxy+}` > `$default`; exact method > ANY), API Gateway payload v1/v2 events, v1 malformed → 502, v2 inferred responses, CORS preflight, `port-conflict` status instead of failing registration. | unit (`api-gateway-events`) + integration |
| Lambda authorizers | REST `token`/`request` (payload 1.0) and HTTP API `request` (payload 1.0/2.0, `enableSimpleResponses`), identity-source extraction (missing → 401), TTL cache + `POST /api/apis/authorizer-cache/clear`, cross-service resolution by ARN through the global registry. | unit (`authorizer-service`) + integration |
| Hot reload | Watched services restart their worker on source changes; `serverless.yml` changes re-package + re-register (with `autoPackage`). | integration |
| Lambdas/APIs HTTP API | `GET /api/lambdas`, `GET /api/lambdas/:name`, `POST /api/lambdas/:name/invoke`, `GET /api/lambdas/:name/logs`, `GET /api/apis`, `GET/POST /api/services/:name/runtime{,/start,/stop}`. | unit (`routes/lambdas`, `routes/apis`) + integration |
| `LssClient` namespaces | `lambdas.list/get/invoke/logs`, `apis.list/clearAuthorizerCache`, `services.runtime/startRuntime/stopRuntime`. | unit (`client/*`) |
| Dashboard menus | Lambdas (list/detail with invoke + logs) and APIs (routes per service with listener status) sections in the Vue UI. | manual (like the rest of the UI) |

## 13. Self engine (in-process AWS emulator — LocalStack replacement)

Opt-in via `engine: "self"` / `lss start --self-engine`: the orchestrator serves the AWS wire API
itself on one port (default 14566) — no Docker, no auth token. The provisioner, explorers, seeds and
application SDKs work unchanged (the endpoint is the seam); events are delivered in-process to the
LSS Lambda runtime. Coverage matrix and storage model: `docs/SELF_ENGINE.md`; design:
`docs/PRD_SELF_ENGINE.md`. Status: v1 — the differential (self vs LocalStack) integration suite is
the next milestone and rows below will gain integration assertions with it.

| Feature | Promise | Asserted by |
|---|---|---|
| Engine selection | `engine`/`selfEngine` config keys, `LSS_ENGINE`/`LSS_ENGINE_PORT` env, `--self-engine` CLI (rejected combined with `--external`/`--pro`/`--localstack-token`); LocalStack remains the default. | unit (`config-manager`, `cli`) |
| Wire front door | SigV4-scope/X-Amz-Target/path routing on one port; per-protocol error shapes (`__type`, Query XML, S3 XML with body-less HEAD, Lambda + `x-amzn-ErrorType`); `x-amzn-query-error` SQS compat header; aws-chunked PutObject decoding; `/_localstack/health` alias; `fallbackEndpoint` verbatim reverse proxy for anything unimplemented. | unit (`engine/http`) |
| Storage & footprint | JSONL snapshot + WAL per table (torn-tail-safe replay, compaction), atomic JSON catalogs, content-addressed S3 blobs (never in heap), hydrate-on-first-touch + idle dehydrate + `memoryBudgetMb` LRU, debounced flushes with opt-in fsync. | unit (`engine/store`) |
| DynamoDB emulation | Full expression language (KeyCondition/Condition/Filter/Update/Projection, decimal-exact `N` arithmetic), GSI/LSI with projection + sparse semantics, Limit-before-filter parity, LEK paging, streams records, lazy TTL, `TransactWriteItems`/`TransactGetItems` (all-or-nothing, `CancellationReasons`, `ClientRequestToken` idempotency, stream records for committed writes only), AWS error names the provisioner relies on. | unit (`engine/dynamodb`, `engine/dynamodb/transactions`) |
| SQS emulation | Queues (FIFO groups/dedup), event-driven long poll, visibility redelivery, live counters for QueueInspector, MD5 digests, CreateQueue idempotency duality. | unit (`engine/sqs`) |
| S3 emulation | Buckets, binary-exact object round trips, Range reads, ListObjectsV2 pagination/delimiter/encoding, DeleteObjects, CopyObject, presigned POST (browser multipart form upload: `${filename}`, `success_action_status`/`redirect`, `x-amz-meta-*`), notification configuration (incl. legacy XML names), versioning flag. | unit (`engine/s3`, `engine/s3/s3-post`, `engine/s3/multipart`) |
| EventBridge + SNS + STS | Buses/rules/targets, PutEvents per-entry results, pattern matcher (exact/array-OR/prefix/exists/nested; unsupported operators rejected at PutRule), minimal SNS, `GetCallerIdentity`. | unit (`engine/events`, `engine/sns-sts`) |
| OpenSearch Serverless emulation | `aoss` control plane (Create/BatchGet/List/DeleteCollection, deterministic ids, `collectionEndpoint` handed out) + the OpenSearch REST data plane under `/_aoss/<collection>`: index/document CRUD with versioning, `_bulk` NDJSON, `_search` (match/term/terms/range/prefix/wildcard/exists/ids/bool, sort, `_source` filtering, `terms`+metric aggregations), `_count`, `_mapping`, `_cat/indices`; OpenSearch-shaped errors; unsupported operators rejected loudly. | unit (`engine/opensearch`, `engine/http/router`) |
| Secrets Manager emulation | Create/Get/Put/Update/DescribeSecret, DeleteSecret (recovery window + `ForceDeleteWithoutRecovery`), RestoreSecret, ListSecrets, Tag/UntagResource, GetRandomPassword — real `AWSCURRENT`/`AWSPREVIOUS` staging, `SecretString`/`SecretBinary`, `ClientRequestToken` idempotency, per-region scoping (values persisted, not encrypted; `KmsKeyId` accepted and ignored). Rotation/replication/resource-policies rejected; CFN `AWS::SecretsManager::Secret` not yet provisioned on registration (create via SDK). Backs the Secrets explorer/tab. | unit (`engine/secretsmanager`, `secrets-explorer`) |
| Lambda control plane | Proxy absorption as metadata (INVOKE_URL kept as HTTP fallback), ESM lifecycle with `Enabled` toggle (QueueInspector hold/release), Invoke passthrough (`X-Amz-Invocation-Type`). | unit (`engine/lambda-ctl`) |
| In-process event delivery | SQS→Lambda loops (batch size/window, visibility semantics), DynamoDB stream tailers (TRIM_HORIZON/LATEST, retry-then-advance, OnFailure destination), S3 notification fan-out (globs + prefix/suffix), EventBridge targets (`Input`/`InputPath`), schedules (`rate` + 6-field cron) — all through `LambdaRuntimeManager.invoke()`, no proxies, no polling loops. | unit (`engine/dispatch`, `engine/self-backend`) |

---

### How the integration suite boots

`tests/integration/features.test.ts` uses an isolated config fixture
(`tests/integration/fixtures/lss.integration.config.json`: distinct ports, its own `stateDir`, managed mode,
`autoPackage`, token from `LOCALSTACK_AUTH_TOKEN`), runs `npx lss start --config <fixture>`, registers
the `tests/integration/fixtures/sample-microservice` rig, asserts the rows above via the HTTP API, then `npx lss stop --config <fixture>`
and removes the scoped LocalStack container/volume. It runs locally and in a CI job gated on the
`LOCALSTACK_AUTH_TOKEN` secret (community LocalStack images ≥ 2026.5 require a token).
