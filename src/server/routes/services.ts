import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { CloudFormationParser } from '../services/cloudformation-parser.js';
import { CacheManager } from '../services/cache-manager.js';
import { ResourceProvisioner } from '../services/resource-provisioner.js';
import { ProcessManager } from '../services/process-manager.js';
import { ConfigManager } from '../services/config-manager.js';
import { runServerlessPackage, ServerlessPackageError } from '../services/serverless-packager.js';

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
    
    const { servicePath, invokePort, region } = req.body;

    if (!servicePath) {
      return res.status(400).json({ error: 'servicePath is required' });
    }

    // Region priority: Serverless Framework > lss.config.json > default
    const effectiveRegion = region || configManager.getConfig().region || 'us-east-1';
    
    console.log(`📝 Registering service from ${servicePath}`);
    console.log(`   Invoke port: ${invokePort || 'not specified'}`);
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

    // Validate invokePort
    if (invokePort && (typeof invokePort !== 'number' || invokePort < 1024 || invokePort > 65535)) {
      return res.status(400).json({ error: 'Invalid invokePort, must be between 1024-65535' });
    }

    // Read CloudFormation template. If missing and autoPackage is enabled, run
    // the configured package command and retry once.
    const templatePath = path.join(resolvedPath, '.serverless', 'cloudformation-template-update-stack.json');
    let templateContent: string;
    try {
      templateContent = await fs.readFile(templatePath, 'utf-8');
    } catch (err) {
      const isENOENT = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      if (!isENOENT) throw err;

      if (!configManager.isAutoPackage()) {
        return res.status(400).json({
          error: `CloudFormation template not found at ${templatePath}. Run 'serverless package' in the service directory, or enable autoPackage in lss.config.json.`,
        });
      }

      const packageCommand = configManager.getPackageCommand();
      console.log(`📦 Template missing — running '${packageCommand}' in ${resolvedPath}`);
      try {
        const result = await runServerlessPackage({
          command: packageCommand,
          cwd: resolvedPath,
          timeoutMs: configManager.getPackageTimeoutMs(),
        });
        console.log(`✅ Auto-package finished for ${resolvedPath} (exit 0)`);
        if (result.stdout.trim()) {
          console.log(`--- ${packageCommand} stdout ---\n${result.stdout.trimEnd()}\n--- end ---`);
        }
      } catch (packageErr) {
        if (packageErr instanceof ServerlessPackageError) {
          console.error(`❌ Auto-package failed for ${resolvedPath}: ${packageErr.message}`);
          if (packageErr.result.stdout.trim()) {
            console.error(`--- ${packageCommand} stdout ---\n${packageErr.result.stdout.trimEnd()}\n--- end ---`);
          }
          if (packageErr.result.stderr.trim()) {
            console.error(`--- ${packageCommand} stderr ---\n${packageErr.result.stderr.trimEnd()}\n--- end ---`);
          }
        } else {
          console.error(`❌ Auto-package failed for ${resolvedPath}:`, packageErr);
        }
        const detail = packageErr instanceof ServerlessPackageError
          ? `${packageErr.message}\n${packageErr.result.stderr || packageErr.result.stdout}`.trim()
          : packageErr instanceof Error ? packageErr.message : 'Unknown error';
        return res.status(500).json({
          error: `Auto-package failed for ${resolvedPath}: ${detail}. Full stderr/stdout is in the orchestrator log (/tmp/lss-orchestrator.log).`,
        });
      }
      templateContent = await fs.readFile(templatePath, 'utf-8');
    }
    const template = JSON.parse(templateContent);

    // Parse resources
    const resources = parser.parse(template);
    const templateHash = parser.calculateHash(template);

    // Extract service name
    const serviceName = path.basename(servicePath);

    // Save to cache
    await cache.saveTemplate(serviceName, template, {
      root: servicePath,
      templateHash,
      lastUpdated: Date.now(),
      status: 'registered',
      invokePort,
      region: effectiveRegion,
    });

    // Provision resources to LocalStack
    await provisioner.provisionResources(serviceName, resources, {
      invokePort,
      region: effectiveRegion,
    });

    return res.json({
      success: true,
      serviceName,
      resourcesCount: resources.length,
      resources: resources.map(r => ({
        type: r.type,
        name: 'name' in r ? r.name : r.functionName,
      })),
    });
  } catch (error) {
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
        };
        return { ...s, resourcesCount: resources.length, resourceBreakdown };
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
