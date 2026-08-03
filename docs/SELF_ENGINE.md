# Self Engine

The self engine is the in-process AWS emulator LSS runs on. It replaces a container-based emulator for the
typical serverless dev loop: DynamoDB, SQS, S3, EventBridge, OpenSearch
Serverless, Secrets Manager, SNS (minimal), Lambda control plane and STS served
from a single `node:http` listener inside the orchestrator — no Docker, no
container, no auth token. Design rationale and phased roadmap:
[PRD_SELF_ENGINE.md](PRD_SELF_ENGINE.md) (PT-BR).

## Configuring it

```jsonc
// lss.config.json
{
  "selfEngine": {
    "port": 14566,                   // default — equal to serverPort, so the
                                     // engine shares the orchestrator's listener*
    "dataDir": null,                 // default: <stateDir>/engine, else ~/.lss/projects/<slug>/engine
    "account": "000000000000",
    "idleUnloadMs": 300000,          // dehydrate idle data stores after 5 min
    "memoryBudgetMb": 128,           // LRU budget for hydrated data
    "fsync": false,                  // true = fsync every WAL flush (paranoid)
    "fallbackEndpoint": null         // reverse-proxy unimplemented operations here
  }
}
```

The engine starts with the orchestrator and, by default, **on the same port**:
`selfEngine.port` defaults to the same value as `serverPort`, so the dashboard,
the REST API and the AWS wire are one URL. A request is routed by shape — SigV4,
`X-Amz-Target` or any `x-amz-*` header reaches the engine, everything else the
API/SPA (`src/server/engine/http/is-aws-request.ts`). Give the two keys different
values to go back to two listeners.

Env overrides: `LSS_ENGINE_PORT`, `LSS_ENGINE_DATA_DIR` — with `LSS_DASHBOARD_PORT`
they are everything a second instance needs.

Point your application at the engine like any AWS endpoint:

```
AWS_ENDPOINT=http://localhost:14566
```

\* And outside 4566–4599: a real LocalStack install (if your machine has one) intercepts that range on some hosts (Docker
Desktop/WSL2), silently hijacking traffic. If you need the engine on 4566 for
drop-in compatibility, set `selfEngine.port` explicitly.

The active engine kind, its endpoint and the resolved `selfEngine` block are
exposed on `GET /api/config`, and the engine port shows up (next to every other
listener) on `GET /api/config/ports` — surfaced in the dashboard's Overview
"Exposed ports" card and editable in the Settings tab (a `selfEngine` change is
boot-materialized, so it is flagged `restartRequired`).

## What keeps working

The wire API is the seam: the provisioner, the dashboards/explorers, seeds,
`LssClient` and the QueueInspector primitives (`hold`/`release`/`await-idle`)
all speak AWS SDK against the engine endpoint, unchanged. Service registration
(`lss register`, onboarding, `POST /api/services/register`) is unaffected too —
it only speaks the orchestrator REST API and never talks to the engine directly. Event delivery to your handlers happens **in-process** through the
LSS Lambda runtime — proxy Lambdas are absorbed as metadata
(their `INVOKE_URL` doubles as an HTTP fallback for services still running
serverless-offline).

## Coverage

