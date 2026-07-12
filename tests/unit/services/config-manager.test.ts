// Unit tests for ConfigManager (src/server/services/config-manager.ts).
// ConfigManager is a singleton whose private constructor calls loadConfig(),
// which reads from disk (fs) and process.env. To test file-loading precedence
// and env overrides we mock fs, set process.env, then jest.resetModules() +
// re-require to construct a fresh singleton under those conditions.
import path from 'path';

jest.mock('fs');
const fs = require('fs') as jest.Mocked<typeof import('fs')>;

const ENV = { ...process.env };

// The env vars ConfigManager reads. Cleared before each test for determinism.
const LSS_ENV_VARS = [
  'LSS_CONFIG_PATH',
  'LSS_DASHBOARD_PORT',
  'PORT',
  'LSS_LOCALSTACK_PORT',
  'LSS_LOCALSTACK_ENDPOINT',
  'LSS_LOCALSTACK_MODE',
  'LSS_LOCALSTACK_EDITION',
  'LSS_LOCALSTACK_VERSION',
  'LSS_LOCALSTACK_IMAGE',
  'LOCALSTACK_AUTH_TOKEN',
  'LSS_ENABLE_DYNAMO_PROXY',
  'ENABLE_DYNAMO_PROXY',
  'LSS_DYNAMO_PROXY_PORT',
  'AWS_REGION',
  'LSS_SERVICES',
  'LSS_PERSISTENCE',
  'LSS_DEBUG',
  'LSS_SEEDS_DIR',
  'LSS_AUTO_PACKAGE',
  'LSS_PACKAGE_COMMAND',
  'LSS_PACKAGE_TIMEOUT_MS',
  'LSS_LAMBDA_RUNTIME',
  'LSS_LAMBDA_EXECUTION',
  'LSS_LAMBDA_WATCH',
  'LSS_INVOKE_HOST',
  'LSS_ENGINE',
  'LSS_ENGINE_PORT',
  'HOME',
];

type CM = import('../../../src/server/services/config-manager').ConfigManager;

/**
 * Build a fresh ConfigManager singleton against the current fs mock + env.
 * resetModules clears the cached singleton so the constructor runs again.
 */
function freshConfigManager(): CM {
  let instance: CM | undefined;
  jest.isolateModules(() => {
    const mod = require('../../../src/server/services/config-manager');
    instance = mod.ConfigManager.getInstance();
  });
  return instance as CM;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of LSS_ENV_VARS) {
    delete process.env[key];
  }
  process.env.HOME = '/home/tester';
  // Default: no config file exists anywhere.
  fs.existsSync.mockReturnValue(false);
  fs.readFileSync.mockReturnValue('{}');
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

describe('getInstance', () => {
  it('returns the same instance on repeated calls (singleton)', () => {
    let a: CM | undefined;
    let b: CM | undefined;
    jest.isolateModules(() => {
      const mod = require('../../../src/server/services/config-manager');
      a = mod.ConfigManager.getInstance();
      b = mod.ConfigManager.getInstance();
    });
    expect(a).toBe(b);
  });
});

describe('loadConfig file precedence', () => {
  it('prefers LSS_CONFIG_PATH over cwd/home candidates', () => {
    process.env.LSS_CONFIG_PATH = '/custom/lss.json';
    fs.existsSync.mockImplementation((p) => p === '/custom/lss.json');
    fs.readFileSync.mockReturnValue(JSON.stringify({ serverPort: 9999 }));

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe('/custom/lss.json');
    expect(cm.getServerPort()).toBe(9999);
  });

  it('falls back to lss.config.json in cwd when LSS_CONFIG_PATH is unset', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ region: 'eu-west-1' }));

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe(cwdFile);
    expect(cm.getRegion()).toBe('eu-west-1');
  });

  it('falls back to .lssrc in cwd', () => {
    const cwdRc = path.join(process.cwd(), '.lssrc');
    fs.existsSync.mockImplementation((p) => p === cwdRc);
    fs.readFileSync.mockReturnValue(JSON.stringify({ debug: true }));

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe(cwdRc);
    expect(cm.isDebug()).toBe(true);
  });

  it('falls back to lss.config.json in HOME', () => {
    const homeFile = path.join('/home/tester', 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === homeFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ persistence: false }));

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe(homeFile);
    expect(cm.isPersistence()).toBe(false);
  });

  it('falls back to .lssrc in HOME', () => {
    const homeRc = path.join('/home/tester', '.lssrc');
    fs.existsSync.mockImplementation((p) => p === homeRc);
    fs.readFileSync.mockReturnValue(JSON.stringify({ mode: 'external' }));

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe(homeRc);
    expect(cm.getMode()).toBe('external');
  });

  it('uses ~ as the home base when HOME is unset', () => {
    delete process.env.HOME;
    const tildeFile = path.join('~', 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === tildeFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ serverPort: 4321 }));

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe(tildeFile);
    expect(cm.getServerPort()).toBe(4321);
  });

  it('warns and keeps searching when a config file fails to parse', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue('{ not valid json');

    const cm = freshConfigManager();
    // Parse failed: no config loaded, configPath stays empty, defaults apply.
    expect(cm.getConfigPath()).toBe('');
    expect(cm.getServerPort()).toBe(3100);
    expect(console.warn).toHaveBeenCalled();
  });

  it('reports a generic message when the thrown value is not an Error', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockImplementation(() => {
      throw 'a string, not an Error';
    });

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe('');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse config file'),
      'Unknown error',
    );
  });
});

