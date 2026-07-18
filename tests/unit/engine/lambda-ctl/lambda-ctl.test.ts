// Route matrix, error contract, ESM lifecycle, invoke passthrough and catalog
// persistence for the Lambda control-plane emulator. The store is an in-test
// fake implementing store-types (the real engine store is a sibling module
// still under construction); it persists catalogs as JSON files on a temp dir
// so the round-trip test exercises real disk state.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { LambdaCtlEmulator } from '../../../../src/server/engine/emulators/lambda-ctl/index.js';
import type { LambdaFunctionRecord } from '../../../../src/server/engine/emulators/lambda-ctl/index.js';
import { AwsError } from '../../../../src/server/engine/http/errors.js';
import { EngineBus } from '../../../../src/server/engine/bus.js';
import type { CatalogStore, EngineStore, ItemTable } from '../../../../src/server/engine/store/store-types.js';
import type {
  AwsRequest,
  AwsResponse,
  DispatcherApi,
  EngineContext,
  EngineInvokeResult,
} from '../../../../src/server/engine/types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeCatalog<T> implements CatalogStore<T> {
  private map = new Map<string, T>();
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as Record<string, T>;
      for (const [key, value] of Object.entries(parsed)) this.map.set(key, value);
    } catch {
      // missing/corrupt file → empty catalog
    }
    this.loaded = true;
  }

  // The emulator must await load() before touching a catalog — throwing here
  // pins that discipline.
  private assertLoaded(): void {
    if (!this.loaded) throw new Error(`catalog ${this.file} touched before load()`);
  }

  get(key: string): T | undefined {
    this.assertLoaded();
    return this.map.get(key);
  }

  set(key: string, value: T): void {
    this.assertLoaded();
    this.map.set(key, value);
  }

  delete(key: string): boolean {
    this.assertLoaded();
    return this.map.delete(key);
  }

  keys(): string[] {
    this.assertLoaded();
    return [...this.map.keys()];
  }

  values(): T[] {
    this.assertLoaded();
    return [...this.map.values()];
  }

  async flush(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)));
  }
}

class FakeStore implements EngineStore {
  private catalogs = new Map<string, FakeCatalog<unknown>>();

  constructor(private readonly root: string) {}

  dir(...segments: string[]): string {
    return path.join(this.root, ...segments);
  }

  catalog<T>(relPath: string): CatalogStore<T> {
    let existing = this.catalogs.get(relPath);
    if (!existing) {
      existing = new FakeCatalog<unknown>(path.join(this.root, `${relPath}.json`));
      this.catalogs.set(relPath, existing);
    }
    return existing as CatalogStore<T>;
  }

  table(_relPath: string): ItemTable {
    throw new Error('not used by lambda-ctl');
  }

  async writeBlob(_relDir: string, _data: Buffer): Promise<string> {
    throw new Error('not used by lambda-ctl');
  }

  async readBlob(_blobPath: string): Promise<Buffer> {
    throw new Error('not used by lambda-ctl');
  }

  async deleteBlob(_blobPath: string): Promise<void> {
    throw new Error('not used by lambda-ctl');
  }

  startSweeper(): void {}
  stopSweeper(): void {}

  async flushAll(): Promise<void> {
    for (const catalog of this.catalogs.values()) await catalog.flush();
  }
}

class FakeDispatcher implements DispatcherApi {
  calls: Array<{ ref: string; event: unknown; opts: { async?: boolean } | undefined }> = [];
  result: EngineInvokeResult = { ok: true, payload: { echoed: true } };

  async invokeFunction(ref: string, event: unknown, opts?: { async?: boolean }): Promise<EngineInvokeResult> {
    this.calls.push({ ref, event, opts });
    return this.result;
  }
}

function makeCtx(root: string): { ctx: EngineContext; dispatcher: FakeDispatcher; store: FakeStore } {
  const store = new FakeStore(root);
  const dispatcher = new FakeDispatcher();
  const ctx: EngineContext = {
    config: {
      port: 14566,
      dataDir: root,
      account: '000000000000',
      region: 'us-east-1',
      idleUnloadMs: 300000,
      memoryBudgetMb: 128,
      fsync: false,
      fallbackEndpoint: null,
      persistence: true,
    },
    store,
    bus: new EngineBus(),
    dispatcher,
    endpoint: () => 'http://127.0.0.1:14566',
  };
  return { ctx, dispatcher, store };
}

