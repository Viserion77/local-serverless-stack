// Finds every Serverless Framework / osls service under the project root, so
// onboarding (and `lss scan`) can offer them for registration instead of each
// service having to announce itself — the job the retired v1 plugin used to do
// from inside `sls package`.
//
// This is a PREVIEW: values here inform a checklist, nothing more. The
// authoritative name/region/ports come from the packaged serverless-state.json
// at registration time (service-registrar reads them), so the light-weight
// line-oriented YAML scraping below is allowed to miss — a missed hint costs a
// default, never a wrong registration.

import fs from 'fs';
import path from 'path';

export interface ScannedService {
  // `service:` from the config file, falling back to the directory basename.
  name: string;
  // Absolute service root (the directory holding the serverless config).
  root: string;
  // Root relative to the scanned directory — what a UI shows.
  relPath: string;
  // The config file that identified it (serverless.yml/.yaml/.json/.ts).
  configFile: string;
  // A packaged template already exists — registration needs no packaging step.
  packaged: boolean;
  // Already registered on this orchestrator (matched by root).
  registered: boolean;
  // Best-effort hints mined from the config file; blank when not found.
  region?: string;
  apiPort?: number;
  invokePort?: number;
  // Anything the operator should fix before or after registering.
  warnings: string[];
}

const CONFIG_FILES = ['serverless.yml', 'serverless.yaml', 'serverless.json', 'serverless.ts'];

// Never descend into these: dependency trees, VCS metadata, build output and
// LSS's own state. node_modules matters twice — cost (the shipped example holds
// 1700+ directories per service) and correctness (dependencies ship their own
// serverless.yml fixtures).
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.serverless', '.lss', '.build', '.esbuild',
  'dist', 'build', 'coverage', '.webpack', '.vscode', '.devcontainer', '.idea',
]);

// Beyond this depth a hit is more likely a fixture than a service; the scan
// stays fast on monorepos either way.
const MAX_DEPTH = 6;

export function scanForServices(rootDir: string, registeredRoots: Iterable<string>): ScannedService[] {
  const registered = new Set([...registeredRoots].map(root => path.resolve(root)));
  const found: ScannedService[] = [];
  walk(path.resolve(rootDir), 0);
  // Stable, human-friendly order for the checklist.
  return found.sort((a, b) => a.relPath.localeCompare(b.relPath));

  function walk(dir: string, depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — not ours to report
    }

    const configFile = CONFIG_FILES.find(name => entries.some(e => e.isFile() && e.name === name));
    if (configFile) {
      found.push(inspect(dir, configFile));
      // A service root is a leaf: nested serverless configs under one service
      // are fixtures/templates, not independently registrable services.
      return;
    }

    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  function inspect(dir: string, configFile: string): ScannedService {
    const warnings: string[] = [];
    const hints = readHints(path.join(dir, configFile), warnings);
    const packaged = fs.existsSync(path.join(dir, '.serverless', 'cloudformation-template-update-stack.json'));
    if (!packaged) {
      warnings.push('not packaged yet — registration will package it (autoPackage) or run `serverless package` first');
    }
    return {
      name: hints.name ?? path.basename(dir),
      root: dir,
      relPath: path.relative(path.resolve(rootDir), dir) || '.',
      configFile,
      packaged,
      registered: registered.has(dir),
      region: hints.region,
      apiPort: hints.apiPort,
      invokePort: hints.invokePort,
      warnings,
    };
  }
}

interface Hints {
  name?: string;
  region?: string;
  apiPort?: number;
  invokePort?: number;
}

// Line-oriented scrape of the obvious keys. serverless.json parses properly;
// serverless.ts is executable code, so it only contributes the warning — the
// packaged state resolves it for real.
function readHints(configPath: string, warnings: string[]): Hints {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    warnings.push(`could not read ${path.basename(configPath)}`);
    return {};
  }

  if (configPath.endsWith('.ts')) {
    warnings.push('TypeScript service config — name/region/ports resolve at packaging time');
    return {};
  }

  if (configPath.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw) as {
        service?: unknown;
        provider?: { region?: unknown };
        custom?: { lss?: { apiPort?: unknown; invokePort?: unknown } };
      };
      return {
        name: typeof parsed.service === 'string' ? parsed.service : undefined,
        region: typeof parsed.provider?.region === 'string' ? parsed.provider.region : undefined,
        apiPort: asPort(parsed.custom?.lss?.apiPort),
        invokePort: asPort(parsed.custom?.lss?.invokePort),
      };
    } catch {
      warnings.push('serverless.json is not valid JSON');
      return {};
    }
  }

  const hints: Hints = {};
  for (const line of raw.split('\n')) {
    let match = /^service:\s*['"]?([\w-]+)['"]?\s*$/.exec(line);
    if (match && !hints.name) hints.name = match[1];
    // Indented `region:` — provider.region in every serverless.yml layout. A
    // ${var} placeholder is skipped: better no hint than a template string.
    match = /^\s+region:\s*['"]?([a-z]{2}-[a-z]+-\d)['"]?\s*$/.exec(line);
    if (match && !hints.region) hints.region = match[1];
    match = /^\s+apiPort:\s*(\d+)\s*$/.exec(line);
    if (match && hints.apiPort === undefined) hints.apiPort = asPort(Number(match[1]));
    match = /^\s+invokePort:\s*(\d+)\s*$/.exec(line);
    if (match && hints.invokePort === undefined) hints.invokePort = asPort(Number(match[1]));
  }
  return hints;
}

function asPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined;
}
