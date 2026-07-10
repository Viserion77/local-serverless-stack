import { Router, Request, Response } from 'express';
import path from 'path';
import { CloudFormationParser } from '../services/cloudformation-parser.js';
import { CacheManager } from '../services/cache-manager.js';
import { ResourceProvisioner } from '../services/resource-provisioner.js';
import { ProcessManager } from '../services/process-manager.js';
import { ConfigManager } from '../services/config-manager.js';
import { ServiceRegistrar, RegistrationError } from '../services/service-registrar.js';
import { LambdaRuntimeManager } from '../services/lambda-runtime-manager.js';
import { GatewayManager } from '../services/gateway-manager.js';
import { SourceWatcher } from '../services/source-watcher.js';

const router = Router();
const parser = new CloudFormationParser();
const cache = new CacheManager();
const provisioner = ResourceProvisioner.getInstance();
const processManager = new ProcessManager();
const configManager = ConfigManager.getInstance();

// Initialize cache on first request (lazy init)
let cacheInitialized = false;
async function ensureCacheInit() {
  if (!cacheInitialized) {
    await cache.init();
    cacheInitialized = true;
  }
}

// Register a service
router.post('/register', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();

    const { servicePath, invokePort, apiPort, region } = req.body;

    if (!servicePath) {
      return res.status(400).json({ error: 'servicePath is required' });
    }

    // Region priority: Serverless Framework > lss.config.json > default
    const effectiveRegion = region || configManager.getConfig().region || 'us-east-1';

    console.log(`📝 Registering service from ${servicePath}`);
    console.log(`   Invoke port: ${invokePort || 'not specified'}`);
    console.log(`   API port: ${apiPort || 'not specified'}`);
    console.log(`   Region: ${effectiveRegion}`);
    if (region) {
      console.log(`   Region source: Serverless Framework configuration`);
    } else if (configManager.getConfig().region) {
      console.log(`   Region source: lss.config.json`);
    } else {
      console.log(`   Region source: default`);
    }

    // Validate servicePath to prevent path traversal
    const resolvedPath = path.resolve(servicePath);
    if (resolvedPath.includes('..') || !resolvedPath.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid service path' });
    }

    for (const [label, value] of [['invokePort', invokePort], ['apiPort', apiPort]] as const) {
      if (value && (typeof value !== 'number' || value < 1024 || value > 65535)) {
        return res.status(400).json({ error: `Invalid ${label}, must be between 1024-65535` });
      }
    }

    const result = await ServiceRegistrar.getInstance().register({
      servicePath: resolvedPath,
      invokePort,
      apiPort,
      region,
    });

    return res.json({
      success: true,
      serviceName: result.serviceName,
      resourcesCount: result.resources.length,
      functionsCount: result.functionsCount,
      routesCount: result.routesCount,
      warnings: result.warnings,
      resources: result.resources.map(r => ({
        type: r.type,
        name: 'name' in r ? r.name : r.functionName,
      })),
    });
  } catch (error) {
    if (error instanceof RegistrationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Registration error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// List all services
router.get('/', async (_req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const services = await cache.listServices();
    const withCount = await Promise.all(
      services.map(async (s) => {
        const template = await cache.getTemplate(s.name);
        const resources = template ? parser.parse(template) : [];
        const resourceBreakdown = {
          lambdas: resources.filter(r => r.type === 'lambda').length,
          tables: resources.filter(r => r.type === 'dynamodb').length,
          queues: resources.filter(r => r.type === 'sqs').length,
          topics: resources.filter(r => r.type === 'sns').length,
          buckets: resources.filter(r => r.type === 's3').length,
          buses: resources.filter(r => r.type === 'eventbus').length,
          eventRules: resources.filter(r => r.type === 'event-rule').length,
        };
        const runtime = LambdaRuntimeManager.getInstance().getRuntimeInfo(s.name);
        const gateway = GatewayManager.getInstance().getInfo(s.name);
        return {
          ...s,
          resourcesCount: resources.length,
          resourceBreakdown,
          functionsCount: s.functions?.length ?? 0,
          routesCount: s.routes?.length ?? 0,
          runtimeStatus: runtime.status,
          gateway,
        };
      }),
    );
    return res.json(withCount);
  } catch (error) {
    console.error('Error listing services:', error);
    return res.status(500).json({ error: 'Failed to list services' });
  }
});

// Get service details
router.get('/:name', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const template = await cache.getTemplate(serviceName);
    const resources = parser.parse(template);

    return res.json({
      ...metadata,
      resourcesCount: resources.length,
      resources: resources.map(r => ({
        type: r.type,
        name: 'name' in r ? r.name : r.functionName,
      })),
    });
  } catch (error) {
    console.error('Error fetching service:', error);
    return res.status(500).json({ error: 'Failed to fetch service details' });
  }
});

