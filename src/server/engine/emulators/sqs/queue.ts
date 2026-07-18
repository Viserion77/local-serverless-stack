// In-memory SQS queue state machine: visibility timeouts, delivery delays,
// FIFO group serialization and the 5-minute dedup window. Messages are
// transient dev data — persistence is a graceful-shutdown snapshot via
// serialize()/restore() (see SqsEmulator.serializeMessages).
//
// Timer discipline: ONE unref'd timer per queue, armed to the nearest future
// deadline (delay expiry or visibility expiry). Adding an earlier deadline
// re-arms; removals leave the timer to fire spuriously and re-scan — the
// fire path is the only O(n) walk.

import crypto from 'crypto';
import { md5OfMessageAttributes, md5OfMessageBody } from './md5.js';
import type { SqsMessageAttributeValue } from './md5.js';

export const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;

// FIFO SequenceNumber base: AWS issues 20-digit monotonic values; we mimic
// the magnitude so string comparisons in app code behave sensibly.
const SEQUENCE_BASE = 18849496460467900000n;

export interface StoredMessage {
  messageId: string;
  body: string;
  md5OfBody: string;
  messageAttributes?: Record<string, SqsMessageAttributeValue>;
  md5OfMessageAttributes?: string;
  // Both timestamps in epoch milliseconds.
  sentTimestamp: number;
  firstReceiveTimestamp?: number;
  // Arrival order; `visible` stays sorted by it so requeued messages return
  // to their original position (strict order within FIFO groups).
  order: number;
  receiveCount: number;
  // When the message becomes (or became) visible: delay deadline before the
  // first receive, visibility deadline while in flight.
  visibleAt: number;
  receiptHandle?: string;
  messageGroupId?: string;
  messageDeduplicationId?: string;
  sequenceNumber?: string;
}

export interface SendMessageOptions {
  body: string;
  delayMs: number;
  messageAttributes?: Record<string, SqsMessageAttributeValue>;
  messageGroupId?: string;
  messageDeduplicationId?: string;
  contentBasedDeduplication?: boolean;
}

export interface SendMessageOutcome {
  messageId: string;
  md5OfBody: string;
  md5OfMessageAttributes?: string;
  sequenceNumber?: string;
  // True when the FIFO dedup window matched: messageId/sequenceNumber are the
  // ORIGINAL message's and nothing was enqueued.
  deduplicated: boolean;
}

export interface ReceiveOptions {
  max: number;
  visibilityMs: number;
  retentionMs: number;
}

export interface QueueCounters {
  available: number;
  inFlight: number;
  delayed: number;
}

interface DedupEntry {
  messageId: string;
  sequenceNumber?: string;
  expiresAt: number;
}

export interface SerializedQueueMessages {
  messages: StoredMessage[];
  orderCounter: number;
  sequenceCounter: number;
  dedup: Array<{ id: string } & DedupEntry>;
}

export type DeleteMessageResult = 'deleted' | 'stale' | 'invalid';
export type ChangeVisibilityResult = 'changed' | 'not-inflight' | 'invalid';

export interface SqsQueueOptions {
  fifo?: boolean;
  // Fired whenever at least one message becomes visible (arrival, delay
  // expiry, visibility expiry, requeue) or a FIFO group with pending visible
  // messages unlocks — the emulator forwards it to the engine bus. Parked
  // long-polls are woken internally on the same transitions.
  onVisible?: () => void;
  dedupWindowMs?: number;
  // Queue-level redrive (the RedrivePolicy attribute). See RedriveResolver.
  redrive?: RedriveResolver;
}

// The queue's RedrivePolicy attribute, already decoded from its JSON string.
export interface RedrivePolicy {
  deadLetterTargetArn: string;
  maxReceiveCount: number;
}

// What a queue needs in order to redrive: the threshold plus a way to hand the
// poison message over. The DLQ lookup lives in the emulator (only it knows the
// catalog); the queue owns the "has it failed enough times?" decision.
export interface RedriveTarget {
  maxReceiveCount: number;
  move: (message: StoredMessage) => void;
}

