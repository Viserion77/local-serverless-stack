# Self Engine

The self engine is an in-process AWS emulator that replaces LocalStack for the
typical serverless dev loop: DynamoDB, SQS, S3, EventBridge, OpenSearch
Serverless, SNS (minimal), Lambda control plane and STS served from a single
`node:http` listener inside the orchestrator — no Docker, no container, no
auth token. Design rationale and phased roadmap:
[PRD_SELF_ENGINE.md](PRD_SELF_ENGINE.md) (PT-BR).

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
`LssClient` and the QueueInspector primitives (`hold`/`release`/`await-idle`)
all speak AWS SDK against the engine endpoint, unchanged. The `serverless-lss`
plugin is unaffected too — it only POSTs JSON to the orchestrator REST API and
never talks to the engine directly. Event delivery to your handlers happens **in-process** through the
LSS Lambda runtime — the LocalStack-era proxy Lambdas are absorbed as metadata
(their `INVOKE_URL` doubles as an HTTP fallback for services still running
serverless-offline).

## Coverage

Anything not listed answers with an explicit AWS-shaped error naming this file
— or is forwarded verbatim to `fallbackEndpoint` when configured. Unknown
operations never silently succeed. Two known divergences are the exception:
SQS `RedrivePolicy` (accepted but not enforced) and S3 object ACL/policy
sub-resources (treated as plain object operations) — see
[Known divergences from AWS](#known-divergences-from-aws).

| Service | Implemented (v1) | Explicit error until the hardening phase |
|---|---|---|
| DynamoDB | CreateTable, DescribeTable, DeleteTable, ListTables, Update/DescribeTimeToLive, Put/Get/Delete/UpdateItem, Query, Scan, BatchGetItem, BatchWriteItem — full expression language (KeyCondition, Condition, Filter, Update, Projection), GSI/LSI with projection + sparse semantics, streams (in-process), lazy TTL, decimal-exact `N` arithmetic | Transactions, UpdateTable, PartiQL, legacy parameters (`KeyConditions`, `Expected`, …), Streams wire API |
| SQS | CreateQueue (idempotent), GetQueueUrl, Get/SetQueueAttributes (live counters), ListQueues, DeleteQueue, SendMessage(+Batch), ReceiveMessage (event-driven long poll), DeleteMessage(+Batch), PurgeQueue, ChangeMessageVisibility — FIFO groups/dedup, visibility redelivery, `x-amzn-query-error` compat header, MD5 digests. RedrivePolicy is accepted and round-trips through Get/SetQueueAttributes, but DLQ redrive is NOT enforced — failed messages redeliver via visibility timeout | Legacy Query protocol (aws-sdk v2 / old boto3 — loud error suggests `fallbackEndpoint`), tags |
| S3 | Create/Head/Delete bucket, ListBuckets, GetBucketLocation, versioning flag, notification configuration (incl. legacy `CloudFunctionConfiguration` XML), ListObjectsV2 (prefix/delimiter/pagination/encoding-type), PutObject (aws-chunked decoded), GetObject (Range), HeadObject, DeleteObject(s), CopyObject — bodies streamed to disk blobs, never held in memory | Multipart uploads, version stacks. Object ACL/policy sub-resources (`?acl`, `?policy`) are **not** recognized — requests dispatch on HTTP method alone and behave as plain object operations (PutObjectAcl overwrites the object body): a known divergence, not an explicit error |
| EventBridge | Create/Delete/DescribeEventBus, ListEventBuses, PutRule (pattern validation), DeleteRule, Enable/DisableRule, Put/RemoveTargets, ListRules, ListTargetsByRule, PutEvents (per-entry results, pattern matching: exact, array-OR, `prefix`, `exists`, nested) | `anything-but`, `numeric`, `suffix`, `wildcard`, `cidr` pattern operators (rejected at PutRule), Archives |
| Lambda (control plane) | CreateFunction (metadata absorption), GetFunction, ListFunctions, UpdateFunctionConfiguration, DeleteFunction, Add/RemovePermission, Create/Get/List/Update/DeleteEventSourceMapping (Enabled toggle = QueueInspector hold/release), Invoke (in-process via the LSS runtime; `X-Amz-Invocation-Type` honored) | Versions/aliases, concurrency APIs |
| OpenSearch Serverless | Control plane (`aoss`): CreateCollection (deterministic ids, ACTIVE immediately), BatchGetCollection (hands out the local `collectionEndpoint`), ListCollections, DeleteCollection (id or name). Data plane under `<engine>/_aoss/<collection>`: index create/get/delete/HEAD, `_mapping` get/merge, `_doc`/`_create`/`_update` (deep merge, `doc_as_upsert`/`upsert`) with versioning, auto-create on first write, `_bulk` NDJSON with per-item results, `_search`/`_count` (`match`, `match_phrase`, `multi_match`, `term`, `terms`, `range`, `prefix`, `wildcard`, `exists`, `ids`, `bool` + `minimum_should_match`; `sort`, `from`/`size`, `_source` filtering, `?q=`), aggregations (`terms`, `avg`, `sum`, `min`, `max`, `value_count`), `_refresh`, `_cat/indices` | Security/access/lifecycle policy APIs, VPC endpoints, scripted updates, `_mget`, scroll/PIT, sub-aggregations, relevance scoring (`_score` is a constant 1), analyzers/k-NN — all rejected with an explicit OpenSearch-shaped error |
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
metadata, JSONL snapshot + WAL per DynamoDB table / S3 object index / OpenSearch
index, S3 bodies as content-addressed blobs. Registration writes metadata only;
item data hydrates on first access (streamed line-by-line) and dehydrates after
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
- SQS: `RedrivePolicy` is accepted and round-trips through
  Get/SetQueueAttributes, but DLQ redrive is NOT enforced — failed messages
  redeliver via visibility timeout.
- S3: object ACL/policy sub-resources (`?acl`, `?policy`) are not recognized —
  requests dispatch on HTTP method alone and behave as plain object operations
  (a PutObjectAcl overwrites the object body).
- OpenSearch Serverless: the collection endpoint is path-based
  (`<engine>/_aoss/<collection>` instead of a per-collection host), collections
  are ACTIVE immediately (no CREATING phase), text matching is
  tokenize-and-compare with no analyzers or relevance ranking (`_score` is a
  constant 1 — filtering is exact, ordering needs an explicit `sort`), and
  encryption/network/data-access policies are not enforced (the CFN resources
  are skipped with a registration warning). Unsigned data-plane requests
  (plain `curl`) resolve to the engine's default region — SigV4-signed clients
  carry their own region, like every other service.
- LocalStack volume data does not migrate; re-register + `lss seed`.
