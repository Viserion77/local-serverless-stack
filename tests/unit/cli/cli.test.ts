// In-process unit tests for bin/cli.js. The existing tests/unit/cli-seed.test.ts
// spawns the CLI as a subprocess (which does NOT count toward in-process
// coverage); these tests require the module directly and exercise every exported
// helper, mocking fs, child_process, http and readline so nothing touches the
// real filesystem, network, or process table.
//
// EXPLICIT_CONFIG is resolved once at module load from process.argv, so any test
// that needs a particular `--config`/argv shape sets process.argv first, then
// jest.resetModules() + re-requires the module via loadCli().

// Every mocked module is backed by a module-level set of jest.fns that the mock
// factory returns BY REFERENCE. This matters because loadCli() calls
// jest.resetModules() before re-requiring the CLI: the factories run again, but
// must hand back the same fn instances we configure here, so configuration set in
// a test is the implementation the freshly-required CLI module actually sees.
const mockFs = {
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  openSync: jest.fn(),
  closeSync: jest.fn(),
};
jest.mock('fs', () => mockFs);

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: mockSpawn }));

// The CLI's getJson/postJson call require('http').request.
const mockHttpRequest = jest.fn();
jest.mock('http', () => ({ request: mockHttpRequest }));

// readline.createInterface is a getter-only export on the namespace, so spyOn
// throws "Cannot redefine property". Mock the whole module instead.
const mockCreateInterface = jest.fn();
jest.mock('readline', () => ({ createInterface: mockCreateInterface }));

const CLI_PATH = require.resolve('../../../bin/cli.js');

type Cli = typeof import('../../../bin/cli.js');

function loadCli(argv: string[] = ['node', 'cli.js'], env: Record<string, string | undefined> = {}): Cli {
  process.argv = argv;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jest.resetModules();
  return require(CLI_PATH);
}

// Thrown by the mocked process.exit so the calling code stops, mirroring the
// real process.exit which never returns.
class ExitError extends Error {
  constructor(public code?: number) {
    super(`process.exit(${code})`);
  }
}