// Re-resolved on EVERY redelivery rather than cached: the dead-letter queue is
// frequently declared AFTER the queue that points at it (CloudFormation
// template order), and SetQueueAttributes can add or replace the policy at any
// time. Returning undefined means "no redrive" — a missing policy, a malformed
// one, or a DLQ that cannot be resolved.
export type RedriveResolver = () => RedriveTarget | undefined;

// Decode the RedrivePolicy queue attribute, which travels as a JSON *string*:
// `{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:0:dlq","maxReceiveCount":3}`.
// Anything malformed yields undefined (redrive simply stays off) instead of
// throwing — a bad policy must never break SendMessage/ReceiveMessage on the
// queue that carries it. maxReceiveCount is accepted as a number or a numeric
// string, because both shapes occur in the wild (console/CDK/CFN emit either).
export function parseRedrivePolicy(raw: string | undefined): RedrivePolicy | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const policy = parsed as Record<string, unknown>;
  const arn = typeof policy.deadLetterTargetArn === 'string' ? policy.deadLetterTargetArn : '';
  const maxReceiveCount = Math.trunc(Number(policy.maxReceiveCount));
  if (!arn || !Number.isFinite(maxReceiveCount) || maxReceiveCount < 1) return undefined;
  return { deadLetterTargetArn: arn, maxReceiveCount };
}

export class SqsQueue {
  readonly name: string;
  readonly fifo: boolean;

  private visible: StoredMessage[] = [];
  private delayed = new Map<string, StoredMessage>();
  private inflight = new Map<string, StoredMessage>();
  // FIFO: messageGroupId -> number of in-flight messages. A group with any
  // in-flight message yields no further messages ("one in-flight batch per
  // group") until they are deleted or become visible again.
  private groupLocks = new Map<string, number>();
  // Insertion-ordered (constant window => expiry-ordered), pruned from the
  // front on each send.
  private dedup = new Map<string, DedupEntry>();
  private waiters = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Infinity;
  private orderCounter = 0;
  private sequenceCounter = 0;
  private readonly onVisible: () => void;
  private readonly dedupWindowMs: number;
  private readonly redrive: RedriveResolver;

  constructor(name: string, options: SqsQueueOptions = {}) {
    this.name = name;
    this.fifo = options.fifo ?? name.endsWith('.fifo');
    this.onVisible = options.onVisible ?? (() => undefined);
    this.dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.redrive = options.redrive ?? (() => undefined);
  }

  send(options: SendMessageOptions): SendMessageOutcome {
    const now = Date.now();
    const md5Body = md5OfMessageBody(options.body);
    const md5Attributes =
      options.messageAttributes && Object.keys(options.messageAttributes).length > 0
        ? md5OfMessageAttributes(options.messageAttributes)
        : undefined;

    let deduplicationId = options.messageDeduplicationId;
    if (this.fifo && !deduplicationId && options.contentBasedDeduplication) {
      deduplicationId = crypto.createHash('sha256').update(options.body, 'utf8').digest('hex');
    }
    if (this.fifo && deduplicationId) {
      this.pruneDedup(now);
      const hit = this.dedup.get(deduplicationId);
      if (hit) {
        return {
          messageId: hit.messageId,
          md5OfBody: md5Body,
          md5OfMessageAttributes: md5Attributes,
          sequenceNumber: hit.sequenceNumber,
          deduplicated: true,
        };
      }
    }

    const message: StoredMessage = {
      messageId: crypto.randomUUID(),
      body: options.body,
      md5OfBody: md5Body,
      messageAttributes: options.messageAttributes,
      md5OfMessageAttributes: md5Attributes,
      sentTimestamp: now,
      order: ++this.orderCounter,
      receiveCount: 0,
      visibleAt: now + Math.max(0, options.delayMs),
      messageGroupId: options.messageGroupId,
      messageDeduplicationId: deduplicationId,
      sequenceNumber: this.fifo
        ? (SEQUENCE_BASE + BigInt(++this.sequenceCounter)).toString()
        : undefined,
    };

    if (this.fifo && deduplicationId) {
      this.dedup.set(deduplicationId, {
        messageId: message.messageId,
        sequenceNumber: message.sequenceNumber,
        expiresAt: now + this.dedupWindowMs,
      });
    }

    if (options.delayMs > 0) {
      this.delayed.set(message.messageId, message);
      this.addDeadline(message.visibleAt);
    } else {
      this.insertVisible(message);
      this.notifyVisible();
    }

    return {
      messageId: message.messageId,
      md5OfBody: md5Body,
      md5OfMessageAttributes: md5Attributes,
      sequenceNumber: message.sequenceNumber,
      deduplicated: false,
    };
  }

