// DynamoDB Streams → Lambda tailers (PRD RF5.3). One serial tailer per
// ENABLED ESM on a table stream ARN; wakes on the engine bus
// 'dynamo:stream-appended' event — no polling. Failure semantics follow AWS:
// maximumRetryAttempts omitted or -1 means "retry until the record ages out of
// the stream" (locally, until the batch's oldest record rotates past the
// 1000-record ring's trim horizon — never capped at 5); a positive N retries
// at most N times (N+1 invocations). On genuine exhaustion (RetryAttemptsExhausted)
// or record-age expiry (RecordAgeExpired) the OnFailure SQS destination, when
// configured, receives the DDBStreamBatchInfo envelope and the tailer advances
// past the batch. FilterCriteria drops non-matching records before batching
// (still advancing the cursor); ReportBatchItemFailures honors a handler's
// partial-batch response, checkpointing before the earliest still-failing record.

import { randomUUID } from 'crypto';
import type {
  AwsRequest,
  DynamoStreamAppendedEvent,
  EngineContext,
  EngineEventSourceMappingRecord,
} from '../types.js';
import type { DynamoDbEmulator } from '../emulators/dynamodb/index.js';
import type { SqsEmulator } from '../emulators/sqs/index.js';
import { queueNameFromArn } from '../emulators/sqs/index.js';
import type { LambdaCtlEmulator } from '../emulators/lambda-ctl/index.js';
import type { InvokeFn } from './sqs-poller.js';
import { buildStreamFilterView, compileFilterCriteria } from './filter-criteria.js';

export interface StreamTailerDeps {
  ctx: EngineContext;
  dynamo: DynamoDbEmulator;
  sqs: SqsEmulator;
  lambdaCtl: LambdaCtlEmulator;
  invoke: InvokeFn;
  // Test hook: delay between retries of a failed batch (default 200 ms).
  retryBackoffMs?: number;
}

const DEFAULT_RETRY_BACKOFF_MS = 200;
// The stream ring keeps at most 1000 records, so one read sees them all.
const LATEST_PROBE_LIMIT = 1000;

const STREAM_ARN_TABLE = /:table\/([^/]+)\/stream\//;

// Minimal view of the wire-shaped records the dynamo emulator returns.
interface StreamWireRecord {
  eventSourceARN?: string;
  dynamodb?: {
    SequenceNumber?: string;
    ApproximateCreationDateTime?: number;
  };
}

class StreamTailer {
  readonly region: string;
  readonly tableName: string;

  private esm: EngineEventSourceMappingRecord;
  private readonly deps: StreamTailerDeps;
  private afterSeq: string | undefined;
  private stopped = false;
  private delivering = false;
  private pending = false;
  private filter: (record: Record<string, unknown>) => boolean;
  private readonly busListener: (payload: DynamoStreamAppendedEvent) => void;

  constructor(deps: StreamTailerDeps, esm: EngineEventSourceMappingRecord, region: string, tableName: string) {
    this.deps = deps;
    this.esm = esm;
    this.region = region;
    this.tableName = tableName;
    this.filter = compileFilterCriteria(esm.filterCriteria);
    // LATEST starts after whatever the ring holds right now; TRIM_HORIZON
    // (and an omitted position) starts at the oldest retained record.
    if (esm.startingPosition === 'LATEST') {
      this.afterSeq = deps.dynamo.readStream(region, tableName, undefined, LATEST_PROBE_LIMIT).lastSeq;
    }
    this.busListener = payload => {
      if (payload.region === this.region && payload.tableName === this.tableName) this.wake();
    };
  }

  start(): void {
    this.deps.ctx.bus.on('dynamo:stream-appended', this.busListener);
    this.wake();
  }

  update(esm: EngineEventSourceMappingRecord): void {
    this.esm = esm;
    // FilterCriteria can change on update — recompile the predicate.
    this.filter = compileFilterCriteria(esm.filterCriteria);
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.deps.ctx.bus.off('dynamo:stream-appended', this.busListener);
  }

  wake(): void {
    if (this.stopped || !this.esm.enabled) return;
    if (this.delivering) {
      this.pending = true;
      return;
    }
    this.delivering = true;
    void this.run().catch(err => {
      console.warn(`[engine-stream-tailer] tailer for ${this.tableName} crashed:`, err);
      this.delivering = false;
    });
  }

