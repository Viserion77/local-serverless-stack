# self-hosted

Four microservices running **entirely on the LSS self engine** — DynamoDB, SQS, S3
(incl. presigned POST), EventBridge, OpenSearch Serverless and Secrets Manager emulated
in-process by the orchestrator. **No Docker. No LocalStack. No auth token.** The engine boots in milliseconds and serves the
real AWS wire protocols, so the services below use plain `@aws-sdk` v3 clients (or bare
`fetch` for OpenSearch) pointed at `http://localhost:14566`.

| Service | Role | API port | Invoke port |
|---|---|---|---|
| `orders-service` | `POST /orders` stores the order in DynamoDB and enqueues it on SQS; `GET /orders` lists them. Owns the `orders-Orders` table and the `orders-to-process` queue. | `3631` | `13631` |
| `billing-service` | SQS consumer (cross-service ESM **by ARN**) writes a receipt to S3 and publishes `OrderBilled` to the `billing-events` bus; `GET /receipts` lists receipts, `GET /attachments/upload-url` returns a presigned POST, `GET /receipts/{id}/signature` signs with a Secrets Manager key. Owns the bucket and the bus. | `3632` | `13632` |
| `notifications-service` | EventBridge rule (`source: billing`, `detail-type: OrderBilled`) stores a notification in DynamoDB; `GET /notifications` lists them. | `3633` | `13633` |
| `catalog-service` | `POST /products` indexes documents; `GET /products/{id}` / `DELETE /products/{id}` read and remove them; `GET /search` runs full-text + filtered queries; `GET /stats` aggregates by category. Owns the `products-catalog` OpenSearch Serverless collection. | `3634` | `13634` |

The order pipeline, end to end:

```
POST /orders (3631)
  → DynamoDB orders-Orders + SQS orders-to-process        [orders-service]
  → in-process ESM delivery → S3 receipt + PutEvents      [billing-service]
  → rule match on billing-events → DynamoDB notification  [notifications-service]
  → GET /notifications (3633) shows the result

…and when billing keeps rejecting an order:
  2 failed deliveries → SQS orders-to-process-dlq         [RedrivePolicy]
```

What this exercises on the self engine:

- **DynamoDB** — two tables created from `resources:`, document-client reads/writes,
  auto-seed on table creation (`seeds/orders-Orders.json`).
- **SQS** — queue from `resources:`, `SendMessage` from a handler, and a
  **cross-service event source mapping** (billing consumes a queue owned by orders,
  referenced by ARN). Delivery is in-process to the LSS Lambda runtime.