describe('loadFromEnv overrides every variable', () => {
  it('serverPort from LSS_DASHBOARD_PORT', () => {
    process.env.LSS_DASHBOARD_PORT = '5500';
    expect(freshConfigManager().getServerPort()).toBe(5500);
  });

  it('serverPort from PORT when LSS_DASHBOARD_PORT is unset', () => {
    process.env.PORT = '5600';
    expect(freshConfigManager().getServerPort()).toBe(5600);
  });

  it('localstackPort', () => {
    process.env.LSS_LOCALSTACK_PORT = '4567';
    expect(freshConfigManager().getLocalStackPort()).toBe(4567);
  });

  it('localstackEndpoint', () => {
    process.env.LSS_LOCALSTACK_ENDPOINT = 'http://ls:4566';
    expect(freshConfigManager().getLocalStackEndpoint()).toBe('http://ls:4566');
  });

  it('mode managed (lowercased)', () => {
    process.env.LSS_LOCALSTACK_MODE = 'MANAGED';
    expect(freshConfigManager().getMode()).toBe('managed');
  });

  it('mode external', () => {
    process.env.LSS_LOCALSTACK_MODE = 'external';
    const cm = freshConfigManager();
    expect(cm.getMode()).toBe('external');
    expect(cm.isExternal()).toBe(true);
  });

  it('mode ignores invalid values', () => {
    process.env.LSS_LOCALSTACK_MODE = 'bogus';
    expect(freshConfigManager().getMode()).toBe('managed');
  });

  it('edition pro (lowercased)', () => {
    process.env.LSS_LOCALSTACK_EDITION = 'PRO';
    expect(freshConfigManager().getLocalStackEdition()).toBe('pro');
  });

  it('edition community', () => {
    process.env.LSS_LOCALSTACK_EDITION = 'community';
    expect(freshConfigManager().getLocalStackEdition()).toBe('community');
  });

  it('edition ignores invalid values', () => {
    process.env.LSS_LOCALSTACK_EDITION = 'enterprise';
    expect(freshConfigManager().getLocalStackEdition()).toBe('community');
  });

  it('localstackVersion', () => {
    process.env.LSS_LOCALSTACK_VERSION = '3.0.0';
    expect(freshConfigManager().getLocalStackVersion()).toBe('3.0.0');
  });

  it('localstackImage', () => {
    process.env.LSS_LOCALSTACK_IMAGE = 'myrepo/ls:custom';
    expect(freshConfigManager().getLocalStackImage()).toBe('myrepo/ls:custom');
  });

  it('localstackAuthToken', () => {
    process.env.LOCALSTACK_AUTH_TOKEN = 'tok-123';
    expect(freshConfigManager().getLocalStackAuthToken()).toBe('tok-123');
  });

  it('enableDynamoProxy true', () => {
    process.env.LSS_ENABLE_DYNAMO_PROXY = 'true';
    expect(freshConfigManager().isEnableDynamoProxy()).toBe(true);
  });

  it('enableDynamoProxy "1"', () => {
    process.env.LSS_ENABLE_DYNAMO_PROXY = '1';
    expect(freshConfigManager().isEnableDynamoProxy()).toBe(true);
  });

  it('enableDynamoProxy false when set to another value', () => {
    process.env.LSS_ENABLE_DYNAMO_PROXY = 'no';
    expect(freshConfigManager().isEnableDynamoProxy()).toBe(false);
  });

  it('dynamoProxyPort', () => {
    process.env.LSS_DYNAMO_PROXY_PORT = '9000';
    expect(freshConfigManager().getDynamoProxyPort()).toBe(9000);
  });

  it('region from AWS_REGION', () => {
    process.env.AWS_REGION = 'ap-south-1';
    expect(freshConfigManager().getRegion()).toBe('ap-south-1');
  });

  it('services from LSS_SERVICES (comma split)', () => {
    process.env.LSS_SERVICES = 'dynamodb,sqs';
    expect(freshConfigManager().getServices()).toEqual(['dynamodb', 'sqs']);
  });

  it('persistence true', () => {
    process.env.LSS_PERSISTENCE = 'true';
    expect(freshConfigManager().isPersistence()).toBe(true);
  });

  it('persistence "1"', () => {
    process.env.LSS_PERSISTENCE = '1';
    expect(freshConfigManager().isPersistence()).toBe(true);
  });

  it('persistence false when set to another value', () => {
    process.env.LSS_PERSISTENCE = 'off';
    expect(freshConfigManager().isPersistence()).toBe(false);
  });

  it('debug true', () => {
    process.env.LSS_DEBUG = 'true';
    expect(freshConfigManager().isDebug()).toBe(true);
  });

  it('debug "1"', () => {
    process.env.LSS_DEBUG = '1';
    expect(freshConfigManager().isDebug()).toBe(true);
  });

  it('debug false when set to another value', () => {
    process.env.LSS_DEBUG = 'nope';
    expect(freshConfigManager().isDebug()).toBe(false);
  });

  it('seedsDir', () => {
    process.env.LSS_SEEDS_DIR = '/abs/seeds';
    expect(freshConfigManager().getSeedsDir()).toBe('/abs/seeds');
  });

  it('autoPackage true', () => {
    process.env.LSS_AUTO_PACKAGE = 'true';
    expect(freshConfigManager().isAutoPackage()).toBe(true);
  });

  it('autoPackage "1"', () => {
    process.env.LSS_AUTO_PACKAGE = '1';
    expect(freshConfigManager().isAutoPackage()).toBe(true);
  });

  it('autoPackage false when set to another value', () => {
    process.env.LSS_AUTO_PACKAGE = 'maybe';
    expect(freshConfigManager().isAutoPackage()).toBe(false);
  });

  it('packageCommand', () => {
    process.env.LSS_PACKAGE_COMMAND = 'yarn package';
    expect(freshConfigManager().getPackageCommand()).toBe('yarn package');
  });

  it('packageTimeoutMs when valid and positive', () => {
    process.env.LSS_PACKAGE_TIMEOUT_MS = '60000';
    expect(freshConfigManager().getPackageTimeoutMs()).toBe(60000);
  });

  it('packageTimeoutMs ignores non-numeric values', () => {
    process.env.LSS_PACKAGE_TIMEOUT_MS = 'abc';
    expect(freshConfigManager().getPackageTimeoutMs()).toBe(300000);
  });

  it('packageTimeoutMs ignores non-positive values', () => {
    process.env.LSS_PACKAGE_TIMEOUT_MS = '0';
    expect(freshConfigManager().getPackageTimeoutMs()).toBe(300000);
  });
});

