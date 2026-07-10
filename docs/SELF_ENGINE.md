# Self Engine

The self engine is an in-process AWS emulator that replaces LocalStack for the
typical serverless dev loop: DynamoDB, SQS, S3, EventBridge, SNS (minimal),
Lambda control plane and STS served from a single `node:http` listener inside
the orchestrator — no Docker, no container, no auth token. Design rationale and
phased roadmap: [PRD_SELF_ENGINE.md](PRD_SELF_ENGINE.md) (PT-BR).

## Enabling it

```jsonc
// lss.config.json
{
  "engine": "self",                  // default: "localstack"
  "selfEngine": {
    "port": 14566,                   // default — outside 4566–4599 on purpose*
    "dataDir": "~/.lss/engine",      // default; <stateDir>/engine when stateDir is set
    "account": "000000000000",
    "idleUnloadMs": 300000,          // dehydrate idle data stores after 5 min
    "memoryBudgetMb": 128,           // LRU budget for hydrated data
    "fsync": false,                  // true = fsync every WAL flush (paranoid)
    "fallbackEndpoint": null         // e.g. "http://localhost:4566" during migration
  }
}
```

CLI: `npx lss start --self-engine` (equivalent to `LSS_ENGINE=self`). Env
overrides: `LSS_ENGINE`, `LSS_ENGINE_PORT`. `--self-engine` cannot be combined
with `--external`, `--pro` or `--localstack-token`.

Point your application at the engine exactly like LocalStack:

```
AWS_ENDPOINT=http://localhost:14566
```

\* A real LocalStack install intercepts ports 4566–4599 on some hosts (Docker
Desktop/WSL2), silently hijacking traffic. If you need the engine on 4566 for
drop-in compatibility, set `selfEngine.port` explicitly.

## What keeps working

The wire API is the seam: the provisioner, the dashboards/explorers, seeds,
`LssClient`, the QueueInspector primitives (`hold`/`release`/`await-idle`) and
the `serverless-lss` plugin all speak AWS SDK against the engine endpoint,
unchanged. Event delivery to your handlers happens **in-process** through the
LSS Lambda runtime — the LocalStack-era proxy Lambdas are absorbed as metadata
(their `INVOKE_URL` doubles as an HTTP fallback for services still running
serverless-offline).

## Coverage

Anything not listed answers with an explicit AWS-shaped error naming this file
— or is forwarded verbatim to `fallbackEndpoint` when configured. The engine
never silently succeeds.

| Service | Implemented (v1) | Explicit error until the hardening phase |
|---|---|---|
| DynamoDB | CreateTable, DescribeTable, DeleteTable, ListTables, Update/DescribeTimeToLive, Put/Get/Delete/UpdateItem, Query, Scan, BatchGetItem, BatchWriteItem — full expression language (KeyCondition, Condition, Filter, Update, Projection), GSI/LSI with projection + sparse semantics, streams (in-process), lazy TTL, decimal-exact `N` arithmetic | Transactions, UpdateTable, PartiQL, legacy parameters (`KeyConditions`, `Expected`, …), Streams wire API |
| SQS | CreateQueue (idempotent), GetQueueUrl, Get/SetQueueAttributes (live counters), ListQueues, DeleteQueue, SendMessage(+Batch), ReceiveMessage (event-driven long poll), DeleteMessage(+Batch), PurgeQueue, ChangeMessageVisibility — FIFO groups/dedup, visibility redelivery, `x-amzn-query-error` compat header, MD5 digests | Legacy Query protocol (aws-sdk v2 / old boto3 — loud error suggests `fallbackEndpoint`), RedrivePolicy→DLQ enforcement, tags |
| S3 | Create/Head/Delete bucket, ListBuckets, GetBucketLocation, versioning flag, notification configuration (incl. legacy `CloudFunctionConfiguration` XML), ListObjectsV2 (prefix/delimiter/pagination/encoding-type), PutObject (aws-chunked decoded), GetObject (Range), HeadObject, DeleteObject(s), CopyObject — bodies streamed to disk blobs, never held in memory | Multipart uploads, version stacks, ACL/policy APIs |
| EventBridge | Create/Delete/DescribeEventBus, ListEventBuses, PutRule (pattern validation), DeleteRule, Enable/DisableRule, Put/RemoveTargets, ListRules, ListTargetsByRule, PutEvents (per-entry results, pattern matching: exact, array-OR, `prefix`, `exists`, nested) | `anything-but`, `numeric`, `suffix`, `wildcard`, `cidr` pattern operators (rejected at PutRule), Archives |
| Lambda (control plane) | CreateFunction (metadata absorption), GetFunction, ListFunctions, UpdateFunctionConfiguration, DeleteFunction, Add/RemovePermission, Create/Get/List/Update/DeleteEventSourceMapping (Enabled toggle = QueueInspector hold/release), Invoke (in-process via the LSS runtime; `X-Amz-Invocation-Type` honored) | Versions/aliases, concurrency APIs |
| SNS | CreateTopic, ListTopics, DeleteTopic, GetTopicAttributes, Publish (logged + counted, no fan-out) | Subscriptions and delivery |
| STS | GetCallerIdentity | Everything else |

### Eventing (delivered in-process to the LSS Lambda runtime)

- **SQS → Lambda**: batch size + batching window honored, failure → visibility
  redelivery (AWS semantics, no custom retry machinery), FIFO per-group
  ordering, disabled mapping = held queue.
- **DynamoDB Streams → Lambda**: single implicit shard (single-writer order),
  TRIM_HORIZON/LATEST, retry-then-advance with optional OnFailure SQS
  destination (`DDBStreamBatchInfo` envelope).
- **S3 notifications**: `s3:ObjectCreated:*` globs, prefix/suffix filters,
  `eventVersion 2.1` records.
- **EventBridge**: rule targets with `Input`/`InputPath`; schedules
  (`rate(...)` and 6-field cron) fire from a single timer wheel.

## Storage & footprint

Data lives under `dataDir` (default `~/.lss/engine`): JSON catalogs for
metadata, JSONL snapshot + WAL per DynamoDB table / S3 object index, S3 bodies
as content-addressed blobs. Registration writes metadata only; item data
hydrates on first access (streamed line-by-line) and dehydrates after
`idleUnloadMs` or under `memoryBudgetMb` LRU pressure. SQS messages are
memory-only (snapshotted on graceful shutdown when `persistence` is on).

Crash-safety bar (a dev tool, stated honestly): a hard crash may lose the last
~20 ms of writes. Ground truth is regenerable — re-register the services and
run `lss seed`. Worst case, delete `dataDir` and start clean.

## Known divergences from AWS

- No SigV4 verification, IAM, quotas or throttling; single account/region
  namespace per request scope.
- DynamoDB: 1 MB page-size cap not enforced (Limit is); index queries answer
  from the base table (correct semantics, dev-scale performance).
- SQS legacy Query protocol (pre-JSON SDKs) is not served natively — use
  `fallbackEndpoint`.
- LocalStack volume data does not migrate; re-register + `lss seed`.
