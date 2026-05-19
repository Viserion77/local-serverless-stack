# sample-microservice

End-to-end test rig for **Local Serverless Stack (LSS)**. Exercises every integration LSS supports so you can poke at the dashboard with real data:

- **DynamoDB** — three tables to cover the common shapes:
  - `sample-microservice-Users` — partition key only, no TTL → surfaces the **"TTL not configured"** warning in the UI
  - `sample-microservice-Sessions` — partition key only, intended for TTL (enable from the **Settings** tab)
  - `sample-microservice-Orders` — composite key (`userId` + `orderId`), a **GSI** on `status`, and a **DynamoDB Stream** (NEW_AND_OLD_IMAGES)
- **SQS** — `sample-microservice-OrderProcessing` queue with a Lambda consumer (`processOrderQueue`)
- **SNS** — `sample-microservice-OrderEvents` topic, published to from the stream consumer
- **Lambda event sources**:
  - HTTP routes via `serverless-offline`
  - SQS → Lambda (provisioned in LocalStack, proxied back to `serverless-offline` by LSS)
  - DynamoDB Stream → Lambda (same proxying)

## Prerequisites

- Docker (LocalStack runs in a container managed by LSS)
- Node.js ≥ 18

> **Heads up — PID file is global.** The LSS PID file lives at `/tmp/lss-orchestrator.pid` and is shared across all working directories, while `lss.config.json` is read from the *current* directory. If you already have an orchestrator running started from a different folder (e.g. the repo root), `npm run lss:start` from here will see the existing PID, report the **wrong** port (the example's config) but the real orchestrator will still be on the other folder's port. Always `npm run lss:stop` first so this example can boot a fresh orchestrator on **3100 / 4566**.

> **Heads up — `serverless offline` does not write the CF template.** The LSS plugin reads `.serverless/cloudformation-template-update-stack.json` to discover resources, but `serverless offline start` packages in memory and skips the disk write. The `offline` script in this example chains `serverless package` first so the template is materialized before the orchestrator hook fires.

## Run

```bash
cd examples/sample-microservice
npm install

# 1. Start LSS (boots LocalStack via Docker; first run pulls the image, ~30s).
npm run lss:start

# 2. Start serverless-offline. The LSS plugin registers this service with the
#    orchestrator, which parses serverless.yml and provisions the resources
#    (tables / queue / topic) in LocalStack. Stream + queue consumers wire up
#    Lambda proxies back to serverless-offline automatically.
npm run offline
```

LSS auto-seeds DynamoDB tables when they are created if a matching JSON file exists in `./seeds`. The Users and Orders tables ship seeded; Sessions starts empty.

Open the dashboard at <http://localhost:3100>:

- **Overview** → counts of every resource type
- **Services** → this microservice + its routes
- **Queues** → live SQS metrics + per-consumer view
- **DynamoDB** → table list with the TTL warning on Users; click a table for **Items** (scan / query / CRUD), **Indexes**, and **Settings**
- **Seeds** → re-apply or clear the bundled fixtures

## Try the HTTP routes

```bash
curl http://localhost:3000/dev/health

# Create a user
curl -X POST http://localhost:3000/dev/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dora","email":"dora@example.com"}'

# List all users
curl http://localhost:3000/dev/users

# Enqueue an order — this goes through SQS → Lambda consumer → DynamoDB write
# → DynamoDB stream → Lambda consumer → SNS publish, exercising the entire chain.
curl -X POST http://localhost:3000/dev/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u-alice","items":[{"sku":"BOOK-02","price":42,"qty":1}]}'
```

After enqueueing an order: watch the **Queues** tab (queue depth ticks up then back to zero), then refresh the **DynamoDB** → **Orders** → **Items** view and you should see the new row.

## Things to play with in the UI

- **DynamoDB tab**
  - Open **Orders**, switch to **Query** mode, set a key condition `userId = u-alice`, run it.
  - Switch to **Scan** with a filter `status = CONFIRMED` (auto-typed to string).
  - Use the index dropdown to query `ByStatus` instead of the table.
  - Click **View** / **Edit** / **Delete** on a row.
  - In **Settings**, enable TTL on **Sessions** with attribute `expiresAt`. Confirm the warning disappears on the table list.
- **Seeds tab**
  - Click **Clear** on `sample-microservice-Users`, then **Apply** to re-seed.
- **Queues tab**
  - Send several `/orders` requests in a row to build a small backlog before the consumer drains it.

## Reset

```bash
npm run lss:seed:clear   # empties tables that have a seed file
npm run lss:stop         # stops orchestrator + LocalStack
```

LocalStack persistence is on, so a `lss:stop` / `lss:start` cycle preserves data. To wipe state completely, also `docker rm -f localstack-main` (or whatever container name your LocalStack instance uses).

## File map

```
serverless.yml                 ← all resources + Lambda wiring
src/handlers/
  aws.js                       ← shared AWS SDK clients (point at LocalStack)
  health.js                    ← GET /health
  createUser.js                ← POST /users
  listUsers.js                 ← GET /users
  enqueueOrder.js              ← POST /orders → SQS
  processOrderQueue.js         ← SQS consumer → DynamoDB
  onOrderStream.js             ← DynamoDB stream consumer → SNS
seeds/                         ← auto-applied when tables are created
lss.config.json                ← LSS config local to this example
```
