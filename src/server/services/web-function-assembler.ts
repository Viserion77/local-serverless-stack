// Folds the three Lambda Web Function resource types — AWS::Lambda::WebFunction,
// ::WebFunctionRevision and ::WebFunctionEndpoint — into one
// RegisteredWebFunction per function: its revisions (code + config), its
// endpoints (URL + auth + revision weights) and every finding worth showing the
// developer. Same spirit as raw-api-assembler.ts: a pure pass over the parsed
// template, run at registration, whose output is cached with the service and
// drives the web-function manager and gateway.
//
// The CloudFormation template is the canonical input: services packaged with
// osls 4.0.0 (which has no `webApps:` key) declare the three resources under
// `resources.Resources`, and osls passes them through untouched. A Serverless
// Framework v4 `webApps` block in serverless-state.json is an additive extra
// that only ever contributes an explicit entry file.

import fs from 'fs';
import path from 'path';
import type {
  Resource,
  WebFunctionResource,
  WebFunctionRevisionResource,
  WebFunctionEndpointResource,
} from './cloudformation-parser.js';
import type { LambdaExecutionMode } from './config-manager.js';

const ACCOUNT_ID = '000000000000';
const PARTITION = 'aws';

// Where a revision's code is loaded from, and WHY — the dashboard shows the
// reason, because "it ran the old code" is otherwise a mystery.
//   state-entry  serverless-state.json `webApps.<name>.entry` (Framework v4)
//   artifact     a packaged zip in `.serverless/`, extracted like event
//                functions' artifacts are
//   source       the service root, entry from AWS_LAMBDA_NODEJS_ENTRYPOINT or
//                index.js — what Lambda itself loads by default
//   missing      nothing usable was found; the first request answers 502
export type WebCodeSource = 'state-entry' | 'artifact' | 'source' | 'missing';

export interface WebCodeLocation {
  source: WebCodeSource;
  reason: string;
  // The directory the entry is relative to (and the process's cwd). For
  // `artifact` this is the service root until the manager extracts the zip.
  root: string;
  // The entry file, relative to `root`.
  entry: string;
  // `artifact` only: the zip to extract.
  artifact?: string;
}

export interface WebRevision {
  logicalId: string;
  revisionId: string;
  arn: string;
  runtime: string;
  description?: string;
  // Final string form (physical values resolved, https rewrite applied) — set
  // by the registrar once resources exist; the assembler seeds it with the
  // values that were already literal.
  environment: Record<string, string>;
  timeoutSeconds: number;
  maxConcurrency: number;
  code: WebCodeLocation;
}

export type WebAuthType = 'ApplicationManaged' | 'IamAuth';

export interface WebRevisionWeight {
  revisionId: string;
  weight: number;
}

export interface WebEndpoint {
  logicalId: string;
  name: string;
  arn: string;
  authType: WebAuthType;
  endpointType: string;
  weights: WebRevisionWeight[];
  // Allocated at registration (web-function-ports.ts).
  port?: number;
}

export interface RegisteredWebFunction {
  service: string;
  // FunctionName as declared.
  name: string;
  logicalId: string;
  arn: string;
  revisions: WebRevision[];
  endpoints: WebEndpoint[];
  warnings: string[];
}

// serverless-state.json `service.webApps` (Framework v4). Only `entry` is read.
export type StateWebApps = Record<string, { entry?: unknown } | undefined>;

export interface WebAssembleInput {
  service: string;
  // The service root — the source-mode code location and where `.serverless/`
  // lives.
  root: string;
  region: string;
  resources: Resource[];
  executionMode: LambdaExecutionMode;
  stateWebApps?: StateWebApps;
  // Service-level findings (dangling references, unmatched webApps) — the
  // per-function ones also go on the function itself, for the dashboard.
  warnings: string[];
  // Filesystem probes, injectable for tests.
  exists?: (file: string) => boolean;
  listZips?: (dir: string) => string[];
}

// The runtimes AWS documents for web functions (Lambda Developer Guide, "Web
// Function runtimes"). Anything else still runs — on the orchestrator's Node —
// but is flagged.
const SUPPORTED_RUNTIMES = new Set(['nodejs24.x']);

