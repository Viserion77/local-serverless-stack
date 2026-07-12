// Deprecated facade kept so the ~10 existing call sites (provisioner,
// explorers, seeds, dynamo-proxy, routes) stay untouched: they keep importing
// LocalStackManager, but the active provider may be the LocalStack container
// OR the in-process self engine — EngineManager decides from the config.
// New code should use EngineManager directly.

import { EngineManager } from '../engine/engine-manager.js';

export class LocalStackManager {
  private static instance: LocalStackManager;

  static getInstance(): LocalStackManager {
    if (!LocalStackManager.instance) {
      LocalStackManager.instance = new LocalStackManager();
    }
    return LocalStackManager.instance;
  }

  async start(): Promise<void> {
    return EngineManager.getInstance().start();
  }

  async stop(): Promise<void> {
    return EngineManager.getInstance().stop();
  }

  isRunning(): boolean {
    return EngineManager.getInstance().isRunning();
  }

  getEndpoint(): string {
    return EngineManager.getInstance().getEndpoint();
  }

  getConfig(): { endpoint: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string } } {
    return EngineManager.getInstance().getConfig();
  }
}
