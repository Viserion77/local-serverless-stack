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
| `lss start` | Starts the orchestrator + engine in the background on **one port** (default 14566: dashboard, REST API and AWS wire); writes a PID file and logs. | integration (`features.test.ts` boots via `lss start --config`) + unit (`cli`) |
| `lss stop` | Gracefully stops the orchestrator addressed by the active config. | integration (`features.test.ts` teardown) + unit (`cli`) |
| `lss status` | Reports RUNNING/NOT RUNNING + ports for the addressed instance. | unit (`cli`) |
| `lss logs` | Prints the tail of the instance log. | unit (`cli`) |
| `lss mcp` | Runs the MCP server on stdio for an AI coding agent. Requires a running orchestrator. | unit (`cli`, `mcp/*`) |
| `lss seed [table]` | Applies `{table}.json` seed files from `seedsDir` into DynamoDB (all matching tables, or one). | unit (`cli-seed`) + integration |
| `lss seed:clear [table]` | Deletes seeded items after an interactive `confirmar` prompt (or `--yes`); refuses any non-local endpoint. | unit (`cli-seed`, `seed-manager-guard`) |
| `--config <path>` | Loads config from an explicit file, taking precedence over the cwd/home search; also via `LSS_CONFIG`. | unit (`cli`) + integration |

## 2. Configuration & instance isolation

