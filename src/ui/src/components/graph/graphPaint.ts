// The pure half of painting a wiring diagram — the decisions the canvas
// painter (`graphCanvas.ts`) and the SVG exporter (`graphSvg.ts`) must agree
// on: which token colours what, which AWS mark a card carries, how each
// connector style is stroked, where the legend items go. No DOM here, so the
// SVG exporter (and its unit test) can run without a browser.
import type { AwsIconName } from '../../icons/aws/artwork.generated';
import { graphNodeIcons } from '../../icons/resourceIcons';
import type { GraphEdgeKind, GraphNode } from '../../services/api';
import type { LegendKey } from './graphLayout';
import { methodTone } from './graphText';

// --- Palette -------------------------------------------------------------------

// Token → fallback. Names live in one map so a typo is fixable in one place —
// this repo has shipped `--tree-font-mono` (real name `--tree-font-family-mono`)
// as a silent fallback before.
export const TOKENS = {
  surface: ['--tree-color-bg-surface', '#ffffff'],
  subtle: ['--tree-color-bg-subtle', '#f3f4f6'],
  page: ['--tree-color-bg-primary', '#ffffff'],
  border: ['--tree-color-border-default', '#e5e7eb'],
  borderStrong: ['--tree-color-border-strong', '#9ca3af'],
  text: ['--tree-color-text-primary', '#111827'],
  muted: ['--tree-color-text-muted', '#6b7280'],
  brand: ['--tree-color-brand-primary', '#0d9488'],
  focus: ['--tree-color-focus-ring', '#2563eb'],
  danger: ['--tree-color-status-error', '#dc2626'],
  successSoft: ['--tree-color-status-success-soft', '#dcfce7'],
  successOn: ['--tree-color-status-success-on-soft', '#166534'],
  infoSoft: ['--tree-color-status-info-soft', '#dbeafe'],
  infoOn: ['--tree-color-status-info-on-soft', '#1e40af'],
  warningSoft: ['--tree-color-status-warning-soft', '#fef3c7'],
  warningOn: ['--tree-color-status-warning-on-soft', '#92400e'],
  errorSoft: ['--tree-color-status-error-soft', '#fee2e2'],
  errorOn: ['--tree-color-status-error-on-soft', '#991b1b'],
  fontSans: ['--tree-font-family-sans', 'system-ui, sans-serif'],
  fontMono: ['--tree-font-family-mono', 'ui-monospace, monospace'],
} as const;

export type TokenName = keyof typeof TOKENS;
export type Palette = Record<TokenName, string> & { edge: Record<GraphEdgeKind, string> };

/** Chip colours per HTTP verb, from the status token families. */
export function methodColours(palette: Palette, method: string): { fill: string; text: string } {
  switch (methodTone(method)) {
    case 'success': return { fill: palette.successSoft, text: palette.successOn };
    case 'info': return { fill: palette.infoSoft, text: palette.infoOn };
    case 'warning': return { fill: palette.warningSoft, text: palette.warningOn };
    case 'error': return { fill: palette.errorSoft, text: palette.errorOn };
    default: return { fill: palette.subtle, text: palette.muted };
  }
}

// --- AWS marks ---------------------------------------------------------------------

// The AWS service an external node names, by either spelling it may carry
// (the ARN prefix `events`, or the graph kind `eventbus`).
const EXTERNAL_MARKS: Readonly<Record<string, AwsIconName>> = {
  sqs: 'aws-sqs',
  sns: 'aws-sns',
  s3: 'aws-s3',
  dynamodb: 'aws-dynamodb',
  lambda: 'aws-lambda',
  events: 'aws-eventbridge',
  eventbus: 'aws-eventbridge',
  secretsmanager: 'aws-secrets-manager',
  secret: 'aws-secrets-manager',
  aoss: 'aws-opensearch',
  es: 'aws-opensearch',
  opensearch: 'aws-opensearch',
  ssm: 'aws-systems-manager',
};

/**
 * The AWS mark for a node, or null. An external node takes the mark of the AWS
 * service it names (a queue in an unregistered stack is still SQS); a
 * third-party host has no brand and gets a lettered tile instead — the
 * functional `external-link` glyph is a TreeUI icon stroked with
 * `currentColor`, and re-drawing it here would breach rule 3.
 */
export function markNameFor(node: GraphNode): AwsIconName | null {
  if (node.kind === 'external') return EXTERNAL_MARKS[node.service ?? ''] ?? null;
  const name: string = graphNodeIcons[node.kind];
  return name.startsWith('aws-') ? (name as AwsIconName) : null;
}

// --- Strokes and legend --------------------------------------------------------------

export const MARK_SIZE = 28;
export const CARD_RADIUS = 8;
export const FRAME_RADIUS = 12;

/** Stroke pattern per connector style, shared with the SVG exporter. */
export const STROKES = {
  sync: { width: 1.6, dash: [] as number[] },
  async: { width: 1.6, dash: [6, 4] },
  inferred: { width: 1, dash: [2, 3] },
  link: { width: 1, dash: [] as number[] },
} as const;

/** Index of the longest leg of a polyline — where a weight pill goes. */
export function longestLeg(points: readonly { x: number; y: number }[]): number {
  let best = 0;
  let bestLength = -1;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.abs(points[index].x - points[index - 1].x) + Math.abs(points[index].y - points[index - 1].y);
    if (length > bestLength) {
      bestLength = length;
      best = index - 1;
    }
  }
  return best;
}

/** Which arrowheads a legend sample shows — shared with the SVG exporter. */
export function legendArrows(key: LegendKey): { start: boolean; end: boolean } {
  return {
    start: key === 'read' || key === 'readwrite',
    end: key !== 'read' && key !== 'inferred' && key !== 'external',
  };
}

/** Legend item x positions, given a text measurer (canvas or the SVG width table). */
export function legendPositions(keys: readonly LegendKey[], labels: readonly string[], measure: (text: string) => number): number[] {
  const positions: number[] = [];
  let x = 28;
  keys.forEach((_key, index) => {
    positions.push(x);
    x += 40 + measure(labels[index]) + 22;
  });
  return positions;
}

