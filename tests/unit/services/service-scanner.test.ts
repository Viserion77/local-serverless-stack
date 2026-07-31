// The scanner behind onboarding and `lss scan`. Its contract is honesty about
// being a PREVIEW: best-effort hints, never wrong registrations — the packaged
// state is the authority at register time. What must hold here: discovery
// (find real services, skip dependency trees), leaf semantics (a service root
// is not descended into), and the registered/packaged flags a checklist needs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanForServices } from '../../../src/server/services/service-scanner';

let root: string;

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-scan-'));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('discovery', () => {
  it('finds services by any serverless config flavor, sorted by path', () => {
    write('svc-yml/serverless.yml', 'service: orders\n');
    write('svc-yaml/serverless.yaml', 'service: billing\n');
    write('svc-json/serverless.json', JSON.stringify({ service: 'catalog' }));
    write('deep/one/two/svc/serverless.yml', 'service: nested\n');

    const found = scanForServices(root, []);
    expect(found.map(s => [s.relPath, s.name, s.configFile])).toEqual([
      ['deep/one/two/svc', 'nested', 'serverless.yml'],
      ['svc-json', 'catalog', 'serverless.json'],
      ['svc-yaml', 'billing', 'serverless.yaml'],
      ['svc-yml', 'orders', 'serverless.yml'],
    ]);
  });

  it('never descends into node_modules, dot-dirs or build output', () => {
    write('svc/serverless.yml', 'service: real\n');
    write('svc-b/node_modules/dep/serverless.yml', 'service: fixture\n');
    write('.git/serverless.yml', 'service: vcs\n');
    write('svc-c/dist/serverless.yml', 'service: built\n');
    write('svc-d/.serverless/serverless.yml', 'service: packaged-artifact\n');

    expect(scanForServices(root, []).map(s => s.name)).toEqual(['real']);
  });

  it('treats a service root as a leaf — nested configs are fixtures, not services', () => {
    write('svc/serverless.yml', 'service: parent\n');
    write('svc/fixtures/child/serverless.yml', 'service: child\n');
    expect(scanForServices(root, []).map(s => s.name)).toEqual(['parent']);
  });

  it('stops at the depth limit', () => {
    write('a/b/c/d/e/f/g/serverless.yml', 'service: too-deep\n');
    expect(scanForServices(root, [])).toEqual([]);
  });

  it('the scanned root itself can be the service (relPath ".")', () => {
    write('serverless.yml', 'service: mono\n');
    const [svc] = scanForServices(root, []);
    expect(svc.relPath).toBe('.');
    expect(svc.name).toBe('mono');
  });

  it('survives an unreadable directory', () => {
    write('svc/serverless.yml', 'service: ok\n');
    fs.mkdirSync(path.join(root, 'locked'));
    // Bind the real implementation BEFORE spying — jest.requireActual('fs')
    // hands back the same (spied) module object, which would recurse.
    const original = fs.readdirSync.bind(fs);
    jest.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, opts: never) => {
      if (String(dir).endsWith('locked')) throw new Error('EACCES');
      return original(dir, opts as never);
    }) as never);
    expect(scanForServices(root, []).map(s => s.name)).toEqual(['ok']);
  });
});

