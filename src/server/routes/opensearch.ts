import { Router, Request, Response } from 'express';
import { OpenSearchExplorer, OpenSearchDataPlaneError } from '../services/opensearch-explorer.js';

const router = Router();
const explorer = OpenSearchExplorer.getInstance();

// AOSS collection names are 3-32 lowercase chars, but the only constraints
// enforced here are anti-traversal — actual validation happens at the aoss
// data plane.
function isValidCollectionName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 32 &&
    !name.includes('/') &&
    !name.includes('..') &&
    !name.includes('\\')
  );
}

function fail(res: Response, error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return res.status(status).json({ error: message });
}

// Data-plane failures keep their upstream 4xx status — 404 for an unknown
// collection (the documented contract choice), 400 for a bad query DSL — and
// upstream 5xx surfaces as 502, since the failure belongs to the emulator,
// not this API. Everything else is a plain 500.
function failDataPlane(res: Response, error: unknown): Response {
  if (error instanceof OpenSearchDataPlaneError) {
    return fail(res, error, error.status < 500 ? error.status : 502);
  }
  return fail(res, error);
}

function getRegion(req: Request): string | undefined {
  const r = req.query.region;
  return typeof r === 'string' && r ? r : undefined;
}

router.get('/collections', async (req: Request, res: Response) => {
  try {
    const collections = await explorer.listCollections(getRegion(req));
    res.json({ collections });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/collections/:name/indices', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidCollectionName(name)) return fail(res, new Error('Invalid collection name'), 400);
  try {
    const indices = await explorer.listIndices(name, getRegion(req));
    return res.json({ indices });
  } catch (error) {
    return failDataPlane(res, error);
  }
});

router.post('/collections/:name/search', async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!isValidCollectionName(name)) return fail(res, new Error('Invalid collection name'), 400);
  const { index, q, query, from, size } = req.body ?? {};
  try {
    // The raw OpenSearch _search response is passed through verbatim.
    return res.json(await explorer.search(name, { index, q, query, from, size }, getRegion(req)));
  } catch (error) {
    return failDataPlane(res, error);
  }
});

export { router as opensearchRouter };
