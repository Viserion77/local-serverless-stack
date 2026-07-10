// SQS emulator: AWS JSON 1.0 (X-Amz-Target: AmazonSQS.<Operation>). Queue
// ATTRIBUTES persist in the engine store catalog `sqs/<region>/queues`;
// MESSAGES are memory-only (transient dev data — graceful shutdown snapshots
// them through serializeMessages()/restoreMessages(), wired by the backend).
//
// Fidelity ground truth is LSS's own SDK consumers: resource-provisioner
// branches on err.name 'QueueAlreadyExists' / substring 'NonExistentQueue',
// queue-inspector reads the live Approximate* counters and CreatedTimestamp.

import { AwsError, notImplemented } from '../../http/errors.js';
import type {
  AwsRequest,
  EngineContext,
  EngineServiceName,
  TargetEmulator,
} from '../../types.js';
import type { CatalogStore } from '../../store/store-types.js';
import { SqsQueue } from './queue.js';
import type { SendMessageOutcome, SerializedQueueMessages, StoredMessage } from './queue.js';
import { md5OfMessageAttributes } from './md5.js';
import type { SqsMessageAttributeValue } from './md5.js';

// Persisted per-queue metadata. `attributes` holds exactly what the client
// set (CreateQueue/SetQueueAttributes) — defaults are applied at read time.
interface QueueRecord {
  name: string;
  fifo: boolean;
  attributes: Record<string, string>;
  // Epoch seconds, as SQS reports them.
  createdTimestamp: number;
  lastModifiedTimestamp: number;
}

// One message handed to the dispatcher for Lambda delivery (already marked
// in-flight with the queue's VisibilityTimeout).
export interface DeliveredMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, SqsMessageAttributeValue>;
  md5OfBody: string;
  md5OfMessageAttributes?: string;
  sentTimestamp: number;
  approximateReceiveCount: number;
  messageGroupId?: string;
  sequenceNumber?: string;
}

export interface SqsMessagesSnapshot {
  queues: Array<{ region: string; queueName: string; state: SerializedQueueMessages }>;
}

interface BatchResultError {
  Id: string;
  SenderFault: boolean;
  Code: string;
  Message: string;
}

interface SendMessageWireInput {
  MessageBody?: string;
  DelaySeconds?: number;
  MessageAttributes?: Record<string, SqsMessageAttributeValue>;
  MessageGroupId?: string;
  MessageDeduplicationId?: string;
}

// Read-time defaults for attributes the client did not set. Also the
// baseline for CreateQueue's idempotency comparison: an omitted attribute
// counts as its default, so re-creating with explicit defaults still matches.
const ATTRIBUTE_DEFAULTS: Record<string, string> = {
  VisibilityTimeout: '30',
  DelaySeconds: '0',
  MessageRetentionPeriod: '345600',
  ReceiveMessageWaitTimeSeconds: '0',
  MaximumMessageSize: '262144',
  FifoQueue: 'false',
  ContentBasedDeduplication: 'false',
};

const VALID_QUEUE_NAME = /^[A-Za-z0-9_-]{1,80}$/;

export function queueNameFromArn(arn: string): string {
  return arn.slice(arn.lastIndexOf(':') + 1);
}

function sqsJsonError(code: string, modelName: string, message: string): AwsError {
  return new AwsError(code, message, { typeName: `com.amazonaws.sqs#${modelName}` });
}

function nonExistentQueueError(): AwsError {
  // Legacy compat code (feeds the router's x-amzn-query-error header, which
  // the SDK's awsQueryCompatible trait rewrites err.name from) + modern JSON
  // __type. QueueInspector's not-found mapping keys on the legacy name.
  return sqsJsonError(
    'AWS.SimpleQueueService.NonExistentQueue',
    'QueueDoesNotExist',
    'The specified queue does not exist for this wsdl version.',
  );
}

function invalidParameterError(message: string): AwsError {
  return sqsJsonError('InvalidParameterValue', 'InvalidParameterValue', message);
}