// Delete service
router.delete('/:name', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    // Tear down the data plane first (worker, listeners, watcher, registry).
    await ServiceRegistrar.getInstance().deactivate(serviceName);

    // Clean up resources from LocalStack — re-parse the cached template so the cleanup
    // works even after an orchestrator restart (no in-memory state).
    const template = await cache.getTemplate(serviceName);
    const resources = template ? parser.parse(template) : [];
    await provisioner.cleanupResources(serviceName, resources);

    // Delete from cache
    await cache.deleteService(serviceName);

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting service:', error);
    return res.status(500).json({ error: 'Failed to delete service' });
  }
});

// Update service status
router.patch('/:name/status', async (req: Request, res: Response) => {
  try {
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const { status, pid } = req.body;
    
    // Validate status
    const validStatuses = ['registered', 'running', 'stopped', 'error'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    
    // Validate PID
    if (pid !== undefined && (typeof pid !== 'number' || pid < 0)) {
      return res.status(400).json({ error: 'Invalid PID' });
    }
    
    await cache.updateMetadata(serviceName, { status, pid });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error updating service status:', error);
    return res.status(500).json({ error: 'Failed to update service status' });
  }
});

// Start a service process (serverless offline / npm start)
router.post('/:name/start', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const { cwd, command, args, env, stage } = req.body || {};
    
    // Validate command whitelist
    const allowedCommands = ['npm', 'npx', 'yarn', 'node'];
    if (command && !allowedCommands.includes(command)) {
      return res.status(400).json({ error: 'Command not allowed' });
    }
    
    const runArgs = args && Array.isArray(args) && args.length > 0 ? args : ['run', stage ? `start:${stage}` : 'start'];

    const result = processManager.start(serviceName, {
      cwd: cwd || metadata.root,
      command,
      args: runArgs,
      env,
    });

    await cache.updateMetadata(serviceName, { status: 'running', pid: result.pid || undefined });

    return res.json({ success: true, pid: result.pid, status: result.status });
  } catch (error) {
    console.error('Error starting service:', error);
    return res.status(500).json({ error: 'Failed to start service' });
  }
});

// Stop a service process
router.post('/:name/stop', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const result = processManager.stop(serviceName);
    await cache.updateMetadata(serviceName, { status: 'stopped', pid: undefined });

    return res.json({ success: result.stopped });
  } catch (error) {
    console.error('Error stopping service:', error);
    return res.status(500).json({ error: 'Failed to stop service' });
  }
});

// Lambda runtime status for a service (worker + gateway/invoke listeners).
router.get('/:name/runtime', async (req: Request, res: Response) => {
  try {
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const runtime = LambdaRuntimeManager.getInstance().getRuntimeInfo(serviceName);
    const gateway = GatewayManager.getInstance().getInfo(serviceName);
    const watch = SourceWatcher.getInstance().getStatus(serviceName);
    return res.json({ runtime, gateway, watch });
  } catch (error) {
    console.error('Error fetching runtime status:', error);
    return res.status(500).json({ error: 'Failed to fetch runtime status' });
  }
});

// Start (or restart) the Lambda runtime for a service.
router.post('/:name/runtime/start', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    const metadata = await cache.getMetadata(serviceName);
    if (!metadata) {
      return res.status(404).json({ error: 'Service not found' });
    }
    await ServiceRegistrar.getInstance().activate(metadata);
    const runtime = LambdaRuntimeManager.getInstance().getRuntimeInfo(serviceName);
    const gateway = GatewayManager.getInstance().getInfo(serviceName);
    return res.json({ success: true, runtime, gateway });
  } catch (error) {
    console.error('Error starting runtime:', error);
    return res.status(500).json({ error: 'Failed to start runtime' });
  }
});

// Stop the Lambda runtime (worker + listeners) for a service.
router.post('/:name/runtime/stop', async (req: Request, res: Response) => {
  try {
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    SourceWatcher.getInstance().unwatch(serviceName);
    await LambdaRuntimeManager.getInstance().stopRuntime(serviceName);
    await GatewayManager.getInstance().stopService(serviceName);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error stopping runtime:', error);
    return res.status(500).json({ error: 'Failed to stop runtime' });
  }
});

// Fetch logs for a running service
router.get('/:name/logs', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    const info = processManager.getLogs(serviceName);
    return res.json(info);
  } catch (error) {
    console.error('Error fetching logs:', error);
    return res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

export { router as servicesRouter, processManager };
