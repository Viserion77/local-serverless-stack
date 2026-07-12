import { Router, Request, Response } from 'express';
import { S3Explorer } from '../services/s3-explorer.js';

const router = Router();
const explorer = S3Explorer.getInstance();

// S3 bucket name rules are stricter than DNS, but the only constraints we enforce here
// are anti-traversal — actual validation happens server-side at LocalStack.
function isValidBucketName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 63 &&
    !name.includes('/') &&
    !name.includes('..') &&
    !name.includes('\\')
  );
}

function isValidObjectKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.includes('..');
}

function fail(res: Response, error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return res.status(status).json({ error: message });
}

function getRegion(req: Request): string | undefined {
  const r = req.query.region;
  return typeof r === 'string' && r ? r : undefined;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const buckets = await explorer.listBuckets(getRegion(req));
    res.json(buckets);
  } catch (error) {
    fail(res, error);
  }
});

router.get('/:name', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidBucketName(name)) return fail(res, new Error('Invalid bucket name'), 400);
  try {
    const bucket = await explorer.getBucket(name, getRegion(req));
    if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
    return res.json(bucket);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/:name/objects', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidBucketName(name)) return fail(res, new Error('Invalid bucket name'), 400);
  const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : undefined;
  const continuationToken =
    typeof req.query.continuationToken === 'string' ? req.query.continuationToken : undefined;
  const delimiter = typeof req.query.delimiter === 'string' ? req.query.delimiter : undefined;
  const maxKeysRaw = req.query.maxKeys;
  const maxKeys = typeof maxKeysRaw === 'string' ? parseInt(maxKeysRaw, 10) : undefined;
  try {
    const result = await explorer.listObjects(
      name,
      { prefix, continuationToken, maxKeys, delimiter },
      getRegion(req),
    );
    return res.json(result);
  } catch (error) {
    return fail(res, error);
  }
});

// Fetch the raw object body. Used by the UI to preview text or download files.
router.get('/:name/objects/content', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidBucketName(name)) return fail(res, new Error('Invalid bucket name'), 400);
  const key = req.query.key;
  if (!isValidObjectKey(key)) return fail(res, new Error('Invalid object key'), 400);
  try {
    const obj = await explorer.getObject(name, key, getRegion(req));
    if (!obj) return res.status(404).json({ error: 'Object not found' });

    // ?download=1 forces an attachment disposition; otherwise inline view.
    const wantDownload = req.query.download === '1' || req.query.download === 'true';
    if (obj.contentType) res.setHeader('Content-Type', obj.contentType);
    if (wantDownload) {
      const fname = key.split('/').pop() || 'download';
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    }
    res.setHeader('Content-Length', String(obj.size));
    return res.send(obj.body);
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/:name/objects', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidBucketName(name)) return fail(res, new Error('Invalid bucket name'), 400);
  const { key, body, contentType, encoding } = req.body ?? {};
  if (!isValidObjectKey(key)) return fail(res, new Error('key (string) is required'), 400);
  if (typeof body !== 'string') return fail(res, new Error('body (string) is required'), 400);

  // encoding="base64" lets the UI upload binary content via a JSON body.
  const payload = encoding === 'base64' ? Buffer.from(body, 'base64') : body;

  try {
    await explorer.putObject(name, { key, body: payload, contentType }, getRegion(req));
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.delete('/:name/objects', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidBucketName(name)) return fail(res, new Error('Invalid bucket name'), 400);
  const key = req.query.key;
  if (!isValidObjectKey(key)) return fail(res, new Error('Invalid object key'), 400);
  try {
    await explorer.deleteObject(name, key, getRegion(req));
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 400);
  }
});

export { router as bucketsRouter };
