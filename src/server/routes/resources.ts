import { Router, Request, Response } from 'express';
import { ResourceProvisioner } from '../services/resource-provisioner.js';

const router = Router();
const provisioner = ResourceProvisioner.getInstance();

// List all provisioned resources
router.get('/', async (_req: Request, res: Response) => {
  try {
    const resources = await provisioner.listAllResources();
    res.json(resources);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export { router as resourcesRouter };
