import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectCacheSegment } from './project-scope.js';
import type { SecretSeedValue } from './secret-value.js';

// Symlink-stable spelling of a directory (e.g. macOS /tmp -> /private/tmp),
// so the project identity matches the plugin's symlink-resolved process.cwd().
function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}


export interface SelfEngineConfig {
  // Front door port. Default 14566 — deliberately outside 4566–4599, which a
  // real LocalStack install intercepts on some hosts (Docker Desktop/WSL2).
  port?: number;
  // Engine persistence root. Defaults to <stateDir>/engine when stateDir is
  // set, else a per-project directory under ~/.lss/projects/.
  dataDir?: string;
  account?: string;
  // Dehydrate hydrated data stores idle past this window.
  idleUnloadMs?: number;
  // Hard LRU budget for hydrated data across all stores.
  memoryBudgetMb?: number;
  // fsync on every WAL flush (paranoid mode). Default: fsync only at
  // compaction/dehydrate/shutdown.
  fsync?: boolean;
  // Reverse-proxy target for AWS operations the engine does not implement.
  // An escape hatch for a niche gap — see docs/SELF_ENGINE.md "Coverage".
  fallbackEndpoint?: string | null;
}

// SelfEngineConfig with every default applied.
export interface ResolvedSelfEngineConfig {
  port: number;
  dataDir: string;
  account: string;
  idleUnloadMs: number;
  memoryBudgetMb: number;
  fsync: boolean;
  fallbackEndpoint: string | null;
  persistence: boolean;
  region: string;
}

// Per-service packaging overrides. Keyed in `servicePackaging` by the service
// directory name (basename) OR its path relative to the config file's directory.
export interface ServicePackageConfig {
  packageCommand?: string;
  packageArgs?: string[];
  packageEnv?: Record<string, string>;
  packageTimeoutMs?: number;
}

// The effective packaging settings resolved for a single service: global config
// merged with any matching per-service override.
export interface ResolvedPackageConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

// How the Lambda runtime resolves handler code:
//   "artifact": extract the `sls package` zip and load the compiled handler.
//   "source":   require the handler straight from the service source tree
//               (TS supported via an on-demand loader).
//   "auto" (default): artifact when the zip exists, source otherwise.
export type LambdaExecutionMode = 'auto' | 'artifact' | 'source';

export interface LambdaRuntimeConfig {
  // Master switch for the runtime + gateway/invoke listeners (default: true).
  enabled?: boolean;
  execution?: LambdaExecutionMode;
  // Watch service sources and hot-reload workers (default: true in source mode,
  // false in artifact mode — repackaging on every save is expensive).
  watch?: boolean;
  // apiPort (30xx) → invokePort (130xx) derivation when a service doesn't
  // declare an explicit invoke port. Default: 10000.
  invokePortOffset?: number;
  // Hostname used to build the invoke URL a service's event proxies call back
  // on (default "127.0.0.1" — everything runs in this process). Override only
  // when the orchestrator must be reachable under another name.
  invokeHost?: string;
  // Fork a service's worker on its first invocation instead of at registration
  // (default: true). Each worker is a Node process costing ~48 MB resident, so
  // a 40-service monorepo paid ~1.9 GB before a single handler ran. Deferring
  // the fork costs one cold start (~200 ms) per service actually exercised.
  // Set false to restore the eager behaviour.
  lazy?: boolean;
  // Stop a worker that has served nothing for this long, returning it to the
  // lazy state (default: 60000 — one minute). LSS is a development stack, not a
  // production workload: a handler only needs to be resident while it is being
  // used, and a cold start costs ~20 ms. Set 0 to keep workers alive forever.
  idleTimeoutMs?: number;
  // Hard ceiling on how many workers may be resident at once. When a fork
  // pushes past it, the least-recently-invoked idle worker is unloaded. This is
  // the guarantee that a burst across every service in a large monorepo cannot
  // exhaust the host's memory: the ceiling is on services in flight, not on
  // services registered. Default: one per GB of system RAM, clamped to 2..12.
  maxWarmWorkers?: number;
}

// Per-service runtime overrides, keyed like `servicePackaging` (directory
// basename or config-relative path).
export interface ServiceRuntimeConfig {
  enabled?: boolean;
  apiPort?: number;
  invokePort?: number;
  execution?: LambdaExecutionMode;
  watch?: boolean;
}

// The effective runtime settings resolved for a single service.
export interface ResolvedRuntimeConfig {
  enabled: boolean;
  execution: LambdaExecutionMode;
  watch?: boolean;
  apiPort?: number;
  invokePort?: number;
}

// Dashboard branding: title/logo/colors so the UI can carry the look of the
// team using it. Purely cosmetic — never affects orchestration behavior.
export interface BrandingConfig {
  // Navbar title and browser tab title. Default: "Local Serverless Stack".
  title?: string;
  // Small line under the title. Default: "Local development control plane".
  subtitle?: string;
  // Logo shown in the navbar. Accepts an http(s)/data URL (used as-is) or a
  // file path resolved relative to the config file's directory, which the
  // orchestrator serves at /api/config/branding/logo.
  logo?: string;
  // Favicon; same URL-or-path rules as `logo`.
  favicon?: string;
  // Theme applied when the user hasn't picked one in the UI yet.
  defaultTheme?: 'dark' | 'light';
  // TreeUI token overrides applied to BOTH themes. Keys are either the token
  // suffix ("brand-primary" → --tree-color-brand-primary) or a full custom
  // property name ("--tree-radius-md").
  colors?: Record<string, string>;
  // Per-theme overrides, merged over `colors` for that theme.
  themeColors?: {
    dark?: Record<string, string>;
    light?: Record<string, string>;
  };
}

