# Self Engine

The self engine is the in-process AWS emulator LSS runs on. It replaces a container-based emulator for the
typical serverless dev loop: DynamoDB, SQS, S3, EventBridge, OpenSearch
Serverless, Secrets Manager, SSM Parameter Store, the API Gateway control plane (API keys and usage plans), SNS (minimal), Lambda control plane and STS served
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
    "fallbackEndpoint": null,        // reverse-proxy unemulated services here (catch-all)
    "fallbackEndpoints": {}          // per-service overrides: { "<signing name>": url }
  }
}
```

The engine starts with the orchestrator and, by default, **on the same port**:
`selfEngine.port` defaults to the same value as `serverPort`, so the dashboard,
the REST API and the AWS wire are one URL. A request is routed by shape — SigV4,
`X-Amz-Target` or any `x-amz-*` header reaches the engine, everything else the
API/SPA (`src/server/engine/http/is-aws-request.ts`). Give the two keys different
values to go back to two listeners.

Env overrides: `LSS_ENGINE_PORT`, `LSS_ENGINE_DATA_DIR`, `LSS_FALLBACK_ENDPOINT` —
with `LSS_DASHBOARD_PORT` they are everything a second instance needs. Setting
only `LSS_DASHBOARD_PORT` (or `serverPort`) moves the whole stack: the engine port
follows it unless `selfEngine.port` is set explicitly to something else.

Point your application at the engine like any AWS endpoint — `AWS_ENDPOINT_URL`
is the variable the AWS SDK v3, the AWS CLI and boto3 read natively:

```
AWS_ENDPOINT_URL=http://localhost:14566
```

The LSS Lambda runtime sets it for you: every worker starts with
`AWS_ENDPOINT_URL` pointing at the engine, `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` = `test` and `AWS_REGION` / `AWS_DEFAULT_REGION` = the
service's region. Session tokens, profiles, role / web-identity / container
credential variables and any `AWS_ENDPOINT_URL_<SERVICE>` inherited from the
orchestrator's shell are removed, so a handler can never reach a real account
with the developer's credentials. A template, `serviceRuntime.env` or function
env that sets one of these explicitly still wins.

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

Provisioning reads back from the engine what a template can only reference:
after a service's resources are created, function environments are filled with
the physical values — queue URLs (`GetQueueUrl`), DynamoDB stream ARNs
(`DescribeTable` `LatestStreamArn`), secret ARNs with their random suffix
(`DescribeSecret`) and OpenSearch Serverless collection id/ARN/endpoint
(`BatchGetCollection`) — so a handler reading `!Ref OrdersQueue` gets the URL
the engine actually serves.

## Coverage

Anything not listed answers with an explicit `NotImplemented` error naming
`service.Operation` and linking to this table — or, for a service the engine
does not emulate at all, is forwarded verbatim to a fallback endpoint when one is
configured (see [Fallback endpoints](#fallback-endpoints)). The error comes back
in the caller's own protocol — AWS JSON (an `X-Amz-Target` call), Query XML (an
`Action=` call), S3-style XML (rest-xml services) or rest-json (`__type` plus
`x-amzn-ErrorType`) — so every SDK surfaces it as a readable error rather than a
parse failure. Unknown operations never silently succeed.

| Service | Implemented (v1) | Explicit error until the hardening phase |
|---|---|---|
| DynamoDB | CreateTable, DescribeTable, DeleteTable, ListTables, Update/DescribeTimeToLive, Put/Get/Delete/UpdateItem, Query, Scan, BatchGetItem, BatchWriteItem, TransactWriteItems/TransactGetItems (all-or-nothing, `CancellationReasons` with `ReturnValuesOnConditionCheckFailure`, `ClientRequestToken` idempotency, stream records for committed writes) — full expression language (KeyCondition, Condition, Filter, Update, Projection), GSI/LSI with projection + sparse semantics, streams (in-process), TTL (expired items hidden on read **and** deleted by a 30 s background sweep that emits the stream `REMOVE` with the TTL service identity), decimal-exact `N` arithmetic, **AWS read limits**: Query/Scan pages stop at 1 MB of examined data (before `FilterExpression`) and return `LastEvaluatedKey`, `ConsistentRead` on a GSI is a `ValidationException`, bare **reserved words** (the full 573-word list) as attribute names are rejected, and `a <> :v` is true when `a` is absent (every other comparator false) | UpdateTable, PartiQL, legacy parameters (`KeyConditions`, `Expected`, …), Streams wire API |
| SQS | CreateQueue (idempotent), GetQueueUrl, Get/SetQueueAttributes (live counters), ListQueues (`MaxResults`/`NextToken` paging), ListDeadLetterSourceQueues, DeleteQueue, SendMessage(+Batch) (`MaximumMessageSize` enforced on body + attributes), ReceiveMessage (event-driven long poll), DeleteMessage(+Batch), PurgeQueue, ChangeMessageVisibility — FIFO groups/dedup, visibility redelivery, **AWS receipt-handle semantics** (the most recent handle still deletes the message after its visibility lapsed, until the next receive; `VisibilityTimeout: 0` makes the message visible again at once), `x-amzn-query-error` compat header, MD5 digests, **queue-level redrive**: a `RedrivePolicy` (`{deadLetterTargetArn, maxReceiveCount}`) moves a message to its DLQ on the receive that would push `ApproximateReceiveCount` past `maxReceiveCount` (not the instant its visibility lapses), preserving `MessageId`/body/`MessageAttributes`/MD5s and releasing the FIFO `MessageGroupId` | Legacy Query protocol (aws-sdk v2 / old boto3 — loud error suggests `fallbackEndpoint`), `RedriveAllowPolicy`, the manual redrive API (`StartMessageMoveTask`/`ListMessageMoveTasks`/`CancelMessageMoveTask`), tags |
| S3 | Create/Head/Delete bucket, ListBuckets, GetBucketLocation, versioning flag, notification configuration (incl. legacy `CloudFunctionConfiguration` XML), ListObjectsV2 (prefix/delimiter/pagination/encoding-type), PutObject (aws-chunked decoded), **presigned POST (browser form upload: multipart/form-data, `${filename}` substitution, `success_action_status`/`success_action_redirect`, `x-amz-meta-*` fields)**, **CORS (`Put`/`Get`/`DeleteBucketCors`, preflight `OPTIONS`, `Access-Control-Allow-Origin` on responses — honors a matching bucket rule, else a dev-permissive default so browser uploads work out of the box; a bucket's CloudFormation `CorsConfiguration.CorsRules[]` is applied with `PutBucketCors` at create time, so the declared rules are live on the first boot instead of needing a bootstrap call)**, GetObject (Range, **`response-*` header overrides on presigned GET/HEAD — content-disposition/type/encoding/language/cache-control/expires**), HeadObject, DeleteObject(s), CopyObject — bodies streamed to disk blobs, never held in memory. **Bucket configuration**: Put/Get/DeleteBucketEncryption (one default-encryption rule; a bucket with none reports SSE-S3 `AES256`, as AWS does since 2023), Put/Get/DeleteBucketTagging (`NoSuchTagSet`, `InvalidTag`), Put/Get/DeletePublicAccessBlock (new buckets report all four flags on), Put/Get/DeleteBucketPolicy (stored verbatim, never evaluated). **Object system metadata**: `Content-Disposition`, `Cache-Control`, `Content-Encoding`, `Content-Language`, `Expires` and the SSE headers (`x-amz-server-side-encryption`, KMS key id, bucket key) are stored by PutObject, presigned POST and CopyObject (COPY keeps the source's content headers, REPLACE takes the request's; SSE falls back to the **destination** bucket's default) and returned by Get/Head | Multipart uploads, version stacks. Every other bucket subresource (lifecycle, ownershipControls, acl, website, logging, replication, versions, …) and object subresource (tagging, acl, retention, legal-hold, attributes, restore, select, torrent) answers `NotImplemented` (501) — it never falls through to CreateBucket, DeleteBucket or PutObject |
| EventBridge | Create/Delete/DescribeEventBus, ListEventBuses, PutRule (pattern validation), DeleteRule, Enable/DisableRule, Put/RemoveTargets, ListRules, ListTargetsByRule, PutEvents (per-entry results, pattern matching: exact, array-OR, `prefix`, `exists`, nested) | `anything-but`, `numeric`, `suffix`, `wildcard`, `cidr` pattern operators (rejected at PutRule), Archives |
| Lambda (control plane) | CreateFunction (metadata absorption), GetFunction, ListFunctions, UpdateFunctionConfiguration, DeleteFunction, Add/RemovePermission, Create/Get/List/Update/DeleteEventSourceMapping (Enabled toggle = QueueInspector hold/release), Invoke (in-process via the LSS runtime; `X-Amz-Invocation-Type` honored) | Versions/aliases, concurrency APIs |
| OpenSearch Serverless | Control plane (`aoss`): CreateCollection (deterministic ids, ACTIVE immediately), BatchGetCollection (hands out the local `collectionEndpoint`), ListCollections, DeleteCollection (id or name). Data plane under `<engine>/_aoss/<collection>`: index create/get/delete/HEAD, `_mapping` get/merge, `_doc`/`_create`/`_update` (deep merge, `doc_as_upsert`/`upsert`) with versioning, auto-create on first write, `_bulk` NDJSON with per-item results, `_search`/`_count` (`match`, `match_phrase`, `multi_match`, `term`, `terms`, `range`, `prefix`, `wildcard`, `exists`, `ids`, `bool` + `minimum_should_match`; `sort`, `from`/`size`, `_source` filtering, `?q=`), aggregations (`terms`, `avg`, `sum`, `min`, `max`, `value_count`), `_refresh`, `_cat/indices` | Security/access/lifecycle policy APIs, VPC endpoints, scripted updates, `_mget`, scroll/PIT, sub-aggregations, relevance scoring (`_score` is a constant 1), analyzers/k-NN — all rejected with an explicit OpenSearch-shaped error |
| API Gateway (REST control plane) | rest-json `apigateway`: CreateApiKey, GetApiKey (`includeValue`), GetApiKeys (`name` prefix, `customerId`, `includeValues`), UpdateApiKey (`replace` `/name` `/description` `/enabled` `/customerId`; `add`/`remove` `/stages`), DeleteApiKey (also leaves every plan), CreateUsagePlan, GetUsagePlan, GetUsagePlans (`keyId`), UpdateUsagePlan (name, description, throttle, quota, productCode, `apiStages` add/remove), DeleteUsagePlan (even with stages and keys attached), CreateUsagePlanKey / GetUsagePlanKey(s) / DeleteUsagePlanKey, GetTags / TagResource / UntagResource, GetUsage (always empty). AWS wire shapes: lists as `{"item": [...], "position"}` with a cursor that stays stable while items are deleted mid-paging (`limit` 1–500, default 25), dates in epoch seconds, key ids 10 and plan ids 6 lowercase alphanumerics, `enabled` defaulting to `false`, a provided `value` kept byte for byte (minimum 20 characters) or 40 alphanumerics generated, values unique engine-wide (`ConflictException`) while names may repeat, usage-plan keys always carrying their value, errors as `x-amzn-ErrorType` + `{message}`. `apiStages` are stored as given — an `apiId` need not exist. Backs `private: true` route enforcement in the local gateway (in-process lookup by key value, indexed — no catalog scan per request), the dashboard's **API keys** tab and the `lss_api_keys` / `lss_usage_plans` MCP tools. Packaged templates' `AWS::ApiGateway::UsagePlan` / `ApiKey` / `UsagePlanKey` are provisioned into it at registration | REST APIs, resources, methods, deployments, stages, authorizers, domain names, ImportApiKeys, UpdateUsage → `NotImplemented` (501); throttle and quota are stored, never enforced |
| SSM Parameter Store | PutParameter, GetParameter, GetParameters, GetParametersByPath, DescribeParameters, GetParameterHistory, LabelParameterVersion, DeleteParameter, DeleteParameters, AddTagsToResource, RemoveTagsFromResource, ListTagsForResource — `String`/`StringList`/`SecureString`, `Overwrite` versioning (100 versions kept), `name:version` / `name:label` selectors, `AllowedPattern`, tiers (4 KB / 8 KB, no downgrade), `DataType`, hierarchy rules (15 levels, `aws`/`ssm` reserved), `Recursive` by-path reads with filters and `NextToken` paging, per-region scoping. ARNs are `arn:aws:ssm:<region>:<account>:parameter/<name>`. Values persist in a catalog. CloudFormation `AWS::SSM::Parameter` is provisioned at registration (idempotent: an existing parameter is never overwritten) | KMS (`KeyId` accepted and echoed, default `alias/aws/ssm`), parameter policies (`Policies` always `[]`), UnlabelParameterVersion, public `/aws/service/…` parameters, every non-Parameter-Store SSM API (Run Command, Session Manager, documents, inventory…) |
| SNS | CreateTopic, ListTopics, DeleteTopic, GetTopicAttributes, Publish (logged + counted, no fan-out) | Subscriptions and delivery |
| STS | GetCallerIdentity | Everything else |
| Secrets Manager | CreateSecret, GetSecretValue, PutSecretValue, UpdateSecret, DescribeSecret, DeleteSecret (recovery window + `ForceDeleteWithoutRecovery`), RestoreSecret, ListSecrets, TagResource/UntagResource, GetRandomPassword — real `AWSCURRENT`/`AWSPREVIOUS` version staging, `SecretString`/`SecretBinary`, `ClientRequestToken` idempotency, per-region scoping. Values persist in a catalog (not encrypted locally). Browsable in the dashboard's **Secrets** tab (list, version stages, reveal value). Secrets are populated before the first read by two boot paths — CloudFormation `AWS::SecretsManager::Secret` provisioned at registration, and **boot seeds** (see below) | Rotation scheduling/Lambda, replication, KMS encryption (`KmsKeyId` accepted and ignored), resource policies |

### Eventing (delivered in-process to the LSS Lambda runtime)

Every wiring below works **without an invoke port**: when a service declares no
`invokePort`, the function is still recorded in the Lambda control plane (with
no `INVOKE_URL`) and the dispatcher delivers through the in-process function
registry. The `INVOKE_URL` HTTP hop is only a fallback for functions LSS does
not run itself.

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
  A `PutRule` against a **custom bus that does not exist yet** — the normal
  outcome when a consumer is registered before the stack that owns the bus —
  does not silently drop the rule: the provisioner parks it, tells the caller
  what it is waiting for (a `warnings[]` entry on the register response) and
  provisions it as soon as that bus is created. Registration order is whatever
  the operator typed, so requiring them to know the dependency graph would be
  the wrong fix.

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

## Fallback endpoints

Requests for a service the engine does not emulate can be forwarded verbatim to
another AWS-compatible endpoint. `selfEngine.fallbackEndpoints` maps a SigV4
signing name to a URL (`{ "kinesis": "http://localhost:4567", "iam":
"http://localhost:4568" }`) and wins over `selfEngine.fallbackEndpoint`, the
catch-all, which `LSS_FALLBACK_ENDPOINT` can also set. Unsigned calls carry no
signing name, so only the catch-all applies to them; legacy SQS Query calls use
the `sqs` entry. Proxied responses are cleaned up on the way back: single-valued
headers such as `Date` keep only their first value — an upstream that sends
`Date` twice would otherwise reach the SDK as one joined header and break its
clock-skew correction from the second call on. Operation-level gaps inside an
emulated service are never forwarded.

## Resetting the engine

`lss reset` (or `POST /_lss/reset` with the header `x-lss-confirm-reset: true`)
empties every emulator in place — tables and items, queues and messages, buckets
and objects, topics, buses and rules, secrets, parameters, OpenSearch
collections, Lambda metadata and event source mappings — without restarting the
process or rebinding the port. It works in persistent mode (the contents of the
engine data dir are deleted; a directory that looks like a project or home dir
is refused) and in memory. The route only answers loopback clients, and the
custom header forces a CORS preflight it never answers, so a web page in the
developer's browser cannot trigger it. Requests that arrive during a reset wait
for it to finish. Registered services stay registered: `lss register` puts their
resources back.

`POST /_lss/reset?service=<name>` empties a single emulator and leaves the rest
untouched. Only emulators whose state nothing else depends on accept it — today
`apigateway` (the others share state with the delivery loops: mappings,
schedules, stream tailers); any other name answers 400 `InvalidParameterValue`
naming the supported ones.

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
- DynamoDB: index queries answer from the base table (correct semantics,
  dev-scale performance). The TTL sweep deletes expired items within about 30 s
  (AWS takes up to a few days); a dehydrated table without a stream is not
  rehydrated just to delete — its expired items stay hidden from reads.
- SQS legacy Query protocol (pre-JSON SDKs) is not served natively — use
  `fallbackEndpoint`.
- SQS: queue-level redrive is enforced, but the DLQ must live in the same
  account/region (only the queue name in `deadLetterTargetArn` is read).
  `RedriveAllowPolicy` is stored and returned, never enforced, and the manual
  redrive API (`StartMessageMoveTask` and friends) is not implemented — drain a
  DLQ with ReceiveMessage/SendMessage instead.
- S3: encryption is reported, not performed — bytes are stored unencrypted on
  disk, but every object reports its encryption (`AES256` by default, or the
  bucket's default rule) exactly as AWS does. KMS key ids are echoed as given.
  Bucket policies and Public Access Block flags are stored, never enforced.
- SSM: `SecureString` is not encrypted. `WithDecryption: true` returns the
  value; without it the engine answers a deterministic opaque token (stable per
  name/version/value, never the plaintext) in place of the ciphertext.
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