function makeReq(
  method: string,
  rawPath: string,
  opts: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string>; region?: string } = {},
): AwsRequest {
  let body: Buffer;
  if (opts.body === undefined) body = Buffer.alloc(0);
  else if (typeof opts.body === 'string') body = Buffer.from(opts.body, 'utf8');
  else body = Buffer.from(JSON.stringify(opts.body), 'utf8');
  return {
    method,
    rawPath,
    query: opts.query ?? {},
    headers: opts.headers ?? {},
    body,
    service: 'lambda',
    region: opts.region ?? 'us-east-1',
    requestId: 'test-request-id',
  };
}

interface FunctionConfigJson {
  FunctionName?: string;
  FunctionArn?: string;
  Runtime?: string;
  Handler?: string;
  MemorySize?: number;
  Timeout?: number;
  Environment?: { Variables?: Record<string, string> };
  Version?: string;
  State?: string;
  LastUpdateStatus?: string;
  LastModified?: string;
}

interface MappingJson {
  UUID?: string;
  State?: string;
  StateTransitionReason?: string;
  BatchSize?: number;
  MaximumBatchingWindowInSeconds?: number;
  MaximumRetryAttempts?: number;
  StartingPosition?: string;
  EventSourceArn?: string;
  FunctionArn?: string;
  DestinationConfig?: { OnFailure?: { Destination?: string } };
  FilterCriteria?: unknown;
  FunctionResponseTypes?: string[];
  LastModified?: number;
}

function parseBody<T>(res: AwsResponse): T {
  return JSON.parse(String(res.body)) as T;
}

async function expectAwsError(
  promise: Promise<unknown>,
  code: string,
  status: number,
  message?: string | RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AwsError);
  const error = caught as AwsError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  if (typeof message === 'string') expect(error.message).toBe(message);
  else if (message) expect(error.message).toMatch(message);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const REGION = 'us-east-1';
const FN = 'pro-sample-dev-processOrderQueue';
const FN_ARN = `arn:aws:lambda:${REGION}:000000000000:function:${FN}`;
const QUEUE_ARN = `arn:aws:sqs:${REGION}:000000000000:order-processing-queue`;

