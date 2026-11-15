// web-function-runtime.ts + web-function-manager.ts against REAL server
// processes (tests/fixtures/runtime/web/): the spawn environment, readiness
// (success, never listens, listens late, dies at boot), concurrency and the
// bounded queue, crash → restart, the SIGTERM → 1 s → SIGKILL shutdown, drain on
// reload, idle unload, artifact extraction and the TypeScript loaders.
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import { ConfigManager } from '../../../src/server/services/config-manager';
import {
  WebFunctionManager,
  WebFunctionError,
  terminate,
} from '../../../src/server/services/web-function-manager';
import {
  buildWebFunctionEnv,
  typescriptPreloadArgs,
  hasNativeTypeScript,
  pickFreePort,
  canConnect,
  waitForListening,
} from '../../../src/server/services/web-function-runtime';
import type { RegisteredWebFunction, WebRevision, WebCodeLocation } from '../../../src/server/services/web-function-assembler';

jest.setTimeout(30000);

const FIXTURES = path.join(__dirname, '../../fixtures/runtime/web');
const REPO = path.resolve(__dirname, '../../..');
const SERVICE = { name: 'orders', root: FIXTURES, region: 'eu-west-1' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function revision(id: string, over: Partial<WebRevision> = {}, code: Partial<WebCodeLocation> = {}): WebRevision {
  return {
    logicalId: `Rev${id}`,
    revisionId: id,
    arn: `arn:aws:lambda:eu-west-1:000000000000:web-function/web/revision/${id}`,
    runtime: 'nodejs24.x',
    environment: { RELEASE: id },
    timeoutSeconds: 5,
    maxConcurrency: 4,
    code: { source: 'source', reason: 'test', root: FIXTURES, entry: 'app.js', ...code },
    ...over,
  };
}

function webFunction(name: string, revisions: WebRevision[]): RegisteredWebFunction {
  return {
    service: SERVICE.name,
    name,
    logicalId: name,
    arn: `arn:aws:lambda:eu-west-1:000000000000:web-function/${name}`,
    revisions,
    endpoints: [],
    warnings: [],
  };
}

function get(port: number, urlPath = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode as number, body }));
    }).on('error', reject);
  });
}

function manager(over: ConstructorParameters<typeof WebFunctionManager>[0] = {}): WebFunctionManager {
  return new WebFunctionManager({
    readinessTimeoutMs: 2000,
    readinessPollMs: 20,
    drainTimeoutMs: 300,
    echo: false,
    lssResolveBase: path.join(REPO, 'package.json'),
    nativeTypeScript: false,
    ...over,
  });
}

let managers: WebFunctionManager[] = [];
function track(m: WebFunctionManager): WebFunctionManager {
  managers.push(m);
  return m;
}

const config = ConfigManager.getInstance();

beforeEach(() => {
  jest.spyOn(config, 'getLambdaIdleTimeoutMs').mockReturnValue(0);
  jest.spyOn(config, 'getWebFunctionQueueFactor').mockReturnValue(4);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(managers.map(m => m.stopAll()));
  managers = [];
  jest.restoreAllMocks();
});

