// Lifecycle seam between the orchestrator and whichever AWS provider is
// active. Provisioning is NOT part of this interface on purpose: both engines
// are driven through the AWS wire API by the existing SDK-based code
// (provisioner, explorers, seeds), so the only thing that varies is lifecycle
// and endpoint. See docs/PRD_SELF_ENGINE.md §5.1.

export interface EngineBackend {
  readonly kind: 'localstack' | 'self';
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getEndpoint(): string;
  getConfig(): {
    endpoint: string;
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  };
  healthDetail(): Record<string, unknown>;
}
