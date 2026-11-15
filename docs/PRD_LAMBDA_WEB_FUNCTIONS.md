# PRD — Lambda Web Functions on the LSS runtime

| | |
|---|---|
| **Status** | Ready for implementation |
| **Date** | 2026-11-15 |
| **Area** | CFN parser + physical values, a new web-function manager and HTTP front, registrar, dashboard, `LssClient`, MCP |
| **Branch** | `feat/lambda-web-functions` |
| **Release** | minor — `1.3.0 → 1.4.0` (second of three planned PRs; see §12) |
| **Related docs** | [PRD_API_LAMBDA_EMULATION.md](PRD_API_LAMBDA_EMULATION.md), [FEATURES.md](FEATURES.md), [CONFIGURATION.md](CONFIGURATION.md) |

---

## 1. Context

In October 2026 AWS launched **Lambda Web Functions**, a second Lambda function type (the original
one is now called an *Event Function*). A web function runs an **ordinary HTTP server** — Express,
Fastify, Koa, Next.js, plain `node:http` — with no handler signature and no event-to-HTTP adapter.
Lambda starts the process, waits for it to listen, and proxies HTTPS traffic from a managed endpoint
to it, many requests per execution environment at once.

LSS already replaces `serverless-offline` for event functions (its own runtime workers plus the
API Gateway emulation). A service that adopts web functions today gets nothing locally: the resource
types are dropped by the parser, nothing starts the server, nothing serves the URL, and anything that
references the endpoint (`!GetAtt Endpoint.DomainName` in another function's environment) resolves
to garbage.

## 2. What AWS shipped (the contract to emulate)

Sources: Lambda Developer Guide (*Web Function runtimes*, *Execution environment lifecycle*), CFN
Template Reference (the three resource types below), the Serverless Framework v4 *Web Apps* guide.

### 2.1 Resources (CloudFormation)

| Type | Role | Key properties | Return values |
|---|---|---|---|
| `AWS::Lambda::WebFunction` | The container; serves nothing on its own | `FunctionName`, `Tags` | `Ref` → ARN (`arn:aws:lambda:<r>:<acct>:web-function/<name>`); `FunctionArn`, `State`, … |
| `AWS::Lambda::WebFunctionRevision` | Immutable code + config | `FunctionName`, `BuildConfig.CodeConfig.S3Object{Bucket,Key}`, `BuildConfig.RuntimeConfig.Runtime` (`nodejs24.x`), `ServiceConfig{ExecutionRoleArn, EnvironmentVariables, TimeoutSeconds 3..900 (30), MaxConcurrencyPerEnvironment 1..128 (64), TelemetryConfig, EgressNetworkConnectorArn}`, `Description`, `KmsKeyArn` | `Ref` → revision ARN; `RevisionId`, `RevisionArn`, `FunctionArn` |
| `AWS::Lambda::WebFunctionEndpoint` | HTTPS URL routing to ≤ 2 revisions | `FunctionName`, `EndpointName`, `EndpointType` (`HomeRegion`/`MultiRegion`/`PerRegion`), `AuthType` (`ApplicationManaged`/`IamAuth`), `RevisionWeights[{RevisionId, Weight}]`, `ScalingConfig`, `ThrottleConfig`, `Regions` | `Ref` → endpoint ARN; `DomainName`, `EndpointArn`, `RegionalEndpoints`, `State`, … |

### 2.2 Runtime contract

- Lambda loads `index.js` from the package root, or the file named by `AWS_LAMBDA_NODEJS_ENTRYPOINT`.
- The server must listen on the `host:port` in **`AWS_LAMBDA_HTTP_ENDPOINT`** (Lambda chooses it),
  and must start listening **within 10 s** or initialisation fails.
- Readiness = "the port accepts connections". There is no health-check path.
- Every forwarded request carries a **`lambda-web-request-id`** header, echoed on the response.
- Each request is bounded by `TimeoutSeconds`. Up to `MaxConcurrencyPerEnvironment` requests share
  one process (one Node event loop).
- Shutdown: stop routing → let in-flight requests finish (best effort) → `SIGTERM` → **1 s** →
  terminate.
- TLS is terminated at the endpoint; the app speaks plain HTTP.
- The Serverless Framework (v4, `webApps:` key) additionally sets `PORT`, `HOSTNAME` and
  `AWS_LAMBDA_NODEJS_ENTRYPOINT` for the app, and `serverless dev` runs `dev.command` locally.

> The bundled examples package with `osls` 4.0.0, which has no `webApps:` support. Services written
> for it declare the three resources directly under `resources.Resources`, which `osls` passes through
> untouched. That makes **the CloudFormation template the canonical input** for LSS; reading
> `serverless-state.json`'s `webApps` (Framework v4) is an additive extra.

## 3. Goals

1. Discover web functions from the packaged template (and from `serverless-state.json` `webApps` when
   present) at register time, with no extra manifest.
2. Run each one as a real child process honouring §2.2: entry resolution, `AWS_LAMBDA_HTTP_ENDPOINT`,
   10 s readiness, per-request timeout, concurrency cap, `lambda-web-request-id`, SIGTERM + 1 s.
3. Serve every endpoint on a **stable local URL**, streaming in both directions (SSE, chunked uploads
   and long polls must work — the whole point of web functions is "a normal web server").
4. Resolve `Ref` / `Fn::GetAtt` of the three types, so other functions' environment variables that
   point at a web endpoint get the local URL.
5. Same developer ergonomics as event functions: lazy start, idle unload, hot reload, logs, recent
   requests and activity in the dashboard, `LssClient` and MCP access.
6. Proven through `examples/self-hosted` and a `wire-*`-style test against a real server process.

### Non-goals

- The Lambda **control plane** for web functions (`CreateWebFunction`, `aws lambda-web deploy`, …) in
  the `lambda-ctl` emulator. Services deploy through CloudFormation; LSS reads the template.
- `MultiRegion` / `PerRegion` semantics (every endpoint is served once, locally).
- VPC network connectors, KMS, telemetry config, `ScalingConfig`, multiple execution environments
  per revision (one local process per revision; overflow queues — see §4.4).
- CloudFront-origin integration.

## 4. Design

### 4.1 Parsing — `cloudformation-parser.ts`, `cfn-physical-values.ts`

- Three new switch arms producing `WebFunctionResource`, `WebFunctionRevisionResource`,
  `WebFunctionEndpointResource` (raw-ish, intrinsics resolved the way the Lambda arm does). Add them to
  the `Resource` union and give **both** provisioner switches an explicit arm (see 4.2) so the union
  stays exhaustive.
- `cfn-physical-values.ts`:
  - `Ref` WebFunction → `arn:aws:lambda:<region>:000000000000:web-function/<name>`.
  - `Ref`/`RevisionArn` Revision → `<function-arn>/revision/<RevisionId>`; `RevisionId` → a stable
    id derived from the logical id + code key (deterministic across boots).
  - `DomainName` Endpoint → `localhost:<port>` (see 4.3), `EndpointArn` → `<function-arn>/endpoint/<name>`.
  This is what makes `URL: !Sub 'https://${Endpoint.DomainName}'` in a sibling function usable —
  with one caveat to document: the scheme in the template says `https`, the local listener is `http`.
  Offer an opt-in rewrite (`webFunctions.rewriteHttpsInEnv`, default **on**) that turns
  `https://localhost:<webPort>` into `http://…` inside environment values only.

### 4.2 Assembly — new `services/web-function-assembler.ts`

Pure function, same spirit as `raw-api-assembler.ts`: takes the parsed resources (+ optional
`serverless-state` `webApps`) and returns `RegisteredWebFunction[]`:

```ts
interface RegisteredWebFunction {
  service: string;
  name: string;                 // FunctionName as declared
  logicalId: string;
  revisions: WebRevision[];     // runtime, env, timeoutSeconds, maxConcurrency, code: CodeLocation
  endpoints: WebEndpoint[];     // name, authType, weights: [{revisionId, weight}]
  warnings: string[];           // unsupported runtime, dangling revision ids, weights ≠ 100, …
}
```

**Code location resolution**, in order, first hit wins — each choice recorded so the dashboard can
show *why*:

1. `serverless-state.json` `webApps.<name>.entry` (Framework v4) — source mode, entry is explicit.
2. `S3Object.Key` basename matching a zip in the service's `.serverless/` (artifact mode — unzip into
   the cache exactly like `lambda-runtime-manager.ts` does for event functions).