describe('getters: defaults (no file, no env)', () => {
  let cm: CM;
  beforeEach(() => {
    cm = freshConfigManager();
  });

  it('getConfig returns the (empty) config object', () => {
    expect(cm.getConfig()).toEqual({});
  });

  it('getServerPort defaults to 3100', () => {
    expect(cm.getServerPort()).toBe(3100);
  });

  it('getServerPort reads PORT env at call time when config unset', () => {
    process.env.PORT = '7000';
    expect(cm.getServerPort()).toBe(7000);
  });

  it('getDashboardPort aliases getServerPort', () => {
    expect(cm.getDashboardPort()).toBe(3100);
  });

  it('getLocalStackPort defaults to 4566', () => {
    expect(cm.getLocalStackPort()).toBe(4566);
  });

  it('getLocalStackEndpoint defaults from port', () => {
    expect(cm.getLocalStackEndpoint()).toBe('http://localhost:4566');
  });

  it('getMode defaults to managed', () => {
    expect(cm.getMode()).toBe('managed');
  });

  it('isExternal defaults to false', () => {
    expect(cm.isExternal()).toBe(false);
  });

  it('getLocalStackEdition defaults to community', () => {
    expect(cm.getLocalStackEdition()).toBe('community');
  });

  it('getLocalStackVersion defaults to latest', () => {
    expect(cm.getLocalStackVersion()).toBe('latest');
  });

  it('getLocalStackImage defaults to community repo + latest', () => {
    expect(cm.getLocalStackImage()).toBe('localstack/localstack:latest');
  });

  it('getLocalStackAuthToken defaults to undefined', () => {
    expect(cm.getLocalStackAuthToken()).toBeUndefined();
  });

  it('isEnableDynamoProxy defaults to false', () => {
    expect(cm.isEnableDynamoProxy()).toBe(false);
  });

  it('getDynamoProxyPort defaults to 8000', () => {
    expect(cm.getDynamoProxyPort()).toBe(8000);
  });

  it('getRegion defaults to us-east-1', () => {
    expect(cm.getRegion()).toBe('us-east-1');
  });

  it('getRegion reads AWS_REGION env at call time when config unset', () => {
    process.env.AWS_REGION = 'us-west-2';
    expect(cm.getRegion()).toBe('us-west-2');
  });

  it('getServices defaults to the standard list', () => {
    expect(cm.getServices()).toEqual(['dynamodb', 'sqs', 'sns', 's3', 'lambda', 'events']);
  });

  it('isPersistence defaults to true', () => {
    expect(cm.isPersistence()).toBe(true);
  });

  it('isDebug defaults to false', () => {
    expect(cm.isDebug()).toBe(false);
  });

  it('getSeedsDir defaults to ./seeds resolved against cwd', () => {
    expect(cm.getSeedsDir()).toBe(path.resolve(process.cwd(), './seeds'));
  });

  it('getStateDir defaults to undefined', () => {
    expect(cm.getStateDir()).toBeUndefined();
  });

  it('isAutoPackage defaults to false', () => {
    expect(cm.isAutoPackage()).toBe(false);
  });

  it('getPackageCommand defaults to npx serverless package', () => {
    expect(cm.getPackageCommand()).toBe('npx serverless package');
  });

  it('getPackageTimeoutMs defaults to 300000', () => {
    expect(cm.getPackageTimeoutMs()).toBe(300000);
  });

  it('getConfigPath defaults to empty string', () => {
    expect(cm.getConfigPath()).toBe('');
  });

  it('getOrchestratorUrl uses the server port', () => {
    expect(cm.getOrchestratorUrl()).toBe('http://localhost:3100');
  });
});