// BrandingConfig with defaults applied and file-path assets rewritten to the
// orchestrator endpoints that serve them.
export interface ResolvedBranding {
  title: string;
  subtitle: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  defaultTheme: 'dark' | 'light';
  colors: Record<string, string>;
  themeColors: {
    dark: Record<string, string>;
    light: Record<string, string>;
  };
}

// One port for the whole stack: the REST API, the dashboard and the AWS wire
// all answer here by default. Deliberately outside 4566–4599, which a real
// LocalStack install intercepts on some hosts (Docker Desktop/WSL2).
//
// Setting `serverPort` and `selfEngine.port` to DIFFERENT values splits them
// back onto two listeners — see isSingleListener().
const DEFAULT_PORT = 14566;

export type BrandingAssetKind = 'logo' | 'favicon';

export interface LSSConfig {
  // Server port (dashboard + API)
  serverPort?: number;

  // DynamoDB Proxy
  enableDynamoProxy?: boolean;
  dynamoProxyPort?: number;

  // AWS Configuration
  region?: string;

  // Persistence
  persistence?: boolean;

  // Debug mode
  debug?: boolean;

  // Directory containing DynamoDB seed files ({tableName}.json).
  // Seeds are auto-applied when a table is created; can also be run on demand.
  seedsDir?: string;

  // Secrets to seed on boot (name → value/descriptor). Applied idempotently so
  // an AWSCURRENT version exists before the first GetSecretValue; an existing
  // active secret is never clobbered. A value is a bare string/object (the
  // SecretString itself) or a descriptor with secretString/generateSecretString
  // plus optional description/kmsKeyId/tags. Merged with seeds/secrets/*.json
  // (this map wins on a name collision).
  secrets?: Record<string, SecretSeedValue>;

  // Directory where this instance keeps its state (PID/lock/log). When set, the
  // CLI isolates an instance there so `lss stop --config <path>` targets it and
  // not the dev instance. Resolved relative to the working directory.
  stateDir?: string;

  // When the CloudFormation template is missing during /register, run a packaging
  // command (default: `npx serverless package`) and retry the read.
  autoPackage?: boolean;

  // Command to run when autoPackage is enabled and the template is missing.
  // Parsed as shell-style args; runs in the servicePath as CWD.
  packageCommand?: string;

  // Extra args appended to every auto-package command (passed as discrete argv
  // elements, so no shell parsing). E.g. ["--param=custom-stage=offline"].
  packageArgs?: string[];

  // Extra env vars merged over the orchestrator's env for every package child.
  packageEnv?: Record<string, string>;

  // Per-service packaging overrides, keyed by the service directory name
  // (basename) OR its path relative to this config file's directory (use `/`).
  // A relative-path key wins over a basename key. Per-service `packageCommand`/
  // `packageTimeoutMs` replace the global value; `packageArgs` are appended
  // after the global args; `packageEnv` is merged over the global (service wins).
  servicePackaging?: Record<string, ServicePackageConfig>;

  // Maximum time (ms) to wait for the package command to complete. Defaults to 300000 (5min).
  packageTimeoutMs?: number;

  // Lambda runtime + gateway proxy (API emulation) settings.
  lambdaRuntime?: LambdaRuntimeConfig;

  // Per-service runtime overrides (ports, execution mode, watch).
  serviceRuntime?: Record<string, ServiceRuntimeConfig>;

  // Accepted only so a v1 file fails loudly instead of silently: the only
  // value LSS v2 tolerates is "self". See assertNoLocalStackEngine.
  engine?: string;

  // Self-engine settings.
  selfEngine?: SelfEngineConfig;

  // Dashboard branding (title, logo, theme colors). Cosmetic only.
  branding?: BrandingConfig;
}

// ---------------------------------------------------------------------------
// Dashboard editing support (PUT /api/config, POST /api/config/reload)
// ---------------------------------------------------------------------------

// Value shape accepted for each editable top-level key. On update, `object`
// blocks are merged one level deep (subkeys replace; a null subkey deletes the
// subkey) so a partial edit never drops sibling settings like `branding.logo`;
// every other kind replaces the key wholesale. A top-level null deletes the key.
interface ConfigKeySpec {
  kind: 'port' | 'positiveInt' | 'nonNegativeInt' | 'boolean' | 'string' | 'stringArray' | 'stringRecord' | 'object';
  enum?: readonly string[];
  // Fixed-shape object blocks: every subkey is validated against its own spec
  // and unknown subkeys are rejected — a garbage nested value would otherwise
  // be written to disk and crash consumers like getSelfEngineConfig().
  subKeys?: Record<string, ConfigKeySpec>;
  // Map-shaped object blocks keyed by service name (servicePackaging,
  // serviceRuntime): each entry must be an object whose subkeys match these.
  entrySubKeys?: Record<string, ConfigKeySpec>;
}

// `secrets` is deliberately absent (and rejected on write): it holds seed
// material that belongs in the config file or the environment, never in a
// payload that crosses the dashboard API.
const BLOCKED_CONFIG_KEYS: ReadonlySet<string> = new Set(['secrets']);

