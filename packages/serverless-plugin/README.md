# Serverless Orchestrator Plugin

Automatically register your Serverless microservices with the Local Serverless Stack Local Orchestrator.

## Installation

```bash
npm install --save-dev lss-serverless-plugin
```

## Usage

Add the plugin to your `serverless.yml`:

```yaml
plugins:
  - lss-serverless-plugin

custom:
  orchestrator:
    enabled: true
    orchestratorUrl: http://localhost:3100
```

## How it works

After running `sls package` or `sls deploy`:

1. The plugin reads your CloudFormation template from `.serverless/`
2. Sends a registration request to the Orchestrator
3. The Orchestrator provisions resources (DynamoDB, SQS, SNS) to LocalStack

## Configuration Options

- `enabled` (boolean, default: `true`): Enable/disable the plugin
- `orchestratorUrl` (string, default: `http://localhost:3100`): Orchestrator API endpoint

### Example with custom config:

```yaml
plugins:
  - lss-serverless-plugin

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
