// SNS emulator (Query protocol — SNS never migrated to JSON). Minimal v1
// surface: topics as catalog metadata plus Publish as a logged no-op with an
// in-memory counter; no subscriptions or fan-out (PRD §RF-scope). handle()
// returns the complete XML document; the router only sets headers.
//
// Fidelity anchors: resource-provisioner.ts createSNSTopic (idempotent by
// "already exists" message) and deleteSNSTopic (ListTopics then match ARN by
// endsWith(':' + name), tolerates "NotFound").

import { randomUUID } from 'crypto';
import type { AwsRequest, EngineContext, EngineServiceName, QueryEmulator } from '../../types.js';
import type { CatalogStore } from '../../store/store-types.js';
import { AwsError, notImplemented } from '../../http/errors.js';
import { tag, xmlDocument } from '../../http/xml.js';

const SNS_XMLNS = 'http://sns.amazonaws.com/doc/2010-03-31/';

export interface SnsTopicRecord {
  name: string;
  displayName: string;
}

export class SnsEmulator implements QueryEmulator {
  readonly service: EngineServiceName = 'sns';

  private ctx: EngineContext;
  // Messages published per topic ARN since boot — dashboard/testing surface;
  // deliberately not persisted (Publish stores nothing in v1).
  private publishCounts = new Map<string, number>();

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
  }

  async handle(action: string, params: Record<string, string>, req: AwsRequest): Promise<string> {
    const region = req.region;
    switch (action) {
      case 'CreateTopic': return this.createTopic(region, params);
      case 'ListTopics': return this.listTopics(region);
      case 'DeleteTopic': return this.deleteTopic(region, params);
      case 'GetTopicAttributes': return this.getTopicAttributes(region, params);
      case 'Publish': return this.publish(region, params);
      default: throw notImplemented('sns', action);
    }
  }

  publishCount(topicArn: string): number {
    return this.publishCounts.get(topicArn) ?? 0;
  }

  private async createTopic(region: string, params: Record<string, string>): Promise<string> {
    const name = requireParam(params, 'Name');
    const topics = await this.topics(region);
    // Idempotent by name, like AWS when attributes are equal (we keep none
    // that could conflict).
    if (!topics.get(name)) {
      const attributes = entryMap(params, 'Attributes.entry');
      topics.set(name, { name, displayName: attributes.DisplayName ?? '' });
    }
    return response('CreateTopic', tag('TopicArn', this.topicArn(region, name)));
  }

  private async listTopics(region: string): Promise<string> {
    const topics = await this.topics(region);
    const members = topics.values()
      .map(topic => tag('member', tag('TopicArn', this.topicArn(region, topic.name)), { escape: false }))
      .join('');
    return response('ListTopics', tag('Topics', members, { escape: false }));
  }

  private async deleteTopic(region: string, params: Record<string, string>): Promise<string> {
    const arn = requireParam(params, 'TopicArn');
    const topics = await this.topics(region);
    // Idempotent like AWS: deleting an absent topic succeeds.
    topics.delete(topicNameFromArn(arn));
    this.publishCounts.delete(arn);
    return response('DeleteTopic');
  }

  private async getTopicAttributes(region: string, params: Record<string, string>): Promise<string> {
    const arn = requireParam(params, 'TopicArn');
    const topic = await this.requireTopic(region, arn);
    const entries = [
      ['TopicArn', this.topicArn(region, topic.name)],
      ['DisplayName', topic.displayName],
    ] as const;
    const attributes = entries
      .map(([key, value]) => tag('entry', tag('key', key) + tag('value', value), { escape: false }))
      .join('');
    return response('GetTopicAttributes', tag('Attributes', attributes, { escape: false }));
  }

  private async publish(region: string, params: Record<string, string>): Promise<string> {
    // Publish addresses the topic via TopicArn or TargetArn.
    const arn = params.TopicArn || params.TargetArn;
    if (!arn) {
      throw new AwsError('InvalidParameter', 'Invalid parameter: TopicArn Reason: no value given');
    }
    const message = params.Message;
    if (message === undefined || message === '') {
      throw new AwsError('InvalidParameter', 'Invalid parameter: Empty message');
    }
    const topic = await this.requireTopic(region, arn);
    const messageId = randomUUID();
    const count = (this.publishCounts.get(arn) ?? 0) + 1;
    this.publishCounts.set(arn, count);
    console.log(`[engine:sns] Publish #${count} to ${topic.name}: ${messageId} (${message.length} bytes, no subscribers in v1)`);
    return response('Publish', tag('MessageId', messageId));
  }

  private async topics(region: string): Promise<CatalogStore<SnsTopicRecord>> {
    const catalog = this.ctx.store.catalog<SnsTopicRecord>(`sns/${region}/topics`);
    await catalog.load();
    return catalog;
  }

  private async requireTopic(region: string, arn: string): Promise<SnsTopicRecord> {
    const topics = await this.topics(region);
    const topic = topics.get(topicNameFromArn(arn));
    if (!topic) {
      throw new AwsError('NotFound', 'Topic does not exist', { status: 404, fault: 'Sender' });
    }
    return topic;
  }

  private topicArn(region: string, name: string): string {
    return `arn:aws:sns:${region}:${this.ctx.config.account}:${name}`;
  }
}

function topicNameFromArn(arn: string): string {
  return arn.slice(arn.lastIndexOf(':') + 1);
}

// <ActionResponse xmlns=…><ActionResult>…</ActionResult><ResponseMetadata>
// <RequestId>…</RequestId></ResponseMetadata></ActionResponse>. Actions
// without a result shape (DeleteTopic) skip the Result element, like AWS.
function response(action: string, resultXml?: string): string {
  const result = resultXml === undefined ? '' : tag(`${action}Result`, resultXml, { escape: false });
  const metadata = tag('ResponseMetadata', tag('RequestId', randomUUID()), { escape: false });
  return xmlDocument(tag(`${action}Response`, result + metadata, { attrs: { xmlns: SNS_XMLNS }, escape: false }));
}

function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (value === undefined || value === '') {
    throw new AwsError('InvalidParameter', `Invalid parameter: ${name} Reason: no value given`);
  }
  return value;
}

// Query-protocol collections arrive flattened ("Attributes.entry.1.key",
// "Attributes.entry.1.value", …); rebuild the map.
function entryMap(params: Record<string, string>, prefix: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (let index = 1; params[`${prefix}.${index}.key`] !== undefined; index++) {
    map[params[`${prefix}.${index}.key`]] = params[`${prefix}.${index}.value`] ?? '';
  }
  return map;
}
