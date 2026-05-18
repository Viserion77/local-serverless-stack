import { Router, Request, Response } from 'express';
import { SeedManager } from '../services/seed-manager.js';
import { ConfigManager } from '../services/config-manager.js';

const router = Router();
const seeds = SeedManager.getInstance();

function isValidTableName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('..') &&
    !name.includes('\\')
  );
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const entries = await seeds.list();
    res.json({
      seedsDir: ConfigManager.getInstance().getSeedsDir(),
      entries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list seeds';
    res.status(500).json({ error: message });
  }
});

router.post('/run', async (req: Request, res: Response) => {
  try {
    const { tableName } = req.body ?? {};
    if (tableName !== undefined && !isValidTableName(tableName)) {
      return res.status(400).json({ error: 'Invalid tableName' });
    }
    const result = tableName
      ? [await seeds.seedTable(tableName)]
      : await seeds.seedAll();
    return res.json({ results: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run seeds';
    return res.status(500).json({ error: message });
  }
});

router.post('/clear', async (req: Request, res: Response) => {
  try {
    const { tableName } = req.body ?? {};
    if (tableName !== undefined && !isValidTableName(tableName)) {
      return res.status(400).json({ error: 'Invalid tableName' });
    }
    const result = tableName
      ? [await seeds.clearTable(tableName)]
      : await seeds.clearAllSeeded();
    return res.json({ results: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clear seeds';
    return res.status(500).json({ error: message });
  }
});

export { router as seedsRouter };
