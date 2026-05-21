# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Serverless Framework >= 3.0 required

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
