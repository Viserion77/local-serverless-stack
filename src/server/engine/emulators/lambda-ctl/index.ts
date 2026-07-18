// Lambda control-plane emulator for the self engine. Real functions run in
// the LSS Lambda runtime; this emulator absorbs the provisioner's
// LocalStack-era proxy functions as pure metadata (Code.ZipFile is discarded,
// the INVOKE_URL env survives as the dispatcher's HTTP fallback), owns the
// event source mapping registry the dispatcher delivers from, and passes
// Invoke through to the dispatcher. REST-JSON on the /2015-03-31 paths the
// LSS provisioner and QueueInspector call — see docs/PRD_SELF_ENGINE.md §6.

import { randomUUID } from 'crypto';
import { AwsError, notImplementedOperation } from '../../http/errors.js';
import { validateFilterCriteria } from '../../dispatch/filter-criteria.js';
import type { CatalogStore } from '../../store/store-types.js';
import type {
  AwsRequest,
  AwsResponse,
  EngineContext,
  EngineEventSourceMappingRecord,
  EngineFunctionRecord,
  EngineInvokeResult,
  EngineServiceName,
  RestEmulator,
} from '../../types.js';

// AddPermission statements ride along in the same catalog entry as an
// additive field — the shared EngineFunctionRecord contract stays untouched.
export interface LambdaPolicyStatement {
  Sid: string;
  Effect: 'Allow';
  Action?: string;
  Resource: string;
  Principal?: { Service: string };
  Condition?: { ArnLike: { 'AWS:SourceArn': string } };
}

export interface LambdaFunctionRecord extends EngineFunctionRecord {
  statements?: Record<string, LambdaPolicyStatement>;
}

type CreateFunctionInput = {
  FunctionName?: string;
  Runtime?: string;
  Handler?: string;
  MemorySize?: number;
  Timeout?: number;
  Environment?: { Variables?: Record<string, string> };
};

type UpdateFunctionConfigurationInput = Omit<CreateFunctionInput, 'FunctionName'>;

type AddPermissionInput = {
  StatementId?: string;
  Action?: string;
  Principal?: string;
  SourceArn?: string;
};

type EventSourceMappingInput = {
  FunctionName?: string;
  EventSourceArn?: string;
  Enabled?: boolean;
  BatchSize?: number;
  MaximumBatchingWindowInSeconds?: number;
  MaximumRetryAttempts?: number;
  StartingPosition?: 'TRIM_HORIZON' | 'LATEST';
  DestinationConfig?: { OnFailure?: { Destination?: string } };
  FilterCriteria?: unknown;
  FunctionResponseTypes?: string[];
};

// DynamoDB Streams / Kinesis sources; SQS sources do not carry a retry count.
function isStreamSourceArn(arn: string): boolean {
  return arn.startsWith('arn:aws:dynamodb:') || arn.startsWith('arn:aws:kinesis:');
}

// Failed dispatcher results with these errorType values mean "the ref could
// not be resolved at all" (vs a handler error, which stays a 200 +
// X-Amz-Function-Error). The dispatcher contract never throws, so this is the
// only signal available to turn an unknown function into the 404 the
// provisioner's ensureLambdaProxyExists branches on.
// 'FunctionNotResolvable' is what the round-2 dispatcher actually emits for
// refs it cannot resolve anywhere (registry, catalog, INVOKE_URL).
const UNRESOLVED_ERROR_TYPES = new Set([
  'ResourceNotFoundException',
  'FunctionNotFound',
  'Function.NotFound',
  'FunctionNotResolvable',
]);

const SOURCE_LABELS: Record<string, string> = { sqs: 'SQS', dynamodb: 'DynamoDB', kinesis: 'Kinesis' };

