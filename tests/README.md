# LSS Tests

Two separated test types:

| Type | Command | Docker? | What it does |
|---|---|---|---|
| **Unit** | `npm run test:unit` (alias of `npm test`) | no | Hermetic. Enforces a **100% coverage gate** (statements/branches/functions/lines) over the unit-testable server code. |
| **Integration** | `npm run test:integration` | yes | Boots a real isolated LSS + LocalStack and validates the promised features end-to-end (see [../docs/FEATURES.md](../docs/FEATURES.md)). |

## Layout

```
tests/
├── unit/                     # Unit suites (mirror src/), run in CI, 100% gate
│   ├── services/             # one *.test.ts per src/server/services module
│   ├── routes/               # one *.test.ts per src/server/routes module
│   ├── dev/ · plugin/ · cli/ # dynamo-proxy, serverless-lss plugin, bin/cli.js
│   ├── cli-seed.test.ts      # CLI seed/seed:clear (spawns the built CLI)
│   ├── seed-manager-guard.test.ts · serverless-packager.test.ts · smoke.test.ts
├── integration/
│   ├── features.test.ts      # promised-features validation (the integration suite)
│   └── fixtures/lss.integration.config.json
├── fixtures/                 # committed CFN templates used by the parser tests
├── setup.matchers.ts         # shared custom matchers (+ jest type augmentation)
├── setup.unit.ts             # unit setup (matchers only)
└── setup.integration.ts      # integration setup (orchestrator stop/cleanup lifecycle)
```

## Unit tests (100% gate)

```bash
npm run test:unit        # fast, no Docker
npm run test:coverage    # same + enforces the 100% gate (what CI runs)
npm run test:watch
```

Coverage scope (`jest.config.js` → `collectCoverageFrom`): `src/server/services/**` (except the
Docker-driven `localstack-manager.ts`), `src/server/routes/**`, `src/server/dev/**`,
`packages/serverless-plugin/src/**`, and `bin/cli.js`. `src/server/index.ts` is excluded because it
bootstraps the server at import. Genuinely-unreachable defensive lines are marked with a justified
`/* istanbul ignore next */`.

**Patterns** (copy the existing exemplars):
- AWS-SDK services → [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock):
  `mockClient(SQSClient)` patches the client prototype, so it intercepts the clients the singletons cache.
  Reset singleton state and use `jest.useFakeTimers()` for sleep/poll loops. See `services/queue-inspector.test.ts`.
- Express routes → `supertest` + `jest.spyOn(Singleton.getInstance(), method)`. See `routes/config.test.ts`.
- The plugin → mock global `fetch`. See `plugin/index.test.ts`.

## Integration tests

```bash
# community LocalStack images >= 2026.5 require a token
export LOCALSTACK_AUTH_TOKEN=ls-xxxx
npm run test:integration
```

`features.test.ts` starts an isolated instance via `lss start --config tests/integration/fixtures/lss.integration.config.json`
(own ports 3399/4599, own `stateDir`, managed mode), registers `examples/sample-microservice`, asserts the
provisioned resources + queue `await-idle`/hold-capture-release + seeds + S3 round-trip via the HTTP API, then
stops the instance and removes the scoped container/volume. The whole suite **skips automatically** when no
`LOCALSTACK_AUTH_TOKEN` is present, so a token-less run never fails.

## CI

`.github/workflows/tests.yml`: an always-on **unit** job (the 100% gate on every PR), a **lint** job, a **build**
job, and an **integration** job gated on the `LOCALSTACK_AUTH_TOKEN` repository secret.
