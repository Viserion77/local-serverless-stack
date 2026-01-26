// Global test setup
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Increase timeout for integration tests
jest.setTimeout(60000);

// Global setup - runs once before all tests
beforeAll(async () => {
  console.log('🧪 Setting up test environment...');
  
  // Ensure orchestrator is stopped before tests
  try {
    await execAsync('npx lss stop 2>/dev/null || true');
  } catch {
    // Ignore errors - orchestrator might not be running
  }
  
  // Wait a bit for cleanup
  await new Promise(resolve => setTimeout(resolve, 2000));
});

// Global teardown - runs once after all tests
afterAll(async () => {
  console.log('🧹 Cleaning up test environment...');
  
  // Stop orchestrator if running
  try {
    await execAsync('npx lss stop 2>/dev/null || true');
  } catch {
    // Ignore errors
  }
  
  // Cleanup any test files
  try {
    await execAsync('rm -f /tmp/lss-test-*.json 2>/dev/null || true');
  } catch {
    // Ignore errors
  }
});

// Add custom matchers if needed
expect.extend({
  toBeValidPort(received: number) {
    const pass = received > 0 && received < 65536;
    return {
      pass,
      message: () => `expected ${received} to be a valid port (1-65535)`,
    };
  },
  
  toBeValidPid(received: number) {
    const pass = received > 0;
    return {
      pass,
      message: () => `expected ${received} to be a valid PID (> 0)`,
    };
  },
});

// Extend Jest matchers type
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidPort(): R;
      toBeValidPid(): R;
    }
  }
}
