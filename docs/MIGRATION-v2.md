# Migrating to LSS v2

**v2 removes the LocalStack backend.** The self engine — the in-process AWS
emulator LSS has shipped since v0.10 — is now the only engine. No Docker, no
container image, no `LOCALSTACK_AUTH_TOKEN`, no Pro plan.

This is not a deprecation: the code is gone. A configuration that still asks for
LocalStack fails at boot with a message pointing here, rather than silently
running against something you did not ask for.

---

## Why

The self engine was already the default recommendation and, as of v0.18, it ran
**every capability both shipped LocalStack examples exercised** — REST and HTTP
API routes, Lambda authorizers (including cross-service ones), DynamoDB with
composite keys / GSIs / streams / seeds, SQS with DLQ redrive, EventBridge buses
and pattern rules, `rate()` schedules, S3 notifications with prefix filters,
Secrets Manager and OpenSearch Serverless. Keeping a second backend meant:

- a Docker + auth-token dependency on the critical path of a tool whose reason
  for existing is running large stacks on small machines;
- an integration suite that **skipped itself** unless you had a LocalStack Pro
  token, so the only end-to-end coverage the project had usually did not run;
- two code paths for every explorer, every config key and every dashboard
  screen — and the dashboard told self-engine users they were running LocalStack.

v2's integration suite runs **on every machine and in every CI job**: no Docker,
no token, ~20 seconds.

---

## What to change

### 1. Configuration

Delete these keys — they are rejected as unknown on `PUT /api/config`, and
`engine: "localstack"` aborts the boot:

| Removed | Replacement |
|---|---|
| `engine` | none — there is one engine (drop the key; `"self"` is tolerated) |
| `mode` (`managed` / `external`) | none |
| `localstackPort`, `localstackEndpoint` | `serverPort` / `selfEngine.port` — both default to `14566`, and being equal is what puts the dashboard, the REST API and the AWS wire on **one** listener |
| `localstackEdition`, `localstackVersion`, `localstackImage` | none |
| `localstackAuthToken` | none |
| `services` | none — the engine serves its full set; see `GET /api/health` → `engine.services` |
| `aossSidecar` | none — OpenSearch Serverless is native to the engine |

Before:

```jsonc
{
  "serverPort": 3100,
  "engine": "self",
  "mode": "managed",
  "localstackPort": 4566,
  "localstackEdition": "community",
  "services": ["dynamodb", "sqs", "sns", "s3", "lambda", "events"],
  "selfEngine": { "port": 14566 }
}
```

After:

```jsonc
{}
```

That is not a typo: every key above is now a default. The stack answers on
`14566` — dashboard, REST API and AWS wire — so `AWS_ENDPOINT` and the browser
URL are the same. Keep two listeners by giving `serverPort` and
`selfEngine.port` different values.

### 2. Environment variables

Removed: `LSS_LOCALSTACK_PORT`, `LSS_LOCALSTACK_ENDPOINT`, `LSS_LOCALSTACK_MODE`,
`LSS_LOCALSTACK_EDITION`, `LSS_LOCALSTACK_VERSION`, `LSS_LOCALSTACK_IMAGE`,
`LOCALSTACK_AUTH_TOKEN`, `LSS_SERVICES`. `LSS_ENGINE` is accepted only as `self`.

Still there, and now the fastest way to run a second instance:

```bash
LSS_DASHBOARD_PORT=3250 LSS_ENGINE_PORT=14766 \
  LSS_ENGINE_DATA_DIR=/tmp/lss-run-7/engine npx lss start
```

### 3. CLI

| Removed flag | What to do |
|---|---|
| `--self-engine` | drop it — it is the only mode |
| `--external` | drop it |
| `--pro` | drop it |
| `--localstack-token <token>` | drop it |

Each one now exits 1 with a message naming this file, so a stale script fails
visibly instead of quietly starting the wrong thing.

### 4. Service endpoints

Point your handlers' AWS endpoint at the stack's port (default `14566`) instead
of `4566` — the same port the dashboard uses:

```yaml
provider:
  environment:
    AWS_ENDPOINT: http://localhost:14566
```

The engine's default port sits outside `4566–4599` on purpose: a real LocalStack
install intercepts that whole range on some hosts, and your machine may still
have one.

### 5. API and client

| Field | Change |
|---|---|
| `GET /api/health` → `localstack` | removed — use `engineRunning` (`engine.kind` is always `"self"`) |
| `GET /api/config` → `localstack` block | removed — `engine.endpoint` is the AWS endpoint |
| `GET /api/config` → `aossSidecar` | removed |
| `GET /api/config` → `services` | removed — `GET /api/health` → `engine.services` |
| `LssClient` `HealthStatus.localstack` | removed — use `engineRunning` |
| `LssClient` `lifecycle.start({ external, pro, localstackToken })` | removed |

### 6. The `serverless-lss` plugin is retired

v2 removes the Serverless Framework plugin entirely — services no longer
announce themselves from inside `sls package`. Migration:

1. Delete `serverless-lss` from each service's `devDependencies`.
2. Remove the `plugins: - serverless-lss` entry and the whole
   `custom.orchestrator` block from each `serverless.yml`.
   **Keep `custom.lss`** — it is now read by the orchestrator itself, from the
   packaged `serverless-state.json`.
3. Register through the orchestrator instead:
   - `npx lss scan` — lists every Serverless/osls service under the project
     root, with packaged/registered flags;
   - `npx lss register [path...]` — registers them (with `autoPackage` the
     orchestrator runs the package command when the template is missing);
   - or open the dashboard: the first visit with no services starts a guided
     onboarding (ports → branding → project scan with tick-to-register),
     reopenable later from Settings;
   - or `POST /api/services/register { servicePath }` /
     `LssClient.services.register` from automation.

`serverless-offline` compatibility went with it: `custom.serverless-offline`
ports are no longer read (declare `custom.lss.apiPort`/`invokePort` instead),
and registration no longer fires on `sls offline` — v1's plugin was the only
piece that ever did.

### 7. Examples

`examples/localstack-free` and `examples/localstack-ultimate` are gone.
[`examples/self-hosted`](../examples/self-hosted/) is the example: four
microservices exercising DynamoDB, SQS with DLQ redrive, S3, EventBridge,
OpenSearch Serverless and Secrets Manager.

The raw `AWS::ApiGatewayV2::*` cross-stack topology that lived in
`localstack-free/gateway-stack` moved to
`tests/integration/fixtures/apigw-raw/`, where its end-to-end test still runs.

---

## What did *not* change

Everything else. The wire API is the seam, so the provisioner, explorers, seeds,
the Lambda runtime, the gateway emulation, the dashboard, the `LssClient` and
the MCP server all behave exactly as they did.
A project that already ran on `engine: "self"` needs only the config keys
trimmed.

---

## If you still need LocalStack

Pin `local-serverless-stack@^0.18` — the last line that ships both engines.

If a specific AWS operation is missing from the self engine, prefer
`selfEngine.fallbackEndpoint`: it reverse-proxies the operations the engine does
not implement to any AWS-compatible endpoint you point it at, including a
LocalStack container you run yourself. That keeps the gap narrow instead of
bringing back a second backend. The coverage matrix and every known divergence
are in [SELF_ENGINE.md](SELF_ENGINE.md).
