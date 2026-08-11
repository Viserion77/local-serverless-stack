// Which AWS mark stands for which declared resource kind.
//
// `ui-ux.md` rule 3: functional interface icons come only from TreeUI, while
// brands come from a standardised external source — for AWS that is AWS's own
// Architecture Service Icons pack, vendored under `./aws` and registered into
// the TreeUI registry by name. Rule 3 names the services list as the motivating
// case: a counter that stands for ONE AWS service is a brand, not a generic
// glyph (`code`, `database`, `inbox`, `megaphone`, `archive`, `shuffle`,
// `target`, `search` all used to stand in for one here).
//
// This module is the only place that decision is made, so the services table
// (`ServicesList.vue`), a service's detail screen (`ServiceDetailPage.vue`) and
// the Overview's engine-coverage tags cannot drift apart. Every map here is
// keyed by a union coming from the API contract, so adding a resource type, a
// breakdown counter or an engine service is a typecheck error here until its
// mark is chosen. That is the point: an unknown resource must not silently
// inherit a neighbour's brand.
import type { TIconName } from '@treeui/vue';
import type { EngineServiceName, GraphNodeKind, ResourceBreakdown, ServiceResource } from '../services/api';

/**
 * Declared-resource kind → AWS service mark.
 *
 * Three kinds deliberately share a mark, because they share a service:
 * - `eventbus` and `event-rule` are both Amazon EventBridge (`AWS::Events::*`);
 * - `event-source` is `AWS::Lambda::EventSourceMapping` — a Lambda resource,
 *   even though what it points at is a queue or a stream.
 *
 * That is safe on the detail screen because every group there is introduced by
 * a badge naming the resource in words ("EventBridge buses" vs "EventBridge
 * rules"), so the shared mark never has to carry the distinction alone.
 */
export const resourceTypeIcons: Readonly<Record<ServiceResource['type'], TIconName>> = {
  lambda: 'aws-lambda',
  dynamodb: 'aws-dynamodb',
  sqs: 'aws-sqs',
  sns: 'aws-sns',
  s3: 'aws-s3',
  eventbus: 'aws-eventbridge',
  'event-rule': 'aws-eventbridge',
  opensearch: 'aws-opensearch',
  'event-source': 'aws-lambda',
};

/**
 * Wiring-graph node kind → mark.
 *
 * A separate key space from `resourceTypeIcons`: the graph has three node kinds
 * that are not declared CFN resources — an HTTP `route`, the execution
 * `iam-role` that several functions share, and `external`, a resource this
 * service references but another one declares.
 *
 * `external` is the one entry that is deliberately NOT a brand. It does not
 * stand for an AWS service (it can be a queue, a bus, a table — whatever the
 * neighbour declared); it stands for "this lives somewhere else", which is a
 * functional idea, so by rule 3 it takes a TreeUI glyph. `secret` and `route`
 * do stand for one service each, so they take the AWS marks.
 *
 * Exhaustive over `GraphNodeKind` on purpose. The server union and this one are
 * hand-mirrored across two tsconfigs, and nothing else checks them against each
 * other — this map is the tripwire that makes a new kind fail `vue-tsc` until
 * someone decides how it should look.
 */
export const graphNodeIcons: Readonly<Record<GraphNodeKind, TIconName>> = {
  lambda: 'aws-lambda',
  dynamodb: 'aws-dynamodb',
  sqs: 'aws-sqs',
  sns: 'aws-sns',
  s3: 'aws-s3',
  eventbus: 'aws-eventbridge',
  'event-rule': 'aws-eventbridge',
  opensearch: 'aws-opensearch',
  secret: 'aws-secrets-manager',
  route: 'aws-api-gateway',
  'iam-role': 'aws-iam',
  external: 'external-link',
};

/** One counter of the per-service resource breakdown shown in the table. */
export interface ResourceBreakdownEntry {
  readonly icon: TIconName;
  /**
   * i18n key naming the resource type. The breakdown tags render a mark and a
   * number and nothing else, so this is the tag's **accessible name** — not
   * decoration. The keys are the ones the detail screen already groups by, so
   * "3 DynamoDB tables" reads the same in both places and in all three locales.
   */
  readonly labelKey: string;
}

/**
 * Breakdown counter → mark + name. Keyed by `ResourceBreakdown` so the map
 * stays total as the orchestrator reports new counters.
 */
export const breakdownEntries: Readonly<Record<keyof ResourceBreakdown, ResourceBreakdownEntry>> = {
  lambdas: { icon: resourceTypeIcons.lambda, labelKey: 'services.groupLambdas' },
  tables: { icon: resourceTypeIcons.dynamodb, labelKey: 'services.groupTables' },
  queues: { icon: resourceTypeIcons.sqs, labelKey: 'services.groupQueues' },
  topics: { icon: resourceTypeIcons.sns, labelKey: 'services.groupTopics' },
  buckets: { icon: resourceTypeIcons.s3, labelKey: 'services.groupBuckets' },
  buses: { icon: resourceTypeIcons.eventbus, labelKey: 'services.groupBuses' },
  eventRules: { icon: resourceTypeIcons['event-rule'], labelKey: 'services.groupRules' },
  collections: { icon: resourceTypeIcons.opensearch, labelKey: 'services.groupCollections' },
};

/**
 * Display order of the counters — compute, data, messaging, eventing, search.
 * Kept as an explicit list rather than `Object.keys(breakdownEntries)`: the
 * order is a UI decision, and object key order is not a contract.
 */
export const breakdownOrder: readonly (keyof ResourceBreakdown)[] = [
  'lambdas',
  'tables',
  'queues',
  'topics',
  'buckets',
  'buses',
  'eventRules',
  'collections',
];

/**
 * Engine wire id → AWS service mark, for the Overview's "what the engine
 * answers for" tags. A different key space from `resourceTypeIcons` (signing
 * names, not declared resource kinds), so it is a separate map — but the same
 * decision, so it lives here rather than inline in the page.
 *
 * `sts` borrows the IAM mark: the AWS Architecture pack ships no standalone
 * Security Token Service icon, because AWS documents STS under Identity and
 * Access Management. It is the same service family, not a stand-in.
 */
export const engineServiceIcons: Readonly<Record<EngineServiceName, TIconName>> = {
  dynamodb: 'aws-dynamodb',
  sqs: 'aws-sqs',
  sns: 'aws-sns',
  s3: 'aws-s3',
  events: 'aws-eventbridge',
  lambda: 'aws-lambda',
  sts: 'aws-iam',
  secretsmanager: 'aws-secrets-manager',
  aoss: 'aws-opensearch',
};

/**
 * The mark for an engine service id, or `null` when the id is not one we know.
 *
 * The map above is exhaustive over the union, so a service added to the engine
 * fails the typecheck here until someone picks its mark. This lookup covers the
 * other direction: the health response is wire data typed as `string[]`, so an
 * id from a newer orchestrator than this dashboard renders as plain text rather
 * than under a wrong brand.
 */
export function engineServiceIcon(id: string): TIconName | null {
  return (engineServiceIcons as Readonly<Record<string, TIconName | undefined>>)[id] ?? null;
}
