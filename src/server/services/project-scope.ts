// One naming scheme for "state that belongs to this project", used by every
// place that falls back to a shared location under ~/.lss.
//
// A single global namespace let two checkouts (or two examples, or a dev stack
// and a test stack) collide: same-named services overwrote each other's cached
// templates and artifact extractions, and an engine data dir with no stateDir
// meant every project on the machine shared one set of DynamoDB tables.

import crypto from 'crypto';
import path from 'path';

// Stable, filesystem-safe segment for one project root: a readable slug from
// the directory basename plus a short hash of the absolute path, so two
// projects whose directories share a basename still get distinct namespaces.
export function projectCacheSegment(projectRoot: string): string {
  const absoluteRoot = path.resolve(projectRoot);
  const slug = path.basename(absoluteRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha256').update(absoluteRoot).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}
