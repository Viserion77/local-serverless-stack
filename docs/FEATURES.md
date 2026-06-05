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
| `lss start` | Starts the orchestrator (managed LocalStack by default) in the background; writes a PID file and logs. | integration (`cli.test.ts`) |
| `lss stop` | Gracefully stops the orchestrator addressed by the active config. | integration |
| `lss status` | Reports RUNNING/NOT RUNNING + ports for the addressed instance. | integration |
| `lss logs` | Prints the tail of the instance log. | integration |
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

---

### How the integration suite boots

`tests/integration/features.test.ts` uses an isolated config fixture
(`tests/integration/fixtures/lss.integration.config.json`: distinct ports, its own `stateDir`, managed mode,
`autoPackage`, token from `LOCALSTACK_AUTH_TOKEN`), runs `npx lss start --config <fixture>`, registers
`examples/sample-microservice`, asserts the rows above via the HTTP API, then `npx lss stop --config <fixture>`
and removes the scoped LocalStack container/volume. It runs locally and in a CI job gated on the
`LOCALSTACK_AUTH_TOKEN` secret (community LocalStack images ≥ 2026.5 require a token).