describe('getters: branch coverage on config-provided values', () => {
  it('getLocalStackEndpoint returns the explicit endpoint when set', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ localstackEndpoint: 'http://explicit:1' }));
    expect(freshConfigManager().getLocalStackEndpoint()).toBe('http://explicit:1');
  });

  it('getLocalStackImage uses the pro repo for the pro edition', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ localstackEdition: 'pro', localstackVersion: '3.0' }));
    expect(freshConfigManager().getLocalStackImage()).toBe('localstack/localstack-pro:3.0');
  });

  it('isEnableDynamoProxy honors the ENABLE_DYNAMO_PROXY env fallback ("true")', () => {
    process.env.ENABLE_DYNAMO_PROXY = 'TRUE';
    expect(freshConfigManager().isEnableDynamoProxy()).toBe(true);
  });

  it('isEnableDynamoProxy honors the ENABLE_DYNAMO_PROXY env fallback ("1")', () => {
    process.env.ENABLE_DYNAMO_PROXY = '1';
    expect(freshConfigManager().isEnableDynamoProxy()).toBe(true);
  });

  it('getSeedsDir returns an absolute seedsDir unchanged', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ seedsDir: '/abs/seeds' }));
    expect(freshConfigManager().getSeedsDir()).toBe('/abs/seeds');
  });

  it('getStateDir resolves a relative stateDir against cwd', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ stateDir: 'rel/state' }));
    expect(freshConfigManager().getStateDir()).toBe(path.resolve(process.cwd(), 'rel/state'));
  });

  it('getStateDir returns an absolute stateDir unchanged', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ stateDir: '/abs/state' }));
    expect(freshConfigManager().getStateDir()).toBe('/abs/state');
  });
});