| Feature | Promise | Asserted by |
|---|---|---|
| `lss.config.json` / `.lssrc` | File config for ports, mode, edition, services, seeds, etc.; env vars override. | unit (`config-manager`, `cli`) |
| `stateDir` | Per-instance PID/log directory so an isolated test instance never collides with the dev instance. | unit (`cli`, `config-manager`) + integration |
| `LSS_ENGINE_DATA_DIR` | Points the self engine's state at an explicit directory from the environment. With `LSS_DASHBOARD_PORT` and `LSS_ENGINE_PORT` it is everything a second instance needs — no config file to write, nothing shared with the dev stack. | unit (`config-manager`) |
| `LSS_CONFIG_PATH` passthrough | The CLI hands the chosen config to the spawned server so both loaders agree on ports/seedsDir/region/mode. | unit (`config-manager`) + integration |
| `LSS_BIND_HOST` | The interface **every listener the process opens** binds — one variable, one posture. Not just the orchestrator (dashboard + REST API + embedded AWS wire): each service's API Gateway and **Lambda Invoke API** port (`gateway-manager.ts`), the engine's own front door when `selfEngine.port` differs from `serverPort` (`self-backend.ts`) and the DynamoDB proxy (`dev/dynamo-proxy.ts`) all read the same value from `services/bind-host.ts`, so widening is a single decision and there is no half-open state. Default **`127.0.0.1`**: the API has no authentication and every table, queue, bucket and secret is readable through it, so it is not offered to the network unless you ask. `LSS_BIND_HOST=0.0.0.0 lss start` is the opt-in — needed for Docker port publishing (`-p 14566:14566` arrives on the container's external interface), *not* for VS Code devcontainer forwarding, which attaches from inside the container — and any non-loopback bind prints a boot warning naming what it exposed; an address that is not this host's fails with an `EADDRNOTAVAIL` message pointing at the variable. **Env-only by design**: there is no `lss.config.json` key and no `PUT /api/config` spelling, because widening the bind through the API the bind protects would hand the exposure back to whoever already reached the API. Through **0.17.2** the last three listeners ignored this variable — a bare `server.listen(port)` binds the `::` wildcard and `self-backend.ts` asked for `0.0.0.0` outright — which left the invoke ports (arbitrary handler execution from a request body) and, in split-listener mode, the whole AWS data plane open on the LAN behind a loopback dashboard. | unit (`routes/services`, `dev/dynamo-proxy` — real listeners' bound address asserted) + integration (the suite boots and drives the API on the default bind; `src/server/index.ts` is excluded from the unit coverage denominator — it listens at import) |
| `LSS_CORS_ORIGINS` | Which **browser origins** may call the REST API cross-origin: comma-separated exact origins (case and trailing slash forgiven), or a single `*` for any. Unset (or empty) keeps the default loopback allowlist — `http://localhost`, `http://127.0.0.1`, `http://[::1]`, any port — and setting it **replaces** that list rather than extending it. Exists because loopback-only is wrong for a layout LSS is genuinely used in: the stack runs in a container, the browser is on the host, and the developer's own frontends call LSS directly to inspect a queue, hit the emulated API Gateway or invoke a Lambda. Pairs with `LSS_BIND_HOST` — the bind decides who can open a socket, this decides which pages the browser lets read the answer — so the documented container opt-in is one line: `LSS_BIND_HOST=0.0.0.0 LSS_CORS_ORIGINS='*' lss start`. A `*` list prints the same boot exposure warning as a non-loopback bind; a named list prints nothing. Env-only for the same reason the bind is. Callers with no `Origin` (curl, `lss`, `LssClient`, MCP, AWS SDKs) never reach a CORS decision, and AWS wire traffic never reaches the middleware at all. | unit (`services/bind-host`) |
| Per-project state, no `stateDir` | With no `stateDir`, the engine `dataDir`, the aoss sidecar data dir and the artifact-extraction dir all fall back to `~/.lss/projects/<project-slug>-<hash>/…` instead of one shared path — two checkouts (or two examples) never read each other's tables, and re-registering in one no longer `rm -rf`s the code another instance's worker is running from. | unit (`config-manager`, `cache-manager`) |
| No LocalStack env | `lss start` exports **no** `LSS_LOCALSTACK_*` / `LOCALSTACK_AUTH_TOKEN` to the orchestrator (and therefore to every forked worker). Each key exported this way was also reported by `GET /api/config` as env-overridden, greying out a Settings field for a value the user never set. | unit (`cli`) |
| Edition / version / image / services / persistence / region | All configurable; sensible defaults (community/latest, us-east-1, dynamodb+sqs+sns+s3+lambda+events). | unit (`config-manager`) |
| `GET /api/config` | Public-safe full config snapshot for the UI: engine kind/endpoint, self-engine + aoss sidecar + lambda-runtime blocks, packaging, `envOverrides` (keys masked by env vars). Secret values never appear — auth token → `hasAuthToken`, `packageEnv` → key names, `secrets` → count. | unit (`routes/config`) + integration |
| `PUT /api/config` | Edit the config from the dashboard Settings tab: writes only the patched keys into the loaded config file (creating `lss.config.json` when none is loaded), `null` deletes, object blocks merge one level deep; hot-reloads and reports `restartRequired` (boot-materialized keys) + `envOverridden` (file value masked by env). `secrets` is rejected. | unit (`config-manager`, `routes/config`) |
| `packageCommand` / `packageArgs` packaging grammar | The command `autoPackage` and `POST /api/services/package` run is not a free-form string when it is written through `PUT /api/config`. Global **and** per-service (`servicePackaging[*]`), it is tokenized by the same tokenizer the packager uses before `spawn()` — so the checked string is the executed string — and must match one of three shapes: `npm\|yarn\|pnpm run\|run-script …`, `serverless\|sls\|osls package …`, or `npx [-y] serverless\|sls\|osls[@version] package …`. Every documented form still works (`npx serverless package`, `npm run package:local`, `yarn run package`, `serverless package --stage dev`, `sls package -c custom.yml`, `npx -y serverless@3.38.0 package`). **A first-token check was not enough and was walked through**: every allowed runner is an interpreter one subcommand in, and `spawn('npm', ['exec','-c','<shell string>'])` runs that string with no `shell: true` — so `npm exec -c`, `npm x`, `npx -c`, `npx -y <pkg>`, `yarn dlx`, `pnpm dlx`, `yarn exec`, `yarn node -e`, `yarn create`, `npm i <pkg>` and `yarn add <pkg>` (install scripts) all named an allowed runner while running caller-chosen code. Pinning the **subcommand** removes them; a bare `yarn package` is rejected too, because yarn 1's implicit `run` is what makes `yarn node -e` look like a script name. On top of the grammar, every command token **and every `packageArgs` element** (error: `"packageArgs[1]" cannot contain …`) is screened for flags that re-point an allowed program: `--node-options`, `--script-shell`, `--shell`, `--shell-mode`, `--call`, `--userconfig`, `--globalconfig`, `--use-yarnrc`, `--registry`, `--prefix`, `--cwd`, `--dir`, `--require`, `--eval`, `--print`, `--import`, `--loader`, `--experimental-loader`, `--input-type` — compared with dashes/underscores stripped (`--nodeOptions` is the same flag), while Serverless's `-c`/`-p`/`-r` stay usable because the grammar already makes them unreachable as npm/npx options. `packageArgs` needed its own screen because it reaches the same argv without a tokenizer: `{"packageCommand":"npm","packageArgs":["exec","-c","<shell>"]}` was the identical bypass one key across. `packageEnv` (global and per-service) additionally rejects keys the runtime or dynamic linker reads before `main()` — `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`, `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, matched case-insensitively for Windows — since those choose the binary whichever runner passed. All three become arguments to `spawn()`, and all three were plain `string`/`stringArray`/`stringRecord` in **0.17.2** (verified against the released tree), where `POST /api/services/register` with `autoPackage` — itself a `PUT /api/config` key — reached the same `spawn()`; that made the `/start` and `/install` allowlists worthless on their own. **Scope, stated rather than implied**: the fence is on the API, not the read path — a hand-edited `lss.config.json` and `LSS_PACKAGE_COMMAND` stay unchecked, being the operator's own shell — and what remains expressible is the project's own build: `npm run <script>` runs what the service's `package.json` declares and `serverless package` reads its `serverless.yml` (plugins included), because forbidding that would mean the dashboard could not set a package command at all. The gain is "any binary with any argv" → "the project's own build, and nothing the caller names". | unit (`config-manager`, `routes/config`) |
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

## 4. Service registration & discovery (plugin-free)

| Feature | Promise | Asserted by |
|---|---|---|
| Registration API | `POST /api/services/register` with a bare `{ servicePath }` is complete: the orchestrator packages when the template is missing (`autoPackage`) and reads name/region/`custom.lss` ports from the packaged `serverless-state.json`. Explicit `apiPort`/`invokePort`/`region` in the payload win over the state hints; `serviceRuntime` (config) wins over both. | unit (`routes/services`, `serverless-state-parser`) + integration |
| Service discovery | `GET /api/services/scan` / `lss scan` walk the project root (depth ≤ 6, dependency/build/VCS trees skipped, a service root is a leaf) and report every Serverless/osls service with `installed`/`packaged`/`registered` flags plus effective ports and package command (`serviceRuntime`/`servicePackaging` overlays win over yml hints — same precedence registration applies). | unit (`service-scanner`, `routes/services`, `cli`) |
| Preparation endpoints | `POST /api/services/install` runs a dependency install in the service dir (default `npm install`) and `POST /api/services/package` runs the effective package command (global merged with the `servicePackaging` override). Both answer `{ exitCode, durationMs, output }`, 422 with the output tail on failure. Both confine `servicePath` to the project root **by real path** — `servicePath` and the root are `realpathSync`-resolved before they are compared, so a symlink inside the root that points outside it is rejected instead of followed, and the resolved path is what the command runs in. The install command is validated by **shape** — package manager + install verb, no positionals — and its flags against an **allowlist** (`--production`, lockfile spellings, `--no-audit`/`--no-fund`, `--prefer-offline`/`--offline`, `--legacy-peer-deps`, `--force`, `--silent`/`--quiet`, and `--omit=`/`--include=`/`--loglevel=`). So `node -e …`, `npm exec …`, `npm install <other-package>` and every location- or registry-bearing flag (`--registry=`, `--userconfig=`, `--prefix=`, `yarn --cwd=`, `pnpm --dir=`) are rejected — a flag is not inert, and a deny-list cannot keep up with three package managers. `/package` runs the effective `packageCommand`/`packageArgs`, which answer to the packaging grammar and flag screen of their own (§2) — runner *and* subcommand, so `npm exec -c '<shell>'` is refused there exactly as `npm exec` is here — so neither endpoint can be turned into a general command runner by way of the config. | unit (`routes/services`) |
| CLI registration | `lss register [path...]` (defaults to `.`) POSTs each path and exits non-zero if any fails; `lss scan` prints the checklist. | unit (`cli`) + integration (live proof) |
| Guided onboarding | First dashboard visit with no services opens a 3-step flow — ports, branding, project scan with tick-to-select and install → package → register buttons; per-service ports and package commands are editable inline and persist to `lss.config.json` (`serviceRuntime`/`servicePackaging`, merged per entry so sibling settings survive). Reopenable from Settings. | vue-tsc + manual |
| Service lifecycle API | `GET/DELETE /api/services`, `PATCH /:name/status`, `POST /:name/start\|stop`, `GET /:name/logs`. `start` spawns the service's **own** npm start script (`run start`, or `run start:<stage>`) in the root recorded at registration: argv, cwd and env are server-derived and the body's `args`/`cwd`/`env` are not read at all. The only caller-supplied values are `command`, allowlisted to `npm`/`yarn`/`pnpm` (`node` and `npx` are off it), and `stage`, constrained to `[A-Za-z0-9._-]+` so it can name a script of that service's `package.json` and nothing else. Through **0.17.2** this endpoint passed body-supplied `command`/`args`/`cwd`/`env` to `spawn()` with `node` allowed, i.e. arbitrary code execution for anything that reached the port. | unit (`routes/services`) |

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
(The 0.x `localstack` boolean is gone — see [MIGRATION-v1.md](MIGRATION-v1.md).)

**Who may talk to this API.** Two knobs, one posture, both env-only (§2). `LSS_BIND_HOST` decides which
machines may open a socket — loopback by default, and it covers **every** listener the process opens, not
just this one. `LSS_CORS_ORIGINS` decides which browser *pages* may read the answer — loopback origins by
default (`http://localhost`, `http://127.0.0.1`, `http://[::1]`, any port), which is the whole set of browser
callers a default install has: the built dashboard is served by this same process (same-origin, so CORS never
applies), and only the Vite dev dashboard on `3101` is cross-origin. Any other origin gets **no**
`Access-Control-Allow-Origin` header, so the browser fails the preflight and the real request is never sent —
which matters because there is no authentication on any route: the bind and the origin allowlist *are* the
boundary. A request with no `Origin` (curl, `lss`, `LssClient`, the MCP server, an AWS SDK) is not a
cross-origin browser request and is unaffected, and AWS wire traffic never reaches the middleware at all —
`isAwsRequest()` hands it to the engine ahead of Express.

Both defaults are **deliberately widenable**, because the common container layout — LSS in a container, browser
and the developer's own frontends on the host — needs both halves: `LSS_BIND_HOST=0.0.0.0 LSS_CORS_ORIGINS='*'
lss start`, or with the origins named instead of wildcarded. What that accepts is an unauthenticated API on the
network whose callers can read and write local emulator data and read secret values. That is bounded rather
than a shell on the host — `/start` derives its argv server-side, `/install` is shape- and flag-allowlisted,
and `packageCommand`/`packageArgs`/`packageEnv` are grammar- and flag-fenced (§2, §4) — but bounded is not zero, so a trusted network
stays a precondition. Boot warns on every non-default posture. Asserted by:
unit (`services/bind-host` — the origin predicate and the exposure warning) + integration (every suite request
is a loopback request against the default bind; `src/server/index.ts` is integration-only by nature and
excluded from the unit coverage denominator).

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

**Official AWS service icons**: 64 marks from AWS's **Architecture Service Icons** pack (the 16 variant —
`viewBox 0 0 24 24`, TreeUI's own icon grid) are vendored as geometry in `src/ui/src/icons/aws/` and registered
into the TreeUI icon registry by `registerTreeIcons()` before `createApp`, with a `TIconRegistry` augmentation
so `<TIcon name="aws-lambda" />` typechecks like a built-in. 12 cover the services LSS provides (Lambda,
DynamoDB, S3, SQS, SNS, EventBridge, OpenSearch, Secrets Manager, API Gateway, CloudFormation, IAM — also
standing for STS — and CloudWatch — also standing for CloudWatch Logs); 52 more are a registered reserve.
They label the sidebar, the Overview tiles and coverage rows, every per-service resource breakdown, the Lambda
trigger tags and each explorer's headers and empty states; `src/ui/src/icons/resourceIcons.ts` is the single
resource-type → mark map, keyed by the API contract's unions so a new resource type fails the typecheck until
its mark is chosen. The artwork is an AWS trademark, reproduced unmodified — full-colour, deliberately ignoring
the theme and the `branding.colors` overrides (`src/ui/src/icons/aws/NOTICE.md`). `npm run icons:aws`
regenerates it from the pack, which is **not** committed. Asserted by: `vue-tsc` (the registry augmentation) +
manual, like the rest of the UI.

Dashboard branding: an optional `branding` key in `lss.config.json` (title, subtitle, logo,
favicon, defaultTheme, plus `colors`/`themeColors` as TreeUI token overrides) customizes the dashboard. Served
at `GET /api/config/branding`; local logo/favicon files are exposed at `GET /api/config/branding/logo|favicon`.
A working showcase (logo file + per-theme colors) ships with `examples/self-hosted` — every project under
`examples/` carries its own branding block. Asserted by: unit (`config-manager` "branding" block).

### Live load panel (Overview)

`GET /api/lambdas/activity?windowMs=&buckets=` answers with the invocation spans in the window, per-bucket
**peak** concurrency (never an average — the burst is the signal), totals (invocations, errors, cold starts,
peak parallelism, in-flight now, mean duration), the worker table (one row per service: status, warm, pid,
counters, function count), the residency policy (`warm`/`maxWarmWorkers`/`lazy`/`idleTimeoutMs`) and host
counters (orchestrator RSS, free/total RAM, CPU count, 1-minute load, uptime). Spans come from a stack-wide,
log-free ring capped at 1000 entries (`invocation-activity.ts`), recorded on every invocation; a span still
running when the window opens is included, so a long handler reads as load rather than silence. The dashboard
renders it as stat tiles + a step area + a per-service span timeline. Asserted by: unit (`invocation-activity`,
`routes/lambdas`).

### Languages (dashboard + CLI)

Both interfaces speak **English, Brazilian Portuguese and Spanish**. The dashboard picks the language
from a stored choice, else the browser's `navigator.languages` (`pt` → `pt-BR`, `es-AR` → `es`,
anything unknown → English); switch it in the ⋮ menu and the choice is remembered per browser. The CLI
resolves `LSS_LANG` first, then the POSIX `LC_ALL` / `LC_MESSAGES` / `LANG` chain, and falls back to
English. Both layers are hand-rolled and dependency-free (`src/ui/src/i18n/`, `bin/i18n.js`): a missing
key falls back to English and then to the key itself, so an untranslated screen still renders something
actionable. AWS proper nouns, config keys, CLI commands and flags are deliberately never translated.
Asserted by: unit (`cli/i18n`) + `vue-tsc`.

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
(Claude Code included) as **25 tools**, so an AI agent drives the stack directly instead of being handed
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
`docs/PRD_SELF_ENGINE.md`. Status: the only engine as of 1.0 — the integration suite is
the next milestone and rows below will gain integration assertions with it.

| Feature | Promise | Asserted by |
|---|---|---|
| One port for everything | `serverPort` and `selfEngine.port` both default to `14566`, and being equal is the switch: the orchestrator binds one listener and routes each request by shape — SigV4 / `X-Amz-Target` / any `x-amz-*` header / an engine-owned path (`/_aoss`, `/2015-03-31/`, `/_lss/health`) / a `POST` of `multipart` or form-encoded goes to the engine, everything else to the REST API and the SPA. A bucket named `api` is not a conflict: the SDK signs, the browser does not. Give the two keys different values to bind two listeners as before. | unit (`engine/http/is-aws-request`, `config-manager`, `routes/config`) + integration |
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
It runs **unconditionally**, locally and in CI: no Docker, no secret, ~20 seconds. (Under 0.x the same
suite skipped itself whenever the LocalStack auth token was absent, which was most of the time.)
