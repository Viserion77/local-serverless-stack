# LSS Integration Tests

Comprehensive integration tests for the Local Serverless Stack (LSS) project.

## Overview

These tests validate the entire LSS system, including:

- **CLI**: All commands (start, stop, status, logs, help)
- **Orchestrator API**: Service registration, resource management, health checks
- **Serverless Plugin**: CloudFormation parsing, resource provisioning, Lambda proxy creation

## Structure

```
tests/
├── integration/           # Integration test suites
│   ├── cli.test.ts       # CLI command tests
│   ├── orchestrator.test.ts  # Orchestrator API tests
│   └── plugin.test.ts    # Plugin registration tests
├── fixtures/             # Test data and templates
│   └── sample-cloudformation.json
├── helpers/              # Test utilities
│   └── test-utils.ts    # Common test helpers
└── setup.ts             # Global test setup
```

## Running Tests

### All Tests

```bash
npm test
```

### Specific Test Suites

```bash
# CLI tests only
npm run test:cli

# Orchestrator API tests only
npm run test:orchestrator

# Plugin tests only
npm run test:plugin

# All integration tests
npm run test:integration
```

### Watch Mode

```bash
npm run test:watch
```

### Coverage Report

```bash
npm run test:coverage
```

## Prerequisites

Before running tests:

1. **Docker must be running** (for LocalStack)
2. **Ports 3100 and 4566 must be available**
3. **Build the project**: `npm run build`
4. **Install dependencies**: `npm install`

## Test Suites

### 1. CLI Tests (`cli.test.ts`)

Tests all CLI commands:

- ✅ `npx lss start` - Starts orchestrator successfully
- ✅ `npx lss status` - Shows correct status (running/not running)
- ✅ `npx lss stop` - Stops orchestrator gracefully
- ✅ `npx lss logs` - Displays logs
- ✅ `npx lss help` - Shows help information
- ✅ LocalStack container startup
- ✅ PID file management
- ✅ Process lifecycle

### 2. Orchestrator API Tests (`orchestrator.test.ts`)

Tests the orchestrator REST API:

- ✅ Health check endpoint
- ✅ Service registration (`POST /api/services/register`)
- ✅ Service listing (`GET /api/services`)
- ✅ Resource listing (`GET /api/resources`)
- ✅ Service deletion (`DELETE /api/services/:name`)
- ✅ Error handling (404, malformed JSON, validation)
- ✅ CloudFormation template validation

### 3. Plugin Tests (`plugin.test.ts`)

Tests the Serverless Framework plugin integration:

- ✅ Service registration flow
- ✅ DynamoDB table provisioning
- ✅ SQS queue provisioning
- ✅ SNS topic provisioning
- ✅ Lambda proxy creation
- ✅ Event source mapping creation
- ✅ Duplicate service handling
- ✅ CloudFormation parsing

## Test Utilities

### `TestUtils` Class

Located in `tests/helpers/test-utils.ts`:

- `waitFor(condition, timeout)` - Wait for a condition to be true
- `waitForPort(port)` - Wait for a port to be open
- `waitForProcessExit(pid)` - Wait for a process to exit
- `isPortInUse(port)` - Check if a port is in use
- `killProcessOnPort(port)` - Kill process using a port
- `readPidFile()` - Read the orchestrator PID file
- `isProcessRunning(pid)` - Check if a process is running
- `execCli(command)` - Execute LSS CLI command
- `createTempCfnTemplate(serviceName)` - Create test CloudFormation template
- `cleanupTempFiles()` - Clean up temporary files
- `waitForLocalStack()` - Wait for LocalStack to be ready

### Custom Jest Matchers

- `toBeValidPort()` - Check if number is a valid port (1-65535)
- `toBeValidPid()` - Check if number is a valid process ID (> 0)

## Test Workflow

Each test suite follows this pattern:

```typescript
describe('Test Suite', () => {
  beforeAll(async () => {
    // Start orchestrator once
    await TestUtils.execCli('start');
    await TestUtils.waitForPort(3100);
  });

  afterAll(async () => {
    // Stop orchestrator once
    await TestUtils.execCli('stop');
  });

  it('should do something', async () => {
    // Test implementation
  });
});
```

## Debugging Tests

### Run Single Test

```bash
npx jest tests/integration/cli.test.ts -t "should start the orchestrator"
```

### Verbose Output

```bash
npx jest --verbose
```

### Check Logs

During tests, orchestrator logs are written to `/tmp/lss-orchestrator.log`:

```bash
tail -f /tmp/lss-orchestrator.log
```

### Check LocalStack

```bash
# LocalStack health
curl http://localhost:4566/_localstack/health

# List DynamoDB tables
aws --endpoint-url=http://localhost:4566 dynamodb list-tables --region us-east-1
```

## Common Issues

### Port Already in Use

```bash
# Kill process on port 3100
lsof -ti :3100 | xargs kill -9

# Or use test utility
npm run test:cli  # Will automatically clean up
```

### Tests Timeout

- Increase timeout in test: `it('test', async () => {...}, 60000)`
- Check if Docker is running
- Check if LocalStack started: `docker ps | grep localstack`

### Tests Hang

- Tests might not clean up properly
- Run: `npx lss stop`
- Kill any hanging processes: `ps aux | grep node`

## CI/CD Integration

For CI pipelines:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run build
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
```

## Coverage Goals

Target coverage levels:

- **Statements**: > 80%
- **Branches**: > 75%
- **Functions**: > 80%
- **Lines**: > 80%

## Contributing

When adding new features:

1. Add corresponding integration tests
2. Ensure all tests pass: `npm test`
3. Check coverage: `npm run test:coverage`
4. Update this README if adding new test utilities

## Future Improvements

- [ ] Add unit tests for individual components
- [ ] Add E2E tests with real Serverless projects
- [ ] Add performance/load tests
- [ ] Add snapshot tests for UI
- [ ] Add contract tests for API
- [ ] Add mutation testing
