import { Router, Request, Response } from 'express';
import { QueueInspector } from '../services/queue-inspector.js';

const router = Router();
const inspector = QueueInspector.getInstance();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const queues = await inspector.listQueues();
    res.json(queues);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list queues';
    res.status(500).json({ error: message });
  }
});

router.get('/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name;
    if (!name || typeof name !== 'string' || name.includes('/') || name.includes('..')) {
      return res.status(400).json({ error: 'Invalid queue name' });
    }
    const queue = await inspector.getQueue(name);
    if (!queue) {
      return res.status(404).json({ error: 'Queue not found' });
    }
    return res.json(queue);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch queue';
    return res.status(500).json({ error: message });
  }
});

router.post('/:name/reset-processed', async (req: Request, res: Response) => {
  try {
    const name = req.params.name;
    if (!name || typeof name !== 'string' || name.includes('/') || name.includes('..')) {
      return res.status(400).json({ error: 'Invalid queue name' });
    }
    inspector.resetProcessedCount(name);
    return res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reset counter';
    return res.status(500).json({ error: message });
  }
});

export { router as queuesRouter };
