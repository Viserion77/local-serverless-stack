// Global in-memory registry of every function and HTTP route across registered
// services. Rebuilt from the on-disk service cache at boot and updated on every
// (re-)registration, it is the lookup layer shared by the invoke listeners, the
// gateway proxy and the authorizer service — including cross-service resolution
// (an authorizer ARN in service A can point at a function registered by service B).

import { CacheManager, ServiceMetadata } from './cache-manager.js';
import type { RegisteredFunction, HttpRoute, AuthorizerConfig } from './serverless-state-parser.js';

export interface ServiceEntry {
  name: string;
  root: string;
  region?: string;
  stage?: string;
  apiPort?: number;
  invokePort?: number;
  functions: RegisteredFunction[];
  routes: HttpRoute[];
  authorizers: AuthorizerConfig[];
}

export interface FunctionRef {
  service: ServiceEntry;
  fn: RegisteredFunction;
}

export class FunctionRegistry {
  private static instance: FunctionRegistry;
  private services = new Map<string, ServiceEntry>();

  static getInstance(): FunctionRegistry {
    if (!FunctionRegistry.instance) {
      FunctionRegistry.instance = new FunctionRegistry();
    }
    return FunctionRegistry.instance;
  }

  // Rebuild from the persisted service cache (called once at boot so registered
  // services survive orchestrator restarts).
  async rehydrate(cache: CacheManager): Promise<ServiceEntry[]> {
    const services = await cache.listServices();
    for (const metadata of services) {
      this.registerService(metadata);
    }
    return [...this.services.values()];
  }

  registerService(metadata: ServiceMetadata): ServiceEntry {
    const entry: ServiceEntry = {
      name: metadata.name,
      root: metadata.root,
      region: metadata.region,
      stage: metadata.stage,
      apiPort: metadata.apiPort,
      invokePort: metadata.invokePort,
      functions: metadata.functions || [],
      routes: metadata.routes || [],
      authorizers: metadata.authorizers || [],
    };
    this.services.set(metadata.name, entry);
    return entry;
  }

  removeService(serviceName: string): void {
    this.services.delete(serviceName);
  }

  getService(serviceName: string): ServiceEntry | undefined {
    return this.services.get(serviceName);
  }

  listServices(): ServiceEntry[] {
    return [...this.services.values()];
  }

  listFunctions(): FunctionRef[] {
    const refs: FunctionRef[] = [];
    for (const service of this.services.values()) {
      for (const fn of service.functions) {
        refs.push({ service, fn });
      }
    }
    return refs;
  }

  // Resolve a function by short name, fully qualified name, or Lambda ARN.
  // `preferredService` scopes short-name lookups (the invoke listener knows which
  // service's port received the call); ARNs and full names search globally.
  resolve(nameOrArn: string, preferredService?: string): FunctionRef | undefined {
    if (!nameOrArn) return undefined;

    // ARN → the function name is the segment after "function:".
    let name = nameOrArn;
    const arnMatch = /^arn:aws:lambda:[^:]*:[^:]*:function:([^:]+)/.exec(nameOrArn);
    if (arnMatch) name = arnMatch[1];

    if (preferredService) {
      const service = this.services.get(preferredService);
      const local = service?.functions.find(f => f.name === name || f.fullName === name);
      if (service && local) return { service, fn: local };
    }

    const matches: FunctionRef[] = [];
    for (const service of this.services.values()) {
      for (const fn of service.functions) {
        if (fn.fullName === name || fn.name === name) {
          matches.push({ service, fn });
        }
      }
    }
    // Full-name matches are unambiguous; short-name matches only count when unique.
    const fullMatch = matches.find(m => m.fn.fullName === name);
    if (fullMatch) return fullMatch;
    if (matches.length === 1) return matches[0];
    return undefined;
  }

  getServiceByApiPort(port: number): ServiceEntry | undefined {
    return [...this.services.values()].find(s => s.apiPort === port);
  }

  getServiceByInvokePort(port: number): ServiceEntry | undefined {
    return [...this.services.values()].find(s => s.invokePort === port);
  }

  getAuthorizer(serviceName: string, authorizerName: string): AuthorizerConfig | undefined {
    return this.services.get(serviceName)?.authorizers.find(a => a.name === authorizerName);
  }
}
