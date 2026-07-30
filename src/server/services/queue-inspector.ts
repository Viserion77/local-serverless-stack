import {
  SQSClient,
  ListQueuesCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  type MessageAttributeValue,
} from '@aws-sdk/client-sqs';
import {
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import { LocalStackManager } from './localstack-manager.js';

export interface QueueConsumer {
  functionName: string;
  uuid?: string;
  state?: string;
  batchSize?: number;
  enabled: boolean;
}

export interface QueueSnapshot {
  name: string;
  url: string;
  arn?: string;
  available: number;
  inFlight: number;
  delayed: number;
  processed: number;
  total: number;
  fifo: boolean;
  visibilityTimeout?: number;
  messageRetentionPeriod?: number;
  createdAt?: number;
  lastModifiedAt?: number;
  consumers: QueueConsumer[];
  lastPolledAt: number;
}

interface QueueMetricsState {
  lastAvailable: number;
  lastInFlight: number;
  processed: number;
}

export interface CapturedMessage {
  messageId?: string;
  body?: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, { type?: string; value?: string }>;
  receivedAt: number;
}

interface HeldQueueState {
  uuids: string[];
  captured: CapturedMessage[];
  heldAt: number;
}

export interface SqsAttributeInput {
  name: string;
  type?: 'String' | 'Number' | 'Binary';
  value: string;
}

export interface SendMessageInput {
  body: string;
  delaySeconds?: number;
  messageAttributes?: SqsAttributeInput[];
  messageGroupId?: string;
  messageDeduplicationId?: string;
}

export interface SendMessageResult {
  messageId?: string;
  sequenceNumber?: string;
  md5OfBody?: string;
}

export interface SqsMessage {
  messageId?: string;
  receiptHandle?: string;
  body?: string;
  md5OfBody?: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, { type?: string; value?: string }>;
}

export interface ReceiveMessagesInput {
  maxNumberOfMessages?: number;
  visibilityTimeout?: number;
  waitTimeSeconds?: number;
}

export class QueueInspector {
  private static instance: QueueInspector;
  private sqsClients = new Map<string, SQSClient>();
  private lambdaClients = new Map<string, LambdaClient>();
  private metrics = new Map<string, QueueMetricsState>();
  // Queues currently "held": their consumer event source mappings are disabled
  // and messages are captured on demand. Keyed by resolved queue URL. In-memory
  // only — lost on restart (see holdQueue caveats).
  private held = new Map<string, HeldQueueState>();
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly pollFrequencyMs = 5000;
  private defaultRegion = 'us-east-1';

  private constructor() {
    const region = LocalStackManager.getInstance().getConfig().region;
    if (region) this.defaultRegion = region;
  }

  static getInstance(): QueueInspector {
    if (!QueueInspector.instance) {
      QueueInspector.instance = new QueueInspector();
    }
    return QueueInspector.instance;
  }

  setDefaultRegion(region: string): void {
    if (region) this.defaultRegion = region;
  }

  private sqsClientFor(region?: string): SQSClient {
    const r = region || this.defaultRegion;
    let client = this.sqsClients.get(r);
    if (!client) {
      const base = LocalStackManager.getInstance().getConfig();
      client = new SQSClient({ ...base, region: r });
      this.sqsClients.set(r, client);
    }
    return client;
  }

  private lambdaClientFor(region?: string): LambdaClient {
    const r = region || this.defaultRegion;
    let client = this.lambdaClients.get(r);
    if (!client) {
      const base = LocalStackManager.getInstance().getConfig();
      client = new LambdaClient({ ...base, region: r });
      this.lambdaClients.set(r, client);
    }
    return client;
  }

  startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      // refreshMetrics swallows its own errors, so this catch arm never fires.
      this.refreshMetrics().catch(/* istanbul ignore next */ () => undefined);
    }, this.pollFrequencyMs);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async listQueues(region?: string): Promise<QueueSnapshot[]> {
    const queueUrls = await this.fetchQueueUrls(region);
    const eventSourceMap = await this.fetchEventSourceMappingsByQueueArn(region);

    const snapshots = await Promise.all(
      queueUrls.map(url => this.buildSnapshot(url, eventSourceMap, region)),
    );
    return snapshots.filter((s): s is QueueSnapshot => s !== null);
  }

  async getQueue(queueName: string, region?: string): Promise<QueueSnapshot | null> {
    try {
      const url = await this.resolveQueueUrl(queueName, region);
      if (!url) return null;
      const eventSourceMap = await this.fetchEventSourceMappingsByQueueArn(region);
      return await this.buildSnapshot(url, eventSourceMap, region);
    } catch {
      /* istanbul ignore next: resolveQueueUrl/fetchEventSourceMappings/buildSnapshot all swallow their own errors */
      return null;
    }
  }

  /**
   * Block until the queue is idle (no available and no in-flight messages),
   * polling its counters every `pollIntervalMs`. Returns `drained: true` once
   * idle (and, if `sinceProcessed` is given, once `processed >= sinceProcessed`),
   * or `drained: false` on timeout. Returns null when the queue does not exist.
   *
   * Each poll forces a fresh metrics read rather than waiting on the ~5s
   * background poller, so callers get a deterministic, fast answer.
   */
  async awaitIdle(
    queueName: string,
    opts: { timeoutMs?: number; sinceProcessed?: number; pollIntervalMs?: number } = {},
    region?: string,
  ): Promise<{ name: string; available: number; inFlight: number; processed: number; drained: boolean } | null> {
    const url = await this.resolveQueueUrl(queueName, region);
    if (!url) return null;

    const timeoutMs = opts.timeoutMs ?? 15000;
    const poll = opts.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const m = await this.updateMetricsForQueue(url, region);
      const processed = this.metrics.get(url)?.processed ?? 0;

      if (
        m &&
        m.available === 0 &&
        m.inFlight === 0 &&
        (opts.sinceProcessed == null || processed >= opts.sinceProcessed)
      ) {
        return { name: queueName, available: m.available, inFlight: m.inFlight, processed, drained: true };
      }

      // A null `m` means a transient fetch failure (LocalStack briefly down) —
      // treat it as "not idle yet" and keep polling until the deadline.
      if (Date.now() >= deadline) {
        const last = this.metrics.get(url);
        return {
          name: queueName,
          available: m?.available ?? last?.lastAvailable ?? 0,
          inFlight: m?.inFlight ?? last?.lastInFlight ?? 0,
          processed: last?.processed ?? 0,
          drained: false,
        };
      }

      await this.sleep(poll);
    }
  }

  async sendMessage(
    queueName: string,
    input: SendMessageInput,
    region?: string,
  ): Promise<SendMessageResult> {
    const url = await this.resolveQueueUrl(queueName, region);
    if (!url) throw new Error(`Queue not found: ${queueName}`);

    const attrs: Record<string, MessageAttributeValue> | undefined =
      input.messageAttributes && input.messageAttributes.length
        ? Object.fromEntries(
            input.messageAttributes
              .filter(a => a.name)
              .map(a => [
                a.name,
                { DataType: a.type || 'String', StringValue: a.value } as MessageAttributeValue,
              ]),
          )
        : undefined;

    const isFifo = queueName.endsWith('.fifo');
    const response = await this.sqsClientFor(region).send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: input.body,
        DelaySeconds: !isFifo && input.delaySeconds !== undefined ? input.delaySeconds : undefined,
        MessageAttributes: attrs,
        MessageGroupId: isFifo ? input.messageGroupId || 'default' : undefined,
        MessageDeduplicationId: isFifo ? input.messageDeduplicationId : undefined,
      }),
    );

    return {
      messageId: response.MessageId,
      sequenceNumber: response.SequenceNumber,
      md5OfBody: response.MD5OfMessageBody,
    };
  }

  async receiveMessages(
    queueName: string,
    input: ReceiveMessagesInput,
    region?: string,
  ): Promise<SqsMessage[]> {
    const url = await this.resolveQueueUrl(queueName, region);
    if (!url) throw new Error(`Queue not found: ${queueName}`);

    const max = Math.min(Math.max(input.maxNumberOfMessages ?? 10, 1), 10);
    const wait = Math.min(Math.max(input.waitTimeSeconds ?? 0, 0), 20);
    const visibility = input.visibilityTimeout !== undefined
      ? Math.max(input.visibilityTimeout, 0)
      : undefined;

    const response = await this.sqsClientFor(region).send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: wait,
        VisibilityTimeout: visibility,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );

    return (response.Messages || []).map(m => ({
      messageId: m.MessageId,
      receiptHandle: m.ReceiptHandle,
      body: m.Body,
      md5OfBody: m.MD5OfBody,
      attributes: m.Attributes,
      messageAttributes: m.MessageAttributes
        ? Object.fromEntries(
            Object.entries(m.MessageAttributes).map(([k, v]) => [
              k,
              { type: v.DataType, value: v.StringValue ?? v.BinaryValue?.toString() },
            ]),
          )
        : undefined,
    }));
  }

  async deleteMessage(queueName: string, receiptHandle: string, region?: string): Promise<void> {
    const url = await this.resolveQueueUrl(queueName, region);
    if (!url) throw new Error(`Queue not found: ${queueName}`);
    await this.sqsClientFor(region).send(
      new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receiptHandle }),
    );
  }

  async purgeQueue(queueName: string, region?: string): Promise<void> {
    const url = await this.resolveQueueUrl(queueName, region);
    if (!url) throw new Error(`Queue not found: ${queueName}`);
    await this.sqsClientFor(region).send(new PurgeQueueCommand({ QueueUrl: url }));
  }

  /**
   * Put a queue on "hold": disable its consumer event source mapping(s) and start
   * capturing messages, so a producer can be asserted without the consumer running.
   * Returns null when the queue does not exist.
   *
   * Best-effort caveats: the hold state is in-memory and lost on orchestrator
   * restart (mappings could remain disabled — release or re-register to recover);
   * messages already received by the consumer before hold cannot be un-consumed;
   * LocalStack applies the Enabled toggle asynchronously, so a message may still
   * reach the consumer immediately after hold.
   */
  async holdQueue(
    queueName: string,
    region?: string,
  ): Promise<{ queue: string; disabledMappings: number; held: boolean } | null> {
    const snapshot = await this.getQueue(queueName, region);
    if (!snapshot) return null;

    const uuids = snapshot.consumers
      .map(c => c.uuid)
      .filter((u): u is string => Boolean(u));

    for (const uuid of uuids) {
      try {
        await this.lambdaClientFor(region).send(
          new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: false }),
        );
      } catch {
        // best-effort: LocalStack may apply the toggle asynchronously or reject it
      }
    }

    const existing = this.held.get(snapshot.url);
    this.held.set(snapshot.url, {
      uuids,
      captured: existing?.captured ?? [],
      heldAt: Date.now(),
    });

    return { queue: queueName, disabledMappings: uuids.length, held: true };
  }

  /**
   * Return the messages captured while a queue is held, draining anything
   * currently in the queue into the buffer first (capture is pull-based — there
   * is no background receiver). Returns 'not-found' when the queue doesn't exist
   * and 'not-held' when it exists but isn't held, so the route can distinguish
   * 404 from 409 (consistent with the other queue endpoints).
   */
  async getCaptured(queueName: string, region?: string): Promise<CapturedMessage[] | 'not-found' | 'not-held'> {
    const url = await this.resolveQueueUrl(queueName, region);
    if (!url) return 'not-found';
    const state = this.held.get(url);
    if (!state) return 'not-held';
    await this.drainCaptured(queueName, state, region);
    return state.captured;
  }

  /**
   * Release a held queue: re-enable its consumer mapping(s) and re-dispatch the
   * captured messages so the consumer processes them. Returns 'not-found' when
   * the queue doesn't exist and 'not-held' when it exists but isn't held (404 vs
   * 409 at the route layer).
   */
  async releaseQueue(
    queueName: string,
    region?: string,
  ): Promise<{ queue: string; dispatched: number; released: boolean } | 'not-found' | 'not-held'> {
    const url = await this.resolveQueueUrl(queueName, region);
    if (!url) return 'not-found';
    const state = this.held.get(url);
    if (!state) return 'not-held';

    // Capture anything still in the queue before flipping the consumer back on.
    await this.drainCaptured(queueName, state, region);

    for (const uuid of state.uuids) {
      try {
        await this.lambdaClientFor(region).send(
          new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: true }),
        );
      } catch {
        // best-effort
      }
    }

    const fifo = queueName.endsWith('.fifo');
    let dispatched = 0;
    for (const msg of state.captured) {
      try {
        await this.sendMessage(
          queueName,
          {
            body: msg.body ?? '',
            // FIFO needs a group id; reuse the original or fall back to 'default'.
            messageGroupId: fifo ? msg.attributes?.MessageGroupId || 'default' : undefined,
            // Force a fresh dedup id so the 5-min FIFO dedup window doesn't drop
            // the replay. Content-based dedup is overridden by an explicit id.
            messageDeduplicationId: fifo
              ? `replay-${msg.messageId ?? dispatched}-${state.heldAt}`
              : undefined,
          },
          region,
        );
        dispatched++;
      } catch {
        // best-effort re-dispatch
      }
    }

    this.held.delete(url);
    return { queue: queueName, dispatched, released: true };
  }

  // Pull whatever is currently in the queue into the capture buffer, deleting
  // each message so it is held out of the queue. Bounded so a flooded queue can't
  // block the request indefinitely.
  private async drainCaptured(
    queueName: string,
    state: HeldQueueState,
    region?: string,
  ): Promise<void> {
    const maxIterations = 20; // up to ~200 messages per call
    for (let i = 0; i < maxIterations; i++) {
      const messages = await this.receiveMessages(
        queueName,
        { maxNumberOfMessages: 10, waitTimeSeconds: 1 },
        region,
      );
      if (!messages.length) break;
      for (const m of messages) {
        state.captured.push({
          messageId: m.messageId,
          body: m.body,
          attributes: m.attributes,
          messageAttributes: m.messageAttributes,
          receivedAt: Date.now(),
        });
        if (m.receiptHandle) {
          try {
            await this.deleteMessage(queueName, m.receiptHandle, region);
          } catch {
            // best-effort delete; we already captured the body
          }
        }
      }
      if (messages.length < 10) break;
    }
  }

  private async resolveQueueUrl(queueName: string, region?: string): Promise<string | null> {
    try {
      const response = await this.sqsClientFor(region).send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      return response.QueueUrl || null;
    } catch {
      return null;
    }
  }

  private async refreshMetrics(): Promise<void> {
    try {
      const queueUrls = await this.fetchQueueUrls();
      await Promise.all(queueUrls.map(url => this.updateMetricsForQueue(url)));
    } catch {
      // Ignore polling errors — LocalStack may be unavailable briefly
    }
  }

  // Paginated: ListQueues answers at most 1000 URLs per page. A large monorepo
  // (one queue + one DLQ per bounded context) crosses that, and a truncated
  // list would drop consumers from the dashboard and from await-idle.
  private async fetchQueueUrls(region?: string): Promise<string[]> {
    try {
      const urls: string[] = [];
      let nextToken: string | undefined;
      do {
        const response = await this.sqsClientFor(region).send(new ListQueuesCommand({ NextToken: nextToken }));
        urls.push(...(response.QueueUrls || []));
        nextToken = response.NextToken;
      } while (nextToken);
      return urls;
    } catch {
      return [];
    }
  }

  private async fetchEventSourceMappingsByQueueArn(region?: string): Promise<Map<string, QueueConsumer[]>> {
    const result = new Map<string, QueueConsumer[]>();
    try {
      const response = await this.lambdaClientFor(region).send(new ListEventSourceMappingsCommand({}));
      for (const mapping of response.EventSourceMappings || []) {
        if (!mapping.EventSourceArn || !mapping.FunctionArn) continue;
        if (!mapping.EventSourceArn.includes(':sqs:')) continue;

        const consumer: QueueConsumer = {
          functionName: mapping.FunctionArn.split(':').pop() || mapping.FunctionArn,
          uuid: mapping.UUID,
          state: mapping.State,
          batchSize: mapping.BatchSize,
          enabled: mapping.State === 'Enabled' || mapping.State === 'Creating',
        };

        const consumers = result.get(mapping.EventSourceArn) || [];
        consumers.push(consumer);
        result.set(mapping.EventSourceArn, consumers);
      }
    } catch {
      // No mappings or LocalStack offline — return empty map
    }
    return result;
  }

  private async buildSnapshot(
    queueUrl: string,
    consumersByArn: Map<string, QueueConsumer[]>,
    region?: string,
  ): Promise<QueueSnapshot | null> {
    try {
      const attrs = await this.sqsClientFor(region).send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['All'],
        }),
      );

      const a = attrs.Attributes || {};
      const available = Number(a.ApproximateNumberOfMessages || 0);
      const inFlight = Number(a.ApproximateNumberOfMessagesNotVisible || 0);
      const delayed = Number(a.ApproximateNumberOfMessagesDelayed || 0);
      const arn = a.QueueArn;
      const name = queueUrl.split('/').pop() || queueUrl;

      this.updateMetricsState(queueUrl, available, inFlight);
      const processed = this.metrics.get(queueUrl)?.processed || 0;

      return {
        name,
        url: queueUrl,
        arn,
        available,
        inFlight,
        delayed,
        processed,
        total: available + inFlight + delayed,
        fifo: name.endsWith('.fifo'),
        visibilityTimeout: a.VisibilityTimeout ? Number(a.VisibilityTimeout) : undefined,
        messageRetentionPeriod: a.MessageRetentionPeriod ? Number(a.MessageRetentionPeriod) : undefined,
        createdAt: a.CreatedTimestamp ? Number(a.CreatedTimestamp) * 1000 : undefined,
        lastModifiedAt: a.LastModifiedTimestamp ? Number(a.LastModifiedTimestamp) * 1000 : undefined,
        consumers: arn ? consumersByArn.get(arn) || [] : [],
        lastPolledAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  private async updateMetricsForQueue(
    queueUrl: string,
    region?: string,
  ): Promise<{ available: number; inFlight: number } | null> {
    try {
      const attrs = await this.sqsClientFor(region).send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
          ],
        }),
      );
      const available = Number(attrs.Attributes?.ApproximateNumberOfMessages || 0);
      const inFlight = Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible || 0);
      this.updateMetricsState(queueUrl, available, inFlight);
      return { available, inFlight };
    } catch {
      // Skip on transient failures
      return null;
    }
  }

  private updateMetricsState(queueUrl: string, available: number, inFlight: number): void {
    const state = this.metrics.get(queueUrl);
    if (!state) {
      this.metrics.set(queueUrl, {
        lastAvailable: available,
        lastInFlight: inFlight,
        processed: 0,
      });
      return;
    }

    // A message is considered "processed" when it leaves the in-flight bucket
    // without re-appearing as available (i.e., the consumer deleted it).
    const inFlightDelta = state.lastInFlight - inFlight;
    const availableDelta = available - state.lastAvailable;
    if (inFlightDelta > 0) {
      // Some messages left in-flight. Messages re-added to available are retries,
      // not new work — subtract them so retries don't inflate the processed count.
      const reAppeared = Math.max(0, availableDelta);
      const processedNow = Math.max(0, inFlightDelta - reAppeared);
      state.processed += processedNow;
    }

    state.lastAvailable = available;
    state.lastInFlight = inFlight;
  }

  resetProcessedCount(queueName: string): void {
    for (const [url, state] of this.metrics.entries()) {
      if (url.endsWith(`/${queueName}`)) {
        state.processed = 0;
      }
    }
  }
}
