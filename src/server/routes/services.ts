import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { CloudFormationParser } from '../services/cloudformation-parser.js';
import { CacheManager } from '../services/cache-manager.js';
import { ResourceProvisioner } from '../services/resource-provisioner.js';
import { ProcessManager } from '../services/process-manager.js';

const router = Router();
const parser = new CloudFormationParser();
const cache = new CacheManager();
const provisioner = new ResourceProvisioner();
const processManager = new ProcessManager();

// Initialize cache
await cache.init();

// Register a service
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { servicePath, invokePort } = req.body;

    if (!servicePath) {
      return res.status(400).json({ error: 'servicePath is required' });
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

    // Read CloudFormation template
    const templatePath = path.join(resolvedPath, '.serverless', 'cloudformation-template-update-stack.json');
    const templateContent = await fs.readFile(templatePath, 'utf-8');
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
    });

    // Provision resources to LocalStack
    await provisioner.provisionResources(serviceName, resources, {
      invokePort,
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
    const message = error instanceof Error ? 'Failed to register service' : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// List all services
router.get('/', async (_req: Request, res: Response) => {
  try {
    const services = await cache.listServices();
    return res.json(services);
  } catch (error) {
    console.error('Error listing services:', error);
    return res.status(500).json({ error: 'Failed to list services' });
  }
});

// Get service details
router.get('/:name', async (req: Request, res: Response) => {
  try {
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
    const serviceName = req.params.name;
    if (!serviceName || typeof serviceName !== 'string' || serviceName.includes('/') || serviceName.includes('..')) {
      return res.status(400).json({ error: 'Invalid service name' });
    }
    
    // Clean up resources from LocalStack
    await provisioner.cleanupResources(serviceName);
    
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
