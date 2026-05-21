# pro-sample-microservice

Same end-to-end test rig as [`sample-microservice`](../sample-microservice/), but pointed at the **LocalStack Pro** image (`localstack/localstack-pro:latest`) and isolated on its own ports so both examples can run side by side.

It exercises the same surface — DynamoDB (PK/SK, GSI, streams), SQS, SNS, S3 with Lambda notifications, and HTTP handlers — only on top of Pro.

## Prerequisites

- Docker
- Node.js ≥ 18
- A **LocalStack auth token**. Pro images refuse to start without one. Grab a token at <https://app.localstack.cloud> → *Personal access tokens*. A free Hobby token is enough for the resources this example uses.

## Setup

```bash
cd examples/pro-sample-microservice
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
| LocalStack | `4571` |
| serverless-offline HTTP | `3010` |
| serverless-offline Lambda invoke | `3011` |

These are all different from `sample-microservice` (which uses `3110 / 4570 / 3000 / 3001`) **and** from a default external LocalStack on `4566`, so you can run any combination at the same time without conflict.

## Run

```bash
# 1. Boot LSS — pulls localstack/localstack-pro:latest on first run.
npm run lss:start

# 2. Package + start serverless-offline. The plugin registers this service with
#    LSS (3111), which provisions every CloudFormation resource into the Pro
#    LocalStack on 4571 and wires the S3 -> onUpload notification.
npm run offline
```

Dashboard: <http://localhost:3111>.

## Try the HTTP routes

The offline server binds to **port 3010** here (not 3000):

```bash
curl http://localhost:3010/dev/health

# Create a user
curl -X POST http://localhost:3010/dev/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dora","email":"dora@example.com"}'

# Enqueue an order
curl -X POST http://localhost:3010/dev/orders \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u-alice","items":[{"sku":"BOOK-02","price":42,"qty":1}]}'

# Upload to S3 -> triggers the onUpload Lambda via bucket notification
curl -X POST http://localhost:3010/dev/uploads \
  -H 'Content-Type: application/json' \
  -d '{"filename":"hello.txt","content":"hello from pro"}'

curl http://localhost:3010/dev/uploads
```

## Reset

```bash
npm run lss:seed:clear   # empties seeded tables
npm run lss:stop         # stops orchestrator + LocalStack Pro container
```

Persistence is on, so a `lss:stop` / `lss:start` cycle preserves data. To wipe completely, also `docker rm -f` the Pro container that LSS launched.

## What's different from sample-microservice

- `lss.config.json` -> `"localstackEdition": "pro"`, `serverPort: 3111`, `localstackPort: 4571`.
- Service name is `pro-sample-microservice`, so resources live under a separate namespace (`pro-sample-microservice-Users`, `pro-sample-microservice-uploads`, etc.).
- All offline + LocalStack URLs shifted to dodge the community example.
- `LOCALSTACK_AUTH_TOKEN` is **required**; without it the Pro image exits with code 55.

Everything else (handlers, seeds, CloudFormation shape) is identical to `sample-microservice`. Use it as a side-by-side baseline when you want to confirm a behavior is or isn't gated behind Pro.

## File map

```
serverless.yml                 ← service name + Pro-specific URLs
lss.config.json                ← edition: pro, ports 3111/4571
.env / .env.example            ← LOCALSTACK_AUTH_TOKEN (gitignored)
src/handlers/                  ← identical to sample-microservice
seeds/                         ← identical
```
