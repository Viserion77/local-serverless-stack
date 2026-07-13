// Shared contracts for the self engine: the in-process AWS emulator that
// replaces LocalStack when `engine: "self"` is configured. Everything here is
// interface-only so the http layer, the store and each emulator can be
// implemented (and tested) independently against a stable seam.
//
// See docs/PRD_SELF_ENGINE.md for the full design.

import type { EngineStore } from './store/store-types.js';
import type { EngineBus } from './bus.js';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

// One parsed HTTP request entering the engine front door. The router fully
// reads (and aws-chunked-decodes) the body before dispatching, so emulators
// never deal with streaming except S3 object bodies, which the S3 emulator
// re-reads from `body` as a Buffer.
export interface AwsRequest {
  method: string;
  // Path without query string, URL-decoded per segment left to the emulator
  // (S3 keys must preserve encoded slashes).
  rawPath: string;
  query: Record<string, string>;
  // Header names lowercased; duplicate headers joined with ", ".
  headers: Record<string, string>;
  body: Buffer;
  // Resolved by the router from the SigV4 credential scope / X-Amz-Target /
  // path heuristics. `region` falls back to the configured default.
  service: EngineServiceName | undefined;
  region: string;
  requestId: string;
}

export interface AwsResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export type EngineServiceName =
  | 'dynamodb'
  | 'sqs'
  | 'sns'
  | 's3'
  | 'events'
  | 'lambda'
  | 'sts'
  | 'secretsmanager'
  // OpenSearch Serverless — the SigV4 signing name, shared by the control
  // plane (X-Amz-Target OpenSearchServerless.*) and the data plane REST API.
  | 'aoss';

// DynamoDB wire-format attribute value (also reused for stream records and
// SQS message-attribute shapes where noted). `B`/`BS` carry base64 strings —
// items are persisted exactly as received, so numeric precision and binary
// payloads survive untouched.
export interface AttributeValue {
  S?: string;
  N?: string;
  B?: string;
  BOOL?: boolean;
  NULL?: boolean;
  L?: AttributeValue[];
  M?: Record<string, AttributeValue>;
  SS?: string[];
  NS?: string[];
  BS?: string[];
}

export type AttributeMap = Record<string, AttributeValue>;

// ---------------------------------------------------------------------------
// Emulator interfaces (one flavor per AWS protocol family)
// ---------------------------------------------------------------------------

// AWS JSON 1.0/1.1 services routed by X-Amz-Target (DynamoDB, SQS, EventBridge).
// `handle` returns the response payload object; AWS-shaped failures are thrown
// as AwsError (see http/errors.ts) and serialized by the router.
export interface TargetEmulator {
  readonly service: EngineServiceName;
  // e.g. "DynamoDB_20120810", "AmazonSQS", "AWSEvents"
  readonly targetPrefix: string;
  readonly jsonVersion: '1.0' | '1.1';
  handle(operation: string, input: Record<string, unknown>, req: AwsRequest): Promise<object>;
}

// REST services (S3 rest-xml, Lambda rest-json): the emulator owns its routing
// and response shape entirely.
export interface RestEmulator {
  readonly service: EngineServiceName;
  handle(req: AwsRequest): Promise<AwsResponse>;
}

// Query-protocol services (SNS, STS): form-encoded Action= requests answered
// with XML. `handle` returns the inner XML result; the router wraps errors.
export interface QueryEmulator {
  readonly service: EngineServiceName;
  handle(action: string, params: Record<string, string>, req: AwsRequest): Promise<string>;
}

export type AnyEmulator = TargetEmulator | RestEmulator | QueryEmulator;

// ---------------------------------------------------------------------------
// Dispatcher (event delivery into the LSS Lambda runtime)
// ---------------------------------------------------------------------------

export interface EngineInvokeResult {
  ok: boolean;
  payload?: unknown;
  errorType?: string;
  errorMessage?: string;
}