function sourceLabel(arn: string): string {
  const service = arn.split(':')[2] ?? '';
  return SOURCE_LABELS[service] ?? service.toUpperCase();
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseJsonBody<T>(req: AwsRequest): T {
  if (req.body.length === 0) return {} as T;
  try {
    return JSON.parse(req.body.toString('utf8')) as T;
  } catch {
    throw new AwsError('InvalidRequestContentException', 'Could not parse request body into json', { status: 400 });
  }
}

function jsonResponse(status: number, payload: unknown): AwsResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

// Lambda's LastModified format ("2026-07-10T12:00:00.000+0000").
function awsTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace('Z', '+0000');
}

export class LambdaCtlEmulator implements RestEmulator {
  readonly service: EngineServiceName = 'lambda';

  private readonly ctx: EngineContext;
  private readonly esmChangedListeners: Array<(region: string) => void> = [];

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
  }

  // -------------------------------------------------------------------------
  // Dispatcher-facing API (round-2 wiring)
  // -------------------------------------------------------------------------

  // Both sync accessors read the loaded catalog state; callers outside a
  // request (dispatcher boot re-arm) must `await ensureLoaded(region)` first.
  listEventSourceMappings(region: string): EngineEventSourceMappingRecord[] {
    return this.mappings(region).values();
  }

  getFunctionRecord(region: string, name: string): LambdaFunctionRecord | undefined {
    return this.functions(region).get(this.resolveFunctionName(name));
  }

  // Fired after every ESM create/update/delete (including the cascade drop on
  // DeleteFunction) so the dispatcher re-syncs its delivery loops.
  onEsmChanged(cb: (region: string) => void): void {
    this.esmChangedListeners.push(cb);
  }

  async ensureLoaded(region: string): Promise<void> {
    await Promise.all([this.functions(region).load(), this.mappings(region).load()]);
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  async handle(req: AwsRequest): Promise<AwsResponse> {
    const segments = req.rawPath.split('/').filter(s => s.length > 0).map(decodeSegment);
    if (segments[0] !== '2015-03-31') {
      throw notImplementedOperation('lambda', `${req.method} ${req.rawPath}`);
    }
    await this.ensureLoaded(req.region);
    const [, root, ...rest] = segments;
    if (root === 'functions') return this.handleFunctionRoutes(req, rest);
    if (root === 'event-source-mappings') return this.handleMappingRoutes(req, rest);
    throw notImplementedOperation('lambda', `${req.method} ${req.rawPath}`);
  }

  private async handleFunctionRoutes(req: AwsRequest, rest: string[]): Promise<AwsResponse> {
    if (rest.length === 0) {
      if (req.method === 'POST') return this.createFunction(req);
      if (req.method === 'GET') return this.listFunctions(req);
    } else if (rest.length === 1) {
      if (req.method === 'GET') return this.getFunction(req, rest[0]);
      if (req.method === 'DELETE') return this.deleteFunction(req, rest[0]);
    } else if (rest.length === 2 && rest[1] === 'configuration' && req.method === 'PUT') {
      return this.updateFunctionConfiguration(req, rest[0]);
    } else if (rest.length === 2 && rest[1] === 'policy' && req.method === 'POST') {
      return this.addPermission(req, rest[0]);
    } else if (rest.length === 3 && rest[1] === 'policy' && req.method === 'DELETE') {
      return this.removePermission(req, rest[0], rest[2]);
    } else if (rest.length === 2 && rest[1] === 'invocations' && req.method === 'POST') {
      return this.invoke(req, rest[0]);
    }
    throw notImplementedOperation('lambda', `${req.method} ${req.rawPath}`);
  }

  private handleMappingRoutes(req: AwsRequest, rest: string[]): AwsResponse {
    if (rest.length === 0) {
      if (req.method === 'POST') return this.createEventSourceMapping(req);
      if (req.method === 'GET') return this.listEventSourceMappingsRoute(req);
    } else if (rest.length === 1) {
      if (req.method === 'GET') return jsonResponse(200, this.mappingJson(req.region, this.requireMapping(req.region, rest[0])));
      if (req.method === 'PUT') return this.updateEventSourceMapping(req, rest[0]);
      if (req.method === 'DELETE') return this.deleteEventSourceMapping(req, rest[0]);
    }
    throw notImplementedOperation('lambda', `${req.method} ${req.rawPath}`);
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  private createFunction(req: AwsRequest): AwsResponse {
    const input = parseJsonBody<CreateFunctionInput>(req);
    const name = input.FunctionName;
    if (!name) {
      throw new AwsError('ValidationException', 'FunctionName is required', { status: 400 });
    }
    const catalog = this.functions(req.region);
    if (catalog.get(name)) {
      throw new AwsError('ResourceConflictException', `Function already exist: ${name}`, { status: 409 });
    }
    // Code.ZipFile is intentionally never read: absorbed proxies are metadata.
    const record: LambdaFunctionRecord = {
      functionName: name,
      arn: this.functionArn(req.region, name),
      runtime: input.Runtime,
      handler: input.Handler,
      memorySize: input.MemorySize,
      timeout: input.Timeout,
      environment: input.Environment?.Variables ?? {},
      lastModified: new Date().toISOString(),
    };
    catalog.set(name, record);
    return jsonResponse(201, this.functionConfiguration(record));
  }

  private getFunction(req: AwsRequest, ref: string): AwsResponse {
    const record = this.requireFunction(req.region, this.resolveFunctionName(ref));
    return jsonResponse(200, { Configuration: this.functionConfiguration(record), Code: {} });
  }

  private updateFunctionConfiguration(req: AwsRequest, ref: string): AwsResponse {
    const name = this.resolveFunctionName(ref);
    const record = this.requireFunction(req.region, name);
    const input = parseJsonBody<UpdateFunctionConfigurationInput>(req);
    // AWS replaces Environment.Variables wholesale when Environment is sent —
    // this is how the provisioner re-points stale INVOKE_URLs.
    if (input.Environment !== undefined) record.environment = input.Environment.Variables ?? {};
    if (input.Runtime !== undefined) record.runtime = input.Runtime;
    if (input.Handler !== undefined) record.handler = input.Handler;
    if (input.MemorySize !== undefined) record.memorySize = input.MemorySize;
    if (input.Timeout !== undefined) record.timeout = input.Timeout;
    record.lastModified = new Date().toISOString();
    this.functions(req.region).set(name, record);
    return jsonResponse(200, this.functionConfiguration(record));
  }

  private deleteFunction(req: AwsRequest, ref: string): AwsResponse {
    const name = this.resolveFunctionName(ref);
    this.requireFunction(req.region, name);
    this.functions(req.region).delete(name);
    const mappings = this.mappings(req.region);
    let dropped = false;
    for (const mapping of mappings.values()) {
      if (mapping.functionName === name) {
        mappings.delete(mapping.uuid);
        dropped = true;
      }
    }
    if (dropped) this.fireEsmChanged(req.region);
    return { status: 204 };
  }

  private listFunctions(req: AwsRequest): AwsResponse {
    const functions = this.functions(req.region).values().map(record => this.functionConfiguration(record));
    return jsonResponse(200, { Functions: functions });
  }

  // -------------------------------------------------------------------------
  // Permissions (recorded no-ops — nothing enforces them locally)
  // -------------------------------------------------------------------------

  private addPermission(req: AwsRequest, ref: string): AwsResponse {
    const name = this.resolveFunctionName(ref);
    const record = this.requireFunction(req.region, name);
    const input = parseJsonBody<AddPermissionInput>(req);
    const sid = input.StatementId;
    if (!sid) {
      throw new AwsError('ValidationException', 'StatementId is required', { status: 400 });
    }
    const statements = record.statements ?? {};
    if (statements[sid]) {
      throw new AwsError(
        'ResourceConflictException',
        `The statement id (${sid}) provided already exists. Please provide new statement id, or remove existing statement.`,
        { status: 409 },
      );
    }
    const statement: LambdaPolicyStatement = {
      Sid: sid,
      Effect: 'Allow',
      Resource: record.arn,
      ...(input.Action !== undefined ? { Action: input.Action } : {}),
      ...(input.Principal !== undefined ? { Principal: { Service: input.Principal } } : {}),
      ...(input.SourceArn !== undefined ? { Condition: { ArnLike: { 'AWS:SourceArn': input.SourceArn } } } : {}),
    };
    statements[sid] = statement;
    record.statements = statements;
    this.functions(req.region).set(name, record);
    return jsonResponse(201, { Statement: JSON.stringify(statement) });
  }

  private removePermission(req: AwsRequest, ref: string, sid: string): AwsResponse {
    const name = this.resolveFunctionName(ref);
    const record = this.requireFunction(req.region, name);
    if (!record.statements || !record.statements[sid]) {
      throw new AwsError('ResourceNotFoundException', `Statement ${sid} is not found in resource policy.`, { status: 404 });
    }
    delete record.statements[sid];
    this.functions(req.region).set(name, record);
    return { status: 204 };
  }

  // -------------------------------------------------------------------------
  // Event source mappings
  // -------------------------------------------------------------------------

  private createEventSourceMapping(req: AwsRequest): AwsResponse {
    const input = parseJsonBody<EventSourceMappingInput>(req);
    if (!input.FunctionName) {
      throw new AwsError('ValidationException', 'FunctionName is required', { status: 400 });
    }
    const functionName = this.resolveFunctionName(input.FunctionName);
    const eventSourceArn = input.EventSourceArn;
    if (!eventSourceArn) {
      throw new AwsError(
        'InvalidParameterValueException',
        'Unrecognized event source, must be kinesis, sqs or dynamodb stream.',
        { status: 400 },
      );
    }
    const catalog = this.mappings(req.region);
    const existing = catalog.values().find(m => m.eventSourceArn === eventSourceArn && m.functionName === functionName);
    if (existing) {
      throw new AwsError(
        'ResourceConflictException',
        `An event source mapping with ${sourceLabel(eventSourceArn)} arn (" ${eventSourceArn} ") and function ` +
          `(" ${functionName} ") already exists. Please use the existing mapping with UUID ${existing.uuid}`,
        { status: 409 },
      );
    }
    if (input.FilterCriteria !== undefined) this.assertValidFilterCriteria(input.FilterCriteria);
    const now = new Date().toISOString();
    const enabled = input.Enabled !== false;
    const isStream = isStreamSourceArn(eventSourceArn);
    const record: EngineEventSourceMappingRecord = {
      uuid: randomUUID(),
      functionName,
      eventSourceArn,
      enabled,
      batchSize: input.BatchSize ?? 10,
      maximumBatchingWindowInSeconds: input.MaximumBatchingWindowInSeconds,
      // AWS default for a stream (DynamoDB Streams / Kinesis) ESM is -1
      // (retry until the record ages out); SQS sources carry no retry count.
      maximumRetryAttempts: input.MaximumRetryAttempts ?? (isStream ? -1 : undefined),
      startingPosition: input.StartingPosition,
      onFailureDestinationArn: input.DestinationConfig?.OnFailure?.Destination,
      filterCriteria: input.FilterCriteria,
      functionResponseTypes: input.FunctionResponseTypes,
      createdAt: now,
      lastModified: now,
      state: enabled ? 'Enabled' : 'Disabled',
    };
    catalog.set(record.uuid, record);
    this.fireEsmChanged(req.region);
    return jsonResponse(202, this.mappingJson(req.region, record));
  }

  private listEventSourceMappingsRoute(req: AwsRequest): AwsResponse {
    const arnFilter = req.query['EventSourceArn'];
    const rawFunctionFilter = req.query['FunctionName'];
    const functionFilter = rawFunctionFilter ? this.resolveFunctionName(rawFunctionFilter) : undefined;
    let records = this.mappings(req.region).values();
    if (arnFilter) records = records.filter(m => m.eventSourceArn === arnFilter);
    if (functionFilter) records = records.filter(m => m.functionName === functionFilter);
    return jsonResponse(200, { EventSourceMappings: records.map(m => this.mappingJson(req.region, m)) });
  }

  private updateEventSourceMapping(req: AwsRequest, uuid: string): AwsResponse {
    const record = this.requireMapping(req.region, uuid);
    const input = parseJsonBody<EventSourceMappingInput>(req);
    if (typeof input.Enabled === 'boolean') {
      record.enabled = input.Enabled;
      record.state = input.Enabled ? 'Enabled' : 'Disabled';
    }
    if (input.BatchSize !== undefined) record.batchSize = input.BatchSize;
    if (input.MaximumBatchingWindowInSeconds !== undefined) record.maximumBatchingWindowInSeconds = input.MaximumBatchingWindowInSeconds;
    if (input.MaximumRetryAttempts !== undefined) record.maximumRetryAttempts = input.MaximumRetryAttempts;
    if (input.FunctionName !== undefined) record.functionName = this.resolveFunctionName(input.FunctionName);
    if (input.FilterCriteria !== undefined) {
      this.assertValidFilterCriteria(input.FilterCriteria);
      record.filterCriteria = input.FilterCriteria;
    }
    if (input.FunctionResponseTypes !== undefined) record.functionResponseTypes = input.FunctionResponseTypes;
    if (input.DestinationConfig !== undefined) record.onFailureDestinationArn = input.DestinationConfig.OnFailure?.Destination;
    record.lastModified = new Date().toISOString();
    this.mappings(req.region).set(uuid, record);
    this.fireEsmChanged(req.region);
    return jsonResponse(202, this.mappingJson(req.region, record));
  }

  private deleteEventSourceMapping(req: AwsRequest, uuid: string): AwsResponse {
    const record = this.requireMapping(req.region, uuid);
    this.mappings(req.region).delete(uuid);
    this.fireEsmChanged(req.region);
    return jsonResponse(202, this.mappingJson(req.region, record));
  }

  // -------------------------------------------------------------------------
  // Invoke passthrough
  // -------------------------------------------------------------------------

  private async invoke(req: AwsRequest, ref: string): Promise<AwsResponse> {
    const name = this.resolveFunctionName(ref);
    const invocationType = req.headers['x-amz-invocation-type'] || 'RequestResponse';
    const record = this.functions(req.region).get(name);

    if (invocationType === 'DryRun') {
      // No registry probe without invoking, so catalog presence is the check.
      if (!record) throw this.functionNotFound(req.region, name);
      return { status: 204 };
    }

    let event: unknown = {};
    if (req.body.length > 0) {
      try {
        event = JSON.parse(req.body.toString('utf8'));
      } catch {
        throw new AwsError('InvalidRequestContentException', 'Could not parse request body into json', { status: 400 });
      }
    }

    const result = await this.ctx.dispatcher.invokeFunction(name, event, { async: invocationType === 'Event' });
    if (!record && this.isUnresolved(result)) {
      throw this.functionNotFound(req.region, name);
    }
    if (invocationType === 'Event') {
      return { status: 202, headers: { 'content-type': 'application/json' } };
    }
    if (!result.ok) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-amz-function-error': 'Unhandled' },
        body: JSON.stringify({
          errorType: result.errorType ?? 'Error',
          errorMessage: result.errorMessage ?? 'Unhandled error',
        }),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: result.payload === undefined || result.payload === null ? 'null' : JSON.stringify(result.payload),
    };
  }

  private isUnresolved(result: EngineInvokeResult): boolean {
    return !result.ok && result.errorType !== undefined && UNRESOLVED_ERROR_TYPES.has(result.errorType);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private functions(region: string): CatalogStore<LambdaFunctionRecord> {
    return this.ctx.store.catalog<LambdaFunctionRecord>(`lambda/${region}/functions`);
  }

  private mappings(region: string): CatalogStore<EngineEventSourceMappingRecord> {
    return this.ctx.store.catalog<EngineEventSourceMappingRecord>(`lambda/${region}/event-source-mappings`);
  }

  // Accepts a bare name, "name:qualifier", or a full/partial function ARN and
  // returns the bare name — records are always keyed by name.
  private resolveFunctionName(ref: string): string {
    if (!ref.startsWith('arn:')) return ref.split(':')[0];
    const suffix = ref.split(':function:')[1];
    return suffix ? suffix.split(':')[0] : ref;
  }

  private functionArn(region: string, name: string): string {
    return `arn:aws:lambda:${region}:${this.ctx.config.account}:function:${name}`;
  }

  private requireFunction(region: string, name: string): LambdaFunctionRecord {
    const record = this.functions(region).get(name);
    if (!record) throw this.functionNotFound(region, name);
    return record;
  }

  private functionNotFound(region: string, name: string): AwsError {
    return new AwsError('ResourceNotFoundException', `Function not found: ${this.functionArn(region, name)}`, { status: 404 });
  }

  private requireMapping(region: string, uuid: string): EngineEventSourceMappingRecord {
    const record = this.mappings(region).get(uuid);
    if (!record) {
      throw new AwsError('ResourceNotFoundException', 'The resource you requested does not exist.', { status: 404 });
    }
    return record;
  }

  private functionConfiguration(record: LambdaFunctionRecord): Record<string, unknown> {
    return {
      FunctionName: record.functionName,
      FunctionArn: record.arn,
      Runtime: record.runtime,
      Handler: record.handler,
      MemorySize: record.memorySize,
      Timeout: record.timeout,
      Environment: { Variables: record.environment },
      Version: '$LATEST',
      State: 'Active',
      LastUpdateStatus: 'Successful',
      LastModified: awsTimestamp(record.lastModified),
    };
  }

  private mappingJson(region: string, record: EngineEventSourceMappingRecord): Record<string, unknown> {
    const json: Record<string, unknown> = {
      UUID: record.uuid,
      BatchSize: record.batchSize,
      MaximumBatchingWindowInSeconds: record.maximumBatchingWindowInSeconds ?? 0,
      EventSourceArn: record.eventSourceArn,
      FunctionArn: this.functionArn(region, record.functionName),
      LastModified: Math.floor(Date.parse(record.lastModified) / 1000),
      State: record.state,
      StateTransitionReason: 'USER_INITIATED',
    };
    if (record.startingPosition !== undefined) json.StartingPosition = record.startingPosition;
    if (record.maximumRetryAttempts !== undefined) json.MaximumRetryAttempts = record.maximumRetryAttempts;
    if (record.onFailureDestinationArn !== undefined) {
      json.DestinationConfig = { OnFailure: { Destination: record.onFailureDestinationArn } };
    }
    if (record.filterCriteria !== undefined) json.FilterCriteria = record.filterCriteria;
    // AWS always returns FunctionResponseTypes, defaulting to [].
    json.FunctionResponseTypes = record.functionResponseTypes ?? [];
    return json;
  }

  // Validates ESM FilterCriteria at write time, surfacing the AWS-shaped 400.
  private assertValidFilterCriteria(filterCriteria: unknown): void {
    try {
      validateFilterCriteria(filterCriteria);
    } catch (err) {
      throw new AwsError(
        'InvalidArgumentException',
        err instanceof Error ? err.message : 'Invalid FilterCriteria.',
        { status: 400 },
      );
    }
  }

  private fireEsmChanged(region: string): void {
    for (const listener of this.esmChangedListeners) {
      try {
        listener(region);
      } catch (err) {
        console.warn(`lambda-ctl: onEsmChanged listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