// Runs an action expected to terminate via process.exit, swallowing the sentinel
// and returning the exit code so the test can assert on it.
async function expectExit(action: () => unknown): Promise<number | undefined> {
  try {
    await action();
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  throw new Error('expected process.exit to be called, but it was not');
}

// Describes the canned response (or connection error) for one HTTP request,
// keyed by the request's `method` option.
interface Route {
  status?: number;
  body?: string;
  statusMessage?: string;
  err?: any;
}

// Sets the canned behaviour of the mocked http.request used by the CLI's
// internal getJson/postJson (which call the free functions by closure, not via
// module.exports). `routes` maps an HTTP method to its canned outcome.
function installHttp(routes: Record<string, Route>): jest.Mock {
  mockHttpRequest.mockImplementation((opts: any, cb?: any): any => {
    const route = routes[opts.method] ?? routes.GET ?? routes.POST ?? {};
    const reqHandlers: Record<string, (e?: any) => void> = {};
    const req: any = {
      on: (ev: string, h: (e?: any) => void) => {
        reqHandlers[ev] = h;
        return req;
      },
      write: jest.fn(),
      end: jest.fn(),
    };
    setImmediate(() => {
      if (route.err) {
        reqHandlers.error?.(route.err);
        return;
      }
      const res: any = {
        statusCode: route.status ?? 200,
        statusMessage: route.statusMessage,
        handlers: {} as Record<string, (chunk?: any) => void>,
        on(ev: string, h: (chunk?: any) => void) {
          res.handlers[ev] = h;
          return res;
        },
      };
      cb?.(res);
      if (route.body) res.handlers.data?.(Buffer.from(route.body));
      res.handlers.end?.();
    });
    return req;
  });
  return mockHttpRequest;
}

describe('bin/cli.js helpers', () => {
  const origArgv = process.argv;
  const origEnv = { ...process.env };

  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  let killSpy: jest.SpyInstance;

  beforeEach(() => {
    // Reset implementations + call data of the module-level mocks so no test
    // leaks an http/readline/spawn/fs behaviour into the next.
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.unlinkSync.mockReset();
    mockFs.mkdirSync.mockReset();
    mockFs.openSync.mockReset();
    mockFs.closeSync.mockReset();
    mockSpawn.mockReset();
    mockHttpRequest.mockReset();
    mockCreateInterface.mockReset();

    // Pin the CLI's language: bin/i18n.js resolves the locale from the
    // environment at require time, and a CI box exporting LANG=pt_BR would
    // otherwise flip every string assertion below.
    process.env.LSS_LANG = 'en';

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Model process.exit faithfully: it must abort the current call stack, just
    // like the real thing, so code after `process.exit(1)` doesn't keep running
    // (which would, e.g., let runSeed fall through to an HTTP call). Throw a
    // sentinel and let callers assert via expectExit().
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code);
    }) as any);
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as any);

    // Sensible defaults: no config files anywhere, so loadConfig() returns {}.
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('{}');
    mockFs.mkdirSync.mockReturnValue(undefined as any);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.unlinkSync.mockReturnValue(undefined);
    mockFs.openSync.mockReturnValue(7 as any);
    mockFs.closeSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Always drop back to real timers so a failed fake-timer test can't leave
    // setImmediate/setTimeout stubbed and hang every subsequent async test.
    jest.useRealTimers();
    process.argv = origArgv;
    process.env = { ...origEnv };
  });

  // ---------------------------------------------------------------------------
  // getConfig
  // ---------------------------------------------------------------------------
  describe('getConfig', () => {
    it('applies defaults when the config is empty', () => {
      const cli = loadCli();
      expect(cli.getConfig({})).toEqual({
        serverPort: 14566,
        enableDynamoProxy: false,
        dynamoProxyPort: 8000,
        mode: 'managed',
        stateDir: undefined,
        engine: undefined,
        selfEnginePort: 14566,
      });
    });

    // The server applies these overrides, so the CLI has to agree: it prints the
    // ports AND derives the PID/log path from serverPort when no stateDir is set.
    // Disagreeing meant `LSS_DASHBOARD_PORT=… lss start` and `lss stop`
    // addressed two different files.
    it('applies the same environment overrides the server does', () => {
      const cli = loadCli(['node', 'cli.js'], {
        LSS_DASHBOARD_PORT: '3250',
        LSS_ENGINE_PORT: '14766',
        LSS_DYNAMO_PROXY_PORT: '8123',
        LSS_ENABLE_DYNAMO_PROXY: '1',
      });
      const out = cli.getConfig({ serverPort: 14566, selfEngine: { port: 14566 }, dynamoProxyPort: 8000 });
      expect(out.serverPort).toBe(3250);
      expect(out.selfEnginePort).toBe(14766);
      expect(out.dynamoProxyPort).toBe(8123);
      expect(out.enableDynamoProxy).toBe(true);
    });

    it('falls back to PORT, and to the file when an override is unset or garbage', () => {
      expect(loadCli(['node', 'cli.js'], { PORT: '4200' }).getConfig({}).serverPort).toBe(4200);
      const cli = loadCli(['node', 'cli.js'], {
        LSS_DASHBOARD_PORT: 'not-a-port',
        LSS_ENGINE_PORT: '0',
        PORT: undefined,
      });
      const out = cli.getConfig({ serverPort: 3300, selfEngine: { port: 15000 } });
      expect(out.serverPort).toBe(3300);
      expect(out.selfEnginePort).toBe(15000);
    });

    it('LSS_ENABLE_DYNAMO_PROXY set to anything else disables the proxy', () => {
      const cli = loadCli(['node', 'cli.js'], { LSS_ENABLE_DYNAMO_PROXY: 'no' });
      expect(cli.getConfig({ enableDynamoProxy: true }).enableDynamoProxy).toBe(false);
    });

    it('passes through provided values', () => {
      const cli = loadCli();
      const out = cli.getConfig({
        serverPort: 4000,
        enableDynamoProxy: true,
        dynamoProxyPort: 9000,
        stateDir: '.lss',
        engine: 'self',
        selfEngine: { port: 15000 },
      });
      expect(out.serverPort).toBe(4000);
      expect(out.enableDynamoProxy).toBe(true);
      expect(out.dynamoProxyPort).toBe(9000);
      expect(out.stateDir).toBe('.lss');
      expect(out.engine).toBe('self');
      expect(out.selfEnginePort).toBe(15000);
    });
  });

  // ---------------------------------------------------------------------------
  // getArgValue
  // ---------------------------------------------------------------------------
  describe('getArgValue', () => {
    it('reads the value from the following argv token', () => {
      const cli = loadCli(['node', 'cli.js', '--localstack-token', 'abc']);
      expect(cli.getArgValue('--localstack-token')).toBe('abc');
    });

    it('reads an inline name=value token', () => {
      const cli = loadCli(['node', 'cli.js', '--localstack-token=xyz']);
      expect(cli.getArgValue('--localstack-token')).toBe('xyz');
    });

    it('returns undefined when the flag is the last token (no value follows)', () => {
      const cli = loadCli(['node', 'cli.js', '--localstack-token']);
      expect(cli.getArgValue('--localstack-token')).toBeUndefined();
    });

    it('returns undefined when absent', () => {
      const cli = loadCli(['node', 'cli.js']);
      expect(cli.getArgValue('--nope')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // loadConfig + EXPLICIT_CONFIG
  // ---------------------------------------------------------------------------
  describe('loadConfig', () => {
    it('returns {} when no config files exist', () => {
      const cli = loadCli();
      expect(cli.loadConfig()).toEqual({});
    });

    it('reads + parses an explicit --config file when present', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('/my.json'));
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ serverPort: 5000 }));
      const cli = loadCli(['node', 'cli.js', '--config', '/abs/my.json']);
      expect(cli.loadConfig()).toEqual({ serverPort: 5000 });
    });

    it('warns and falls back when the explicit --config file is unparseable', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('/bad.json'));
      mockFs.readFileSync.mockReturnValue('not json{');
      const cli = loadCli(['node', 'cli.js', '--config', '/abs/bad.json']);
      expect(cli.loadConfig()).toEqual({});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse config file'));
    });

    it('warns when the explicit --config file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli(['node', 'cli.js', '--config', '/abs/missing.json']);
      expect(cli.loadConfig()).toEqual({});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Config file not found'));
    });

    it('honors LSS_CONFIG env when no --config flag is given', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('/env.json'));
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ serverPort: 6000 }));
      const cli = loadCli(['node', 'cli.js'], { LSS_CONFIG: '/abs/env.json' });
      expect(cli.loadConfig()).toEqual({ serverPort: 6000 });
    });

    it('falls back to a cwd candidate file when present', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('lss.config.json'));
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ serverPort: 7000 }));
      const cli = loadCli();
      expect(cli.loadConfig()).toEqual({ serverPort: 7000 });
    });

    it('warns and continues when a candidate file is unparseable', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('lss.config.json'));
      mockFs.readFileSync.mockReturnValue('}{ broken');
      const cli = loadCli();
      expect(cli.loadConfig()).toEqual({});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse config file'));
    });

    it('uses the ~ fallback for HOME candidates when HOME is unset', () => {
      // Drive the `process.env.HOME || '~'` fallback branch.
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli(['node', 'cli.js'], { HOME: undefined });
      expect(cli.loadConfig()).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // runtimePaths
  // ---------------------------------------------------------------------------
  describe('runtimePaths', () => {
    it('uses stateDir when configured (and mkdirs it)', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('lss.config.json'));
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ stateDir: '.lss-e2e' }));
      const cli = loadCli();
      const paths = cli.runtimePaths();
      expect(paths.pidFile).toContain('orchestrator.pid');
      expect(paths.logFile).toContain('orchestrator.log');
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('uses the legacy global temp path for the default port', () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli();
      const paths = cli.runtimePaths();
      expect(paths.pidFile).toContain('lss-orchestrator.pid');
      expect(paths.pidFile).not.toMatch(/lss-orchestrator-\d+\.pid/);
    });

    it('scopes the temp path by serverPort for a non-default port', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('lss.config.json'));
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ serverPort: 3200 }));
      const cli = loadCli();
      const paths = cli.runtimePaths();
      expect(paths.pidFile).toMatch(/lss-orchestrator-3200\.pid$/);
      expect(paths.logFile).toMatch(/lss-orchestrator-3200\.log$/);
    });
  });

  // ---------------------------------------------------------------------------
  // getOrchestratorPath
  // ---------------------------------------------------------------------------
  describe('getOrchestratorPath', () => {
    it('returns the first candidate that exists', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('index.js'));
      const cli = loadCli();
      expect(cli.getOrchestratorPath()).toContain('dist/server/index.js');
    });

    it('returns null when no candidate exists', () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli();
      expect(cli.getOrchestratorPath()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getServerPort
  // ---------------------------------------------------------------------------
  describe('getServerPort', () => {
    it('returns the default port when no config', () => {
      const cli = loadCli();
      expect(cli.getServerPort()).toBe(14566);
    });
  });

  // ---------------------------------------------------------------------------
  // formatError
  // ---------------------------------------------------------------------------
  describe('formatError', () => {
    it('handles null/undefined', () => {
      const cli = loadCli();
      expect(cli.formatError(undefined)).toBe('unknown error (no details)');
    });
    it('trims a non-empty string', () => {
      const cli = loadCli();
      expect(cli.formatError('  boom  ')).toBe('boom');
    });
    it('returns fallback for an empty string', () => {
      const cli = loadCli();
      expect(cli.formatError('   ')).toBe('unknown error (no details)');
    });
    it('prefers a non-empty message', () => {
      const cli = loadCli();
      expect(cli.formatError(new Error('kaboom'))).toBe('kaboom');
    });
    it('falls back to the I/O code when message is empty', () => {
      const cli = loadCli();
      expect(cli.formatError({ message: '   ', code: 'ECONNRESET' })).toBe('I/O error (ECONNRESET)');
    });
    it('falls back to the name when no message/code', () => {
      const cli = loadCli();
      expect(cli.formatError({ name: 'WeirdError' })).toBe('WeirdError');
    });
    it('stringifies an object with no useful fields', () => {
      const cli = loadCli();
      // String(obj) === '[object Object]' -> final fallback string
      expect(cli.formatError({})).toBe('unknown error (no details)');
    });
    it('uses a meaningful String() representation when available', () => {
      const cli = loadCli();
      const weird = { toString: () => 'custom-str' };
      expect(cli.formatError(weird)).toBe('custom-str');
    });
  });

  // ---------------------------------------------------------------------------
  // buildHttpError
  // ---------------------------------------------------------------------------
  describe('buildHttpError', () => {
    it('uses the JSON body .error field', () => {
      const cli = loadCli();
      const err = cli.buildHttpError({ statusCode: 500 } as any, JSON.stringify({ error: 'boom' }));
      expect(err.message).toBe('boom');
    });
    it('uses the JSON body .message field', () => {
      const cli = loadCli();
      const err = cli.buildHttpError({ statusCode: 500 } as any, JSON.stringify({ message: 'msg' }));
      expect(err.message).toBe('msg');
    });
    it('includes a short non-JSON snippet with statusMessage', () => {
      const cli = loadCli();
      const err = cli.buildHttpError({ statusCode: 502, statusMessage: 'Bad Gateway' } as any, 'oops text');
      expect(err.message).toBe('HTTP 502 Bad Gateway: oops text');
    });
    it('omits statusMessage when not present', () => {
      const cli = loadCli();
      const err = cli.buildHttpError({ statusCode: 500 } as any, 'oops');
      expect(err.message).toBe('HTTP 500: oops');
    });
    it('reports an empty-body status when data is absent', () => {
      const cli = loadCli();
      const err = cli.buildHttpError({ statusCode: 500 } as any, '');
      expect(err.message).toBe('HTTP 500 (no error body)');
    });
    it('ignores a body that is too long to be a snippet', () => {
      const cli = loadCli();
      const big = 'x'.repeat(400); // >= 300, not valid JSON -> parsed null, no snippet
      const err = cli.buildHttpError({ statusCode: 500 } as any, big);
      expect(err.message).toBe('HTTP 500 (no error body)');
    });
    it('falls past an empty-after-trim JSON error field to the body snippet', () => {
      const cli = loadCli();
      // parsed.error is whitespace -> fromBody is falsy after trim -> snippet path.
      const err = cli.buildHttpError({ statusCode: 400 } as any, JSON.stringify({ error: '   ' }));
      expect(err.message).toBe('HTTP 400: {"error":"   "}');
    });
  });

  // ---------------------------------------------------------------------------
  // firstPositional
  // ---------------------------------------------------------------------------
  describe('firstPositional', () => {
    it('returns the first non-flag arg after the command', () => {
      const cli = loadCli(['node', 'cli.js', 'seed', 'Users']);
      expect(cli.firstPositional()).toBe('Users');
    });
    it('skips leading flags', () => {
      const cli = loadCli(['node', 'cli.js', 'seed:clear', '--yes', 'Users']);
      expect(cli.firstPositional()).toBe('Users');
    });
    it('returns undefined when only flags follow', () => {
      const cli = loadCli(['node', 'cli.js', 'seed:clear', '--yes']);
      expect(cli.firstPositional()).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // printSeedRunResults
  // ---------------------------------------------------------------------------
  describe('printSeedRunResults', () => {
    it('counts missing tables and prints inserts/skips', () => {
      const cli = loadCli();
      const out = cli.printSeedRunResults([
        { tableName: 'A', inserted: 3 },
        { tableName: 'B', skipped: true, reason: 'B does not exist in the engine' },
        { tableName: 'C', skipped: true, reason: 'empty seed file' },
        { tableName: 'D', skipped: true },
      ]);
      expect(out).toEqual({ missingTables: 1 });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('A: 3 item(s) inserted'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('B: skipped'));
    });
  });

  // ---------------------------------------------------------------------------
  // printSeedClearResults
  // ---------------------------------------------------------------------------
  describe('printSeedClearResults', () => {
    it('prints deletions and skips', () => {
      const cli = loadCli();
      cli.printSeedClearResults([
        { tableName: 'A', deleted: 2 },
        { tableName: 'B', skipped: true, reason: 'gone' },
      ]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('A: 2 item(s) deleted'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('B: skipped (gone)'));
    });
  });

  // ---------------------------------------------------------------------------
  // printSeedMismatchDiagnostic
  // ---------------------------------------------------------------------------
  describe('printSeedMismatchDiagnostic', () => {
    it('focusTable branch with live tables', () => {
      const cli = loadCli();
      cli.printSeedMismatchDiagnostic({
        entries: [{ tableName: 'Users' }],
        liveTables: ['real-Users'],
        focusTable: 'Users',
      });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Seed file inspected: Users.json'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Live tables in the engine'));
    });

    it('lists multiple seed files when no focusTable and no live tables', () => {
      const cli = loadCli();
      cli.printSeedMismatchDiagnostic({
        entries: [{ tableName: 'Users' }, { tableName: 'Orders' }],
        liveTables: [],
        focusTable: undefined,
      });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Seed files inspected'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No live tables in the engine'));
    });

    it('reports no seed files when entries are empty', () => {
      const cli = loadCli();
      cli.printSeedMismatchDiagnostic({ entries: [], liveTables: undefined, focusTable: undefined });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No *.json file found in seedsDir'));
    });
  });

  // ---------------------------------------------------------------------------
  // ensureRunningOrExit
  // ---------------------------------------------------------------------------
  describe('ensureRunningOrExit', () => {
    it('does nothing when the pid file exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      const cli = loadCli();
      cli.ensureRunningOrExit();
      expect(exitSpy).not.toHaveBeenCalled();
    });
    it('errors and exits when the pid file is missing', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli();
      expect(await expectExit(() => cli.ensureRunningOrExit())).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    });
  });

  // ---------------------------------------------------------------------------
  // showLogs
  // ---------------------------------------------------------------------------
  describe('showLogs', () => {
    it('warns when no log file exists', () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli();
      cli.showLogs();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No log file at'));
    });
    it('prints the last 50 lines of the log file', () => {
      mockFs.existsSync.mockReturnValue(true);
      const lines = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
      mockFs.readFileSync.mockReturnValue(lines);
      const cli = loadCli();
      cli.showLogs();
      const printed = logSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(printed).toContain('line59');
      expect(printed).not.toContain('line0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // stopOrchestrator
  // ---------------------------------------------------------------------------
  describe('stopOrchestrator', () => {
    it('warns when not running', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli();
      await cli.stopOrchestrator();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    });
    it('kills the process, waits until it exits, and removes the pid file', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('12345\n');
      killSpy.mockImplementation((_pid: any, signal?: any) => {
        if (signal === 0) throw new Error('gone');
        return true as any;
      });
      const cli = loadCli();
      await cli.stopOrchestrator();
      expect(killSpy).toHaveBeenCalledWith('12345', 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith('12345', 0);
      expect(mockFs.unlinkSync).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stopped (PID: 12345)'));
    });
    it('reports a failure and removes a leftover pid file when SIGTERM throws', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('999');
      killSpy.mockImplementation(() => {
        throw new Error('no such process');
      });
      const cli = loadCli();
      await cli.stopOrchestrator();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop the orchestrator: no such process'));
      expect(mockFs.unlinkSync).toHaveBeenCalled();
    });
    it('handles a SIGTERM failure when the pid file already vanished', async () => {
      // The pid file exists at the gate (1st .pid lookup) but is gone by the time
      // the catch re-checks it (2nd .pid lookup); config lookups (.json) stay false.
      let pidLookups = 0;
      mockFs.existsSync.mockImplementation((p: any) => {
        if (!String(p).endsWith('.pid')) return false;
        pidLookups += 1;
        return pidLookups === 1;
      });
      mockFs.readFileSync.mockReturnValue('999');
      killSpy.mockImplementation(() => {
        throw new Error('gone');
      });
      const cli = loadCli();
      await cli.stopOrchestrator();
      expect(errorSpy).toHaveBeenCalled();
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    });
    it('warns after the exit wait times out but still removes the pid file', async () => {
      jest.useFakeTimers();
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('12345');
      killSpy.mockReturnValue(true as any);
      const cli = loadCli();
      const pending = cli.stopOrchestrator();
      await jest.advanceTimersByTimeAsync(10000);
      await pending;
      expect(mockFs.unlinkSync).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('did not exit within 10s'));
    });
  });

  // ---------------------------------------------------------------------------
  // showStatus
  // ---------------------------------------------------------------------------
  describe('showStatus', () => {
    it('reports NOT RUNNING when there is no pid file', () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli();
      cli.showStatus();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('NOT RUNNING'));
    });
    it('reports RUNNING (with proxy line) when the process is alive', () => {
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('lss.config.json')) return true;
        return true; // pid file exists
      });
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (String(p).endsWith('lss.config.json')) {
          return JSON.stringify({ enableDynamoProxy: true }) as any;
        }
        return '4242\n' as any;
      });
      const cli = loadCli();
      cli.showStatus();
      expect(killSpy).toHaveBeenCalledWith('4242', 0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('RUNNING (PID: 4242)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB Proxy'));
    });
    it('reports RUNNING without a proxy line when the proxy is disabled', () => {
      mockFs.existsSync.mockReturnValue(true); // pid file + no config file matters
      mockFs.readFileSync.mockReturnValue('4242');
      const cli = loadCli();
      cli.showStatus();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('RUNNING (PID: 4242)'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('DynamoDB Proxy'));
    });
    it('reports a stale pid file when the process is dead', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('4242');
      killSpy.mockImplementation(() => {
        throw new Error('ESRCH');
      });
      const cli = loadCli();
      cli.showStatus();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stale PID file'));
      expect(mockFs.unlinkSync).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // startOrchestrator
  // ---------------------------------------------------------------------------
  describe('startOrchestrator', () => {
    function makeChild() {
      return { pid: 4321, unref: jest.fn() };
    }

    it('reports already running when the pid file is alive', () => {
      // pid file exists; loadConfig has no file -> {}; kill(pid,0) succeeds.
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('.pid'));
      mockFs.readFileSync.mockReturnValue('111');
      const cli = loadCli();
      cli.startOrchestrator();
      expect(killSpy).toHaveBeenCalledWith('111', 0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running (PID: 111)'));
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('reports already running with the proxy line when enabled', () => {
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        return s.endsWith('.pid') || s.endsWith('lss.config.json');
      });
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (String(p).endsWith('lss.config.json')) {
          return JSON.stringify({ enableDynamoProxy: true }) as any;
        }
        return '111' as any;
      });
      const cli = loadCli();
      cli.startOrchestrator();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB Proxy'));
    });

    it('removes a stale pid file then spawns the orchestrator', () => {
      jest.useFakeTimers();
      // pid file exists but the process is dead; orchestrator path exists.
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        return s.endsWith('.pid') || s.endsWith('index.js');
      });
      mockFs.readFileSync.mockReturnValue('222');
      killSpy.mockImplementationOnce(() => {
        throw new Error('dead');
      });
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli();
      cli.startOrchestrator();
      expect(mockFs.unlinkSync).toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalled();
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(expect.any(String), '4321');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('started (PID: 4321)'));
    });

    it('errors and exits when the orchestrator is not built', async () => {
      // no pid file, no index.js anywhere -> getOrchestratorPath() === null
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli();
      expect(await expectExit(() => cli.startOrchestrator())).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Orchestrator not found'));
    });

    it('threads config into the spawned env and prints the proxy line', () => {
      jest.useFakeTimers();
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        // No pid file; config exists; orchestrator built.
        if (s.endsWith('.pid')) return false;
        if (s.endsWith('lss.config.json')) return true;
        if (s.endsWith('index.js')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ serverPort: 3300, dynamoProxyPort: 8123 }),
      );
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli([
        'node', 'cli.js', 'start', '--enable-dynamo-proxy', '--config', '/abs/lss.config.json',
      ]);
      cli.startOrchestrator();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [, , opts] = mockSpawn.mock.calls[0];
      const env = (opts as any).env;
      expect(env.PORT).toBe(3300);
      expect(env.LSS_ENABLE_DYNAMO_PROXY).toBe('true');
      expect(env.LSS_DYNAMO_PROXY_PORT).toBe(8123);
      expect(env.LSS_CONFIG_PATH).toBe('/abs/lss.config.json');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB Proxy'));
    });

    // v2 has one engine, so not one LocalStack variable reaches the child (and
    // therefore every forked worker). Each one exported would also be reported
    // by GET /api/config as env-overridden, greying out a Settings field for a
    // value the user never set.
    it('exports no LocalStack env var', () => {
      jest.useFakeTimers();
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('index.js'));
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli(['node', 'cli.js', 'start']);
      cli.startOrchestrator();
      const [, , opts] = mockSpawn.mock.calls[0];
      const env = (opts as any).env;
      for (const key of Object.keys(env)) {
        expect(key).not.toMatch(/LOCALSTACK/);
      }
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Self Engine: http://localhost:14566'));
    });

    it('prints the configured self engine port', () => {
      jest.useFakeTimers();
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        return s.endsWith('index.js') || s.endsWith('lss.config.json');
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ selfEngine: { port: 15000 } }));
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli(['node', 'cli.js', 'start']);
      cli.startOrchestrator();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Self Engine: http://localhost:15000'));
    });

    it('reports already running with the Self Engine line when engine is self', () => {
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        return s.endsWith('.pid') || s.endsWith('lss.config.json');
      });
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (String(p).endsWith('lss.config.json')) {
          return JSON.stringify({ engine: 'self' }) as any;
        }
        return '111' as any;
      });
      const cli = loadCli();
      cli.startOrchestrator();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Self Engine: http://localhost:14566'));
    });

    it('uses LOCALSTACK_AUTH_TOKEN env when no CLI token or config token is set', () => {
      jest.useFakeTimers();
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('.pid')) return false;
        if (s.endsWith('index.js')) return true;
        return false;
      });
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli(['node', 'cli.js', 'start'], { LOCALSTACK_AUTH_TOKEN: 'ENVTOK' });
      cli.startOrchestrator();
      const [, , opts] = mockSpawn.mock.calls[0];
      expect((opts as any).env.LOCALSTACK_AUTH_TOKEN).toBe('ENVTOK');
    });

    it('runs the 2s liveness timer success path', () => {
      jest.useFakeTimers();
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('.pid')) return false;
        if (s.endsWith('index.js')) return true;
        return false;
      });
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli(['node', 'cli.js', 'start'], { LOCALSTACK_AUTH_TOKEN: undefined });
      cli.startOrchestrator();
      killSpy.mockClear();
      jest.advanceTimersByTime(2000);
      expect(killSpy).toHaveBeenCalledWith(4321, 0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Service is running'));
      jest.useRealTimers();
    });

    it('runs the 2s liveness timer failure path (process died) and clears the pid file', () => {
      jest.useFakeTimers();
      // existsSync: false for pid at gate, true for index.js. Inside the timer
      // catch, the pidFile existsSync must be true so it gets unlinked.
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('.pid')) return true; // timer catch -> unlink
        if (s.endsWith('index.js')) return true;
        return false;
      });
      // But the gate at the top of startOrchestrator reads the pid file and would
      // think it's running. Re-route: pid gate uses existsSync(pidFile) too.
      // To take the spawn path we need NO pid file at the gate but a present one
      // in the timer. Use a call-count toggle.
      let pidExistsCalls = 0;
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('index.js')) return true;
        if (s.endsWith('.pid')) {
          pidExistsCalls += 1;
          // first call (gate): false -> spawn; later (timer catch): true -> unlink
          return pidExistsCalls > 1;
        }
        return false;
      });
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli(['node', 'cli.js', 'start']);
      cli.startOrchestrator();
      killSpy.mockClear();
      mockFs.unlinkSync.mockClear();
      killSpy.mockImplementation(() => {
        throw new Error('died');
      });
      jest.advanceTimersByTime(2000);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
      expect(mockFs.unlinkSync).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('handles the timer failure path when the pid file is already gone', () => {
      jest.useFakeTimers();
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('index.js')) return true;
        return false; // no pid file ever
      });
      mockSpawn.mockReturnValue(makeChild() as any);
      const cli = loadCli(['node', 'cli.js', 'start']);
      cli.startOrchestrator();
      killSpy.mockClear();
      mockFs.unlinkSync.mockClear();
      killSpy.mockImplementation(() => {
        throw new Error('died');
      });
      jest.advanceTimersByTime(2000);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // HTTP helpers: getJson / postJson
  // ---------------------------------------------------------------------------
  describe('getJson / postJson', () => {
    it('postJson resolves parsed JSON on 2xx', async () => {
      installHttp({ POST: { status: 200, body: JSON.stringify({ ok: 1 }) } });
      const cli = loadCli();
      await expect(cli.postJson('/api/seeds/run', { tableName: 'x' })).resolves.toEqual({ ok: 1 });
    });

    it('postJson resolves {} for an empty 2xx body', async () => {
      installHttp({ POST: { status: 204, body: '' } });
      const cli = loadCli();
      await expect(cli.postJson('/api/seeds/run', undefined)).resolves.toEqual({});
    });

    it('postJson wraps an unparseable 2xx body as { raw }', async () => {
      installHttp({ POST: { status: 200, body: 'not-json' } });
      const cli = loadCli();
      await expect(cli.postJson('/x', {})).resolves.toEqual({ raw: 'not-json' });
    });

    it('postJson rejects with an HTTP error on non-2xx', async () => {
      installHttp({ POST: { status: 500, body: JSON.stringify({ error: 'server boom' }) } });
      const cli = loadCli();
      await expect(cli.postJson('/x', {})).rejects.toThrow('server boom');
    });

    it('postJson rejects with the raw error when it carries a message', async () => {
      const err = new Error('socket hang up');
      installHttp({ POST: { err } });
      const cli = loadCli();
      await expect(cli.postJson('/x', {})).rejects.toBe(err);
    });

    it('postJson wraps a messageless connection error', async () => {
      installHttp({ POST: { err: { code: 'ECONNREFUSED' } } }); // no .message
      const cli = loadCli();
      await expect(cli.postJson('/x', {})).rejects.toThrow(/HTTP connection to the orchestrator failed/);
    });

    it('getJson resolves parsed JSON on 2xx', async () => {
      installHttp({ GET: { status: 200, body: JSON.stringify({ entries: [] }) } });
      const cli = loadCli();
      await expect(cli.getJson('/api/seeds')).resolves.toEqual({ entries: [] });
    });

    it('getJson resolves {} for an empty 2xx body', async () => {
      installHttp({ GET: { status: 200, body: '' } });
      const cli = loadCli();
      await expect(cli.getJson('/api/seeds')).resolves.toEqual({});
    });

    it('getJson wraps an unparseable 2xx body as { raw }', async () => {
      installHttp({ GET: { status: 200, body: 'oops' } });
      const cli = loadCli();
      await expect(cli.getJson('/api/seeds')).resolves.toEqual({ raw: 'oops' });
    });

    it('getJson rejects with an HTTP error on non-2xx', async () => {
      installHttp({ GET: { status: 404, body: JSON.stringify({ message: 'not found' }), statusMessage: 'Not Found' } });
      const cli = loadCli();
      await expect(cli.getJson('/api/seeds')).rejects.toThrow('not found');
    });

    it('getJson rejects with the raw error when it carries a message', async () => {
      const err = new Error('reset');
      installHttp({ GET: { err } });
      const cli = loadCli();
      await expect(cli.getJson('/x')).rejects.toBe(err);
    });

    it('getJson wraps a messageless connection error', async () => {
      installHttp({ GET: { err: { code: 'ECONNREFUSED' } } });
      const cli = loadCli();
      await expect(cli.getJson('/x')).rejects.toThrow(/HTTP connection to the orchestrator failed/);
    });
  });

  // ---------------------------------------------------------------------------
  // promptConfirmation
  // ---------------------------------------------------------------------------
  describe('promptConfirmation', () => {
    function installReadline(answer: string) {
      const rl: any = {
        question: jest.fn((_q: string, cb: (a: string) => void) => cb(answer)),
        close: jest.fn(),
      };
      mockCreateInterface.mockReturnValue(rl);
      return rl;
    }

    it('resolves true when the answer matches exactly (after trim)', async () => {
      const rl = installReadline('  confirmar  ');
      const cli = loadCli();
      await expect(cli.promptConfirmation('confirmar')).resolves.toBe(true);
      expect(rl.close).toHaveBeenCalled();
    });

    it('resolves false when the answer does not match', async () => {
      installReadline('nope');
      const cli = loadCli();
      await expect(cli.promptConfirmation('confirmar')).resolves.toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // runSeed
  // ---------------------------------------------------------------------------
  describe('runSeed', () => {
    it('seeds successfully without missing tables', async () => {
      mockFs.existsSync.mockReturnValue(true); // ensureRunningOrExit passes
      const httpSpy = installHttp({
        POST: { status: 200, body: JSON.stringify({ results: [{ tableName: 'Users', inserted: 3 }] }) },
      });
      const cli = loadCli(['node', 'cli.js', 'seed', 'Users']);
      await cli.runSeed('Users');
      // POST body carries the table name.
      const postBody = JSON.parse((httpSpy.mock.results[0].value as any).write.mock.calls[0][0]);
      expect(postBody).toEqual({ tableName: 'Users' });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Seeding Users'));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('seeds all tables when no table name given', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ POST: { status: 200, body: JSON.stringify({ results: [] }) } });
      const cli = loadCli(['node', 'cli.js', 'seed']);
      await cli.runSeed(undefined);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Applying seeds'));
    });

    it('falls back to [] results when the response omits results', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ POST: { status: 200, body: JSON.stringify({}) } });
      const cli = loadCli(['node', 'cli.js', 'seed']);
      await cli.runSeed(undefined);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('fetches the mismatch diagnostic when tables are missing', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        POST: {
          status: 200,
          body: JSON.stringify({
            results: [{ tableName: 'Users', skipped: true, reason: 'Users does not exist in the engine' }],
          }),
        },
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [
              { tableName: 'Users', tableExists: false },
              { tableName: 'Orders', tableExists: true },
            ],
            liveTables: ['real-Users'],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'seed', 'Users']);
      await cli.runSeed('Users');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Live tables in the engine'));
    });

    it('falls back to empty diagnostic fields when the list response is sparse', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        POST: {
          status: 200,
          body: JSON.stringify({
            results: [{ tableName: 'X', skipped: true, reason: 'X does not exist in the engine' }],
          }),
        },
        GET: { status: 200, body: JSON.stringify({}) }, // no entries, no liveTables
      });
      const cli = loadCli(['node', 'cli.js', 'seed']);
      await cli.runSeed(undefined);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No live tables in the engine'));
    });

    it('swallows a diagnostic failure (best-effort hint)', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        POST: {
          status: 200,
          body: JSON.stringify({
            results: [{ tableName: 'X', skipped: true, reason: 'X does not exist in the engine' }],
          }),
        },
        GET: { err: new Error('list failed') },
      });
      const cli = loadCli(['node', 'cli.js', 'seed']);
      await cli.runSeed(undefined);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('could not detail the live tables'));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('errors and exits when the seed POST fails', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ POST: { err: new Error('boom') } });
      const cli = loadCli(['node', 'cli.js', 'seed']);
      expect(await expectExit(() => cli.runSeed(undefined))).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Seed failed'), 'boom');
    });

    it('exits early when the orchestrator is not running', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const httpSpy = installHttp({ POST: { status: 200, body: '{}' } });
      const cli = loadCli(['node', 'cli.js', 'seed']);
      expect(await expectExit(() => cli.runSeed(undefined))).toBe(1);
      expect(httpSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // clearSeed
  // ---------------------------------------------------------------------------
  describe('clearSeed', () => {
    function mockReadline(answer: string) {
      const rl: any = {
        question: jest.fn((_q: string, cb: (a: string) => void) => cb(answer)),
        close: jest.fn(),
      };
      mockCreateInterface.mockReturnValue(rl);
      return rl;
    }

    it('clears all live tables after a confirmed prompt', async () => {
      mockFs.existsSync.mockReturnValue(true);
      const httpSpy = installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [
              { tableName: 'Users', tableExists: true },
              { tableName: 'Orders', tableExists: true },
            ],
            liveTables: ['Users', 'Orders'],
          }),
        },
        POST: { status: 200, body: JSON.stringify({ results: [{ tableName: 'Users', deleted: 1 }] }) },
      });
      mockReadline('confirmar');
      const cli = loadCli(['node', 'cli.js', 'seed:clear']);
      await cli.clearSeed(undefined);
      // The POST call (second http.request) carried an empty body for "all tables".
      const postReq = httpSpy.mock.results.map(r => r.value as any).find(v => v.write.mock.calls.length);
      expect(JSON.parse(postReq.write.mock.calls[0][0])).toEqual({});
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Clearing seeded tables'));
    });

    it('clears a specific table', async () => {
      mockFs.existsSync.mockReturnValue(true);
      const httpSpy = installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [{ tableName: 'Users', tableExists: true }],
            liveTables: ['Users'],
          }),
        },
        POST: { status: 200, body: JSON.stringify({ results: [{ tableName: 'Users', deleted: 1 }] }) },
      });
      mockReadline('confirmar');
      const cli = loadCli(['node', 'cli.js', 'seed:clear', 'Users']);
      await cli.clearSeed('Users');
      const postReq = httpSpy.mock.results.map(r => r.value as any).find(v => v.write.mock.calls.length);
      expect(JSON.parse(postReq.write.mock.calls[0][0])).toEqual({ tableName: 'Users' });
    });

    it('cancels when the prompt is declined', async () => {
      mockFs.existsSync.mockReturnValue(true);
      const httpSpy = installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [{ tableName: 'Users', tableExists: true }],
            liveTables: ['Users'],
          }),
        },
        POST: { status: 200, body: '{}' },
      });
      mockReadline('nope');
      const cli = loadCli(['node', 'cli.js', 'seed:clear']);
      await cli.clearSeed(undefined);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Aborted.'));
      // No POST was made (only the GET request).
      const posts = httpSpy.mock.results.filter(r => (r.value as any).write.mock.calls.length);
      expect(posts).toHaveLength(0);
    });

    it('skips the prompt with --yes', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [{ tableName: 'Users', tableExists: true }],
            liveTables: ['Users'],
          }),
        },
        POST: { status: 200, body: JSON.stringify({ results: [{ tableName: 'Users', deleted: 1 }] }) },
      });
      const cli = loadCli(['node', 'cli.js', 'seed:clear', '--yes']);
      await cli.clearSeed(undefined);
      expect(mockCreateInterface).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('skipping the interactive confirmation'));
    });

    it('skips the prompt with the short -y flag', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [{ tableName: 'Users', tableExists: true }],
            liveTables: ['Users'],
          }),
        },
        // No `results` key: exercises the `res.results || []` fallback in clearSeed.
        POST: { status: 200, body: JSON.stringify({}) },
      });
      const cli = loadCli(['node', 'cli.js', 'seed:clear', '-y']);
      await cli.clearSeed(undefined);
      expect(mockCreateInterface).not.toHaveBeenCalled();
    });

    it('exits early with a hint when the named table does not exist in the engine', async () => {
      mockFs.existsSync.mockReturnValue(true);
      const httpSpy = installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [{ tableName: 'Users', tableExists: true }],
            liveTables: ['Users'],
          }),
        },
        POST: { status: 200, body: '{}' },
      });
      const cli = loadCli(['node', 'cli.js', 'seed:clear', 'Ghost']);
      await cli.clearSeed('Ghost');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No table "Ghost" exists in the engine'));
      const posts = httpSpy.mock.results.filter(r => (r.value as any).write.mock.calls.length);
      expect(posts).toHaveLength(0);
    });

    it('reports an empty seedsDir when there are no entries at all', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ GET: { status: 200, body: JSON.stringify({ entries: [], liveTables: [] }) } });
      const cli = loadCli(['node', 'cli.js', 'seed:clear']);
      await cli.clearSeed(undefined);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No seed file (*.json) found in seedsDir'));
    });

    it('reports a name mismatch when entries exist but none are live', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [{ tableName: 'Ghost', tableExists: false }],
            liveTables: ['real-Ghost'],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'seed:clear']);
      await cli.clearSeed(undefined);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('NONE of the matching tables exist in the engine'),
      );
    });

    it('falls back to empty entries/liveTables when the list response is sparse', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ GET: { status: 200, body: JSON.stringify({}) } }); // no entries, no liveTables
      const cli = loadCli(['node', 'cli.js', 'seed:clear']);
      await cli.clearSeed(undefined);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No seed file (*.json) found in seedsDir'));
    });

    it('errors and exits when listing the tables fails', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ GET: { err: new Error('list down') } });
      const cli = loadCli(['node', 'cli.js', 'seed:clear']);
      expect(await expectExit(() => cli.clearSeed(undefined))).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not list the tables before clearing'),
        'list down',
      );
    });

    it('errors and exits when the clear POST fails', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            entries: [{ tableName: 'Users', tableExists: true }],
            liveTables: ['Users'],
          }),
        },
        POST: { err: new Error('clear down') },
      });
      const cli = loadCli(['node', 'cli.js', 'seed:clear', '--yes']);
      expect(await expectExit(() => cli.clearSeed(undefined))).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Clear failed'), 'clear down');
    });

    it('exits early when the orchestrator is not running', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const httpSpy = installHttp({ GET: { status: 200, body: '{}' } });
      const cli = loadCli(['node', 'cli.js', 'seed:clear']);
      expect(await expectExit(() => cli.clearSeed(undefined))).toBe(1);
      expect(httpSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // showHelp
  // ---------------------------------------------------------------------------
  describe('showHelp', () => {
    it('prints usage text', () => {
      const cli = loadCli();
      cli.showHelp();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Local Serverless Stack (LSS) CLI'));
    });
  });

  // `lss register` / `lss scan` — the plugin-free registration path. The
  // orchestrator resolves packaging/name/region/ports itself, so the CLI's only
  // duties are addressing, existence checks and honest exit codes.
  describe('registerServices', () => {
    it('POSTs each path and prints the result summary with warnings', async () => {
      mockFs.existsSync.mockReturnValue(true); // pid file + service dirs
      installHttp({
        POST: {
          status: 200,
          body: JSON.stringify({
            serviceName: 'orders', resourcesCount: 12, functionsCount: 2, routesCount: 2,
            warnings: ['not packaged yet'],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'register', 'svc-a', 'svc-b']);
      await cli.registerServices(['svc-a', 'svc-b']);
      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
      const opts = mockHttpRequest.mock.calls[0][0] as { path: string; method: string };
      expect(opts.method).toBe('POST');
      expect(opts.path).toBe('/api/services/register');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('orders: 12 resource(s), 2 function(s), 2 route(s)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not packaged yet'));
    });

    it('defaults to the current directory and tolerates a response without warnings', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        POST: {
          status: 200,
          body: JSON.stringify({ serviceName: 'here', resourcesCount: 1, functionsCount: 1, routesCount: 0 }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'register']);
      await cli.registerServices([]);
      expect(mockHttpRequest).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('here: 1 resource(s)'));
    });

    it('exits 1 when a directory does not exist, without calling the API', async () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('.pid'));
      const cli = loadCli(['node', 'cli.js', 'register', 'ghost-dir']);
      expect(await expectExit(() => cli.registerServices(['ghost-dir']))).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('directory not found'));
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it('exits 1 when the orchestrator rejects a registration', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ POST: { status: 500, body: JSON.stringify({ error: 'boom' }) } });
      const cli = loadCli(['node', 'cli.js', 'register']);
      expect(await expectExit(() => cli.registerServices(['.']))).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('requires a running orchestrator', async () => {
      mockFs.existsSync.mockReturnValue(false); // no pid file
      const cli = loadCli(['node', 'cli.js', 'register']);
      expect(await expectExit(() => cli.registerServices([]))).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    });
  });

  describe('scanServices', () => {
    it('prints each found service with flags, hints and warnings', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            projectRoot: '/abs',
            services: [
              { name: 'orders', relPath: 'services/orders', registered: true, installed: true, packaged: true, apiPort: 3631, invokePort: 13631, packageCommand: 'npx serverless package', warnings: [] },
              {
                name: 'fresh', relPath: 'services/fresh', registered: false, packaged: false,
                warnings: [
                  { code: 'not-packaged', message: 'not packaged yet — server wording' },
                  // A code this CLI has no string for still prints, via the
                  // English message the server sent with it.
                  { code: 'from-a-newer-server', message: 'something the CLI has never heard of' },
                ],
              },
              // api hint without invoke hint, and no warnings key at all
              { name: 'bare', relPath: 'services/bare', registered: false, packaged: true, apiPort: 3640 },
            ],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'scan']);
      await cli.scanServices();
      const out = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(out).toContain('3 service(s) under /abs');
      expect(out).toContain('✓ orders  (services/orders) — registered, installed, packaged api:3631 invoke:13631');
      expect(out).toContain('· fresh  (services/fresh) — not registered, not installed, not packaged');
      expect(out).toContain('· bare  (services/bare) — not registered, not installed, packaged api:3640');
      expect(out).toContain('package: npx serverless package');
      // Rendered from the code, not from the server's wording…
      expect(out).toContain('⚠ not packaged yet — registering packages it for you (autoPackage)');
      // …and an unknown code falls back to the message instead of vanishing.
      expect(out).toContain('⚠ something the CLI has never heard of');
      expect(out).toContain('npx lss register');
    });

    // `installed` is the flag onboarding shows beside registered/packaged: it
    // answers "can this be packaged at all, or does it need an install first?".
    // GET /scan has always returned it; the CLI used to drop it on the floor.
    it('reports the installed flag independently of packaged', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            projectRoot: '/abs',
            services: [
              { name: 'stale', relPath: 'services/stale', registered: false, installed: false, packaged: true },
              { name: 'ready', relPath: 'services/ready', registered: false, installed: true, packaged: false },
            ],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'scan']);
      await cli.scanServices();
      const out = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(out).toContain('· stale  (services/stale) — not registered, not installed, packaged');
      expect(out).toContain('· ready  (services/ready) — not registered, installed, not packaged');
    });

    // The effective package command is per-service configurable
    // (`servicePackaging`), so it earns its own line: it is what
    // install → package → register would actually run for that service.
    it('prints the effective package command only for the services that carry one', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            projectRoot: '/abs',
            services: [
              {
                name: 'orders', relPath: 'services/orders', registered: true, installed: true, packaged: true,
                packageCommand: 'npm run package:local',
              },
              // No packageCommand at all — the line is simply omitted.
              { name: 'bare', relPath: 'services/bare', registered: false, installed: true, packaged: false },
            ],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'scan']);
      await cli.scanServices();
      const out = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(out).toContain('      package: npm run package:local');
      expect(out.match(/package: /g)).toHaveLength(1);
    });

    // End-to-end proof that the catalogue is wired to the locale resolved from
    // the environment, not just to the English default.
    it('speaks the locale resolved from the environment', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            projectRoot: '/abs',
            services: [
              { name: 'orders', relPath: 'services/orders', registered: true, installed: false, packaged: false },
            ],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'scan'], { LSS_LANG: 'pt-BR' });
      await cli.scanServices();
      const out = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(out).toContain('1 serviço(s) sob /abs');
      expect(out).toContain('registrado, não instalado, não empacotado');
    });

    // Before the structured-warning refactor the server sent `warnings` as
    // plain strings. A CLI newer than the orchestrator it talks to still has to
    // print them verbatim — the renderer falls back to `String(warning)` rather
    // than looking up `scan.warning.undefined` and dropping the line.
    it('prints a legacy string warning from an older server verbatim', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({
        GET: {
          status: 200,
          body: JSON.stringify({
            projectRoot: '/abs',
            services: [
              {
                name: 'legacy', relPath: 'services/legacy', registered: false, installed: true, packaged: false,
                warnings: ['no .serverless directory — run serverless package'],
              },
            ],
          }),
        },
      });
      const cli = loadCli(['node', 'cli.js', 'scan']);
      await cli.scanServices();
      const out = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(out).toContain('⚠ no .serverless directory — run serverless package');
    });

    it('says so when nothing is found', async () => {
      mockFs.existsSync.mockReturnValue(true);
      // no `services` key at all — the CLI treats it as an empty list
      installHttp({ GET: { status: 200, body: JSON.stringify({ projectRoot: '/abs' }) } });
      const cli = loadCli(['node', 'cli.js', 'scan']);
      await cli.scanServices();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No Serverless/osls services found'));
    });

    it('exits 1 when the scan endpoint fails', async () => {
      mockFs.existsSync.mockReturnValue(true);
      installHttp({ GET: { status: 500, body: JSON.stringify({ error: 'disk' }) } });
      const cli = loadCli(['node', 'cli.js', 'scan']);
      expect(await expectExit(() => cli.scanServices())).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith('❌ Scan failed:', expect.stringContaining('disk'));
    });
  });

  describe('allPositionals', () => {
    it('collects non-flag args, skipping flag values', () => {
      const cli = loadCli(['node', 'cli.js', 'register', 'a', '--config', 'x.json', 'b', '-y']);
      expect(cli.allPositionals()).toEqual(['a', 'b']);
    });
  });

  // `lss mcp` launcher. The dynamic import of the ESM build is the process entry
  // point (it binds this process's stdio), so only the resolution and the
  // missing-build guard are unit-testable — the rest is covered by starting the
  // server for real in the MCP suite.
  describe('mcp command', () => {
    it('resolves the built MCP server next to the CLI', () => {
      mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('dist/mcp/server.js'));
      const cli = loadCli(['node', 'cli.js', 'mcp']);
      expect(cli.getMcpServerPath()).toMatch(/dist\/mcp\/server\.js$/);
    });

    it('returns null when nothing is built', () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(loadCli().getMcpServerPath()).toBeNull();
    });

    it('reads the package version, falling back when package.json is unreadable', () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '9.9.9' }));
      expect(loadCli().getPackageVersion()).toBe('9.9.9');
      mockFs.readFileSync.mockReturnValue('{ not json');
      expect(loadCli().getPackageVersion()).toBe('0.0.0');
      mockFs.readFileSync.mockReturnValue(JSON.stringify({}));
      expect(loadCli().getPackageVersion()).toBe('0.0.0');
    });

    it('tells the user to build before it can serve MCP', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const cli = loadCli(['node', 'cli.js', 'mcp']);
      expect(await expectExit(() => cli.runMcpServer())).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MCP server build not found'));
    });
  });
});
