# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-07-10

The self engine: an in-process AWS emulator that replaces LocalStack for the typical serverless dev loop — DynamoDB, SQS, S3, EventBridge, SNS (minimal), Lambda control plane and STS served by the orchestrator itself on one port. No Docker, no container, no auth token; boots in milliseconds; data persisted in local files. Opt-in (`engine: "self"` / `lss start --self-engine`) — LocalStack mode remains the default and fully supported. Design: `docs/PRD_SELF_ENGINE.md`; coverage matrix: `docs/SELF_ENGINE.md`.

### Added
- **Engine selection**: `engine: "localstack" | "self"` and a `selfEngine` config block (`port` default 14566 — deliberately outside the 4566–4599 range a real LocalStack intercepts on some hosts —, `dataDir`, `account`, `idleUnloadMs`, `memoryBudgetMb`, `fsync`, `fallbackEndpoint`); env overrides `LSS_ENGINE`/`LSS_ENGINE_PORT`; CLI `lss start --self-engine` (rejected when combined with the LocalStack-only `--external`/`--pro`/`--localstack-token`).
- **AWS wire front door** (`src/server/engine/http/`): one `node:http` listener routing by SigV4 credential scope → `X-Amz-Target` → path heuristics; per-protocol error serialization (JSON `__type`, Query XML, S3 XML with body-less HEAD errors, Lambda REST + `x-amzn-ErrorType`); the `x-amzn-query-error` SQS compat header; `aws-chunked` request decoding (SDK v3 streaming PutObject); `x-amzn-RequestId` on every response; `/_localstack/health` alias so existing readiness polls keep working; `selfEngine.fallbackEndpoint` reverse-proxies any unimplemented service/operation verbatim to a LocalStack during migration — unsupported calls otherwise fail loudly, never silently succeed.
- **File-backed store** (`src/server/engine/store/`): JSONL snapshot + append-only WAL per data table (torn-tail-safe replay, seq-based compaction), atomic JSON catalogs for metadata, content-addressed blob storage for S3 bodies (never held in the heap); registration writes metadata only — data hydrates on first touch (streamed line-by-line) and dehydrates after `idleUnloadMs` or under the `memoryBudgetMb` LRU budget; debounced flushes (20 ms / 256 KB) with opt-in fsync.
- **DynamoDB emulator** with a hand-rolled expression engine (KeyCondition/Condition/Filter/Update/Projection: comparators, `BETWEEN`/`IN`, boolean precedence, document paths, `SET`/`REMOVE`/`ADD`/`DELETE` with exact decimal-string `N` arithmetic), GSI/LSI queries with projection and sparse-index semantics, `Limit`-before-filter parity, `LastEvaluatedKey` paging (including index LEKs), lazy TTL (filtered at read, purged at compaction with Service-identity stream REMOVEs), stream records (`INSERT`/`MODIFY`/`REMOVE` per `StreamViewType`), batch ops, and the full `DescribeTable` introspection shape (`LatestStreamArn` present immediately).
- **SQS emulator**: FIFO (per-group ordering, 5-minute dedup window), event-driven long polling (parked promises — no polling loops), visibility-timeout redelivery, live `ApproximateNumberOfMessages*` counters (QueueInspector `await-idle`/metrics work unchanged), `MD5OfMessageBody`/`MD5OfMessageAttributes`, CreateQueue idempotent-success on identical attributes; messages are memory-only with a graceful-shutdown snapshot under `persistence`.
- **S3 emulator**: byte-exact object round trips, `Range` reads, `ListObjectsV2` (prefix/delimiter/CommonPrefixes/continuation/`encoding-type=url`), `DeleteObjects`, `CopyObject`, versioning flag, notification configuration (including the legacy `CloudFunctionConfiguration` XML names), quoted-MD5 ETags, `GetBucketLocation` us-east-1 quirk; multipart answers an explicit `NotImplemented` until the hardening phase.
- **EventBridge emulator**: buses, rules with validated patterns (exact, array-OR, `prefix`, `exists`, nested keys; unsupported operators rejected at `PutRule` with `InvalidEventPatternException`), targets, `PutEvents` with per-entry results, plus minimal **SNS** (topics + logged `Publish`) and **STS** (`GetCallerIdentity`).
- **Lambda control plane**: the provisioner's proxy functions are absorbed as metadata (zip discarded, `INVOKE_URL` kept — it doubles as the HTTP fallback for services still on serverless-offline), event source mappings with UUIDs persisted across restarts, `UpdateEventSourceMapping Enabled` = QueueInspector hold/release, `Invoke` honoring `X-Amz-Invocation-Type`.
- **In-process event dispatch** (`src/server/engine/dispatch/`): SQS delivery loops (batch size + `MaximumBatchingWindowInSeconds`, failure → visibility redelivery, capped backoff on runtime-unavailable), DynamoDB stream tailers (`TRIM_HORIZON`/`LATEST`, retry-then-advance with the `DDBStreamBatchInfo` OnFailure SQS envelope), S3 notification fan-out (event globs + prefix/suffix filters, `eventVersion 2.1` records), EventBridge target invocation (`Input`/`InputPath`) and **schedule triggering** (`rate()` + 6-field AWS cron, single timer wheel) — all delivered straight into the LSS Lambda runtime: no proxy Lambdas, no HTTP hop, no polling containers. Closes the long-standing scheduled-triggers TODO for self-engine mode.
- **Example `examples/self-engine-sample`**: three microservices (orders → billing → notifications) exercising DynamoDB + SQS (cross-service ESM by ARN) + S3 + EventBridge on the self engine, registered with `sls package` only. Measured: engine boot ~10 ms; the full pipeline across the three services completes in ~170 ms — no Docker.
- **Docs**: `docs/SELF_ENGINE.md` (coverage matrix, storage model, known divergences), `docs/PRD_SELF_ENGINE.md` (design), FEATURES.md §13, CONFIGURATION.md and README (self engine as the headline feature).

### Changed
- **Dashboard component library updated**: `@treeui/vue` `^0.6.1` → `^0.10.0` (latest). No API changes required in the LSS components — `vue-tsc` and the Vite build pass unchanged.
- **Engine seam**: the LocalStack container lifecycle moved to `src/server/engine/backends/localstack-backend.ts`; `services/localstack-manager.ts` is now a thin facade over the new `EngineManager`, so the provisioner/explorers/seeds keep their imports and work against whichever engine is active (they always speak AWS SDK to `getConfig().endpoint`). Self-engine code is loaded via dynamic `import()` — LocalStack-mode memory footprint is unchanged.
- `lambdaRuntime.invokeHost` defaults to `127.0.0.1` in self-engine mode (nothing runs inside Docker); explicit config still wins.
- `GET /api/health` now includes an `engine: {kind, running, endpoint, ...}` block; the `localstack` boolean stays truthy when the active engine is healthy (client/UI compatibility).
- The root package version is now `0.8.0`. The `serverless-lss` plugin package was not changed.

### Tests
- ~700 new unit tests (1796 total, up from 1100): wire router/SigV4/aws-chunked, store WAL/compaction/hydration/LRU-budget, DynamoDB expression engine (223 assertions) + emulator core, SQS/S3/EventBridge/SNS/STS/lambda-ctl emulators, dispatcher loops/stream tailers/scheduler, self-backend boot; engine selection covered in `config-manager` and `cli` suites. End-to-end smoke with real AWS SDK v3 clients against a booted engine (CRUD/Query/GSI, queue lifecycle, binary S3 round trip, per-entry PutEvents, ESM hold, restart persistence).

## [0.7.0] - 2026-07-10

EventBridge support: LSS can now provision the shared event bus and rule→Lambda triggers that previously required the last remaining `serverless deploy` (CloudFormation) step in local monorepo setups.

