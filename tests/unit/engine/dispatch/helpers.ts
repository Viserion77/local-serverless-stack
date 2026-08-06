// Shared fixtures for the dispatch-layer tests: a real EngineStore on a
// mkdtemp dir (the store module is battle-tested by its own suite), synthetic
// AwsRequests for driving emulators directly, and small async test utilities.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { createEngineStore } from '../../../../src/server/engine/store/engine-store.js';
import { EngineBus } from '../../../../src/server/engine/bus.js';
import type {
  AwsRequest,
  EngineContext,
  EngineInvokeResult,
  EventRuleTarget,
  SelfEngineResolvedConfig,
} from '../../../../src/server/engine/types.js';
import { resolveTargetInput } from '../../../../src/server/engine/dispatch/scheduler.js';

export interface TestEngineContext {
  ctx: EngineContext;
  dir: string;
  cleanup(): Promise<void>;
}

export function makeCtx(overrides: Partial<SelfEngineResolvedConfig> = {}): TestEngineContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-engine-dispatch-'));
  const store = createEngineStore({ dataDir: dir, idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false });
  const bus = new EngineBus();
  const ctx: EngineContext = {
    config: {
      port: 14566,
      dataDir: dir,
      account: '000000000000',
      region: 'us-east-1',
      idleUnloadMs: 300_000,
      memoryBudgetMb: 64,
      fsync: false,
      fallbackEndpoint: null,
      persistence: false,
      ...overrides,
    },
    store,
    bus,
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://localhost:14566',
  };
  return {
    ctx,
    dir,
    // Root cause of the intermittent `ENOTEMPTY: rmdir '/tmp/lss-engine-dispatch-*'`:
    // catalog writes are debounced (20 ms) and WAL appends are buffered, so the
    // old cleanup raced the store — rm walked the tree while a flush was still
    // creating files in it. flushAll() drains both; the retry covers the tail a
    // dispatch loop's synchronous stop() can still emit under parallel load.
    cleanup: async () => {
      store.stopSweeper();
      await store.flushAll();
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.promises.rm(dir, { recursive: true, force: true });
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt >= 4) throw err;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    },
  };
}

export function awsReq(region = 'us-east-1', partial: Partial<AwsRequest> = {}): AwsRequest {
  return {
    method: 'POST',
    rawPath: '/',
    query: {},
    headers: {},
    body: Buffer.alloc(0),
    service: undefined,
    region,
    requestId: randomUUID(),
    ...partial,
  };
}

export function jsonReq(region: string, method: string, rawPath: string, payload?: unknown): AwsRequest {
  return awsReq(region, {
    method,
    rawPath,
    body: payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload)),
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll `condition` until it holds, or fail with `label` at the deadline.
 *
 * The predicate may be async, and it MUST be awaited: several callers pass one
 * that reads the queue counters over the wire. Before this signature they were
 * typed `() => boolean`, so `!condition()` negated a *Promise* — always truthy,
 * so the loop exited on the first check and the wait quietly waited for
 * nothing. The assertions that followed then read whatever state happened to
 * exist. The type error was the symptom; this is the bug it was hiding.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

export interface InvokeCall {
  ref: string;
  event: unknown;
  opts?: { async?: boolean };
}

// Recording invoke stub whose per-call results are scripted by `plan` (last
// entry repeats once the plan is exhausted).
export function makeInvokeStub(plan: EngineInvokeResult[] = [{ ok: true }]): {
  calls: InvokeCall[];
  invoke: (ref: string, event: unknown, opts?: { async?: boolean }) => Promise<EngineInvokeResult>;
} {
  const calls: InvokeCall[] = [];
  return {
    calls,
    invoke: async (ref, event, opts) => {
      const result = plan[Math.min(calls.length, plan.length - 1)];
      calls.push({ ref, event, opts });
      return result;
    },
  };
}

export interface DeliverCall {
  target: EventRuleTarget;
  envelope: Record<string, unknown>;
  sourceLabel: string;
  // Convenience projections for assertions.
  arn: string;
  event: unknown;
}

// Recording stub for the scheduler's `deliverToTarget` dependency — the
// scheduler now delegates per-target delivery here, so a test can assert what
// each rule fired without mocking the Lambda/SQS delivery mechanism.
export function makeDeliverStub(): {
  calls: DeliverCall[];
  deliverToTarget: (target: EventRuleTarget, envelope: Record<string, unknown>, sourceLabel: string) => void;
} {
  const calls: DeliverCall[] = [];
  return {
    calls,
    deliverToTarget: (target, envelope, sourceLabel) => {
      calls.push({ target, envelope, sourceLabel, arn: target.arn, event: resolveTargetInput(target, envelope) });
    },
  };
}
