import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ConfigManager } from './config-manager.js';
import type { RegisteredFunction, HttpRoute, AuthorizerConfig } from './serverless-state-parser.js';

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
  region?: string;
  stage?: string;
  functions?: RegisteredFunction[];
  routes?: HttpRoute[];
  authorizers?: AuthorizerConfig[];
}

// Stable, filesystem-safe cache segment for one project root: a readable slug
// from the directory basename plus a short hash of the absolute path, so two
// projects whose directories share a basename still get distinct namespaces.
export function projectCacheSegment(projectRoot: string): string {
  const absoluteRoot = path.resolve(projectRoot);
  const slug = path.basename(absoluteRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha256').update(absoluteRoot).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
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
