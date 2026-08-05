// Finds every Serverless Framework / osls service under the project root, so
// onboarding (and `lss scan`) can offer them for registration instead of each
// service having to announce itself — the job the retired 0.x plugin used to do
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
  // node_modules exists — `serverless package` can run without an install step.
  installed: boolean;
  // A packaged template already exists — registration needs no packaging step.
  packaged: boolean;
  // Already registered on this orchestrator (matched by root).
  registered: boolean;
  // Best-effort hints mined from the config file; blank when not found.
  region?: string;
  apiPort?: number;
  invokePort?: number;
  // Whether the config declares any function. `false` marks a resources-only
  // stack — for which an apiPort/invokePort means nothing, so onboarding stops
  // offering the fields. `undefined` means "could not tell" (a TS config, a
  // `${file(…)}` reference): the caller must assume it might have functions,
  // because hiding the ports of a service that does have them is the expensive
  // mistake, and the packaged state settles it at registration anyway.
  hasFunctions?: boolean;
  // Anything the operator should fix before or after registering.
  //
  // Each carries a stable `code` AND an English `message`. The code is what a
  // localised surface (dashboard, CLI) translates; the message keeps the
  // payload self-explanatory for anything reading the API directly — a log, a
  // curl, an agent — and is the fallback when a surface has no string for a
  // code it has not seen yet.
  warnings: ScanWarning[];
}

export interface ScanWarning {
  // `not-packaged` and `not-packaged-manual` are the same fact under different
  // configuration: with autoPackage on, registering packages the service; with
  // it off, registering answers 400 until `serverless package` has run. One
  // code promising both is how a warning ends up contradicting what happens
  // next, so the effective setting picks the code.
  code: 'not-installed' | 'not-packaged' | 'not-packaged-manual' | 'ts-config'
    | 'unreadable-config' | 'invalid-json';
  message: string;
  // Values the localised string interpolates (e.g. the config file name).
  params?: Record<string, string>;
}

export interface ScanOptions {
  // Skip these service directories entirely (see ConfigManager.isScanIgnored).
  isIgnored?: (serviceRoot: string) => boolean;
  // The effective `autoPackage` — decides which not-packaged warning is true.
  autoPackage?: boolean;
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

export function scanForServices(
  rootDir: string,
  registeredRoots: Iterable<string>,
  options: ScanOptions = {},
): ScannedService[] {
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
      // An ignored stack is still a leaf: it is a service, just not one this
      // project registers locally, so descending into it would only surface
      // its fixtures.
      if (!options.isIgnored?.(dir)) found.push(inspect(dir, configFile));
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
    const warnings: ScanWarning[] = [];
    const hints = readHints(path.join(dir, configFile), warnings);
    const installed = hasDependencies(dir, path.resolve(rootDir));
    const packaged = fs.existsSync(path.join(dir, '.serverless', 'cloudformation-template-update-stack.json'));
    if (!installed) {
      warnings.push({
        code: 'not-installed',
        message: 'dependencies not installed — packaging needs an install first (node_modules is missing)',
      });
    }
    if (!packaged) {
      warnings.push(options.autoPackage
        ? {
          code: 'not-packaged',
          message: 'not packaged yet — registration will package it (autoPackage)',
        }
        : {
          code: 'not-packaged-manual',
          message: 'not packaged yet — autoPackage is off, so run `serverless package` before registering',
        });
    }
    return {
      name: hints.name ?? path.basename(dir),
      root: dir,
      relPath: path.relative(path.resolve(rootDir), dir) || '.',
      configFile,
      installed,
      packaged,
      registered: registered.has(dir),
      region: hints.region,
      apiPort: hints.apiPort,
      invokePort: hints.invokePort,
      hasFunctions: hints.hasFunctions,
      warnings,
    };
  }
}

// Whether the service can be packaged without an install step. The service's
// own node_modules answers it — but in an npm/yarn/pnpm workspaces monorepo
// (the shape this scanner exists for) dependencies HOIST to the workspace
// root, and a package legitimately has none of its own. Walking up to the
// scanned root keeps those services from being reported as uninstalled
// forever, which would push the operator into running `npm install` inside a
// workspace package — creating a local tree that shadows the hoisted one.
function hasDependencies(dir: string, rootDir: string): boolean {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, 'node_modules'))) return true;
    if (current === rootDir) return false;
    const parent = path.dirname(current);
    /* istanbul ignore next -- unreachable via scanForServices: `dir` always
       comes from walk(), which starts at the resolved rootDir and only
       descends, so the `current === rootDir` check above always ends the loop
       first. Kept so a future caller passing an unrelated directory cannot
       spin at the filesystem root. */
    if (parent === current) return false;
    current = parent;
  }
}

interface Hints {
  name?: string;
  region?: string;
  apiPort?: number;
  invokePort?: number;
  hasFunctions?: boolean;
}

// Line-oriented scrape of the obvious keys. serverless.json parses properly;
// serverless.ts is executable code, so it only contributes the warning — the
// packaged state resolves it for real.
function readHints(configPath: string, warnings: ScanWarning[]): Hints {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    warnings.push({
      code: 'unreadable-config',
      message: `could not read ${path.basename(configPath)}`,
      params: { file: path.basename(configPath) },
    });
    return {};
  }

  if (configPath.endsWith('.ts')) {
    warnings.push({
      code: 'ts-config',
      message: 'TypeScript service config — name/region/ports resolve at packaging time',
    });
    return {};
  }

  if (configPath.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw) as {
        service?: unknown;
        provider?: { region?: unknown };
        custom?: { lss?: { apiPort?: unknown; invokePort?: unknown } };
        functions?: unknown;
      };
      return {
        name: typeof parsed.service === 'string' ? parsed.service : undefined,
        region: typeof parsed.provider?.region === 'string' ? parsed.provider.region : undefined,
        apiPort: asPort(parsed.custom?.lss?.apiPort),
        invokePort: asPort(parsed.custom?.lss?.invokePort),
        // JSON leaves nothing to guess: the key is there with entries, or it is not.
        hasFunctions: Object.keys((parsed.functions ?? {}) as Record<string, unknown>).length > 0,
      };
    } catch {
      warnings.push({ code: 'invalid-json', message: 'serverless.json is not valid JSON' });
      return {};
    }
  }

  const hints: Hints = { hasFunctions: scrapeHasFunctions(raw) };
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

/**
 * Does this serverless.yml declare any function?
 *
 *   no `functions:` key at all      → false (a resources-only stack)
 *   `functions:` + an indented key  → true
 *   `functions: ${file(./fns.yml)}` → undefined — the value is resolved at
 *                                     packaging time, and claiming "no
 *                                     functions" for a service that has 23 is
 *                                     the failure this hint must never cause.
 *
 * Line-oriented like the rest of readHints: this informs a form field, and the
 * packaged state is what registration actually reads.
 */
function scrapeHasFunctions(raw: string): boolean | undefined {
  const lines = raw.split('\n');
  const index = lines.findIndex(line => /^functions:/.test(line));
  if (index === -1) return false;
  const inline = lines[index].slice('functions:'.length).trim();
  // Anything on the same line is a reference or an inline map — neither is a
  // count this scrape can trust. `functions: {}` is the one honest exception.
  if (inline) return inline === '{}' ? false : undefined;
  for (const line of lines.slice(index + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    // Dedented back to column 0: the block ended without an entry.
    if (!/^\s/.test(line)) return false;
    if (/^\s+[^\s#-][^:]*:/.test(line)) return true;
  }
  return false;
}

function asPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined;
}
