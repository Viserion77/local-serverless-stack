# LSS — Promised Features

This is the canonical inventory of what `local-serverless-stack` (LSS) promises. It doubles as the
checklist for the integration suite (`tests/integration/features.test.ts`), which boots a real isolated
LSS + LocalStack and asserts each capability against the live HTTP API.

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
| Edition / version / image / services / persistence / region | All configurable; sensible defaults (community/latest, us-east-1, dynamodb+sqs+sns+s3+lambda). | unit (`config-manager`) |
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
| Lambda proxies | Generated proxy functions forward events to the `serverless-offline` invoke endpoint. | unit (`resource-provisioner`) |
| `GET /api/resources` / `…/owners` | List provisioned resources (tables/queues/topics/buckets) and map them to owning services. | unit (`routes/resources`) + integration |

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
| `POST /:name/messages` (+ `/receive`, `/delete`, `/purge`) | Send/receive/delete/purge messages (FIFO group/dedup supported). | unit + integration |
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

Optional reverse proxy (`enableDynamoProxy` / `dynamoProxyPort`, default 8000) forwarding to LocalStack, for
tools that expect DynamoDB on the standard port. Asserted by: unit (`dev/dynamo-proxy`).

## 10. Health & dashboard

`GET /api/health` reports orchestrator + LocalStack + dynamo-proxy status. The Vue dashboard (served as a SPA)
surfaces Overview / Services / Queues / DynamoDB / S3 with a region selector and theme toggle (UI is exercised
manually, not in the automated suites).

## 11. Programmatic client (`LssClient`)

Everything the CLI/orchestrator exposes, importable for Jest e2e at runtime instead of shelling out to `npx lss`:
`import { LssClient } from 'local-serverless-stack'`. The data-plane (`seeds`, `queues`, `dynamo`, `buckets`,
`resources`, `services`, `config`, `health`) is HTTP against the running orchestrator; `lifecycle`
(`start`/`stop`/`status`/`logs`) shells out to `bin/cli.js`, and `lifecycle.waitUntilReady()` polls `/api/health`
until LocalStack is up. The constructor resolves the target from options → env (`LSS_CONFIG`, `LSS_BASE_URL`,
`LSS_SERVER_PORT`, `AWS_REGION`) → config file, so `new LssClient()` works purely from the environment. Shipped as
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
| Execution modes | `artifact` (extracted `sls package` zip — TS/JS uniform), `source` (direct require; TS via `esbuild-register`/`tsx`/`ts-node`), `auto` picks artifact when present. | unit (`config-manager`) + integration |
| Invoke API (130xx) | `POST /2015-03-31/functions/{name}/invocations` with `X-Amz-Invocation-Type` (RequestResponse 200 / Event 202 / DryRun 204) and `X-Amz-Function-Error` — same contract the LocalStack event proxies already call. | integration |
| Gateway proxy (30xx) | Multi-port routing (literal > `{param}` > `{proxy+}` > `$default`; exact method > ANY), API Gateway payload v1/v2 events, v1 malformed → 502, v2 inferred responses, CORS preflight, `port-conflict` status instead of failing registration. | unit (`api-gateway-events`) + integration |
| Lambda authorizers | REST `token`/`request` (payload 1.0) and HTTP API `request` (payload 1.0/2.0, `enableSimpleResponses`), identity-source extraction (missing → 401), TTL cache + `POST /api/apis/authorizer-cache/clear`, cross-service resolution by ARN through the global registry. | unit (`authorizer-service`) + integration |
| Hot reload | Watched services restart their worker on source changes; `serverless.yml` changes re-package + re-register (with `autoPackage`). | integration |
| Lambdas/APIs HTTP API | `GET /api/lambdas`, `GET /api/lambdas/:name`, `POST /api/lambdas/:name/invoke`, `GET /api/lambdas/:name/logs`, `GET /api/apis`, `GET/POST /api/services/:name/runtime{,/start,/stop}`. | unit (`routes/lambdas`, `routes/apis`) + integration |
| `LssClient` namespaces | `lambdas.list/get/invoke/logs`, `apis.list/clearAuthorizerCache`, `services.runtime/startRuntime/stopRuntime`. | unit (`client/*`) |
| Dashboard menus | Lambdas (list/detail with invoke + logs) and APIs (routes per service with listener status) sections in the Vue UI. | manual (like the rest of the UI) |

---

### How the integration suite boots

`tests/integration/features.test.ts` uses an isolated config fixture
(`tests/integration/fixtures/lss.integration.config.json`: distinct ports, its own `stateDir`, managed mode,
`autoPackage`, token from `LOCALSTACK_AUTH_TOKEN`), runs `npx lss start --config <fixture>`, registers
`examples/sample-microservice`, asserts the rows above via the HTTP API, then `npx lss stop --config <fixture>`
and removes the scoped LocalStack container/volume. It runs locally and in a CI job gated on the
`LOCALSTACK_AUTH_TOKEN` secret (community LocalStack images ≥ 2026.5 require a token).