  private async run(): Promise<void> {
    do {
      this.pending = false;
      for (;;) {
        if (this.stopped || !this.esm.enabled) break;
        const { records, lastSeq } = this.deps.dynamo.readStream(
          this.region,
          this.tableName,
          this.afterSeq,
          this.esm.batchSize,
        );
        if (records.length === 0 || lastSeq === undefined) break;
        // FilterCriteria drops non-matching records BEFORE batching. The raw
        // window is still consumed (batchSize reads raw records) and the cursor
        // advances past filtered records so they never reappear.
        const wire = records as StreamWireRecord[];
        const matching = wire.filter(record => this.filter(buildStreamFilterView(record as Record<string, unknown>)));
        // A window that is 100% filtered advances the cursor with no invoke.
        const advance = matching.length === 0 ? true : await this.deliverBatch(matching);
        if (this.stopped) break;
        // deliverBatch returns false only when the ESM was disabled/stopped
        // mid-retry: leave the cursor so the batch is reconsidered on re-enable.
        if (!advance) break;
        // Advance in every advancing outcome: success, partial-batch commit,
        // retries exhausted or record-age expiry (OnFailure already sent), or a
        // fully-filtered window — a poisoned batch never wedges.
        this.afterSeq = lastSeq;
      }
    } while (this.pending && !this.stopped && this.esm.enabled);
    this.delivering = false;
  }

  // Delivers one batch, honoring maximumRetryAttempts (-1/omitted = retry until
  // record-age expiry; positive N = N retries) and, when the ESM declares
  // ReportBatchItemFailures, the handler's partial-batch response. Returns true
  // to advance the cursor past the batch, false to leave it (disabled/stopped
  // mid-retry) so the batch is reconsidered when the ESM is re-enabled.
  private async deliverBatch(records: StreamWireRecord[]): Promise<boolean> {
    const reportPartial = this.esm.functionResponseTypes?.includes('ReportBatchItemFailures') ?? false;
    const configured = this.esm.maximumRetryAttempts;
    const infinite = configured === undefined || configured < 0;
    const maxRetries = infinite ? Number.POSITIVE_INFINITY : configured;

    // The still-failing suffix; shrinks as ReportBatchItemFailures checkpoints
    // past committed records. The attempt budget is NOT reset when it shrinks.
    let suffix = records;
    let lastErrorType: string | undefined;
    let condition = 'RetryAttemptsExhausted';
    let invokeCount = 0;

    for (let attempt = 0; ; attempt++) {
      if (this.stopped || !this.esm.enabled) return false;
      if (attempt > 0) await sleep(this.deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
      if (this.stopped || !this.esm.enabled) return false;

      const result = await this.deps.invoke(this.esm.functionName, { Records: suffix });
      invokeCount++;
      if (result.ok) {
        if (!reportPartial) return true; // whole batch committed
        const parsed = this.parseBatchItemFailures(result.payload, suffix);
        if (parsed.kind === 'success') return true; // whole (remaining) batch committed
        if (parsed.kind === 'partial') suffix = parsed.failingSuffix; // checkpoint past the prefix
        // partial or malformed → the suffix failed; fall through to retry it.
        lastErrorType = 'Unhandled';
      } else {
        // A failed invoke (result.ok === false) retries the whole current suffix.
        lastErrorType = result.errorType;
      }

      if (infinite) {
        // -1/omitted retries until the still-failing suffix ages out of the ring.
        if (this.batchAgedOut(suffix)) {
          condition = 'RecordAgeExpired';
          break;
        }
      } else if (attempt >= maxRetries) {
        condition = 'RetryAttemptsExhausted';
        break;
      }
    }

    console.warn(
      `[engine-stream-tailer] ${this.tableName}: batch of ${suffix.length} record(s) failed after ` +
        `${invokeCount} attempt(s) (${lastErrorType ?? 'Error'}, ${condition}) — advancing past it`,
    );
    if (this.esm.onFailureDestinationArn) {
      await this.sendOnFailure(suffix, invokeCount, lastErrorType, condition);
    }
    return true;
  }

  // Parses a ReportBatchItemFailures response against the current suffix.
  // success  = null/undefined payload, absent batchItemFailures, or [] (commit).
  // malformed = batchItemFailures not an array, a bad/empty itemIdentifier, or an
  //             itemIdentifier that is not a SequenceNumber in the current suffix
  //             (retry the whole current suffix, like a thrown handler).
  // partial  = the contiguous suffix from the EARLIEST reported failure through
  //            the end (records are ascending, so slicing from the first matched
  //            index includes any unlisted records after the earliest failure).
  private parseBatchItemFailures(
    payload: unknown,
    suffix: StreamWireRecord[],
  ): { kind: 'success' } | { kind: 'malformed' } | { kind: 'partial'; failingSuffix: StreamWireRecord[] } {
    if (payload === null || payload === undefined) return { kind: 'success' };
    if (typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'malformed' };
    const bif = (payload as Record<string, unknown>).batchItemFailures;
    if (bif === null || bif === undefined) return { kind: 'success' };
    if (!Array.isArray(bif)) return { kind: 'malformed' };
    if (bif.length === 0) return { kind: 'success' };

    const failing = new Set<string>();
    for (const entry of bif) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { kind: 'malformed' };
      const id = (entry as Record<string, unknown>).itemIdentifier;
      if (typeof id !== 'string' || id.length === 0) return { kind: 'malformed' };
      failing.add(id);
    }
    const suffixSeqs = new Set(
      suffix.map(record => record.dynamodb?.SequenceNumber).filter((seq): seq is string => seq !== undefined),
    );
    for (const id of failing) {
      if (!suffixSeqs.has(id)) return { kind: 'malformed' };
    }
    const firstIndex = suffix.findIndex(record => {
      const seq = record.dynamodb?.SequenceNumber;
      return seq !== undefined && failing.has(seq);
    });
    return { kind: 'partial', failingSuffix: suffix.slice(firstIndex) };
  }

