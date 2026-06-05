// Integration-test setup: shared matchers + the orchestrator lifecycle that
// ensures a clean slate before/after the Docker-backed suites run.
import './setup.matchers';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

jest.setTimeout(120000);

// Ensure no default orchestrator is running before integration tests start.
beforeAll(async () => {
  console.log('🧪 Setting up integration test environment...');
  try {
    await execAsync('npx lss stop 2>/dev/null || true');
  } catch {
    // Ignore — orchestrator might not be running
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
});

afterAll(async () => {
  console.log('🧹 Cleaning up integration test environment...');
  try {
    await execAsync('npx lss stop 2>/dev/null || true');
  } catch {
    // Ignore
  }
  try {
    await execAsync('rm -f /tmp/lss-test-*.json 2>/dev/null || true');
  } catch {
    // Ignore
  }
});
