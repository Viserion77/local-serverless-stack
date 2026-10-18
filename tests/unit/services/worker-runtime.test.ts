// Unit tests for the runtime worker's process-setup rules. Real temp
// directories for the filesystem helpers (no fs mocks), so symlink and
// realpath semantics — and Node's own ESM resolution through the links — are
// exercised for real.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  ancestorNodeModules,
  buildWorkerEnv,
  execArgvError,
  ignoredSubpaths,
  isIgnoredSubpath,
  linkArtifactNodeModules,
  resolveInvocationEnv,
  runtimeMismatchWarning,
} from '../../../src/server/services/worker-runtime';

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lss-worker-runtime-')));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('buildWorkerEnv', () => {
  const base = { region: 'eu-west-1', engineEndpoint: 'http://localhost:14566', serviceRoot: '/repo/orders' };

  it('points the SDK at the engine with dummy credentials and the service region', () => {
    const env = buildWorkerEnv({
      HOME: '/home/dev',
      AWS_ACCESS_KEY_ID: 'AKIAREAL',
      AWS_SECRET_ACCESS_KEY: 'real-secret',
      AWS_SESSION_TOKEN: 'real-session',
      AWS_SECURITY_TOKEN: 'legacy-session',
      AWS_PROFILE: 'prod',
      AWS_DEFAULT_PROFILE: 'prod',
      AWS_ROLE_ARN: 'arn:aws:iam::123:role/x',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/token',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/creds',
      AWS_REGION: 'us-west-2',
      AWS_ENDPOINT_URL: 'https://somewhere-else',
      AWS_ENDPOINT_URL_DYNAMODB: 'https://dynamo-elsewhere',
    }, base);
    expect(env).toMatchObject({
      HOME: '/home/dev',
      AWS_ENDPOINT_URL: 'http://localhost:14566',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_REGION: 'eu-west-1',
      AWS_DEFAULT_REGION: 'eu-west-1',
      NODE_PATH: path.join('/repo/orders', 'node_modules'),
    });
    for (const dropped of [
      'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_ENDPOINT_URL_DYNAMODB',
    ]) {
      expect(env).not.toHaveProperty(dropped);
    }
  });

  it('keeps an inherited NODE_PATH behind the service node_modules', () => {
    const env = buildWorkerEnv({ NODE_PATH: '/opt/shared' }, base);
    expect(env.NODE_PATH).toBe([path.join('/repo/orders', 'node_modules'), '/opt/shared'].join(path.delimiter));
  });

  it('lets the service-level override win over everything it sets', () => {
    const env = buildWorkerEnv({}, {
      ...base,
      serviceEnv: { AWS_ENDPOINT_URL: 'http://localhost:4566', AWS_ENDPOINT_URL_S3: 'http://s3.local', LOG_LEVEL: 'debug' },
    });
    expect(env.AWS_ENDPOINT_URL).toBe('http://localhost:4566');
    expect(env.AWS_ENDPOINT_URL_S3).toBe('http://s3.local');
    expect(env.LOG_LEVEL).toBe('debug');
  });
});

describe('resolveInvocationEnv', () => {
  it('layers template < service override < function override', () => {
    expect(resolveInvocationEnv(
      { TABLE: 'orders', STAGE: 'dev', ONLY_TEMPLATE: 't' },
      { TABLE: 'orders-local', STAGE: 'local' },
      { TABLE: 'orders-fn' },
    )).toEqual({ TABLE: 'orders-fn', STAGE: 'local', ONLY_TEMPLATE: 't' });
  });

  it('tolerates every layer being absent', () => {
    expect(resolveInvocationEnv(undefined, undefined, undefined)).toEqual({});
  });
});

describe('ancestorNodeModules', () => {
  it('lists every node_modules dir from the service up, nearest first', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.mkdirSync(path.join(tmp, 'services', 'orders', 'node_modules'), { recursive: true });
    // A FILE named node_modules is not a resolution root.
    write(path.join(tmp, 'services', 'node_modules'), '');
    const found = ancestorNodeModules(path.join(tmp, 'services', 'orders'));
    expect(found.slice(0, 2)).toEqual([
      path.join(tmp, 'services', 'orders', 'node_modules'),
      path.join(tmp, 'node_modules'),
    ]);
  });
});

