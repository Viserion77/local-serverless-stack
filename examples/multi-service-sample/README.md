# multi-service-sample

Three microservices that exercise **LSS's API + Lambda emulation** end to end — API Gateway proxy, per-service Lambda runtime workers, and Lambda authorizers (local **and** cross-service). There is **no `serverless-offline` anywhere** in this example: each service ships only the `serverless-lss` plugin, and LSS itself serves the HTTP APIs and the AWS Lambda Invoke API.

| Service | Language | API flavor | Authorizer | API port | Invoke port |
|---|---|---|---|---|---|
| `users-service` | TypeScript | HTTP API (payload **v2**) | local v2 **simple response** | `3010` | `13010` |
| `auth-service` | JavaScript | REST API (payload **v1**) | local v1 **REQUEST** (IAM policy) | `3011` | `13011` |
| `orders-service` | JavaScript | REST API (payload **v1**) | **cross-service** by ARN → auth-service | `3012` | `13012` |

Other moving parts:

- **DynamoDB** — `auth-Sessions`, `users-Users`, `orders-Orders` (provisioned in community LocalStack, seeded from `./seeds`)
- **SQS** — `orders-OrderQueue` with a Lambda consumer (`processOrderQueue`), running without serverless-offline
- **Schedule** — `cleanupExpiredOrders` (`rate(1 hour)`), provisioned as an EventBridge rule that fires on schedule (`"events"` is enabled in `lss.config.json`; the self engine ships a native scheduler); the function is also invocable via the Invoke API — every Lambda is, even without API events
- **TypeScript from source** — `users-service` handlers are `.ts` files run through `esbuild-register` (`lambdaRuntime.execution: "source"`), no build script
- **Hot reload** — `lambdaRuntime.watch: true`; edit a handler and re-curl

> **Ports used by this example** — LSS server `3120`, LocalStack `4572`, service APIs `3010`–`3012`, Lambda invoke `13010`–`13012`. The non-default LocalStack port keeps this example out of the way of an external LocalStack you might have on `4566`, and clear of the other examples in this repo. (Caveat: a real LocalStack install commonly publishes the whole `4566–4599` range — in that case `4572` will still conflict.)

## Prerequisites

- Docker (LocalStack **community** runs in a container managed by LSS — no pro features needed)
- Node.js ≥ 20

## Run

```bash
cd examples/multi-service-sample

# Install the three services' dependencies
npm run setup

# (Optional) LocalStack auth token — community images from 2026.5 onward
# prompt for one even in free mode:
cp .env.example .env   # then fill LOCALSTACK_AUTH_TOKEN in your editor

# 1. Start LSS (boots LocalStack via Docker; first run pulls the image, ~30s).
npm run lss:start

# 2. Register all three services. `serverless package` triggers the LSS plugin,
#    which POSTs the service to the orchestrator: resources are provisioned in
#    LocalStack, routes + authorizers are registered, a runtime worker starts,
#    and the API/invoke listeners bind on the ports above.
npm run register:all
```

Open the dashboard at <http://localhost:3120> — **Services** lists all three, with their routes, authorizers, and listener status.

## Curl walkthrough

**1. Log in against auth-service** (public route) — password is `lss-demo`:

```bash
curl -X POST http://localhost:3011/login \
  -H 'Content-Type: application/json' \
  -d '{"user":"jane","password":"lss-demo"}'
# → 201 {"code":"code-jane"}
```

Or skip this step: the seed in `seeds/auth-Sessions.json` ships a ready-made session `code-admin`.

**2. Call a v1-protected route** — the local REQUEST authorizer looks the `code` header up in DynamoDB and allows/denies with an IAM policy:

```bash
curl http://localhost:3011/whoami -H 'code: code-admin'
# → 200 {"user":"admin"}

curl http://localhost:3011/whoami -H 'code: nope'
# → 403 (Deny policy)
```

