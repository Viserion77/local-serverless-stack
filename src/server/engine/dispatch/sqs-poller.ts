// SQS → Lambda event source mapping delivery. One DeliveryLoop per ENABLED
// ESM whose eventSourceArn is an SQS queue. Event-driven (PRD RF4.3): the loop
// wakes on the engine bus 'sqs:message-visible' event for its queue — never a
// busy poll — plus a 1 s unref'd safety tick armed only while a batch might be
// in flight. Delivery semantics are AWS's: success deletes the batch, failure
// leaves it to the visibility timeout (no retry machinery of our own), and
// only 'RuntimeUnavailable' (worker restarting) retries the same batch with a
// capped backoff.

import type { EngineContext, EngineEventSourceMappingRecord, EngineInvokeResult, SqsMessageVisibleEvent } from '../types.js';
import type { DeliveredMessage, SqsEmulator } from '../emulators/sqs/index.js';
import { queueNameFromArn } from '../emulators/sqs/index.js';
import type { LambdaCtlEmulator } from '../emulators/lambda-ctl/index.js';

export type InvokeFn = (ref: string, event: unknown, opts?: { async?: boolean }) => Promise<EngineInvokeResult>;

export interface SqsPollerDeps {
  ctx: EngineContext;
  sqs: SqsEmulator;
  lambdaCtl: LambdaCtlEmulator;
  invoke: InvokeFn;
  // Test hook: RuntimeUnavailable retry backoffs (defaults 1 s, 2 s, 4 s).
  runtimeRetryBackoffMs?: number[];
}

const DEFAULT_RUNTIME_RETRY_BACKOFF_MS = [1000, 2000, 4000];
const SAFETY_TICK_MS = 1000;

// The Lambda SQS event for one delivered batch. Message attributes use the
// lowercase keys real AWS Lambda events carry (aws-lambda's SQSRecord shape).
export function buildSqsLambdaEvent(
  batch: DeliveredMessage[],
  eventSourceArn: string,
  region: string,
): { Records: Record<string, unknown>[] } {
  return {
    Records: batch.map(message => {
      const attributes: Record<string, string> = {
        ApproximateReceiveCount: String(message.approximateReceiveCount),
        SentTimestamp: String(message.sentTimestamp),
        SenderId: 'AIDASELFENGINE',
        ApproximateFirstReceiveTimestamp:
          message.attributes.ApproximateFirstReceiveTimestamp ?? String(message.sentTimestamp),
      };
      if (message.messageGroupId !== undefined) attributes.MessageGroupId = message.messageGroupId;
      if (message.sequenceNumber !== undefined) attributes.SequenceNumber = message.sequenceNumber;
      if (message.attributes.MessageDeduplicationId !== undefined) {
        attributes.MessageDeduplicationId = message.attributes.MessageDeduplicationId;
      }
      const messageAttributes: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(message.messageAttributes)) {
        messageAttributes[name] = {
          ...(value.StringValue !== undefined ? { stringValue: value.StringValue } : {}),
          ...(value.BinaryValue !== undefined ? { binaryValue: value.BinaryValue } : {}),
          stringListValues: [],
          binaryListValues: [],
          dataType: value.DataType,
        };
      }
      return {
        messageId: message.messageId,
        receiptHandle: message.receiptHandle,
        body: message.body,
        attributes,
        messageAttributes,
        md5OfBody: message.md5OfBody,
        eventSource: 'aws:sqs',
        eventSourceARN: eventSourceArn,
        awsRegion: region,
      };
    }),
  };
}

class DeliveryLoop {
  readonly region: string;
  readonly queueName: string;

  private esm: EngineEventSourceMappingRecord;
  private readonly deps: SqsPollerDeps;
  private stopped = false;
  private delivering = false;
  private pending = false;
  // Set after a failed delivery: the batch is waiting out its visibility
  // timeout, so the safety tick stays armed until redelivery succeeds.
  private awaitingRedelivery = false;
  private tick: NodeJS.Timeout | null = null;
  private windowWaiter: (() => void) | null = null;
  private readonly busListener: (payload: SqsMessageVisibleEvent) => void;

  constructor(deps: SqsPollerDeps, esm: EngineEventSourceMappingRecord, region: string) {
    this.deps = deps;
    this.esm = esm;
    this.region = region;
    this.queueName = queueNameFromArn(esm.eventSourceArn);
    this.busListener = payload => {
      if (payload.region === this.region && payload.queueName === this.queueName) this.wake();
    };
  }

  start(): void {
    this.deps.ctx.bus.on('sqs:message-visible', this.busListener);
    // Drain anything already visible (boot rearm, restored snapshots).
    this.wake();
  }

