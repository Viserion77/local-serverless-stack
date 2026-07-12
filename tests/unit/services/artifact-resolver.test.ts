// Unit tests for resolveArtifacts — the path-resolution rules behind the Lambda
// runtime's "artifact" execution mode. Uses real temp directories (no fs mocks)
// so path.resolve/existsSync semantics are exercised for real.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveArtifacts } from '../../../src/server/services/artifact-resolver';

let root: string;

function touch(...segments: string[]): string {
  const file = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'zip-bytes');
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-artifact-resolver-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveArtifacts', () => {
  it('keeps an absolute artifact path that exists', () => {
    const zip = touch('.serverless', 'svc.zip');
    expect(resolveArtifacts(root, [zip])).toEqual([zip]);
  });

  it('resolves a bare filename against .serverless/ (serverless v3 / osls v4 shape)', () => {
    const zip = touch('.serverless', 's7-identity.zip');
    expect(resolveArtifacts(root, ['s7-identity.zip'])).toEqual([zip]);
  });

  it('resolves a root-relative path (legacy shape)', () => {
    const zip = touch('build', 'svc.zip');
    expect(resolveArtifacts(root, [path.join('build', 'svc.zip')])).toEqual([zip]);
  });

  it('resolves ".serverless/x.zip" via the root interpretation without doubling the prefix', () => {
    const zip = touch('.serverless', 'svc.zip');
    expect(resolveArtifacts(root, [path.join('.serverless', 'svc.zip')])).toEqual([zip]);
  });

  it('prefers the .serverless/ interpretation when both interpretations exist', () => {
    const inServerless = touch('.serverless', 'svc.zip');
    touch('svc.zip');
    expect(resolveArtifacts(root, ['svc.zip'])).toEqual([inServerless]);
  });

  it('dedupes when several functions declare the same artifact', () => {
    const zip = touch('.serverless', 'svc.zip');
    expect(resolveArtifacts(root, ['svc.zip', 'svc.zip'])).toEqual([zip]);
  });

  it('skips undefined artifacts and still resolves the declared ones', () => {
    const zip = touch('.serverless', 'svc.zip');
    expect(resolveArtifacts(root, [undefined, 'svc.zip'])).toEqual([zip]);
  });

  it('falls back to scanning .serverless/*.zip when no declared artifact exists on disk', () => {
    const zip = touch('.serverless', 'other.zip');
    touch('.serverless', 'notes.txt');
    expect(resolveArtifacts(root, ['missing.zip'])).toEqual([zip]);
  });

  it('falls back to scanning when nothing is declared at all', () => {
    const zip = touch('.serverless', 'only.zip');
    expect(resolveArtifacts(root, [])).toEqual([zip]);
  });

  it('ignores an absolute artifact that does not exist and scans instead', () => {
    const zip = touch('.serverless', 'real.zip');
    expect(resolveArtifacts(root, [path.join(root, 'gone.zip')])).toEqual([zip]);
  });

  it('returns [] when there is no .serverless directory to scan', () => {
    expect(resolveArtifacts(root, ['missing.zip'])).toEqual([]);
  });
});
