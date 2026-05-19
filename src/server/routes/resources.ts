import { Router, Request, Response } from 'express';
import { ResourceProvisioner } from '../services/resource-provisioner.js';

const router = Router();
const provisioner = ResourceProvisioner.getInstance();

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

export { router as resourcesRouter };