describe('LambdaCtlEmulator', () => {
  let root: string;
  let ctx: EngineContext;
  let dispatcher: FakeDispatcher;
  let store: FakeStore;
  let emulator: LambdaCtlEmulator;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-lambda-ctl-'));
    ({ ctx, dispatcher, store } = makeCtx(root));
    emulator = new LambdaCtlEmulator(ctx);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function createProxy(name = FN, env?: Record<string, string>): Promise<AwsResponse> {
    return emulator.handle(makeReq('POST', '/2015-03-31/functions', {
      body: {
        FunctionName: name,
        Runtime: 'nodejs20.x',
        Role: 'arn:aws:iam::000000000000:role/lambda-role',
        Handler: 'index.handler',
        Code: { ZipFile: 'UEsDBBQAAAAIAFAKE=' },
        Environment: {
          Variables: env ?? { INVOKE_URL: 'http://127.0.0.1:13001', FUNCTION_NAME: name },
        },
        MemorySize: 256,
        Timeout: 60,
      },
    }));
  }

  async function createMapping(body: Record<string, unknown>): Promise<MappingJson> {
    const res = await emulator.handle(makeReq('POST', '/2015-03-31/event-source-mappings', { body }));
    expect(res.status).toBe(202);
    return parseBody<MappingJson>(res);
  }

  describe('CreateFunction (absorbed proxies)', () => {
    it('stores metadata only, keeps INVOKE_URL, discards Code.ZipFile', async () => {
      const res = await createProxy();
      expect(res.status).toBe(201);
      const config = parseBody<FunctionConfigJson>(res);
      expect(config.FunctionName).toBe(FN);
      expect(config.FunctionArn).toBe(FN_ARN);
      expect(config.Runtime).toBe('nodejs20.x');
      expect(config.Handler).toBe('index.handler');
      expect(config.MemorySize).toBe(256);
      expect(config.Timeout).toBe(60);
      expect(config.State).toBe('Active');
      expect(config.LastUpdateStatus).toBe('Successful');
      expect(config.Environment?.Variables?.INVOKE_URL).toBe('http://127.0.0.1:13001');
      expect(config.LastModified).toMatch(/\+0000$/);

      const record = emulator.getFunctionRecord(REGION, FN);
      expect(record?.environment.INVOKE_URL).toBe('http://127.0.0.1:13001');
      expect(record?.environment.FUNCTION_NAME).toBe(FN);
      // The zip must not survive anywhere in the persisted record.
      expect(JSON.stringify(record)).not.toContain('UEsDBBQAAAAIAFAKE=');
    });

    it('rejects a duplicate with the exact ResourceConflictException the provisioner swallows', async () => {
      await createProxy();
      await expectAwsError(createProxy(), 'ResourceConflictException', 409, `Function already exist: ${FN}`);
    });

    it('rejects a missing FunctionName', async () => {
      const req = makeReq('POST', '/2015-03-31/functions', { body: { Runtime: 'nodejs20.x' } });
      await expectAwsError(emulator.handle(req), 'ValidationException', 400);
    });

    it('rejects an unparseable JSON body', async () => {
      const req = makeReq('POST', '/2015-03-31/functions', { body: '{nope' });
      await expectAwsError(emulator.handle(req), 'InvalidRequestContentException', 400);
    });
  });

  describe('GetFunction', () => {
    it('returns {Configuration, Code: {}}', async () => {
      await createProxy();
      const res = await emulator.handle(makeReq('GET', `/2015-03-31/functions/${FN}`));
      expect(res.status).toBe(200);
      const body = parseBody<{ Configuration: FunctionConfigJson; Code: Record<string, never> }>(res);
      expect(body.Configuration.FunctionArn).toBe(FN_ARN);
      expect(body.Configuration.Environment?.Variables?.INVOKE_URL).toBe('http://127.0.0.1:13001');
      expect(body.Code).toEqual({});
    });

    it('resolves an ARN in the path to the bare name', async () => {
      await createProxy();
      const res = await emulator.handle(makeReq('GET', `/2015-03-31/functions/${encodeURIComponent(FN_ARN)}`));
      expect(res.status).toBe(200);
      expect(parseBody<{ Configuration: FunctionConfigJson }>(res).Configuration.FunctionName).toBe(FN);
    });

    it('404s with the arn-bearing message ensureLambdaProxyExists branches on', async () => {
      await expectAwsError(
        emulator.handle(makeReq('GET', '/2015-03-31/functions/ghost')),
        'ResourceNotFoundException',
        404,
        `Function not found: arn:aws:lambda:${REGION}:000000000000:function:ghost`,
      );
    });
  });

  describe('UpdateFunctionConfiguration', () => {
    it('re-points a stale INVOKE_URL, replacing Environment.Variables wholesale', async () => {
      await createProxy();
      const res = await emulator.handle(makeReq('PUT', `/2015-03-31/functions/${FN}/configuration`, {
        body: { Environment: { Variables: { INVOKE_URL: 'http://127.0.0.1:13099', FUNCTION_NAME: FN } } },
      }));
      expect(res.status).toBe(200);
      const config = parseBody<FunctionConfigJson>(res);
      expect(config.Environment?.Variables?.INVOKE_URL).toBe('http://127.0.0.1:13099');
      // Untouched fields survive the merge.
      expect(config.Timeout).toBe(60);
      expect(config.MemorySize).toBe(256);
      expect(config.Handler).toBe('index.handler');
      expect(emulator.getFunctionRecord(REGION, FN)?.environment.INVOKE_URL).toBe('http://127.0.0.1:13099');
    });

    it('merges scalar fields without clearing the environment', async () => {
      await createProxy();
      const res = await emulator.handle(makeReq('PUT', `/2015-03-31/functions/${FN}/configuration`, {
        body: { Timeout: 120, MemorySize: 512, Handler: 'index.main', Runtime: 'nodejs22.x' },
      }));
      const config = parseBody<FunctionConfigJson>(res);
      expect(config.Timeout).toBe(120);
      expect(config.MemorySize).toBe(512);
      expect(config.Handler).toBe('index.main');
      expect(config.Runtime).toBe('nodejs22.x');
      expect(config.Environment?.Variables?.INVOKE_URL).toBe('http://127.0.0.1:13001');
    });

    it('404s on a missing function', async () => {
      const req = makeReq('PUT', '/2015-03-31/functions/ghost/configuration', { body: { Timeout: 5 } });
      await expectAwsError(emulator.handle(req), 'ResourceNotFoundException', 404);
    });
  });

  describe('DeleteFunction', () => {
    it('returns 204, removes the function and cascades its ESMs', async () => {
      await createProxy();
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      const regions: string[] = [];
      emulator.onEsmChanged(region => regions.push(region));

      const res = await emulator.handle(makeReq('DELETE', `/2015-03-31/functions/${FN}`));
      expect(res.status).toBe(204);
      expect(emulator.getFunctionRecord(REGION, FN)).toBeUndefined();
      expect(emulator.listEventSourceMappings(REGION)).toEqual([]);
      expect(regions).toEqual([REGION]);
      await expectAwsError(
        emulator.handle(makeReq('GET', `/2015-03-31/event-source-mappings/${mapping.UUID}`)),
        'ResourceNotFoundException',
        404,
      );
    });

    it('404s on a missing function and fires no ESM callback', async () => {
      const regions: string[] = [];
      emulator.onEsmChanged(region => regions.push(region));
      await expectAwsError(emulator.handle(makeReq('DELETE', '/2015-03-31/functions/ghost')), 'ResourceNotFoundException', 404);
      expect(regions).toEqual([]);
    });
  });

  describe('ListFunctions', () => {
    it('returns every registered function configuration', async () => {
      await createProxy('fn-a');
      await createProxy('fn-b');
      const res = await emulator.handle(makeReq('GET', '/2015-03-31/functions'));
      expect(res.status).toBe(200);
      const body = parseBody<{ Functions: FunctionConfigJson[] }>(res);
      expect(body.Functions.map(f => f.FunctionName).sort()).toEqual(['fn-a', 'fn-b']);
    });
  });

  describe('AddPermission / RemovePermission', () => {
    const ruleArn = `arn:aws:events:${REGION}:000000000000:rule/user-events/on-signup`;

    async function addPermission(sid = 'events-invoke-on-signup'): Promise<AwsResponse> {
      return emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/policy`, {
        body: { StatementId: sid, Action: 'lambda:InvokeFunction', Principal: 'events.amazonaws.com', SourceArn: ruleArn },
      }));
    }

    it('records the statement and returns it as a JSON string', async () => {
      await createProxy();
      const res = await addPermission();
      expect(res.status).toBe(201);
      const statement = JSON.parse(parseBody<{ Statement: string }>(res).Statement);
      expect(statement).toEqual({
        Sid: 'events-invoke-on-signup',
        Effect: 'Allow',
        Action: 'lambda:InvokeFunction',
        Resource: FN_ARN,
        Principal: { Service: 'events.amazonaws.com' },
        Condition: { ArnLike: { 'AWS:SourceArn': ruleArn } },
      });
      const record = emulator.getFunctionRecord(REGION, FN);
      expect(record?.statements?.['events-invoke-on-signup']?.Sid).toBe('events-invoke-on-signup');
    });

    it('409s on a duplicate StatementId (the provisioner swallows it by name)', async () => {
      await createProxy();
      await addPermission();
      await expectAwsError(addPermission(), 'ResourceConflictException', 409, /statement id \(events-invoke-on-signup\)/);
    });

    it('404s when the function does not exist', async () => {
      await expectAwsError(addPermission(), 'ResourceNotFoundException', 404);
    });

    it('rejects a missing StatementId', async () => {
      await createProxy();
      const req = makeReq('POST', `/2015-03-31/functions/${FN}/policy`, { body: { Principal: 's3.amazonaws.com' } });
      await expectAwsError(emulator.handle(req), 'ValidationException', 400);
    });

    it('RemovePermission returns 204 and frees the StatementId for re-add', async () => {
      await createProxy();
      await addPermission();
      const res = await emulator.handle(makeReq('DELETE', `/2015-03-31/functions/${FN}/policy/events-invoke-on-signup`));
      expect(res.status).toBe(204);
      expect(emulator.getFunctionRecord(REGION, FN)?.statements?.['events-invoke-on-signup']).toBeUndefined();
      expect((await addPermission()).status).toBe(201);
    });

    it('RemovePermission 404s on an unknown StatementId', async () => {
      await createProxy();
      const req = makeReq('DELETE', `/2015-03-31/functions/${FN}/policy/nope`);
      await expectAwsError(emulator.handle(req), 'ResourceNotFoundException', 404);
    });
  });

  describe('CreateEventSourceMapping', () => {
    it('stores the bare name when FunctionName arrives as an ARN, with defaults applied', async () => {
      const regions: string[] = [];
      emulator.onEsmChanged(region => regions.push(region));
      const mapping = await createMapping({ FunctionName: FN_ARN, EventSourceArn: QUEUE_ARN });
      expect(mapping.UUID).toBeDefined();
      expect(mapping.State).toBe('Enabled');
      expect(mapping.BatchSize).toBe(10);
      expect(mapping.EventSourceArn).toBe(QUEUE_ARN);
      expect(mapping.FunctionArn).toBe(FN_ARN);
      expect(regions).toEqual([REGION]);

      const records = emulator.listEventSourceMappings(REGION);
      expect(records).toHaveLength(1);
      expect(records[0].functionName).toBe(FN);
      expect(records[0].enabled).toBe(true);
    });

    it('maps every optional stream-source field', async () => {
      const streamArn = `arn:aws:dynamodb:${REGION}:000000000000:table/orders/stream/2026-07-10T00:00:00.000`;
      const dlqArn = `arn:aws:sqs:${REGION}:000000000000:orders-dlq`;
      const filter = { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] };
      const mapping = await createMapping({
        FunctionName: FN,
        EventSourceArn: streamArn,
        Enabled: false,
        BatchSize: 25,
        StartingPosition: 'TRIM_HORIZON',
        MaximumRetryAttempts: 2,
        MaximumBatchingWindowInSeconds: 5,
        DestinationConfig: { OnFailure: { Destination: dlqArn } },
        FilterCriteria: filter,
      });
      expect(mapping.State).toBe('Disabled');
      expect(mapping.BatchSize).toBe(25);
      expect(mapping.StartingPosition).toBe('TRIM_HORIZON');
      expect(mapping.MaximumRetryAttempts).toBe(2);
      expect(mapping.MaximumBatchingWindowInSeconds).toBe(5);
      expect(mapping.DestinationConfig).toEqual({ OnFailure: { Destination: dlqArn } });
      expect(mapping.FilterCriteria).toEqual(filter);

      const record = emulator.listEventSourceMappings(REGION)[0];
      expect(record.enabled).toBe(false);
      expect(record.startingPosition).toBe('TRIM_HORIZON');
      expect(record.onFailureDestinationArn).toBe(dlqArn);
      expect(record.maximumRetryAttempts).toBe(2);
      expect(record.filterCriteria).toEqual(filter);
    });

    it('defaults MaximumRetryAttempts to -1 for a stream source, leaving SQS sources untouched', async () => {
      const streamArn = `arn:aws:dynamodb:${REGION}:000000000000:table/orders/stream/2026-07-10T00:00:00.000`;
      const stream = await createMapping({ FunctionName: FN, EventSourceArn: streamArn, StartingPosition: 'TRIM_HORIZON' });
      expect(stream.MaximumRetryAttempts).toBe(-1);
      expect(emulator.listEventSourceMappings(REGION).find(m => m.eventSourceArn === streamArn)!.maximumRetryAttempts).toBe(-1);

      const sqs = await createMapping({ FunctionName: 'sqs-fn', EventSourceArn: QUEUE_ARN });
      expect(sqs.MaximumRetryAttempts).toBeUndefined();
      expect(emulator.listEventSourceMappings(REGION).find(m => m.eventSourceArn === QUEUE_ARN)!.maximumRetryAttempts).toBeUndefined();
    });

    it('round-trips FunctionResponseTypes and defaults it to [] when omitted', async () => {
      const withRbif = await createMapping({
        FunctionName: FN,
        EventSourceArn: QUEUE_ARN,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      });
      expect(withRbif.FunctionResponseTypes).toEqual(['ReportBatchItemFailures']);
      expect(emulator.listEventSourceMappings(REGION)[0].functionResponseTypes).toEqual(['ReportBatchItemFailures']);

      const without = await createMapping({ FunctionName: 'plain-fn', EventSourceArn: `arn:aws:sqs:${REGION}:000000000000:plain` });
      expect(without.FunctionResponseTypes).toEqual([]);
    });

    it('applies FunctionResponseTypes on update and echoes it back', async () => {
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      const res = await emulator.handle(makeReq('PUT', `/2015-03-31/event-source-mappings/${mapping.UUID}`, {
        body: { FunctionResponseTypes: ['ReportBatchItemFailures'] },
      }));
      expect(parseBody<MappingJson & { FunctionResponseTypes?: string[] }>(res).FunctionResponseTypes)
        .toEqual(['ReportBatchItemFailures']);
    });

    it('accepts valid FilterCriteria (numeric/anything-but/prefix/exists) and echoes them unchanged', async () => {
      const filter = {
        Filters: [
          { Pattern: '{"dynamodb":{"NewImage":{"price":{"N":[{"numeric":[">",50]}]}}}}' },
          { Pattern: '{"eventName":[{"anything-but":"REMOVE"}]}' },
          { Pattern: '{"eventName":[{"prefix":"MOD"}]}' },
          { Pattern: '{"dynamodb":{"NewImage":{"status":{"S":[{"exists":true}]}}}}' },
        ],
      };
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN, FilterCriteria: filter });
      expect(mapping.FilterCriteria).toEqual(filter);
    });

    it('rejects invalid FilterCriteria with InvalidArgumentException (400)', async () => {
      await expectAwsError(
        emulator.handle(makeReq('POST', '/2015-03-31/event-source-mappings', {
          body: { FunctionName: FN, EventSourceArn: QUEUE_ARN, FilterCriteria: { Filters: [{ Pattern: '{not json' }] } },
        })),
        'InvalidArgumentException',
        400,
      );
      await expectAwsError(
        emulator.handle(makeReq('POST', '/2015-03-31/event-source-mappings', {
          body: { FunctionName: FN, EventSourceArn: QUEUE_ARN, FilterCriteria: { Filters: [{ Pattern: '{"source":[{"suffix":".users"}]}' }] } },
        })),
        'InvalidArgumentException',
        400,
      );
      const sixFilters = { Filters: Array.from({ length: 6 }, (_, i) => ({ Pattern: `{"n":[${i}]}` })) };
      await expectAwsError(
        emulator.handle(makeReq('POST', '/2015-03-31/event-source-mappings', {
          body: { FunctionName: FN, EventSourceArn: QUEUE_ARN, FilterCriteria: sixFilters },
        })),
        'InvalidArgumentException',
        400,
      );
    });

    it('requires EventSourceArn', async () => {
      const req = makeReq('POST', '/2015-03-31/event-source-mappings', { body: { FunctionName: FN } });
      await expectAwsError(emulator.handle(req), 'InvalidParameterValueException', 400);
    });

    it('requires FunctionName', async () => {
      const req = makeReq('POST', '/2015-03-31/event-source-mappings', { body: { EventSourceArn: QUEUE_ARN } });
      await expectAwsError(emulator.handle(req), 'ValidationException', 400);
    });

    it('409s on a duplicate source+function pair, naming the existing UUID', async () => {
      const first = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      const req = makeReq('POST', '/2015-03-31/event-source-mappings', {
        body: { FunctionName: FN_ARN, EventSourceArn: QUEUE_ARN },
      });
      await expectAwsError(
        emulator.handle(req),
        'ResourceConflictException',
        409,
        `An event source mapping with SQS arn (" ${QUEUE_ARN} ") and function (" ${FN} ") already exists. ` +
          `Please use the existing mapping with UUID ${first.UUID}`,
      );
    });
  });

  describe('ListEventSourceMappings', () => {
    const otherArn = `arn:aws:sqs:${REGION}:000000000000:other-queue`;

    beforeEach(async () => {
      await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      await createMapping({ FunctionName: 'other-fn', EventSourceArn: otherArn });
    });

    async function list(query?: Record<string, string>): Promise<MappingJson[]> {
      const res = await emulator.handle(makeReq('GET', '/2015-03-31/event-source-mappings', { query }));
      expect(res.status).toBe(200);
      return parseBody<{ EventSourceMappings: MappingJson[] }>(res).EventSourceMappings;
    }

    it('returns every mapping without filters', async () => {
      expect(await list()).toHaveLength(2);
    });

    it('filters by EventSourceArn', async () => {
      const mappings = await list({ EventSourceArn: QUEUE_ARN });
      expect(mappings).toHaveLength(1);
      expect(mappings[0].EventSourceArn).toBe(QUEUE_ARN);
    });

    it('filters by FunctionName given as a bare name or an ARN', async () => {
      const byName = await list({ FunctionName: FN });
      expect(byName).toHaveLength(1);
      expect(byName[0].FunctionArn).toBe(FN_ARN);
      const byArn = await list({ FunctionName: FN_ARN });
      expect(byArn).toHaveLength(1);
      expect(byArn[0].FunctionArn).toBe(FN_ARN);
    });
  });

  describe('Get/Update/DeleteEventSourceMapping', () => {
    it('gets a mapping by uuid and 404s with the exact AWS message otherwise', async () => {
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      const res = await emulator.handle(makeReq('GET', `/2015-03-31/event-source-mappings/${mapping.UUID}`));
      expect(res.status).toBe(200);
      expect(parseBody<MappingJson>(res).UUID).toBe(mapping.UUID);
      await expectAwsError(
        emulator.handle(makeReq('GET', '/2015-03-31/event-source-mappings/00000000-0000-0000-0000-000000000000')),
        'ResourceNotFoundException',
        404,
        'The resource you requested does not exist.',
      );
    });

    it('toggles Enabled (QueueInspector hold/release) and notifies the dispatcher each time', async () => {
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      const regions: string[] = [];
      emulator.onEsmChanged(region => regions.push(region));

      const hold = await emulator.handle(makeReq('PUT', `/2015-03-31/event-source-mappings/${mapping.UUID}`, {
        body: { Enabled: false },
      }));
      expect(hold.status).toBe(202);
      expect(parseBody<MappingJson>(hold).State).toBe('Disabled');
      expect(emulator.listEventSourceMappings(REGION)[0].enabled).toBe(false);

      const release = await emulator.handle(makeReq('PUT', `/2015-03-31/event-source-mappings/${mapping.UUID}`, {
        body: { Enabled: true },
      }));
      expect(parseBody<MappingJson>(release).State).toBe('Enabled');
      expect(emulator.listEventSourceMappings(REGION)[0].enabled).toBe(true);
      expect(regions).toEqual([REGION, REGION]);
    });

    it('updates BatchSize and other tunables', async () => {
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      const res = await emulator.handle(makeReq('PUT', `/2015-03-31/event-source-mappings/${mapping.UUID}`, {
        body: { BatchSize: 1, MaximumBatchingWindowInSeconds: 3 },
      }));
      const updated = parseBody<MappingJson>(res);
      expect(updated.BatchSize).toBe(1);
      expect(updated.MaximumBatchingWindowInSeconds).toBe(3);
      // Enabled untouched when not sent.
      expect(updated.State).toBe('Enabled');
    });

    it('404s when updating or deleting an unknown uuid', async () => {
      await emulator.ensureLoaded(REGION);
      await expectAwsError(
        emulator.handle(makeReq('PUT', '/2015-03-31/event-source-mappings/nope', { body: { Enabled: false } })),
        'ResourceNotFoundException',
        404,
        'The resource you requested does not exist.',
      );
      await expectAwsError(
        emulator.handle(makeReq('DELETE', '/2015-03-31/event-source-mappings/nope')),
        'ResourceNotFoundException',
        404,
      );
    });

    it('deletes with 202 returning the record, and notifies the dispatcher', async () => {
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
      const regions: string[] = [];
      emulator.onEsmChanged(region => regions.push(region));
      const res = await emulator.handle(makeReq('DELETE', `/2015-03-31/event-source-mappings/${mapping.UUID}`));
      expect(res.status).toBe(202);
      expect(parseBody<MappingJson>(res).UUID).toBe(mapping.UUID);
      expect(emulator.listEventSourceMappings(REGION)).toEqual([]);
      expect(regions).toEqual([REGION]);
    });

    it('keeps serving the request when an onEsmChanged listener throws', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        emulator.onEsmChanged(() => {
          throw new Error('listener boom');
        });
        const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN });
        expect(mapping.UUID).toBeDefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener boom'));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('Invoke passthrough', () => {
    it('RequestResponse: forwards the parsed payload and returns the result JSON', async () => {
      await createProxy();
      dispatcher.result = { ok: true, payload: { statusCode: 200, body: 'done' } };
      const res = await emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/invocations`, {
        body: { orderId: 42 },
      }));
      expect(res.status).toBe(200);
      expect(parseBody<{ statusCode: number }>(res).statusCode).toBe(200);
      expect(res.headers?.['x-amz-function-error']).toBeUndefined();
      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0].ref).toBe(FN);
      expect(dispatcher.calls[0].event).toEqual({ orderId: 42 });
      expect(dispatcher.calls[0].opts).toEqual({ async: false });
    });

    it('RequestResponse: handler errors are 200 + X-Amz-Function-Error: Unhandled', async () => {
      await createProxy();
      dispatcher.result = { ok: false, errorType: 'TypeError', errorMessage: 'boom' };
      const res = await emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/invocations`, {
        body: { orderId: 42 },
      }));
      expect(res.status).toBe(200);
      expect(res.headers?.['x-amz-function-error']).toBe('Unhandled');
      expect(parseBody<{ errorType: string; errorMessage: string }>(res)).toEqual({
        errorType: 'TypeError',
        errorMessage: 'boom',
      });
    });

    it('Event: returns 202 with no payload and dispatches async', async () => {
      await createProxy();
      const res = await emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/invocations`, {
        body: { fire: 'forget' },
        headers: { 'x-amz-invocation-type': 'Event' },
      }));
      expect(res.status).toBe(202);
      expect(res.body).toBeUndefined();
      expect(dispatcher.calls[0].opts).toEqual({ async: true });
    });

    it('DryRun: 204 without invoking; 404 for an unknown function', async () => {
      await createProxy();
      const res = await emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/invocations`, {
        headers: { 'x-amz-invocation-type': 'DryRun' },
      }));
      expect(res.status).toBe(204);
      expect(dispatcher.calls).toHaveLength(0);
      await expectAwsError(
        emulator.handle(makeReq('POST', '/2015-03-31/functions/ghost/invocations', {
          headers: { 'x-amz-invocation-type': 'DryRun' },
        })),
        'ResourceNotFoundException',
        404,
      );
    });

    it('accepts an ARN in the invoke path', async () => {
      await createProxy();
      const res = await emulator.handle(makeReq('POST', `/2015-03-31/functions/${encodeURIComponent(FN_ARN)}/invocations`, {
        body: {},
      }));
      expect(res.status).toBe(200);
      expect(dispatcher.calls[0].ref).toBe(FN);
    });

    it('404s when the function is neither in the catalog nor dispatcher-resolvable', async () => {
      dispatcher.result = { ok: false, errorType: 'ResourceNotFoundException', errorMessage: 'not registered' };
      await emulator.ensureLoaded(REGION);
      await expectAwsError(
        emulator.handle(makeReq('POST', '/2015-03-31/functions/ghost/invocations', { body: {} })),
        'ResourceNotFoundException',
        404,
        `Function not found: arn:aws:lambda:${REGION}:000000000000:function:ghost`,
      );
    });

    it('serves registry-resolvable functions that have no catalog record', async () => {
      dispatcher.result = { ok: true, payload: 'live' };
      const res = await emulator.handle(makeReq('POST', '/2015-03-31/functions/registry-only-fn/invocations', {
        body: { ping: true },
      }));
      expect(res.status).toBe(200);
      expect(String(res.body)).toBe('"live"');
    });

    it('handler errors on cataloged functions never turn into 404s', async () => {
      await createProxy();
      dispatcher.result = { ok: false, errorType: 'ResourceNotFoundException', errorMessage: 'from handler' };
      const res = await emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/invocations`, { body: {} }));
      expect(res.status).toBe(200);
      expect(res.headers?.['x-amz-function-error']).toBe('Unhandled');
    });

    it('passes {} for an empty body and renders undefined payloads as null', async () => {
      await createProxy();
      dispatcher.result = { ok: true };
      const res = await emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/invocations`));
      expect(res.status).toBe(200);
      expect(String(res.body)).toBe('null');
      expect(dispatcher.calls[0].event).toEqual({});
    });

    it('rejects an unparseable payload', async () => {
      await createProxy();
      const req = makeReq('POST', `/2015-03-31/functions/${FN}/invocations`, { body: '{nope' });
      await expectAwsError(emulator.handle(req), 'InvalidRequestContentException', 400);
      expect(dispatcher.calls).toHaveLength(0);
    });
  });

  describe('routing edges', () => {
    it('rejects unknown prefixes, resources and methods with NotImplemented', async () => {
      await expectAwsError(emulator.handle(makeReq('GET', '/2020-01-01/functions')), 'NotImplemented', 400);
      await expectAwsError(emulator.handle(makeReq('GET', '/2015-03-31/layers')), 'NotImplemented', 400);
      await expectAwsError(emulator.handle(makeReq('PATCH', '/2015-03-31/functions')), 'NotImplemented', 400);
      await expectAwsError(emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/aliases`)), 'NotImplemented', 400);
      await expectAwsError(emulator.handle(makeReq('PATCH', '/2015-03-31/event-source-mappings/x')), 'NotImplemented', 400);
    });

    it('scopes catalogs by region', async () => {
      await createProxy();
      await emulator.ensureLoaded('eu-west-1');
      expect(emulator.getFunctionRecord('eu-west-1', FN)).toBeUndefined();
      expect(emulator.getFunctionRecord(REGION, FN)).toBeDefined();
    });
  });

  describe('catalog persistence round trip', () => {
    it('rehydrates functions (with statements) and ESMs from disk into a fresh emulator', async () => {
      await createProxy();
      await emulator.handle(makeReq('POST', `/2015-03-31/functions/${FN}/policy`, {
        body: { StatementId: 's3-invoke', Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com' },
      }));
      const mapping = await createMapping({ FunctionName: FN, EventSourceArn: QUEUE_ARN, BatchSize: 5 });
      await store.flushAll();

      // Fresh store + emulator over the same data dir = engine restart.
      const restarted = makeCtx(root);
      const emulator2 = new LambdaCtlEmulator(restarted.ctx);
      await emulator2.ensureLoaded(REGION);

      const record: LambdaFunctionRecord | undefined = emulator2.getFunctionRecord(REGION, FN);
      expect(record?.environment.INVOKE_URL).toBe('http://127.0.0.1:13001');
      expect(record?.statements?.['s3-invoke']?.Principal).toEqual({ Service: 's3.amazonaws.com' });

      const mappings = emulator2.listEventSourceMappings(REGION);
      expect(mappings).toHaveLength(1);
      expect(mappings[0].uuid).toBe(mapping.UUID);
      expect(mappings[0].batchSize).toBe(5);
      expect(mappings[0].functionName).toBe(FN);

      // Routes see the rehydrated state too (UUIDs preserved across restarts).
      const res = await emulator2.handle(makeReq('GET', `/2015-03-31/event-source-mappings/${mapping.UUID}`));
      expect(parseBody<MappingJson>(res).UUID).toBe(mapping.UUID);
    });
  });
});
