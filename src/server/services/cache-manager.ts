import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ConfigManager } from './config-manager.js';
import { projectCacheSegment } from './project-scope.js';
import type { RegisteredFunction, HttpRoute, AuthorizerConfig } from './serverless-state-parser.js';

// Re-exported for the existing importers (the segment itself now lives in
// project-scope.ts, which config-manager can import without a cycle).
export { projectCacheSegment };

// The port layers BELOW lss.config.json: what the register request carried and
// what the packaged `custom.lss` block declared. Recorded so every activation
// can re-apply the config on top of them instead of replaying a number that was
// resolved once — see resolvePorts() in service-registrar.ts.
export interface ServicePortHints {
  apiPort?: number;
  invokePort?: number;
}

export interface ServiceMetadata {
  name: string;
  root: string;
  templateHash: string;
  lastUpdated: number;
  pid?: number;
  status: 'registered' | 'running' | 'stopped';
  invokePort?: number;
  // Port the gateway proxy binds for this service's HTTP routes (30xx convention).
  apiPort?: number;
  // Absent on entries cached before 1.1: those keep `apiPort`/`invokePort` as
  // their own hint, so an upgrade never moves a running service's port.
  portHints?: ServicePortHints;
  region?: string;
  stage?: string;
  functions?: RegisteredFunction[];
  routes?: HttpRoute[];
  authorizers?: AuthorizerConfig[];
}

export class CacheManager {
  private cacheDir: string;

  // The registered-services cache is scoped per project (the directory this
  // orchestrator serves). A single global namespace let same-named services
  // from different projects overwrite each other and rehydrate into the wrong
  // orchestrator. Old flat-layout entries (~/.lss/orchestrator/cache/<svc>)
  // stay on disk but are invisible here.
  constructor(projectRoot: string = ConfigManager.getInstance().getProjectRoot()) {
    this.cacheDir = path.join(
      os.homedir(), '.lss', 'orchestrator', 'cache',
      'projects', projectCacheSegment(projectRoot),
    );
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async saveTemplate(serviceName: string, template: any, metadata: Omit<ServiceMetadata, 'name'>): Promise<void> {
    const serviceDir = path.join(this.cacheDir, serviceName);
    await fs.mkdir(serviceDir, { recursive: true });

    // Save template
    await fs.writeFile(path.join(serviceDir, 'cloudformation-template.json'), JSON.stringify(template, null, 2));

    // Save metadata
    await fs.writeFile(
      path.join(serviceDir, 'metadata.json'),
      JSON.stringify({ name: serviceName, ...metadata }, null, 2),
    );
  }

  async getTemplate(serviceName: string): Promise<any | null> {
    try {
      const templatePath = path.join(this.cacheDir, serviceName, 'cloudformation-template.json');
      const content = await fs.readFile(templatePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async getMetadata(serviceName: string): Promise<ServiceMetadata | null> {
    try {
      const metadataPath = path.join(this.cacheDir, serviceName, 'metadata.json');
      const content = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async updateMetadata(serviceName: string, updates: Partial<ServiceMetadata>): Promise<void> {
    const metadata = await this.getMetadata(serviceName);
    if (!metadata) {
      throw new Error(`Service ${serviceName} not found in cache`);
    }

    await fs.writeFile(
      path.join(this.cacheDir, serviceName, 'metadata.json'),
      JSON.stringify({ ...metadata, ...updates }, null, 2),
    );
  }

  async listServices(): Promise<ServiceMetadata[]> {
    try {
      const entries = await fs.readdir(this.cacheDir, { withFileTypes: true });
      const services: ServiceMetadata[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const metadata = await this.getMetadata(entry.name);
          if (metadata) {
            services.push(metadata);
          }
        }
      }

      return services;
    } catch {
      return [];
    }
  }

  async deleteService(serviceName: string): Promise<void> {
    const serviceDir = path.join(this.cacheDir, serviceName);
    await fs.rm(serviceDir, { recursive: true, force: true });
  }
}