describe('getPackageConfigForService', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('returns global defaults when nothing is configured (no config file)', () => {
    // No config file → configPath is '' → resolver falls back to process.cwd().
    const cm = freshConfigManager();
    expect(cm.getPackageConfigForService('/abs/some/access')).toEqual({
      command: 'npx serverless package',
      args: [],
      env: {},
      timeoutMs: 300000,
    });
  });

  it('applies global packageArgs/packageEnv to any service', () => {
    const cm = cmWith({ packageArgs: ['--g'], packageEnv: { A: '1' } });
    expect(cm.getPackageConfigForService('/abs/whatever')).toEqual({
      command: 'npx serverless package',
      args: ['--g'],
      env: { A: '1' },
      timeoutMs: 300000,
    });
  });

  it('matches a per-service override by directory basename', () => {
    const cm = cmWith({
      servicePackaging: {
        access: { packageArgs: ['--param=custom-stage=offline'], packageTimeoutMs: 60000 },
      },
    });
    expect(cm.getPackageConfigForService('/abs/microservices/access')).toEqual({
      command: 'npx serverless package',
      args: ['--param=custom-stage=offline'],
      env: {},
      timeoutMs: 60000,
    });
  });

  it('matches a per-service override by relative path and it wins over basename', () => {
    const cm = cmWith({
      servicePackaging: {
        access: { packageArgs: ['--by-basename'] },
        'microservices/access': { packageArgs: ['--by-relpath'], packageCommand: 'npx sls package' },
      },
    });
    const svc = path.join(process.cwd(), 'microservices/access');
    expect(cm.getPackageConfigForService(svc)).toEqual({
      command: 'npx sls package',
      args: ['--by-relpath'],
      env: {},
      timeoutMs: 300000,
    });
  });

  it('concatenates global then per-service args and merges env (service wins)', () => {
    const cm = cmWith({
      packageArgs: ['--g'],
      packageEnv: { A: '1', B: '2' },
      servicePackaging: { access: { packageArgs: ['--s'], packageEnv: { B: '9', C: '3' } } },
    });
    expect(cm.getPackageConfigForService('/abs/access')).toEqual({
      command: 'npx serverless package',
      args: ['--g', '--s'],
      env: { A: '1', B: '9', C: '3' },
      timeoutMs: 300000,
    });
  });

  it('returns only globals for a service with no matching override', () => {
    const cm = cmWith({
      packageArgs: ['--g'],
      servicePackaging: { access: { packageArgs: ['--s'] } },
    });
    expect(cm.getPackageConfigForService('/abs/other')).toEqual({
      command: 'npx serverless package',
      args: ['--g'],
      env: {},
      timeoutMs: 300000,
    });
  });

  it('uses env-var packageCommand/timeout as the global baseline', () => {
    process.env.LSS_PACKAGE_COMMAND = 'yarn package';
    process.env.LSS_PACKAGE_TIMEOUT_MS = '120000';
    const cm = freshConfigManager();
    expect(cm.getPackageConfigForService('/abs/access')).toEqual({
      command: 'yarn package',
      args: [],
      env: {},
      timeoutMs: 120000,
    });
  });
});

describe('lambdaRuntime config', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('defaults: enabled, auto execution, offset 10000 and host.docker.internal invoke host', () => {
    const cm = freshConfigManager();
    expect(cm.isLambdaRuntimeEnabled()).toBe(true);
    expect(cm.getLambdaExecutionMode()).toBe('auto');
    expect(cm.getInvokePortOffset()).toBe(10000);
    expect(cm.getInvokeHost()).toBe('host.docker.internal');
  });

  it('reads enabled/execution/invokePortOffset from the config file', () => {
    const cm = cmWith({
      lambdaRuntime: {
        enabled: false,
        execution: 'artifact',
        invokePortOffset: 20000,
        invokeHost: '172.19.0.1',
      },
    });
    expect(cm.isLambdaRuntimeEnabled()).toBe(false);
    expect(cm.getLambdaExecutionMode()).toBe('artifact');
    expect(cm.getInvokePortOffset()).toBe(20000);
    expect(cm.getInvokeHost()).toBe('172.19.0.1');
  });

  it('falls back per-field when the lambdaRuntime block is partial', () => {
    const cm = cmWith({ lambdaRuntime: { execution: 'source' } });
    expect(cm.isLambdaRuntimeEnabled()).toBe(true);
    expect(cm.getLambdaExecutionMode()).toBe('source');
    expect(cm.getInvokePortOffset()).toBe(10000);
  });

  it('LSS_LAMBDA_RUNTIME=true / "1" enables, anything else disables', () => {
    process.env.LSS_LAMBDA_RUNTIME = 'true';
    expect(freshConfigManager().isLambdaRuntimeEnabled()).toBe(true);
    process.env.LSS_LAMBDA_RUNTIME = '1';
    expect(freshConfigManager().isLambdaRuntimeEnabled()).toBe(true);
    process.env.LSS_LAMBDA_RUNTIME = 'off';
    expect(freshConfigManager().isLambdaRuntimeEnabled()).toBe(false);
  });

  it('LSS_LAMBDA_RUNTIME merges over file config without clobbering execution', () => {
    process.env.LSS_LAMBDA_RUNTIME = 'false';
    const cm = cmWith({ lambdaRuntime: { enabled: true, execution: 'artifact' } });
    expect(cm.isLambdaRuntimeEnabled()).toBe(false);
    expect(cm.getLambdaExecutionMode()).toBe('artifact');
  });

  it('LSS_LAMBDA_EXECUTION accepts auto/artifact/source', () => {
    process.env.LSS_LAMBDA_EXECUTION = 'auto';
    expect(freshConfigManager().getLambdaExecutionMode()).toBe('auto');
    process.env.LSS_LAMBDA_EXECUTION = 'ARTIFACT'; // lowercased
    expect(freshConfigManager().getLambdaExecutionMode()).toBe('artifact');
    process.env.LSS_LAMBDA_EXECUTION = 'source';
    expect(freshConfigManager().getLambdaExecutionMode()).toBe('source');
  });

  it('LSS_LAMBDA_EXECUTION ignores invalid values (file value kept)', () => {
    process.env.LSS_LAMBDA_EXECUTION = 'bogus';
    const cm = cmWith({ lambdaRuntime: { execution: 'artifact' } });
    expect(cm.getLambdaExecutionMode()).toBe('artifact');
  });

  it('LSS_LAMBDA_WATCH=true / "1" enables the watch flag, anything else disables', () => {
    process.env.LSS_LAMBDA_WATCH = 'true';
    expect(freshConfigManager().getRuntimeConfigForService('/abs/svc').watch).toBe(true);
    process.env.LSS_LAMBDA_WATCH = '1';
    expect(freshConfigManager().getRuntimeConfigForService('/abs/svc').watch).toBe(true);
    process.env.LSS_LAMBDA_WATCH = 'no';
    expect(freshConfigManager().getRuntimeConfigForService('/abs/svc').watch).toBe(false);
  });

  it('LSS_INVOKE_HOST overrides file config without clobbering other lambdaRuntime fields', () => {
    process.env.LSS_INVOKE_HOST = '172.19.0.1';
    const cm = cmWith({ lambdaRuntime: { execution: 'artifact', invokeHost: 'host.docker.internal' } });
    expect(cm.getInvokeHost()).toBe('172.19.0.1');
    expect(cm.getLambdaExecutionMode()).toBe('artifact');
  });
});

