# localstack-ultimate

End-to-end LSS example pointed at the **LocalStack paid tier**. LocalStack renamed its
paid plans — the top plan is now **Ultimate** — but the Docker image those plans use is
still `localstack/localstack-pro:latest`, and that is exactly what this example boots.

This is also the one example that deliberately keeps the **serverless-offline
integration path**: the HTTP API is served by `serverless-offline` (not by the LSS
gateway), while the `serverless-lss` plugin registers the service with the orchestrator,
which provisions every CloudFormation resource into the Pro LocalStack and wires the
S3 → Lambda notification. Use it to confirm LSS plays nicely with an offline-based
workflow you may already have.

## What this exercises

- **LocalStack Pro image** — `localstackEdition: "pro"` in `lss.config.json`; the
  container refuses to start without a valid `LOCALSTACK_AUTH_TOKEN` (exit code 55).
- **serverless-offline compatibility** — REST (v1) routes with `cors: true` served by
  the offline server on `3002`; registration with LSS fires on `sls package` and on
  offline startup.
- **Region `eu-west-1`** — the whole example (LSS config, provider, SDK clients) runs
  outside the default region, proving nothing is hardwired to it.
- **DynamoDB** — PK-only tables, composite key + GSI (`ByStatus`), a stream feeding
  the `onOrderStream` Lambda, seeds auto-loaded from `seeds/`. The Users table has
  deliberately **no TTL** (surfacing a UI warning); the Sessions table carries an
  `expiresAt` attribute so you can enable **TTL from the UI** (Settings tab).
- **SQS + DLQ redrive** — `enqueueOrder` sends to the queue, `processOrderQueue`
  consumes in batches (`ReportBatchItemFailures`) and persists orders with a computed
  `status`/`total`; poison orders (computed total ≤ 0) are re-received every 10s
  (short `VisibilityTimeout`) and redriven to `-OrderProcessingDLQ` after 3 receives —
  watch them pile up in the dashboard's Queues tab.
- **SNS** — stream handler publishes `order.*` events to a topic.
- **EventBridge custom bus + pattern rule + audit trail** — `processOrderQueue`
  (`order.processed`) and `purgeSessions` (`sessions.purged`) `PutEvents` onto the
  `ultimate-order-events` bus; the `auditEvents` rule (pattern filter on `source`)
  writes each matched event into the AuditTrail table, readable via `GET /audit`.
- **Schedule** — `purgeSessions` (`rate(2 minutes)`), provisioned as an EventBridge
  rule fired by LocalStack, purges expired sessions and leaves an audit entry.
- **S3 + Lambda notification** — uploads under `incoming/` trigger `onUpload`, which
  reads the object back and indexes it in the Orders table.
- **Seeds & persistence** — tables pre-filled from `seeds/`; `persistence: true`
  keeps data across `lss:stop`/`lss:start` cycles.
- **Dashboard branding** — per-theme brand tokens with a light default (see below).

## Prerequisites

- Docker
- Node.js ≥ 20
- A **LocalStack auth token**. Paid-tier images refuse to start without one. Grab a
  token at <https://app.localstack.cloud> → *Personal access tokens*. A free Hobby
  token is enough for the resources this example uses.

## Setup

```bash
cd examples/localstack-ultimate
npm install

# Drop your token into a local .env (gitignored). The npm scripts wrap commands
# with dotenv-cli so LOCALSTACK_AUTH_TOKEN reaches both LSS and serverless-offline.
cp .env.example .env
$EDITOR .env   # set LOCALSTACK_AUTH_TOKEN=ls-xxxxxxxx
```

## Ports used

| Concern | Port |
|---|---|
| LSS dashboard / API | `3111` |
| LocalStack (Pro image) | `4571` |
| serverless-offline HTTP | `3002` |
| serverless-offline Lambda invoke | `3003` |
| Validation console (`npm run console`) | `8621` |

These are all different from [`localstack-free`](../localstack-free/) (which uses
LSS `3120`, LocalStack `4572`, service APIs `3610`–`3612`) **and** from a default
external LocalStack on `4566`, so
you can run any combination at the same time without conflict — unless your external
LocalStack publishes the whole `4566–4599` range (a common install default), in which
case `4571` sits inside it and will collide.

## Run

```bash
# 1. Boot LSS — pulls localstack/localstack-pro:latest on first run.
npm run lss:start

# 2. Package + start serverless-offline. The plugin registers this service with
#    LSS (3111), which provisions every CloudFormation resource into the Pro
#    LocalStack on 4571 and wires the S3 -> onUpload notification, the
#    EventBridge bus/rules and the SQS event source mapping. In between, the
#    script applies the queue's RedrivePolicy via scripts/wire-dlq.js (LSS's
#    CloudFormation parser doesn't carry that attribute yet).
npm run offline
```

