// Owns the AWS engine for this process.
//
// 1.0 removed the LocalStack backend: the self engine is the only engine, so
// this is no longer a chooser — it is the singleton every SDK-based consumer
// (provisioner, explorers, seeds, dynamo proxy, routes) goes through to get an
// endpoint + credentials. It stays as a seam so those consumers never import
// the backend, and so `getEndpoint()` answers correctly before `start()` — the
// explorers build their clients at construction time.

import type http from 'http';
import { ConfigManager } from '../services/config-manager.js';
import type { SelfEngineBackend } from './backends/self-backend.js';
import type { ApiGatewayEmulator } from './emulators/apigateway/index.js';

export class EngineManager {
  private static instance: EngineManager;
  private backend: SelfEngineBackend | null = null;
  private readonly configManager = ConfigManager.getInstance();

  static getInstance(): EngineManager {
    if (!EngineManager.instance) {
      EngineManager.instance = new EngineManager();
    }
    return EngineManager.instance;
  }

  async start(): Promise<void> {
    await (await this.resolveBackend()).start();
  }

  /**
   * Start the engine WITHOUT binding a port and hand back its request handler,
   * so the orchestrator can serve the AWS wire on its own listener.
   */
  async startEmbedded(): Promise<(req: http.IncomingMessage, res: http.ServerResponse) => void> {
    return (await this.resolveBackend()).startEmbedded();
  }

  async stop(): Promise<void> {
    if (this.backend) {
      await this.backend.stop();
    }
  }

  isRunning(): boolean {
    return this.backend?.isRunning() ?? false;
  }

  getEndpoint(): string {
    // Embedded: the engine never bound a port of its own, so the endpoint is
    // whatever the orchestrator resolved.
    if (this.configManager.isSingleListener()) return this.configManager.getOrchestratorUrl();
    return this.backend?.getEndpoint() ?? this.configManager.getEngineEndpoint();
  }

  getConfig(): { endpoint: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string } } {
    if (this.backend) {
      return this.backend.getConfig();
    }
    return {
      endpoint: this.getEndpoint(),
      region: this.configManager.getRegion(),
      // The engine never verifies signatures; the SDKs just refuse to send a
      // request without credentials at all.
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    };
  }

  // The running engine's API Gateway control plane — what the local gateway
  // consults to enforce API keys on `private: true` routes. Undefined (never a
  // throw) before the engine starts, after it stops, or mid-reset: the gateway
  // turns that into a 403 for the key-protected route, not a 500.
  getApiGateway(): ApiGatewayEmulator | undefined {
    if (!this.backend?.isRunning()) return undefined;
    try {
      return this.backend.getApiGateway();
    } catch {
      return undefined;
    }
  }

  healthDetail(): Record<string, unknown> {
    return {
      kind: 'self',
      running: this.isRunning(),
      endpoint: this.getEndpoint(),
      ...(this.backend?.healthDetail() ?? {}),
    };
  }

  // Loaded on demand rather than at module scope. Everything that reads an
  // endpoint imports this module (explorers, provisioner, seeds), and a static
  // import would drag the whole engine — emulators, dispatch, the Lambda
  // runtime — into every one of their unit tests.
  private async resolveBackend(): Promise<SelfEngineBackend> {
    if (!this.backend) {
      const { SelfEngineBackend: Backend } = await import('./backends/self-backend.js');
      this.backend = new Backend();
    }
    return this.backend;
  }
}
