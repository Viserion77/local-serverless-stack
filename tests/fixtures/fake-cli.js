#!/usr/bin/env node
'use strict';

// Stand-in for bin/cli.js used by the lifecycle unit tests. It does NOT touch
// Docker/PID files — it just echoes its argv (so tests can assert that
// --config and flags were threaded) and prints the same status strings the real
// CLI prints, so the lifecycle parser can be exercised deterministically.
//
// Behaviour is steered by env vars set by the test:
//   FAKE_CLI_EXIT=<n>      exit with this code (default 0)
//   FAKE_CLI_ALREADY=1     `start` reports "already running"
//   FAKE_CLI_NOT_RUNNING=1 `stop`/`status` report "not running"

const cmd = process.argv[2];
const exitCode = process.env.FAKE_CLI_EXIT ? Number(process.env.FAKE_CLI_EXIT) : 0;

function emit(line) {
  process.stdout.write(`ARGS:${JSON.stringify(process.argv.slice(2))}\n${line}\n`);
}

switch (cmd) {
  case 'start':
    if (exitCode !== 0) {
      process.stderr.write('boom: start failed\n');
      process.exit(exitCode);
    }
    emit(
      process.env.FAKE_CLI_ALREADY
        ? '✅ LSS Orchestrator already running (PID: 123)'
        : '🚀 LSS Orchestrator started (PID: 123)',
    );
    break;
  case 'stop':
    // On failure, print nothing — exercises the `(stderr || stdout)` fallback.
    if (exitCode !== 0) process.exit(exitCode);
    emit(
      process.env.FAKE_CLI_NOT_RUNNING
        ? '⚠️  LSS Orchestrator is not running'
        : '🛑 LSS Orchestrator stopped (PID: 123)',
    );
    break;
  case 'status':
    emit(
      process.env.FAKE_CLI_NOT_RUNNING
        ? '⚪ LSS Orchestrator: NOT RUNNING'
        : '🟢 LSS Orchestrator: RUNNING (PID: 123)',
    );
    break;
  case 'logs':
    emit('📝 some log line');
    break;
  default:
    process.stderr.write('unknown command\n');
    process.exit(1);
}

process.exit(exitCode);
