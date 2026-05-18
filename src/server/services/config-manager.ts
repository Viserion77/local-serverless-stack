import fs from 'fs';
import path from 'path';

export type LocalStackMode = 'managed' | 'external';
export type LocalStackEdition = 'community' | 'pro';

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

    const candidates = [
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
    return this.config.services ?? ['dynamodb', 'sqs', 'sns', 'lambda'];
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
