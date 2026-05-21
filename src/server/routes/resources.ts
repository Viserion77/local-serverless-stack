import { Router, Request, Response } from 'express';
import { ResourceProvisioner } from '../services/resource-provisioner.js';
import { CacheManager } from '../services/cache-manager.js';
import { CloudFormationParser } from '../services/cloudformation-parser.js';
import { ConfigManager } from '../services/config-manager.js';

const router = Router();
const provisioner = ResourceProvisioner.getInstance();
const cache = new CacheManager();
const parser = new CloudFormationParser();
const configManager = ConfigManager.getInstance();

let cacheInitialized = false;
async function ensureCacheInit() {
  if (!cacheInitialized) {
    await cache.init();
    cacheInitialized = true;
  }
}

// List all provisioned resources
router.get('/', async (req: Request, res: Response) => {
  try {
    const region = typeof req.query.region === 'string' && req.query.region ? req.query.region : undefined;
    const resources = await provisioner.listAllResources(region);
    res.json(resources);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Map resource names to the service that declared them, sourced from the
// cached CloudFormation templates. Filtered by region so the UI can match
// owners against the currently-viewed LocalStack region.
router.get('/owners', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const queryRegion = typeof req.query.region === 'string' && req.query.region ? req.query.region : undefined;
    const defaultRegion = configManager.getRegion();
    const services = await cache.listServices();

    const filtered = queryRegion
      ? services.filter(s => (s.region || defaultRegion) === queryRegion)
      : services;

    const tables: Array<{ name: string; service: string }> = [];
    const queues: Array<{ name: string; service: string }> = [];
    const topics: Array<{ name: string; service: string }> = [];
    const buckets: Array<{ name: string; service: string }> = [];

    for (const svc of filtered) {
      const template = await cache.getTemplate(svc.name);
      if (!template) continue;
      const resources = parser.parse(template);
      for (const r of resources) {
        if (r.type === 'dynamodb') tables.push({ name: r.name, service: svc.name });
        else if (r.type === 'sqs') queues.push({ name: r.name, service: svc.name });
        else if (r.type === 'sns') topics.push({ name: r.name, service: svc.name });
        else if (r.type === 's3') buckets.push({ name: r.name, service: svc.name });
      }
    }

    res.json({ tables, queues, topics, buckets });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export { router as resourcesRouter };
