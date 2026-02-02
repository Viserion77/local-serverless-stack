# Configuration Guide for LSS

LSS (Local Serverless Stack) supports configuration files to customize the behavior of the orchestrator, including server port, LocalStack port, and DynamoDB proxy settings.

## Configuration Files

LSS looks for configuration files in the following order:

1. `lss.config.json` in the current working directory
2. `.lssrc` in the current working directory
3. `lss.config.json` in the home directory (`~`)
4. `.lssrc` in the home directory

The first file found will be used. If no configuration file is found, environment variables will be checked.

## Configuration Options

### lss.config.json or .lssrc

Both files should contain valid JSON with the following optional properties:

```json
{
  "serverPort": 3100,
  "localstackPort": 4566,
  "localstackEndpoint": "http://localhost:4566",
  "enableDynamoProxy": false,
  "dynamoProxyPort": 8000,
  "region": "us-east-1",
  "services": ["dynamodb", "sqs", "sns", "lambda"],
  "persistence": true,
  "debug": false
}
```

### Configuration Properties

- **serverPort** (number, default: 3100)
  - Port where the LSS server (dashboard + API) will run
  - Used by both the web UI and REST API
  - The Serverless Plugin connects to this server to register services
  - Example: `3100`

- **localstackPort** (number, default: 4566)
  - Port where LocalStack container will expose its API
  - Example: `4566`

- **localstackEndpoint** (string, optional)
  - Custom endpoint for LocalStack
  - Example: `"http://localhost:4566"` or `"http://192.168.1.100:4566"`

- **enableDynamoProxy** (boolean, default: false)
  - Enable a proxy for DynamoDB on a separate port
  - Useful for tools that expect DynamoDB on port 8000
  - Example: `true`

- **dynamoProxyPort** (number, default: 8000)
  - Port where the DynamoDB proxy will run (only if enableDynamoProxy is true)
  - Example: `8000`

- **region** (string, default: "us-east-1")
  - AWS region for LocalStack
  - Example: `"us-east-1"`

- **services** (array, default: ["dynamodb", "sqs", "sns", "lambda"])
  - AWS services to enable in LocalStack
  - Example: `["dynamodb", "sqs", "sns", "lambda", "s3"]`

- **persistence** (boolean, default: true)
  - Whether to persist LocalStack data between restarts
  - Example: `true`

- **debug** (boolean, default: false)
  - Enable debug mode for LocalStack
  - Example: `false`

## Configuring the Serverless Plugin

The Serverless Plugin needs to know where to find the LSS server. Configure it in `serverless.yml`:

```yaml
plugins:
  - lss-serverless-plugin

custom:
  orchestrator:
    enabled: true
    orchestratorUrl: http://localhost:3100
```

The plugin will automatically use the `serverPort` from the LSS configuration if you don't override it.

### Plugin Configuration Options

- **enabled** (boolean, default: true)
  - Whether to enable the plugin
  - Example: `true`

- **orchestratorUrl** (string, default: "http://localhost:3100")
  - URL where the LSS server is running
  - Should match the serverPort from lss.config.json
  - Can be overridden via `ORCHESTRATOR_URL` environment variable
  - Example: `"http://localhost:3100"`

### Environment Variables for Plugin

- `ORCHESTRATOR_URL` - Override orchestratorUrl
- `ORCHESTRATOR_ENABLED` - Override enabled setting (true/false)

## Examples

### Basic Configuration (lss.config.json)

```json
{
  "serverPort": 3100,
  "localstackPort": 4566,
  "enableDynamoProxy": false
}
```

### Full Configuration with Custom Ports

```json
{
  "serverPort": 3200,
  "localstackPort": 4600,
  "localstackEndpoint": "http://localhost:4600",
  "enableDynamoProxy": true,
  "dynamoProxyPort": 8001,
  "region": "eu-west-1",
  "services": ["dynamodb", "sqs", "sns", "lambda", "s3"],
  "persistence": true,
  "debug": false
}
```

### .lssrc File

The `.lssrc` file has the same format as `lss.config.json`:

```json
{
  "serverPort": 3100,
  "localstackPort": 4566
}
```

### Serverless.yml with Custom Server Port

If you're using a custom server port, update both configurations:

**lss.config.json:**
```json
{
  "serverPort": 3200
}
```

**serverless.yml:**
```yaml
custom:
  orchestrator:
    orchestratorUrl: http://localhost:3200
```

## Environment Variables

If no configuration file is found, you can use environment variables:

- `PORT` or `LSS_DASHBOARD_PORT` - Server port
- `LSS_LOCALSTACK_PORT` - LocalStack port
- `LSS_LOCALSTACK_ENDPOINT` - LocalStack endpoint
- `LSS_ENABLE_DYNAMO_PROXY` - Enable DynamoDB proxy (true/false or 1/0)
- `LSS_DYNAMO_PROXY_PORT` - DynamoDB proxy port
- `AWS_REGION` - AWS region
- `LSS_SERVICES` - Services (comma-separated)
- `LSS_PERSISTENCE` - Persistence (true/false or 1/0)
- `LSS_DEBUG` - Debug mode (true/false or 1/0)

### Environment Variable Examples

```bash
# Set server port
export LSS_DASHBOARD_PORT=3200

# Enable DynamoDB proxy
export LSS_ENABLE_DYNAMO_PROXY=true

# Set LocalStack port
export LSS_LOCALSTACK_PORT=4600

# Start the orchestrator
npx lss start
```

## Priority Order

Configuration is loaded in this order (first match wins):

1. Configuration file (`lss.config.json` or `.lssrc`)
2. Environment variables
3. Default values

## Getting Started

1. Copy the example configuration:
   ```bash
   cp lss.config.json.example lss.config.json
   ```

2. Edit `lss.config.json` with your desired settings

3. Update `serverless.yml` with the orchestrator configuration (if using custom port)

4. Start the orchestrator:
   ```bash
   npx lss start
   ```

## Checking Current Configuration

Start the orchestrator and check the logs:

```bash
npx lss start
npx lss logs
```

The orchestrator will print a configuration summary when it starts, showing all active settings.

## Troubleshooting

### Configuration not being loaded

1. Ensure the file is valid JSON
2. Check the file location (must be in cwd or home directory)
3. Check file permissions (must be readable)
4. Look at the logs: `npx lss logs`

### Port already in use

If a port is already in use, change it in the configuration file:

```json
{
  "serverPort": 3200,
  "localstackPort": 4600
}
```

Then update `serverless.yml`:
```yaml
custom:
  orchestrator:
    orchestratorUrl: http://localhost:3200
```

### Plugin can't find the server

1. Verify the server is running: `npx lss status`
2. Check the `orchestratorUrl` in `serverless.yml` matches the `serverPort` in `lss.config.json`
3. Check the logs: `npx lss logs`
4. Try using the `ORCHESTRATOR_URL` environment variable:
   ```bash
   export ORCHESTRATOR_URL=http://localhost:3200
   npx serverless offline start
   ```

### Can't find configuration file

Use environment variables instead:

```bash
export LSS_DASHBOARD_PORT=3100
export LSS_LOCALSTACK_PORT=4566
npx lss start
```
