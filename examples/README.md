# LSS Examples

Three complete runnable projects — one per engine flavor. Each is a self-contained
monorepo slice: its own `lss.config.json`, AWS region, npm scripts, DynamoDB seeds,
dashboard branding and a browser validation console.

| Example | Engine | Region | Docker? | Auth token? | Dashboard / engine ports | Services (API / invoke) | What it demonstrates |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [localstack-free](localstack-free/) | LocalStack community 4.0 (managed) | `sa-east-1` | Yes | No | 3120 / LocalStack 4572 | users-service 3610/13610 · auth-service 3611/13611 · orders-service 3612/13612 · events-stack (portless) | httpApi v2 + REST v1, Lambda authorizers, shared EventBridge bus (`domain-events`), SQS consumer, schedule, DynamoDB stream → SNS, S3 uploads bucket + notification, seeds |
| [localstack-ultimate](localstack-ultimate/) | LocalStack Pro image (Ultimate plan) | `eu-west-1` | Yes | Yes (`LOCALSTACK_AUTH_TOKEN`) | 3111 / LocalStack 4571 | one service on serverless-offline: HTTP 3002 / invoke 3003 | The `--pro` path: Pro image + serverless-offline in charge of the ports, exercising the full resource menu — EventBridge custom bus + pattern rule with a queryable audit trail (`GET /audit`), `rate(2 minutes)` schedule, SQS DLQ redrive (`ReportBatchItemFailures`), DynamoDB GSI + streams → SNS, S3 notifications, TTL-from-the-UI story (resources named `localstack-ultimate-*`) |
| [self-hosted](self-hosted/) | LSS self engine (in-process) | `us-west-2` | No | No | 3140 / engine 14566 | orders 3631 · billing 3632 · notifications 3633 · catalog 3634 (invoke 13631–13634) | The no-Docker engine end to end: DynamoDB, SQS, S3, EventBridge pipeline plus an OpenSearch Serverless catalog (full-text search, filters, aggregations) |

## Shared conventions

Every example follows the same workflow:

```bash
cd examples/<example>
npm run setup          # npm install in each service
npm run lss:start      # start the orchestrator (self engine or managed LocalStack)
npm run register:all   # sls package each service → auto-register + provision
npm run lss:stop       # tear everything down
```

> localstack-ultimate is a single service on serverless-offline, so it has no
> `register:all`: after `npm run setup` + `npm run lss:start`, run
> `npm run offline` — packaging registers the service and offline serves the HTTP
> ports (see its [README](localstack-ultimate/README.md)).

- **Validation console**: each example ships an `index.html` you can open directly
  in a browser — or serve with `npm run console` (localstack-free on **8620**,
  localstack-ultimate on **8621**, self-hosted on **8622**) — to exercise every
  endpoint and event flow from one page.
- **Dashboard branding**: each `lss.config.json` carries a `branding` block with a
  logo made of the folder's initials — **LF** (purple), **LU** (amber), **SH**
  (teal) — a live demo of the [branding config](../docs/CONFIGURATION.md#configuration-properties).
- **Seeds**: DynamoDB fixtures under `seeds/{tableName}.json`, auto-applied on
  table creation and re-applied via `npx lss seed` or the dashboard.
- **.gitignore**: `node_modules/`, `.serverless/`, `.lss/`, `.env` are ignored in
  every example.

## What happened to the old examples?

The previous six examples were consolidated into this trio (same coverage, fewer
places to look):

| Old example | Now covered by |
| --- | --- |
| sample-microservice | [localstack-free](localstack-free/) (single-service DynamoDB/SQS/SNS/S3/stream/seed coverage folded into orders-service) |
| multi-service-sample | [localstack-free](localstack-free/) (users/auth/orders trio, cross-service events, schedules) |
| eventbridge-sample | [localstack-free](localstack-free/) (events-stack owns the `domain-events` bus; auth-service consumes `UserSignedUp` — `GET /signups`) |
| pro-sample-microservice | [localstack-ultimate](localstack-ultimate/) (resources renamed `localstack-ultimate-*`) |
| self-engine-sample | [self-hosted](self-hosted/) (orders → billing → notifications pipeline) |
| opensearch-sample | [self-hosted](self-hosted/) (catalog-service) |

The integration suite no longer boots from `examples/`: the old sample-microservice
test rig now lives at `tests/integration/fixtures/sample-microservice`.