### Added
- **`AWS::Events::EventBus` provisioning**: buses declared in the `resources:` section are created in LocalStack on registration (idempotent — re-registration tolerates an existing bus). `PutEvents` from handlers already worked via the SDK; the bus just had to exist.
- **`AWS::Events::Rule` triggers**: rules (event pattern or schedule, `ENABLED`/`DISABLED` state honored) are created on the declared bus and their Lambda targets wired through the same proxy model used by streams/SQS — EventBridge → proxy Lambda in LocalStack → LSS invoke API (130xx). Target `Input`/`InputPath` pass through; the bus is resolved from the template's logical ids, a literal name, or an ARN. Rules whose `EventBusName` can't be resolved from the template (e.g. `Fn::ImportValue`) are skipped with a warning instead of silently landing on the default bus.
- **Resources-only stacks**: a registered service that declares only `resources:` (no functions, no ports) provisions its resources without starting a runtime worker, gateway listeners or watcher — this already worked structurally since 0.5.0 gated those on declared functions/ports, and is now covered by tests for the EventBus-only infra-stack case.
- **Cleanup parity**: unregistering a service removes rule targets and rules first, then deletes its event buses.
- **Dashboard visibility**: EventBridge buses and rules show up in the service detail page (own sections) and as counters in the services list (`resourceBreakdown.buses`/`eventRules`), so a resources-only infra stack no longer renders as "N total" with an empty body.
- **Example `examples/eventbridge-sample`**: resources-only `events-stack` owning the shared bus (+ skipped Archive), a producer publishing `UserSignedUp` via `PutEvents`, and a consumer with an `events: eventBridge` trigger storing events in DynamoDB — registered with `sls package` only, no deploy. Its LocalStack runs on port `14566`, outside the standard 4566–4599 range, so a real LocalStack publishing that range (docker-compose defaults) can't intercept the example's `localhost` traffic on Docker Desktop/WSL2.

### Fixed
- **EventBridge event shape through proxies**: the generated LocalStack proxy Lambda no longer wraps EventBridge events in a `Records` array — handlers receive `source`/`detail-type`/`detail` at the top level, exactly like on AWS. SQS/DynamoDB/SNS batches keep their `Records` shape. Proxies created by earlier versions keep the old code until recreated (only their `INVOKE_URL` is updated in place); delete the proxy function or reset LocalStack to pick up the fix.

### Changed
- `AWS::Events::Archive` resources are accepted and skipped with a registration warning: LocalStack mocks Archives (CloudFormation reports `CREATE_COMPLETE` but `ListArchives` stays empty), so provisioning one locally would only fake success.
- `CloudFormationParser.parse()` accepts an optional warnings sink; the registrar forwards template-level warnings (like skipped Archives) to the registering client alongside state-file warnings.
- New runtime dependency: `@aws-sdk/client-eventbridge`.

### Tests
- Parser coverage for `AWS::Events::EventBus`/`Rule`/`Archive` (bus name fallback, pattern/schedule/state, `Fn::ImportValue` flagging, literal-ARN targets, warning sink) and ResourceProvisioner coverage for bus creation, rule wiring (proxy reuse, permissions, default vs named vs literal bus), unresolvable-bus/unsupported-target skips, and cleanup ordering.

## [0.6.0] - 2026-07-09

Corrections from integrating LSS 0.5.0 in a real monorepo using osls 4, serverless-esbuild ESM artifacts, HTTP API v2 authorizers, DynamoDB Streams, and Docker-in-Docker devcontainers.

### Added
- **Configurable LocalStack proxy callback host**: `lambdaRuntime.invokeHost` and `LSS_INVOKE_HOST` now control the host used when generated LocalStack Lambda proxies call back into LSS's invoke listener. The default remains `host.docker.internal`; devcontainers/DinD can point it at the Docker network gateway (for example `172.19.0.1`).
- **Native TypeScript source loading when available**: in `source` mode, the runtime worker now tries Node's native TypeScript type stripping (`process.features.typescript`) before requiring `esbuild-register`, `tsx`, or `ts-node`.

### Fixed
- **Artifact resolution for osls/serverless package output**: `package.artifact` values such as `s7-identity.zip` are now resolved relative to `.serverless/` as well as the service root, and nonexistent declared candidates no longer suppress the `.serverless/*.zip` scan fallback.
- **Stale LocalStack proxy `INVOKE_URL`**: re-registering a service now updates an existing proxy Lambda when the expected invoke URL changed (port renumbering or `invokeHost` changes).
- **Service identity collisions**: service registration now uses the `service:` name from `serverless-state.json` instead of the directory basename, with migration for same-root legacy cache entries.
- **Event source mapping fidelity**: CloudFormation `StartingPosition`, `MaximumRetryAttempts`, `FunctionResponseTypes`, `MaximumBatchingWindowInSeconds`, `FilterCriteria`, and `DestinationConfig.OnFailure` are parsed/applied where supported; duplicate checks compare the resolved live ARN instead of unresolved CFN refs.
- **DynamoDB table fidelity**: `StreamViewType` is preserved and `TimeToLiveSpecification` is applied after table creation or on re-registration, including disabled TTL declarations.
- **CLI stop/start race**: `lss stop` now waits for the orchestrator process to exit (with timeout) before returning, reducing immediate `lss start` failures from a still-bound port.

### Changed
- The root package version is now `0.6.0`. The `serverless-lss` plugin package was not changed.

### Tests
- Added/updated unit coverage for artifact resolution, Lambda runtime config env overrides, CloudFormation parsing, ResourceProvisioner proxy/TTL/event-source behavior, and the async CLI stop flow.

## [0.5.0] - 2026-07-08

API Gateway & Lambda runtime emulation: LSS now registers every function and HTTP route a service declares, executes the handlers itself in per-service workers, and answers on the service's own API (30xx) and Lambda-invoke (130xx) ports — making `serverless-offline` optional. Monorepo callers and the LocalStack event proxies keep their ports and contracts unchanged; only the process answering changes.

### Added
- **Function & route registry**: `POST /api/services/register` (and the `serverless-lss` plugin on `sls package`) now also parses `.serverless/serverless-state.json` — functions (name, handler, runtime, env, memory, timeout, triggers, artifact), REST (`http`, payload v1) and HTTP API (`httpApi`, payload v2) routes, and Lambda authorizers — persisted in the service cache and rehydrated on orchestrator restart. The plugin additionally reports `apiPort` (`custom.lss.apiPort` > `custom['serverless-offline'].httpPort`; same for `invokePort`/`lambdaPort`).
- **Lambda runtime workers** (`lambda-runtime-manager.ts` + `runtime/runtime-worker.ts`): one forked worker per service loads handlers lazily (warm starts), applies per-function env/timeout, builds a faithful Lambda `context`, captures `console.*` per invocation via `AsyncLocalStorage`, tolerates handler crashes (auto-restart with backoff) and enforces timeouts with the classic `Task timed out after N seconds` shape. Execution modes: `artifact` (extracts the `sls package` zip — TS and JS handlers arrive compiled), `source` (requires handlers from the source tree; TS via `esbuild-register`/`tsx`/`ts-node` resolved from the service's or LSS's node_modules), `auto` (artifact when a zip exists). Configured globally (`lambdaRuntime`) or per service (`serviceRuntime`).
- **AWS Lambda Invoke API per service (130xx)**: `POST /2015-03-31/functions/{name}/invocations` honoring `X-Amz-Invocation-Type` (`RequestResponse` 200, `Event` 202, `DryRun` 204) and `X-Amz-Function-Error`/`X-Amz-Log-Result` — the exact contract the LocalStack event-source proxies already call, so SQS/stream/S3 flows work with no serverless-offline running and zero provisioner changes. **Every** registered function is invocable this way, including schedule/queue-only ones.
- **API Gateway emulator per service (30xx)**: multi-port gateway inside the orchestrator process (no extra processes). Route matching (literal > `{param}` > `{proxy+}` > `$default`; exact method > `ANY`), API Gateway event payloads v1.0/v2.0 (multi-value headers/query, cookies, base64 bodies), response mapping with real semantics (v1 malformed proxy response → 502; v2 inferred responses), CORS preflight answering, and a `port-conflict` listener status instead of a failed registration when serverless-offline still owns the port.
- **Lambda authorizers**: REST `token` and `request` (payload 1.0) and HTTP API `request` (payload 1.0/2.0 with `enableSimpleResponses`), identity-source extraction for v1 (`method.request.header.x`) and v2 (`$request.header.x`) styles (missing source → 401 without invoking), IAM-policy and simple-response interpretation (deny → 403), result caching per `resultTtlInSeconds` with `POST /api/apis/authorizer-cache/clear` (global/per-service/per-authorizer) for e2e identity switches, and **cross-service resolution**: an authorizer `arn` pointing at another registered service's function resolves through the global registry — something serverless-offline cannot do in a monorepo.
- **Hot reload** (`source-watcher.ts`): watched services restart their runtime worker on source changes (module cache flush); `serverless.yml`/`package.json` changes re-package (with `autoPackage`) and fully re-register. Defaults: on in source mode, off in artifact mode; `watch` configurable globally/per service.
- **New orchestrator endpoints**: `GET /api/lambdas` (+ `/:name`, `POST /:name/invoke`, `GET /:name/logs`), `GET /api/apis`, `POST /api/apis/authorizer-cache/clear`, `GET /api/services/:name/runtime`, `POST /api/services/:name/runtime/start|stop`; `GET /api/services` now reports `functionsCount`/`routesCount`/`runtimeStatus`/`gateway`.
- **`LssClient`**: new `lambdas` (`list`/`get`/`invoke`/`logs`) and `apis` (`list`/`clearAuthorizerCache`) namespaces plus `services.runtime`/`startRuntime`/`stopRuntime`; `RegisterServiceInput.apiPort`.
- **Dashboard**: new **Lambdas** (list + detail with JSON invoke, triggers, env, invocation logs) and **APIs** (routes per service with listener status, authorizers, copy-as-curl) sections.
- **Example `examples/multi-service-sample`**: three microservices (TypeScript + JavaScript, REST v1 + HTTP API v2) on community LocalStack exercising local and cross-service authorizers, SQS event flow and an invocable scheduled function — with no serverless-offline dependency.
- **PRD**: `docs/PRD_API_LAMBDA_EMULATION.md` documents the full design (Portuguese, like the original proposal doc).

