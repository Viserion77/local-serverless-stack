// Unit-test setup: matchers only. Unit tests are hermetic (no Docker, no running
// orchestrator), so they must NOT pay for the `npx lss stop` + sleep lifecycle.
import './setup.matchers';
