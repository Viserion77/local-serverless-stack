# LSS - TODO List

Backlog audited against the codebase at v0.8.0 (2026-07). Items listed here were
verified as genuinely open; delivered work is tracked in [CHANGELOG.md](CHANGELOG.md).

## 🚧 In Progress

### High Priority

- [ ] **Backlog from the 0.6.0 real-monorepo audit (still open as of 0.8.0)**
  - Fix cleanup of event-source proxy Lambdas: cleanup still derives legacy proxy names from `serviceName + functionName` instead of the fully resolved Lambda name.
  - Make CLI `start` wait for the HTTP health endpoint/port readiness, not only for the child process to stay alive for 2 seconds.
  - Add diagnostics for duplicate `service:` names registered from different roots, so intentional collisions are explicit.
  - Expand Event Source Mapping fidelity beyond the 0.6.0 fields when needed (`ParallelizationFactor`, `BisectBatchOnFunctionError`, `MaximumRecordAgeInSeconds`, `TumblingWindowInSeconds`, `ScalingConfig`, source access config).
  - Decide whether generated LocalStack proxy Lambdas should follow the service runtime instead of always using `nodejs20.x`.

- [ ] **Self engine hardening** (divergences found in the 2026-07 docs audit)
  - Enforce (or explicitly reject) SQS `RedrivePolicy`: today it is stored verbatim and DLQ redrive never happens — failed messages redeliver via visibility timeout forever.
  - Guard unrecognized S3 sub-resource query params (`?acl`, `?policy`, `?tagging`, `?cors`, …) with `notImplemented` — today `PutObjectAcl` silently overwrites the object body.
  - OpenSearch Serverless backlog (explicit errors today): `_mget`, scroll/PIT pagination, sub-aggregations, scripted `_update`, relevance scoring (`_score` is a constant 1 — filtering is exact, ranking is not emulated).

- [ ] **Error Handling**
  - Better error messages in CLI
  - Recovery from orchestrator crashes
  - Handle `EADDRINUSE` on the orchestrator's own server port (`app.listen`) with a clear message — the gateway/invoke listeners and self engine already degrade gracefully
  - Validate serverless.yml before registration

- [ ] **Integration test gaps**
  - Exercise the LocalStack proxy-Lambda → HTTP invoke path end-to-end (the in-process path is covered)
  - Cross-service communication assertions (SQS/SNS between two registered services)

### Medium Priority

- [ ] **Enhanced CLI**
  - `npx lss restart` command
  - `npx lss list` to show registered services
  - `npx lss clean` to remove stale resources
  - `npx lss config` to show current configuration

- [ ] **Dashboard Improvements**
  - Replace the 2s log-polling loop with push streaming (SSE/WebSocket)
  - Resource usage metrics
  - Active HTTP health-probing of each service's api/invoke ports (today: process-state badges)
  - Resource-level create/delete from the dashboard (tables, queues, buckets, buses) — item/object management already exists

- [ ] **Development Experience**
  - Better logging and debugging output
  - Watch support in `artifact` execution mode (re-package on change; today watch is source-mode only by default)
  - Seed support beyond DynamoDB (e.g. Secrets Manager seeds)

### Low Priority

- [ ] **Documentation**
  - Generated REST reference (OpenAPI) for `src/server/routes/*`
  - Migration guide from pure LocalStack

- [ ] **Release pipeline**
  - Re-enable a test gate in `.github/workflows/publish.yml` (today publishing runs no tests; they only run in `tests.yml`)
  - Optional: automatic git tags on publish

## 🔮 Future Ideas

- [ ] Multi-project workspace management
- [ ] VS Code extension
- [ ] Template/project scaffolding
- [ ] Snapshot/restore of engine/LocalStack state

## 🎯 v1.0.0 Roadmap

v1.0.0 is an **API-stability commitment** (the package has been published on npm
since 0.x — see [docs/RELEASE.md](docs/RELEASE.md)). Before tagging it:

1. ⏳ Freeze the config schema (`lss.config.json`) and HTTP API surface
2. ⏳ Production-ready error handling (section above)
3. ⏳ Migration guide from existing LocalStack setups
4. ⏳ Self engine hardening items closed

Target: Q4 2026