  update(esm: EngineEventSourceMappingRecord): void {
    this.esm = esm;
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.deps.ctx.bus.off('sqs:message-visible', this.busListener);
    this.clearTick();
    this.windowWaiter?.();
  }

  wake(): void {
    if (this.stopped || !this.esm.enabled) return;
    if (this.delivering) {
      this.pending = true;
      // Interrupt a batching-window wait so new arrivals join the batch now.
      this.windowWaiter?.();
      return;
    }
    this.delivering = true;
    void this.run().catch(err => {
      console.warn(`[engine-sqs-poller] delivery loop for ${this.queueName} crashed:`, err);
      this.delivering = false;
    });
  }

  // Single-flight drain: one batch in flight per ESM; wakes during a batch
  // mark `pending` and the loop re-checks before going idle.
  private async run(): Promise<void> {
    do {
      this.pending = false;
      while (!this.stopped && this.esm.enabled && this.deps.sqs.hasVisibleMessages(this.region, this.queueName)) {
        const progressed = await this.deliverBatch();
        if (!progressed) break; // paranoia: never hot-loop on an empty receive
      }
    } while (this.pending && !this.stopped && this.esm.enabled);
    this.delivering = false;
    if (!this.awaitingRedelivery) this.clearTick();
  }

  private async deliverBatch(): Promise<boolean> {
    const batchSize = this.esm.batchSize;
    let batch = this.deps.sqs.receiveForDelivery(this.region, this.queueName, batchSize);
    if (batch.length === 0) return false;

    // maximumBatchingWindowInSeconds: with a short batch, wait (once) up to
    // the window for more messages — but never delay a full batch.
    const windowMs = (this.esm.maximumBatchingWindowInSeconds ?? 0) * 1000;
    if (windowMs > 0 && batch.length < batchSize) {
      const deadline = Date.now() + windowMs;
      while (batch.length < batchSize && !this.stopped) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await this.waitForWake(remaining);
        if (this.stopped) break;
        batch = batch.concat(this.deps.sqs.receiveForDelivery(this.region, this.queueName, batchSize - batch.length));
      }
    }
    if (this.stopped) return true; // in-flight messages redeliver via visibility

    this.armTick();
    const event = buildSqsLambdaEvent(batch, this.esm.eventSourceArn, this.region);
    const backoffs = this.deps.runtimeRetryBackoffMs ?? DEFAULT_RUNTIME_RETRY_BACKOFF_MS;
    let attempt = 0;
    for (;;) {
      const result = await this.deps.invoke(this.esm.functionName, event);
      if (result.ok) {
        this.deps.sqs.deleteDelivered(
          this.region,
          this.queueName,
          batch.map(message => message.receiptHandle),
        );
        this.awaitingRedelivery = false;
        return true;
      }
      if (result.errorType === 'RuntimeUnavailable' && attempt < backoffs.length && !this.stopped) {
        await sleep(backoffs[attempt]);
        attempt += 1;
        continue;
      }
      // AWS semantics: the batch is NOT deleted; visibility expiry redelivers.
      this.awaitingRedelivery = true;
      return true;
    }
  }

  private waitForWake(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.windowWaiter = null;
        resolve();
      }, ms);
      timer.unref();
      this.windowWaiter = () => {
        clearTimeout(timer);
        this.windowWaiter = null;
        resolve();
      };
    });
  }

  private armTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => this.wake(), SAFETY_TICK_MS);
    this.tick.unref();
  }

  private clearTick(): void {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }
}

// Owns every SQS delivery loop; sync() reconciles them against the current
// ESM catalog (called at boot and from lambda-ctl's onEsmChanged hook).
export class SqsPollerSet {
  private readonly deps: SqsPollerDeps;
  private readonly loops = new Map<string, DeliveryLoop>();

  constructor(deps: SqsPollerDeps) {
    this.deps = deps;
  }

  sync(region: string): void {
    const alive = new Set<string>();
    for (const esm of this.deps.lambdaCtl.listEventSourceMappings(region)) {
      if (!esm.eventSourceArn.startsWith('arn:aws:sqs:')) continue;
      // Enabled=false is the QueueInspector hold: its loop must stop promptly.
      if (!esm.enabled) continue;
      alive.add(esm.uuid);
      const existing = this.loops.get(esm.uuid);
      if (existing) {
        existing.update(esm);
      } else {
        const loop = new DeliveryLoop(this.deps, esm, region);
        this.loops.set(esm.uuid, loop);
        loop.start();
      }
    }
    for (const [uuid, loop] of this.loops) {
      if (loop.region === region && !alive.has(uuid)) {
        loop.stop();
        this.loops.delete(uuid);
      }
    }
  }

  stopAll(): void {
    for (const loop of this.loops.values()) loop.stop();
    this.loops.clear();
  }

  loopCount(): number {
    return this.loops.size;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
