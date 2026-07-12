import { Router, Request, Response } from 'express';
import { FunctionRegistry } from '../services/function-registry.js';
import { LambdaRuntimeManager } from '../services/lambda-runtime-manager.js';

const router = Router();

function describeFunction(ref: ReturnType<FunctionRegistry['listFunctions']>[number]) {
  const runtimeManager = LambdaRuntimeManager.getInstance();
  const info = runtimeManager.getRuntimeInfo(ref.service.name);
  const history = runtimeManager.getHistory(ref.service.name, ref.fn.name);
  const last = history[history.length - 1];
  return {
    name: ref.fn.name,
    fullName: ref.fn.fullName,
    service: ref.service.name,
    handler: ref.fn.handler,
    runtime: ref.fn.runtime,
    memorySize: ref.fn.memorySize,
    timeout: ref.fn.timeout,
    triggers: ref.fn.triggers,
    invokePort: ref.service.invokePort,
    status: info.status,
    executionMode: info.resolvedMode,
    invocations: history.length,
    errors: history.filter(h => !h.ok).length,
    lastInvokedAt: last?.at,
    lastDurationMs: last?.durationMs,
    lastOk: last?.ok,
  };
}

// List every registered function across services, with runtime status.
router.get('/', (_req: Request, res: Response) => {
  const refs = FunctionRegistry.getInstance().listFunctions();
  return res.json(refs.map(describeFunction));
});

// Function detail — accepts the short or fully qualified name.
router.get('/:name', (req: Request, res: Response) => {
  const ref = FunctionRegistry.getInstance().resolve(String(req.params.name));
  if (!ref) {
    return res.status(404).json({ error: `Function not found: ${req.params.name}` });
  }
  return res.json({
    ...describeFunction(ref),
    environment: ref.fn.environment,
    routes: ref.service.routes
      .filter(r => r.functionName === ref.fn.name)
      .map(r => ({ method: r.method, path: r.path, eventType: r.eventType, authorizerName: r.authorizerName })),
  });
});

// Invoke any registered function (UI / LssClient / tests). The AWS-compatible
// channel is the per-service invoke port; this one returns logs and duration.
router.post('/:name/invoke', async (req: Request, res: Response) => {
  try {
    const ref = FunctionRegistry.getInstance().resolve(String(req.params.name));
    if (!ref) {
      return res.status(404).json({ error: `Function not found: ${req.params.name}` });
    }
    const { payload, invocationType } = req.body || {};

    if (invocationType === 'Event') {
      void LambdaRuntimeManager.getInstance().invoke(ref.service.name, ref.fn, payload ?? {});
      return res.status(202).json({ accepted: true });
    }

    const result = await LambdaRuntimeManager.getInstance().invoke(ref.service.name, ref.fn, payload ?? {});
    return res.json({
      ok: result.ok,
      payload: result.payload,
      functionError: result.ok ? undefined : { errorType: result.errorType, errorMessage: result.errorMessage, trace: result.trace },
      logs: result.logs,
      durationMs: result.durationMs,
    });
  } catch (error) {
    console.error('Error invoking function:', error);
    return res.status(500).json({ error: 'Failed to invoke function' });
  }
});

// Recent invocations (with captured console output) for one function.
router.get('/:name/logs', (req: Request, res: Response) => {
  const ref = FunctionRegistry.getInstance().resolve(String(req.params.name));
  if (!ref) {
    return res.status(404).json({ error: `Function not found: ${req.params.name}` });
  }
  const history = LambdaRuntimeManager.getInstance().getHistory(ref.service.name, ref.fn.name);
  return res.json({ invocations: history });
});

export { router as lambdasRouter };