function missingParameterError(name: string): AwsError {
  return sqsJsonError('MissingParameter', 'MissingParameter', `The request must contain the parameter ${name}.`);
}

function receiptHandleInvalidError(receiptHandle: string): AwsError {
  return sqsJsonError(
    'ReceiptHandleIsInvalid',
    'ReceiptHandleIsInvalid',
    `The input receipt handle "${receiptHandle}" is not a valid receipt handle.`,
  );
}

function integerParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

// Batch envelope validation shared by SendMessageBatch/DeleteMessageBatch.
function checkBatchEntries(entries: Array<{ Id?: string }> | undefined): asserts entries {
  if (!entries || entries.length === 0) {
    throw sqsJsonError(
      'AWS.SimpleQueueService.EmptyBatchRequest',
      'EmptyBatchRequest',
      'There should be at least one entry in the request.',
    );
  }
  if (entries.length > 10) {
    throw sqsJsonError(
      'AWS.SimpleQueueService.TooManyEntriesInBatchRequest',
      'TooManyEntriesInBatchRequest',
      `Maximum number of entries per request are 10. You have sent ${entries.length}.`,
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = entry.Id ?? '';
    if (seen.has(id)) {
      throw sqsJsonError(
        'AWS.SimpleQueueService.BatchEntryIdsNotDistinct',
        'BatchEntryIdsNotDistinct',
        `Id ${id} repeated.`,
      );
    }
    seen.add(id);
  }
}

export class SqsEmulator implements TargetEmulator {
  readonly service: EngineServiceName = 'sqs';
  readonly targetPrefix = 'AmazonSQS';
  readonly jsonVersion = '1.0' as const;

  private readonly ctx: EngineContext;
  // Loaded catalogs by region; the sync dispatcher API only sees regions a
  // wire call (or ensureRegionLoaded) already touched.
  private readonly catalogs = new Map<string, CatalogStore<QueueRecord>>();
  // Live message state by `${region}/${queueName}`.
  private readonly runtimes = new Map<string, SqsQueue>();

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
  }

  async handle(operation: string, input: Record<string, unknown>, req: AwsRequest): Promise<object> {
    const region = req.region;
    const catalog = await this.catalogFor(region);
    switch (operation) {
      case 'CreateQueue':
        return this.createQueue(region, catalog, input);
      case 'GetQueueUrl':
        return this.getQueueUrl(catalog, input);
      case 'GetQueueAttributes':
        return this.getQueueAttributes(region, catalog, input);
      case 'SetQueueAttributes':
        return this.setQueueAttributes(catalog, input);
      case 'ListQueues':
        return this.listQueues(catalog, input);
      case 'DeleteQueue':
        return this.deleteQueue(region, catalog, input);
      case 'SendMessage':
        return this.sendMessage(region, catalog, input);
      case 'SendMessageBatch':
        return this.sendMessageBatch(region, catalog, input);
      case 'ReceiveMessage':
        return this.receiveMessage(region, catalog, input);
      case 'DeleteMessage':
        return this.deleteMessage(region, catalog, input);
      case 'DeleteMessageBatch':
        return this.deleteMessageBatch(region, catalog, input);
      case 'PurgeQueue':
        return this.purgeQueue(region, catalog, input);
      case 'ChangeMessageVisibility':
        return this.changeMessageVisibility(region, catalog, input);
      default:
        throw notImplemented('sqs', operation);
    }
  }

  // ------------------------------------------------------------------
  // Dispatcher API (in-process event source mappings; sync by design)
  // ------------------------------------------------------------------

  queueExists(region: string, queueName: string): boolean {
    return this.catalogs.get(region)?.get(queueName) !== undefined;
  }

  hasVisibleMessages(region: string, queueName: string): boolean {
    const record = this.catalogs.get(region)?.get(queueName);
    const runtime = this.runtimes.get(`${region}/${queueName}`);
    if (!record || !runtime) return false;
    return runtime.hasDeliverable(this.attrMs(record, 'MessageRetentionPeriod'));
  }

  // Marks up to `max` messages in-flight with the queue's VisibilityTimeout
  // and returns them shaped for the Lambda `Records` payload.
  receiveForDelivery(region: string, queueName: string, max: number): DeliveredMessage[] {
    const record = this.catalogs.get(region)?.get(queueName);
    if (!record) return [];
    const runtime = this.runtimeFor(region, record);
    const messages = runtime.receive({
      max,
      visibilityMs: this.attrMs(record, 'VisibilityTimeout'),
      retentionMs: this.attrMs(record, 'MessageRetentionPeriod'),
    });
    return messages.map(message => ({
      messageId: message.messageId,
      // receive() always assigns a fresh handle to delivered messages.
      receiptHandle: message.receiptHandle ?? '',
      body: message.body,
      attributes: this.systemAttributes(message, record.fifo),
      messageAttributes: message.messageAttributes ?? {},
      md5OfBody: message.md5OfBody,
      md5OfMessageAttributes: message.md5OfMessageAttributes,
      sentTimestamp: message.sentTimestamp,
      approximateReceiveCount: message.receiveCount,
      messageGroupId: message.messageGroupId,
      sequenceNumber: message.sequenceNumber,
    }));
  }

  deleteDelivered(region: string, queueName: string, receiptHandles: string[]): void {
    const runtime = this.runtimes.get(`${region}/${queueName}`);
    if (!runtime) return;
    for (const handle of receiptHandles) runtime.deleteMessage(handle);
  }

  // Boot wiring: load a region's queue catalog before the dispatcher's sync
  // API touches it (rearming ESMs from persisted metadata).
  async ensureRegionLoaded(region: string): Promise<void> {
    await this.catalogFor(region);
  }

  // ------------------------------------------------------------------
  // Graceful-shutdown snapshot (round-2 wiring in the self backend)
  // ------------------------------------------------------------------

  serializeMessages(): SqsMessagesSnapshot {
    const queues: SqsMessagesSnapshot['queues'] = [];
    for (const [key, runtime] of this.runtimes) {
      const region = key.slice(0, key.indexOf('/'));
      queues.push({ region, queueName: runtime.name, state: runtime.serialize() });
    }
    return { queues };
  }

  restoreMessages(snapshot: SqsMessagesSnapshot): void {
    for (const queue of snapshot.queues) {
      const key = `${queue.region}/${queue.queueName}`;
      let runtime = this.runtimes.get(key);
      if (!runtime) {
        runtime = this.newRuntime(queue.region, queue.queueName, queue.queueName.endsWith('.fifo'));
        this.runtimes.set(key, runtime);
      }
      runtime.restore(queue.state);
    }
  }

  // ------------------------------------------------------------------
  // Operations
  // ------------------------------------------------------------------

  private createQueue(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const name = typeof input.QueueName === 'string' ? input.QueueName : '';
    const requested = (input.Attributes ?? {}) as Record<string, string>;
    const fifo = requested.FifoQueue === 'true';

    const validName = fifo
      ? name.endsWith('.fifo') && VALID_QUEUE_NAME.test(name.slice(0, -'.fifo'.length)) && name.length <= 80
      : VALID_QUEUE_NAME.test(name);
    if (!validName) {
      throw invalidParameterError(
        'Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length',
      );
    }

    const existing = catalog.get(name);
    if (existing) {
      const keys = new Set([...Object.keys(requested), ...Object.keys(existing.attributes)]);
      for (const key of keys) {
        const requestedValue = requested[key] ?? ATTRIBUTE_DEFAULTS[key];
        const existingValue = existing.attributes[key] ?? ATTRIBUTE_DEFAULTS[key];
        if (requestedValue !== existingValue) {
          // Error-name duality: the JSON model calls this QueueNameExists
          // (the __type we serialize), but SDKs with the awsQueryCompatible
          // trait rewrite err.name from the x-amzn-query-error header the
          // router builds out of `code` — and the provisioner catches the
          // legacy name, so `code` must stay 'QueueAlreadyExists'.
          throw new AwsError(
            'QueueAlreadyExists',
            `A queue already exists with the same name and a different value for attribute ${key}`,
            { typeName: 'com.amazonaws.sqs#QueueNameExists' },
          );
        }
      }
      return { QueueUrl: this.queueUrl(existing.name) };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const record: QueueRecord = {
      name,
      fifo,
      attributes: { ...requested },
      createdTimestamp: nowSeconds,
      lastModifiedTimestamp: nowSeconds,
    };
    catalog.set(name, record);
    this.runtimeFor(region, record);
    return { QueueUrl: this.queueUrl(name) };
  }

  private getQueueUrl(catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const name = typeof input.QueueName === 'string' ? input.QueueName : '';
    const record = catalog.get(name);
    if (!record) throw nonExistentQueueError();
    return { QueueUrl: this.queueUrl(record.name) };
  }

  private getQueueAttributes(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    const requested = (input.AttributeNames ?? []) as string[];
    if (requested.length === 0) return {};

    const runtime = this.runtimeFor(region, record);
    const counters = runtime.counters(this.attrMs(record, 'MessageRetentionPeriod'));
    const all: Record<string, string> = {
      // Stored attributes pass through first (RedrivePolicy and friends)…
      ...record.attributes,
      // …then read-time defaults for the standard set the client didn't set.
      VisibilityTimeout: record.attributes.VisibilityTimeout ?? ATTRIBUTE_DEFAULTS.VisibilityTimeout,
      DelaySeconds: record.attributes.DelaySeconds ?? ATTRIBUTE_DEFAULTS.DelaySeconds,
      MessageRetentionPeriod:
        record.attributes.MessageRetentionPeriod ?? ATTRIBUTE_DEFAULTS.MessageRetentionPeriod,
      ReceiveMessageWaitTimeSeconds:
        record.attributes.ReceiveMessageWaitTimeSeconds ?? ATTRIBUTE_DEFAULTS.ReceiveMessageWaitTimeSeconds,
      MaximumMessageSize: record.attributes.MaximumMessageSize ?? ATTRIBUTE_DEFAULTS.MaximumMessageSize,
      QueueArn: this.queueArn(region, record.name),
      ApproximateNumberOfMessages: String(counters.available),
      ApproximateNumberOfMessagesNotVisible: String(counters.inFlight),
      ApproximateNumberOfMessagesDelayed: String(counters.delayed),
      CreatedTimestamp: String(record.createdTimestamp),
      LastModifiedTimestamp: String(record.lastModifiedTimestamp),
    };
    if (record.fifo) {
      all.FifoQueue = 'true';
      all.ContentBasedDeduplication =
        record.attributes.ContentBasedDeduplication ?? ATTRIBUTE_DEFAULTS.ContentBasedDeduplication;
    }

    if (requested.includes('All')) return { Attributes: all };
    const picked: Record<string, string> = {};
    for (const name of requested) {
      if (all[name] !== undefined) picked[name] = all[name];
    }
    return { Attributes: picked };
  }

  private setQueueAttributes(catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    const updates = (input.Attributes ?? {}) as Record<string, string>;
    record.attributes = { ...record.attributes, ...updates };
    record.lastModifiedTimestamp = Math.floor(Date.now() / 1000);
    catalog.set(record.name, record);
    return {};
  }

  private listQueues(catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const prefix = typeof input.QueueNamePrefix === 'string' ? input.QueueNamePrefix : '';
    const urls = catalog
      .keys()
      .filter(name => name.startsWith(prefix))
      .sort()
      .map(name => this.queueUrl(name));
    return urls.length > 0 ? { QueueUrls: urls } : {};
  }

  private deleteQueue(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    catalog.delete(record.name);
    const key = `${region}/${record.name}`;
    this.runtimes.get(key)?.dispose();
    this.runtimes.delete(key);
    return {};
  }

  private sendMessage(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    const runtime = this.runtimeFor(region, record);
    return this.sendOne(record, runtime, input as SendMessageWireInput);
  }

  private sendMessageBatch(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    const runtime = this.runtimeFor(region, record);
    const entries = input.Entries as Array<SendMessageWireInput & { Id?: string }> | undefined;
    checkBatchEntries(entries);

    const successful: Array<Record<string, unknown>> = [];
    const failed: BatchResultError[] = [];
    for (const entry of entries) {
      try {
        successful.push({ Id: entry.Id, ...this.sendOne(record, runtime, entry) });
      } catch (error) {
        if (!(error instanceof AwsError)) throw error;
        failed.push({
          Id: entry.Id ?? '',
          SenderFault: error.fault !== 'Receiver',
          Code: error.code,
          Message: error.message,
        });
      }
    }
    return { Successful: successful, Failed: failed };
  }

  private sendOne(record: QueueRecord, runtime: SqsQueue, input: SendMessageWireInput): Record<string, unknown> {
    if (typeof input.MessageBody !== 'string' || input.MessageBody.length === 0) {
      throw missingParameterError('MessageBody');
    }
    const delaySeconds = integerParam(input.DelaySeconds);
    if (delaySeconds !== undefined && record.fifo) {
      throw invalidParameterError(
        `Value ${delaySeconds} for parameter DelaySeconds is invalid. Reason: The request include parameter that is not valid for this queue type.`,
      );
    }
    if (delaySeconds !== undefined && (delaySeconds < 0 || delaySeconds > 900)) {
      throw invalidParameterError(
        `Value ${delaySeconds} for parameter DelaySeconds is invalid. Reason: DelaySeconds must be >= 0 and <= 900.`,
      );
    }
    if (record.fifo && !input.MessageGroupId) {
      throw missingParameterError('MessageGroupId');
    }
    if (
      record.fifo &&
      !input.MessageDeduplicationId &&
      (record.attributes.ContentBasedDeduplication ?? 'false') !== 'true'
    ) {
      throw invalidParameterError(
        'The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly',
      );
    }

    const outcome: SendMessageOutcome = runtime.send({
      body: input.MessageBody,
      delayMs: (delaySeconds ?? this.attrInt(record, 'DelaySeconds')) * 1000,
      messageAttributes: input.MessageAttributes,
      messageGroupId: input.MessageGroupId,
      messageDeduplicationId: input.MessageDeduplicationId,
      contentBasedDeduplication: record.attributes.ContentBasedDeduplication === 'true',
    });

    const result: Record<string, unknown> = {
      MessageId: outcome.messageId,
      MD5OfMessageBody: outcome.md5OfBody,
    };
    if (outcome.md5OfMessageAttributes) result.MD5OfMessageAttributes = outcome.md5OfMessageAttributes;
    if (outcome.sequenceNumber) result.SequenceNumber = outcome.sequenceNumber;
    return result;
  }

  private async receiveMessage(
    region: string,
    catalog: CatalogStore<QueueRecord>,
    input: Record<string, unknown>,
  ): Promise<object> {
    const record = this.requireQueue(catalog, input);
    const max = integerParam(input.MaxNumberOfMessages) ?? 1;
    if (max < 1 || max > 10) {
      throw sqsJsonError(
        'ReadCountOutOfRange',
        'ReadCountOutOfRange',
        `Value ${max} for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.`,
      );
    }
    const visibilitySeconds = integerParam(input.VisibilityTimeout);
    if (visibilitySeconds !== undefined && (visibilitySeconds < 0 || visibilitySeconds > 43200)) {
      throw invalidParameterError(
        `Value ${visibilitySeconds} for parameter VisibilityTimeout is invalid. Reason: Must be >= 0 and <= 43200, if provided.`,
      );
    }
    const visibilityMs = (visibilitySeconds ?? this.attrInt(record, 'VisibilityTimeout')) * 1000;
    const retentionMs = this.attrMs(record, 'MessageRetentionPeriod');
    const waitSeconds =
      integerParam(input.WaitTimeSeconds) ?? this.attrInt(record, 'ReceiveMessageWaitTimeSeconds');
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 20) * 1000;

    // Modern SDKs send MessageSystemAttributeNames; older ones AttributeNames.
    const systemNames = [
      ...((input.AttributeNames as string[] | undefined) ?? []),
      ...((input.MessageSystemAttributeNames as string[] | undefined) ?? []),
    ];
    const attributeNames = (input.MessageAttributeNames as string[] | undefined) ?? [];

    const key = `${region}/${record.name}`;
    for (;;) {
      // Re-fetched every lap: the queue may be deleted while we are parked
      // (dispose() wakes us) — treat that as an empty receive.
      const runtime = this.runtimes.get(key);
      if (!runtime) return {};
      const messages = runtime.receive({ max, visibilityMs, retentionMs });
      if (messages.length > 0) {
        return {
          Messages: messages.map(message =>
            this.shapeMessage(message, record.fifo, systemNames, attributeNames),
          ),
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return {};
      // Long poll: park until a message becomes visible or the wait elapses.
      await runtime.waitForVisible(remaining);
    }
  }

  private deleteMessage(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    const handle = typeof input.ReceiptHandle === 'string' ? input.ReceiptHandle : '';
    const result = this.runtimeFor(region, record).deleteMessage(handle);
    if (result === 'invalid') throw receiptHandleInvalidError(handle);
    return {};
  }

  private deleteMessageBatch(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    const runtime = this.runtimeFor(region, record);
    const entries = input.Entries as Array<{ Id?: string; ReceiptHandle?: string }> | undefined;
    checkBatchEntries(entries);

    const successful: Array<{ Id: string }> = [];
    const failed: BatchResultError[] = [];
    for (const entry of entries) {
      const handle = entry.ReceiptHandle ?? '';
      if (runtime.deleteMessage(handle) === 'invalid') {
        failed.push({
          Id: entry.Id ?? '',
          SenderFault: true,
          Code: 'ReceiptHandleIsInvalid',
          Message: `The input receipt handle "${handle}" is not a valid receipt handle.`,
        });
      } else {
        successful.push({ Id: entry.Id ?? '' });
      }
    }
    return { Successful: successful, Failed: failed };
  }

  private purgeQueue(region: string, catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): object {
    const record = this.requireQueue(catalog, input);
    this.runtimeFor(region, record).purge();
    return {};
  }

  private changeMessageVisibility(
    region: string,
    catalog: CatalogStore<QueueRecord>,
    input: Record<string, unknown>,
  ): object {
    const record = this.requireQueue(catalog, input);
    const handle = typeof input.ReceiptHandle === 'string' ? input.ReceiptHandle : '';
    const visibilitySeconds = integerParam(input.VisibilityTimeout);
    if (visibilitySeconds === undefined || visibilitySeconds < 0 || visibilitySeconds > 43200) {
      throw invalidParameterError(
        `Value ${input.VisibilityTimeout} for parameter VisibilityTimeout is invalid. Reason: Must be >= 0 and <= 43200, if provided.`,
      );
    }
    const result = this.runtimeFor(region, record).changeVisibility(handle, visibilitySeconds * 1000);
    if (result === 'invalid') throw receiptHandleInvalidError(handle);
    if (result === 'not-inflight') {
      throw sqsJsonError(
        'AWS.SimpleQueueService.MessageNotInflight',
        'MessageNotInflight',
        'The message referred to is not in flight.',
      );
    }
    return {};
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async catalogFor(region: string): Promise<CatalogStore<QueueRecord>> {
    const existing = this.catalogs.get(region);
    if (existing) return existing;
    const catalog = this.ctx.store.catalog<QueueRecord>(`sqs/${region}/queues`);
    await catalog.load();
    this.catalogs.set(region, catalog);
    return catalog;
  }

  private runtimeFor(region: string, record: QueueRecord): SqsQueue {
    const key = `${region}/${record.name}`;
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = this.newRuntime(region, record.name, record.fifo);
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  private newRuntime(region: string, queueName: string, fifo: boolean): SqsQueue {
    return new SqsQueue(queueName, {
      fifo,
      onVisible: () => this.ctx.bus.emit('sqs:message-visible', { region, queueName }),
    });
  }

  // Resolve `input.QueueUrl` (last path segment is the queue name) to its
  // catalog record or fail like AWS does for unknown queues.
  private requireQueue(catalog: CatalogStore<QueueRecord>, input: Record<string, unknown>): QueueRecord {
    const url = typeof input.QueueUrl === 'string' ? input.QueueUrl : '';
    if (!url) throw missingParameterError('QueueUrl');
    const name = url.replace(/\/+$/, '').split('/').pop() ?? '';
    const record = catalog.get(name);
    if (!record) throw nonExistentQueueError();
    return record;
  }

  private queueUrl(queueName: string): string {
    return `${this.ctx.endpoint()}/${this.ctx.config.account}/${queueName}`;
  }

  private queueArn(region: string, queueName: string): string {
    return `arn:aws:sqs:${region}:${this.ctx.config.account}:${queueName}`;
  }

  private attrInt(record: QueueRecord, name: string): number {
    return parseInt(record.attributes[name] ?? ATTRIBUTE_DEFAULTS[name] ?? '0', 10);
  }

  private attrMs(record: QueueRecord, name: string): number {
    return this.attrInt(record, name) * 1000;
  }

  private systemAttributes(message: StoredMessage, fifo: boolean): Record<string, string> {
    const attributes: Record<string, string> = {
      SenderId: this.ctx.config.account,
      SentTimestamp: String(message.sentTimestamp),
      ApproximateReceiveCount: String(message.receiveCount),
      ApproximateFirstReceiveTimestamp: String(message.firstReceiveTimestamp ?? message.sentTimestamp),
    };
    if (fifo) {
      if (message.messageGroupId) attributes.MessageGroupId = message.messageGroupId;
      if (message.messageDeduplicationId) {
        attributes.MessageDeduplicationId = message.messageDeduplicationId;
      }
      if (message.sequenceNumber) attributes.SequenceNumber = message.sequenceNumber;
    }
    return attributes;
  }

  private shapeMessage(
    message: StoredMessage,
    fifo: boolean,
    systemNames: string[],
    attributeNames: string[],
  ): Record<string, unknown> {
    const wire: Record<string, unknown> = {
      MessageId: message.messageId,
      ReceiptHandle: message.receiptHandle,
      MD5OfBody: message.md5OfBody,
      Body: message.body,
    };

    if (systemNames.length > 0) {
      const all = this.systemAttributes(message, fifo);
      const picked = systemNames.includes('All')
        ? all
        : Object.fromEntries(Object.entries(all).filter(([name]) => systemNames.includes(name)));
      if (Object.keys(picked).length > 0) wire.Attributes = picked;
    }

    if (message.messageAttributes && attributeNames.length > 0) {
      const wantAll = attributeNames.includes('All') || attributeNames.includes('.*');
      const picked = Object.fromEntries(
        Object.entries(message.messageAttributes).filter(
          ([name]) =>
            wantAll ||
            attributeNames.some(pattern =>
              pattern.endsWith('.*') ? name.startsWith(pattern.slice(0, -2)) : name === pattern,
            ),
        ),
      );
      if (Object.keys(picked).length > 0) {
        wire.MessageAttributes = picked;
        // AWS digests exactly the returned (filtered) attribute set.
        wire.MD5OfMessageAttributes = md5OfMessageAttributes(picked);
      }
    }
    return wire;
  }
}
