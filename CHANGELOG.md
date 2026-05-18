# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.9] - 2026-05-18

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