  // True once the batch's earliest record has been evicted from the ring (its
  // SequenceNumber no longer precedes the oldest retained record after the
  // pre-batch cursor) — the local stand-in for AWS's record-age expiry.
  private batchAgedOut(records: StreamWireRecord[]): boolean {
    const firstSeq = records[0]?.dynamodb?.SequenceNumber;
    if (firstSeq === undefined) return true;
    const head = this.deps.dynamo.readStream(this.region, this.tableName, this.afterSeq, 1);
    const headSeq = (head.records[0] as StreamWireRecord | undefined)?.dynamodb?.SequenceNumber;
    if (headSeq === undefined) return true; // nothing left in the ring after the cursor
    return headSeq > firstSeq;
  }

  // AWS's OnFailure destination envelope for stream batches.
  private async sendOnFailure(
    records: StreamWireRecord[],
    invokeCount: number,
    errorType: string | undefined,
    condition: string,
  ): Promise<void> {
    const destinationArn = this.esm.onFailureDestinationArn as string;
    const first = records[0];
    const last = records[records.length - 1];
    const { account } = this.deps.ctx.config;
    const envelope = {
      requestContext: {
        requestId: randomUUID(),
        functionArn: `arn:aws:lambda:${this.region}:${account}:function:${this.esm.functionName}`,
        condition,
        approximateInvokeCount: invokeCount,
      },
      responseContext: {
        statusCode: 200,
        functionError: errorType ?? 'Unhandled',
      },
      version: '1.0',
      timestamp: new Date().toISOString(),
      DDBStreamBatchInfo: {
        shardId: 'shardId-000000000000',
        startSequenceNumber: first.dynamodb?.SequenceNumber,
        endSequenceNumber: last.dynamodb?.SequenceNumber,
        approximateArrivalOfFirstRecord: arrivalIso(first),
        approximateArrivalOfLastRecord: arrivalIso(last),
        batchSize: records.length,
        streamArn: first.eventSourceARN ?? this.esm.eventSourceArn,
      },
    };

    const queueName = queueNameFromArn(destinationArn);
    const syntheticRequest: AwsRequest = {
      method: 'POST',
      rawPath: '/',
      query: {},
      headers: {},
      body: Buffer.alloc(0),
      service: 'sqs',
      region: this.region,
      requestId: randomUUID(),
    };
    try {
      await this.deps.sqs.handle(
        'SendMessage',
        {
          QueueUrl: `${this.deps.ctx.endpoint()}/${account}/${queueName}`,
          MessageBody: JSON.stringify(envelope),
        },
        syntheticRequest,
      );
    } catch (err) {
      console.warn(
        `[engine-stream-tailer] OnFailure destination ${destinationArn} rejected the failure envelope:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export class StreamTailerSet {
  private readonly deps: StreamTailerDeps;
  private readonly tailers = new Map<string, StreamTailer>();

  constructor(deps: StreamTailerDeps) {
    this.deps = deps;
  }

  sync(region: string): void {
    const alive = new Set<string>();
    for (const esm of this.deps.lambdaCtl.listEventSourceMappings(region)) {
      const match = STREAM_ARN_TABLE.exec(esm.eventSourceArn);
      if (!match) continue;
      if (!esm.enabled) continue;
      alive.add(esm.uuid);
      const existing = this.tailers.get(esm.uuid);
      if (existing) {
        existing.update(esm);
      } else {
        const tailer = new StreamTailer(this.deps, esm, region, match[1]);
        this.tailers.set(esm.uuid, tailer);
        tailer.start();
      }
    }
    for (const [uuid, tailer] of this.tailers) {
      if (tailer.region === region && !alive.has(uuid)) {
        tailer.stop();
        this.tailers.delete(uuid);
      }
    }
  }

  stopAll(): void {
    for (const tailer of this.tailers.values()) tailer.stop();
    this.tailers.clear();
  }

  tailerCount(): number {
    return this.tailers.size;
  }
}

function arrivalIso(record: StreamWireRecord): string | undefined {
  const seconds = record.dynamodb?.ApproximateCreationDateTime;
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
