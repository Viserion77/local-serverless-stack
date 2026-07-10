// DynamoDB Streams → Lambda tailers (PRD RF5.3). One serial tailer per
// ENABLED ESM on a table stream ARN; wakes on the engine bus
// 'dynamo:stream-appended' event — no polling. Failure semantics follow AWS:
// the same batch retries up to min(maximumRetryAttempts, 5) times, then (when
// configured) the OnFailure SQS destination receives the DDBStreamBatchInfo
// envelope and the tailer advances past the poisoned batch.

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
const MAX_RETRY_ATTEMPTS = 5;
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
  private readonly busListener: (payload: DynamoStreamAppendedEvent) => void;

  constructor(deps: StreamTailerDeps, esm: EngineEventSourceMappingRecord, region: string, tableName: string) {
    this.deps = deps;
    this.esm = esm;
    this.region = region;
    this.tableName = tableName;
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
        await this.deliverBatch(records as StreamWireRecord[]);
        if (this.stopped) break;
        // Advance in every outcome: success, or retries exhausted (with the
        // OnFailure envelope already sent) — a poisoned batch never wedges.
        this.afterSeq = lastSeq;
      }
    } while (this.pending && !this.stopped && this.esm.enabled);
    this.delivering = false;
  }

  private async deliverBatch(records: StreamWireRecord[]): Promise<void> {
    const event = { Records: records };
    const maxRetries = Math.min(this.esm.maximumRetryAttempts ?? MAX_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS);
    let lastErrorType: string | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
      if (this.stopped) return;
      const result = await this.deps.invoke(this.esm.functionName, event);
      if (result.ok) return;
      lastErrorType = result.errorType;
    }
    console.warn(
      `[engine-stream-tailer] ${this.tableName}: batch of ${records.length} record(s) failed after ` +
        `${maxRetries + 1} attempt(s) (${lastErrorType ?? 'Error'}) — advancing past it`,
    );
    if (this.esm.onFailureDestinationArn) {
      await this.sendOnFailure(records, maxRetries + 1, lastErrorType);
    }
  }

  // AWS's OnFailure destination envelope for stream batches.
  private async sendOnFailure(records: StreamWireRecord[], invokeCount: number, errorType: string | undefined): Promise<void> {
    const destinationArn = this.esm.onFailureDestinationArn as string;
    const first = records[0];
    const last = records[records.length - 1];
    const { account } = this.deps.ctx.config;
    const envelope = {
      requestContext: {
        requestId: randomUUID(),
        functionArn: `arn:aws:lambda:${this.region}:${account}:function:${this.esm.functionName}`,
        condition: 'RetryAttemptsExhausted',
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
