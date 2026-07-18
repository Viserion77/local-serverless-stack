# localstack-free

The single **LocalStack community (free)** example: five services that exercise **LSS's API + Lambda emulation** end to end — API Gateway proxy, per-service Lambda runtime workers, Lambda authorizers (local **and** cross-service), raw **CloudFormation API Gateway v2** topologies, a shared **EventBridge bus**, **DynamoDB streams → SNS**, and **S3 bucket notifications**. There is **no `serverless-offline` anywhere** and no `serverless deploy`: each service ships only the `serverless-lss` plugin, and LSS itself serves the HTTP APIs and the AWS Lambda Invoke API.

| Service | Language | API flavor | Authorizer | API port | Invoke port |
|---|---|---|---|---|---|
| `users-service` | TypeScript | HTTP API (payload **v2**) + **raw CFN** routes on its *own* framework `HttpApi` | local v2 **simple response** (×2) | `3610` | `13610` |
| `auth-service` | JavaScript | REST API (payload **v1**) | local v1 **REQUEST** (IAM policy) | `3611` | `13611` |
| `orders-service` | JavaScript | REST API (payload **v1**) | **cross-service** by ARN → auth-service | `3612` | `13612` |
| `gateway-stack` | — | **raw CFN** HTTP API v2 (`AWS::ApiGatewayV2::*`) — **no functions of its own** | **cross-stack** by ARN → users-service | `3613` | `13613` |
| `events-stack` | — | **resources-only** — owns the `domain-events` bus (+ an Archive, which LSS skips with a warning). No functions, no ports. | — | — | — |

## What this exercises

