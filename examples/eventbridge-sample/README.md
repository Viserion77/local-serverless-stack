# eventbridge-sample

A shared **EventBridge bus** covered 100% by LSS — including the piece that used to force a real `serverless deploy` (CloudFormation): the infra stack that owns the bus.

| Service | Role | API port | Invoke port |
|---|---|---|---|
| `events-stack` | **resources-only** — owns the `domain-events` bus (+ an Archive, which LSS skips with a warning). No functions, no ports. | — | — |
| `producer-service` | `POST /signups` publishes `UserSignedUp` to the bus with a plain SDK `PutEvents`. | `3621` | `13621` |
| `consumer-service` | `eventBridge`-triggered Lambda (pattern `source: producer`, `detail-type: UserSignedUp`) stores each event in DynamoDB; `GET /events` lists them. | `3622` | `13622` |

What this exercises, end to end:

- **`AWS::Events::EventBus` in `resources:`** — registering `events-stack` (just `sls package`, never `deploy`) creates the bus in LocalStack. A service with zero functions and no ports registers fine.
- **`AWS::Events::Archive`** — accepted and skipped with a registration warning (LocalStack mocks Archives: CFN says `CREATE_COMPLETE`, `ListArchives` stays empty).
- **`events: eventBridge` trigger** — Serverless compiles it to a native `AWS::Events::Rule`; LSS puts the rule on the shared bus (referenced **by ARN**, so no second bus gets created) and wires the target through its proxy → Invoke API model.
- **Real event shape** — the consumer handler receives the event exactly as AWS delivers it (`source`, `detail-type`, `detail`), *not* wrapped in `Records`.
- **Pattern filtering** — events with a non-matching `source`/`detail-type` are not delivered.

> **Ports** — LSS server `3130`, LocalStack `14566`, service APIs `3621`–`3622`, invoke `13621`–`13622`. LocalStack deliberately sits **outside the standard 4566–4599 range**: a real LocalStack (e.g. from another project's docker-compose) usually publishes that whole range, and on Docker Desktop/WSL2 setups `localhost` connections can silently land on it instead of this example's container.

## Prerequisites

- Docker (LocalStack **community**, managed by LSS)
- Node.js ≥ 20

## Run

```bash
cd examples/eventbridge-sample

# Install the three services' dependencies
npm run setup

# (Optional) LocalStack auth token — community images from 2026.5 onward
# prompt for one even in free mode:
cp .env.example .env   # then fill LOCALSTACK_AUTH_TOKEN in your editor

# 1. Start LSS (boots LocalStack via Docker)
npm run lss:start

# 2. Register all three services — each runs `serverless package`; the
#    serverless-lss plugin POSTs the service to the orchestrator. No deploy.
npm run register:all

# 3. Publish a signup through the producer
curl -s -X POST http://localhost:3621/signups \
  -H 'content-type: application/json' \
  -d '{"userId":"u-100","email":"ana@example.com"}'
# → {"published":true,"eventId":"..."}

# 4. Watch it arrive at the consumer (first delivery cold-starts the proxy
#    Lambda in LocalStack — give it ~10s)
curl -s http://localhost:3622/events
# → {"count":1,"events":[{"detailType":"UserSignedUp","detail":{"userId":"u-100",...}}]}

# Done?
npm run lss:stop
```

## How the delivery works

```
POST /signups (3621)                                # LSS API gateway → producer worker
  └─ PutEvents → domain-events bus                  # LocalStack EventBridge
       └─ rule consumer-service-dev-onUserSignedUp-rule-1 (pattern match)
            └─ target: proxy Lambda in LocalStack
                 └─ POST host.docker.internal:13622 # LSS Invoke API
                      └─ onUserSignedUp handler (consumer worker) → DynamoDB
```

The dashboard at http://localhost:3130 shows the bus and the rule under each service's *Declared resources*, and the consumer's invocations under **Lambdas**.
