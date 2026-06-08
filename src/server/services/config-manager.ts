import fs from 'fs';
import path from 'path';

export type LocalStackMode = 'managed' | 'external';
export type LocalStackEdition = 'community' | 'pro';

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

export interface LSSConfig {
  // Server port (dashboard + API)
  serverPort?: number;

  // LocalStack endpoint and port
  localstackPort?: number;
  localstackEndpoint?: string;

  // LocalStack operation mode:
  //   "managed" (default): LSS starts/stops a Docker container.
  //   "external": LSS connects to an already-running LocalStack instance.
  mode?: LocalStackMode;

  // LocalStack edition: "community" (free) or "pro" (requires auth token).
  localstackEdition?: LocalStackEdition;

  // LocalStack image tag/version. Defaults to "latest".
  localstackVersion?: string;

  // Full image override. Wins over edition+version when set.
  localstackImage?: string;

  // Auth token for LocalStack Pro and recent (>=2026.5) community images.
  // Prefer the LOCALSTACK_AUTH_TOKEN env var over committing this to a file.
  localstackAuthToken?: string;

  // DynamoDB Proxy
  enableDynamoProxy?: boolean;
  dynamoProxyPort?: number;

  // AWS Configuration
  region?: string;

  // LocalStack services
  services?: string[];

  // Persistence
  persistence?: boolean;

  // Debug mode
  debug?: boolean;

  // Directory containing DynamoDB seed files ({tableName}.json).
  // Seeds are auto-applied when a table is created; can also be run on demand.
  seedsDir?: string;

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
          break;
        } catch (error) {
          console.warn(`⚠️  Failed to parse config file ${candidate}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }

    // Environment variables override file values so secrets like LOCALSTACK_AUTH_TOKEN
    // can be injected without committing them to disk.
    this.loadFromEnv();
  }

  private loadFromEnv(): void {
    // Load configuration from environment variables
    if (process.env.LSS_DASHBOARD_PORT || process.env.PORT) {
      /* istanbul ignore next: the enclosing if guarantees one of these is truthy, so the `|| ''` fallback is unreachable */
      this.config.serverPort = parseInt(process.env.LSS_DASHBOARD_PORT || process.env.PORT || '', 10);
    }
    if (process.env.LSS_LOCALSTACK_PORT) {
      this.config.localstackPort = parseInt(process.env.LSS_LOCALSTACK_PORT, 10);
    }
    if (process.env.LSS_LOCALSTACK_ENDPOINT) {
      this.config.localstackEndpoint = process.env.LSS_LOCALSTACK_ENDPOINT;
    }
    if (process.env.LSS_LOCALSTACK_MODE) {
      const mode = process.env.LSS_LOCALSTACK_MODE.toLowerCase();
      if (mode === 'managed' || mode === 'external') {
        this.config.mode = mode;
      }
    }
    if (process.env.LSS_LOCALSTACK_EDITION) {
      const edition = process.env.LSS_LOCALSTACK_EDITION.toLowerCase();
      if (edition === 'community' || edition === 'pro') {
        this.config.localstackEdition = edition;
      }
    }
    if (process.env.LSS_LOCALSTACK_VERSION) {
      this.config.localstackVersion = process.env.LSS_LOCALSTACK_VERSION;
    }
    if (process.env.LSS_LOCALSTACK_IMAGE) {
      this.config.localstackImage = process.env.LSS_LOCALSTACK_IMAGE;
    }
    if (process.env.LOCALSTACK_AUTH_TOKEN) {
      this.config.localstackAuthToken = process.env.LOCALSTACK_AUTH_TOKEN;
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
    if (process.env.LSS_SERVICES) {
      this.config.services = process.env.LSS_SERVICES.split(',');
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
  }

  getConfig(): LSSConfig {
    return this.config;
  }

  getServerPort(): number {
    return this.config.serverPort ?? (parseInt(process.env.PORT || '', 10) || 3100);
  }

  // Alias for backward compatibility
  getDashboardPort(): number {
    return this.getServerPort();
  }

  getLocalStackPort(): number {
    return this.config.localstackPort ?? 4566;
  }

  getLocalStackEndpoint(): string {
    if (this.config.localstackEndpoint) {
      return this.config.localstackEndpoint;
    }
    const port = this.getLocalStackPort();
    return `http://localhost:${port}`;
  }

  getMode(): LocalStackMode {
    return this.config.mode ?? 'managed';
  }

  isExternal(): boolean {
    return this.getMode() === 'external';
  }

  getLocalStackEdition(): LocalStackEdition {
    return this.config.localstackEdition ?? 'community';
  }

  getLocalStackVersion(): string {
    return this.config.localstackVersion ?? 'latest';
  }

  getLocalStackImage(): string {
    if (this.config.localstackImage) {
      return this.config.localstackImage;
    }
    const repo = this.getLocalStackEdition() === 'pro' ? 'localstack/localstack-pro' : 'localstack/localstack';
    return `${repo}:${this.getLocalStackVersion()}`;
  }

  getLocalStackAuthToken(): string | undefined {
    return this.config.localstackAuthToken;
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

  getServices(): string[] {
    return this.config.services ?? ['dynamodb', 'sqs', 'sns', 's3', 'lambda'];
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
    const map = this.config.servicePackaging ?? {};
    const baseName = path.basename(servicePath);
    const configDir = path.resolve(this.configPath ? path.dirname(this.configPath) : process.cwd());
    const relPath = path.relative(configDir, servicePath).split(path.sep).join('/');
    const perService = map[relPath] ?? map[baseName] ?? {};
    return {
      command: perService.packageCommand ?? this.getPackageCommand(),
      args: [...(this.config.packageArgs ?? []), ...(perService.packageArgs ?? [])],
      env: { ...(this.config.packageEnv ?? {}), ...(perService.packageEnv ?? {}) },
      timeoutMs: perService.packageTimeoutMs ?? this.getPackageTimeoutMs(),
    };
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Print configuration summary
   */
  printSummary(): void {
    console.log('\n📋 Configuration Summary:');
    console.log(`  Server Port: ${this.getServerPort()} (http://localhost:${this.getServerPort()})`);
    console.log(`  LocalStack Mode: ${this.getMode()}`);
    console.log(`  LocalStack Port: ${this.getLocalStackPort()} (${this.getLocalStackEndpoint()})`);
    if (!this.isExternal()) {
      console.log(`  LocalStack Image: ${this.getLocalStackImage()} (${this.getLocalStackEdition()})`);
      console.log(`  LocalStack Auth Token: ${this.getLocalStackAuthToken() ? 'set' : 'not set'}`);
    }
    console.log(`  DynamoDB Proxy Enabled: ${this.isEnableDynamoProxy()}`);
    if (this.isEnableDynamoProxy()) {
      console.log(`  DynamoDB Proxy Port: ${this.getDynamoProxyPort()}`);
    }
    console.log(`  AWS Region: ${this.getRegion()}`);
    console.log(`  Services: ${this.getServices().join(', ')}`);
    console.log(`  Persistence: ${this.isPersistence()}`);
    console.log(`  Seeds Dir: ${this.getSeedsDir()}`);
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
