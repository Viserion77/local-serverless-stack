// Selects and owns the active EngineBackend (LocalStack container vs the
// in-process self engine) based on `engine` in the config. Every consumer of
// the old LocalStackManager API goes through here (via the facade kept at
// services/localstack-manager.ts), so the provisioner/explorers/seeds are
// engine-agnostic: they always talk AWS wire against getConfig().endpoint.

import { ConfigManager } from '../services/config-manager.js';
import { LocalStackBackend } from './backends/localstack-backend.js';
import type { EngineBackend } from './engine-backend.js';

export class EngineManager {
  private static instance: EngineManager;
  private backend: EngineBackend | null = null;
  private readonly configManager = ConfigManager.getInstance();

  static getInstance(): EngineManager {
    if (!EngineManager.instance) {
      EngineManager.instance = new EngineManager();
    }
    return EngineManager.instance;
  }

  getKind(): 'localstack' | 'self' {
    return this.configManager.getEngineKind();
  }

  async start(): Promise<void> {
    const backend = await this.resolveBackend();
    await backend.start();
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
    // Computable without the backend instance so callers can read it before
    // start() (the self backend is loaded lazily inside start()).
    return this.backend?.getEndpoint() ?? this.configManager.getEngineEndpoint();
  }

  getConfig(): { endpoint: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string } } {
    if (this.backend) {
      return this.backend.getConfig();
    }
    return {
      endpoint: this.getEndpoint(),
      region: this.configManager.getRegion(),
      credentials: {
        accessKeyId: process.env.LOCALSTACK_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.LOCALSTACK_SECRET_ACCESS_KEY || 'test',
      },
    };
  }

  healthDetail(): Record<string, unknown> {
    return {
      kind: this.getKind(),
      running: this.isRunning(),
      endpoint: this.getEndpoint(),
      ...(this.backend?.healthDetail() ?? {}),
    };
  }

  // The self backend is loaded with a dynamic import so LocalStack-mode
  // processes never pay for the engine's code (RSS provably unchanged).
  private async resolveBackend(): Promise<EngineBackend> {
    if (!this.backend) {
      if (this.configManager.isSelfEngine()) {
        const { SelfEngineBackend } = await import('./backends/self-backend.js');
        this.backend = new SelfEngineBackend();
      } else {
        this.backend = new LocalStackBackend();
      }
    }
    return this.backend;
  }
}