- **Authorizers, three flavors** — a local v1 REQUEST authorizer (IAM policy) in `auth-service`, a local v2 simple-response authorizer in `users-service`, and a **cross-service** authorizer in `orders-service` that references auth-service's Lambda **by ARN** (LSS resolves it against its global function registry).
- **TypeScript from source** — `users-service` handlers are `.ts` files run through `esbuild-register` (`lambdaRuntime.execution: "source"`), no build script.
- **Hot reload** — `lambdaRuntime.watch: true`; edit a handler and re-curl.
- **SQS consumer** — `orders-OrderQueue` with a Lambda consumer (`processOrderQueue`), running without serverless-offline.
- **Schedule** — `cleanupExpiredOrders` (`rate(1 hour)`), provisioned as an EventBridge rule that fires on schedule (`"events"` is enabled in `lss.config.json`); the function is also invocable via the Invoke API — every Lambda is, even without API events.
- **Raw `AWS::ApiGatewayV2::*` routes, cross-stack** — `gateway-stack` has **no `functions:` block and no `httpApi:` event at all**. It declares an `::Api` + `::Route` + `::Integration` + `::Authorizer` (plus the `AWS::Lambda::Permission` invoke grant) directly under `resources:`, all pointing at **users-service's** Lambdas by ARN. LSS parses those resource types, reduces `IntegrationUri`/`AuthorizerUri` (literal ARN, `Fn::GetAtt`, `Fn::Sub`, `Fn::ImportValue`, `Fn::Join`) to concrete ARNs, and registers them into the *same* route registry the `httpApi:` events feed — resolving the cross-stack target through the global function registry at request time, so **registration order does not matter**. A raw `::Route` that mirrors an existing `httpApi:` event is de-duplicated (the state route wins), which is why registering `users-service` yields its three `httpApi:` routes once, not twice. There is **no `/api/{proxy+}` or `$default` catch-all anywhere** in this example.
- **Raw `AWS::ApiGatewayV2::*` routes on the framework's OWN `HttpApi`** — the *other* half of the raw story, and the shape a real `serverless.yml` produces far more often than a dedicated gateway stack: `users-service` keeps its normal `httpApi:` events **and** hand-writes `GET`/`POST /api/identity/spaces` under `resources:`, with `ApiId: !Ref HttpApi` (no second `::Api`). Every reference uses the `!Sub` idiom the Serverless Framework passes straight through into the compiled template — `Target: !Sub 'integrations/${SpacesIntegration}'`, an `AuthorizerUri`/`IntegrationUri` that is the API Gateway **invocation-URI wrapper** (`arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${LogicalId.Arn}/invocations`, *not* a bare Lambda ARN), `FunctionName: !Ref ListUsersLambdaFunction` (which CloudFormation resolves to a **name**, never an ARN) and `SourceArn: !Sub '…:${HttpApi}/*'`. Because that one template carries both the framework's compiled `::Route` mirrors and the genuinely-raw routes, it is also where the `(METHOD, path)` de-dup earns its keep.
- **`AWS::Lambda::Permission` as an advisory grant** — present, its `SourceArn` is recorded on the route; absent, the route still registers and LSS logs one warning naming the ungranted function (in AWS the call would 500, but locally the in-process runtime performs the invoke).
- **`AWS::Events::EventBus` in `resources:`** — registering `events-stack` (just `sls package`, never `deploy`) creates the `domain-events` bus in LocalStack. A service with zero functions and no ports registers fine.
- **`AWS::Events::Archive`** — accepted and skipped with a registration warning (LocalStack mocks Archives: CFN says `CREATE_COMPLETE`, `ListArchives` stays empty).
- **`events: eventBridge` trigger + pattern filtering** — `users-service`'s `createUser` publishes `UserSignedUp` (`source: users`) with a plain SDK `PutEvents`; `auth-service`'s `onUserSignedUp` rule (pattern `source: users`, `detail-type: UserSignedUp`) stores each event in `auth-SignupAudit`. Events with a non-matching source/detail-type are not delivered.
- **Real event envelope** — the EventBridge target receives the event exactly as AWS delivers it (`source`, `detail-type`, `detail`), *not* wrapped in `Records`.
- **DynamoDB stream → SNS** — `orders-Orders` streams `NEW_AND_OLD_IMAGES`; `onOrderStream` publishes every INSERT/MODIFY/REMOVE as an `order.*` message to the `orders-OrderEvents` SNS topic.
- **S3 bucket notification** — `POST /uploads` writes to `s3://orders-uploads/incoming/`; the bucket's `NotificationConfiguration` fires `onUpload`, which indexes the object back into `orders-Orders`.
- **Seeds** — `auth-Sessions`, `users-Users`, and `orders-Orders` are seeded from `./seeds` (a ready-made session `code-admin` included).
- **Dashboard branding** — see [Branding](#branding) below.

> **Ports used by this example** — LSS server `3120`, LocalStack `4572`, service APIs `3610`–`3613`, Lambda invoke `13610`–`13613`, validation console `8620`. The non-default LocalStack port keeps this example out of the way of an external LocalStack you might have on `4566`, and clear of the other examples in this repo. (Caveat: a real LocalStack install commonly publishes the whole `4566–4599` range — in that case `4572` will still conflict.)

## Prerequisites

- Docker (LocalStack **community** runs in a container managed by LSS — no pro features needed)
- Node.js ≥ 20

## Run

```bash
cd examples/localstack-free

# Install the four services' dependencies
npm run setup

# (Optional) LocalStack auth token — community images from 2026.5 onward
# prompt for one even in free mode:
cp .env.example .env   # then fill LOCALSTACK_AUTH_TOKEN in your editor

# 1. Start LSS (boots LocalStack via Docker; first run pulls the image, ~30s).
npm run lss:start

# 2. Register all four services. `serverless package` triggers the LSS plugin,
#    which POSTs the service to the orchestrator: resources are provisioned in
#    LocalStack, routes + authorizers are registered, a runtime worker starts,
#    and the API/invoke listeners bind on the ports above. events-stack goes
#    FIRST so the domain-events bus exists before auth-service's rule lands.
npm run register:all
```

Open the dashboard at <http://localhost:3120> — **Services** lists all four, with their routes, authorizers, declared resources, and listener status.

## Curl walkthrough

**1. Log in against auth-service** (public route) — password is `lss-demo`:

```bash
curl -X POST http://localhost:3611/login \
  -H 'Content-Type: application/json' \
  -d '{"user":"jane","password":"lss-demo"}'
# → 201 {"code":"code-jane"}
```

Or skip this step: the seed in `seeds/auth-Sessions.json` ships a ready-made session `code-admin`.

**2. Call a v1-protected route** — the local REQUEST authorizer looks the `code` header up in DynamoDB and allows/denies with an IAM policy:

```bash
curl http://localhost:3611/whoami -H 'code: code-admin'
# → 200 {"user":"admin"}

curl http://localhost:3611/whoami -H 'code: nope'
# → 403 (Deny policy)
```

**3. Create a user and watch EventBridge deliver it cross-service** — `createUser` (TypeScript, HTTP API v2) writes to DynamoDB and publishes `UserSignedUp` onto the shared `domain-events` bus; auth-service's `eventBridge`-triggered `onUserSignedUp` stores the real envelope in `auth-SignupAudit`:

```bash
curl -X POST http://localhost:3610/users \
  -H 'Authorization: Bearer lss-secret' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dora","email":"dora@example.com"}'
# → 201 {"id":"...","name":"Dora",...}

# First delivery cold-starts the proxy Lambda in LocalStack — give it ~10s:
curl http://localhost:3611/signups
# → 200 {"count":1,"signups":[{"eventId":"...","source":"users","detailType":"UserSignedUp","detail":{"userId":"..."}}]}
```

`GET /users` and `GET /users/{id}` work the same way (`Authorization: Bearer lss-secret`).

**3b. A raw CloudFormation route on the service's OWN framework `HttpApi`** — `users-service` declares `GET`/`POST /api/identity/spaces` under `resources:` with `ApiId: !Ref HttpApi`, `Target: !Sub 'integrations/${SpacesIntegration}'` and an `AuthorizerUri`/`IntegrationUri` in the API Gateway *invocation-URI* form. No second `::Api`, no `httpApi:` event — yet they are served on the same port as the compiled routes, behind their own raw authorizer:

```bash
curl http://localhost:3610/api/identity/spaces -H 'authorization: Bearer lss-secret'
# → 200 {"items":[...]}   (the raw route lands on listUsers)

curl -i http://localhost:3610/api/identity/spaces
# → 401 (identity source header absent — the raw ::Authorizer is enforced)
```

`GET /users` is still registered **once**: the framework compiles a mirror `::Route` for every `httpApi:` event into the very same template, and LSS de-duplicates it by `(METHOD, normalized path)` in favor of the serverless-state route.

**3c. A raw cross-stack CloudFormation route** — `gateway-stack` owns **no Lambdas**. Its `GET /gw/users` exists only as an `AWS::ApiGatewayV2::Route` under `resources:`, wired by ARN to users-service's `listUsers`, and guarded by an `AWS::ApiGatewayV2::Authorizer` pointing at users-service's v2 authorizer. LSS resolves both across the stack boundary at request time:

```bash
# Same body as :3610/users — but served by the gateway stack's raw route,
# invoking a Lambda that belongs to another service entirely.
curl http://localhost:3613/gw/users -H 'authorization: Bearer lss-secret'
# → 200 {"items":[...]}

# The cross-stack authorizer is enforced, not bypassed:
curl -i http://localhost:3613/gw/users
# → 401 (identity source header absent — authorizer never invoked, as in AWS)
curl -i http://localhost:3613/gw/users -H 'authorization: Bearer wrong'
# → 403 (authorizer returned {isAuthorized:false})
```

Confirm the topology resolved on its own — the route reports the cross-service `functionArn`, and nothing anywhere falls back to a catch-all:

```bash
curl -s http://localhost:3120/api/apis | grep -o '"path":"[^"]*"' | sort -u
# → …"path":"/gw/users"… and NO "/api/{proxy+}" and NO "$default"
```

**4. Cross-service authorizer + SQS + stream → SNS** — `orders-service` declares its authorizer by **ARN**; the Lambda behind it lives in `auth-service`. The order flows through SQS → `processOrderQueue` → DynamoDB, and the table's stream fans the write out to the `orders-OrderEvents` SNS topic via `onOrderStream`:

```bash
curl -X POST http://localhost:3612/orders \
  -H 'Content-Type: application/json' \
  -H 'code: code-admin' \
  -d '{"item":"coffee"}'
# → 202 {"queued":true,"id":"..."}

curl http://localhost:3612/orders -H 'code: code-admin'
# → 200 {"count":4,"items":[...,{"item":"coffee","user":"admin","status":"processed",...}]}
```

**5. S3 notification round-trip** — `POST /uploads` puts the payload under `incoming/` in `orders-uploads`; the bucket notification fires `onUpload`, which reads the object back and indexes it into `orders-Orders` (status `uploaded`):

```bash
curl -X POST http://localhost:3612/uploads \
  -H 'Content-Type: application/json' \
  -d '{"filename":"hello.txt","content":"hello LSS"}'
# → 201 {"uploaded":true,"bucket":"orders-uploads","key":"incoming/hello.txt"}

curl http://localhost:3612/uploads
# → 200 {"bucket":"orders-uploads","count":1,"objects":[{"key":"incoming/hello.txt",...}]}

# ~10s later the indexed row appears:
curl http://localhost:3612/orders -H 'code: code-admin'
# → ...{"id":"upload:orders-uploads/incoming/hello.txt","status":"uploaded",...}
```

**6. Invoke any Lambda directly** — every function is reachable through the AWS Lambda Invoke API on the service's invoke port, even ones with no API event (like the scheduled `cleanupExpiredOrders`):

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws lambda invoke \
  --endpoint-url http://localhost:13612 \
  --region sa-east-1 \
  --function-name orders-service-dev-cleanupExpiredOrders \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' /dev/stdout
# → {"scanned":4,"deleted":0}
```

Short names work too (`--function-name cleanupExpiredOrders`), and the same API is what SDK-based tests (or the programmatic `LssClient`) hit.

## Validation console

A one-page console at [`index.html`](./index.html) runs every flow above from the browser — status dots for each port, one-click request chains (login → whoami, create user → signup audit, order → SQS, upload → S3 notification), editable request bodies, and a request log.

```bash
npm run console   # serves it on http://localhost:8620
```

…or just open `index.html` straight from the file system (`file://` works — the LSS gateway answers CORS preflights itself for routes declared with `cors: true`).

## Branding

The example also showcases [dashboard branding](../../docs/CONFIGURATION.md#configuration-properties): `lss.config.json` sets a custom `title`/`subtitle`, points `logo`/`favicon` at [`assets/logo.svg`](./assets/logo.svg), defaults the UI to the **dark** theme, and overrides the TreeUI brand tokens (`brand-primary`/`brand-hover`/`brand-soft`) with purple tones — so the dashboard at `http://localhost:3120` opens with this example's identity. Each example in this repo uses a different branding mechanism; this one is the simple top-level `colors` form.

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
                                    lambdaRuntime {execution: source, watch: true}, branding
index.html                       ← validation console (npm run console → :8620)
assets/logo.svg                  ← dashboard logo/favicon (referenced from lss.config.json)
seeds/
  auth-Sessions.json             ← seeded session code-admin (name must match table)
  users-Users.json               ← two seeded users
  orders-Orders.json             ← three seeded orders (writes also flow through the stream)
events-stack/                    ← resources-only: domain-events bus + Archive (skipped)
  serverless.yml
gateway-stack/                   ← raw CFN HTTP API v2, no functions, ports 3613/13613
  serverless.yml                 ← ::Api + ::Route + ::Integration + ::Authorizer
                                    + Lambda::Permission, all targeting users-service
                                    Lambdas by cross-stack ARN. No httpApi: event.
auth-service/                    ← JS, REST v1, ports 3611/13611
  serverless.yml                 ← + eventBridge rule on the shared bus (by ARN)
  src/handlers/
    aws.js                       ← shared AWS SDK clients (point at LocalStack)
    login.js                     ← POST /login (public) → writes session
    session-authorizer.js        ← v1 REQUEST authorizer (IAM policy), no events;
                                    used locally by whoami and by ARN from orders
    whoami.js                    ← GET /whoami (protected)
    onUserSignedUp.js            ← eventBridge target → auth-SignupAudit
    listSignups.js               ← GET /signups (public) → lists the audit table
users-service/                   ← TS, HTTP API v2, ports 3610/13610
  serverless.yml                 ← provider.httpApi.authorizers (simple responses)
  tsconfig.json                  ← noEmit; LSS runs .ts from source
  src/handlers/
    aws.ts                       ← + EventBridge client
    session-authorizer-v2.ts     ← {isAuthorized, context}
    listUsers.ts                 ← bare-object return (v2 inferred response)
    createUser.ts                ← explicit {statusCode: 201} + PutEvents UserSignedUp
    getUser.ts                   ← path parameters
orders-service/                  ← JS, REST v1, ports 3612/13612
  serverless.yml                 ← cross-service authorizer by ARN + SQS + schedule
                                    + stream + SNS topic + S3 bucket notification
  src/handlers/
    aws.js                       ← + SNS and S3 clients
    createOrder.js               ← POST /orders → SQS
    listOrders.js                ← GET /orders
    processOrderQueue.js         ← SQS consumer → DynamoDB (status: processed)
    cleanupExpiredOrders.js      ← schedule rate(1 hour); invoke on 13612
    onOrderStream.js             ← DynamoDB stream → SNS orders-OrderEvents
    uploadFile.js                ← POST /uploads → s3://orders-uploads/incoming/
    listUploads.js               ← GET /uploads
    onUpload.js                  ← S3 notification target → indexes into orders-Orders
```
