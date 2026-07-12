// Resolves which packaged artifact zips a service registration points at.
// Split out of LambdaRuntimeManager so the path-resolution rules are unit-testable
// (the manager itself is integration-only: it forks workers and uses import.meta).

import path from 'path';
import fs from 'fs';

// `package.artifact` in serverless-state.json arrives in three shapes:
// absolute, relative to `.serverless/` (what serverless v3 / osls v4 write —
// e.g. "my-service.zip" for a zip at `<root>/.serverless/my-service.zip`), or
// relative to the service root (legacy). For each declared artifact keep the
// first interpretation that exists on disk; when none of the declared artifacts
// resolve, fall back to scanning `.serverless/*.zip`.
export function resolveArtifacts(root: string, declared: Array<string | undefined>): string[] {
  const existing = new Set<string>();
  for (const artifact of declared) {
    if (!artifact) continue;
    const interpretations = path.isAbsolute(artifact)
      ? [artifact]
      : [path.resolve(root, '.serverless', artifact), path.resolve(root, artifact)];
    const found = interpretations.find(p => fs.existsSync(p));
    if (found) existing.add(found);
  }
  if (existing.size > 0) return [...existing];

  const serverlessDir = path.join(root, '.serverless');
  try {
    return fs
      .readdirSync(serverlessDir)
      .filter(file => file.endsWith('.zip'))
      .map(file => path.join(serverlessDir, file));
  } catch {
    // No .serverless dir — the caller falls back to source mode.
    return [];
  }
}