describe('linkArtifactNodeModules', () => {
  let repo: string;
  let service: string;
  let extractDir: string;

  beforeEach(() => {
    repo = path.join(tmp, 'repo');
    service = path.join(repo, 'services', 'orders');
    extractDir = path.join(tmp, 'runtime', 'orders', 'abc123');
    fs.mkdirSync(extractDir, { recursive: true });
    // The service keeps one dependency of its own; the rest is hoisted.
    write(path.join(service, 'node_modules', 'acme-dep', 'package.json'), '{"name":"acme-dep","type":"module","exports":"./index.js"}');
    write(path.join(service, 'node_modules', 'acme-dep', 'index.js'), 'import h from "acme-hoisted"; export default `dep+${h}`;');
    write(path.join(repo, 'node_modules', 'acme-hoisted', 'package.json'), '{"name":"acme-hoisted","main":"index.js"}');
    write(path.join(repo, 'node_modules', 'acme-hoisted', 'index.js'), 'module.exports = "hoisted";');
  });

  it('makes bare ESM specifiers resolve from outside the service (own + hoisted deps)', () => {
    const handler = path.join(extractDir, 'handler.mjs');
    write(handler, 'import d from "acme-dep"; import h from "acme-hoisted"; console.log(d, h);');
    const run = () => execFileSync(process.execPath, [handler], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    // The bug: NODE_PATH does nothing for ESM.
    expect(run).toThrow(/ERR_MODULE_NOT_FOUND|Cannot find package/);

    const links = linkArtifactNodeModules(extractDir, service);
    expect(links).toEqual([
      [path.join(extractDir, 'node_modules'), path.join(service, 'node_modules')],
      [path.join(path.dirname(extractDir), 'node_modules'), path.join(repo, 'node_modules')],
    ]);
    expect(run().trim()).toBe('dep+hoisted hoisted');
  });

  it('is idempotent and re-points a link left by a service that moved', () => {
    linkArtifactNodeModules(extractDir, service);
    const stale = path.join(path.dirname(extractDir), 'node_modules');
    fs.unlinkSync(stale);
    fs.symlinkSync(path.join(tmp, 'elsewhere'), stale, 'junction');

    const links = linkArtifactNodeModules(extractDir, service);
    expect(links.map(([, target]) => target)).toEqual([path.join(service, 'node_modules'), path.join(repo, 'node_modules')]);
    expect(fs.readlinkSync(stale)).toBe(path.join(repo, 'node_modules'));
  });

  it('leaves an artifact that ships its own node_modules alone', () => {
    fs.mkdirSync(path.join(extractDir, 'node_modules'));
    expect(linkArtifactNodeModules(extractDir, service)).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(extractDir), 'node_modules'))).toBe(false);
  });

  it('never replaces a real directory in the parent slot', () => {
    fs.mkdirSync(path.join(path.dirname(extractDir), 'node_modules'));
    const links = linkArtifactNodeModules(extractDir, service);
    expect(links).toEqual([[path.join(extractDir, 'node_modules'), path.join(service, 'node_modules')]]);
    expect(fs.lstatSync(path.join(path.dirname(extractDir), 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('links nothing when the service resolves through no node_modules at all', () => {
    const bare = path.join(tmp, 'bare-service');
    fs.mkdirSync(bare);
    // Only meaningful when no ancestor of the temp dir has a node_modules.
    const expected = ancestorNodeModules(bare).length;
    expect(linkArtifactNodeModules(extractDir, bare)).toHaveLength(Math.min(expected, 2));
  });

  it('warns instead of failing when the filesystem refuses the link', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    expect(linkArtifactNodeModules(extractDir, service)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EPERM: operation not permitted'));
  });

  it('stringifies a non-Error failure in the warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw 'refused';
    });
    linkArtifactNodeModules(extractDir, service);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(': refused'));
  });
});

