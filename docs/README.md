# LSS Documentation

LSS (Local Serverless Stack) is a local control plane for serverless development:
one orchestrator provisions every AWS resource your services declare and emulates
the Lambda runtime + API Gateway — backed either by the in-process **self engine**
(no Docker) or by a single shared **LocalStack** container. A CLI (`npx lss`), a
Vue 3 dashboard, a Serverless Framework plugin (`serverless-lss`) and a
programmatic client (`LssClient`) sit on top.

Start with the [project README](../README.md) for the quick start, then:

| Doc | What it covers |
| --- | --- |
| [CONFIGURATION.md](CONFIGURATION.md) | Every `lss.config.json` key, env var, plugin setup, branding, troubleshooting |
| [FEATURES.md](FEATURES.md) | Feature inventory: each promise and the test that asserts it |
| [SELF_ENGINE.md](SELF_ENGINE.md) | Self engine user guide: coverage matrix, storage model, fallback |
| [RELEASE.md](RELEASE.md) | How releases and npm publishing work (maintainers) |
| [serverless.yml.example](serverless.yml.example) | Minimal service template for the `serverless-lss` plugin |

Design documents (PRDs — rationale and decisions, not reference):

| Doc | Topic |
| --- | --- |
| [PRD_SELF_ENGINE.md](PRD_SELF_ENGINE.md) | The in-process AWS engine (shipped in 0.8.0) |
| [PRD_API_LAMBDA_EMULATION.md](PRD_API_LAMBDA_EMULATION.md) | Lambda runtime + API Gateway emulation (shipped in 0.7.x) |
| [archive/DESIGN_PROPOSAL.md](archive/DESIGN_PROPOSAL.md) | Original design proposal (historical) |

Related, outside `docs/`: [CONTRIBUTING.md](../CONTRIBUTING.md) ·
[CHANGELOG.md](../CHANGELOG.md) · runnable examples in [examples/](../examples/).