3. Source mode fallback: the service root, entry = `AWS_LAMBDA_NODEJS_ENTRYPOINT` from the revision's
   environment, else `index.js`.

Respect the existing `LambdaExecutionMode` (`auto | artifact | source`) and the artifact-staleness
check (`artifact-staleness.ts`) — a stale zip is the same trap for web functions.

The provisioner gets a pass that hands the assembled list to the manager on register and tears it
down on unregister (nothing is created in the engine).

### 4.3 The front door — new `services/web-function-gateway.ts`

- One HTTP listener **per endpoint**, on a stable port. Allocation: config
  `services.<svc>.webFunctions.<fn>.<endpoint>.port` if set; otherwise the next free port in
  `webFunctions.portRange` (default `15000–15999` — clear of the orchestrator's `14566`, the 30xx API
ports, the 130xx invoke ports and Linux's ephemeral range), **persisted in the service cache** so the URL
  survives restarts and re-registers. Bound through `bind-host.ts` like every other listener.
- For each request: pick the revision by weight (a `x-lss-web-revision: <revisionId>` request header
  pins one, which makes canary splits testable), ensure its environment is ready, then **pipe** the
  request to `AWS_LAMBDA_HTTP_ENDPOINT` and the response back — no buffering, so streaming works.
  Add `lambda-web-request-id` (UUID) to the upstream request and the downstream response, plus
  `x-forwarded-for` / `x-forwarded-host` / `x-forwarded-proto` (`https`, matching what the app sees on
  AWS behind TLS termination — document this).
- Per-request timeout = `TimeoutSeconds`: destroy the upstream socket; answer **504** if headers were
  not yet sent, otherwise abort the connection. Upstream connect failure or crash mid-request → **502**.
- `AuthType: IamAuth`: require a SigV4 `Authorization` header (reuse `engine/http/sigv4.ts` parsing;
  signature verification follows the engine's existing credential policy) → **403** otherwise.
  `ApplicationManaged`: pass through.
- Body errors (the 502/503/504 LSS itself generates) carry a small JSON body naming LSS as the
  source, so nobody confuses them with the app's own errors.

### 4.4 Execution environments — new `services/web-function-manager.ts`

One **environment = one child process** per *(service, function, revision)*, started lazily.

- Spawn `node` on the resolved entry with: the revision's `EnvironmentVariables`; the same AWS
  plumbing env every LSS worker gets (`buildWorkerEnv` in `worker-runtime.ts` — endpoints pointed at
  the engine, region, dummy credentials); `AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:<free inner port>`;
  `AWS_LAMBDA_NODEJS_ENTRYPOINT`; and `PORT` / `HOSTNAME` mirroring the Framework (so apps written
  for `serverless dev` work unchanged). TypeScript entries load through the **same loader strategy
  `runtime/runtime-worker.ts` already implements** (native TS → tsx → esbuild-register); don't
  invent a second one.
- Readiness: poll a TCP connect to the inner port (e.g. every 50 ms) until it succeeds; give up at
  **10 s**, kill the process, log the reason, fail the waiting requests with 502. Requests that arrive
  while starting wait on the same promise (cold start counted once).
- Concurrency: at most `MaxConcurrencyPerEnvironment` in flight; extra requests **queue** (bounded,
  e.g. 4 × the cap; beyond that → 503). On AWS more environments would spin up — locally one process
  keeps the footprint predictable. Document the divergence.
- Lifecycle: idle unload after the same idle window event-function workers use; hot reload on source
  change (`source-watcher.ts`); unregister/shutdown. All three run the AWS sequence: stop routing →
  drain in-flight (bounded) → `SIGTERM` → 1 s → `SIGKILL`. A process that exits unexpectedly is marked
  dead and restarted on the next request.
- Footprint at the scale target (40 services): nothing runs until a URL is hit; a running web
  function costs one Node process — no per-function timers beyond the idle check the manager already
  shares.

### 4.5 Observability

- stdout/stderr → the same log capture used for event functions (`runtime/log-capture.ts`), keyed
  `web:<service>/<function>`. Which request a log line belongs to is not knowable when many requests
  share one process, so logs stay per-process and the recent-request list sits next to them.
- Each proxied request records an `InvocationSpan` in `invocation-activity.ts`
  (`functionName = <name>`, `ok = status < 500`, `coldStart` when it waited for a start), so the
  stack-wide activity and concurrency charts include web traffic.
- A small per-function ring of recent requests (`method, path, status, ms, revisionId, requestId`).

### 4.6 HTTP API, client, MCP, dashboard

- Routes: `GET /api/lambdas/web` (list: service, name, endpoints + URLs, revisions, state, code
  source), `GET /api/lambdas/web/:service/:name` (detail + recent requests + logs),
  `POST /api/lambdas/web/:service/:name/restart`.
- `LssClient`: `client.lambdas.web.list()`, `.get(service, name)`, `.restart(...)`.
- MCP: `lss_web_functions` (list with URLs) and `lss_web_request` (send an HTTP request to an endpoint
  and return status/headers/body — lets an agent exercise the app).
- Dashboard: Lambdas page gains a *Web functions* section (badge "Web", URL with open/copy, state
  cold/starting/ready/error); a detail page with endpoints, revisions and weights, environment state,
  recent requests and logs. **TreeUI only** (`src/ui/ui-ux.md`), strings in en / pt-BR / es.

### 4.7 Configuration — `config-manager.ts`, `docs/CONFIGURATION.md`

`webFunctions.portRange`, `webFunctions.rewriteHttpsInEnv`, `webFunctions.queueFactor`, per-endpoint
`port` override. Defaults must make a zero-config service work.

## 5. Example — `examples/self-hosted`

Extend an existing service (keep the "four microservices" shape) with a web function written on
**plain `node:http`** — no new dependency, so no lockfile change. Suggested: `orders-service` gets an
`orders-web` app serving a tiny HTML status page plus `GET /api/orders/:id` (reads the orders table
through the SDK the runtime lends) and `GET /api/stream` (SSE, emits three events) to prove streaming.
Declared as raw `AWS::Lambda::WebFunction` + `…Revision` + `…Endpoint` under `resources.Resources`,
with `AWS_LAMBDA_NODEJS_ENTRYPOINT` pointing at the file. Add an event function in the same service
whose environment carries `!GetAtt OrdersWebEndpoint.DomainName`, and have it call the web app — that
proves §4.1's resolution end to end. Extend the demo task and the integration suite with assertions
on status, body, `lambda-web-request-id`, and the SSE event count.

## 6. Fixtures

- `tests/fixtures/web-functions-template.json` — the three resources in all their spellings
  (`Fn::GetAtt` array and dotted string, `Ref` FunctionName, two weighted revisions, `IamAuth`).
- `tests/fixtures/runtime/web/` — tiny servers: listens correctly; never listens (readiness timeout);
  listens late (9 s — keep the test fast with an injectable deadline); crashes on a path; streams;
  sleeps past the timeout; ignores SIGTERM (proves the 1 s kill).
- A `serverless-state.json` fragment with `webApps` for the Framework v4 path. Mark it in a comment as
  **derived from the published docs**, to be replaced by a real `serverless package` output when one is
  available.

## 7. Tests (100 % coverage gate applies)

- Parser arms and physical values (every return value in §2.1).
- Assembler: resolution order, warnings (weights not summing to 100, revision of another function,
  unsupported runtime, missing code).
- Manager: spawn env contents, readiness success/timeout, queueing and 503 overflow, crash → restart,
  idle unload, SIGTERM-then-SIGKILL, hot reload.
- Gateway: weighted pick + header pin, request-id echo, x-forwarded-*, timeout 504 vs mid-stream
  abort, 502 on crash, `IamAuth` 403, streaming (SSE chunks arrive before the response ends).
- `tests/unit/services/wire-web-function.test.ts` (or under `engine/` if it needs the backend) —
  register a fixture service, hit the real URL, read DynamoDB through the engine from inside the app.
- Routes, client and MCP tests mirroring their neighbours.

## 8. Documentation (AGENTS.md rule 4)

- `README.md` — feature entry under *Lambda runtime & API Gateway emulation*.
- `docs/FEATURES.md` — rows for discovery, runtime, front door, `Ref`/`GetAtt`, dashboard/client/MCP.
- `docs/CONFIGURATION.md` — the new keys.
- `docs/SELF_ENGINE.md` — only the `Ref`/`GetAtt` resolution if it lands in engine code; otherwise
  state explicitly in the PR description that the engine is untouched.
- *Known divergences*: one environment per revision (queue instead of scale-out), `http` locally vs
  `https` on AWS, single region, no control plane.
- `CHANGELOG.md` — `## [1.4.0]` *Added*.

## 9. Acceptance

- [ ] `validate: pre-prod` green.
- [ ] The example's web app answers on its stable URL after a cold boot, survives an orchestrator
      restart on the same port, and reloads on a source edit.
- [ ] SSE events arrive incrementally; a request past `TimeoutSeconds` gets 504; a server that never
      listens fails with a clear log line after 10 s.
- [ ] The sibling event function reaches the web app through the URL resolved from `DomainName`.

## 10. Work breakdown (suggested commit-sized steps)

1. Fixtures + parser arms + physical values.
2. Assembler (+ code resolution, warnings).
3. Manager (spawn, readiness, lifecycle).
4. Gateway (ports, proxy, timeout, auth, weights).
5. Registrar/provisioner wiring, hot reload, activity + logs.
6. Routes, client, MCP.
7. Dashboard + i18n.
8. Example + integration assertions.
9. Docs, CHANGELOG, version `1.4.0` (edit `package.json` and the lockfile's two root `version` fields
   by hand).

## 11. Open questions to settle during implementation

- Exact env-var set AWS injects besides `AWS_LAMBDA_HTTP_ENDPOINT` (function name, region, memory…):
  the guide's *Environment variables* page under *web-functions-configuration* is the source; mirror
  what it lists, nothing invented.
- What AWS answers on `IamAuth` failure and on timeout (status + body). Until confirmed, keep LSS's
  bodies clearly labelled as LSS's.

## 12. Coordination with the two sibling PRs

Order: **(A) DynamoDB vector search → (B) this PR → (C) stack map + README cards**. This PR rebases on
A after A merges (conflicts limited to `README.md`, `docs/*.md`, `CHANGELOG.md`, `package.json`, the
parser's union/switch). PR C will add a `web-function` node kind to the wiring graph **after** this PR
merges, so **don't** touch `service-graph.ts` or `src/ui/src/components/graph/**` here.
