import chalk from 'chalk';

interface ServerlessInstance {
  config: {
    servicePath: string;
    service?: string;
  };
  service?: {
    service?: string;
    custom?: Record<string, any>;
    provider?: {
      region?: string;
    };
  };
  utils?: {
    log?: {
      notice?: (msg: string) => void;
      error?: (msg: string) => void;
    };
  };
}

interface PluginOptions {
  orchestratorUrl?: string;
  enabled?: boolean;
}

class ServerlessOrchestratorPlugin {
  private serverless: ServerlessInstance;
  private orchestratorUrl: string;
  private enabled: boolean;
  public hooks: Record<string, () => Promise<void>>;

  constructor(serverless: ServerlessInstance, options: PluginOptions = {}) {
    this.serverless = serverless;
    const customConfig = (this.serverless.service?.custom || {}).orchestrator || {};

    // Merge priority: env > options > custom > defaults
    const merged = {
      enabled: true,
      orchestratorUrl: 'http://localhost:14566',
      ...customConfig,
      ...options,
    } as PluginOptions;

    // Env overrides win over file/options so the same serverless.yml can register
    // against different LSS instances at runtime (e.g. an isolated e2e stack).
    // ORCHESTRATOR_URL (a full URL) is the most explicit and wins over
    // LSS_DASHBOARD_PORT (just the dashboard port of the target instance).
    if (process.env.ORCHESTRATOR_URL) {
      merged.orchestratorUrl = process.env.ORCHESTRATOR_URL;
    } else if (process.env.LSS_DASHBOARD_PORT) {
      merged.orchestratorUrl = `http://localhost:${process.env.LSS_DASHBOARD_PORT}`;
    }
    if (process.env.ORCHESTRATOR_ENABLED) {
      merged.enabled = process.env.ORCHESTRATOR_ENABLED !== 'false';
    }

    this.orchestratorUrl = merged.orchestratorUrl!;
    this.enabled = merged.enabled !== false;

    this.hooks = {
      'after:package:finalize': this.registerWithOrchestrator.bind(this),
      // 'after:deploy:deploy': this.registerWithOrchestrator.bind(this),
      'before:offline:start': this.registerWithOrchestrator.bind(this),
      'before:offline:start:init': this.registerWithOrchestrator.bind(this),
    };
  }

  private log(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
    const timestamp = new Date().toLocaleTimeString();

    let formattedMessage = '';
    switch (type) {
      case 'success':
        formattedMessage = chalk.green(`✓ [${timestamp}] ${message}`);
        break;
      case 'error':
        formattedMessage = chalk.red(`✗ [${timestamp}] ${message}`);
        break;
      default:
        formattedMessage = chalk.blue(`ℹ [${timestamp}] ${message}`);
    }

    console.log(formattedMessage);
  }

  private async registerWithOrchestrator(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const servicePath = this.serverless.config.servicePath;
    const serviceName = this.serverless.service?.service || this.serverless.config.service || 'unknown';
    const region = this.serverless.service?.provider?.region; // Don't use fallback, let orchestrator handle it

    // Port discovery: custom.lss wins; custom.serverless-offline keeps drop-in
    // compatibility for services already configured for offline (httpPort →
    // apiPort, lambdaPort → invokePort).
    const lssConfig = this.serverless.service?.custom?.lss || {};
    const serverlessOfflineConfig = this.serverless.service?.custom?.['serverless-offline'] || {};
    const invokePort = lssConfig.invokePort ?? serverlessOfflineConfig.lambdaPort;
    const apiPort = lssConfig.apiPort ?? serverlessOfflineConfig.httpPort;

    if (region) {
      this.log(`Registering service "${serviceName}" (region: ${region} from Serverless Framework) with orchestrator at ${this.orchestratorUrl}...`, 'info');
    } else {
      this.log(`Registering service "${serviceName}" (region will use orchestrator configuration) with orchestrator at ${this.orchestratorUrl}...`, 'info');
    }

    try {
      const response = await fetch(`${this.orchestratorUrl}/api/services/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          servicePath,
          invokePort,
          ...(apiPort !== undefined && { apiPort }),
          ...(region && { region }), // Only include region if defined in Serverless Framework
        }),
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ error: response.statusText }))) as any;
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      const result = (await response.json()) as any;
      this.log(`Orchestrator: Registered ${result.resourcesCount} resources for "${serviceName}"`, 'success');
    } catch (error: any) {
      // Non-blocking error: log but don't fail the deployment
      this.log(
        `Orchestrator unavailable or registration failed: ${error.message}. Continuing without orchestrator sync.`,
        'error',
      );
    }
  }
}

// Export for serverless framework (CommonJS)
module.exports = ServerlessOrchestratorPlugin;