describe('getRuntimeConfigForService', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('returns global defaults with watch left undefined when nothing is configured', () => {
    // No config file → configPath is '' → resolver falls back to process.cwd().
    const cm = freshConfigManager();
    expect(cm.getRuntimeConfigForService('/abs/some/access')).toEqual({
      enabled: true,
      execution: 'auto',
      watch: undefined,
      apiPort: undefined,
      invokePort: undefined,
    });
  });

  it('matches a per-service override by directory basename', () => {
    const cm = cmWith({
      serviceRuntime: {
        access: { enabled: false, apiPort: 3001, invokePort: 13001, execution: 'source', watch: true },
      },
    });
    expect(cm.getRuntimeConfigForService('/abs/microservices/access')).toEqual({
      enabled: false,
      execution: 'source',
      watch: true,
      apiPort: 3001,
      invokePort: 13001,
    });
  });

  it('a relative-path key wins over a basename key', () => {
    const cm = cmWith({
      serviceRuntime: {
        access: { apiPort: 1111 },
        'microservices/access': { apiPort: 2222 },
      },
    });
    const svc = path.join(process.cwd(), 'microservices/access');
    expect(cm.getRuntimeConfigForService(svc).apiPort).toBe(2222);
  });

  it('falls back to the global lambdaRuntime block for unset per-service fields', () => {
    const cm = cmWith({
      lambdaRuntime: { enabled: false, execution: 'artifact', watch: true },
      serviceRuntime: { access: { apiPort: 3001 } },
    });
    expect(cm.getRuntimeConfigForService('/abs/access')).toEqual({
      enabled: false,
      execution: 'artifact',
      watch: true,
      apiPort: 3001,
      invokePort: undefined,
    });
  });

  it('keeps watch undefined when neither the service nor the global block set it', () => {
    const cm = cmWith({
      lambdaRuntime: { execution: 'source' },
      serviceRuntime: { access: { enabled: true } },
    });
    expect(cm.getRuntimeConfigForService('/abs/access').watch).toBeUndefined();
  });

  it('returns only globals for a service with no matching override', () => {
    const cm = cmWith({
      lambdaRuntime: { execution: 'source' },
      serviceRuntime: { access: { execution: 'artifact' } },
    });
    expect(cm.getRuntimeConfigForService('/abs/other').execution).toBe('source');
  });
});

describe('printSummary', () => {
  it('prints a full summary in managed mode with dynamo proxy + auto package + config file', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(
      JSON.stringify({
        mode: 'managed',
        enableDynamoProxy: true,
        autoPackage: true,
        localstackAuthToken: 'secret',
      }),
    );
    const cm = freshConfigManager();
    expect(() => cm.printSummary()).not.toThrow();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Configuration Summary');
    expect(out).toContain('DynamoDB Proxy Port');
    expect(out).toContain('Package Command');
    expect(out).toContain('Config File');
    expect(out).toContain('LocalStack Auth Token: set');
  });

  it('prints a summary in external mode without image/proxy/package/config sections', () => {
    process.env.LSS_LOCALSTACK_MODE = 'external';
    const cm = freshConfigManager();
    expect(() => cm.printSummary()).not.toThrow();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    // External mode skips the image/auth-token block.
    expect(out).not.toContain('LocalStack Image');
    // No dynamo proxy → no proxy port line; no auto package → no command line.
    expect(out).not.toContain('DynamoDB Proxy Port');
    expect(out).not.toContain('Package Command');
    // No config file loaded (env-only) → no config file line.
    expect(out).not.toContain('Config File');
  });

  it('prints global package args/env (keys only) and per-service packaging when set', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoPackage: true,
        packageArgs: ['--param=custom-stage=offline'],
        packageEnv: { AWS_ACCESS_KEY_ID: 'super-secret' },
        servicePackaging: { access: { packageArgs: ['--param=custom-stage=offline'] } },
      }),
    );
    const cm = freshConfigManager();
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Package Args (global): --param=custom-stage=offline');
    expect(out).toContain('Package Env (global): AWS_ACCESS_KEY_ID');
    expect(out).toContain('Per-service Packaging: access');
    // Secret env VALUES must never be printed.
    expect(out).not.toContain('super-secret');
  });

  it('prints "not set" for the auth token when it is absent (managed mode)', () => {
    const cm = freshConfigManager();
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('LocalStack Auth Token: not set');
  });
});