// Names AWS refuses in a revision's environment ("Configuring Lambda Web
// Functions" → Environment variables): Lambda owns them. A template carrying
// one would not deploy; locally the value is dropped (LSS sets its own) and the
// developer is told.
export const RESERVED_WEB_ENV = new Set([
  'AWS_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_KEY',
  'AWS_SECURITY_TOKEN', 'AWS_SESSION_TOKEN', 'AWS_DEFAULT_REGION', 'AWS_REGION',
  'AWS_LAMBDA_HTTP_ENDPOINT', 'AWS_LAMBDA_RUNTIME_API', 'AWS_LAMBDA_INITIALIZATION_TYPE',
  'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_LAMBDA_METADATA_API', 'AWS_LAMBDA_METADATA_TOKEN',
]);

const ENTRYPOINT_VAR = 'AWS_LAMBDA_NODEJS_ENTRYPOINT';

function defaultListZips(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(file => file.endsWith('.zip')).map(file => path.join(dir, file));
  } catch {
    return [];
  }
}

// Which web function a FunctionName reference names: a same-template logical
// id, a declared FunctionName, or a web-function ARN whose last segment is one.
function findFunction(ref: string, functions: WebFunctionResource[]): WebFunctionResource | undefined {
  const name = ref.startsWith('arn:') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  return functions.find(fn => fn.logicalId === ref) ?? functions.find(fn => fn.name === name);
}

/** Only the values that are already plain strings/numbers/booleans. */
function literalEnvironment(env: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    }
  }
  return result;
}

// A webApps entry belongs to the function whose name IS the key, or ends with
// `-<key>` (the `<service>-<stage>-<name>` shape the Framework uses for every
// other resource it names).
function stateEntryFor(fn: WebFunctionResource, webApps: StateWebApps | undefined): string | undefined {
  for (const [key, app] of Object.entries(webApps ?? {})) {
    if (fn.name !== key && !fn.name.endsWith(`-${key}`)) continue;
    if (typeof app?.entry === 'string' && app.entry) return app.entry;
  }
  return undefined;
}

/**
 * Code location, first hit wins (each choice recorded with its reason):
 *   1. `webApps.<name>.entry` from serverless-state.json — source, explicit;
 *   2. the S3Object.Key basename among `.serverless/*.zip` — artifact;
 *   3. the service root, entry = AWS_LAMBDA_NODEJS_ENTRYPOINT, else index.js.
 * The execution mode narrows the choice exactly as it does for event functions:
 * `source` never takes 2, `artifact` takes nothing but 2.
 */
function resolveCode(
  revision: WebFunctionRevisionResource,
  stateEntry: string | undefined,
  input: WebAssembleInput,
  exists: (file: string) => boolean,
  listZips: (dir: string) => string[],
): WebCodeLocation {
  const mode = input.executionMode;
  const envEntry = typeof revision.environment[ENTRYPOINT_VAR] === 'string'
    ? (revision.environment[ENTRYPOINT_VAR] as string)
    : undefined;
  const entry = envEntry ?? 'index.js';

  if (stateEntry && mode !== 'artifact') {
    return {
      source: 'state-entry',
      reason: `serverless-state.json webApps entry "${stateEntry}"`,
      root: input.root,
      entry: stateEntry,
    };
  }

  if (mode !== 'source') {
    const keyBase = revision.codeKey ? path.basename(revision.codeKey) : undefined;
    const zip = keyBase ? listZips(path.join(input.root, '.serverless')).find(file => path.basename(file) === keyBase) : undefined;
    if (zip) {
      return {
        source: 'artifact',
        reason: `packaged zip .serverless/${keyBase} (matches S3Object.Key)`,
        root: input.root,
        entry,
        artifact: zip,
      };
    }
    if (mode === 'artifact') {
      return {
        source: 'missing',
        reason: `execution mode is "artifact" but no zip in .serverless/ matches S3Object.Key ${JSON.stringify(revision.codeKey ?? null)}`,
        root: input.root,
        entry,
      };
    }
  }

  if (!exists(path.join(input.root, entry))) {
    return {
      source: 'missing',
      reason: `entry file ${entry} not found under ${input.root}${envEntry ? ` (${ENTRYPOINT_VAR})` : ' (set AWS_LAMBDA_NODEJS_ENTRYPOINT to point elsewhere)'}`,
      root: input.root,
      entry,
    };
  }
  return {
    source: 'source',
    reason: envEntry ? `service source, ${ENTRYPOINT_VAR}=${envEntry}` : 'service source, default index.js',
    root: input.root,
    entry,
  };
}