describe('execArgvError', () => {
  it.each([
    [['--enable-source-maps', '--inspect', '--inspect-brk=9230', '--inspect=127.0.0.1:9231']],
    [['--inspect=localhost:9232', '--inspect-port=[::1]:9233', '--inspect-wait']],
    [['--max-old-space-size=4096', '--stack-trace-limit=50', '--unhandled-rejections=strict']],
    [[]],
  ])('accepts %j', (value) => {
    expect(execArgvError('serviceRuntime.orders.execArgv', value)).toBeNull();
  });

  it.each([
    ['--import=tsx'],
    ['--require'],
    ['--loader=./x.mjs'],
    ['--eval=process.exit()'],
    ['--inspect=0.0.0.0:9229'],
    ['--inspect=attacker.example:9229'],
    ['--max-old-space-size=lots'],
    ['--unhandled-rejections=explode'],
    ['--enable-source-maps=1'],
  ])('rejects %s', (flag) => {
    expect(execArgvError('k', ['--enable-source-maps', flag])).toBe(
      `"k[1]": "${flag}" is not an allowed worker flag — through the config API execArgv accepts ` +
        'only debugger (loopback), source-map, memory/stack sizing and diagnostic flags; ' +
        'set anything else by editing lss.config.json',
    );
  });

  it.each([['--inspect'], [['--inspect', 1]], [{ 0: '--inspect' }]])('rejects a non-string-array %j', (value) => {
    expect(execArgvError('k', value)).toBe('"k" must be an array of strings');
  });
});

describe('runtimeMismatchWarning', () => {
  it('is null when every Node runtime matches the worker major (or none is Node)', () => {
    expect(runtimeMismatchWarning('orders', ['nodejs22.x', 'nodejs22.x'], 'v22.16.0')).toBeNull();
    expect(runtimeMismatchWarning('orders', ['python3.12', undefined, 'provided.al2'], 'v22.16.0')).toBeNull();
  });

  it('names each mismatched runtime once, sorted', () => {
    expect(runtimeMismatchWarning('orders', ['nodejs20.x', 'nodejs18.x', 'nodejs20.x', 'nodejs22.x'], 'v22.16.0')).toBe(
      '⚠️  "orders" declares nodejs18.x, nodejs20.x but its Lambda workers run on Node 22 (the orchestrator\'s) — ' +
        'behaviour that differs between the two majors will not show up locally',
    );
  });
});

describe('ignoredSubpaths / isIgnoredSubpath', () => {
  it('keeps only paths strictly inside the root, relative to it', () => {
    const root = path.join(tmp, 'orders');
    fs.mkdirSync(path.join(root, '.lss-state', 'engine'), { recursive: true });
    const ignored = ignoredSubpaths(root, [
      path.join(root, '.lss-state'),
      path.join(root, '.lss-state', 'engine'),
      path.join(root, '.lss-state'),
      root,
      path.join(tmp, 'elsewhere'),
      undefined,
    ]);
    expect(ignored).toEqual(['.lss-state', path.join('.lss-state', 'engine')]);
  });

  it('matches through a symlinked checkout', () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(path.join(real, 'data'), { recursive: true });
    const link = path.join(tmp, 'link');
    fs.symlinkSync(real, link, 'junction');
    expect(ignoredSubpaths(link, [path.join(real, 'data')])).toEqual(['data']);
  });

  it('matches the path itself and anything under it, not a sibling sharing the prefix', () => {
    const ignored = ['.lss-state'];
    expect(isIgnoredSubpath('.lss-state', ignored)).toBe(true);
    expect(isIgnoredSubpath(path.join('.lss-state', 'orchestrator.log'), ignored)).toBe(true);
    expect(isIgnoredSubpath('.lss-state-notes.md', ignored)).toBe(false);
    expect(isIgnoredSubpath(path.join('src', 'handler.ts'), ignored)).toBe(false);
  });
});
