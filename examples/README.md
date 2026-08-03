# LSS Examples

One complete runnable project: a self-contained monorepo slice with its own
`lss.config.json`, AWS region, npm scripts, DynamoDB seeds, dashboard branding and
a browser validation console.

| Example | Region | Docker? | Stack port | Services (API / invoke) | What it demonstrates |
| --- | --- | --- | --- | --- | --- |
| [self-hosted](self-hosted/) | `us-west-2` | No | 14566 (dashboard + API + AWS wire) | orders 3631 · billing 3632 · notifications 3633 · catalog 3634 (invoke 13631–13634) | The engine end to end: DynamoDB, SQS with DLQ redrive, S3 (incl. presigned POST), EventBridge, Secrets Manager, and an OpenSearch Serverless catalog (full-text search, filters, aggregations) |

## Shared conventions

Every example follows the same workflow:

```bash
cd examples/<example>
npm run setup          # npm install in each service
npm run lss:start      # start the orchestrator + engine (no Docker)
npm run register:all   # lss register each service (packages on demand) + provision
npm run lss:stop       # tear everything down
```

- **Validation console**: each example ships an `index.html` you can open directly
  in a browser — or serve with `npm run console` (self-hosted on **8622**) — to
  exercise every endpoint and event flow from one page.
- **Dashboard branding**: `lss.config.json` carries a `branding` block (teal **SH**
  logo, per-theme brand tokens) — a live demo of the
  [branding config](../docs/CONFIGURATION.md#configuration-properties).
- **Seeds**: DynamoDB fixtures under `seeds/{tableName}.json`, auto-applied on
  table creation and re-applied via `npx lss seed` or the dashboard.
- **.gitignore**: `node_modules/`, `.serverless/`, `.lss/`, `.env` are ignored in
  every example.

## What happened to the old examples?

The previous six examples were consolidated into this trio (same coverage, fewer
places to look):

| Old example | Now covered by |
| --- | --- |
| self-engine-sample | [self-hosted](self-hosted/) (orders → billing → notifications pipeline) |
| opensearch-sample | [self-hosted](self-hosted/) (catalog-service) |
| localstack-free, localstack-ultimate | removed in 1.0 with the LocalStack backend — see [MIGRATION-v1.md](../docs/MIGRATION-v1.md). Their raw `AWS::ApiGatewayV2::*` cross-stack topology moved to `tests/integration/fixtures/apigw-raw/`, where its end-to-end test still runs. |

The integration suite no longer boots from `examples/`: the old sample-microservice
test rig now lives at `tests/integration/fixtures/sample-microservice`.
