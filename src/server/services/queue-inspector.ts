import {
  SQSClient,
  ListQueuesCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
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

export class QueueInspector {
  private static instance: QueueInspector;
  private sqsClient: SQSClient;
  private lambdaClient: LambdaClient;
  private metrics = new Map<string, QueueMetricsState>();
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly pollFrequencyMs = 5000;

  private constructor() {
    const config = LocalStackManager.getInstance().getConfig();
    this.sqsClient = new SQSClient(config);
    this.lambdaClient = new LambdaClient(config);
  }

  static getInstance(): QueueInspector {
    if (!QueueInspector.instance) {
      QueueInspector.instance = new QueueInspector();
    }
    return QueueInspector.instance;
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

  async listQueues(): Promise<QueueSnapshot[]> {
    const queueUrls = await this.fetchQueueUrls();
    const eventSourceMap = await this.fetchEventSourceMappingsByQueueArn();

    const snapshots = await Promise.all(
      queueUrls.map(url => this.buildSnapshot(url, eventSourceMap)),
    );
    return snapshots.filter((s): s is QueueSnapshot => s !== null);
  }

  async getQueue(queueName: string): Promise<QueueSnapshot | null> {
    try {
      const urlResponse = await this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      if (!urlResponse.QueueUrl) return null;

      const eventSourceMap = await this.fetchEventSourceMappingsByQueueArn();
      return await this.buildSnapshot(urlResponse.QueueUrl, eventSourceMap);
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

  private async fetchQueueUrls(): Promise<string[]> {
    try {
      const response = await this.sqsClient.send(new ListQueuesCommand({}));
      return response.QueueUrls || [];
    } catch {
      return [];
    }
  }

  private async fetchEventSourceMappingsByQueueArn(): Promise<Map<string, QueueConsumer[]>> {
    const result = new Map<string, QueueConsumer[]>();
    try {
      const response = await this.lambdaClient.send(new ListEventSourceMappingsCommand({}));
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
  ): Promise<QueueSnapshot | null> {
    try {
      const attrs = await this.sqsClient.send(
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
      const attrs = await this.sqsClient.send(
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