describe('engine selection (self engine)', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('getEngineKind defaults to localstack', () => {
    const cm = freshConfigManager();
    expect(cm.getEngineKind()).toBe('localstack');
    expect(cm.isSelfEngine()).toBe(false);
  });

  it('engine from the config file', () => {
    expect(cmWith({ engine: 'self' }).getEngineKind()).toBe('self');
  });

  it('LSS_ENGINE env overrides the file (case-insensitive)', () => {
    process.env.LSS_ENGINE = 'SELF';
    expect(cmWith({ engine: 'localstack' }).getEngineKind()).toBe('self');
  });

  it('LSS_ENGINE accepts localstack', () => {
    process.env.LSS_ENGINE = 'localstack';
    expect(cmWith({ engine: 'self' }).getEngineKind()).toBe('localstack');
  });

  it('LSS_ENGINE ignores invalid values', () => {
    process.env.LSS_ENGINE = 'bogus';
    expect(freshConfigManager().getEngineKind()).toBe('localstack');
  });

  it('LSS_ENGINE_PORT merges over the file selfEngine block', () => {
    process.env.LSS_ENGINE_PORT = '24566';
    const cm = cmWith({ engine: 'self', selfEngine: { account: '111111111111' } });
    const resolved = cm.getSelfEngineConfig();
    expect(resolved.port).toBe(24566);
    expect(resolved.account).toBe('111111111111');
  });

  it('getSelfEngineConfig applies every default', () => {
    const resolved = freshConfigManager().getSelfEngineConfig();
    expect(resolved.port).toBe(14566);
    expect(resolved.dataDir).toBe(path.join(require('os').homedir(), '.lss', 'engine'));
    expect(resolved.account).toBe('000000000000');
    expect(resolved.idleUnloadMs).toBe(300000);
    expect(resolved.memoryBudgetMb).toBe(128);
    expect(resolved.fsync).toBe(false);
    expect(resolved.fallbackEndpoint).toBeNull();
    expect(resolved.persistence).toBe(true);
    expect(resolved.region).toBe('us-east-1');
  });

  it('getSelfEngineConfig honors explicit values', () => {
    const cm = cmWith({
      selfEngine: {
        port: 15000,
        dataDir: '/abs/engine',
        idleUnloadMs: 1000,
        memoryBudgetMb: 64,
        fsync: true,
        fallbackEndpoint: 'http://localhost:4566',
      },
    });
    const resolved = cm.getSelfEngineConfig();
    expect(resolved.port).toBe(15000);
    expect(resolved.dataDir).toBe('/abs/engine');
    expect(resolved.idleUnloadMs).toBe(1000);
    expect(resolved.memoryBudgetMb).toBe(64);
    expect(resolved.fsync).toBe(true);
    expect(resolved.fallbackEndpoint).toBe('http://localhost:4566');
  });

  it('resolves a relative dataDir against cwd', () => {
    const cm = cmWith({ selfEngine: { dataDir: 'rel/engine' } });
    expect(cm.getSelfEngineConfig().dataDir).toBe(path.resolve(process.cwd(), 'rel/engine'));
  });

  it('defaults dataDir under stateDir when stateDir is set (test isolation)', () => {
    const cm = cmWith({ stateDir: '/abs/state' });
    expect(cm.getSelfEngineConfig().dataDir).toBe(path.join('/abs/state', 'engine'));
  });

  it('getEngineEndpoint follows the active engine', () => {
    expect(freshConfigManager().getEngineEndpoint()).toBe('http://localhost:4566');
    expect(cmWith({ engine: 'self', selfEngine: { port: 15000 } }).getEngineEndpoint())
      .toBe('http://localhost:15000');
  });

  it('printSummary in self mode shows engine lines and hides LocalStack lines', () => {
    const cm = cmWith({
      engine: 'self',
      selfEngine: { fallbackEndpoint: 'http://localhost:4566' },
    });
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Engine: self');
    expect(out).toContain('Self Engine Port: 14566');
    expect(out).toContain('Self Engine Data Dir:');
    expect(out).toContain('Self Engine Fallback: http://localhost:4566');
    expect(out).not.toContain('LocalStack Mode');
  });

  it('printSummary in self mode omits the fallback line when unset', () => {
    const cm = cmWith({ engine: 'self' });
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Engine: self');
    expect(out).not.toContain('Self Engine Fallback');
  });

  it('printSummary in localstack mode shows the engine kind and LocalStack lines', () => {
    const cm = freshConfigManager();
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Engine: localstack');
    expect(out).toContain('LocalStack Mode: managed');
  });
});

