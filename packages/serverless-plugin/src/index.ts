import chalk from 'chalk';

interface ServerlessInstance {
  config: {
    servicePath: string;
    service?: string;
  };
  service?: {
    service?: string;
    custom?: Record<string, any>;
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
      orchestratorUrl: 'http://localhost:3100',
      ...customConfig,
      ...options,
    } as PluginOptions;

    if (process.env.ORCHESTRATOR_URL) {
      merged.orchestratorUrl = process.env.ORCHESTRATOR_URL;
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

    // Extract invoke port from serverless-offline configuration
    const serverlessOfflineConfig = this.serverless.service?.custom?.['serverless-offline'];
    const invokePort = serverlessOfflineConfig?.lambdaPort;

    this.log(`Registering service "${serviceName}" with orchestrator at ${this.orchestratorUrl}...`, 'info');

    try {
      const response = await fetch(`${this.orchestratorUrl}/api/services/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          servicePath,
          invokePort,
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
