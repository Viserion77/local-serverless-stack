# Agent instructions — Local Serverless Stack (LSS)

> **This is the single source of truth for every AI coding agent working in this repo.**
> `CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file —
> edit **this** file, never the symlinks.

---

## The project in one paragraph

LSS is a **local control plane for serverless development**. One orchestrator provisions and serves
every AWS resource your services declare, so a monorepo of 15+ microservices needs a single local
stack instead of one emulator per service. The AWS provider is the **self engine**: an in-process
emulator — no Docker, no container, no auth token — and since 1.0 the only engine LSS ships. It also
replaces `serverless-offline` with its own Lambda runtime
and API Gateway emulation.

Published as the single npm package `local-serverless-stack` (CLI: `lss`). Services join the stack
through the orchestrator itself — `lss scan` / `lss register`, the dashboard onboarding or
`POST /api/services/register` — there is no Serverless Framework plugin anymore (the `serverless-lss`
package was retired in 1.0). Node **>= 20**, CommonJS, npm workspaces (`src/ui`).

---

## Repo map

| Path | What lives there |
|---|---|
| `src/server/` | The orchestrator: `index.ts` (boot), `routes/` (HTTP API), `services/` (registrar, CFN parser, provisioner, seeds, gateway/lambda managers), `runtime/` (Lambda workers), `dev/` |
| `src/server/engine/` | **The self engine.** `emulators/` (dynamodb, sqs, sns, s3, events, secretsmanager, opensearch, lambda-ctl, sts), `dispatch/` (stream-tailer, sqs-poller, scheduler, dispatcher), `store/` (JSONL snapshot + WAL), `http/` (router, sigv4, protocols), `bus.ts` |
| `src/client/` | `LssClient` — the programmatic API |
| `src/mcp/` | MCP server (`lss mcp`) — the stack as tools for an AI coding agent |
| `src/ui/` | Vue 3 dashboard (own workspace) |
| `examples/` | `self-hosted` — four microservices on the engine (DynamoDB, SQS, S3, EventBridge, OpenSearch, Secrets) |
| `tests/` | `unit/`, `integration/` (self engine, no Docker, no token), `fixtures/` |
| `docs/` | `FEATURES.md`, `SELF_ENGINE.md`, `CONFIGURATION.md`, `RELEASE.md`, PRDs |

---

## Non-negotiables

### 1. Never touch git history or the remote

**You do not commit. You do not create branches. You do not push.** The human reviews and commits.

- Leave your work as **uncommitted working-tree edits**. Do not stage it either — whoever
  orchestrates you (or the human) runs `git add` and reviews the staged diff.
- Read-only git (`status`, `diff`, `log`) is fine. Every git **write** is off-limits.
- Never run `git add`, `commit`, `reset`, `stash`, `checkout`/`restore`, `rebase`, `merge`, `pull`,
  `fetch`, `push`, `tag`, `branch`, or `clean` — **under any rationale**, including "to get a clean
  tree" or "to isolate my diff".
- Do not run `npm install`, `npm ci` or `npm version` (they rewrite lockfiles and package manifests).

This rule exists because agents have violated it here before — one committed unreviewed work and
pushed it to the public GitHub remote. A dirty working tree is **normal and intentional**; work with
it, don't "clean" it.

### 2. The `validate: pre-prod` gate is the definition of done

Nothing is finished until this passes. It is the task of the same name in `.vscode/tasks.json`, and
it mirrors CI. Shell equivalent:

```bash
npm run lint \
  && npx tsc --noEmit -p src/server/tsconfig.json \
  && npx tsc --noEmit -p src/client/tsconfig.json \
  && npx tsc --noEmit -p src/mcp/tsconfig.json \
  && (cd src/ui && npx vue-tsc --noEmit) \
  && npm run test:coverage \
  && npm run build