describe('getInvokeHost under the self engine', () => {
  it('defaults to 127.0.0.1 in self mode (nothing runs in Docker)', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ engine: 'self' }));
    expect(freshConfigManager().getInvokeHost()).toBe('127.0.0.1');
  });

  it('an explicit invokeHost still wins in self mode', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(
      JSON.stringify({ engine: 'self', lambdaRuntime: { invokeHost: '10.0.0.7' } }),
    );
    expect(freshConfigManager().getInvokeHost()).toBe('10.0.0.7');
  });
});

describe('branding', () => {
  function cmWith(config: Record<string, unknown>, extraFiles: string[] = []): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile || extraFiles.includes(String(p)));
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('returns neutral defaults when branding is not configured', () => {
    expect(freshConfigManager().getBranding()).toEqual({
      title: 'Local Serverless Stack',
      subtitle: 'Local development control plane',
      logoUrl: null,
      faviconUrl: null,
      defaultTheme: 'dark',
      colors: {},
      themeColors: { dark: {}, light: {} },
    });
  });

  it('passes through title, subtitle, defaultTheme and color overrides', () => {
    const cm = cmWith({
      branding: {
        title: 'Acme Cloud',
        subtitle: 'Sandbox local',
        defaultTheme: 'light',
        colors: { 'brand-primary': '#e63946' },
        themeColors: { dark: { 'bg-primary': '#111' } },
      },
    });
    const branding = cm.getBranding();
    expect(branding.title).toBe('Acme Cloud');
    expect(branding.subtitle).toBe('Sandbox local');
    expect(branding.defaultTheme).toBe('light');
    expect(branding.colors).toEqual({ 'brand-primary': '#e63946' });
    expect(branding.themeColors).toEqual({ dark: { 'bg-primary': '#111' }, light: {} });
  });

  it('falls back to dark for an invalid defaultTheme', () => {
    expect(cmWith({ branding: { defaultTheme: 'blue' } }).getBranding().defaultTheme).toBe('dark');
  });

  it('http(s) and data logo URLs pass through untouched and resolve no local file', () => {
    const cm = cmWith({ branding: { logo: 'https://acme.dev/logo.svg', favicon: 'data:image/png;base64,AAA' } });
    expect(cm.getBranding().logoUrl).toBe('https://acme.dev/logo.svg');
    expect(cm.getBranding().faviconUrl).toBe('data:image/png;base64,AAA');
    expect(cm.getBrandingAssetFile('logo')).toBeNull();
    expect(cm.getBrandingAssetFile('favicon')).toBeNull();
  });

  it('a relative logo path resolves from the config dir and is served by the orchestrator', () => {
    const resolved = path.resolve(process.cwd(), './assets/logo.svg');
    const cm = cmWith({ branding: { logo: './assets/logo.svg' } }, [resolved]);
    expect(cm.getBrandingAssetFile('logo')).toBe(resolved);
    expect(cm.getBranding().logoUrl).toBe('/api/config/branding/logo');
  });

  it('an absolute logo path is used as-is when the file exists', () => {
    const cm = cmWith({ branding: { logo: '/srv/assets/logo.png' } }, ['/srv/assets/logo.png']);
    expect(cm.getBrandingAssetFile('logo')).toBe('/srv/assets/logo.png');
    expect(cm.getBranding().logoUrl).toBe('/api/config/branding/logo');
  });

  it('a logo path pointing to a missing file yields null (no broken img in the UI)', () => {
    const cm = cmWith({ branding: { logo: './missing/logo.svg' } });
    expect(cm.getBrandingAssetFile('logo')).toBeNull();
    expect(cm.getBranding().logoUrl).toBeNull();
  });

  it('resolves relative assets from process.cwd() when no config path is recorded (defensive)', () => {
    const resolved = path.resolve(process.cwd(), './assets/logo.svg');
    const cm = cmWith({ branding: { logo: './assets/logo.svg' } }, [resolved]);
    (cm as any).configPath = '';
    expect(cm.getBrandingAssetFile('logo')).toBe(resolved);
  });
});
