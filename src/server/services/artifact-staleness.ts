// Decides whether a service's packaged artifacts predate its sources.
//
// Why this exists: `autoPackage` only packages when the CloudFormation template
// is MISSING (see ServiceRegistrar.readTemplate). On a service that has been
// packaged once, `lss register <dir>` re-reads whatever template and zip are on
// disk — possibly many commits old — and answers `✓` in a fraction of a second.
// Registering is the natural gesture after editing code, so the operator reads
// that `✓` as "my code is loaded" when it may mean "yesterday's build is loaded".
// The registration is not wrong (it faithfully registers what was packaged); the
// silence is. This module supplies the evidence for a warning that says so.
//
// Split out of the registrar so the mtime rules are unit-testable on a plain
// temp directory, the same reasoning that produced `artifact-resolver.ts`.

import path from 'path';
import fs from 'fs/promises';

export interface StaleArtifactVerdict {
  // When the package was produced: the newest artifact mtime, in ms epoch.
  packagedAt: number;
  // The first source found to be newer — absolute path and its mtime (ms epoch).
  // "First" is walk order, not "newest": the walk short-circuits, because one
  // newer file already settles the question and the stale case is the one the
  // operator is waiting on.
  newestSource: string;
  newestSourceAt: number;
}

// Directories that are never packaging INPUT, skipped so the walk stays cheap
// on a monorepo (the scale target is 40 services on a weak machine). Everything
// starting with a dot goes too — that covers `.serverless` itself, `.git`, and
// the build caches (`.next`, `.turbo`, `.build`) without enumerating them.
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name);
}

/**
 * The moment `sls package` last wrote this service's artifacts: the newest
 * mtime among the files it produces in `.serverless/` (the zips plus the
 * template and serverless-state JSON, all written by the same run).
 *
 * Newest rather than oldest on purpose — a stray leftover from an older
 * packaging run must not make a current package look ancient.
 *
 * Returns null when there is nothing to compare against (no `.serverless/`, or
 * no recognisable artifact in it), which the caller treats as "cannot tell".
 */
async function packagedAt(serverlessDir: string): Promise<number | null> {
  const entries = await fs.readdir(serverlessDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return null;

  let newest: number | null = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.zip') && !entry.name.endsWith('.json')) continue;
    const stat = await fs.stat(path.join(serverlessDir, entry.name)).catch(() => null);
    if (!stat) continue;
    if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

/**
 * First source file under `root` whose mtime is past `threshold`, or null when
 * every source is older. Breadth-first over an array used as a queue so there is
 * no recursion depth to worry about and no non-null assertion to appease lint.
 *
 * Unreadable directories and files are skipped rather than thrown: a permission
 * hole should cost the warning, never the registration.
 */
async function findNewerSource(
  root: string,
  threshold: number,
): Promise<{ file: string; mtimeMs: number } | null> {
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const entries = await fs.readdir(queue[i], { withFileTypes: true }).catch(() => null);
    if (!entries) continue;

    for (const entry of entries) {
      const full = path.join(queue[i], entry.name);
      if (entry.isDirectory()) {
        // Symlinked directories are not followed: `withFileTypes` reports a
        // symlink as neither file nor directory, so a loop cannot form here.
        if (!isSkippedDir(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.mtimeMs > threshold) return { file: full, mtimeMs: stat.mtimeMs };
    }
  }
  return null;
}

/**
 * Verdict for one service root, or null when the artifact is current — or when
 * there is not enough on disk to tell. Null is deliberately unopinionated: the
 * caller warns only on a positive verdict, so an undecidable case never invents
 * a scary message.
 */
export async function detectStaleArtifact(serviceRoot: string): Promise<StaleArtifactVerdict | null> {
  const producedAt = await packagedAt(path.join(serviceRoot, '.serverless'));
  if (producedAt === null) return null;

  const newer = await findNewerSource(serviceRoot, producedAt);
  if (!newer) return null;

  return { packagedAt: producedAt, newestSource: newer.file, newestSourceAt: newer.mtimeMs };
}

/**
 * The operator-facing sentence. Kept next to the detector so the wording and the
 * evidence never drift apart, and phrased with the concrete remedy: the command
 * this service actually packages with is a datum lss.config.json already holds,
 * and having to know it from outside was the original complaint.
 */
export function formatStaleArtifactWarning(
  verdict: StaleArtifactVerdict,
  serviceRoot: string,
  packageCommand: string,
): string {
  const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const relative = path.relative(serviceRoot, verdict.newestSource) || verdict.newestSource;
  return `the package predates the sources — ${relative} changed at ${when(verdict.newestSourceAt)}, `
    + `after the last package at ${when(verdict.packagedAt)}. `
    + `Run \`${packageCommand}\` or register again with --repackage to load current code.`;
}
