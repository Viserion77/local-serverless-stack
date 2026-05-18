import { Router, Request, Response } from 'express';
import { DynamoExplorer } from '../services/dynamo-explorer.js';

const router = Router();
const explorer = DynamoExplorer.getInstance();

function isValidName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes('/') &&
    !name.includes('..') &&
    !name.includes('\\')
  );
}

function fail(res: Response, error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return res.status(status).json({ error: message });
}

router.get('/tables', async (_req: Request, res: Response) => {
  try {
    const tables = await explorer.listTables();
    res.json({ tables });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/tables/:name', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  try {
    const detail = await explorer.describeTable(name);
    if (!detail) return res.status(404).json({ error: 'Table not found' });
    return res.json(detail);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/tables/:name/ttl', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  try {
    return res.json(await explorer.describeTtl(name));
  } catch (error) {
    return fail(res, error);
  }
});

router.put('/tables/:name/ttl', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  const { enabled, attributeName } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    return fail(res, new Error('enabled (boolean) is required'), 400);
  }
  try {
    return res.json(await explorer.setTtl(name, enabled, attributeName));
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/tables/:name/scan', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  try {
    return res.json(await explorer.scan(name, req.body ?? {}));
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/tables/:name/query', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  try {
    return res.json(await explorer.query(name, req.body ?? {}));
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/tables/:name/items/get', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  const { key } = req.body ?? {};
  if (!key || typeof key !== 'object') return fail(res, new Error('key is required'), 400);
  try {
    const item = await explorer.getItem(name, key);
    return res.json({ item });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/tables/:name/items', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  const { item } = req.body ?? {};
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return fail(res, new Error('item must be a plain object'), 400);
  }
  try {
    await explorer.putItem(name, item);
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/tables/:name/items/delete', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidName(name)) return fail(res, new Error('Invalid table name'), 400);
  const { key } = req.body ?? {};
  if (!key || typeof key !== 'object') return fail(res, new Error('key is required'), 400);
  try {
    await explorer.deleteItem(name, key);
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 400);
  }
});

export { router as dynamoRouter };
