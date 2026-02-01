# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
