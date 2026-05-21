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
import { LambdaClient, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
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
      this.refreshMetrics().catch(() => undefined);
    }, this.pollFrequencyMs);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
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
      return null;
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

  private async fetchQueueUrls(region?: string): Promise<string[]> {
    try {
      const response = await this.sqsClientFor(region).send(new ListQueuesCommand({}));
      return response.QueueUrls || [];
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

  private async updateMetricsForQueue(queueUrl: string): Promise<void> {
    try {
      const attrs = await this.sqsClientFor().send(
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
    } catch {
      // Skip on transient failures
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