const EDITABLE_CONFIG_KEYS: Record<string, ConfigKeySpec> = {
  serverPort: { kind: 'port' },
  enableDynamoProxy: { kind: 'boolean' },
  dynamoProxyPort: { kind: 'port' },
  region: { kind: 'string' },
  persistence: { kind: 'boolean' },
  debug: { kind: 'boolean' },
  seedsDir: { kind: 'string' },
  stateDir: { kind: 'string' },
  autoPackage: { kind: 'boolean' },
  packageCommand: { kind: 'string' },
  packageArgs: { kind: 'stringArray' },
  packageEnv: { kind: 'stringRecord' },
  servicePackaging: {
    kind: 'object',
    entrySubKeys: {
      packageCommand: { kind: 'string' },
      packageArgs: { kind: 'stringArray' },
      packageEnv: { kind: 'stringRecord' },
      packageTimeoutMs: { kind: 'positiveInt' },
    },
  },
  packageTimeoutMs: { kind: 'positiveInt' },
  lambdaRuntime: {
    kind: 'object',
    subKeys: {
      enabled: { kind: 'boolean' },
      execution: { kind: 'string', enum: ['auto', 'artifact', 'source'] },
      watch: { kind: 'boolean' },
      invokePortOffset: { kind: 'positiveInt' },
      invokeHost: { kind: 'string' },
      lazy: { kind: 'boolean' },
      idleTimeoutMs: { kind: 'nonNegativeInt' },
      maxWarmWorkers: { kind: 'nonNegativeInt' },
    },
  },
  serviceRuntime: {
    kind: 'object',
    entrySubKeys: {
      enabled: { kind: 'boolean' },
      apiPort: { kind: 'port' },
      invokePort: { kind: 'port' },
      execution: { kind: 'string', enum: ['auto', 'artifact', 'source'] },
      watch: { kind: 'boolean' },
    },
  },
  selfEngine: {
    kind: 'object',
    subKeys: {
      port: { kind: 'port' },
      dataDir: { kind: 'string' },
      account: { kind: 'string' },
      idleUnloadMs: { kind: 'positiveInt' },
      memoryBudgetMb: { kind: 'positiveInt' },
      fsync: { kind: 'boolean' },
      fallbackEndpoint: { kind: 'string' },
    },
  },
  branding: {
    kind: 'object',
    subKeys: {
      title: { kind: 'string' },
      subtitle: { kind: 'string' },
      logo: { kind: 'string' },
      favicon: { kind: 'string' },
      defaultTheme: { kind: 'string', enum: ['dark', 'light'] },
      colors: { kind: 'stringRecord' },
      themeColors: {
        kind: 'object',
        subKeys: {
          dark: { kind: 'stringRecord' },
          light: { kind: 'stringRecord' },
        },
      },
    },
  },
};