```

Running only `jest` + `server:build` is **not** sufficient — it misses lint, `vue-tsc`, and the
UI/client/MCP builds.

### 3. 100% coverage, globally

`jest.config.js` sets `coverageThreshold.global` to **100** for statements, branches, functions and
lines. New code ships with the tests that cover every branch, or the gate fails. Never lower the
threshold and never paper over a gap with `/* istanbul ignore */` unless the line is genuinely
unreachable — and then say so explicitly in the comment, as existing ones do.

### 4. Keep the inventory alive

Every new capability MUST be documented in **all** of:

- `README.md` (the feature list)
- `docs/FEATURES.md` (the canonical inventory)
- `docs/SELF_ENGINE.md` (whenever it touches the self engine)

A feature that isn't listed is treated as a feature that doesn't exist. Updating these is part of
shipping the change, not an afterthought.

### 5. Validate through the examples

End-to-end proof lives in `examples/`, not in ad-hoc scripts:

- `examples/self-hosted` — four microservices on the self engine (DynamoDB, SQS, S3, EventBridge). The default target.

A new engine capability should gain (or extend) a fixture in one of these plus an assertion. When a
full boot e2e isn't practical, drive the real backend from a `tests/unit/engine/wire-*.test.ts`
instead — that's the established pattern.

---

## Commands

```bash
npm run build          # ui + server + client + mcp
npm run server:build   # tsc for orchestrator + engine only
npm run dev            # tsx watch (server) + vite (UI)
npm test               # jest, unit suite
npm run test:coverage  # unit suite + the 100% gate
npm run test:integration   # e2e on the self engine — no Docker, no token; run `npm run build` first
npm run lint           # eslint (see the warning baseline below)
```

The `.vscode/tasks.json` palette wraps these plus one-command example demos
(`example self-hosted: demo completo` boots the stack, registers the services and drives the
pipeline — the fastest way to see the self engine work).

---

## Testing conventions

- Unit tests mirror the source tree: `tests/unit/services/…`, `tests/unit/engine/…`,
  `tests/unit/routes/…`. Match the neighbouring file's mocking style before inventing your own.
- `tests/unit/engine/wire-*.test.ts` drive a **real `SelfEngineBackend`** end to end (through the
  AWS SDK) rather than mocks — use this shape when proving a provisioning/dispatch behaviour.
- `tests/integration/` boots an isolated orchestrator on the self engine (own ports + `stateDir`) and
  drives it over HTTP. It runs **unconditionally** — no Docker, no auth token, nothing to gate on, so
  a skip there is a real problem, not the old 0.x "no token, never mind". `client.test.ts` imports the
  **built** `dist/client`, so run `npm run build` before `npm run test:integration`.
- `tests/fixtures/` holds committed CloudFormation templates and sample microservices.

## Code conventions

- TypeScript, **NodeNext ESM-style imports with `.js` extensions** in server source
  (`import { Foo } from './foo.js'`) — ts-jest maps these back to the TS sources.
- Match surrounding style: these files are heavily commented with the *why* (AWS semantics, edge
  cases, PRD references). Keep that density; explain AWS-faithful behaviour and its defaults.
- Emulators must answer with **AWS-shaped errors** (correct `__type`/exception names) — the
  provisioner and the SDKs depend on them.
- Provisioning steps are **idempotent and non-fatal**: swallow the "already exists" exception, warn
  and continue rather than aborting a boot.

## Engine orientation

- The CFN parser (`src/server/services/cloudformation-parser.ts`) turns a packaged template into
  typed resources; unknown types are dropped, so adding support means a new switch arm **and** a
  provisioner pass.
- HTTP routes come from `serverless-state.json` (function events) via `serverless-state-parser.ts`,
  and from raw `AWS::ApiGatewayV2::*` resources via `raw-api-assembler.ts` — the two are de-duplicated
  by `(method, normalized path)` with state routes winning.
- Event delivery is in-process: `dispatch/stream-tailer.ts` (DynamoDB Streams → Lambda),
  `dispatch/sqs-poller.ts` (SQS → Lambda), `bus.ts` + `dispatch/dispatcher.ts` (S3 notifications,
  EventBridge rules). Honour ESM semantics: `FilterCriteria`, `ReportBatchItemFailures`,
  `maximumRetryAttempts` (AWS default `-1` = retry until the record ages out).

## Known gotchas

- **Lint has a large pre-existing warning baseline** (~2.9k warnings, **0 errors**). The bar is
  *zero errors* and no new ones — don't try to zero the warnings as part of an unrelated change.
- **`src/ui/node_modules` is usually absent**, but this is an npm workspace, so `vue-tsc`, `vite`,
  `jest`, `tsc` and `eslint` are hoisted into the root `node_modules/.bin` and everything runs anyway.
- **Two intermittently flaky suites** — `tests/unit/engine/dispatch/stream-tailer.test.ts` and
  `sqs-poller.test.ts` occasionally fail with `ENOTEMPTY` while cleaning `/tmp/lss-engine-dispatch-*`
  under parallel load. They pass in isolation. Don't chase them as regressions of your change, but
  don't use them as cover for a real failure either.
- CI (`.github/workflows/tests.yml`) runs unit + coverage gate, lint + tsc, build-artifact
  verification, and integration — the last one unconditionally, since 1.0 left nothing to gate it on.
  `publish.yml` publishes to npm when the version changes — so a version bump is a release action,
  not routine housekeeping.
