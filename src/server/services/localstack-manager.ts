import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { ConfigManager } from './config-manager.js';

const execAsync = promisify(exec);

export class LocalStackManager {
  private static instance: LocalStackManager;
  private process: ChildProcess | null = null;
  private _isRunning = false;
  private endpoint: string;
  private readonly containerName = 'lss-localstack';
  private readonly configManager: ConfigManager;

  private constructor() {
    this.configManager = ConfigManager.getInstance();
    this.endpoint = this.configManager.getLocalStackEndpoint();
  }

  static getInstance(): LocalStackManager {
    if (!LocalStackManager.instance) {
      LocalStackManager.instance = new LocalStackManager();
    }
    return LocalStackManager.instance;
  }

  async start(): Promise<void> {
    if (this._isRunning) {
      console.log('⚠️  LocalStack already running');
      return;
    }

    if (this.configManager.isExternal()) {
      console.log(`🔗 Using external LocalStack at ${this.endpoint}`);
      await this.waitForReady(30);
      this._isRunning = true;
      console.log('✅ Connected to external LocalStack');
      return;
    }

    try {
      // Check if docker is available
      await execAsync('docker ps -q', { timeout: 5000 });
    } catch {
      throw new Error('Docker is not available or not running. Please start Docker first.');
    }

    const edition = this.configManager.getLocalStackEdition();
    const image = this.configManager.getLocalStackImage();
    const authToken = this.configManager.getLocalStackAuthToken();

    if (edition === 'pro' && !authToken) {
      throw new Error(
        'LocalStack Pro requires LOCALSTACK_AUTH_TOKEN. Set the env var or "localstackAuthToken" in your config.',
      );
    }
    if (edition === 'community' && !authToken) {
      console.warn(
        '⚠️  LOCALSTACK_AUTH_TOKEN not set. Recent localstack/localstack images (>= 2026.5) require a token even for the community edition.',
      );
    }

    return new Promise((resolve, reject) => {
      console.log(`🔄 Starting LocalStack (${image})...`);

      const port = this.configManager.getLocalStackPort();
      const services = this.configManager.getServices().join(',');
      const persistence = this.configManager.isPersistence() ? '1' : '0';
      const debug = this.configManager.isDebug() ? '1' : '0';

      const dockerArgs = [
        'run',
        '--rm',
        '-p',
        `${port}:4566`,
        '-p',
        '4571:4571',
        '-v',
        'lss-localstack-data:/var/lib/localstack',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '--name',
        this.containerName,
        '-e',
        `SERVICES=${services}`,
        '-e',
        'LAMBDA_EXECUTOR=local',
        '-e',
        `PERSISTENCE=${persistence}`,
        '-e',
        `DEBUG=${debug}`,
      ];

      if (authToken) {
        dockerArgs.push('-e', `LOCALSTACK_AUTH_TOKEN=${authToken}`);
      }

      dockerArgs.push(image);

      this.process = spawn('docker', dockerArgs);

      let stderr = '';
      let stdout = '';
      this.process.stderr?.on('data', data => {
        stderr += data.toString();
        console.log(`[LocalStack stderr] ${data.toString().trim()}`);
      });
      this.process.stdout?.on('data', data => {
        stdout += data.toString();
        console.log(`[LocalStack stdout] ${data.toString().trim()}`);
      });

      this.process.on('error', error => {
        console.error('❌ Failed to start LocalStack process:', error);
        reject(error);
      });

      this.process.on('close', code => {
        if (code !== 0) {
          console.error(`Container exited with code ${code}`);
          console.error('stderr:', stderr);
          console.error('stdout:', stdout);
        }
      });

      // Wait for LocalStack to be ready
      this.waitForReady()
        .then(() => {
          this._isRunning = true;
          console.log('✅ LocalStack ready');
          resolve();
        })
        .catch(err => {
          console.error('LocalStack startup error:', err.message);
          this.process?.kill();
          reject(err);
        });
    });
  }

  async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    if (this.configManager.isExternal()) {
      console.log('🔗 External LocalStack — leaving container untouched');
      this._isRunning = false;
      return;
    }

    console.log('🛑 Stopping LocalStack...');

    try {
      await execAsync(`docker stop ${this.containerName}`, { timeout: 10000 });
      this._isRunning = false;
      this.process = null;
      console.log('✅ LocalStack stopped');
    } catch (error) {
      console.error('⚠️  Error stopping LocalStack:', error instanceof Error ? error.message : 'Unknown error');
      this._isRunning = false;
    }
  }

  private async waitForReady(maxAttempts = 120): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${this.endpoint}/_localstack/health`);
        if (response.ok) {
          console.log(`✓ LocalStack is responsive (attempt ${i + 1}/${maxAttempts})`);
          return;
        }
      } catch {
        // Ignore fetch errors during startup
        if (i % 20 === 0) {
          console.log(`⏳ Waiting for LocalStack... (attempt ${i + 1}/${maxAttempts})`);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('LocalStack failed to start in time (120s timeout). Check Docker and container logs.');
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  getConfig() {
    return {
      endpoint: this.endpoint,
      region: this.configManager.getRegion(),
      credentials: {
        accessKeyId: process.env.LOCALSTACK_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.LOCALSTACK_SECRET_ACCESS_KEY || 'test',
      },
    };
  }
}