// Env vars that mask each file key while set (loadFromEnv applies them AFTER
// the file, and some getters fall back to env at call time). Surfaced so the
// UI can flag fields whose saved value will not take effect until the env var
// is unset.
const CONFIG_ENV_OVERRIDES: Record<string, string[]> = {
  serverPort: ['LSS_DASHBOARD_PORT', 'PORT'],
  // Note: the deprecated unprefixed ENABLE_DYNAMO_PROXY is NOT listed — it is
  // only a getter-time fallback (isEnableDynamoProxy) that a file value always
  // beats, so it never masks a saved value.
  enableDynamoProxy: ['LSS_ENABLE_DYNAMO_PROXY'],
  dynamoProxyPort: ['LSS_DYNAMO_PROXY_PORT'],
  region: ['AWS_REGION'],
  services: ['LSS_SERVICES'],
  persistence: ['LSS_PERSISTENCE'],
  debug: ['LSS_DEBUG'],
  seedsDir: ['LSS_SEEDS_DIR'],
  autoPackage: ['LSS_AUTO_PACKAGE'],
  packageCommand: ['LSS_PACKAGE_COMMAND'],
  packageTimeoutMs: ['LSS_PACKAGE_TIMEOUT_MS'],
  lambdaRuntime: ['LSS_LAMBDA_RUNTIME', 'LSS_LAMBDA_EXECUTION', 'LSS_LAMBDA_WATCH', 'LSS_INVOKE_HOST'],
  engine: ['LSS_ENGINE'],
  selfEngine: ['LSS_ENGINE_PORT', 'LSS_ENGINE_DATA_DIR'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateValue(key: string, value: unknown, spec: ConfigKeySpec): string | null {
  switch (spec.kind) {
    case 'port':
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
        ? null
        : `"${key}" must be an integer port between 1 and 65535`;
    case 'positiveInt':
      return Number.isInteger(value) && (value as number) > 0
        ? null
        : `"${key}" must be a positive integer`;
    // 0 is meaningful for these (idleTimeoutMs: 0 = never unload).
    case 'nonNegativeInt':
      return Number.isInteger(value) && (value as number) >= 0
        ? null
        : `"${key}" must be an integer >= 0`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `"${key}" must be a boolean`;
    case 'string':
      if (typeof value !== 'string' || value.length === 0) {
        return `"${key}" must be a non-empty string`;
      }
      return spec.enum && !spec.enum.includes(value)
        ? `"${key}" must be one of: ${spec.enum.join(', ')}`
        : null;
    case 'stringArray':
      return Array.isArray(value) && value.every(v => typeof v === 'string')
        ? null
        : `"${key}" must be an array of strings`;
    case 'stringRecord':
      return isPlainObject(value) && Object.values(value).every(v => typeof v === 'string')
        ? null
        : `"${key}" must be an object of string values`;
    case 'object': {
      if (!isPlainObject(value)) {
        return `"${key}" must be an object`;
      }
      // null subvalues are always allowed — they delete the subkey on merge.
      if (spec.subKeys) {
        for (const [subKey, subValue] of Object.entries(value)) {
          // hasOwnProperty, not a plain read: `constructor`/`toString` would
          // otherwise resolve to an Object.prototype member, pass this guard
          // and reach the file as unvalidated JSON.
          const subSpec = Object.prototype.hasOwnProperty.call(spec.subKeys, subKey)
            ? spec.subKeys[subKey]
            : undefined;
          if (!subSpec) return `unknown config key "${key}.${subKey}"`;
          if (subValue === null) continue;
          const error = validateValue(`${key}.${subKey}`, subValue, subSpec);
          if (error) return error;
        }
      }
      if (spec.entrySubKeys) {
        for (const [entryKey, entryValue] of Object.entries(value)) {
          if (entryValue === null) continue;
          if (!isPlainObject(entryValue)) return `"${key}.${entryKey}" must be an object`;
          for (const [subKey, subValue] of Object.entries(entryValue)) {
            const subSpec = Object.prototype.hasOwnProperty.call(spec.entrySubKeys, subKey)
              ? spec.entrySubKeys[subKey]
              : undefined;
            if (!subSpec) return `unknown config key "${key}.${entryKey}.${subKey}"`;
            if (subValue === null) continue;
            const error = validateValue(`${key}.${entryKey}.${subKey}`, subValue, subSpec);
            if (error) return error;
          }
        }
      }
      return null;
    }
  }
}

// Thrown by updateConfig so the route can answer 400 with every problem at
// once instead of failing on the first.
export class ConfigValidationError extends Error {
  readonly details: string[];

  constructor(details: string[]) {
    super(details.join('; '));
    this.name = 'ConfigValidationError';
    this.details = details;
  }
}

export interface ConfigReloadResult {
  // Path of the config file now loaded ('' when none was found).
  path: string;
  // Boot-materialized keys whose resolved value changed — the running process
  // keeps the old value until a full `lss stop && lss start`.
  restartRequired: string[];
}

export interface ConfigUpdateResult extends ConfigReloadResult {
  // Patch keys currently masked by an env var: the file was written, but the
  // env value keeps winning until it is unset.
  envOverridden: string[];
}

// v1 shipped two engines. v2 ships one, so `engine: "localstack"` (from a file
// or from LSS_ENGINE) cannot be honoured and must not be ignored either.
export function assertNoLocalStackEngine(value: string | undefined, source: string): void {
  if (!value) return;
  const kind = value.toLowerCase();
  if (kind === 'localstack') {
    throw new Error(
      `${source} is set to "localstack", which LSS v2 no longer supports — the self engine is the only engine. `
      + 'Remove the setting (and any localstack* keys) from your configuration. '
      + 'See docs/MIGRATION-v2.md.',
    );
  }
}

export class ConfigManager {
  private static instance: ConfigManager;
  private config: LSSConfig = {};
  private configPath: string = '';

  private constructor() {
    this.loadConfig();
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private loadConfig(): void {
    // Search for config file in this order:
    // 1. lss.config.json in current working directory
    // 2. .lssrc in current working directory
    // 3. lss.config.json in home directory
    // 4. .lssrc in home directory

    // LSS_CONFIG_PATH (set by the CLI from `--config <path>`) takes precedence
    // over the cwd/home search so the server reads the same file the CLI used.
    const candidates = [
      ...(process.env.LSS_CONFIG_PATH ? [process.env.LSS_CONFIG_PATH] : []),
      path.join(process.cwd(), 'lss.config.json'),
      path.join(process.cwd(), '.lssrc'),
      path.join(process.env.HOME || '~', 'lss.config.json'),
      path.join(process.env.HOME || '~', '.lssrc'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const content = fs.readFileSync(candidate, 'utf-8');
          this.config = JSON.parse(content);
          this.configPath = candidate;
          console.log(`✅ Configuration loaded from ${candidate}`);
        } catch (error) {
          console.warn(`⚠️  Failed to parse config file ${candidate}:`, error instanceof Error ? error.message : 'Unknown error');
          continue;
        }
        // Outside the try: a v1 `engine` value is a migration error the user
        // must see, not a parse warning to swallow.
        assertNoLocalStackEngine(this.config.engine, `"engine" in ${candidate}`);
        break;
      }
    }

    // Environment variables override file values, so an instance can be
    // retargeted (ports, engine data dir, region) without touching the file.
    this.loadFromEnv();
  }

  private loadFromEnv(): void {
    // Load configuration from environment variables
    if (process.env.LSS_DASHBOARD_PORT || process.env.PORT) {
      /* istanbul ignore next: the enclosing if guarantees one of these is truthy, so the `|| ''` fallback is unreachable */
      this.config.serverPort = parseInt(process.env.LSS_DASHBOARD_PORT || process.env.PORT || '', 10);
    }
    if (process.env.LSS_ENABLE_DYNAMO_PROXY) {
      this.config.enableDynamoProxy = process.env.LSS_ENABLE_DYNAMO_PROXY === 'true' || process.env.LSS_ENABLE_DYNAMO_PROXY === '1';
    }
    if (process.env.LSS_DYNAMO_PROXY_PORT) {
      this.config.dynamoProxyPort = parseInt(process.env.LSS_DYNAMO_PROXY_PORT, 10);
    }
    if (process.env.AWS_REGION) {
      this.config.region = process.env.AWS_REGION;
    }
    if (process.env.LSS_PERSISTENCE) {
      this.config.persistence = process.env.LSS_PERSISTENCE === 'true' || process.env.LSS_PERSISTENCE === '1';
    }
    if (process.env.LSS_DEBUG) {
      this.config.debug = process.env.LSS_DEBUG === 'true' || process.env.LSS_DEBUG === '1';
    }
    if (process.env.LSS_SEEDS_DIR) {
      this.config.seedsDir = process.env.LSS_SEEDS_DIR;
    }
    if (process.env.LSS_AUTO_PACKAGE) {
      this.config.autoPackage = process.env.LSS_AUTO_PACKAGE === 'true' || process.env.LSS_AUTO_PACKAGE === '1';
    }
    if (process.env.LSS_PACKAGE_COMMAND) {
      this.config.packageCommand = process.env.LSS_PACKAGE_COMMAND;
    }
    if (process.env.LSS_PACKAGE_TIMEOUT_MS) {
      const parsed = parseInt(process.env.LSS_PACKAGE_TIMEOUT_MS, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.config.packageTimeoutMs = parsed;
      }
    }
    if (process.env.LSS_LAMBDA_RUNTIME) {
      this.config.lambdaRuntime = {
        ...this.config.lambdaRuntime,
        enabled: process.env.LSS_LAMBDA_RUNTIME === 'true' || process.env.LSS_LAMBDA_RUNTIME === '1',
      };
    }
    if (process.env.LSS_LAMBDA_EXECUTION) {
      const mode = process.env.LSS_LAMBDA_EXECUTION.toLowerCase();
      if (mode === 'auto' || mode === 'artifact' || mode === 'source') {
        this.config.lambdaRuntime = { ...this.config.lambdaRuntime, execution: mode };
      }
    }
    if (process.env.LSS_LAMBDA_WATCH) {
      this.config.lambdaRuntime = {
        ...this.config.lambdaRuntime,
        watch: process.env.LSS_LAMBDA_WATCH === 'true' || process.env.LSS_LAMBDA_WATCH === '1',
      };
    }
    if (process.env.LSS_INVOKE_HOST) {
      this.config.lambdaRuntime = {
        ...this.config.lambdaRuntime,
        invokeHost: process.env.LSS_INVOKE_HOST,
      };
    }
    // v1 chose a backend with LSS_ENGINE / `engine`. v2 has one engine, so a
    // leftover "localstack" is a loud, actionable error rather than a silent
    // no-op that would quietly run against the wrong thing.
    assertNoLocalStackEngine(process.env.LSS_ENGINE, 'LSS_ENGINE');
    if (process.env.LSS_ENGINE_PORT) {
      this.config.selfEngine = {
        ...this.config.selfEngine,
        port: parseInt(process.env.LSS_ENGINE_PORT, 10),
      };
    }
    // Give every instance its own engine state without editing a config file:
    // `LSS_ENGINE_DATA_DIR=... LSS_ENGINE_PORT=... lss start` is enough to run a
    // second stack (a test run, a second checkout) beside the dev one.
    if (process.env.LSS_ENGINE_DATA_DIR) {
      this.config.selfEngine = {
        ...this.config.selfEngine,
        dataDir: process.env.LSS_ENGINE_DATA_DIR,
      };
    }
  }

  getConfig(): LSSConfig {
    return this.config;
  }

  getServerPort(): number {
    return this.config.serverPort ?? (parseInt(process.env.PORT || '', 10) || DEFAULT_PORT);
  }

  // Alias for backward compatibility
  getDashboardPort(): number {
    return this.getServerPort();
  }

  isEnableDynamoProxy(): boolean {
    if (this.config.enableDynamoProxy !== undefined) {
      return this.config.enableDynamoProxy;
    }
    // Also check environment variable for backward compatibility
    return String(process.env.ENABLE_DYNAMO_PROXY || '').toLowerCase() === 'true' || process.env.ENABLE_DYNAMO_PROXY === '1';
  }

  getDynamoProxyPort(): number {
    return this.config.dynamoProxyPort ?? 8000;
  }

  getRegion(): string {
    return this.config.region ?? (process.env.AWS_REGION || 'us-east-1');
  }

  isPersistence(): boolean {
    if (this.config.persistence !== undefined) {
      return this.config.persistence;
    }
    return true; // Default to enabled
  }

  isDebug(): boolean {
    if (this.config.debug !== undefined) {
      return this.config.debug;
    }
    return false;
  }

  getSeedsDir(): string {
    const raw = this.config.seedsDir ?? './seeds';
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  // Directory holding boot secret seeds (seeds/secrets/<name>.json).
  getSecretsSeedDir(): string {
    return path.join(this.getSeedsDir(), 'secrets');
  }

  // The config-declared secrets map (name → value/descriptor), empty by default.
  getSecretSeeds(): Record<string, SecretSeedValue> {
    return this.config.secrets ?? {};
  }

  getStateDir(): string | undefined {
    const raw = this.config.stateDir;
    if (!raw) return undefined;
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  isAutoPackage(): boolean {
    return this.config.autoPackage ?? false;
  }

  getPackageCommand(): string {
    return this.config.packageCommand ?? 'npx serverless package';
  }

  getPackageTimeoutMs(): number {
    return this.config.packageTimeoutMs ?? 300000;
  }

  /**
   * Resolve the effective packaging settings for one service. Merges the global
   * package config with any per-service override matched by relative path (from
   * the config file's dir) or by directory basename. Delegates to
   * getPackageCommand()/getPackageTimeoutMs() so env-var overrides still apply
   * as the global baseline.
   */
  getPackageConfigForService(servicePath: string): ResolvedPackageConfig {
    const perService = this.lookupServiceEntry(this.config.servicePackaging, servicePath);
    return {
      command: perService.packageCommand ?? this.getPackageCommand(),
      args: [...(this.config.packageArgs ?? []), ...(perService.packageArgs ?? [])],
      env: { ...(this.config.packageEnv ?? {}), ...(perService.packageEnv ?? {}) },
      timeoutMs: perService.packageTimeoutMs ?? this.getPackageTimeoutMs(),
    };
  }

  /**
   * The keys a `servicePackaging`/`serviceRuntime` entry may be written under,
   * most specific first: the path relative to the config file's directory, the
   * path relative to the project root, then the directory basename.
   *
   * The two relative forms are usually the same string — but not always, and
   * the difference used to silently drop overrides: `getProjectRoot()`
   * realpath-resolves (and falls back to the cwd for a home-directory config),
   * while a raw `dirname(configPath)` does not. A checkout reached through a
   * symlink, or a config loaded from `~`, made the key the dashboard writes
   * (project-root relative, from the scan) unreachable by the lookup. Both
   * spellings resolve here so a written override always applies.
   */
  private serviceEntryKeys(servicePath: string): string[] {
    const target = realpathOrSelf(path.resolve(servicePath));
    const bases = [
      this.configPath ? realpathOrSelf(path.resolve(path.dirname(this.configPath))) : null,
      this.getProjectRoot(),
    ];
    const keys = bases
      .filter((base): base is string => base !== null)
      .map(base => path.relative(base, target).split(path.sep).join('/'))
      .filter(Boolean);
    keys.push(path.basename(target));
    return [...new Set(keys)];
  }

  private lookupServiceEntry<T extends object>(
    map: Record<string, T> | undefined,
    servicePath: string,
  ): T | Record<string, never> {
    const entries = map ?? {};
    for (const key of this.serviceEntryKeys(servicePath)) {
      if (Object.prototype.hasOwnProperty.call(entries, key)) return entries[key];
    }
    return {};
  }

  isLambdaRuntimeEnabled(): boolean {
    return this.config.lambdaRuntime?.enabled ?? true;
  }

  getLambdaExecutionMode(): LambdaExecutionMode {
    return this.config.lambdaRuntime?.execution ?? 'auto';
  }

  getInvokePortOffset(): number {
    return this.config.lambdaRuntime?.invokePortOffset ?? 10000;
  }

  // Defer forking a service's worker to its first invocation. On by default:
  // one Node process per registered service is ~48 MB, which a 40-service
  // monorepo pays entirely up front for handlers it may never call.
  isLambdaRuntimeLazy(): boolean {
    return this.config.lambdaRuntime?.lazy ?? true;
  }

  // A worker only stays resident while it is being used. 0 disables unloading.
  getLambdaIdleTimeoutMs(): number {
    const raw = this.config.lambdaRuntime?.idleTimeoutMs;
    if (raw === undefined) return 60_000;
    return typeof raw === 'number' && raw > 0 ? raw : 0;
  }

  // Ceiling on resident workers. Default: one per GB of system RAM, clamped to
  // 2..12 — the point is that the host's memory is bounded by how many services
  // are in flight, never by how many are registered. 0 disables the ceiling.
  getLambdaMaxWarmWorkers(): number {
    const raw = this.config.lambdaRuntime?.maxWarmWorkers;
    if (typeof raw === 'number' && raw >= 0) return Math.floor(raw);
    const gib = Math.floor(os.totalmem() / (1024 ** 3));
    return Math.max(2, Math.min(12, gib));
  }

  getInvokeHost(): string {
    if (this.config.lambdaRuntime?.invokeHost) {
      return this.config.lambdaRuntime.invokeHost;
    }
    // Nothing runs inside a container, so callbacks into the invoke listeners
    // resolve on the loopback directly.
    return '127.0.0.1';
  }

  /**
   * Resolve the effective runtime settings for one service, merging the global
   * lambdaRuntime block with any serviceRuntime override matched by relative
   * path (from the config file's dir) or by directory basename. `watch` stays
   * undefined when unset so the runtime can pick its mode-dependent default
   * (true for source, false for artifact).
   */
  getRuntimeConfigForService(servicePath: string): ResolvedRuntimeConfig {
    const perService = this.lookupServiceEntry(this.config.serviceRuntime, servicePath);
    return {
      enabled: perService.enabled ?? this.isLambdaRuntimeEnabled(),
      execution: perService.execution ?? this.getLambdaExecutionMode(),
      watch: perService.watch ?? this.config.lambdaRuntime?.watch,
      apiPort: perService.apiPort,
      invokePort: perService.invokePort,
    };
  }

  getSelfEngineConfig(): ResolvedSelfEngineConfig {
    const selfEngine = this.config.selfEngine ?? {};
    const stateDir = this.getStateDir();
    const rawDataDir = selfEngine.dataDir
      ?? (stateDir ? path.join(stateDir, 'engine') : this.homeStateDir('engine'));
    return {
      port: selfEngine.port ?? DEFAULT_PORT,
      dataDir: path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(process.cwd(), rawDataDir),
      account: selfEngine.account ?? '000000000000',
      idleUnloadMs: selfEngine.idleUnloadMs ?? 300000,
      memoryBudgetMb: selfEngine.memoryBudgetMb ?? 128,
      fsync: selfEngine.fsync ?? false,
      fallbackEndpoint: selfEngine.fallbackEndpoint ?? null,
      persistence: this.isPersistence(),
      region: this.getRegion(),
    };
  }

  // Fallback state root when the config declares no stateDir. Scoped to this
  // project: a flat ~/.lss/<kind> meant every project on the machine shared one
  // set of DynamoDB tables, queues and OpenSearch indices, so opening a second
  // repo silently showed the first one's data.
  private homeStateDir(kind: string): string {
    return path.join(os.homedir(), '.lss', 'projects', projectCacheSegment(this.getProjectRoot()), kind);
  }

  // The AWS endpoint every SDK-based consumer (provisioner, explorers, seeds)
  // targets. Reads the port directly rather than through getSelfEngineConfig(),
  // which would also resolve the data dir — needless work for a URL, and it
  // drags the project-root lookup into every caller that only wants an endpoint.
  getEngineEndpoint(): string {
    return `http://localhost:${this.config.selfEngine?.port ?? DEFAULT_PORT}`;
  }

  /**
   * True when the orchestrator and the engine share one listener — the default,
   * since both ports default to the same value. Give them different values to
   * go back to two listeners.
   */
  isSingleListener(): boolean {
    return this.getServerPort() === (this.config.selfEngine?.port ?? DEFAULT_PORT);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Absolute root of the project this orchestrator serves. Anchored on the
   * loaded config file's directory (LSS_CONFIG_PATH / cwd search). Falls back
   * to process.cwd() when no config was loaded, or when the config came from
   * the home directory — that one is a user-global file shared across projects
   * and must not collapse every project into a single identity.
   */
  getProjectRoot(): string {
    if (this.configPath) {
      const dir = path.resolve(path.dirname(this.configPath));
      // Same home the loadConfig() candidates were built from.
      const home = path.resolve(process.env.HOME || os.homedir());
      if (dir !== home) {
        return realpathOrSelf(dir);
      }
    }
    return realpathOrSelf(path.resolve(process.cwd()));
  }

  /**
   * Resolve a branding asset (`logo`/`favicon`) to a local file, or null when
   * the value is unset, is a URL the browser can load directly, or the file
   * doesn't exist. Relative paths resolve from the config file's directory so
   * assets can live next to lss.config.json.
   */
  getBrandingAssetFile(kind: BrandingAssetKind): string | null {
    const raw = this.config.branding?.[kind];
    if (!raw || /^(https?:|data:)/i.test(raw)) {
      return null;
    }
    const baseDir = this.configPath ? path.dirname(this.configPath) : process.cwd();
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
    return fs.existsSync(resolved) ? resolved : null;
  }

  // URL the UI should load for a branding asset: pass URLs through, rewrite
  // existing local files to the orchestrator endpoint that serves them.
  private getBrandingAssetUrl(kind: BrandingAssetKind): string | null {
    const raw = this.config.branding?.[kind];
    if (!raw) {
      return null;
    }
    if (/^(https?:|data:)/i.test(raw)) {
      return raw;
    }
    return this.getBrandingAssetFile(kind) ? `/api/config/branding/${kind}` : null;
  }

  getBranding(): ResolvedBranding {
    const branding = this.config.branding ?? {};
    return {
      title: branding.title ?? 'Local Serverless Stack',
      subtitle: branding.subtitle ?? 'Local development control plane',
      logoUrl: this.getBrandingAssetUrl('logo'),
      faviconUrl: this.getBrandingAssetUrl('favicon'),
      defaultTheme: branding.defaultTheme === 'light' ? 'light' : 'dark',
      colors: branding.colors ?? {},
      themeColors: {
        dark: branding.themeColors?.dark ?? {},
        light: branding.themeColors?.light ?? {},
      },
    };
  }

  // Config keys currently masked by an environment variable (env wins over the
  // file). The UI flags these fields so a save that "doesn't stick" is
  // explained instead of silent.
  getEnvOverriddenKeys(): string[] {
    // Truthy check on purpose: loadFromEnv only applies truthy env values, so
    // a variable exported as an empty string does not actually override the
    // file and must not be reported as masking it.
    return Object.keys(CONFIG_ENV_OVERRIDES).filter(key =>
      CONFIG_ENV_OVERRIDES[key].some(name => Boolean(process.env[name])),
    );
  }

  // Resolved values that are materialized into listeners, containers, engines
  // or child processes at boot. Everything NOT listed here is consumed lazily
  // (per request/registration/seed run) and follows a reload immediately.
  private resolvedBootValues(): Record<string, unknown> {
    const selfEngine = this.getSelfEngineConfig();
    return {
      serverPort: this.getServerPort(),
      enableDynamoProxy: this.isEnableDynamoProxy(),
      dynamoProxyPort: this.getDynamoProxyPort(),
      region: this.getRegion(),
      persistence: this.isPersistence(),
      debug: this.isDebug(),
      stateDir: this.getStateDir(),
      // Only the block's OWN settings: region/persistence are tracked under
      // their own keys above, so one change never flags two entries.
      selfEngine: {
        port: selfEngine.port,
        dataDir: selfEngine.dataDir,
        account: selfEngine.account,
        idleUnloadMs: selfEngine.idleUnloadMs,
        memoryBudgetMb: selfEngine.memoryBudgetMb,
        fsync: selfEngine.fsync,
        fallbackEndpoint: selfEngine.fallbackEndpoint,
      },
    };
  }

  private static diffKeys(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): string[] {
    return Object.keys(before).filter(
      key => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
  }

  private resetAndReload(): void {
    this.config = {};
    this.configPath = '';
    this.loadConfig();
  }

  /**
   * Re-read the config file from disk — after a hand edit, or after
   * updateConfig() wrote it. Runs the exact boot sequence (file search + env
   * override pass), so the result matches what a fresh process would resolve.
   * Boot-materialized keys that changed are reported as restartRequired: the
   * running listeners/engine keep the old value until `lss stop && lss start`.
   */
  reloadFromDisk(): ConfigReloadResult {
    // A hand-edit typo must not silently discard the working config: when the
    // loaded file still exists but no longer parses, keep the current config
    // and fail loudly instead of letting loadConfig fall through to the next
    // search candidate (the user-global home config, or nothing at all).
    if (this.configPath && fs.existsSync(this.configPath)) {
      try {
        JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      } catch {
        throw new ConfigValidationError([
          `${this.configPath} is not valid JSON — fix the file and reload again`,
        ]);
      }
    }
    const before = this.resolvedBootValues();
    this.resetAndReload();
    return {
      path: this.configPath,
      restartRequired: ConfigManager.diffKeys(before, this.resolvedBootValues()),
    };
  }

  /**
   * Validate a partial config patch, write it into the loaded config file (or
   * create lss.config.json in the project root when none is loaded) and reload
   * in-memory. The raw file is re-read and patched key-by-key — never the
   * env-resolved in-memory config — so env-var overrides are not baked into
   * the file on save. The human commits the file; LSS never touches git.
   */
  updateConfig(patch: Record<string, unknown>): ConfigUpdateResult {
    if (!isPlainObject(patch)) {
      throw new ConfigValidationError(['config patch must be a JSON object of top-level lss.config.json keys']);
    }
    const errors: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (BLOCKED_CONFIG_KEYS.has(key)) {
        errors.push(`"${key}" cannot be edited via the API — set it in the config file or environment directly`);
        continue;
      }
      const spec = Object.prototype.hasOwnProperty.call(EDITABLE_CONFIG_KEYS, key)
        ? EDITABLE_CONFIG_KEYS[key]
        : undefined;
      if (!spec) {
        errors.push(`unknown config key "${key}"`);
        continue;
      }
      if (value === null) continue; // null deletes the key (or subkey) from the file
      const error = validateValue(key, value, spec);
      if (error) errors.push(error);
    }
    if (errors.length > 0) {
      throw new ConfigValidationError(errors);
    }

    // Snapshot the resolved boot values BEFORE any mutation, so a failure
    // later in this method can never compare against poisoned state.
    const before = this.resolvedBootValues();

    const target = this.configPath || path.join(this.getProjectRoot(), 'lss.config.json');
    let fileConfig: Record<string, unknown> = {};
    if (fs.existsSync(target)) {
      try {
        fileConfig = JSON.parse(fs.readFileSync(target, 'utf-8'));
      } catch {
        // Never clobber a file the user may be hand-editing mid-typo.
        throw new ConfigValidationError([
          `${target} exists but is not valid JSON — fix or remove it before saving from the dashboard`,
        ]);
      }
    }

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete fileConfig[key];
      } else if (EDITABLE_CONFIG_KEYS[key].kind === 'object') {
        // One-level merge so a partial block edit (e.g. branding.title) never
        // drops sibling settings the UI does not round-trip (branding.logo).
        // Map-shaped blocks (serviceRuntime/servicePackaging) merge one level
        // deeper for the same reason: onboarding sending { apiPort } for one
        // service must not drop that entry's execution/packageEnv siblings.
        const perEntry = Boolean(EDITABLE_CONFIG_KEYS[key].entrySubKeys);
        const existing = isPlainObject(fileConfig[key])
          ? (fileConfig[key] as Record<string, unknown>)
          : {};
        const merged: Record<string, unknown> = { ...existing };
        for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
          if (subValue === null) {
            delete merged[subKey];
          } else if (perEntry && isPlainObject(subValue)) {
            const entryExisting = isPlainObject(merged[subKey])
              ? (merged[subKey] as Record<string, unknown>)
              : {};
            const entryMerged: Record<string, unknown> = { ...entryExisting };
            for (const [entryKey, entryValue] of Object.entries(subValue as Record<string, unknown>)) {
              if (entryValue === null) {
                delete entryMerged[entryKey];
              } else {
                entryMerged[entryKey] = entryValue;
              }
            }
            // An entry left with no settings carries no meaning and would
            // shadow a basename-keyed entry for the same service (an empty
            // object is truthy), so it is dropped rather than written.
            if (Object.keys(entryMerged).length === 0) {
              delete merged[subKey];
            } else {
              merged[subKey] = entryMerged;
            }
          } else {
            merged[subKey] = subValue;
          }
        }
        fileConfig[key] = merged;
      } else {
        fileConfig[key] = value;
      }
    }

    fs.writeFileSync(target, `${JSON.stringify(fileConfig, null, 2)}\n`);

    this.resetAndReload();
    return {
      // The written file is a search candidate, so the reload finds it again;
      // fall back to the target path defensively.
      path: this.configPath || target,
      restartRequired: ConfigManager.diffKeys(before, this.resolvedBootValues()),
      // Truthy check to mirror loadFromEnv: an empty-string env var does not
      // actually override the file, so it must not be reported as a mask.
      envOverridden: Object.keys(patch).filter(key =>
        (CONFIG_ENV_OVERRIDES[key] ?? []).some(name => Boolean(process.env[name])),
      ),
    };
  }

  /**
   * Print configuration summary
   */
  printSummary(): void {
    console.log('\n📋 Configuration Summary:');
    console.log(`  Server Port: ${this.getServerPort()} (http://localhost:${this.getServerPort()})`);
    const selfEngine = this.getSelfEngineConfig();
    console.log(`  Self Engine Port: ${selfEngine.port} (http://localhost:${selfEngine.port})`);
    console.log(`  Self Engine Data Dir: ${selfEngine.dataDir}`);
    if (selfEngine.fallbackEndpoint) {
      console.log(`  Self Engine Fallback: ${selfEngine.fallbackEndpoint}`);
    }
    console.log(`  DynamoDB Proxy Enabled: ${this.isEnableDynamoProxy()}`);
    if (this.isEnableDynamoProxy()) {
      console.log(`  DynamoDB Proxy Port: ${this.getDynamoProxyPort()}`);
    }
    console.log(`  AWS Region: ${this.getRegion()}`);
    console.log(`  Persistence: ${this.isPersistence()}`);
    console.log(`  Seeds Dir: ${this.getSeedsDir()}`);
    const secretSeedCount = Object.keys(this.getSecretSeeds()).length;
    if (secretSeedCount > 0) {
      console.log(`  Config Secrets: ${secretSeedCount}`);
    }
    console.log(`  Auto Package: ${this.isAutoPackage()}`);
    if (this.isAutoPackage()) {
      console.log(`  Package Command: ${this.getPackageCommand()}`);
      if (this.config.packageArgs?.length) {
        console.log(`  Package Args (global): ${this.config.packageArgs.join(' ')}`);
      }
      if (this.config.packageEnv && Object.keys(this.config.packageEnv).length) {
        // Keys only — values may be secrets.
        console.log(`  Package Env (global): ${Object.keys(this.config.packageEnv).join(', ')}`);
      }
      if (this.config.servicePackaging && Object.keys(this.config.servicePackaging).length) {
        console.log(`  Per-service Packaging: ${Object.keys(this.config.servicePackaging).join(', ')}`);
      }
    }
    if (this.getConfigPath()) {
      console.log(`  Config File: ${this.getConfigPath()}`);
    }
    console.log('');
  }

  getOrchestratorUrl(): string {
    const port = this.getServerPort();
    return `http://localhost:${port}`;
  }
}