  // Returns the delivered messages with a fresh receiptHandle assigned and
  // receive counters updated; the caller shapes the wire response.
  receive(options: ReceiveOptions): StoredMessage[] {
    const now = Date.now();
    this.pruneRetention(now, options.retentionMs);

    const blockedGroups = new Set<string>();
    if (this.fifo) {
      for (const [group, locks] of this.groupLocks) {
        if (locks > 0) blockedGroups.add(group);
      }
    }

    const taken: StoredMessage[] = [];
    for (const message of this.visible) {
      // Locked FIFO groups are skipped entirely — and skipping one message of
      // a group blocks the rest of that group to preserve in-group order.
      if (this.fifo && message.messageGroupId && blockedGroups.has(message.messageGroupId)) {
        continue;
      }
      taken.push(message);
      if (taken.length >= options.max) break;
    }
    if (taken.length === 0) return [];

    const takenIds = new Set(taken.map(message => message.messageId));
    this.visible = this.visible.filter(message => !takenIds.has(message.messageId));

    for (const message of taken) {
      message.receiveCount += 1;
      message.firstReceiveTimestamp ??= now;
      message.visibleAt = now + options.visibilityMs;
      message.receiptHandle = this.newReceiptHandle(message.messageId);
      this.inflight.set(message.receiptHandle, message);
      if (this.fifo && message.messageGroupId) {
        this.groupLocks.set(
          message.messageGroupId,
          (this.groupLocks.get(message.messageGroupId) ?? 0) + 1,
        );
      }
      this.addDeadline(message.visibleAt);
    }
    return taken;
  }

  // Deleting with a well-formed handle that is no longer in flight is a
  // silent success ('stale'), matching AWS's idempotent DeleteMessage.
  deleteMessage(receiptHandle: string): DeleteMessageResult {
    const message = this.inflight.get(receiptHandle);
    if (!message) {
      return this.isOwnHandle(receiptHandle) ? 'stale' : 'invalid';
    }
    this.inflight.delete(receiptHandle);
    message.receiptHandle = undefined;
    this.unlockGroup(message);
    return 'deleted';
  }

  changeVisibility(receiptHandle: string, visibilityMs: number): ChangeVisibilityResult {
    const message = this.inflight.get(receiptHandle);
    if (!message) {
      return this.isOwnHandle(receiptHandle) ? 'not-inflight' : 'invalid';
    }
    if (visibilityMs <= 0) {
      this.inflight.delete(receiptHandle);
      this.requeue(message);
      this.notifyVisible();
      return 'changed';
    }
    message.visibleAt = Date.now() + visibilityMs;
    this.addDeadline(message.visibleAt);
    return 'changed';
  }

  counters(retentionMs: number): QueueCounters {
    this.pruneRetention(Date.now(), retentionMs);
    return {
      available: this.visible.length,
      inFlight: this.inflight.size,
      delayed: this.delayed.size,
    };
  }

  // True when a receive() right now would deliver at least one message (i.e.
  // some visible message belongs to no locked FIFO group).
  hasDeliverable(retentionMs: number): boolean {
    this.pruneRetention(Date.now(), retentionMs);
    if (!this.fifo) return this.visible.length > 0;
    return this.visible.some(
      message =>
        !message.messageGroupId || (this.groupLocks.get(message.messageGroupId) ?? 0) === 0,
    );
  }