### Changed
- `/api/services/register` accepts `apiPort` and derives a missing `invokePort` as `apiPort + lambdaRuntime.invokePortOffset` (default 10000 — the 30xx→130xx monorepo convention). Registration/activation logic was factored out of the route into `service-registrar.ts`.
- `serverless-lss` plugin package bumped to `0.2.0` because its registration payload now includes API Gateway port metadata (`apiPort`).

## [0.4.0] - 2026-06-08

Per-service and global package parameters for `autoPackage`, so different microservices can package with different `serverless` params/env (e.g. one service needs `--param=custom-stage=offline` while others use the plain command).

### Added
- **Per-service & global package parameters for `autoPackage`**: the auto-package step (run when a service's CloudFormation template is missing on `/register`) is no longer locked to a single global `packageCommand` for every service. Three new `lss.config.json` fields let you configure what the package command receives, and the orchestrator consults them before spawning: `packageArgs` (string[], extra args appended to every package command), `packageEnv` (object, extra env vars merged over the child's env), and `servicePackaging` (object — per-service overrides of `packageCommand`/`packageArgs`/`packageEnv`/`packageTimeoutMs`). Per-service entries are keyed by the service **directory name** (e.g. `"access"`) or its **path relative to the config file** (e.g. `"microservices/access"`); the relative-path key wins. Resolution: per-service `packageCommand`/`packageTimeoutMs` replace the global, `packageArgs` are appended after global args, `packageEnv` is merged over global env (per-service wins). `LSS_PACKAGE_COMMAND`/`LSS_PACKAGE_TIMEOUT_MS` still apply as the global baseline. This solves the case where one service (e.g. `access`) needs `--param=custom-stage=offline` to package offline while the others use the plain command. Centralized in `ConfigManager.getPackageConfigForService()`.

### Fixed
- **`packageCommand` quote parsing**: the tokenizer in `serverless-packager.ts` stripped only a single leading + trailing quote from each token, mangling `--param="custom-stage=offline"` into a malformed arg. It now strips quotes per quoted segment, so `--flag="a=b"` / `--flag='a b c'` tokenize correctly. New `packageArgs` are passed as discrete argv elements (no parsing at all), so values with `=`/spaces are always delivered intact.

### Changed
- **Minimum supported Node.js version is now `>=20`** (`engines.node` on both the root package and the `serverless-lss` plugin; the publish workflow uses Node 20).

## [0.3.0] - 2026-06-06

Programmatic client (`LssClient`) so downstream Jest e2e suites can drive everything the `lss` CLI does at runtime via `import`, instead of shelling out to `npx lss` per step.

