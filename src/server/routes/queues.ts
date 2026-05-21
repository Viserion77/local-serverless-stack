import { Router, Request, Response } from 'express';
import { QueueInspector } from '../services/queue-inspector.js';

const router = Router();
const inspector = QueueInspector.getInstance();

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

function getRegion(req: Request): string | undefined {
  const r = req.query.region;
  return typeof r === 'string' && r ? r : undefined;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const queues = await inspector.listQueues(getRegion(req));
    res.json(queues);
  } catch (error) {
    fail(res, error);
  }
});

router.get('/:name', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidName(name)) return fail(res, new Error('Invalid queue name'), 400);
  try {
    const queue = await inspector.getQueue(name, getRegion(req));
    if (!queue) return res.status(404).json({ error: 'Queue not found' });
    return res.json(queue);
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/:name/reset-processed', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidName(name)) return fail(res, new Error('Invalid queue name'), 400);
  try {
    inspector.resetProcessedCount(name);
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/:name/messages', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidName(name)) return fail(res, new Error('Invalid queue name'), 400);
  const { body, delaySeconds, messageAttributes, messageGroupId, messageDeduplicationId } =
    req.body ?? {};
  if (typeof body !== 'string' || !body.length) {
    return fail(res, new Error('body (string) is required'), 400);
  }
  if (delaySeconds !== undefined && (typeof delaySeconds !== 'number' || delaySeconds < 0 || delaySeconds > 900)) {
    return fail(res, new Error('delaySeconds must be between 0 and 900'), 400);
  }
  try {
    const result = await inspector.sendMessage(
      name,
      { body, delaySeconds, messageAttributes, messageGroupId, messageDeduplicationId },
      getRegion(req),
    );
    return res.json(result);
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/:name/messages/receive', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidName(name)) return fail(res, new Error('Invalid queue name'), 400);
  const { maxNumberOfMessages, visibilityTimeout, waitTimeSeconds } = req.body ?? {};
  try {
    const messages = await inspector.receiveMessages(
      name,
      { maxNumberOfMessages, visibilityTimeout, waitTimeSeconds },
      getRegion(req),
    );
    return res.json({ messages });
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/:name/messages/delete', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidName(name)) return fail(res, new Error('Invalid queue name'), 400);
  const { receiptHandle } = req.body ?? {};
  if (typeof receiptHandle !== 'string' || !receiptHandle) {
    return fail(res, new Error('receiptHandle (string) is required'), 400);
  }
  try {
    await inspector.deleteMessage(name, receiptHandle, getRegion(req));
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/:name/purge', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidName(name)) return fail(res, new Error('Invalid queue name'), 400);
  try {
    await inspector.purgeQueue(name, getRegion(req));
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, 400);
  }
});

export { router as queuesRouter };