  // Park until a message becomes visible (or deliverable again) or the
  // timeout elapses — the long-poll primitive. Resolved by notifyVisible(),
  // never by polling.
  waitForVisible(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const waiter = (): void => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(waiter, Math.max(0, timeoutMs));
      this.waiters.add(waiter);
    });
  }

  // Take in a message moved here by a SOURCE queue's RedrivePolicy.
  //
  // AWS preserves the identity of a redriven message: MessageId, body,
  // MessageAttributes and both MD5 digests survive the move, and so does the
  // original SentTimestamp (dead-letter retention is measured from the first
  // enqueue, not from the move). Delivery bookkeeping is per-queue, so the
  // receive counters reset and this queue issues a fresh arrival order — plus a
  // fresh SequenceNumber when it is FIFO (and none at all when the DLQ is a
  // standard queue fed by a FIFO source).
  //
  // The move deliberately bypasses the dedup window: a poison message must
  // never be silently dropped on its way to the dead-letter queue.
  acceptRedriven(message: StoredMessage): void {
    this.insertVisible({
      ...message,
      order: ++this.orderCounter,
      receiveCount: 0,
      firstReceiveTimestamp: undefined,
      receiptHandle: undefined,
      visibleAt: Date.now(),
      sequenceNumber: this.fifo
        ? (SEQUENCE_BASE + BigInt(++this.sequenceCounter)).toString()
        : undefined,
    });
    this.notifyVisible();
  }

  // PurgeQueue: drops every message (visible, delayed and in flight); the
  // FIFO dedup window and sequence counter survive, as on AWS.
  purge(): void {
    this.visible = [];
    this.delayed.clear();
    this.inflight.clear();
    this.groupLocks.clear();
    this.clearTimer();
  }

  // Queue deletion: stop the timer and wake parked long-polls so their loops
  // observe the queue is gone.
  dispose(): void {
    this.purge();
    for (const waiter of [...this.waiters]) waiter();
  }

  serialize(): SerializedQueueMessages {
    const all = [...this.visible, ...this.delayed.values(), ...this.inflight.values()];
    return {
      messages: all.map(message => ({ ...message, receiptHandle: undefined })),
      orderCounter: this.orderCounter,
      sequenceCounter: this.sequenceCounter,
      dedup: [...this.dedup.entries()].map(([id, entry]) => ({ id, ...entry })),
    };
  }

  restore(data: SerializedQueueMessages): void {
    const now = Date.now();
    this.orderCounter = data.orderCounter;
    this.sequenceCounter = data.sequenceCounter;
    for (const entry of data.dedup) {
      if (entry.expiresAt > now) {
        this.dedup.set(entry.id, {
          messageId: entry.messageId,
          sequenceNumber: entry.sequenceNumber,
          expiresAt: entry.expiresAt,
        });
      }
    }
    for (const message of data.messages) {
      message.receiptHandle = undefined;
      if (message.visibleAt > now && message.receiveCount === 0) {
        this.delayed.set(message.messageId, message);
        this.addDeadline(message.visibleAt);
      } else {
        // In-flight at shutdown: the receipt handle died with the process, so
        // the message becomes visible again immediately (SQS redelivery).
        message.visibleAt = Math.min(message.visibleAt, now);
        this.insertVisible(message);
      }
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private newReceiptHandle(messageId: string): string {
    return Buffer.from(`${this.name}|${messageId}|${crypto.randomUUID()}`, 'utf8').toString(
      'base64url',
    );
  }

  // A handle this queue could have issued (whether or not it is still live).
  private isOwnHandle(receiptHandle: string): boolean {
    if (!receiptHandle) return false;
    const decoded = Buffer.from(receiptHandle, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    return parts.length === 3 && parts[0] === this.name;
  }

  private insertVisible(message: StoredMessage): void {
    // Binary insert by arrival order: requeues and expired delays land back
    // in their original position among newer arrivals.
    let low = 0;
    let high = this.visible.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.visible[mid].order < message.order) low = mid + 1;
      else high = mid;
    }
    this.visible.splice(low, 0, message);
  }

  private requeue(message: StoredMessage): void {
    message.receiptHandle = undefined;
    message.visibleAt = Date.now();
    this.unlockGroup(message);
    if (this.movedToDeadLetterQueue(message)) return;
    this.insertVisible(message);
  }

  // The redrive decision, taken on every path that would make an ALREADY
  // RECEIVED message visible again. Returns true when the message left this
  // queue for the dead-letter queue and must not be re-inserted.
  //
  // Off-by-one, AWS-faithful: a message moves once its ApproximateReceiveCount
  // *exceeds* maxReceiveCount. `receiveCount` here is the number of deliveries
  // already made, so the move happens exactly when the NEXT delivery would push
  // it past the threshold — with maxReceiveCount: 2 the consumer sees the
  // message twice, and the third delivery attempt goes to the DLQ instead.
  //
  // Callers unlock the FIFO group BEFORE calling this, so moving a poison
  // message releases its MessageGroupId and the rest of the group flows again
  // rather than stalling behind it forever.
  private movedToDeadLetterQueue(message: StoredMessage): boolean {
    const target = this.redrive();
    if (!target || message.receiveCount < target.maxReceiveCount) return false;
    target.move(message);
    return true;
  }

  private unlockGroup(message: StoredMessage): void {
    if (!this.fifo || !message.messageGroupId) return;
    const locks = (this.groupLocks.get(message.messageGroupId) ?? 1) - 1;
    if (locks <= 0) {
      this.groupLocks.delete(message.messageGroupId);
      // The group is deliverable again; wake pollers waiting on it.
      if (this.visible.some(m => m.messageGroupId === message.messageGroupId)) {
        this.notifyVisible();
      }
    } else {
      this.groupLocks.set(message.messageGroupId, locks);
    }
  }

  private pruneDedup(now: number): void {
    for (const [id, entry] of this.dedup) {
      if (entry.expiresAt > now) break;
      this.dedup.delete(id);
    }
  }

  // Retention is enforced lazily at read time. `visible` is sorted by arrival
  // order, so expired messages are always a prefix.
  private pruneRetention(now: number, retentionMs: number): void {
    while (this.visible.length > 0 && this.visible[0].sentTimestamp + retentionMs <= now) {
      this.visible.shift();
    }
  }

  private notifyVisible(): void {
    for (const waiter of [...this.waiters]) waiter();
    this.onVisible();
  }

  private addDeadline(at: number): void {
    if (at >= this.timerAt) return;
    this.armTimer(at);
  }

  private armTimer(at: number): void {
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => this.fireTimer(), Math.max(0, at - Date.now()));
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  private fireTimer(): void {
    this.timer = null;
    this.timerAt = Infinity;
    const now = Date.now();
    let becameVisible = false;

    for (const [messageId, message] of this.delayed) {
      if (message.visibleAt <= now) {
        this.delayed.delete(messageId);
        this.insertVisible(message);
        becameVisible = true;
      }
    }
    for (const [handle, message] of this.inflight) {
      if (message.visibleAt <= now) {
        this.inflight.delete(handle);
        message.receiptHandle = undefined;
        this.unlockGroup(message);
        // Visibility expiry is the redelivery path a failing consumer takes:
        // the message either goes to the dead-letter queue or becomes visible.
        if (this.movedToDeadLetterQueue(message)) continue;
        this.insertVisible(message);
        becameVisible = true;
      }
    }

    // Re-arm to the next pending deadline, if any.
    let next = Infinity;
    for (const message of this.delayed.values()) next = Math.min(next, message.visibleAt);
    for (const message of this.inflight.values()) next = Math.min(next, message.visibleAt);
    if (next !== Infinity) this.armTimer(next);

    if (becameVisible) this.notifyVisible();
  }
}