// Implemented in dispatch/dispatcher.ts. Resolution order for `ref` (function
// name, full name or ARN): FunctionRegistry → in-process
// LambdaRuntimeManager.invoke(); else engine-registered function metadata with
// an INVOKE_URL env (absorbed LocalStack proxy) → HTTP POST to that invoke
// endpoint; else a failed EngineInvokeResult (never a throw).
export interface DispatcherApi {
  invokeFunction(ref: string, event: unknown, opts?: { async?: boolean }): Promise<EngineInvokeResult>;
}

// ---------------------------------------------------------------------------
// Engine context (constructor dependency of every emulator)
// ---------------------------------------------------------------------------

export interface SelfEngineResolvedConfig {
  port: number;
  dataDir: string;
  account: string;
  region: string;
  idleUnloadMs: number;
  memoryBudgetMb: number;
  fsync: boolean;
  fallbackEndpoint: string | null;
  persistence: boolean;
}

export interface EngineContext {
  config: SelfEngineResolvedConfig;
  store: EngineStore;
  bus: EngineBus;
  // Late-bound: assigned by the self backend before the HTTP listener accepts
  // traffic. Emulators must only touch it inside request handling.
  dispatcher: DispatcherApi;
  endpoint(): string;
}

// ---------------------------------------------------------------------------
// Bus event payloads (emitted by emulators, consumed by the dispatcher)
// ---------------------------------------------------------------------------

export interface SqsMessageVisibleEvent {
  region: string;
  queueName: string;
}

export interface DynamoStreamAppendedEvent {
  region: string;
  tableName: string;
}

// Raw object-level event; the dispatcher matches it against the bucket's
// notification configuration (prefix/suffix filters) and builds the Lambda
// `Records` payload.
export interface S3ObjectEvent {
  region: string;
  bucket: string;
  // e.g. "s3:ObjectCreated:Put", "s3:ObjectRemoved:Delete"
  eventName: string;
  key: string;
  size: number;
  eTag: string;
  sequencer: string;
}

// A rule already matched by the events emulator; the dispatcher applies
// Input/InputPath per target and invokes.
export interface EventRuleMatchedEvent {
  region: string;
  busName: string;
  ruleName: string;
  targets: EventRuleTarget[];
  // The canonical EventBridge envelope (version/id/detail-type/source/account/
  // time/region/resources/detail) — delivered to targets as-is, no Records wrapper.
  event: Record<string, unknown>;
}

export interface EventRuleTarget {
  id: string;
  arn: string;
  input?: string;
  inputPath?: string;
  // SqsParameters.MessageGroupId — required by AWS for a FIFO SQS target.
  sqsMessageGroupId?: string;
}

export interface EngineBusEvents {
  'sqs:message-visible': SqsMessageVisibleEvent;
  'dynamo:stream-appended': DynamoStreamAppendedEvent;
  's3:object-event': S3ObjectEvent;
  'events:rule-matched': EventRuleMatchedEvent;
}

// ---------------------------------------------------------------------------
// Persisted metadata shapes shared across emulators and the dispatcher
// ---------------------------------------------------------------------------

// Absorbed Lambda function metadata (real functions run in the LSS runtime;
// LocalStack-era proxy functions are stored so their INVOKE_URL keeps working
// as an HTTP fallback for services still on serverless-offline).
export interface EngineFunctionRecord {
  functionName: string;
  arn: string;
  runtime?: string;
  handler?: string;
  memorySize?: number;
  timeout?: number;
  environment: Record<string, string>;
  lastModified: string;
}

export interface EngineEventSourceMappingRecord {
  uuid: string;
  functionName: string;
  eventSourceArn: string;
  enabled: boolean;
  batchSize: number;
  maximumBatchingWindowInSeconds?: number;
  maximumRetryAttempts?: number;
  startingPosition?: 'TRIM_HORIZON' | 'LATEST';
  // OnFailure SQS destination ARN, when configured.
  onFailureDestinationArn?: string;
  filterCriteria?: unknown;
  createdAt: string;
  lastModified: string;
  state: 'Enabled' | 'Disabled';
}