**3. Call the TypeScript HTTP API (payload v2)** — the v2 authorizer uses *simple responses* (`{isAuthorized, context}`), and `listUsers` returns a bare object that v2 infers into a 200 JSON response:

```bash
curl http://localhost:3010/users -H 'Authorization: Bearer lss-secret'
# → 200 {"items":[...]}   (two seeded users)

curl -X POST http://localhost:3010/users \
  -H 'Authorization: Bearer lss-secret' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dora","email":"dora@example.com"}'
# → 201 {"id":"...","name":"Dora",...}

curl http://localhost:3010/users/u-ada -H 'Authorization: Bearer lss-secret'
# → 200 (path parameters, v2)
```

**4. Cross-service authorizer + SQS** — `orders-service` declares its authorizer by **ARN**; the Lambda behind it lives in `auth-service`. LSS resolves the ARN against its global function registry, so the same session code works here:

```bash
curl -X POST http://localhost:3012/orders \
  -H 'Content-Type: application/json' \
  -H 'code: code-admin' \
  -d '{"item":"coffee"}'
# → 202 {"queued":true,"id":"..."}
```

The order flows through SQS → `processOrderQueue` → DynamoDB. A moment later:

```bash
curl http://localhost:3012/orders -H 'code: code-admin'
# → 200 {"count":1,"items":[{"id":"...","item":"coffee","user":"admin","status":"processed",...}]}
```

**5. Invoke any Lambda directly** — every function is reachable through the AWS Lambda Invoke API on the service's invoke port, even ones with no API event (like the scheduled `cleanupExpiredOrders`, which also fires on its own via its EventBridge schedule rule):

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws lambda invoke \
  --endpoint-url http://localhost:13012 \
  --region us-east-1 \
  --function-name orders-service-dev-cleanupExpiredOrders \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' /dev/stdout
# → {"scanned":1,"deleted":0}
```

Short names work too (`--function-name cleanupExpiredOrders`), and the same API is what SDK-based tests (or the programmatic `LssClient`) hit.

## Hot reload

`lambdaRuntime.watch` is on. Change a handler — say, make `whoami.js` also return a timestamp — save, and re-run the curl. The runtime worker reloads the module from source (TypeScript included, via `esbuild-register`); no re-register, no restart.

## Reset

```bash
npm run lss:seed    # re-apply seed fixtures
npm run lss:stop    # stops orchestrator + LocalStack (persistence is off)
```

## File map

```
lss.config.json                  ← LSS config: managed community LocalStack on 4572,
                                    lambdaRuntime {execution: source, watch: true}
seeds/
  auth-Sessions.json             ← seeded session code-admin (name must match table)
  users-Users.json               ← two seeded users
auth-service/                    ← JS, REST v1, ports 3011/13011
  serverless.yml
  src/handlers/
    aws.js                       ← shared AWS SDK clients (point at LocalStack)
    login.js                     ← POST /login (public) → writes session
    session-authorizer.js        ← v1 REQUEST authorizer (IAM policy), no events;
                                    used locally by whoami and by ARN from orders
    whoami.js                    ← GET /whoami (protected)
users-service/                   ← TS, HTTP API v2, ports 3010/13010
  serverless.yml                 ← provider.httpApi.authorizers (simple responses)
  tsconfig.json                  ← noEmit; LSS runs .ts from source
  src/handlers/
    aws.ts
    session-authorizer-v2.ts     ← {isAuthorized, context}
    listUsers.ts                 ← bare-object return (v2 inferred response)
    createUser.ts                ← explicit {statusCode: 201, body}
    getUser.ts                   ← path parameters
orders-service/                  ← JS, REST v1, ports 3012/13012
  serverless.yml                 ← cross-service authorizer by ARN + SQS + schedule
  src/handlers/
    aws.js
    createOrder.js               ← POST /orders → SQS
    listOrders.js                ← GET /orders
    processOrderQueue.js         ← SQS consumer → DynamoDB (status: processed)
    cleanupExpiredOrders.js      ← schedule rate(1 hour); invoke on 13012
```