describe('web-function-runtime helpers', () => {
  it('builds the server environment with Lambda-owned names winning', () => {
    const env = buildWebFunctionEnv({
      parentEnv: { PATH: '/bin', AWS_PROFILE: 'real', PORT: '14566' },
      region: 'eu-west-1',
      engineEndpoint: 'http://localhost:14566',
      serviceRoot: '/svc',
      revisionEnv: { RELEASE: 'stable', AWS_REGION: 'us-east-1', AWS_LAMBDA_HTTP_ENDPOINT: 'nope', SHARED: 'revision' },
      serviceEnv: { SHARED: 'service', AWS_LAMBDA_HTTP_ENDPOINT: 'nope' },
      functionEnv: { FN: '1' },
      host: '127.0.0.1',
      port: 40001,
      entry: 'src/web/server.js',
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      RELEASE: 'stable',
      SHARED: 'service',
      FN: '1',
      AWS_REGION: 'eu-west-1',
      AWS_ENDPOINT_URL: 'http://localhost:14566',
      AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:40001',
      AWS_LAMBDA_NODEJS_ENTRYPOINT: 'src/web/server.js',
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '2048',
      PORT: '40001',
      HOSTNAME: '127.0.0.1',
    });
    expect(env.AWS_PROFILE).toBeUndefined();
    const own = buildWebFunctionEnv({
      parentEnv: {}, region: 'r', engineEndpoint: 'e', serviceRoot: '/s',
      revisionEnv: { AWS_LAMBDA_NODEJS_ENTRYPOINT: 'dist/index.js' }, host: 'h', port: 1, entry: 'x.js',
    });
    expect(own.AWS_LAMBDA_NODEJS_ENTRYPOINT).toBe('dist/index.js');
  });

  it('picks TypeScript preloads in the worker order, service first', () => {
    expect(typescriptPreloadArgs('/a/server.js', [REPO], false)).toEqual([]);
    expect(typescriptPreloadArgs('/a/server.ts', [REPO], true)).toEqual([]);
    const tsx = typescriptPreloadArgs('/a/server.mts', [path.join(REPO, 'package.json')], false);
    expect(tsx[0]).toBe('--import');
    expect(tsx[1]).toMatch(/^file:.*tsx/);
    const withEsbuild = path.join(REPO, 'tests/integration/fixtures/apigw-raw/users-service/noop.js');
    expect(typescriptPreloadArgs('/a/server.ts', [withEsbuild], false)).toEqual(['--require', expect.stringContaining('esbuild-register')]);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ts-'));
    const tsNode = path.join(tmp, 'node_modules', 'ts-node', 'register');
    fs.mkdirSync(tsNode, { recursive: true });
    fs.writeFileSync(path.join(tsNode, 'transpile-only.js'), '');
    expect(typescriptPreloadArgs('/a/server.cts', [path.join(tmp, 'noop.js')], false)).toEqual(['--require', path.join(tsNode, 'transpile-only.js')]);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-ts-empty-'));
    expect(() => typescriptPreloadArgs('/a/server.ts', [path.join(empty, 'noop.js')], false)).toThrow(/no TS loader/);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('detects native type stripping', () => {
    expect(hasNativeTypeScript({ typescript: 'strip' })).toBe(true);
    expect(hasNativeTypeScript({})).toBe(false);
    expect(typeof hasNativeTypeScript()).toBe('boolean');
  });

  it('picks free ports, probes them and reports readiness outcomes', async () => {
    const port = await pickFreePort('127.0.0.1');
    expect(await canConnect('127.0.0.1', port)).toBe(false);
    await expect(pickFreePort('256.0.0.1')).rejects.toThrow();
    expect(await waitForListening({ host: '127.0.0.1', port, timeoutMs: 60, pollMs: 20, exited: () => false })).toBe('timeout');
    expect(await waitForListening({ host: '127.0.0.1', port, timeoutMs: 60, pollMs: 20, exited: () => true })).toBe('exited');
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    expect(await waitForListening({ host: '127.0.0.1', port, timeoutMs: 60, pollMs: 20, exited: () => false })).toBe('ready');
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});

describe('WebFunctionManager', () => {
  it('starts lazily, shares one cold start, serves, logs and reports state', async () => {
    const m = track(manager({ echo: true }));
    jest.spyOn(config, 'getWorkerOverridesForService').mockReturnValue({ env: { FROM_SERVICE: 'yes' }, execArgv: [], functions: { web: { env: { FROM_FN: 'yes' } } } });
    await m.syncService(SERVICE, [webFunction('web', [revision('r1', { environment: { RELEASE: 'r1', LOG_LINES: '3' } })])]);
    expect(m.functionState('orders', 'web')).toBe('cold');
    expect(m.revisionStatus('orders', 'web', 'r1')).toEqual({ revisionId: 'r1', state: 'cold', inFlight: 0, queued: 0 });

    const [a, b] = await Promise.all([m.acquire('orders', 'web', 'r1'), m.acquire('orders', 'web', 'r1')]);
    expect([a.coldStart, b.coldStart]).toEqual([true, false]);
    expect(a.port).toBe(b.port);
    expect((await get(a.port)).body).toBe('hello from r1');
    const env = JSON.parse((await get(a.port, '/env')).body);
    expect(env).toMatchObject({ FROM_SERVICE: 'yes', FROM_FN: 'yes', AWS_REGION: 'eu-west-1', AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${a.port}` });

    const status = m.revisionStatus('orders', 'web', 'r1');
    expect(status).toMatchObject({ state: 'ready', inFlight: 2, queued: 0, innerPort: a.port });
    expect(status.pid).toEqual(expect.any(Number));
    expect(status.coldStartMs).toEqual(expect.any(Number));
    expect(m.functionState('orders', 'web')).toBe('ready');
    a.release();
    a.release();
    b.release();
    expect(m.revisionStatus('orders', 'web', 'r1').inFlight).toBe(0);
    const c = await m.acquire('orders', 'web', 'r1');
    expect(c.coldStart).toBe(false);
    c.release();

    await sleep(100);
    const logs = m.getLogs('orders', 'web');
    expect(logs.map(l => l.stream)).toEqual(expect.arrayContaining(['stdout', 'stderr', 'lss']));
    expect(logs.some(l => l.text.includes('partial line'))).toBe(false);
    expect(logs.filter(l => /^line \d$/.test(l.text))).toHaveLength(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[web:orders/web] a line on stderr'));
    expect(m.listFunctions()).toHaveLength(1);
  });

  it('queues past MaxConcurrencyPerEnvironment and answers 429 when the queue is full', async () => {
    jest.spyOn(config, 'getWebFunctionQueueFactor').mockReturnValue(1);
    const m = track(manager());
    await m.syncService(SERVICE, [webFunction('web', [revision('r1', { maxConcurrency: 1 })])]);
    const first = await m.acquire('orders', 'web', 'r1');
    const queued = m.acquire('orders', 'web', 'r1');
    await sleep(20);
    expect(m.revisionStatus('orders', 'web', 'r1').queued).toBe(1);
    await expect(m.acquire('orders', 'web', 'r1')).rejects.toMatchObject({ status: 429, errorType: 'Platform.EndpointMaxEnvThrottle' });
    first.release();
    const second = await queued;
    expect(second.coldStart).toBe(false);
    second.release();
  });

  it('fails initialisation the documented ways', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-web-empty-'));
    fs.writeFileSync(path.join(tmp, 'server.ts'), '');
    const m = track(manager({ readinessTimeoutMs: 300, lssResolveBase: path.join(tmp, 'noop.js') }));
    await m.syncService({ name: 'orders', root: tmp }, [webFunction('web', [
      revision('never', {}, { entry: 'never-listens.js' }),
      revision('boot', {}, { entry: 'exits-on-boot.js' }),
      revision('signal', { environment: { BOOT_SIGNAL: 'SIGKILL' } }, { entry: 'exits-on-boot.js' }),
      revision('missing', {}, { source: 'missing', reason: 'nothing to run' }),
      revision('nofile', {}, { entry: 'does-not-exist.js' }),
      revision('ts', {}, { root: tmp, entry: 'server.ts' }),
      revision('zip', {}, { source: 'artifact', artifact: path.join(tmp, 'gone.zip') }),
    ])]);
    const failure = (id: string) => m.acquire('orders', 'web', id).then(() => null, (err: WebFunctionError) => err);

    expect(await failure('never')).toMatchObject({ status: 502, errorType: 'Application.TimeoutListenError', name: 'WebFunctionError' });
    expect(m.functionState('orders', 'web')).toBe('error');
    expect(m.revisionStatus('orders', 'web', 'never')).toMatchObject({ state: 'error', errorType: 'Application.TimeoutListenError' });
    // The next request tries again — a fixed app recovers without a restart.
    expect(await failure('never')).toMatchObject({ errorType: 'Application.TimeoutListenError' });
    // A reload while a failing start is in flight waits for it, then moves on.
    const failing = failure('never');
    await sleep(20);
    await m.reloadService('orders');
    expect(await failing).toMatchObject({ errorType: 'Application.TimeoutListenError' });
    expect(await failure('boot')).toMatchObject({ errorType: 'Application.InitCodeError', message: expect.stringContaining('code 3') });
    expect(await failure('signal')).toMatchObject({ errorType: 'Application.InitCodeError', message: expect.stringContaining('SIGKILL') });
    expect(await failure('missing')).toMatchObject({ errorType: 'Runtime.ImportCodeError', message: 'nothing to run' });
    expect(await failure('nofile')).toMatchObject({ errorType: 'Runtime.ImportCodeError' });
    expect(await failure('ts')).toMatchObject({ errorType: 'Runtime.ImportCodeError', message: expect.stringContaining('no TS loader') });
    expect(await failure('zip')).toMatchObject({ status: 502, errorType: 'Runtime.InitTimeout' });
    expect(await failure('unknown')).toMatchObject({ status: 404, errorType: 'Platform.InvalidEndpoint' });
    expect(m.getLogs('orders', 'web').some(l => l.text.includes('initialisation failed'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('waits for a server that listens late, inside the deadline', async () => {
    const m = track(manager({ readinessTimeoutMs: 3000 }));
    await m.syncService(SERVICE, [webFunction('web', [revision('late', { environment: { LATE_MS: '500' } }, { entry: 'late-listener.js' })])]);
    const pending = m.acquire('orders', 'web', 'late');
    await sleep(100);
    expect(m.functionState('orders', 'web')).toBe('starting');
    const lease = await pending;
    expect((await get(lease.port)).body).toBe('late but fine');
    lease.release();
  });

  it('starts a TypeScript entry through LSS\'s loader', async () => {
    const m = track(manager());
    await m.syncService({ name: 'orders', root: FIXTURES }, [webFunction('web', [revision('ts', {}, { entry: 'app.ts' })])]);
    const lease = await m.acquire('orders', 'web', 'ts');
    expect((await get(lease.port)).body).toBe('typed hello');
    lease.release();
  });

  it('extracts an artifact once and runs from the extraction', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-web-zip-'));
    const zipPath = path.join(tmp, 'orders.zip');
    const zip = new AdmZip();
    zip.addLocalFile(path.join(FIXTURES, 'app.js'), '', 'server.js');
    zip.writeZip(zipPath);
    jest.spyOn(config, 'getProjectRoot').mockReturnValue(tmp);
    const m = track(manager({ runtimeDir: path.join(tmp, 'runtime') }));
    await m.syncService({ name: 'orders', root: tmp }, [webFunction('web', [revision('z', {}, { source: 'artifact', artifact: zipPath, root: tmp, entry: 'server.js' })])]);
    const lease = await m.acquire('orders', 'web', 'z');
    expect((await get(lease.port)).body).toBe('hello from z');
    lease.release();
    await m.restartFunction('orders', 'web');
    const again = await m.acquire('orders', 'web', 'z');
    expect(again.coldStart).toBe(true);
    again.release();
    expect(fs.readdirSync(path.join(tmp, 'runtime'))).toHaveLength(1);
    await m.stopAll();
    // Default location: ~/.lss/orchestrator/runtime.
    jest.spyOn(os, 'homedir').mockReturnValue(tmp);
    const defaults = track(manager());
    await defaults.syncService({ name: 'orders', root: tmp }, [webFunction('web', [revision('z', {}, { source: 'artifact', artifact: zipPath, root: tmp, entry: 'server.js' })])]);
    (await defaults.acquire('orders', 'web', 'z')).release();
    expect(fs.existsSync(path.join(tmp, '.lss', 'orchestrator', 'runtime'))).toBe(true);
    await defaults.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('marks a crashed process cold and starts a new one on the next request', async () => {
    const m = track(manager());
    await m.syncService(SERVICE, [webFunction('web', [revision('r1', { maxConcurrency: 1 })])]);
    const lease = await m.acquire('orders', 'web', 'r1');
    const queued = m.acquire('orders', 'web', 'r1');
    await get(lease.port, '/crash').catch(() => undefined);
    await sleep(150);
    expect(m.revisionStatus('orders', 'web', 'r1')).toMatchObject({ state: 'cold', lastExitCode: 1 });
    // The queued request is handed the slot, sees the environment gone and
    // starts a fresh one.
    lease.release();
    const fresh = await queued;
    expect(fresh.port).not.toBe(lease.port);
    expect((await get(fresh.port)).status).toBe(200);
    fresh.release();
    expect(m.getLogs('orders', 'web').some(l => l.text.includes('exited unexpectedly'))).toBe(true);
  });

  it('drains in-flight requests on reload and moves the queue to the new environment', async () => {
    const m = track(manager());
    await m.syncService(SERVICE, [webFunction('web', [revision('r1', { maxConcurrency: 1 })])]);
    const held = await m.acquire('orders', 'web', 'r1');
    const queued = m.acquire('orders', 'web', 'r1');
    await sleep(20);
    const started = Date.now();
    await m.reloadService('orders');
    // Bounded drain (300 ms here), then SIGTERM.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const moved = await queued;
    expect(moved.port).not.toBe(held.port);
    held.release();
    moved.release();

    // A drain that completes early does not wait out the bound.
    const inFlight = await m.acquire('orders', 'web', 'r1');
    const reload = m.reloadService('orders');
    setTimeout(() => inFlight.release(), 30);
    const t0 = Date.now();
    await reload;
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('retires an environment that is still starting', async () => {
    const m = track(manager({ readinessTimeoutMs: 3000 }));
    await m.syncService(SERVICE, [webFunction('web', [revision('late', { environment: { LATE_MS: '300' } }, { entry: 'late-listener.js' })])]);
    const pending = m.acquire('orders', 'web', 'late');
    await sleep(50);
    await m.reloadService('orders');
    const lease = await pending;
    expect((await get(lease.port)).body).toBe('late but fine');
    lease.release();
  });

  it('SIGKILLs a server that ignores SIGTERM after the 1 s grace', async () => {
    const m = track(manager());
    await m.syncService(SERVICE, [webFunction('web', [revision('stubborn', {}, { entry: 'ignores-sigterm.js' })])]);
    const lease = await m.acquire('orders', 'web', 'stubborn');
    const pid = m.revisionStatus('orders', 'web', 'stubborn').pid as number;
    lease.release();
    await sleep(100);
    const started = Date.now();
    expect(await m.restartFunction('orders', 'web')).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(m.getLogs('orders', 'web').some(l => l.text === 'SIGTERM ignored')).toBe(true);
  });

  it('unloads an idle environment through the shared sweep', async () => {
    jest.spyOn(config, 'getLambdaIdleTimeoutMs').mockReturnValue(200);
    const m = track(manager());
    await m.syncService(SERVICE, [
      webFunction('a', [revision('r1')]),
      webFunction('b', [revision('r2')]),
    ]);
    const a = await m.acquire('orders', 'a', 'r1');
    const b = await m.acquire('orders', 'b', 'r2');
    // Retiring one function while another runs keeps the sweep alive.
    await m.restartFunction('orders', 'a');
    a.release();
    b.release();
    await sleep(700);
    expect(m.functionState('orders', 'b')).toBe('cold');
    expect(m.getLogs('orders', 'b').some(l => l.text.includes('idle for 200 ms'))).toBe(true);
  });

  it('keeps history across re-registration and forgets removed services', async () => {
    const m = track(manager());
    await m.syncService({ name: 'orders', root: FIXTURES }, [webFunction('web', [revision('r1')])]);
    for (let i = 0; i < 55; i++) {
      m.recordRequest('orders', 'web', { at: i, method: 'GET', path: '/', status: i === 0 ? 500 : 200, durationMs: 1, requestId: `${i}`, endpoint: 'live', coldStart: false });
    }
    m.recordRequest('orders', 'ghost', { at: 0, method: 'GET', path: '/', status: 200, durationMs: 1, requestId: 'x', endpoint: 'live', coldStart: false });
    expect(m.getRequests('orders', 'web')).toHaveLength(50);
    expect(m.getTotals('orders', 'web')).toEqual({ requests: 55, errors: 1, lastRequestAt: 54 });
    const lease = await m.acquire('orders', 'web', 'r1');
    lease.release();
    await m.syncService({ name: 'orders', root: FIXTURES }, [webFunction('web', [revision('r1', { environment: { LOG_LINES: '520' } })]), webFunction('other', [])]);
    expect(m.getTotals('orders', 'web').requests).toBe(55);
    expect(m.functionState('orders', 'web')).toBe('cold');
    const big = await m.acquire('orders', 'web', 'r1');
    big.release();
    await sleep(200);
    expect(m.getLogs('orders', 'web')).toHaveLength(500);

    await m.removeService('orders');
    expect(m.listFunctions()).toEqual([]);
    expect(m.getFunction('orders', 'web')).toBeUndefined();
    expect(m.getLogs('orders', 'web')).toEqual([]);
    expect(m.getRequests('orders', 'web')).toEqual([]);
    expect(m.getTotals('orders', 'web')).toEqual({ requests: 0, errors: 0, lastRequestAt: undefined });
    expect(m.functionState('orders', 'web')).toBe('cold');
    expect(await m.restartFunction('orders', 'web')).toBe(false);
  });

  it('gives up when the environment keeps going away', async () => {
    const m = track(manager());
    await m.syncService(SERVICE, [webFunction('web', [revision('r1')])]);
    jest.spyOn(m as unknown as { start: (env: { state: string; retired: boolean }) => Promise<void> }, 'start')
      .mockImplementation(async env => {
        env.state = 'ready';
        env.retired = true;
      });
    await expect(m.acquire('orders', 'web', 'r1')).rejects.toMatchObject({ status: 503, errorType: 'Runtime.Unreachable' });
  });

  it('ignores the exit of a process it no longer tracks', () => {
    const m = track(manager());
    const env = { process: undefined, state: 'ready', retired: false };
    (m as unknown as { onExit: (e: unknown, c: unknown, code: number) => void }).onExit(env, {}, 0);
    expect(env.state).toBe('ready');
  });

  it('uses defaults for the singleton', () => {
    const instance = WebFunctionManager.getInstance();
    expect(WebFunctionManager.getInstance()).toBe(instance);
    instance.setLssResolveBase(__filename);
    expect(new WebFunctionManager()).toBeInstanceOf(WebFunctionManager);
  });
});

describe('terminate', () => {
  it('resolves at once for a process that already exited', async () => {
    const child = spawn(process.execPath, ['-e', '0']);
    await new Promise(resolve => child.once('exit', resolve));
    await expect(terminate(child, 1000)).resolves.toBeUndefined();
  });
});
