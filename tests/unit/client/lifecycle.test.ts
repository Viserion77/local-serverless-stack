import fs from 'fs';
import os from 'os';
import path from 'path';
import { Lifecycle, resolveCliPath } from '../../../src/client/lifecycle';
import type { HealthApi } from '../../../src/client/namespaces/health';

const FAKE_CLI = path.resolve(__dirname, '../../fixtures/fake-cli.js');
const ENV_KEYS = ['LSS_CLI_PATH', 'FAKE_CLI_EXIT', 'FAKE_CLI_ALREADY', 'FAKE_CLI_NOT_RUNNING'] as const;

function healthStub(get: HealthApi['get']): HealthApi {
  return { get };
}

// A /api/health payload shaped the way v2 answers it.
function okHealth(engineRunning = true) {
  return {
    status: 'ok',
    engineRunning,
    engine: { kind: 'self' as const, running: engineRunning, endpoint: 'http://localhost:14566' },
    dynamoProxy: { enabled: false, running: false, port: 8000 },
  };
}

describe('client lifecycle', () => {
  let saved: Record<string, string | undefined>;
  let cwd: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-lifecycle-'));
    process.env.LSS_CLI_PATH = FAKE_CLI;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe('resolveCliPath', () => {
    it('honors LSS_CLI_PATH', () => {
      expect(resolveCliPath()).toBe(FAKE_CLI);
    });

    it('falls back to bin/cli.js relative to the module', () => {
      delete process.env.LSS_CLI_PATH;
      expect(resolveCliPath().endsWith(path.join('bin', 'cli.js'))).toBe(true);
    });
  });

  describe('start', () => {
    const health = healthStub(async () => okHealth());

    it('reports a fresh start', async () => {
      const r = await new Lifecycle({ health, cwd }).start();
      expect(r.alreadyRunning).toBe(false);
      expect(r.raw).toMatch(/started/i);
    });

    it('detects an already-running instance', async () => {
      process.env.FAKE_CLI_ALREADY = '1';
      const r = await new Lifecycle({ health, cwd }).start();
      expect(r.alreadyRunning).toBe(true);
    });

    it('threads --config (per-call override) and the proxy flag into the CLI argv', async () => {
      const r = await new Lifecycle({ health, cwd }).start({
        configPath: 'e2e.json',
        enableDynamoProxy: true,
      });
      const args = JSON.parse(r.raw.split('\n')[0].replace('ARGS:', ''));
      expect(args).toEqual([
        'start',
        '--config',
        path.resolve(cwd, 'e2e.json'),
        '--enable-dynamo-proxy',
      ]);
    });

    it('throws with the CLI output when start exits non-zero', async () => {
      process.env.FAKE_CLI_EXIT = '2';
      await expect(new Lifecycle({ health, cwd }).start()).rejects.toThrow(/start failed \(exit 2\).*boom/s);
    });
  });

  describe('stop', () => {
    const health = healthStub(async () => okHealth());

    it('reports a stopped instance', async () => {
      const r = await new Lifecycle({ health, cwd }).stop();
      expect(r.wasRunning).toBe(true);
      expect(r.raw).toMatch(/stopped/i);
    });

    it('reports when nothing was running', async () => {
      process.env.FAKE_CLI_NOT_RUNNING = '1';
      const r = await new Lifecycle({ health, cwd }).stop();
      expect(r.wasRunning).toBe(false);
    });

    it('throws when stop exits non-zero (empty output falls back to stdout)', async () => {
      process.env.FAKE_CLI_EXIT = '3';
      await expect(new Lifecycle({ health, cwd }).stop()).rejects.toThrow(/stop failed \(exit 3\)/);
    });
  });

  describe('status / logs', () => {
    const health = healthStub(async () => okHealth());

    it('reads RUNNING and threads the instance configPath', async () => {
      const r = await new Lifecycle({ health, cwd, configPath: 'e2e.json' }).status();
      expect(r.running).toBe(true);
      const args = JSON.parse(r.raw.split('\n')[0].replace('ARGS:', ''));
      expect(args).toEqual(['status', '--config', path.resolve(cwd, 'e2e.json')]);
    });

    it('reads NOT RUNNING', async () => {
      process.env.FAKE_CLI_NOT_RUNNING = '1';
      const r = await new Lifecycle({ health, cwd }).status();
      expect(r.running).toBe(false);
    });

    it('returns the log tail', async () => {
      const r = await new Lifecycle({ health, cwd }).logs();
      expect(r.raw).toContain('some log line');
    });
  });

  describe('waitUntilReady', () => {
    it('resolves once the engine reports ready (default options)', async () => {
      const get = jest.fn().mockResolvedValue(okHealth());
      await expect(new Lifecycle({ health: healthStub(get), cwd }).waitUntilReady()).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('keeps polling while LocalStack is not yet up', async () => {
      const get = jest
        .fn()
        .mockResolvedValueOnce(okHealth(false))
        .mockResolvedValueOnce(okHealth());
      await new Lifecycle({ health: healthStub(get), cwd }).waitUntilReady({ timeoutMs: 2000, intervalMs: 1 });
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('rejects after the timeout when health never succeeds', async () => {
      const get = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(
        new Lifecycle({ health: healthStub(get), cwd }).waitUntilReady({ timeoutMs: 30, intervalMs: 5 }),
      ).rejects.toThrow(/not ready after 30ms/);
    });
  });
});
