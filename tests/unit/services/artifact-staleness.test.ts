// Unit tests for the packaged-artifact staleness detector. Real temp directories
// with explicitly stamped mtimes (no fs mocks except where a failure cannot be
// produced on disk), so the readdir/stat semantics the registrar depends on are
// exercised for real.
//
// The behaviour being pinned: `lss register` on an already-packaged service
// re-registers whatever is on disk, so it must be able to say when that is older
// than the code. A false "you are stale" is worse than silence, hence the many
// null cases below.
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  detectStaleArtifact,
  formatStaleArtifactWarning,
} from '../../../src/server/services/artifact-staleness';

let root: string;

// Fixed points well apart so no filesystem timestamp granularity can blur them.
const PACKAGED = new Date('2026-08-01T12:00:00Z');
const BEFORE = new Date('2026-07-20T09:00:00Z');
const AFTER = new Date('2026-08-05T18:30:00Z');

function write(rel: string, mtime: Date): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  fs.utimesSync(file, mtime, mtime);
  return file;
}

// A service that was packaged at PACKAGED: template + state + zip, as `sls
// package` writes them in one run.
function packagedService(): void {
  write(path.join('.serverless', 'cloudformation-template-update-stack.json'), PACKAGED);
  write(path.join('.serverless', 'serverless-state.json'), PACKAGED);
  write(path.join('.serverless', 'svc.zip'), PACKAGED);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-artifact-staleness-'));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectStaleArtifact', () => {
  it('reports the source that outran the package', async () => {
    packagedService();
    write(path.join('src', 'handler.ts'), AFTER);

    const verdict = await detectStaleArtifact(root);

    expect(verdict).not.toBeNull();
    expect(verdict?.newestSource).toBe(path.join(root, 'src', 'handler.ts'));
    expect(verdict?.packagedAt).toBe(PACKAGED.getTime());
    expect(verdict?.newestSourceAt).toBe(AFTER.getTime());
  });

  it('stays silent when every source predates the package', async () => {
    packagedService();
    write(path.join('src', 'handler.ts'), BEFORE);
    write('serverless.yml', BEFORE);

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('stays silent when there is no .serverless directory to compare against', async () => {
    write(path.join('src', 'handler.ts'), AFTER);

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('stays silent when .serverless holds nothing recognisable as an artifact', async () => {
    write(path.join('.serverless', 'notes.txt'), PACKAGED);
    fs.mkdirSync(path.join(root, '.serverless', 'nested'), { recursive: true });
    write(path.join('src', 'handler.ts'), AFTER);

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('takes the NEWEST artifact as the packaging moment, so a leftover cannot fake staleness', async () => {
    // An ancient zip left over from an older run sits next to a current package.
    write(path.join('.serverless', 'stale-leftover.zip'), BEFORE);
    write(path.join('.serverless', 'cloudformation-template-update-stack.json'), AFTER);
    write(path.join('src', 'handler.ts'), PACKAGED);

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('ignores build output and dependency directories, which are never packaging input', async () => {
    packagedService();
    write(path.join('node_modules', 'dep', 'index.js'), AFTER);
    write(path.join('dist', 'bundle.js'), AFTER);
    write(path.join('build', 'out.js'), AFTER);
    write(path.join('coverage', 'lcov.info'), AFTER);
    write(path.join('.git', 'HEAD'), AFTER);
    write(path.join('.turbo', 'cache'), AFTER);

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('walks nested source directories', async () => {
    packagedService();
    write(path.join('src', 'domain', 'orders', 'repository.ts'), AFTER);

    const verdict = await detectStaleArtifact(root);

    expect(verdict?.newestSource).toBe(path.join(root, 'src', 'domain', 'orders', 'repository.ts'));
  });

  it('skips symlinks rather than following them into a possible loop', async () => {
    packagedService();
    write(path.join('src', 'handler.ts'), BEFORE);
    // A symlink is neither file nor directory to `withFileTypes`, so it is
    // skipped outright — pointing it at the root would otherwise cycle.
    fs.symlinkSync(root, path.join(root, 'src', 'self-link'));

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('skips a directory it cannot read instead of failing the registration', async () => {
    packagedService();
    const secret = path.join(root, 'restricted');
    fs.mkdirSync(secret);
    write(path.join('restricted', 'handler.ts'), AFTER);

    const realReaddir = fsPromises.readdir.bind(fsPromises);
    jest.spyOn(fsPromises, 'readdir').mockImplementation((async (dir: string, opts: unknown) => {
      if (dir === secret) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realReaddir(dir as never, opts as never);
    }) as never);

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('skips a source file that vanishes between listing and stat', async () => {
    packagedService();
    const doomed = write(path.join('src', 'handler.ts'), AFTER);

    const realStat = fsPromises.stat.bind(fsPromises);
    jest.spyOn(fsPromises, 'stat').mockImplementation((async (file: string) => {
      if (file === doomed) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return realStat(file as never);
    }) as never);

    expect(await detectStaleArtifact(root)).toBeNull();
  });

  it('skips an artifact that vanishes between listing and stat', async () => {
    const zip = write(path.join('.serverless', 'svc.zip'), PACKAGED);
    write(path.join('src', 'handler.ts'), AFTER);

    const realStat = fsPromises.stat.bind(fsPromises);
    jest.spyOn(fsPromises, 'stat').mockImplementation((async (file: string) => {
      if (file === zip) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return realStat(file as never);
    }) as never);

    // The only artifact was unreadable, so there is nothing to compare against.
    expect(await detectStaleArtifact(root)).toBeNull();
  });
});

describe('formatStaleArtifactWarning', () => {
  const verdict = {
    packagedAt: PACKAGED.getTime(),
    newestSource: '/svc/src/handler.ts',
    newestSourceAt: AFTER.getTime(),
  };

  it('names the file relative to the service, both timestamps and the remedy', () => {
    const message = formatStaleArtifactWarning(verdict, '/svc', 'npm run package:local');

    expect(message).toContain('the package predates the sources');
    expect(message).toContain(path.join('src', 'handler.ts'));
    expect(message).toContain('2026-08-05 18:30:00');
    expect(message).toContain('2026-08-01 12:00:00');
    expect(message).toContain('Run `npm run package:local`');
    expect(message).toContain('--repackage');
  });

  it('falls back to the absolute path when the source IS the service root', () => {
    const atRoot = { ...verdict, newestSource: '/svc' };

    expect(formatStaleArtifactWarning(atRoot, '/svc', 'sls package')).toContain('/svc changed at');
  });
});