- **SQS redrive (`RedrivePolicy` → DLQ)** — `orders-to-process` declares a
  `RedrivePolicy` (`maxReceiveCount: 2`) pointing at `orders-to-process-dlq`. An order
  `processOrder` cannot bill (non-positive total) is delivered exactly twice and then
  moved to the DLQ by the engine — same `MessageId`, same body — instead of redelivering
  forever. See [Drive the DLQ redrive](#drive-the-dlq-redrive).
- **S3** — bucket from `resources:`, `PutObject`/`ListObjectsV2`/`GetObject` round trips
  (bodies stored as blobs on disk, never in the engine heap), plus **presigned POST**:
  `GET /attachments/upload-url` hands back a browser form (`createPresignedPost`) that
  uploads straight to S3 — the self engine serves the `POST /<bucket>` multipart upload
  natively.
- **Secrets Manager** — `GET /receipts/{id}/signature` reads an HMAC signing key from
  Secrets Manager (lazily created on first use via `CreateSecret`/`GetRandomPassword`,
  read via `GetSecretValue`) to sign a receipt id — the pattern of a service reading a
  signing key at boot/request time. Inspect the secret and its `AWSCURRENT`/`AWSPREVIOUS`
  versions in the dashboard's **Secrets** tab.
- **EventBridge** — custom bus from `resources:`, `PutEvents` from a handler, a rule with
  pattern filtering wired to a target in **another service**, real event envelope
  (no `Records` wrapper).
- **OpenSearch Serverless** — `AWS::OpenSearchServerless::Collection` provisioned from
  `resources:` via the real `aoss` control plane (the `SecurityPolicy`/`AccessPolicy`
  resources are accepted and skipped with a registration warning, so the template stays
  deployable to real AWS); document CRUD with versioning; `multi_match` + `bool` +
  `term`/`range` search DSL with `sort` and pagination; `terms`/`avg` aggregations.
- **API Gateway + Lambda runtime** — the native LSS emulation (payload v2 `httpApi`
  routes on 36xx ports, CORS answered by the LSS gateway, handlers in per-service
  workers, `source` mode with hot reload).
- **Persistence** — engine state lives in `.lss/engine/` (JSONL snapshot + WAL for
  tables and queues, JSON catalogs + a JSONL table per index for OpenSearch); everything
  survives an orchestrator restart. Delete the folder for a clean slate.

> **Ports** — LSS `14566` (dashboard, REST API and AWS wire on one listener), service APIs `3631`–`3634`, invoke
> `13631`–`13634`. The engine's default port sits **outside 4566–4599** on purpose: a real
> LocalStack install intercepts that whole range on some hosts.

The example also showcases [dashboard branding](../../docs/CONFIGURATION.md#configuration-properties)
in its fullest form: `lss.config.json` sets a custom `title`/`subtitle`, points `logo` and
`favicon` at `assets/logo.svg`, defaults the dashboard to the dark theme, overrides the
TreeUI brand tokens (`brand-primary`/`brand-hover`/`brand-soft`) with teal tones — plus
per-theme dark overrides and a raw custom property (`--tree-radius-md`) — so the dashboard
at `http://localhost:14566` opens dark with a teal accent and the example's own identity.

## Prerequisites

- Node.js ≥ 20. That's it — **no Docker required**.

## Run

```bash
cd examples/self-hosted

# Install the four services' dependencies
npm run setup

# 1. Start LSS with the self engine (boots in milliseconds)
npm run lss:start

# 2. Register the four services (plain `sls package` — never `deploy`)
npm run register:all

# 3. Drive the pipeline
curl -X POST http://localhost:3631/orders \
  -H 'content-type: application/json' \
  -d '{"customerId":"u-ada","total":42.5}'

# 4. Watch it flow through the three services
curl http://localhost:3631/orders          # order stored (plus the seeded one)
curl http://localhost:3632/receipts        # receipt written to S3 by billing
curl http://localhost:3633/notifications   # notification created via EventBridge

# 5. Dashboard: http://localhost:14566 (services, queues, tables, lambdas, APIs, Secrets)

npm run lss:stop
```

## Drive Secrets Manager + presigned POST

```bash
# Sign a receipt id with the HMAC key from Secrets Manager (created on first call).
curl -s 'http://localhost:3632/receipts/rcpt-123/signature'
# → {"receiptId":"rcpt-123","signature":"…","keyId":"billing/receipt-signing-key","keyStages":["AWSCURRENT"]}

# The key now shows up in the dashboard's Secrets tab (reveal value, version stages).

# Ask for a presigned POST, then upload an attachment straight to S3 with it.
curl -s 'http://localhost:3632/attachments/upload-url?filename=invoice.pdf'
# The response includes a ready-to-run `hint` curl: paste it (with a real -F file=@…)
# to POST the form to the bucket. The object then appears under the S3 tab.
```

## Drive the DLQ redrive

```bash
# A non-billable order: processOrder throws on every delivery.
curl -s -X POST http://localhost:3631/orders \
  -H 'content-type: application/json' \
  -d '{"customerId":"u-poison","total":-1}'

# VisibilityTimeout is 5 s and maxReceiveCount is 2, so after ~13 s the message
# has been delivered twice and moved to the dead-letter queue.
sleep 13

curl -s http://localhost:14566/api/queues/orders-to-process-dlq   # 1 message
curl -s http://localhost:14566/api/queues/orders-to-process       # drained
```

The redriven message keeps its original `MessageId`, body and MD5 digests; its
`ApproximateReceiveCount` restarts on the DLQ (each queue counts its own
deliveries). Both queues are inspectable in the dashboard's **Queues** tab, and
the flow is also one click in the validation console.

## Drive the catalog

```bash
# Index a few products
curl -s -X POST localhost:3634/products -d '{"name":"Wireless Mouse","category":"peripherals","price":25,"tags":["usb","wireless"]}'
curl -s -X POST localhost:3634/products -d '{"name":"Mechanical Keyboard","category":"peripherals","price":90,"tags":["usb"]}'
curl -s -X POST localhost:3634/products -d '{"name":"USB Hub","category":"accessories","price":15,"tags":["usb"]}'

# Full-text search
curl -s 'localhost:3634/search?q=wireless'

# Filters compose with the text query
curl -s 'localhost:3634/search?category=peripherals&maxPrice=50'

# Aggregations: products and average price per category
curl -s localhost:3634/stats
```

The engine also answers the OpenSearch REST API directly — handy for debugging:

```bash
curl -s 'http://localhost:14566/_aoss/products-catalog/_cat/indices'
curl -s 'http://localhost:14566/_aoss/products-catalog/products/_search?q=name:mouse'
curl -s 'http://localhost:14566/_aoss/products-catalog/products/_count'
```

## Validation console

`index.html` at the example root is a small browser console that pings every port and
runs all three flows (the full order pipeline, the catalog CRUD/search round trip and the
poison-order DLQ redrive) with one click. Open it directly (`file://…/examples/self-hosted/index.html`) or serve it:

```bash
npm run console    # http://localhost:8622
```

All four services enable `provider.httpApi.cors: true`, so the LSS gateway answers the
preflight requests the console needs.

## Troubleshooting

- **`--self-engine` + `--external`/`--pro` rejected** — those flags are LocalStack-only.
- **Port 14566 in use** — set `selfEngine.port` in `lss.config.json`; the engine fails
  fast on bind conflicts.
- **Something the engine doesn't implement yet** — the error names the missing operation
  and points at `docs/SELF_ENGINE.md#coverage`; set `selfEngine.fallbackEndpoint` to a
  LocalStack URL to forward unimplemented calls during migration.

## Stop / reset

```bash
npm run lss:stop        # stop the orchestrator
rm -rf .lss             # wipe engine state (tables, queues, buckets, collections)
```