### Added
- **Programmatic client `LssClient`** (`import { LssClient } from 'local-serverless-stack'`): everything the `lss` CLI/orchestrator exposes, callable from Jest at runtime instead of spawning `npx lss` per step. The data-plane is a thin typed HTTP wrapper over the orchestrator's `/api/*` endpoints, grouped into namespaces — `seeds` (`run`/`clear`/`list`), `queues` (incl. `awaitIdle`, `hold`/`captured`/`release`, `send`/`receive`/`purge`), `dynamo` (tables/scan/query/item CRUD/TTL), `buckets` (S3 list/objects/`getObject` as a `Buffer`/put/delete), `resources`, `services`, `config`, `health` — plus a `request()` escape hatch. `lifecycle` (`start`/`stop`/`status`/`logs`) shells out to the battle-tested `bin/cli.js` (so PID/`stateDir` logic is reused, not duplicated), and `lifecycle.waitUntilReady()` polls `GET /api/health` until LocalStack is actually up (the CLI returns before that). The constructor resolves its target from options → env (`LSS_CONFIG`, `LSS_BASE_URL`, `LSS_SERVER_PORT`, `AWS_REGION`) → `lss.config.json`/`.lssrc`, so `new LssClient()` works purely from the environment or `new LssClient({ configPath })` from an explicit file. Quirks handled for callers: `queues.awaitIdle` resolves on both `200` (drained) and `408` (timeout) rather than throwing, and `buckets.getObject` returns the raw binary body. Errors throw an `LssHttpError` carrying `{ status, statusText, body, path }` and the orchestrator's own `{error|message}`.
- **Package now ships a library entry point**: added `main`/`types`/`exports` to `package.json` pointing at a self-contained CommonJS build at `dist/client` (mirrors the `serverless-lss` plugin's CJS build so consumers on CJS or ESM can `import`/`require` it). New `client:build` (`tsc --project src/client/tsconfig.json`) wired into `npm run build`. Importable as `local-serverless-stack` or `local-serverless-stack/client`.

### Tests
- **100% coverage extended to `src/client/**`**: stub-HTTP-server unit tests assert every namespace method maps to the right route/query/body and cover the full error-mapping matrix (`{error}`/`{message}`/snippet/empty/over-long/non-JSON, timeout, connection refused); lifecycle is driven against a fake CLI fixture (`tests/fixtures/fake-cli.js`) via the `LSS_CLI_PATH` seam plus `waitUntilReady` polling. The integration suite (`features.test.ts`) gained a "programmatic client" block that drives the same isolated instance through `LssClient` end-to-end.

## [0.2.0] - 2026-06-04

Testability features for downstream e2e suites: an isolated test instance and a deterministic queue-drain wait. Plugin `serverless-lss` bumped to `0.1.0` (it gained `LSS_DASHBOARD_PORT` support — install both).

### Added
- **`--config <path>` flag for `start|stop|status|logs`**: loads config from the given file, taking precedence over the cwd/home search (`lss.config.json` / `.lssrc`). A missing or unparseable explicit file warns and falls back to the search rather than hard-exiting, so `stop`/`status`/`logs` never orphan a running instance. `bin/cli.js` resolves the path to absolute once per invocation (also accepted via the `LSS_CONFIG` env var) and hands it to the spawned server as `LSS_CONFIG_PATH`, so the orchestrator's `ConfigManager` reads the identical file — keeping the two config loaders in agreement on port/seedsDir/region/mode.
- **`stateDir` config field**: directory where an instance keeps its PID/log (the PID file doubles as the lock). When set (e.g. `".lss-e2e"`), `runtimePaths()` places state there so an isolated instance — typically an e2e test stack started with `--config` — can be started and stopped without ever touching the dev instance. When omitted, behavior is unchanged: PID/log live in the OS temp dir scoped by `serverPort`. `ConfigManager` gained the field plus a `getStateDir()` getter (resolved relative to the working directory).
- **`POST /api/queues/:name/await-idle`**: blocking endpoint that polls a queue's counters (forcing a fresh read every ~250 ms rather than waiting on the 5 s background poller) and resolves `200 { queue, available, inFlight, processed, drained: true }` once the queue is idle (`available === 0 && inFlight === 0`, and `processed >= sinceProcessed` when that body field is supplied), or `408 { …, drained: false }` on timeout. Body: `{ timeoutMs?: number = 15000 (clamped 100–120000), sinceProcessed?: number }`. Lets a test deterministically wait for an SQS consumer to drain before asserting persistence. Accepts the logical queue name (e.g. `activity-save.fifo`).
- **Queue hold/intercept primitives** (`POST /api/queues/:name/hold`, `GET /api/queues/:name/captured`, `POST /api/queues/:name/release`): `hold` disables the queue's consumer event source mapping(s) (`UpdateEventSourceMapping Enabled: false`) and starts capturing; `captured` drains the queue into an in-memory buffer and returns `[{ messageId, body, attributes, messageAttributes, receivedAt }]`; `release` re-enables the mapping(s) and re-dispatches the captured messages. Lets a test assert a producer's enqueued payload without running the consumer. Best-effort: hold state is in-memory (lost on restart), messages already consumed before hold can't be recalled, and LocalStack applies the `Enabled` toggle asynchronously.

### Changed
- **`serverless-lss` plugin honors `LSS_DASHBOARD_PORT`**: when set (and `ORCHESTRATOR_URL` is not), the plugin registers the service at `http://localhost:${LSS_DASHBOARD_PORT}`. Precedence is `ORCHESTRATOR_URL` (full URL) > `LSS_DASHBOARD_PORT` (port) > `custom.orchestrator.orchestratorUrl` > default `http://localhost:3100`. This lets the same `serverless.yml` register against an isolated test orchestrator at runtime without editing the file.

### Tests
- **Two separated test types**: `npm run test:unit` (default `npm test`) is hermetic, runs in CI, and enforces a **100% coverage gate** (statements/branches/functions/lines) over the unit-testable server code — `src/server/services/**` (except the Docker-driven `localstack-manager.ts`), `src/server/routes/**`, `src/server/dev/**`, `packages/serverless-plugin/src/**` and `bin/cli.js` (`index.ts` is excluded as it bootstraps the server at import). `npm run test:integration` boots a real isolated LSS + LocalStack and validates the promised features end-to-end. Added `aws-sdk-client-mock` + `supertest` as dev deps; split `tests/setup.ts` into shared matchers + per-type setup; `bin/cli.js` now guards its dispatch behind `require.main === module` and exports its helpers for in-process testing. ~750 unit tests.
- **`docs/FEATURES.md`**: a single inventory of the project's promised features (CLI, HTTP API, resource provisioning, plugin, seeds, queue primitives, config/isolation), doubling as the integration suite's checklist. The integration suite provisions `examples/sample-microservice` and asserts each capability; it runs locally and in a CI job gated on a `LOCALSTACK_AUTH_TOKEN` secret.

## [0.1.2] - 2026-05-26

### Added
- **`npx lss seed:clear` now requires interactive confirmation**: before issuing any `DeleteRequest`, the CLI lists the exact LocalStack tables it would wipe, prints the LocalStack URL, makes the "this never touches AWS" guarantee explicit, and waits for the user to type `confirmar` (case-sensitive, exact match after trim). Anything else cancels with `🚫 Cancelado — nenhuma alteração feita.` and no clear call is made. `--yes` / `-y` skips the prompt for CI use.
- **Defensive endpoint guard in `SeedManager`**: `clearTable` and `clearAllSeeded` now refuse to run unless the resolved DynamoDB endpoint hostname is on a hardcoded local allowlist (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `host.docker.internal`, `localstack`, `lss-localstack`, `lss-localstack-<port>`, `*.localhost`). If a future refactor ever pointed `LocalStackManager.getConfig()` at a real AWS endpoint, the guard would throw `Refusing destructive operation: endpoint "..." is not a recognized local LocalStack host. seed:clear may ONLY run against LocalStack — never against AWS.` before any AWS SDK call. Architecture already pinned writes to LocalStack via fake credentials; this is belt-and-braces.
- **Seed/clear mismatch diagnostic**: `GET /api/seeds` now also returns `liveTables: string[]` (every DynamoDB table currently in LocalStack). When `npx lss seed` skips tables or `npx lss seed:clear` finds no live targets, the CLI prints a two-column diagnostic — seed files inspected on one side, live LocalStack tables on the other — with the hint "Os nomes dos arquivos de seed precisam bater EXATAMENTE com o `TableName` no CloudFormation." This makes seed-name/table-name typos obvious instead of "nothing happened, why?". When the live-tables list is empty, the CLI falls back to the older "run `npx lss start` + `npx serverless deploy` first" hint.
- **Test infrastructure**: new `tests/unit/seed-manager-guard.test.ts` (27 tests covering the endpoint allowlist matrix, IPv6 bracket handling, malformed URLs, and that `clearTable`/`clearAllSeeded` invoke the guard) and `tests/unit/cli-seed.test.ts` (21 tests spawning `bin/cli.js` against an in-process HTTP stub of the orchestrator — covers confirmation flow, `--yes`/`-y` bypass, "no live tables" diagnostic, name-mismatch diagnostic, and `formatError` robustness against 500-with-empty-body / 500-with-non-JSON / `{error: ""}` responses).

### Changed
- **`bin/cli.js` error handling never leaves the user with an empty message**: new `formatError(e)` and `buildHttpError(res, data)` helpers walk a fallback chain (`e.message` → `e.code` → `e.name` → body snippet → HTTP status text → "erro desconhecido (sem detalhes)") so a response 500 with no body, a socket reset during orchestrator startup, or an `Error` with empty `.message` all produce a useful CLI line instead of `❌ Não consegui listar as tabelas antes de limpar:` with a blank suffix. Applied to every `console.error` path in `seed`, `seed:clear`, and the underlying `getJson`/`postJson` helpers.
- **`npx lss seed` hint when tables are missing in LocalStack**: previously printed a generic "tabelas foram puladas" footer. Now it fetches `liveTables` and shows the same mismatch diagnostic as `seed:clear`, so the user sees whether the cause is "I haven't deployed yet" (no live tables) or "my seed file name is wrong" (live tables exist but don't match).
- **`firstPositional()` arg parser in the CLI**: commands that accept an optional table name (`seed`, `seed:clear`) now skip args starting with `-`. Without this, `npx lss seed:clear --yes` was interpreting `--yes` as the table name.
- **`SeedManager.assertLocalEndpoint` normalizes IPv6 brackets** so URLs like `http://[::1]:4566` (which `new URL().hostname` reports as `[::1]`) match the `::1` entry in the allowlist instead of being rejected as non-local.
- **`jest.config.js` `moduleNameMapper`**: strips `.js` from relative imports during tests so the server's NodeNext-style ESM imports (`import { Foo } from './foo.js'`) resolve to TypeScript sources under ts-jest. Without this, no unit test could import from `src/server/`.

### Fixed
- **`examples/pro-sample-microservice/seeds/`**: renamed `sample-microservice-Users.json` → `pro-sample-microservice-Users.json` and `sample-microservice-Orders.json` → `pro-sample-microservice-Orders.json` (via `git mv` to preserve history). The files had been copied from `sample-microservice` but never renamed, so the seed prefix didn't match the example's actual `${self:service}-*` `TableName`s in `serverless.yml` — `npx lss seed` and `npx lss seed:clear` always found `tableExists: false` and silently did nothing.

## [0.1.1] - 2026-05-21

### Added
- **DynamoDB tables: search filter**: the DynamoDB tab now has a text input in the table-list header that filters rows by table name or owning service as you type, so finding a table no longer requires `Ctrl+F`. When a query matches nothing, an empty state shows the active query.

## [0.1.0] - 2026-05-21

### Added
- **S3 bucket support, end-to-end**: LSS now parses `AWS::S3::Bucket` from CloudFormation, provisions buckets in LocalStack, and (when present) wires `NotificationConfiguration.LambdaConfigurations` to a Lambda proxy that forwards into `serverless-offline`. Versioning, `Filter.S3Key.Rules` (prefix/suffix), and multiple lambda configurations per bucket are honored.
  - **New service** `src/server/services/s3-explorer.ts` exposing `listBuckets`, `getBucket`, `listObjects`, `getObject`, `headObject`, `putObject`, `deleteObject`. Per-region client cache mirrors `QueueInspector`/`DynamoExplorer`. Client uses `forcePathStyle: true` so LocalStack receives the bucket name in the URL path rather than as a virtual-host subdomain.
  - **New REST routes** under `/api/buckets`:
    - `GET /api/buckets` — list buckets with enriched metadata (`objectCount`, `totalSize`, `region`, `createdAt`).
    - `GET /api/buckets/:name` — describe a bucket (versioning, notifications count, object/size totals, region).
    - `GET /api/buckets/:name/objects` — list objects with `prefix`, `delimiter`, `maxKeys`, `continuationToken` query params.
    - `GET /api/buckets/:name/objects/content?key=...&download=0|1` — stream an object back. Sets `Content-Type` from the object's stored mime; `?download=1` flips to an attachment disposition. Used by the UI for preview and download.
    - `POST /api/buckets/:name/objects` — upload `{ key, body, contentType?, encoding? }` (encoding `base64` flips the body decoder for binary uploads).
    - `DELETE /api/buckets/:name/objects?key=...` — delete a single object.
  - **New dashboard tab "S3"** in `App.vue` between Queues and DynamoDB.
  - **`/buckets`** — lazy-loaded `BucketsPage.vue` wraps `BucketsView.vue`. Shows three stats (buckets, objects, total size), a service-owner column (links back to `/services/:name`), versioning + notifications counters, and refreshes every 10s.
  - **`/buckets/:name`** — lazy-loaded `BucketDetailPage.vue` wraps `BucketDetail.vue`. Shows the four bucket stats, an **Upload object** card (key, optional content-type, free-form body) that POSTs through `/api/buckets/:name/objects`, and an **Objects** table with prefix filter, per-row open-in-tab preview, download, and delete (behind a confirm).
  - **`@aws-sdk/client-s3`** added to the main package.
  - **`/api/resources`** now returns `{ tables, queues, topics, buckets }` and **`/api/resources/owners`** returns a `buckets` array of `{ name, service }` pairs.
  - **`GET /api/services`** `resourceBreakdown` now includes `buckets` count (rendered as `🪣` chip in `ServicesList.vue`).
  - **Overview page** got a fifth stat column for S3 buckets and the **S3 Buckets** entry in "What's covered" is now `Supported` and links to `/buckets`.
  - **Service detail page** got a Buckets stat and a clickable bucket list that navigates to `/buckets/:name`.
  - `S3Resource` interface in `cloudformation-parser.ts` carries `versioningEnabled` and an array of `S3NotificationConfig { functionRef, events, filterPrefix?, filterSuffix? }`.

- **`pro-sample-microservice` example**: same surface as `sample-microservice` (Users/Sessions/Orders tables, OrderProcessing queue, OrderEvents topic, uploads bucket with S3 → Lambda notification, full handler set) but pointed at `localstack/localstack-pro:latest`. Lives on its own ports (LSS `3111`, LocalStack `4571`, offline `3010 / 3011`) so it can run side by side with the community example and an external LocalStack on `4566`. Ships with `.env.example` documenting the required `LOCALSTACK_AUTH_TOKEN` and npm scripts wrapped in `dotenv-cli` so secrets reach both LSS and `serverless-offline` without polluting the shell.

- **`.env` support in `sample-microservice`**: matching `.env.example` (with a note that recent community images ≥ 2026.5 also require a token), `.env` / `.env.local` added to `.gitignore`, and every npm script (`lss:start|stop|status|logs|seed*`, `package`, `offline`, `deploy`) wrapped in `dotenv -- ...` via the new `dotenv-cli` devDep.

- **`sample-microservice` S3 handlers**: `aws.js` now exports an `S3Client` (with `forcePathStyle: true`), and three new handlers exercise the round-trip:
  - `uploadFile.js` — `POST /uploads` → puts an object under `incoming/{filename}` (supports `encoding: "base64"`).
  - `listUploads.js` — `GET /uploads?prefix=` → lists objects with metadata.
  - `onUpload.js` — bound to the bucket's `s3:ObjectCreated:*` notification under the `incoming/` prefix; reads the object back and writes a synthetic row into the `Orders` table (`userId=s3-upload`) so the trigger is visible from the DynamoDB explorer.
  - `serverless.yml` declares the bucket, the notification (with `Filter.S3Key.Rules` prefix), and adds the three corresponding `functions:`. Env var `UPLOADS_BUCKET` injected for the handlers.

### Changed
- **`bin/cli.js` PID and log files are now scoped to `serverPort`**: `/tmp/lss-orchestrator-{serverPort}.{pid,log}` instead of the previous global `/tmp/lss-orchestrator.{pid,log}`. The legacy global path is still used when `serverPort` is the default `3100`, so existing single-project setups keep working. This removes the old "PID file is global across all working directories" gotcha — multiple LSS instances (one per example/project) can now coexist on the same machine.
- **`LocalStackManager` container and volume are scoped to the LocalStack port**: container name is `lss-localstack` for the default `4566` and `lss-localstack-{port}` otherwise; the persistence volume follows the same scheme (`{containerName}-data`). Two examples no longer collide on either the Docker container name or the persistence volume.
- **Removed the hardcoded `-p 4571:4571` extra port binding** from the LocalStack Docker invocation. It clashed with examples whose LocalStack port is `4571`, and the legacy "edge" port it exposed is obsolete in modern LocalStack (everything flows through the primary port).
- **`sample-microservice` ports moved off the defaults**: LSS dashboard now on `3110` (was `3101`), LocalStack now on `4570` (was `4566`). Avoids colliding with an external LocalStack on `4566`. The `serverless-offline` ports (`3000`/`3001`) are unchanged.
- **`sample-microservice` package.json**: added `dotenv-cli` to `devDependencies`; every script wrapped in `dotenv -- ...`. Updated description to mention S3.
- **Resource breakdown / owner types** in `src/ui/src/services/api.ts` gained the `buckets` fields. The `ServiceResource.type` union now includes `'s3'`, `ResourceBreakdown` includes `buckets: number`, and `ResourceOwnersResponse` includes `buckets: ResourceOwner[]`. Existing `.catch(() => ({...}))` fallbacks in `QueuesView.vue` and `DynamoTablesList.vue` were widened to include the new field.

### Fixed
- **`resolveLambdaName` now reads `FunctionName` straight from the parsed CFN** instead of hand-crafting `${service}-api-${shortName}`. The old heuristic only worked when the user's stage happened to be `api`; for any other stage (e.g. the default `dev`) the LocalStack proxy would forward to a name `serverless-offline` doesn't recognize and the invocation 404'd with `Function does not exist`. Both the LocalStack proxy and its invoke URL now use the same fully-qualified name (`pro-sample-microservice-dev-onUpload`) that `serverless-offline` exposes on its `lambdaPort`. The old `resolveLambdaFunctionName` helper was removed; `shortFunctionName` is kept only as a last-resort fallback when a logical id isn't present in the parsed CFN.
- **Event source ARN resolution uses CFN `logicalId` instead of kebab-casing**: `Fn::GetAtt: [OrderProcessingQueue, Arn]` now looks up `OrderProcessingQueue` directly in a logical-id → resource map populated from the parsed template, then derives the real ARN from the resource's actual `QueueName` / `TableName` / `TopicName`. The previous kebab-case match (`order-processing-queue` vs `service-OrderProcessing`) silently failed whenever the user set an explicit `QueueName`/`TableName`, leaving SQS and DynamoDB stream consumers completely unwired.
- **DynamoDB stream ARN is now fetched via `DescribeTable.LatestStreamArn`** (with up to 5 × 300ms retries while the stream provisions), rather than hand-crafting `arn:aws:dynamodb:...:table/X/stream/NEW_AND_OLD_IMAGES` — the real ARN has a timestamp suffix and the hand-crafted one was always rejected with `Stream not found`.
- **`CreateEventSourceMappingCommand` now sets `StartingPosition: 'TRIM_HORIZON'` for stream sources** (any resolved ARN starting with `arn:aws:dynamodb:` or `arn:aws:kinesis:`). DynamoDB Streams and Kinesis require this field; SQS forbids it, so the flag is `undefined` for SQS mappings.
- **CloudFormation parser detects DynamoDB streams via `StreamViewType`** (the field that actually lives in `AWS::DynamoDB::Table.StreamSpecification`) instead of the non-existent `StreamEnabled` boolean. Before, every parsed table came back with `streamEnabled: false`, which meant LSS created the table without streams even when CFN asked for them.
- **S3 `PutBucketNotificationConfiguration` now passes `SkipDestinationValidation: true`**. LocalStack Pro implements the same synchronous test-invoke validation real S3 does, and was rejecting our config with `Unable to validate the following destination configurations` because the `lambda:InvokeFunction` permission for `s3.amazonaws.com` hadn't fully propagated by the time we wrote the notification. The flag tells S3 to trust the permission we just added rather than probing the destination. (Community LocalStack was lax about this; Pro isn't.)
- **`ServerlessDeploymentBucket` is now skipped at parse time**. Serverless Framework injects this `AWS::S3::Bucket` for its own deployment artifacts; its name lives behind CloudFormation pseudo-parameters LSS doesn't resolve, so every registration was logging `Failed to provision s3:ServerlessDeploymentBucket: The specified bucket is not valid`. It isn't useful for local dev and is now filtered before provisioning ever runs.
- **`provisionResources` rebuilds the logical-id map on each call**, so the fixes above don't leak resource lookups across services when the same `ResourceProvisioner` singleton is reused for multiple registrations.

### Documentation
- **`README.md`**: feature list now mentions S3, LocalStack `SERVICES` example updated to `dynamodb,sqs,sns,s3,lambda`, and the "CLI Implementation Details" section reflects the per-port PID/log paths.
- **`docs/CONFIGURATION.md`**: default `services` array now includes `s3`, examples updated.
- **`examples/sample-microservice/README.md`**: replaced the "PID file is global" warning with the new ports table; added an S3 section to the HTTP examples and the "Things to play with in the UI" tour.
- **`examples/pro-sample-microservice/README.md`**: brand-new walkthrough — prerequisites, token setup, port table, run/reset commands, diff summary against the community example.
- **Example configs** (`lss.config.json`, `lss.config.json.example`) now list `s3` in the default services array.

## [0.0.15] - 2026-05-21

### Added
- **Queue detail page with AWS-style send/receive workflow**: clicking a queue in `/queues` now opens `/queues/:name` (lazy-loaded, follows the same routed-page + tabs pattern as the DynamoDB explorer) instead of the old read-only modal. The new page exposes three tabs:
  - **Send & receive** — the headline upgrade. Send arbitrary messages (body, optional `DelaySeconds`, message attributes with `String`/`Number`/`Binary` types). For FIFO queues the form auto-switches to `MessageGroupId` + optional `MessageDeduplicationId` and hides the `DelaySeconds` field (FIFO rejects it). Poll the queue with configurable `MaxNumberOfMessages` (1–10), `VisibilityTimeout`, and `WaitTimeSeconds` (long polling, 0–20). Received messages appear in a table with body preview, message ID, `SentTimestamp`, attribute count, and expandable JSON pretty-print of the full body plus AWS-side attributes (sender, receive count, etc.) and message attributes. Each row supports **Copy body** to clipboard and **Delete** by `ReceiptHandle`. A **Purge queue** action lives under the poll panel, behind a `TConfirmDialog` (warns about the AWS 60s rate limit).
  - **Consumers** — the existing Lambda event-source mapping list, promoted to a dedicated tab.
  - **Attributes** — Identity (queue URL + ARN), Configuration (FIFO, visibility timeout, retention, delayed counter, created/last-polled timestamps), and a Throughput card with the processed-share progress bar and the **Reset processed counter** action that used to live in the modal footer.
- **`POST /api/queues/:name/messages`**: send a message. Body is `{ body, delaySeconds?, messageAttributes?: [{ name, type, value }], messageGroupId?, messageDeduplicationId? }`. Validates `delaySeconds` is 0–900, ignores it for FIFO queues, and auto-injects `messageGroupId: 'default'` when the queue is FIFO and the field is omitted.
- **`POST /api/queues/:name/messages/receive`**: poll. Body is `{ maxNumberOfMessages?, visibilityTimeout?, waitTimeSeconds? }` (clamped server-side to 1–10 and 0–20). Returns `{ messages: SqsMessage[] }` with `messageId`, `receiptHandle`, `body`, `md5OfBody`, AWS `attributes` (`SentTimestamp`, `ApproximateReceiveCount`, etc.) and `messageAttributes`.
- **`POST /api/queues/:name/messages/delete`**: delete a single message by `receiptHandle`.
- **`POST /api/queues/:name/purge`**: PurgeQueue passthrough.
- API client helpers `sendQueueMessage`, `receiveQueueMessages`, `deleteQueueMessage`, `purgeQueue` in `src/ui/src/services/api.ts`, plus the supporting `SendQueueMessageInput` / `ReceiveQueueMessagesInput` / `SqsMessage` / `SqsMessageAttributeInput` types.

### Changed
- `QueueInspector` now keeps a per-region cache of `SQSClient` and `LambdaClient` instances (same pattern `DynamoExplorer` already uses). `listQueues`, `getQueue`, and the new send/receive/delete/purge methods all accept an optional `region` argument, and every `/api/queues/*` route forwards `?region=` through. Background metric polling still uses the default region.
- `QueuesView.vue` row click and the trailing **Details** button now navigate to `/queues/:name` instead of opening the in-page modal. The modal, the local `selectedQueueName` state, and the modal-only "Reset processed counter" button were removed from the list view; the reset action lives on the new Attributes tab.

## [0.0.14] - 2026-05-20

### Added
- **Full-screen dashboard with URL-based navigation**: the Vue dashboard now uses `vue-router` instead of a single in-memory tab state. Every section is a real URL — `/`, `/services`, `/services/:name`, `/queues`, `/dynamo`, `/dynamo/:name` — so views are bookmarkable, shareable, and the browser back/forward buttons work as expected. DynamoDB table sub-tabs (Items / Indexes / Settings / Seed) are persisted via `?tab=...` so deep links land on the exact sub-view. Pages are code-split (lazy-loaded) so the initial bundle stays small.
- **Landing-style Overview page**: replaces the old "Resources" tab. Shows a project pitch hero, a live "Server status" card (LocalStack running, Dynamo Proxy enabled/listening, Auto-package on/off, Persistence on/off), an "LESC configuration" card (default region, server port, enabled LocalStack services, seeds dir, active config file path), four totalizers (services running/total, tables, queues, topics) and a "What's covered" panel listing supported resource types — `✓ SNS Topics`, `✓ SQS Queues`, `✓ DynamoDB Tables`, `⏳ S3 Buckets` (planned).
- **`/services/:name` detail page**: lifecycle controls (Start / Stop / Logs / Delete / Refresh), metadata block (path, region, invoke port, PID, last updated), and resources grouped by type (Lambda functions, DynamoDB tables, SQS queues, SNS topics, event-source mappings). Each declared DynamoDB table or SQS queue is a clickable tag that navigates to its detail view.
- **"Service" column on the Queues and DynamoDB lists**: each row now shows which microservice declared that queue/table, with a tag that links back to the service detail page. Resources not declared by any registered service render as `unmanaged` / `—`. Powered by a new `GET /api/resources/owners` endpoint that joins the cached CloudFormation templates and filters by region.
- **Seeds embedded in the DynamoDB explorer**: the standalone "Seeds" tab is gone. Tables that exist only as a seed file (no live table yet) now appear as **ghost rows** in the DynamoDB tables list (reduced opacity, `Not created` badge, "Register service to provision" hint). When a table has a matching seed file, its detail view gets a new **"Seed" sub-tab** with three actions: **Apply** (insert seed items), **Redo** (purge + re-apply, behind a confirmation), and **Purge** (delete every item in the table). Each destructive action goes through a `TConfirmDialog`.
- **`GET /api/config`**: exposes the runtime LSS configuration snapshot to the UI — `serverPort`, `localstack` (mode/endpoint/port/edition/version/image and `hasAuthToken: boolean`), `dynamoProxy.enabled/port`, `region`, `services`, `persistence`, `debug`, `seedsDir`, `autoPackage`, `packageCommand`, `packageTimeoutMs`, and `configPath`. The actual LocalStack auth token is never returned, only whether one is set.
- **`GET /api/resources/owners`**: returns `{ tables, queues, topics }` where each entry is `{ name, service }`, computed by parsing each cached CloudFormation template. Respects `?region=` and filters owner mappings to services registered in the requested region.
- `GET /api/services` now includes `resourceBreakdown: { lambdas, tables, queues, topics }` so the Services table can render per-type chips (`λ`/`🗄`/`📨`/`📣`) instead of a single opaque resource count.
- `GET /api/health` response now includes a `dynamoProxy: { enabled, running, port }` block so the navbar and Overview can show whether the proxy is actually listening, not just whether it was configured.

### Changed
- **Dashboard uses the full viewport width**. The old `<TContainer size="xl">` cap (~1200px) is gone — wide monitors no longer waste half the screen on margins. A sticky secondary nav bar sits under the navbar with `RouterLink`s for the top-level sections.
- The DynamoDB tables view was refactored from a 2-column card grid to a denser **table layout** to accommodate the new Service and Seed columns and the ghost-row affordance.
- The DynamoDB Proxy status is now surfaced as a soft badge in the navbar (when enabled) alongside the existing LocalStack status badge.
- `Service` typing in the UI moved from inline `interface Service` to the shared `ServiceSummary` / `ServiceDetail` / `ResourceBreakdown` / `ResourceOwner` types in `src/ui/src/services/api.ts`, and the API client gained `getConfig()`, `listResourceOwners()` helpers.

### Removed
- The standalone **"Seeds" tab** and its top-level dashboard entry. All seed actions are now reached from inside the relevant DynamoDB table's detail view, and unprovisioned seeds are visible as ghost rows in the DynamoDB tables list.
- `src/ui/src/components/ResourcesOverview.vue`, `src/ui/src/components/SeedsPanel.vue`, and `src/ui/src/components/dynamo/DynamoTab.vue` — replaced by the new routed pages (`pages/OverviewPage.vue`, `pages/DynamoPage.vue` + `pages/DynamoTablePage.vue`) and the new `components/dynamo/DynamoSeedPanel.vue`.

## [0.0.13] - 2026-05-19

### Added
- **Auto-package on register**: when registering a service, if `.serverless/cloudformation-template-update-stack.json` is missing, the orchestrator can now run a configurable package command in the service directory and retry the read. Controlled by three new `lss.config.json` options: `autoPackage` (boolean, default `false`), `packageCommand` (string, default `"npx serverless package"`), and `packageTimeoutMs` (number, default `300000`). Also exposed as the env vars `LSS_AUTO_PACKAGE`, `LSS_PACKAGE_COMMAND`, `LSS_PACKAGE_TIMEOUT_MS`. Useful when integrating new microservices without manually running `serverless package` first. The runnable `examples/sample-microservice/lss.config.json` ships with `autoPackage: true` enabled by default.

### Changed
- `POST /api/services/register` now returns a clear `400` with an actionable message (`"CloudFormation template not found at ... Run 'serverless package' in the service directory, or enable autoPackage in lss.config.json."`) when the template is missing and `autoPackage` is disabled, instead of leaking the underlying `ENOENT` stack trace as a `500`.
- Auto-package failures now log the full stdout/stderr of the package command to the orchestrator log (`/tmp/lss-orchestrator.log`) with delimiter lines, so failures from `serverless-webpack`, stage validators, missing params, etc. are diagnosable. The HTTP response now points users to the orchestrator log for the full transcript.
- The configuration summary printed at startup now includes the active `autoPackage` and (when enabled) `packageCommand` values.

## [0.0.12] - 2026-05-19

### Added
- **Region selector in the dashboard navbar** (AWS Console–style). The selected region is persisted in `localStorage` and is automatically appended as `?region=<value>` to every API request. The Overview, DynamoDB, and Seeds tabs now reload from scratch when the region changes (keyed remount).
- **`examples/sample-microservice`**: end-to-end test microservice (`serverless.yml` + JS handlers) that exercises DynamoDB (PK-only / composite key + GSI / stream), SQS, SNS and Lambda event sources — meant for poking at the dashboard with real data. Includes its own `lss.config.json` (default ports), seed fixtures for Users/Orders, and `npm run lss:*` scripts that delegate to the local LSS CLI via relative paths.

### Changed
- `DynamoExplorer`, `SeedManager`, and `ResourceProvisioner.listAllResources` now keep a per-region client cache and accept an optional `region` argument on every public method. Each `/api/dynamo/*`, `/api/seeds/*`, and `/api/resources` route reads `?region=` from the query string and forwards it through.
- Auto-seed on table creation now passes the provisioning region down so seeds land in the correct namespace when a service is registered in a non-default region.

### Known limitations
- The **Queues** tab is not yet region-aware — `QueueInspector` still polls the singleton's region (the one set by the most recently registered service). A region-aware refactor of the inspector is planned for a follow-up.

## [0.0.11] - 2026-05-18

### Added
- **DynamoDB explorer**: new "DynamoDB" tab inspired by the AWS Console. Lists every table with key schema, item count, billing mode, TTL/Streams status and per-table warnings (e.g. "TTL not configured"). Clicking a table opens a detail view with three sub-tabs.
- **Explore items (Scan / Query)**: visual filter builder with attribute / operator / value rows (operators: `=`, `<>`, `<`, `<=`, `>`, `>=`, `begins_with`, `contains`, `attribute_exists`, `attribute_not_exists`). Values are auto-typed (number/boolean/null/JSON). Supports running on the table or any GSI/LSI, configurable limit, and "Load more" pagination via `LastEvaluatedKey`. Query mode requires key conditions (up to PK + SK) and reuses the same builder.
- **Item CRUD**: per-row "View", "Edit" and "Delete" actions, plus a "Create item" button. Items are edited as plain JSON in a modal with format/validate. Edit performs a `PutItem` (full-replace); if any key attribute changed during edit, the original row is deleted first so it behaves like an update instead of producing a duplicate.
- **Indexes sub-tab**: lists GSIs and LSIs with their key schema, projection type, item count and status.
- **Settings sub-tab**: TTL toggle (`UpdateTimeToLive`), Streams view, table identifier (ARN + creation date), item count and size.
- **`/api/dynamo` endpoints**: `GET /tables`, `GET /tables/:name`, `GET/PUT /tables/:name/ttl`, `POST /tables/:name/scan`, `POST /tables/:name/query`, `POST /tables/:name/items` (PutItem), `POST /tables/:name/items/get` (GetItem), `POST /tables/:name/items/delete`. Items and keys cross the wire as plain JSON — the server `marshall`s/`unmarshall`s.

## [0.0.10] - 2026-05-18

### Added
- **DynamoDB seeding**: drop `{tableName}.json` files into the directory configured by the new `seedsDir` option (default `./seeds`) and items get marshalled and inserted into the matching DynamoDB table. Items are written as plain JSON (no AWS attribute-typed envelope) — `@aws-sdk/util-dynamodb`'s `marshall` infers types automatically.
- **Auto-seed on table creation**: when `ResourceProvisioner` creates a DynamoDB table, the `SeedManager` checks for a matching seed file and applies it in the background. Idempotent — re-runs are a `PutItem` merge by primary key. Failures are logged and never break the provisioner.
- **`/api/seeds` endpoints**: `GET /api/seeds` (list seed files + whether each target table exists), `POST /api/seeds/run` (apply one or all), `POST /api/seeds/clear` (delete every item from one table or from all tables that have a seed file).
- **CLI commands**: `npx lss seed [tableName]` and `npx lss seed:clear [tableName]`. With no argument they operate on every table that has a corresponding seed file.
- **Seeds dashboard tab**: new "Seeds" tab listing each seed file with its item count and whether the target table exists in LocalStack, plus per-row "Apply"/"Clear" buttons and global "Re-apply all"/"Clear all" actions.

### Changed
- `ConfigManager` accepts the new `seedsDir` option (and `LSS_SEEDS_DIR` env var). Relative paths are resolved against the current working directory. Surfaced in the startup summary.

## [0.0.8] - 2026-05-18

### Added
- **Queue inspection UI**: new "Queues" tab in the dashboard. For each SQS queue it shows available messages, in-flight messages, processed-since-orchestrator-start, delayed messages, and the Lambda consumers (event source mappings) attached to it. Click "Details" for full attributes (visibility timeout, retention, FIFO, creation time) plus a per-consumer panel.
- **`/api/queues` endpoints**: `GET /api/queues` (list), `GET /api/queues/:name` (details), `POST /api/queues/:name/reset-processed` (reset processed counter).
- **Queue metrics tracker**: `QueueInspector` polls LocalStack every 5s and derives a per-queue "processed" count from drops in the in-flight bucket that are not re-queued as retries.
- **TreeUI design system**: dashboard now uses [`@treeui/vue`](https://www.npmjs.com/package/@treeui/vue) components throughout — `TNavbar`, `TContainer`, `TTabs`, `TCard`, `TStat`, `TTable`, `TBadge`, `TTag`, `TButton`, `TInput`, `TFormField`, `TModal`, `TConfirmDialog`, `TEmptyState`, `TSpinner`, `TProgress`, `TAlert`, `TStack`, `TGrid`, `TDivider`, `TToastProvider` / `useToast()`. Toasts replace native `alert()` calls. Dark theme is applied by default with a light/dark toggle in the navbar.

### Changed
- `ServicesList` and `ResourcesOverview` rewritten on top of TreeUI primitives.
- Delete service now goes through a `TConfirmDialog` instead of `window.confirm`.

## [0.0.6] - 2026-05-17

### Added
- **LocalStack operation modes**: new `mode` config (`managed` or `external`). In `external`, LSS only health-checks the configured endpoint and never touches Docker. CLI flag `--external`.
- **LocalStack edition selection**: new `localstackEdition` config (`community` or `pro`). CLI flag `--pro` selects the Pro image.
- **LocalStack image control**: new `localstackVersion` (image tag, default `latest`) and `localstackImage` (full override). Resolved image is shown in startup logs.
- **Auth token forwarding**: new `localstackAuthToken` config and `LOCALSTACK_AUTH_TOKEN` env var are forwarded into the container. Required for `pro` and for community images `>= 2026.5`. CLI flag `--localstack-token <value>`.

### Changed
- `ConfigManager` now layers environment variables on top of the config file (instead of only when no file is found), so secrets can be injected without committing them.
- Startup summary surfaces mode, edition, image, and whether an auth token is set.

## [0.0.5] - 2026-05-17

### Changed
- Upgraded `awpaki` to `^1.4.1`
- Upgraded `vite` (UI) to `^6.4.2`
- Bumped transitive dependencies via lockfile refresh: `axios` to 1.16.1, `path-to-regexp` to 0.1.13, `handlebars` to 4.7.9, `picomatch` to 2.3.2, `flatted` to 3.4.2, `qs` to 6.14.2, `follow-redirects` to 1.16.0, `brace-expansion` to 2.1.0, `minimatch` to 9.0.9

### Security
- Resolved Dependabot advisories #1, #4–#10, #12–#14 by updating affected transitive dependencies

## [0.0.4] - 2026-02-02

### Added
- **Region Priority System**: Plugin now respects region configuration from Serverless Framework with intelligent fallback
  - Priority 1: Region from `provider.region` in Serverless Framework configuration
  - Priority 2: Region from `lss.config.json` configuration
  - Priority 3: Default `us-east-1` if no region is specified
- Detailed logging showing which region source is being used during service registration
- `region` field to `ServiceMetadata` interface for tracking region per service

### Changed
- Serverless plugin now only sends region to orchestrator when explicitly defined in `serverless.yml`
- Orchestrator intelligently applies region priorities when provisioning resources
- Enhanced console output with region source indicators

### Fixed
- AWS SDK clients now properly recreate with correct region when provisioning services in different regions

## [0.0.3] - 2026-02-01

### Fixed
- Removed `postinstall` script that caused installation errors in consuming projects
- The script attempted to access `src/ui` directory which doesn't exist in published package

### Changed
- Simplified Lambda proxy code (removed verbose logging)
- Updated CI workflow to skip Docker-dependent tests in GitHub Actions
- CI now properly checks version changes for both root and plugin packages independently

### Added
- Development guide (DEVELOPMENT.md)
- awpaki dependency for future use in JSON parsing and parameter validation

## [0.0.2] - 2026-02-01

### Added
- TypeScript support with tsx for development mode
- Lint and build check in CI workflow
- NPM badges in README
- Plugin documentation reference in main README

### Fixed
- Top-level await issue in routes/services.ts (lazy cache initialization)
- ESLint warnings (unused variables, empty blocks)
- TypeScript compilation errors

## [0.0.1] - 2026-01-23

### Added

- 🎉 **Initial public release** of Local Serverless Stack (LSS)
- **CLI Tool**: Background process management with `lss start/stop/status/logs` commands
- **Orchestrator**: Express API server with embedded Vue 3 UI dashboard
- **LocalStack Integration**: Single centralized instance for all microservices
- **Auto-provisioning**: CloudFormation template parsing and resource creation
- **Lambda Proxies**: On-demand proxy generation for event source mappings
- **Event Source Mappings**: Automatic connection of DynamoDB/SQS/SNS to Lambda handlers
- **Serverless Plugin**: Auto-registration of services during `sls package`
- **Web UI**: Real-time dashboard for monitoring services and resources
- **Comprehensive Testing**: 34 integration tests with 100% pass rate
- **CI/CD Pipeline**: Automated testing and NPM publishing via GitHub Actions
- **Complete Documentation**: README, API docs, and examples

### Features

#### Core Capabilities
- Centralized LocalStack container management (port 4566)
- CloudFormation resource provisioning:
  - DynamoDB tables with streams
  - SQS queues with event mappings
  - SNS topics with subscriptions
  - Lambda proxies (on-demand creation)
- Event flow: AWS Service → Lambda Proxy → Serverless Offline
- Service registration via plugin or API
- Process management (PID files, background mode)

#### CLI Commands
- `lss start` - Start orchestrator in background
- `lss stop` - Stop orchestrator gracefully
- `lss status` - Check running status
- `lss logs` - View recent logs
- `lss help` - Display usage information

#### API Endpoints
- `POST /api/services/register` - Register new service
- `GET /api/services` - List all services
- `DELETE /api/services/:name` - Remove service
- `GET /api/resources` - List provisioned resources
- `GET /api/health` - Health check

#### Optimizations
- Lambda functions created only on-demand (not duplicated)
- Proxy functions forward to serverless-offline HTTP invoke
- Event transformation for DynamoDB streams, SQS messages, SNS notifications
- Efficient CloudFormation intrinsic function resolution

### Testing
- **CLI Tests**: 10/10 passing
- **Orchestrator Tests**: 12/12 passing
- **Plugin Tests**: 6/6 passing
- **Smoke Tests**: 6/6 passing
- **Total Coverage**: 34/34 tests (100%)

### Development
- TypeScript throughout
- ESM modules
- Vue 3 with Composition API
- Express.js server
- AWS SDK v3
- Jest for testing
- GitHub Actions for CI/CD

### Documentation
- Complete README with quick start guide
- Architecture diagrams (Mermaid)
- API documentation
- Plugin integration examples
- Release process guide
- Contribution guidelines

### Known Limitations
- Requires Docker for LocalStack
- Tested on Linux (Ubuntu/Debian)
- Node.js >= 18 required
- Serverless Framework 3.40.0 required

### Breaking Changes
None (initial release)

### Migration Guide
Not applicable (initial release)

---

## [0.0.3] - 2026-02-01

### Changed

- **Dependency Update**: Upgraded `awpaki` to version 1.3.2 for improved performance and compatibility
- **Enhanced CI/CD**: Improved version change logging in publish workflow for better release visibility
- **Workflow Optimization**: Simplified job dependencies in publish workflow for faster pipeline execution

### Fixed

- Bug fixes and stability improvements

---

## [0.0.2] - 2026-02-01

### Added

- **Lazy Cache Initialization**: Services router now implements lazy cache initialization for better resource management
- **ESLint Integration**: Added ESLint checks to CI pipeline for code quality assurance
- **TypeScript Validation**: Enhanced TypeScript type checking in CI/CD workflow
- **DevContainer Support**: Added .devcontainer configuration for consistent development environment
- **Dependabot Configuration**: Automated dependency updates and security patch management

### Changed

- **Build Pipeline**: Updated build script for improved compilation process
- **TypeScript Configuration**: Adjusted TypeScript settings for stricter type checking
- **Error Handling**: Simplified error handling in resource provisioner for better debugging
- **Documentation**: Enhanced README and plugin documentation for clarity

### Improved

- Project references and documentation clarity
- Integration test prerequisites documentation
- Overall code organization and maintainability

### Refactored

- Removed unused imports throughout the codebase
- Simplified test setup for better maintainability
- Updated CI workflow configuration and naming

---

## [Unreleased]

### Planned Features
- S3 bucket provisioning
- EventBridge integration
- Enhanced UI with real-time updates
- Multi-region support
- CloudWatch logs integration
- Improved error handling and validation
