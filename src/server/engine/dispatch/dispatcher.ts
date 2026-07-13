// The self engine's dispatcher: the single place events leave the emulators
// and enter Lambda code. Resolution order for a function ref (PRD RF4.5):
//   1. FunctionRegistry → LambdaRuntimeManager.invoke() in-process (the LSS
//      native runtime — no HTTP hop);
//   2. engine-absorbed function metadata with an INVOKE_URL env → HTTP POST in
//      the AWS Invoke shape (serverless-offline holdouts keep working);
//   3. a failed EngineInvokeResult (never a throw) + one warn per function.
// Also owns the bus consumers: S3 notification fan-out and EventBridge
// rule-matched target delivery, plus the SQS/stream delivery loop sets.

import http from 'http';
import { randomUUID } from 'crypto';
import type {
  DispatcherApi,
  EngineContext,
  EngineInvokeResult,
  EventRuleMatchedEvent,
  EventRuleTarget,
  S3ObjectEvent,
} from '../types.js';
import type { SqsEmulator } from '../emulators/sqs/index.js';
import type { DynamoDbEmulator } from '../emulators/dynamodb/index.js';
import type { S3Emulator, S3LambdaNotificationConfig } from '../emulators/s3/index.js';
import type { EventsEmulator } from '../emulators/events/index.js';
import type { LambdaCtlEmulator } from '../emulators/lambda-ctl/index.js';
import { SqsPollerSet } from './sqs-poller.js';
import { StreamTailerSet } from './stream-tailer.js';
import { resolveTargetInput } from './scheduler.js';
import { FunctionRegistry } from '../../services/function-registry.js';
import { LambdaRuntimeManager } from '../../services/lambda-runtime-manager.js';

export interface EngineDispatcherDeps {
  ctx: EngineContext;
  sqs: SqsEmulator;
  dynamo: DynamoDbEmulator;
  s3: S3Emulator;
  events: EventsEmulator;
  lambdaCtl: LambdaCtlEmulator;
  // Test hooks — delivery/backoff timing.
  tuning?: {
    s3RetryDelaysMs?: number[];
    sqsRuntimeRetryBackoffMs?: number[];
    streamRetryBackoffMs?: number;
  };
}

const DEFAULT_S3_RETRY_DELAYS_MS = [1000, 3000];
const INVOKE_URL_TIMEOUT_MS = 30_000;
const LAMBDA_ARN_REGION = /^arn:aws:lambda:([^:]+):/;
const SQS_ARN = /^arn:aws:sqs:([^:]+):[^:]+:(.+)$/;

export class EngineDispatcher implements DispatcherApi {
  private readonly deps: EngineDispatcherDeps;
  private readonly sqsPollers: SqsPollerSet;
  private readonly streamTailers: StreamTailerSet;
  private readonly warnedUnresolvable = new Set<string>();
  private started = false;
  private stopped = false;
  // Serializes ESM re-syncs triggered by lambda-ctl catalog changes.
  private syncChain: Promise<void> = Promise.resolve();
  private readonly s3Listener = (event: S3ObjectEvent): void => {
    void this.handleS3ObjectEvent(event);
  };
  private readonly ruleListener = (event: EventRuleMatchedEvent): void => {
    this.handleRuleMatched(event);
  };

  constructor(deps: EngineDispatcherDeps) {
    this.deps = deps;
    const invoke = this.invokeFunction.bind(this);
    this.sqsPollers = new SqsPollerSet({
      ctx: deps.ctx,
      sqs: deps.sqs,
      lambdaCtl: deps.lambdaCtl,
      invoke,
      runtimeRetryBackoffMs: deps.tuning?.sqsRuntimeRetryBackoffMs,
    });
    this.streamTailers = new StreamTailerSet({
      ctx: deps.ctx,
      dynamo: deps.dynamo,
      sqs: deps.sqs,
      lambdaCtl: deps.lambdaCtl,
      invoke,
      retryBackoffMs: deps.tuning?.streamRetryBackoffMs,
    });
  }

