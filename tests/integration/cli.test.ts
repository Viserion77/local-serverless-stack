import { TestUtils } from '../helpers/test-utils';
import * as fs from 'fs/promises';

describe('CLI Integration Tests', () => {
  beforeEach(async () => {
    // Ensure orchestrator is stopped before each test
    await TestUtils.execCli('stop');
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterEach(async () => {
    // Cleanup after each test
    await TestUtils.execCli('stop');
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  describe('lss start', () => {
    it('should start the orchestrator successfully', async () => {
      const result = await TestUtils.execCli('start');

      expect(result.stdout).toContain('LSS Orchestrator started');
      expect(result.stdout).toContain('Dashboard: http://localhost:3100');
      expect(result.exitCode).toBe(0);

      // Wait for orchestrator to be ready
      await TestUtils.waitForPort(3100);

      // Verify PID file exists
      const pid = await TestUtils.readPidFile();
      expect(pid).not.toBeNull();
      expect(pid!).toBeValidPid();

      // Verify process is running
      const isRunning = await TestUtils.isProcessRunning(pid!);
      expect(isRunning).toBe(true);
    }, 45000);

    it('should not start if already running', async () => {
      // Start first time
      await TestUtils.execCli('start');
      await TestUtils.waitForPort(3100);

      // Try to start again
      const result = await TestUtils.execCli('start');

      expect(result.stdout).toContain('already running');
      expect(result.exitCode).toBe(0);
    }, 45000);

    it('should start LocalStack container', async () => {
      await TestUtils.execCli('start');
      await TestUtils.waitForPort(3100);

      // Wait for LocalStack to be ready
      await TestUtils.waitForLocalStack();

      // Verify LocalStack is accessible
      const response = await fetch('http://localhost:4566/_localstack/health');
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.services).toBeDefined();
    }, 60000);
  });

  describe('lss status', () => {
    it('should show NOT RUNNING when orchestrator is stopped', async () => {
      const result = await TestUtils.execCli('status');

      expect(result.stdout).toContain('NOT RUNNING');
      expect(result.exitCode).toBe(0);
    });

    it('should show RUNNING status with PID when orchestrator is running', async () => {
      // Start orchestrator
      await TestUtils.execCli('start');
      await TestUtils.waitForPort(3100);

      const result = await TestUtils.execCli('status');

      expect(result.stdout).toContain('RUNNING');
      expect(result.stdout).toMatch(/PID:\s*\d+/);
      expect(result.stdout).toContain('Dashboard: http://localhost:3100');
      expect(result.exitCode).toBe(0);
    }, 45000);
  });

  describe('lss stop', () => {
    it('should stop the orchestrator successfully', async () => {
      // Start orchestrator first
      await TestUtils.execCli('start');
      await TestUtils.waitForPort(3100);

      const pid = await TestUtils.readPidFile();
      expect(pid).not.toBeNull();

      // Stop orchestrator
      const result = await TestUtils.execCli('stop');

      expect(result.stdout).toContain('stopped');
      expect(result.exitCode).toBe(0);

      // Wait for process to exit
      await TestUtils.waitForProcessExit(pid!);

      // Verify process is not running
      const isRunning = await TestUtils.isProcessRunning(pid!);
      expect(isRunning).toBe(false);

      // Verify PID file is removed
      const pidAfter = await TestUtils.readPidFile();
      expect(pidAfter).toBeNull();
    }, 45000);

    it('should handle stop when not running', async () => {
      const result = await TestUtils.execCli('stop');

      expect(result.stdout).toContain('not running');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('lss logs', () => {
    it('should display recent logs', async () => {
      // Start orchestrator to generate logs
      await TestUtils.execCli('start');
      await TestUtils.waitForPort(3100);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await TestUtils.execCli('logs');

      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.exitCode).toBe(0);
    }, 45000);

    it('should handle when log file does not exist', async () => {
      // Ensure orchestrator is not running and logs are deleted
      await TestUtils.execCli('stop');
      await fs.unlink('/tmp/lss-orchestrator.log').catch(() => {});

      const result = await TestUtils.execCli('logs');

      // Should handle missing log file gracefully
      const output = (result.stderr || result.stdout).toLowerCase();
      const hasExpectedMessage =
        output.includes('not found') ||
        output.includes('no logs') ||
        output.includes('no such file');
      expect(hasExpectedMessage).toBe(true);
    });
  });

  describe('lss help', () => {
    it('should display help information', async () => {
      const result = await TestUtils.execCli('help');

      expect(result.stdout).toContain('start');
      expect(result.stdout).toContain('stop');
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('logs');
      expect(result.exitCode).toBe(0);
    });
  });
});
