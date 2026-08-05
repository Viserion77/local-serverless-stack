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
    expect(bad.warnings.map(w => w.code)).toContain('invalid-json');
    expect(anon.name).toBe('anon');
  });

  it('flags a TypeScript config as packaging-time-resolved', () => {
    write('ts-svc/serverless.ts', 'export default { service: "ts" };\n');
    const [svc] = scanForServices(root, []);
    expect(svc.name).toBe('ts-svc');
    expect(svc.warnings.map(w => w.code)).toContain('ts-config');
  });

  it('warns when the config file cannot be read', () => {
    write('svc/serverless.yml', 'service: s\n');
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((() => {
      throw new Error('EACCES');
    }) as never);
    const [svc] = scanForServices(root, []);
    spy.mockRestore();
    // The file name travels as a param so a localised surface can interpolate it.
    expect(svc.warnings).toContainEqual(expect.objectContaining({
      code: 'unreadable-config',
      params: { file: 'serverless.yml' },
    }));
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
    expect(byName.fresh.warnings.map(w => w.code)).toContain('not-installed');
    // autoPackage was not passed, so the honest code is the manual one.
    expect(byName.fresh.warnings.map(w => w.code)).toContain('not-packaged-manual');
  });

  it('an installed but unpackaged service warns only about packaging', () => {
    write('svc/serverless.yml', 'service: svc\n');
    write('svc/node_modules/.package-lock.json', '{}');
    const [svc] = scanForServices(root, [], { autoPackage: true });
    expect(svc.installed).toBe(true);
    expect(svc.warnings.map(w => w.code)).toEqual(['not-packaged']);
    // The English message travels alongside the code, for anything reading
    // the API without a translation layer.
    expect(svc.warnings[0].message).toContain('not packaged yet');
  });

  it('counts hoisted dependencies: a workspace package with no local node_modules is installed', () => {
    // The monorepo shape this scanner exists for — deps hoist to the root, so
    // a per-package check would report every service as uninstalled forever.
    write('node_modules/.package-lock.json', '{}');
    write('services/orders/serverless.yml', 'service: orders\n');
    const [svc] = scanForServices(root, []);
    expect(svc.installed).toBe(true);
    expect(svc.warnings.map(w => w.code)).not.toContain('not-installed');
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

  it('the walk stops at the scanned root rather than climbing to /', () => {
    write('svc/serverless.yml', 'service: svc\n');
    const [svc] = scanForServices(root, []);
    expect(svc.installed).toBe(false);
  });
});

// The scan is what onboarding renders and what `lss scan` prints; two of the
// three facts below decide what the operator is *offered*, so getting them
// wrong is worse than not having them.
describe('scanIgnore', () => {
  it('drops a service whose directory the caller ignores, and does not descend into it', () => {
    write('infra/bootstrap/serverless.yml', 'service: bootstrap\n');
    write('infra/bootstrap/fixtures/svc/serverless.yml', 'service: fixture\n');
    write('services/orders/serverless.yml', 'service: orders\n');

    const found = scanForServices(root, [], {
      isIgnored: dir => dir.endsWith(`${path.sep}bootstrap`),
    });
    expect(found.map(s => s.name)).toEqual(['orders']);
  });

  it('keeps everything when no predicate is given', () => {
    write('infra/bootstrap/serverless.yml', 'service: bootstrap\n');
    expect(scanForServices(root, []).map(s => s.name)).toEqual(['bootstrap']);
  });
});

describe('autoPackage-aware packaging warning', () => {
  it('promises packaging only when autoPackage is on', () => {
    write('svc/serverless.yml', 'service: svc\n');
    const [on] = scanForServices(root, [], { autoPackage: true });
    expect(on.warnings.map(w => w.code)).toContain('not-packaged');
    expect(on.warnings.find(w => w.code === 'not-packaged')?.message).toContain('autoPackage');

    const [off] = scanForServices(root, [], { autoPackage: false });
    const warning = off.warnings.find(w => w.code === 'not-packaged-manual');
    expect(warning?.message).toContain('serverless package');
  });
});

// `hasFunctions` decides whether onboarding offers a port at all, so its
// failure direction matters more than its precision: unknown must never read
// as "no functions".
describe('hasFunctions hint', () => {
  const scan = (yml: string) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-scan-fn-'));
    write('svc/serverless.yml', yml);
    return scanForServices(root, [])[0].hasFunctions;
  };

  it('false for a resources-only stack', () => {
    expect(scan('service: infra\nresources:\n  Resources:\n    T: {}\n')).toBe(false);
  });

  it('true when the functions block has an entry', () => {
    expect(scan('service: api\nfunctions:\n  # a comment first\n  hello:\n    handler: h.go\n')).toBe(true);
  });

  it('false when the functions block is empty or dedents immediately', () => {
    expect(scan('service: api\nfunctions:\n\nprovider:\n  name: aws\n')).toBe(false);
    expect(scan('service: api\nfunctions: {}\n')).toBe(false);
    expect(scan('service: api\nfunctions:\n')).toBe(false);
  });

  it('undefined — never false — when the block is a reference it cannot resolve', () => {
    expect(scan('service: api\nfunctions: ${file(./functions.yml)}\n')).toBeUndefined();
  });

  it('undefined for a TypeScript config, false/true for JSON', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-scan-fn-ts-'));
    write('svc/serverless.ts', 'export default { service: "api" };');
    expect(scanForServices(root, [])[0].hasFunctions).toBeUndefined();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-scan-fn-json-'));
    write('a/serverless.json', JSON.stringify({ service: 'a', functions: { hello: {} } }));
    write('b/serverless.json', JSON.stringify({ service: 'b' }));
    expect(scanForServices(root, []).map(s => s.hasFunctions)).toEqual([true, false]);
  });

  it('undefined when the config file cannot be read at all', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-scan-fn-unreadable-'));
    write('svc/serverless.yml', 'service: api\nfunctions:\n  hello:\n    handler: h.go\n');
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('EACCES'); });
    expect(scanForServices(root, [])[0].hasFunctions).toBeUndefined();
  });
});