  // Boot rearm: loads the catalogs the sync loop APIs read, syncs delivery
  // loops from persisted ESMs and subscribes the bus consumers.
  async start(region: string): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.syncEventSourceMappings(region);
    this.deps.lambdaCtl.onEsmChanged(changedRegion => {
      this.syncChain = this.syncChain
        .then(() => this.syncEventSourceMappings(changedRegion))
        .catch(err => console.warn('[engine-dispatcher] ESM re-sync failed:', err));
    });
    this.deps.ctx.bus.on('s3:object-event', this.s3Listener);
    this.deps.ctx.bus.on('events:rule-matched', this.ruleListener);
  }

  stop(): void {
    this.stopped = true;
    this.sqsPollers.stopAll();
    this.streamTailers.stopAll();
    this.deps.ctx.bus.off('s3:object-event', this.s3Listener);
    this.deps.ctx.bus.off('events:rule-matched', this.ruleListener);
  }

  loopCounts(): { sqs: number; streams: number } {
    return { sqs: this.sqsPollers.loopCount(), streams: this.streamTailers.tailerCount() };
  }

  private async syncEventSourceMappings(region: string): Promise<void> {
    // The loop sets read sync emulator APIs, which only see loaded catalogs.
    await this.deps.lambdaCtl.ensureLoaded(region);
    await this.deps.sqs.ensureRegionLoaded(region);
    await this.deps.dynamo.primeRegion(region);
    this.sqsPollers.sync(region);
    this.streamTailers.sync(region);
  }

  // -------------------------------------------------------------------------
  // DispatcherApi
  // -------------------------------------------------------------------------

  async invokeFunction(ref: string, event: unknown, opts?: { async?: boolean }): Promise<EngineInvokeResult> {
    // 1. LSS-native runtime, in-process.
    const registered = FunctionRegistry.getInstance().resolve(ref);
    if (registered) {
      const run = async (): Promise<EngineInvokeResult> => {
        const result = await LambdaRuntimeManager.getInstance().invoke(registered.service.name, registered.fn, event);
        return result.ok
          ? { ok: true, payload: result.payload }
          : { ok: false, errorType: result.errorType, errorMessage: result.errorMessage };
      };
      return this.runMaybeAsync(ref, run, opts);
    }

    // 2. Engine-absorbed proxy metadata with a stored INVOKE_URL.
    const arnRegion = LAMBDA_ARN_REGION.exec(ref)?.[1];
    const record = this.deps.lambdaCtl.getFunctionRecord(arnRegion ?? this.deps.ctx.config.region, ref);
    const invokeUrl = record?.environment.INVOKE_URL;
    if (record && invokeUrl) {
      const name = record.environment.FUNCTION_NAME || record.functionName;
      return this.runMaybeAsync(ref, () => httpInvoke(invokeUrl, name, event), opts);
    }

    // 3. Nowhere to deliver.
    if (!this.warnedUnresolvable.has(ref)) {
      this.warnedUnresolvable.add(ref);
      console.warn(
        `[engine-dispatcher] function "${ref}" is not resolvable: not in the LSS runtime registry and ` +
          'no engine-registered function with an INVOKE_URL — events for it are dropped',
      );
    }
    return {
      ok: false,
      errorType: 'FunctionNotResolvable',
      errorMessage: `Function "${ref}" could not be resolved to an LSS runtime or an INVOKE_URL fallback`,
    };
  }

  // Fire-and-forget for async invocations: resolution already happened, so
  // callers get an immediate ok; execution failures are only logged.
  private runMaybeAsync(
    ref: string,
    run: () => Promise<EngineInvokeResult>,
    opts?: { async?: boolean },
  ): Promise<EngineInvokeResult> {
    if (!opts?.async) return run();
    void run()
      .then(result => {
        if (!result.ok) {
          console.warn(
            `[engine-dispatcher] async invoke of "${ref}" failed: ${result.errorType ?? 'Error'}: ${result.errorMessage ?? ''}`,
          );
        }
      })
      .catch(err => console.warn(`[engine-dispatcher] async invoke of "${ref}" crashed:`, err));
    return Promise.resolve({ ok: true });
  }

  // -------------------------------------------------------------------------
  // S3 notifications (PRD RF5.2)
  // -------------------------------------------------------------------------

  private async handleS3ObjectEvent(event: S3ObjectEvent): Promise<void> {
    let configs: S3LambdaNotificationConfig[];
    try {
      configs = await this.deps.s3.getNotificationConfiguration(event.bucket);
    } catch (err) {
      console.warn(`[engine-dispatcher] notification lookup for bucket ${event.bucket} failed:`, err);
      return;
    }
    for (const config of configs) {
      if (!s3EventMatches(config, event)) continue;
      void this.deliverS3Notification(config, event);
    }
  }

  private async deliverS3Notification(config: S3LambdaNotificationConfig, event: S3ObjectEvent): Promise<void> {
    const payload = buildS3NotificationPayload(config, event);
    const delays = this.deps.tuning?.s3RetryDelaysMs ?? DEFAULT_S3_RETRY_DELAYS_MS;
    let result = await this.invokeFunction(config.lambdaFunctionArn, payload);
    for (let retry = 0; !result.ok && retry < delays.length && !this.stopped; retry++) {
      await sleep(delays[retry]);
      if (this.stopped) return;
      result = await this.invokeFunction(config.lambdaFunctionArn, payload);
    }
    if (!result.ok) {
      console.warn(
        `[engine-dispatcher] S3 notification ${config.id} for s3://${event.bucket}/${event.key} dropped ` +
          `after ${delays.length + 1} attempts: ${result.errorType ?? 'Error'}: ${result.errorMessage ?? ''}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // EventBridge targets (PRD RF6.2)
  // -------------------------------------------------------------------------

  private handleRuleMatched(event: EventRuleMatchedEvent): void {
    for (const target of event.targets) {
      this.deliverToTarget(target, event.event, `rule ${event.ruleName}`);
    }
  }

  // Deliver a matched EventBridge event (rule or schedule) to one target,
  // dispatching by the target ARN's service: an SQS ARN enqueues the resolved
  // payload as a message; anything else (Lambda ARN or bare function name) is
  // invoked as a function. Shared by the rule-matched consumer and the
  // scheduler so both delivery paths cover the same target types.
  deliverToTarget(target: EventRuleTarget, envelope: Record<string, unknown>, sourceLabel: string): void {
    const payload = resolveTargetInput(target, envelope);
    const sqs = SQS_ARN.exec(target.arn);
    if (sqs) {
      const [, region, queueName] = sqs;
      // The message body is the resolved input serialized as JSON — matching
      // AWS, which delivers `Input` verbatim (a JSON string stays quoted) and
      // the event envelope as its JSON. `payload` is always JSON-safe (parsed
      // from Input / extracted from the envelope / the envelope itself).
      const body = JSON.stringify(payload ?? null);
      void this.deps.sqs
        .deliverMessage(region, queueName, body, { messageGroupId: target.sqsMessageGroupId })
        .then(delivered => {
          if (!delivered) {
            console.warn(
              `[engine-dispatcher] ${sourceLabel}: SQS target ${target.id} (${target.arn}) — ` +
                `queue "${queueName}" not found in ${region}; event dropped`,
            );
          }
        })
        .catch(err => console.warn(`[engine-dispatcher] ${sourceLabel}: SQS target ${target.id} failed:`, err));
      return;
    }
    void this.invokeFunction(target.arn, payload, { async: true }).then(result => {
      if (!result.ok) {
        console.warn(
          `[engine-dispatcher] ${sourceLabel}: target ${target.id} (${target.arn}) failed: ` +
            `${result.errorType ?? 'Error'}: ${result.errorMessage ?? ''}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// S3 notification helpers
// ---------------------------------------------------------------------------

// Config events are exact names ("s3:ObjectCreated:Put") or globs
// ("s3:ObjectCreated:*"); filter rules are prefix/suffix on the raw key.
function s3EventMatches(config: S3LambdaNotificationConfig, event: S3ObjectEvent): boolean {
  const eventOk = config.events.some(pattern =>
    pattern.endsWith('*') ? event.eventName.startsWith(pattern.slice(0, -1)) : event.eventName === pattern,
  );
  if (!eventOk) return false;
  for (const rule of config.filterRules) {
    if (rule.name === 'prefix' && !event.key.startsWith(rule.value)) return false;
    if (rule.name === 'suffix' && !event.key.endsWith(rule.value)) return false;
  }
  return true;
}

// AWS URL-encodes the object key in notification records, but keeps '/'.
function encodeS3Key(key: string): string {
  return encodeURIComponent(key).replace(/%2F/gi, '/');
}

function buildS3NotificationPayload(config: S3LambdaNotificationConfig, event: S3ObjectEvent): object {
  const requestId = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
  return {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: event.region,
        eventTime: new Date().toISOString(),
        // Record eventName drops the "s3:" prefix the config carries.
        eventName: event.eventName.replace(/^s3:/, ''),
        userIdentity: { principalId: 'AWS:SELFENGINE' },
        requestParameters: { sourceIPAddress: '127.0.0.1' },
        responseElements: {
          'x-amz-request-id': requestId,
          'x-amz-id-2': Buffer.from(requestId).toString('base64'),
        },
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: config.id,
          bucket: {
            name: event.bucket,
            ownerIdentity: { principalId: 'SELFENGINE' },
            arn: `arn:aws:s3:::${event.bucket}`,
          },
          object: {
            key: encodeS3Key(event.key),
            size: event.size,
            eTag: event.eTag,
            sequencer: event.sequencer,
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// INVOKE_URL HTTP fallback (absorbed LocalStack proxies / serverless-offline)
// ---------------------------------------------------------------------------

function httpInvoke(invokeUrl: string, functionName: string, event: unknown): Promise<EngineInvokeResult> {
  return new Promise(resolve => {
    let url: URL;
    try {
      url = new URL(`${invokeUrl.replace(/\/$/, '')}/2015-03-31/functions/${functionName}/invocations`);
    } catch (err) {
      resolve({
        ok: false,
        errorType: 'InvocationFailed',
        errorMessage: `Invalid INVOKE_URL "${invokeUrl}": ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const body = JSON.stringify(event ?? {});
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Amz-Invocation-Type': 'RequestResponse',
        },
        timeout: INVOKE_URL_TIMEOUT_MS,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk as Buffer));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({
              ok: false,
              errorType: 'InvocationFailed',
              errorMessage: `POST ${url.href} returned ${status}: ${text.slice(0, 200)}`,
            });
            return;
          }
          let payload: unknown = text;
          try {
            payload = text.length > 0 ? JSON.parse(text) : undefined;
          } catch {
            // Non-JSON body: hand it over verbatim.
          }
          resolve({ ok: true, payload });
        });
        response.on('error', err => {
          resolve({ ok: false, errorType: 'InvocationFailed', errorMessage: err.message });
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`invoke timed out after ${INVOKE_URL_TIMEOUT_MS} ms`));
    });
    request.on('error', err => {
      resolve({ ok: false, errorType: 'InvocationFailed', errorMessage: `POST ${url.href} failed: ${err.message}` });
    });
    request.end(body);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