Dashboard: <http://localhost:3111>.

## Try the HTTP routes

The offline server binds to **port 3002** and prefixes routes with the stage (`/dev`):

```bash
curl http://localhost:3002/dev/health

# Create a user
curl -X POST http://localhost:3002/dev/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dora","email":"dora@example.com"}'

# Enqueue an order — the SQS consumer stores it and publishes order.processed
# onto the ultimate-order-events bus
curl -X POST http://localhost:3002/dev/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u-alice","items":[{"sku":"BOOK-02","price":42,"qty":1}]}'

# The auditEvents rule wrote it into the AuditTrail table (sessions.purged
# entries from the rate(2 minutes) schedule show up here too)
curl http://localhost:3002/dev/audit

# Poison order: computed total is 0, so processOrderQueue throws and reports
# the message as a batch item failure — after 3 receives (~30s at a 10s
# visibility timeout) SQS redrives it to localstack-ultimate-OrderProcessingDLQ
# (dashboard -> Queues tab).
curl -X POST http://localhost:3002/dev/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u-alice","items":[{"sku":"BROKEN","price":0,"qty":1}]}'

# Upload to S3 -> triggers the onUpload Lambda via bucket notification
curl -X POST http://localhost:3002/dev/uploads \
  -H 'Content-Type: application/json' \
  -d '{"filename":"hello.txt","content":"hello from ultimate"}'

curl http://localhost:3002/dev/uploads
```

## Validation console

`index.html` at the example root is a small browser console that pings every port and
runs the flows above end to end (create user → list, enqueue → verify the SQS consumer
wrote the order, order → audit trail via EventBridge, poison order → DLQ, schedule
observation, upload → verify the S3 notification fired). Open it directly from the
filesystem (`file://…/index.html`) or serve it:

```bash
npm run console   # http://localhost:8621
```

CORS is pre-wired for it: every `http` event declares `cors: true` (serverless-offline
answers the preflight) and every handler response carries
`Access-Control-Allow-Origin: *` via the shared `src/handlers/respond.js` helper.

## Dashboard branding

The example also showcases [dashboard branding](../../docs/CONFIGURATION.md#configuration-properties):
`lss.config.json` sets a custom title/subtitle, points `logo`/`favicon` at
`assets/logo.svg`, forces `defaultTheme: "light"`, and overrides the brand tokens
(`brand-primary`/`brand-hover`/`brand-soft`, plus `brand-contrast` in dark) **per
theme** with amber tones — the dashboard at `http://localhost:3111` opens light with an
amber accent. Each example in this folder uses a different branding mechanism, so
compare them to see what the dashboard supports.

## Reset

```bash
npm run lss:seed:clear   # empties seeded tables — prompts for confirmation
                         # (type "confirmar"); append -- --yes for
                         # non-interactive use
npm run lss:stop         # stops orchestrator + LocalStack Pro container
```

Persistence is on, so a `lss:stop` / `lss:start` cycle preserves data. To wipe
completely, also `docker volume rm lss-localstack-4571-data` (the `--rm` container is
removed automatically on stop).

## What's different from localstack-free

- `lss.config.json` -> `"localstackEdition": "pro"`, `serverPort: 3111`, `localstackPort: 4571`.
- Region is **`eu-west-1`** — each example runs in its own region (localstack-free:
  `sa-east-1`, self-hosted: `us-west-2`), so they also prove multi-region coherence
  side by side.
- Service name is `localstack-ultimate`, so resources live under a separate namespace
  (`localstack-ultimate-Users`, `localstack-ultimate-uploads`, etc.).
- All ports shifted to dodge the community example, so both can run side by side.
- `LOCALSTACK_AUTH_TOKEN` is **required**; without it the Pro image exits with code 55.
- The HTTP API is served by **serverless-offline** — the other examples route HTTP
  through the LSS gateway instead.
- Shape: this is a single service (one `serverless.yml`) owning its own EventBridge
  bus, while `localstack-free` is a four-service stack exercising authorizers and a
  **shared** bus across services.

Run both side by side when you want to confirm a behavior is or isn't gated behind a
paid plan.

## File map

```
serverless.yml                 ← REST routes + SQS/DLQ + streams + EventBridge bus,
                                  pattern rule, rate(2 minutes) schedule (eu-west-1)
lss.config.json                ← edition: pro, region eu-west-1, services incl.
                                  "events", ports 3111/4571, branding block
.env / .env.example            ← LOCALSTACK_AUTH_TOKEN (gitignored)
index.html                     ← validation console (file:// or npm run console)
assets/logo.svg                ← dashboard logo/favicon
scripts/wire-dlq.js            ← applies the RedrivePolicy to the live queue
src/handlers/                  ← HTTP + event handlers, shared respond.js CORS helper
seeds/                         ← localstack-ultimate-Users / -Orders / -Sessions seeds
```
