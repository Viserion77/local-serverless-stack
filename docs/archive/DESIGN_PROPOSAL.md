> **Historical document (2026-05)** — the original design proposal, written
> before implementation. Kept as a record; it **does not reflect the current
> state**. What exists today is in [docs/FEATURES.md](../FEATURES.md),
> [docs/CONFIGURATION.md](../CONFIGURATION.md) and [docs/SELF_ENGINE.md](../SELF_ENGINE.md).

# Local Orchestrator (proposal)

## Goal

Centralise DynamoDB, SQS and SNS resources in a single local control plane, orchestrating start/stop/hot-reload of the microservices without each one booting its own LocalStack/Serverless Offline.

## Architecture

- **Frontend (TS + Vue 3 + Vite)**: light static build, served by the backend. Uses vanilla components and its own CSS.
- **Backend (TS + Express)**: `/api/*` routes; every other route serves the frontend build. Reads CloudFormation templates from `.serverless/` and keeps a state cache.
- **Internal LocalStack**: the single AWS provider (dynamo, sqs, sns). A subprocess/container managed by the backend.
- **Service registration (CloudFormation)**: a Serverless plugin notifies the backend after `sls package`/`sls deploy`; the backend reads the CloudFormation template from `.serverless/` and extracts resources (DynamoDB, SQS, SNS, Lambdas).
- **Execution bridge**: events on the control plane's SQS/SNS fire the service's real handler (using the generated .zip artifact or the source directly).
- **Watcher**: listens for code/config changes in a service and triggers a rebuild via automatic `sls package` plus a resource re-sync.
- **Process control**: the backend can identify the PIDs of running services (e.g. `sls offline`) and signal them to stop/restart before running a new command.

## The CloudFormation template as the source of truth

**We do not need to invent a custom manifest.** The Serverless Framework already generates everything we need in `.serverless/`:

- `cloudformation-template-update-stack.json`: holds every resource definition (DynamoDB tables, SQS queues, SNS topics, Lambda functions with handlers, runtime, env vars, event sources such as SQS triggers, SNS subscriptions, DynamoDB streams).
- `serverless-state.json`: holds the service's full configuration (service name, provider, functions, resources).
- `<function>.zip`: the build artifact for each function.

### What the orchestrator extracts from the CloudFormation template

- **Lambdas** (`AWS::Lambda::Function`): handler path, runtime, env vars, memory, timeout.
- **DynamoDB** (`AWS::DynamoDB::Table`): table name, key schema, indexes, billing mode, streams.
- **SQS** (`AWS::SQS::Queue`): queue name, DLQ, visibility timeout, event source mappings.
- **SNS** (`AWS::SNS::Topic`): topic name, subscriptions.
- **Event Sources** (`AWS::Lambda::EventSourceMapping`): the link between SQS/DynamoDB streams and Lambdas.
- **Ignored**: API Gateway (not useful locally), IAM roles, CloudWatch logs.

### Orchestrator storage

Cached under `~/.lss/orchestrator/cache/<service>/`:

- `cloudformation-template.json` (a copy of the template)
- `metadata.json` (service root path, timestamp, template hash for change detection)
- `artifacts/` (optional: copies of the .zip files when needed)

## Backend API (sketch)

- `POST /api/services/register` → takes a service path, reads `.serverless/cloudformation-template-update-stack.json`, extracts resources, caches them and applies the diff to LocalStack.
- `POST /api/services/:name/package` → runs `sls package` in the service and auto-registers on success.
- `POST /api/services/:name/start` → optionally stops the old PID and runs the start command.
- `POST /api/services/:name/stop` → signals the registered PID.
- `POST /api/services/:name/redeploy` → re-runs `sls package`, re-reads the template, applies the diff.
- `GET /api/services` → lists services, state, PIDs, last update.
- `GET /api/resources` → lists the dynamo/queues/topics provisioned in LocalStack.
- `GET /api/diff/:name` → pending differences between the template and the state applied to LocalStack.

## Local workflow

1. Boot the orchestrator backend (`npm run orchestrator:server`). It starts LocalStack and Express, and serves the frontend build.
2. The built frontend is served automatically by the backend on any non-`/api/*` route.
3. In each microservice, run `sls package` (or the plugin's automatic hook) to generate `.serverless/cloudformation-template-update-stack.json`.
4. The Serverless plugin notifies the orchestrator (POST `/api/services/register` with the service path).
5. The backend reads the CloudFormation template, extracts resources and handlers, applies them to LocalStack and caches them.
6. The watcher detects changes under `src/`, `serverless.yml`, etc. → re-runs `sls package` → automatic redeploy.
7. The UI lets you start/stop services (process start/stop), view logs, apply diffs and re-invoke handlers by hand.

## Suggested monorepo structure

```
orchestrator/
  package.json
  tsconfig.json
  server/ (Express + LocalStack runner + watcher)
  ui/ (Vue 3 + Vite, builds to dist/)
  dist/ (the UI build served by the backend)
```

## Process control

- The backend keeps a PID table per service.
- Before starting a service it tries to stop the previous PID (SIGINT/SIGTERM). Optional: integrate with already-open terminals (signal by PID). On failure, log and carry on.

## Implementation considerations

- **Routing**: Express serves `/api/*`; the `app.get('*')` fallback serves the frontend build's `dist/index.html`.
- **LocalStack**: healthcheck + retry; provisions resources through the AWS SDK v3 by parsing the CloudFormation template (turning `AWS::DynamoDB::Table` into `createTable` calls, and so on).
- **Drift/diff**: the backend persists a snapshot of the applied template; when a new template arrives (via re-package) it computes the diff and applies incremental changes.
- **CloudFormation parser**: extract only the relevant resources (`AWS::Lambda::Function`, `AWS::DynamoDB::Table`, `AWS::SQS::Queue`, `AWS::SNS::Topic`, `AWS::Lambda::EventSourceMapping`); ignore API Gateway, IAM roles, logs.
- **Handler invocation**: when an event lands on LocalStack's SQS/SNS, the bridge reads the event source mapping from CloudFormation, identifies the right handler, loads the .zip (if present) or the source directly and invokes it with the payload.
- **Security**: environment variables from CloudFormation (`Environment.Variables`) are loaded per handler; secrets are not centralised.
- **Logs**: keep the last package/deploy/invoke events in memory plus a light file under `~/.lss/orchestrator/logs`.

## Next steps

1. Scaffold `orchestrator/server` (Express + LocalStack runner + CloudFormation parser + cache storage).
2. Scaffold `orchestrator/ui` (Vue 3 + Vite) with a minimal layout: service list, state, package/start/stop/redeploy actions, log panel.
3. Implement the CloudFormation template parser → extract the relevant resources and turn them into AWS SDK v3 calls.
4. Implement the Serverless plugin with an `after:package:finalize` hook to notify the orchestrator (POST `/api/services/register` with the service path).
5. Implement the file watcher (`src/`, `serverless.yml`) → trigger `sls package` → auto-register.
6. Implement the event bridge: LocalStack SQS/SNS/DynamoDB streams → identify the handler → load and invoke the .zip or source.
