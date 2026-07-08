# Serverless Orchestrator Plugin

[![npm version](https://img.shields.io/npm/v/serverless-lss.svg)](https://www.npmjs.com/package/serverless-lss)

Automatically register your Serverless microservices with the Local Serverless Stack Local Orchestrator.

## Installation

```bash
npm install --save-dev serverless-lss
```

## Usage

Add the plugin to your `serverless.yml`:

```yaml
plugins:
  - serverless-lss

custom:
  orchestrator:
    enabled: true
    orchestratorUrl: http://localhost:3100
```

## How it works

After running `sls package` or `sls deploy`:

1. The plugin sends a registration request to the Orchestrator (service path, ports, region)
2. The Orchestrator reads the `sls package` artifacts from `.serverless/` (CloudFormation template + `serverless-state.json`)
3. It provisions resources (DynamoDB, SQS, SNS, S3) to LocalStack
4. It registers the service's Lambda functions, HTTP routes and authorizers, starts a runtime worker, and binds the service's API port (30xx) and Lambda-invoke port (130xx) — replacing `serverless-offline`

## Configuration Options

- `enabled` (boolean, default: `true`): Enable/disable the plugin
- `orchestratorUrl` (string, default: `http://localhost:3100`): Orchestrator API endpoint

### Service ports

The plugin reports which ports LSS should serve the service on:

```yaml
custom:
  lss:                    # preferred — explicit LSS ports
    apiPort: 3010         # API Gateway emulator (HTTP routes)
    invokePort: 13010     # AWS Lambda Invoke API
  serverless-offline:     # fallback — drop-in for services already using offline
    httpPort: 3010
    lambdaPort: 13010
```

If only `apiPort` is known, the orchestrator derives `invokePort = apiPort + 10000`
(configurable via `lambdaRuntime.invokePortOffset`).

### Example with custom config:

```yaml
plugins:
  - serverless-lss

custom:
  orchestrator:
    enabled: true
    orchestratorUrl: http://my-orchestrator:3100
```

## Environment Variables (optional)

You can also use environment variables to override the configuration:

```bash
ORCHESTRATOR_URL=http://localhost:3100 sls package
```

## Features

✅ Auto-registers on `sls package`
✅ Auto-registers on `sls deploy`
✅ Non-blocking: deployment continues even if orchestrator is unavailable
✅ Colored console output
✅ Minimal dependencies

## Behavior

- If the Orchestrator is unavailable, the plugin logs a warning but doesn't fail the deployment
- The plugin is compatible with all Serverless Framework providers
- It only reads existing `.serverless/cloudformation-template-update-stack.json` files (doesn't create them)

## Troubleshooting

**"Orchestrator unavailable" message**

Make sure the Orchestrator is running:

```bash
cd orchestrator
npm run server
```

**Plugin not found**

Make sure you're using a recent version of Serverless Framework (3.0+) and that the plugin is installed in `node_modules`.

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev
```