describe('hints', () => {
  it('mines service name, region and custom.lss ports out of a yml', () => {
    write('svc/serverless.yml', [
      'service: orders-service',
      'provider:',
      '  name: aws',
      '  region: us-west-2',
      'custom:',
      '  lss:',
      '    apiPort: 3631',
      '    invokePort: 13631',
    ].join('\n'));
    const [svc] = scanForServices(root, []);
    expect(svc).toMatchObject({
      name: 'orders-service',
      region: 'us-west-2',
      apiPort: 3631,
      invokePort: 13631,
    });
  });

  it('skips ${var} region templates — no hint beats a wrong hint', () => {
    write('svc/serverless.yml', 'service: s\nprovider:\n  region: ${opt:region}\n');
    expect(scanForServices(root, [])[0].region).toBeUndefined();
  });

  it('falls back to the directory basename when service: is absent', () => {
    write('anon-svc/serverless.yml', 'provider:\n  name: aws\n');
    expect(scanForServices(root, [])[0].name).toBe('anon-svc');
  });

  it('parses serverless.json properly and flags invalid JSON', () => {
    write('good/serverless.json', JSON.stringify({
      service: 'catalog', provider: { region: 'sa-east-1' }, custom: { lss: { apiPort: 3634 } },
    }));
    write('bad/serverless.json', '{ nope');
    // A JSON config without a string `service` falls back to the basename.
    write('anon/serverless.json', JSON.stringify({ provider: { region: 'us-east-1' } }));
    const [anon, bad, good] = scanForServices(root, []);
    expect(good).toMatchObject({ name: 'catalog', region: 'sa-east-1', apiPort: 3634 });
    expect(bad.warnings.some(w => w.includes('not valid JSON'))).toBe(true);
    expect(anon.name).toBe('anon');
  });

  it('flags a TypeScript config as packaging-time-resolved', () => {
    write('ts-svc/serverless.ts', 'export default { service: "ts" };\n');
    const [svc] = scanForServices(root, []);
    expect(svc.name).toBe('ts-svc');
    expect(svc.warnings.some(w => w.includes('TypeScript service config'))).toBe(true);
  });

  it('warns when the config file cannot be read', () => {
    write('svc/serverless.yml', 'service: s\n');
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((() => {
      throw new Error('EACCES');
    }) as never);
    const [svc] = scanForServices(root, []);
    spy.mockRestore();
    expect(svc.warnings.some(w => w.includes('could not read'))).toBe(true);
  });
});

describe('checklist flags', () => {
  it('reports installed, packaged and registered, and warns about missing steps', () => {
    write('done/serverless.yml', 'service: done\n');
    write('done/node_modules/.package-lock.json', '{}');
    write('done/.serverless/cloudformation-template-update-stack.json', '{}');
    write('fresh/serverless.yml', 'service: fresh\n');

    const found = scanForServices(root, [path.join(root, 'done')]);
    const byName = Object.fromEntries(found.map(s => [s.name, s]));
    expect(byName.done).toMatchObject({ installed: true, packaged: true, registered: true, warnings: [] });
    expect(byName.fresh.installed).toBe(false);
    expect(byName.fresh.packaged).toBe(false);
    expect(byName.fresh.registered).toBe(false);
    expect(byName.fresh.warnings.some(w => w.includes('dependencies not installed'))).toBe(true);
    expect(byName.fresh.warnings.some(w => w.includes('not packaged yet'))).toBe(true);
  });

  it('an installed but unpackaged service warns only about packaging', () => {
    write('svc/serverless.yml', 'service: svc\n');
    write('svc/node_modules/.package-lock.json', '{}');
    const [svc] = scanForServices(root, []);
    expect(svc.installed).toBe(true);
    expect(svc.warnings).toEqual([
      expect.stringContaining('not packaged yet'),
    ]);
  });

  it('counts hoisted dependencies: a workspace package with no local node_modules is installed', () => {
    // The monorepo shape this scanner exists for — deps hoist to the root, so
    // a per-package check would report every service as uninstalled forever.
    write('node_modules/.package-lock.json', '{}');
    write('services/orders/serverless.yml', 'service: orders\n');
    const [svc] = scanForServices(root, []);
    expect(svc.installed).toBe(true);
    expect(svc.warnings.some(w => w.includes('dependencies not installed'))).toBe(false);
  });

  it('stops the ancestor walk at the scanned root', () => {
    // node_modules ABOVE the scanned root must not count: it is another
    // project's tree, not this one's.
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const scanned = path.join(root, 'inner');
    fs.mkdirSync(path.join(scanned, 'svc'), { recursive: true });
    fs.writeFileSync(path.join(scanned, 'svc', 'serverless.yml'), 'service: svc\n');
    const [svc] = scanForServices(scanned, []);
    expect(svc.installed).toBe(false);
  });

  it('a service outside the scanned root stops the walk at the filesystem root', () => {
    // Defensive arm: rootDir is never an ancestor, so the walk must terminate
    // on its own rather than loop at '/'.
    write('svc/serverless.yml', 'service: svc\n');
    const [svc] = scanForServices(root, []);
    // '/' has no node_modules in the sandbox, so the walk ends false.
    expect(svc.installed).toBe(false);
  });
});