function normalizeAuthType(raw: string, label: string, warnings: string[]): WebAuthType {
  if (raw === 'IamAuth' || raw === 'ApplicationManaged') return raw;
  warnings.push(`${label}: AuthType "${raw}" is not ApplicationManaged or IamAuth — served as ApplicationManaged.`);
  return 'ApplicationManaged';
}

export function assembleWebFunctions(input: WebAssembleInput): RegisteredWebFunction[] {
  const exists = input.exists ?? fs.existsSync;
  const listZips = input.listZips ?? defaultListZips;
  const functions = input.resources.filter((r): r is WebFunctionResource => r.type === 'web-function');
  const revisions = input.resources.filter((r): r is WebFunctionRevisionResource => r.type === 'web-function-revision');
  const endpoints = input.resources.filter((r): r is WebFunctionEndpointResource => r.type === 'web-function-endpoint');
  const arnPrefix = `arn:${PARTITION}:lambda:${input.region}:${ACCOUNT_ID}:web-function/`;

  const result = functions.map(fn => {
    const warnings: string[] = [];
    const arn = `${arnPrefix}${fn.name}`;
    const stateEntry = stateEntryFor(fn, input.stateWebApps);

    const ownRevisions = revisions.filter(rev => findFunction(rev.functionRef, functions) === fn);
    const webRevisions: WebRevision[] = ownRevisions.map(rev => {
      if (!SUPPORTED_RUNTIMES.has(rev.runtime)) {
        warnings.push(
          `Revision ${rev.logicalId}: runtime "${rev.runtime}" is not a web-function runtime (AWS supports ${[...SUPPORTED_RUNTIMES].join(', ')}) — it runs on the orchestrator's Node locally.`,
        );
      }
      const reserved = Object.keys(rev.environment).filter(key => RESERVED_WEB_ENV.has(key));
      if (reserved.length > 0) {
        warnings.push(
          `Revision ${rev.logicalId}: ${reserved.join(', ')} ${reserved.length === 1 ? 'is a name' : 'are names'} Lambda reserves for web functions — AWS rejects the revision; locally the value is ignored.`,
        );
      }
      const code = resolveCode(rev, stateEntry, input, exists, listZips);
      if (code.source === 'missing') warnings.push(`Revision ${rev.logicalId}: no code to run — ${code.reason}.`);
      const revision: WebRevision = {
        logicalId: rev.logicalId,
        revisionId: rev.revisionId,
        arn: `${arn}/revision/${rev.revisionId}`,
        runtime: rev.runtime,
        environment: literalEnvironment(rev.environment),
        timeoutSeconds: rev.timeoutSeconds,
        maxConcurrency: rev.maxConcurrency,
        code,
      };
      if (rev.description !== undefined) revision.description = rev.description;
      return revision;
    });
    if (webRevisions.length === 0) {
      warnings.push(`Web function "${fn.name}" has no AWS::Lambda::WebFunctionRevision — its endpoints cannot serve.`);
    }

    const webEndpoints: WebEndpoint[] = endpoints
      .filter(ep => findFunction(ep.functionRef, functions) === fn)
      .map(ep => {
        const label = `Endpoint ${ep.name}`;
        const weights: WebRevisionWeight[] = [];
        for (const entry of ep.revisionWeights) {
          // A logical id of a revision, or a literal revision id.
          const target = revisions.find(rev => rev.logicalId === entry.revisionRef)
            ?? revisions.find(rev => rev.revisionId === entry.revisionRef);
          if (!target) {
            warnings.push(`${label}: RevisionWeights names "${entry.revisionRef}", which is not a revision in this template — ignored.`);
            continue;
          }
          if (!ownRevisions.includes(target)) {
            warnings.push(`${label}: revision ${target.logicalId} belongs to another web function — ignored.`);
            continue;
          }
          weights.push({ revisionId: target.revisionId, weight: entry.weight });
        }
        if (weights.length > 2) {
          warnings.push(`${label}: AWS routes to at most 2 revisions; ${weights.length} are weighted — all are honoured locally.`);
        }
        const total = weights.reduce((sum, w) => sum + w.weight, 0);
        if (weights.length > 0 && total !== 100) {
          warnings.push(`${label}: revision weights sum to ${total}, not 100 — split proportionally locally.`);
        }
        if (ep.endpointType !== 'HomeRegion') {
          warnings.push(`${label}: EndpointType ${ep.endpointType} is served once, locally, like HomeRegion.`);
        }
        return {
          logicalId: ep.logicalId,
          name: ep.name,
          arn: `${arn}/endpoint/${ep.name}`,
          authType: normalizeAuthType(ep.authType, label, warnings),
          endpointType: ep.endpointType,
          weights,
        };
      });
    if (webEndpoints.length === 0) {
      warnings.push(`Web function "${fn.name}" has no AWS::Lambda::WebFunctionEndpoint — nothing serves it.`);
    }

    input.warnings.push(...warnings.map(w => `[web function ${fn.name}] ${w}`));
    return {
      service: input.service,
      name: fn.name,
      logicalId: fn.logicalId,
      arn,
      revisions: webRevisions,
      endpoints: webEndpoints,
      warnings,
    };
  });

  // References no function in this template owns: CloudFormation would fail
  // the stack; locally they are dropped, loudly.
  for (const rev of revisions) {
    if (!findFunction(rev.functionRef, functions)) {
      input.warnings.push(`AWS::Lambda::WebFunctionRevision "${rev.logicalId}": FunctionName "${rev.functionRef}" is not a web function in this template — ignored.`);
    }
  }
  for (const ep of endpoints) {
    if (!findFunction(ep.functionRef, functions)) {
      input.warnings.push(`AWS::Lambda::WebFunctionEndpoint "${ep.logicalId}": FunctionName "${ep.functionRef}" is not a web function in this template — ignored.`);
    }
  }
  for (const key of Object.keys(input.stateWebApps ?? {})) {
    if (!functions.some(fn => fn.name === key || fn.name.endsWith(`-${key}`))) {
      input.warnings.push(
        `serverless-state.json declares webApps.${key}, but the packaged template has no AWS::Lambda::WebFunction for it — not served.`,
      );
    }
  }
  return result;
}

