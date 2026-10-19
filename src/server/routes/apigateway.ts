import { Router, Request, Response } from 'express';
import { ApiGatewayExplorer } from '../services/apigateway-explorer.js';

const router = Router();
const explorer = ApiGatewayExplorer.getInstance();

// API key ids are short alphanumerics (10 characters on the engine, like AWS);
// anything else is rejected before it reaches the control plane, so a crafted
// id can never re-shape the upstream path.
function isValidKeyId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function fail(res: Response, error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return res.status(status).json({ error: message });
}

function getRegion(req: Request): string | undefined {
  const r = req.query.region;
  return typeof r === 'string' && r ? r : undefined;
}

// Keys WITHOUT their values, each with the usage plans holding it.
router.get('/keys', async (req: Request, res: Response) => {
  try {
    const keys = await explorer.listApiKeys(getRegion(req));
    res.json({ keys });
  } catch (error) {
    fail(res, error);
  }
});

// Reveals one key's value — a distinct endpoint so a plain list never carries
// key material.
router.get('/keys/:id/value', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isValidKeyId(id)) return fail(res, new Error('Invalid API key id'), 400);
  try {
    const value = await explorer.getApiKeyValue(id, getRegion(req));
    if (!value) return res.status(404).json({ error: 'API key not found' });
    return res.json(value);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/plans', async (req: Request, res: Response) => {
  try {
    const plans = await explorer.listUsagePlans(getRegion(req));
    res.json({ plans });
  } catch (error) {
    fail(res, error);
  }
});

export { router as apiGatewayRouter };
