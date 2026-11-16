import { Router, Request, Response } from 'express';
import { CacheManager } from '../services/cache-manager.js';
import { CloudFormationParser } from '../services/cloudformation-parser.js';
import { buildServiceGraph, type ServiceGraph } from '../services/service-graph.js';
import { buildStackGraph, resolveExpansion } from '../services/stack-graph.js';

// The whole stack's wiring — every registered service on one map, with the
// cross-service references resolved. Like the per-service graph it is derived
// from the cached templates plus registration metadata only, never from the
// live engine, so a stopped service is drawn exactly like a running one.
const router = Router();
const cache = new CacheManager();
const parser = new CloudFormationParser();

let cacheInitialized = false;
async function ensureCacheInit() {
  if (!cacheInitialized) {
    await cache.init();
    cacheInitialized = true;
  }
}

// GET /api/stack/graph[?expand=a,b | *]
router.get('/graph', async (req: Request, res: Response) => {
  try {
    await ensureCacheInit();
    const services = await cache.listServices();
    const graphs: ServiceGraph[] = [];
    for (const metadata of services) {
      const template = await cache.getTemplate(metadata.name);
      // A registered service with nothing cached is still a service: it gets
      // an empty graph and says why, the same answer the per-service route
      // gives, rather than vanishing from the map.
      if (!template) {
        graphs.push({
          service: metadata.name,
          nodes: [],
          edges: [],
          edgeKinds: [],
          warnings: ['No cached CloudFormation template for this service'],
        });
        continue;
      }
      graphs.push(buildServiceGraph({
        serviceName: metadata.name,
        template,
        resources: parser.parse(template),
        region: metadata.region,
        functions: metadata.functions,
        routes: metadata.routes,
        authorizers: metadata.authorizers,
        webFunctions: metadata.webFunctions,
      }));
    }
    const expand = typeof req.query.expand === 'string' ? req.query.expand : undefined;
    return res.json(buildStackGraph(graphs, resolveExpansion(services.map(s => s.name), expand)));
  } catch (error) {
    console.error('Error building stack graph:', error);
    return res.status(500).json({ error: 'Failed to build stack graph' });
  }
});

export { router as stackRouter };
