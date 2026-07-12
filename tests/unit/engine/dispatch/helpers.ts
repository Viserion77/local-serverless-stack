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
  SelfEngineResolvedConfig,
} from '../../../../src/server/engine/types.js';

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
    cleanup: async () => {
      store.stopSweeper();
      await fs.promises.rm(dir, { recursive: true, force: true });
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

export async function waitFor(condition: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
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
