// Per-table DynamoDB change streams: an in-memory ring buffer (1000 records
// per table, the local stand-in for the 24 h retention window) plus the read
// API the dispatcher's stream tailer consumes. Rings are memory-only — after
// an engine restart the ring is empty and sequence numbers restart at 1,
// which for a dev tool is an acceptable TRIM_HORIZON.

import crypto from 'crypto';
import type { AttributeMap, EngineContext } from '../../types.js';
import type { TableRecord } from './schema.js';
import { itemSizeBytes, streamArnFor } from './schema.js';

const MAX_RECORDS_PER_TABLE = 1000;
const SEQUENCE_PAD = 21;

export type StreamEventName = 'INSERT' | 'MODIFY' | 'REMOVE';

export interface StreamAppendInput {
  eventName: StreamEventName;
  keys: AttributeMap;
  newImage?: AttributeMap;
  oldImage?: AttributeMap;
  // TTL removals carry {type: "Service", principalId: "dynamodb.amazonaws.com"}.
  userIdentity?: { type: string; principalId: string };
}

interface WireStreamRecord {
  eventID: string;
  eventName: StreamEventName;
  eventVersion: '1.1';
  eventSource: 'aws:dynamodb';
  awsRegion: string;
  dynamodb: {
    ApproximateCreationDateTime: number;
    Keys: AttributeMap;
    NewImage?: AttributeMap;
    OldImage?: AttributeMap;
    SequenceNumber: string;
    SizeBytes: number;
    StreamViewType: string;
  };
  eventSourceARN: string;
  userIdentity?: { type: string; principalId: string };
}

interface StreamState {
  arn: string;
  viewType: string;
  nextSeq: number;
  records: WireStreamRecord[];
}

export class DynamoStreams {
  private readonly states = new Map<string, StreamState>();

  constructor(private readonly ctx: EngineContext) {}

  private stateKey(region: string, tableName: string): string {
    return `${region}/${tableName}`;
  }

  // Idempotent: called every time table metadata is touched, so streams come
  // back after a restart as soon as the region catalog is loaded.
  ensureRegistered(region: string, record: TableRecord): void {
    if (record.streamSpecification?.StreamEnabled !== true || !record.latestStreamLabel) return;
    const key = this.stateKey(region, record.tableName);
    if (this.states.has(key)) return;
    this.states.set(key, {
      arn: streamArnFor(this.ctx.config.account, region, record),
      viewType: record.streamSpecification.StreamViewType,
      nextSeq: 1,
      records: [],
    });
  }

  unregister(region: string, tableName: string): void {
    this.states.delete(this.stateKey(region, tableName));
  }

  getStreamArn(region: string, tableName: string): string | undefined {
    return this.states.get(this.stateKey(region, tableName))?.arn;
  }

  // Appends one committed write. No-op for tables without an enabled stream.
  append(region: string, tableName: string, input: StreamAppendInput): void {
    const state = this.states.get(this.stateKey(region, tableName));
    if (!state) return;
    const sequenceNumber = String(state.nextSeq++).padStart(SEQUENCE_PAD, '0');
    const record: WireStreamRecord = {
      eventID: crypto.randomUUID(),
      eventName: input.eventName,
      eventVersion: '1.1',
      eventSource: 'aws:dynamodb',
      awsRegion: region,
      dynamodb: {
        ApproximateCreationDateTime: Math.floor(Date.now() / 1000),
        Keys: structuredClone(input.keys),
        SequenceNumber: sequenceNumber,
        SizeBytes: 0,
        StreamViewType: state.viewType,
      },
      eventSourceARN: state.arn,
    };
    if (input.newImage && (state.viewType === 'NEW_IMAGE' || state.viewType === 'NEW_AND_OLD_IMAGES')) {
      record.dynamodb.NewImage = structuredClone(input.newImage);
    }
    if (input.oldImage && (state.viewType === 'OLD_IMAGE' || state.viewType === 'NEW_AND_OLD_IMAGES')) {
      record.dynamodb.OldImage = structuredClone(input.oldImage);
    }
    record.dynamodb.SizeBytes = itemSizeBytes(record.dynamodb.Keys)
      + (record.dynamodb.NewImage ? itemSizeBytes(record.dynamodb.NewImage) : 0)
      + (record.dynamodb.OldImage ? itemSizeBytes(record.dynamodb.OldImage) : 0)
      + sequenceNumber.length;
    if (input.userIdentity) record.userIdentity = input.userIdentity;
    state.records.push(record);
    if (state.records.length > MAX_RECORDS_PER_TABLE) state.records.shift();
    this.ctx.bus.emit('dynamo:stream-appended', { region, tableName });
  }

  // afterSeq undefined starts at TRIM_HORIZON (oldest retained record).
  // lastSeq is the SequenceNumber of the last returned record — undefined
  // when nothing was returned, so the caller keeps its previous cursor.
  read(
    region: string,
    tableName: string,
    afterSeq: string | undefined,
    limit: number,
  ): { records: unknown[]; lastSeq: string | undefined } {
    const state = this.states.get(this.stateKey(region, tableName));
    if (!state || limit < 1) return { records: [], lastSeq: undefined };
    let startIndex = 0;
    if (afterSeq !== undefined) {
      // Sequence numbers are fixed-width, so string comparison is numeric.
      startIndex = state.records.findIndex((r) => r.dynamodb.SequenceNumber > afterSeq);
      if (startIndex === -1) return { records: [], lastSeq: undefined };
    }
    const slice = state.records.slice(startIndex, startIndex + limit);
    const last = slice[slice.length - 1];
    return {
      records: slice.map((r) => structuredClone(r) as unknown),
      lastSeq: last?.dynamodb.SequenceNumber,
    };
  }
}
