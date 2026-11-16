// The words a card prints, derived from the node's facts. Pure and shared: the
// canvas painter (`graphCanvas.ts`) and the SVG exporter (`graphSvg.ts`) print
// exactly the same text, and neither calls `t()` — the caller injects the
// translator, so the drawing modules stay free of Vue and the strings stay in
// the trilingual catalogue (`i18n/messages/graph.ts`).
import type { GraphNode, GraphNodeKind } from '../../services/api';
import type { LegendKey } from './graphLayout';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Live numbers LSS already serves, keyed by node id — drawn on the card's corner. */
export interface NodeCounter {
  text: string;
  tone: 'muted' | 'danger';
}

export interface GraphText {
  subtitle(node: GraphNode): string;
  counter(node: GraphNode): NodeCounter | null;
  moreRoutes(count: number): string;
  legend(key: LegendKey): string;
  // The frame header's right-hand hint (`collapse`), or '' when frames are
  // not collapsible on this screen.
  frameHint: string;
  // Short text for the tile of a node that has no AWS mark (a third-party host).
  httpTile: string;
}

// Order in which a collapsed service lists its counts: compute, then data.
const COUNT_ORDER: readonly GraphNodeKind[] = [
  'lambda', 'api', 'dynamodb', 'sqs', 'sns', 's3', 'eventbus', 'event-rule', 'opensearch', 'secret', 'ssm',
];

const COUNT_KEYS: Readonly<Partial<Record<GraphNodeKind, string>>> = {
  lambda: 'graph.countLambda',
  api: 'graph.countApi',
  dynamodb: 'graph.countDynamo',
  sqs: 'graph.countSqs',
  sns: 'graph.countSns',
  s3: 'graph.countS3',
  eventbus: 'graph.countBus',
  'event-rule': 'graph.countRule',
  opensearch: 'graph.countCollection',
  secret: 'graph.countSecret',
  ssm: 'graph.countParameter',
};

// The catalogue has a `…One` key next to each counted phrase: "1 tables" is
// the kind of copy that makes a diagram look machine-made.
const plural = (key: string, n: number): string => (n === 1 ? `${key}One` : key);

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The card's second line: what kind of resource this is, at a glance. */
export function nodeSubtitle(node: GraphNode, t: Translate): string {
  const facts = node.facts ?? {};
  const parts: string[] = [];
  switch (node.kind) {
    case 'lambda':
      if (str(facts.runtime)) parts.push(String(facts.runtime));
      if (num(facts.timeout) !== null) parts.push(t('graph.seconds', { n: Number(facts.timeout) }));
      if (num(facts.memory) !== null) parts.push(t('graph.megabytes', { n: Number(facts.memory) }));
      break;
    case 'dynamodb':
      if (str(facts.pk)) parts.push(t('graph.factPk', { name: String(facts.pk) }));
      if (str(facts.sk)) parts.push(t('graph.factSk', { name: String(facts.sk) }));
      if (num(facts.gsis)) parts.push(t('graph.factGsis', { n: Number(facts.gsis) }));
      if (num(facts.vectorIndexes)) parts.push(t('graph.factVectors', { n: Number(facts.vectorIndexes) }));
      if (facts.stream !== undefined) parts.push(t('graph.factStream'));
      if (str(facts.ttl)) parts.push(t('graph.factTtl'));
      break;
    case 'sqs':
      if (str(facts.dlqOf)) {
        parts.push(t('graph.dlq'));
        break;
      }
      if (facts.fifo === true) parts.push('FIFO');
      if (num(facts.visibilityTimeout) !== null) parts.push(t('graph.factVisibility', { n: Number(facts.visibilityTimeout) }));
      if (num(facts.maxReceiveCount) !== null) parts.push(t('graph.factMaxReceive', { n: Number(facts.maxReceiveCount) }));
      if (!parts.length) parts.push(t('graph.queue'));
      break;
    case 'sns':
      parts.push(t('graph.topic'));
      break;
    case 's3':
      parts.push(str(facts.events) ?? t('graph.bucket'));
      break;
    case 'eventbus':
      parts.push(t('graph.bus'));
      break;
    case 'event-rule':
      parts.push(str(facts.schedule) ?? str(facts.pattern) ?? t('graph.rule'));
      break;
    case 'opensearch':
      parts.push(t('graph.collection'));
      if (str(facts.type)) parts.push(String(facts.type));
      break;
    case 'secret':
      parts.push(t('graph.secret'));
      break;
    case 'ssm':
      parts.push(t('graph.parameter'));
      if (str(facts.type)) parts.push(String(facts.type));
      break;
    case 'api':
      parts.push(t(plural('graph.api', num(facts.routes) ?? 0), { protocol: str(facts.protocol) ?? 'HTTP', n: num(facts.routes) ?? 0 }));
      if (str(facts.authorizers)) parts.push(t('graph.authorizers', { names: String(facts.authorizers) }));
      break;
    case 'iam-role':
      parts.push(t(plural('graph.role', num(facts.functions) ?? 0), { n: num(facts.functions) ?? 0 }));
      break;
    case 'route':
      parts.push(t('graph.route'));
      break;
    case 'service':
      for (const kind of COUNT_ORDER) {
        const value = num(facts[kind]);
        if (value) parts.push(t(plural(COUNT_KEYS[kind]!, value), { n: value }));
      }
      if (!parts.length) parts.push(t('graph.serviceEmpty'));
      break;
    case 'external':
      parts.push(node.service === 'http'
        ? t('graph.externalHttp')
        : t('graph.externalAws', { service: node.service ?? '?' }));
      break;
    default:
      break;
  }
  return parts.join(' · ');
}

/** Card title: the short Lambda name, the resource name, the host. */
export function nodeTitle(node: GraphNode): string {
  return node.label;
}

/** HTTP method → which status family colours its chip. */
export function methodTone(method: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'success';
    case 'POST':
      return 'info';
    case 'PUT':
    case 'PATCH':
      return 'warning';
    case 'DELETE':
      return 'error';
    default:
      return 'neutral';
  }
}

const LEGEND_KEYS: Readonly<Record<LegendKey, string>> = {
  sync: 'graph.legendSync',
  async: 'graph.legendAsync',
  inferred: 'graph.legendInferred',
  read: 'graph.legendRead',
  write: 'graph.legendWrite',
  readwrite: 'graph.legendReadwrite',
  'cross-service': 'graph.legendCrossService',
  external: 'graph.legendExternal',
};

/** The translated `GraphText` the painters need, built once per render. */
export function createGraphText(t: Translate, counters: ReadonlyMap<string, NodeCounter>, collapsible: boolean): GraphText {
  return {
    subtitle: node => nodeSubtitle(node, t),
    counter: node => counters.get(node.id) ?? null,
    moreRoutes: count => t('graph.moreRoutes', { n: count }),
    legend: key => t(LEGEND_KEYS[key]),
    frameHint: collapsible ? t('graph.frameCollapse') : '',
    httpTile: 'HTTP',
  };
}
