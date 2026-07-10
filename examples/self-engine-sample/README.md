# self-engine-sample

Three microservices running **entirely on the LSS self engine** — DynamoDB, SQS, S3 and
EventBridge emulated in-process by the orchestrator. **No Docker. No LocalStack. No auth
token.** The engine boots in milliseconds and serves the real AWS wire protocols, so the
services below use plain `@aws-sdk` v3 clients pointed at `http://localhost:14566`.

| Service | Role | API port | Invoke port |
|---|---|---|---|
| `orders-service` | `POST /orders` stores the order in DynamoDB and enqueues it on SQS; `GET /orders` lists them. Owns the `orders-Orders` table and the `orders-to-process` queue. | `3031` | `13031` |
| `billing-service` | SQS consumer (cross-service ESM **by ARN**) writes a receipt to S3 and publishes `OrderBilled` to the `billing-events` bus; `GET /receipts` lists receipts. Owns the bucket and the bus. | `3032` | `13032` |
| `notifications-service` | EventBridge rule (`source: billing`, `detail-type: OrderBilled`) stores a notification in DynamoDB; `GET /notifications` lists them. | `3033` | `13033` |

The pipeline, end to end:

```
POST /orders (3031)
  → DynamoDB orders-Orders + SQS orders-to-process        [orders-service]
  → in-process ESM delivery → S3 receipt + PutEvents      [billing-service]
  → rule match on billing-events → DynamoDB notification  [notifications-service]
  → GET /notifications (3033) shows the result
```

What this exercises on the self engine:

- **DynamoDB** — two tables created from `resources:`, document-client reads/writes,
  auto-seed on table creation (`seeds/orders-Orders.json`).
- **SQS** — queue from `resources:`, `SendMessage` from a handler, and a
  **cross-service event source mapping** (billing consumes a queue owned by orders,
  referenced by ARN). Delivery is in-process to the LSS Lambda runtime — the absorbed
  proxy metadata keeps the `INVOKE_URL` only as fallback.
- **S3** — bucket from `resources:`, `PutObject`/`ListObjectsV2`/`GetObject` round trips
  (bodies stored as blobs on disk, never in the engine heap).
- **EventBridge** — custom bus from `resources:`, `PutEvents` from a handler, a rule with
  pattern filtering wired to a target in **another service**, real event envelope
  (no `Records` wrapper).
- **API Gateway + Lambda runtime** — the native LSS emulation (payload v2 `httpApi`
  routes on 30xx ports, handlers in per-service workers, `source` mode with hot reload).
- **Persistence** — engine state lives in `.lss/engine/` (JSONL snapshot + WAL); tables
  and queues survive an orchestrator restart. Delete the folder for a clean slate.

> **Ports** — LSS server `3140`, self engine `14566`, service APIs `3031`–`3033`, invoke
> `13031`–`13033`. The engine's default port sits **outside 4566–4599** on purpose: a real
> LocalStack install intercepts that whole range on some hosts.

## Prerequisites

- Node.js ≥ 20. That's it — **no Docker required**.

## Run

```bash
cd examples/self-engine-sample

# Install the three services' dependencies
npm run setup

# 1. Start LSS with the self engine (boots in milliseconds)
npm run lss:start

# 2. Register the three services (plain `sls package` — never `deploy`)
npm run register:all

# 3. Drive the pipeline
curl -X POST http://localhost:3031/orders \
  -H 'content-type: application/json' \
  -d '{"customerId":"u-ada","total":42.5}'

# 4. Watch it flow through the three services
curl http://localhost:3031/orders          # order stored (plus the seeded one)
curl http://localhost:3032/receipts        # receipt written to S3 by billing
curl http://localhost:3033/notifications   # notification created via EventBridge

# 5. Dashboard: http://localhost:3140 (services, queues, tables, lambdas, APIs)

npm run lss:stop
```

Measured on this example (Linux, Node 22): engine boot ~10 ms; full pipeline
(order → receipt → notification, crossing 3 services and 4 AWS resources) completes in
~170 ms; the whole stack is the orchestrator process plus one small worker per service —
no container pulling ~1 GB of RAM.

## Troubleshooting

- **`--self-engine` + `--external`/`--pro` rejected** — those flags are LocalStack-only.
- **Port 14566 in use** — set `selfEngine.port` in `lss.config.json`; the engine fails
  fast on bind conflicts.
- **Something the engine doesn't implement yet** — the error names the missing operation
  and points at `docs/SELF_ENGINE.md#coverage`; set `selfEngine.fallbackEndpoint` to a
  LocalStack URL to forward unimplemented calls during migration.