/**
 * The revision a request goes to. A pin (the `x-lss-web-revision` header, by
 * revision id or logical id) wins; otherwise a weighted pick over the
 * endpoint's RevisionWeights; with no usable weights, the LAST declared
 * revision — the newest one, which is what an endpoint without explicit
 * weights serves on AWS (automatic deployment).
 *
 * `random` is injectable so the split is testable. Returns undefined for a pin
 * that names no revision of this function, or a function with none.
 */
export function pickRevision(
  fn: RegisteredWebFunction,
  endpoint: WebEndpoint,
  pin: string | undefined,
  random: () => number = Math.random,
): WebRevision | undefined {
  if (pin) return fn.revisions.find(rev => rev.revisionId === pin || rev.logicalId === pin);
  const weighted = endpoint.weights
    .map(w => ({ revision: fn.revisions.find(rev => rev.revisionId === w.revisionId), weight: w.weight }))
    .filter((w): w is { revision: WebRevision; weight: number } => Boolean(w.revision) && w.weight > 0);
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  if (total > 0) {
    let roll = random() * total;
    for (const w of weighted) {
      roll -= w.weight;
      if (roll < 0) return w.revision;
    }
    return weighted[weighted.length - 1].revision;
  }
  return fn.revisions[fn.revisions.length - 1];
}