Anything not listed answers with an explicit AWS-shaped error naming this file
— or is forwarded verbatim to `fallbackEndpoint` when configured. Unknown
operations never silently succeed. One known divergence is the exception: S3
object ACL/policy sub-resources (treated as plain object operations) — see
[Known divergences from AWS](#known-divergences-from-aws).

| Service | Implemented (v1) | Explicit error until the hardening phase |
|---|---|---|
| DynamoDB | CreateTable, DescribeTable, DeleteTable, ListTables, Update/DescribeTimeToLive, Put/Get/Delete/UpdateItem, Query, Scan, BatchGetItem, BatchWriteItem, TransactWriteItems/TransactGetItems (all-or-nothing, `CancellationReasons` with `ReturnValuesOnConditionCheckFailure`, `ClientRequestToken` idempotency, stream records for committed writes) — full expression language (KeyCondition, Condition, Filter, Update, Projection), GSI/LSI with projection + sparse semantics, streams (in-process), lazy TTL, decimal-exact `N` arithmetic | UpdateTable, PartiQL, legacy parameters (`KeyConditions`, `Expected`, …), Streams wire API |
| SQS | CreateQueue (idempotent), GetQueueUrl, Get/SetQueueAttributes (live counters), ListQueues, DeleteQueue, SendMessage(+Batch), ReceiveMessage (event-driven long poll), DeleteMessage(+Batch), PurgeQueue, ChangeMessageVisibility — FIFO groups/dedup, visibility redelivery, `x-amzn-query-error` compat header, MD5 digests, **queue-level redrive**: a `RedrivePolicy` (`{deadLetterTargetArn, maxReceiveCount}`) moves a message to its DLQ once `ApproximateReceiveCount` exceeds `maxReceiveCount`, preserving `MessageId`/body/`MessageAttributes`/MD5s and releasing the FIFO `MessageGroupId` | Legacy Query protocol (aws-sdk v2 / old boto3 — loud error suggests `fallbackEndpoint`), `RedriveAllowPolicy`, the manual redrive API (`StartMessageMoveTask`/`ListMessageMoveTasks`/`CancelMessageMoveTask`), tags |
| S3 | Create/Head/Delete bucket, ListBuckets, GetBucketLocation, versioning flag, notification configuration (incl. legacy `CloudFunctionConfiguration` XML), ListObjectsV2 (prefix/delimiter/pagination/encoding-type), PutObject (aws-chunked decoded), **presigned POST (browser form upload: multipart/form-data, `${filename}` substitution, `success_action_status`/`success_action_redirect`, `x-amz-meta-*` fields)**, **CORS (`Put`/`Get`/`DeleteBucketCors`, preflight `OPTIONS`, `Access-Control-Allow-Origin` on responses — honors a matching bucket rule, else a dev-permissive default so browser uploads work out of the box; a bucket's CloudFormation `CorsConfiguration.CorsRules[]` is applied with `PutBucketCors` at create time, so the declared rules are live on the first boot instead of needing a bootstrap call)**, GetObject (Range, **`response-*` header overrides on presigned GET/HEAD — content-disposition/type/encoding/language/cache-control/expires**), HeadObject, DeleteObject(s), CopyObject — bodies streamed to disk blobs, never held in memory | Multipart uploads, version stacks. Object ACL/policy sub-resources (`?acl`, `?policy`) are **not** recognized — requests dispatch on HTTP method alone and behave as plain object operations (PutObjectAcl overwrites the object body): a known divergence, not an explicit error |
| EventBridge | Create/Delete/DescribeEventBus, ListEventBuses, PutRule (pattern validation), DeleteRule, Enable/DisableRule, Put/RemoveTargets, ListRules, ListTargetsByRule, PutEvents (per-entry results, pattern matching: exact, array-OR, `prefix`, `exists`, nested) | `anything-but`, `numeric`, `suffix`, `wildcard`, `cidr` pattern operators (rejected at PutRule), Archives |
| Lambda (control plane) | CreateFunction (metadata absorption), GetFunction, ListFunctions, UpdateFunctionConfiguration, DeleteFunction, Add/RemovePermission, Create/Get/List/Update/DeleteEventSourceMapping (Enabled toggle = QueueInspector hold/release), Invoke (in-process via the LSS runtime; `X-Amz-Invocation-Type` honored) | Versions/aliases, concurrency APIs |
| OpenSearch Serverless | Control plane (`aoss`): CreateCollection (deterministic ids, ACTIVE immediately), BatchGetCollection (hands out the local `collectionEndpoint`), ListCollections, DeleteCollection (id or name). Data plane under `<engine>/_aoss/<collection>`: index create/get/delete/HEAD, `_mapping` get/merge, `_doc`/`_create`/`_update` (deep merge, `doc_as_upsert`/`upsert`) with versioning, auto-create on first write, `_bulk` NDJSON with per-item results, `_search`/`_count` (`match`, `match_phrase`, `multi_match`, `term`, `terms`, `range`, `prefix`, `wildcard`, `exists`, `ids`, `bool` + `minimum_should_match`; `sort`, `from`/`size`, `_source` filtering, `?q=`), aggregations (`terms`, `avg`, `sum`, `min`, `max`, `value_count`), `_refresh`, `_cat/indices` | Security/access/lifecycle policy APIs, VPC endpoints, scripted updates, `_mget`, scroll/PIT, sub-aggregations, relevance scoring (`_score` is a constant 1), analyzers/k-NN — all rejected with an explicit OpenSearch-shaped error |
| SNS | CreateTopic, ListTopics, DeleteTopic, GetTopicAttributes, Publish (logged + counted, no fan-out) | Subscriptions and delivery |
| STS | GetCallerIdentity | Everything else |
| Secrets Manager | CreateSecret, GetSecretValue, PutSecretValue, UpdateSecret, DescribeSecret, DeleteSecret (recovery window + `ForceDeleteWithoutRecovery`), RestoreSecret, ListSecrets, TagResource/UntagResource, GetRandomPassword — real `AWSCURRENT`/`AWSPREVIOUS` version staging, `SecretString`/`SecretBinary`, `ClientRequestToken` idempotency, per-region scoping. Values persist in a catalog (not encrypted locally). Browsable in the dashboard's **Secrets** tab (list, version stages, reveal value). Secrets are populated before the first read by two boot paths — CloudFormation `AWS::SecretsManager::Secret` provisioned at registration, and **boot seeds** (see below) | Rotation scheduling/Lambda, replication, KMS encryption (`KmsKeyId` accepted and ignored), resource policies |

### Eventing (delivered in-process to the LSS Lambda runtime)

- **SQS → Lambda**: batch size + batching window honored, failure → visibility
  redelivery (AWS semantics, no custom retry machinery), FIFO per-group
  ordering, disabled mapping = held queue.
- **DynamoDB Streams → Lambda**: single implicit shard (single-writer order),
  TRIM_HORIZON/LATEST, retry-then-advance with optional OnFailure SQS
  destination (`DDBStreamBatchInfo` envelope).
- **Event source mapping semantics** (both stream and SQS mappings):
  - `FilterCriteria` is **enforced**, not just stored: every `Filters[].Pattern`
    is a JSON-encoded EventBridge-style content filter, patterns are OR'd and
    sibling keys inside one pattern AND'd, reusing the engine's own pattern
    matcher. Absent or empty criteria filter nothing; structurally invalid
    criteria are rejected at write time (`InvalidArgumentException` — non-object
    `Filters`, more than the AWS limit of 5 patterns, an unparseable `Pattern`,
    an unsupported operator). Filtered-out **stream** records still advance the
    cursor, so they are dropped once and never reappear; filtered-out **SQS**
    messages leave the batch before the handler is invoked.
  - `maximumRetryAttempts` follows the AWS default: omitted or `-1` retries the
    failing batch **until the record ages out of the stream** (there is no
    5-attempt cap), a positive N means N retries. Whichever ends the loop is
    logged and carried as `RetryAttemptsExhausted` / `RecordAgeExpired` on the
    OnFailure envelope.
  - `ReportBatchItemFailures` (declared via `FunctionResponseTypes`) is honored:
    a **stream** batch checkpoints just before the *earliest* still-failing
    record and only that suffix is retried and eventually sent to the OnFailure
    destination (an empty `batchItemFailures` list commits the whole batch; a
    malformed response retries it like a thrown handler; the attempt budget is
    not reset when the suffix shrinks). For **SQS**, only the receipt handles
    *not* reported as failures are deleted, so the reported ones redeliver on
    their visibility timeout instead of the batch being dropped or replayed
    whole.
- **S3 notifications**: `s3:ObjectCreated:*` globs, prefix/suffix filters,
  `eventVersion 2.1` records.
- **EventBridge**: rule and schedule targets deliver to **Lambda** (invoke) or
  **SQS** (enqueue the resolved event as a message — `SqsParameters.MessageGroupId`
  honored for FIFO targets), with `Input`/`InputPath`; schedules (`rate(...)` and
  6-field cron) fire from a single timer wheel.

### Secrets on boot

Two paths make sure a secret **exists with an `AWSCURRENT` version** before a
handler's first `GetSecretValue`, so nothing has to run a bootstrap
`CreateSecret` first:

- **CloudFormation** — `AWS::SecretsManager::Secret` declared in `resources:` is
  created at service registration. `GenerateSecretString` is expanded the way
  CloudFormation expands it: `GetRandomPassword` with the real AWS defaults
  (`PasswordLength` 32, every character class, `RequireEachIncludedType` true),
  then the generated value injected into `SecretStringTemplate` at
  `GenerateStringKey` when both are given.
- **Boot seeds** — for secrets no template declares: `seeds/secrets/<name>.json`
  files under `seedsDir` (walked recursively, so nested directories map to
  `/`-separated names like `billing/receipt-signing-key`) merged with an
  optional `secrets:` map in `lss.config.json`, the config map winning a name
  collision with a warning. A value is either the `SecretString` itself (a bare
  string, or a bare JSON object that *is* the payload) or a descriptor with
  `secretString` / `generateSecretString` plus `description` / `kmsKeyId` /
  `tags`. Seeds are applied **before cached services are reactivated**, so even
  a handler fired by a relay during rehydrate finds its secret already staged.

Both paths share one value resolver, are idempotent (an existing active secret
is skipped, never clobbered; one scheduled for deletion is warned and skipped)
and non-fatal (a failure warns and boot continues).

## Health endpoints

- `GET /_lss/health` — native: `{ "status": "ok", "engine": "self" }`.
- `GET /_localstack/health` — **compatibility alias**, not a dependency. Third-party
  tooling (wait-for scripts, IDE plugins, compose healthchecks) probes this path to
  decide whether a local AWS is up; the engine answers in the shape they expect, with
  `edition: "self"` so nothing pretends to be something it is not.

The orchestrator's own `GET /api/health` (port 3100) is the one the dashboard and the
`LssClient` use — it reports the engine plus the Lambda runtime and the DynamoDB proxy.

## Storage & footprint

Data lives under `dataDir` (default `<stateDir>/engine`, or
`~/.lss/projects/<project-slug>-<hash>/engine` when no `stateDir` is set — the
home fallback is scoped per project so two checkouts never share one set of
tables): JSON catalogs for metadata, JSONL snapshot + WAL per DynamoDB table /
S3 object index / OpenSearch index, S3 bodies as content-addressed blobs.
Registration writes metadata only; item data hydrates on first access (streamed
line-by-line) and dehydrates after `idleUnloadMs` or under `memoryBudgetMb` LRU
pressure. SQS messages are memory-only (snapshotted on graceful shutdown when
`persistence` is on).

A table's WAL folds back into its snapshot on dehydrate **and** on its own once
it outgrows both 4 MB and twice the table's resident size — a table written to
continuously never goes idle, and without that its WAL would grow for the whole
session and be replayed in full on the next boot.

**`persistence: false` means in-memory.** The engine swaps the file-backed store
for a heap-only one: `dataDir` is never created, no catalog/WAL/blob is written,
and every boot starts empty. That is the mode for an automated test run that
needs a guaranteed clean slate and no leftover files; `idleUnloadMs` /
`memoryBudgetMb` are inert there, since with no snapshot on disk an eviction
would be data loss.

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
- SQS: queue-level redrive is enforced, but the DLQ must live in the same
  account/region (only the queue name in `deadLetterTargetArn` is read).
  `RedriveAllowPolicy` is stored and returned, never enforced, and the manual
  redrive API (`StartMessageMoveTask` and friends) is not implemented — drain a
  DLQ with ReceiveMessage/SendMessage instead.
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
- Container-volume data from another emulator does not migrate; re-register + `lss seed`.
