import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveConfig } from '../../../src/client/config-discovery';

// Env vars the resolver reads — saved/restored so tests don't leak into each other.
const ENV_KEYS = ['LSS_CONFIG', 'LSS_BASE_URL', 'LSS_SERVER_PORT', 'AWS_REGION'] as const;

describe('client config-discovery — resolveConfig', () => {
  let saved: Record<string, string | undefined>;
  let tmp: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-client-cfg-'));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('baseUrl resolution', () => {
    it('uses an explicit baseUrl and strips a trailing slash', () => {
      expect(resolveConfig({ baseUrl: 'http://host:1234/' }).baseUrl).toBe('http://host:1234');
    });

    it('keeps a baseUrl without a trailing slash unchanged', () => {
      expect(resolveConfig({ baseUrl: 'http://host:1234' }).baseUrl).toBe('http://host:1234');
    });

    it('falls back to the LSS_BASE_URL env var (also stripped)', () => {
      process.env.LSS_BASE_URL = 'http://env-host:5555/';
      expect(resolveConfig().baseUrl).toBe('http://env-host:5555');
    });

    it('builds the URL from an explicit host + port', () => {
      expect(resolveConfig({ host: 'example.com', port: 4321 }).baseUrl).toBe('http://example.com:4321');
    });

    it('defaults the host to localhost and reads the port from LSS_SERVER_PORT', () => {
      process.env.LSS_SERVER_PORT = '7777';
      expect(resolveConfig().baseUrl).toBe('http://localhost:7777');
    });

    it('ignores a non-numeric LSS_SERVER_PORT and falls back to the default', () => {
      process.env.LSS_SERVER_PORT = 'not-a-port';
      expect(resolveConfig({ cwd: tmp }).baseUrl).toBe('http://localhost:3100');
    });

    it('ignores a non-positive LSS_SERVER_PORT and falls back to the default', () => {
      process.env.LSS_SERVER_PORT = '0';
      expect(resolveConfig({ cwd: tmp }).baseUrl).toBe('http://localhost:3100');
    });

    it('reads serverPort from an explicit configPath', () => {
      const cfg = path.join(tmp, 'my.config.json');
      fs.writeFileSync(cfg, JSON.stringify({ serverPort: 8888 }));
      expect(resolveConfig({ configPath: cfg, cwd: tmp }).baseUrl).toBe('http://localhost:8888');
    });

    it('discovers lss.config.json in cwd when no configPath is given', () => {
      fs.writeFileSync(path.join(tmp, 'lss.config.json'), JSON.stringify({ serverPort: 9001 }));
      expect(resolveConfig({ cwd: tmp }).baseUrl).toBe('http://localhost:9001');
    });

    it('falls through to .lssrc when lss.config.json is absent', () => {
      fs.writeFileSync(path.join(tmp, '.lssrc'), JSON.stringify({ serverPort: 9002 }));
      expect(resolveConfig({ cwd: tmp }).baseUrl).toBe('http://localhost:9002');
    });

    it('ignores a config file whose serverPort is not a number, using the default', () => {
      fs.writeFileSync(path.join(tmp, 'lss.config.json'), JSON.stringify({ serverPort: 'nope' }));
      expect(resolveConfig({ cwd: tmp }).baseUrl).toBe('http://localhost:3100');
    });

    it('ignores an unparseable config file, using the default port', () => {
      fs.writeFileSync(path.join(tmp, 'lss.config.json'), 'not json {');
      expect(resolveConfig({ cwd: tmp }).baseUrl).toBe('http://localhost:3100');
    });

    it('defaults to port 3100 when no config is found anywhere', () => {
      expect(resolveConfig({ cwd: tmp }).baseUrl).toBe('http://localhost:3100');
    });
  });

  describe('region / configPath / timeout / cwd', () => {
    it('takes region from options', () => {
      expect(resolveConfig({ baseUrl: 'http://h:1', region: 'eu-west-1' }).region).toBe('eu-west-1');
    });

    it('falls back to AWS_REGION for the region', () => {
      process.env.AWS_REGION = 'sa-east-1';
      expect(resolveConfig({ baseUrl: 'http://h:1' }).region).toBe('sa-east-1');
    });

    it('leaves region undefined when neither option nor env is set', () => {
      expect(resolveConfig({ baseUrl: 'http://h:1' }).region).toBeUndefined();
    });

    it('takes configPath from options', () => {
      expect(resolveConfig({ baseUrl: 'http://h:1', configPath: 'a.json' }).configPath).toBe('a.json');
    });

    it('falls back to LSS_CONFIG for the configPath', () => {
      process.env.LSS_CONFIG = '/env/lss.config.json';
      expect(resolveConfig({ baseUrl: 'http://h:1' }).configPath).toBe('/env/lss.config.json');
    });

    it('takes timeoutMs from options and defaults otherwise', () => {
      expect(resolveConfig({ baseUrl: 'http://h:1', timeoutMs: 999 }).timeoutMs).toBe(999);
      expect(resolveConfig({ baseUrl: 'http://h:1' }).timeoutMs).toBe(15000);
    });

    it('defaults cwd to process.cwd() and honors an explicit cwd', () => {
      expect(resolveConfig({ baseUrl: 'http://h:1' }).cwd).toBe(process.cwd());
      expect(resolveConfig({ baseUrl: 'http://h:1', cwd: '/tmp/x' }).cwd).toBe('/tmp/x');
    });
  });
});
