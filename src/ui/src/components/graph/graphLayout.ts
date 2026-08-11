// Geometry for the service wiring diagram: where every node and every link
// goes. Pure — no DOM, no canvas, no Vue — so the drawing code below it is only
// about pixels and the layout can be reasoned about (and, if it ever needs to
// be, tested) on its own.
//
// Why this file exists at all, and why it is `.ts` and not part of the `.vue`:
// `eslint.config.mjs` gives `**/*.vue` a hand-written list of eleven browser
// globals and leaves `no-undef` at severity ERROR for those files. `Path2D`,
// `ResizeObserver`, `devicePixelRatio` and even `HTMLCanvasElement` in type
// position are all absent from that list, so a canvas written inside a `.vue`
// fails `npm run lint` — step one of the `validate: pre-prod` gate. In `.ts`
// the rule is off (typescript-eslint's own override owns those files), which is
// why every line that touches the DOM lives here and in `graphCanvas.ts`.
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, ServiceGraph } from '../../services/api';

/** A node placed on the drawing surface. */
export interface PlacedNode {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  // Which vertical band the node sits in — used to route links and to decide
  // whether a link runs forwards (left to right) or has to double back.
  layer: number;
}

/** A link, with the two points its curve is drawn between. */
export interface PlacedEdge {
  edge: GraphEdge;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  // True when the target sits at or before the source's layer, so the curve has
  // to leave and re-enter on the same side instead of flowing forwards.
  backwards: boolean;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

// Box metrics, in CSS pixels. Chosen so a 26-character resource name fits at
// the label size without truncation, which covers every name the four bundled
// examples declare and the `<service>-<stage>-<function>` shape besides.
export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 48;
const LAYER_GAP = 96;
const ROW_GAP = 18;
const PADDING = 24;

/**
 * Reading order for the nodes inside one layer.
 *
 * Grouping by kind first is what makes a 60-function service scannable: the
 * eye lands on a block of Lambdas rather than on Lambdas interleaved with
 * tables. Within a kind the sort is by label, so the picture is stable across
 * refetches — the detail screen re-polls every 10 s and nodes jumping between
 * frames would read as activity that is not happening.
 */
const KIND_ORDER: readonly GraphNodeKind[] = [
  'route', 'eventbus', 'event-rule', 'sqs', 'sns', 's3',
  'lambda', 'iam-role', 'dynamodb', 'opensearch', 'secret', 'external',
];

function kindRank(kind: GraphNodeKind): number {
  const index = KIND_ORDER.indexOf(kind);
  // A kind this dashboard does not know about sorts last rather than first —
  // an unknown from a newer orchestrator must not lead the layout.
  return index === -1 ? KIND_ORDER.length : index;
}

/**
 * Assign each node to a layer: one more than the deepest thing that points at
 * it, so the picture flows left to right along the direction of causality —
 * route → function → role → table.
 *
 * IAM edges are held back from that walk, and the reason is concrete. The
 * execution role is a hub, not a pipeline stage: every function points at it
 * and it points at every granted resource, so counting its edges as depth adds
 * two columns AND closes a cycle wherever a granted resource also feeds a
 * function. The bundled billing service is exactly that shape — the role is
 * granted `sqs:ReceiveMessage` on the queue that triggers `processOrder`, so
 * `lambda → role → queue → lambda` chained the picture out to SIX columns
 * (1776 px) for a four-function service.
 *
 * So: rank on the structural edges only, then place the role after the deepest
 * function bound to it, and place a resource that IS ONLY reachable by a grant
 * after the role. A resource the structure already positioned keeps its place —
 * that is what stops the cycle from reopening.
 *
 * Cycles are still real among the structural edges (a function that consumes
 * and writes the same queue, a DLQ that redrives home), so the walk carries its
 * own stack and treats a revisit as depth 0 rather than recursing forever.
 */
function assignLayers(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const known = new Set(nodes.map(node => node.id));
  // An edge to or from a node that is not in the payload cannot be laid out;
  // the builder should never emit one, and if it does the layout ignores it
  // rather than inventing a position.
  const live = edges.filter(edge => known.has(edge.from) && known.has(edge.to));
  const structural = live.filter(edge => edge.kind !== 'iam');

  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of structural) incoming.get(edge.to)!.push(edge.from);

  const layers = new Map<string, number>();
  const visiting = new Set<string>();

  const depth = (id: string): number => {
    const seen = layers.get(id);
    if (seen !== undefined) return seen;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const parent of incoming.get(id) ?? []) {
      best = Math.max(best, depth(parent) + 1);
    }
    visiting.delete(id);
    layers.set(id, best);
    return best;
  };
  for (const node of nodes) depth(node.id);

  // A grant target may be pushed right of the role only if it is a SINK — if
  // nothing structural flows out of it. That distinction is what keeps the
  // cycle shut: `orders-to-process` is granted to the role AND triggers
  // `processOrder`, so it is a source and stays on the left where a trigger
  // belongs; `billing-receipts` is only ever written to, so it moves right of
  // the role where a destination belongs.
  const flowsOut = new Set(structural.map(edge => edge.from));

  for (const role of nodes.filter(node => node.kind === 'iam-role')) {
    const bound = live.filter(edge => edge.to === role.id).map(edge => layers.get(edge.from) ?? 0);
    const roleLayer = bound.length ? Math.max(...bound) + 1 : 0;
    layers.set(role.id, roleLayer);
    for (const edge of live) {
      if (edge.from !== role.id || flowsOut.has(edge.to)) continue;
      layers.set(edge.to, Math.max(layers.get(edge.to) ?? 0, roleLayer + 1));
    }
  }

  return layers;
}

/**
 * Place every node and link.
 *
 * Layers become columns and the nodes of a layer stack vertically, centred
 * against the tallest column so a two-node layer next to a twelve-node one does
 * not sit flush at the top with a void beneath it.
 */
export function layoutGraph(graph: ServiceGraph): GraphLayout {
  const layers = assignLayers(graph.nodes, graph.edges);

  const columns = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    const layer = layers.get(node.id) ?? 0;
    const column = columns.get(layer) ?? [];
    column.push(node);
    columns.set(layer, column);
  }

  const indexes = [...columns.keys()].sort((a, b) => a - b);
  const tallest = Math.max(1, ...indexes.map(index => columns.get(index)!.length));
  const height = PADDING * 2 + tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP;
  const width = PADDING * 2 + indexes.length * NODE_WIDTH + Math.max(0, indexes.length - 1) * LAYER_GAP;

  const placed = new Map<string, PlacedNode>();
  indexes.forEach((layer, column) => {
    const nodes = columns.get(layer)!.slice().sort((a, b) => {
      const rank = kindRank(a.kind) - kindRank(b.kind);
      return rank !== 0 ? rank : a.label.localeCompare(b.label);
    });
    const columnHeight = nodes.length * NODE_HEIGHT + (nodes.length - 1) * ROW_GAP;
    const top = (height - columnHeight) / 2;
    nodes.forEach((node, row) => {
      placed.set(node.id, {
        node,
        x: PADDING + column * (NODE_WIDTH + LAYER_GAP),
        y: top + row * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        layer,
      });
    });
  });

  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const backwards = to.layer <= from.layer;
    edges.push({
      edge,
      // Forward links leave the right edge and arrive on the left. A link that
      // doubles back leaves and arrives on the same side, so the curve is
      // visibly a return path rather than a mysterious crossing line.
      fromX: backwards ? from.x : from.x + from.width,
      fromY: from.y + from.height / 2,
      toX: backwards ? to.x + to.width : to.x,
      toY: to.y + to.height / 2,
      backwards,
    });
  }

  return { nodes: [...placed.values()], edges, width, height };
}

/** The node under a point, or null. Topmost-last wins, matching paint order. */
export function nodeAt(layout: GraphLayout, x: number, y: number): PlacedNode | null {
  for (let index = layout.nodes.length - 1; index >= 0; index -= 1) {
    const node = layout.nodes[index];
    if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) {
      return node;
    }
  }
  return null;
}

/**
 * Every edge kind, in legend order, paired with the token that colours it.
 *
 * Colour is never the only difference — `graphCanvas.ts` also gives the two
 * inferred/weak kinds a dashed stroke and a thinner line. That is the
 * `ActivityPanel` rule applied here: the status tokens sit at ΔE 4.4 under
 * deuteranopia, so a diagram that separated "IAM grant" from "event source" by
 * hue alone would be unreadable for a red-green colourblind developer.
 */
export const EDGE_STYLES: Readonly<Record<GraphEdgeKind, { token: string; dashed: boolean }>> = {
  'http-route': { token: '--tree-color-chart-1', dashed: false },
  authorizer: { token: '--tree-color-chart-5', dashed: false },
  'event-source': { token: '--tree-color-chart-2', dashed: false },
  's3-notification': { token: '--tree-color-chart-3', dashed: false },
  'event-rule-target': { token: '--tree-color-chart-4', dashed: false },
  'event-bus-rule': { token: '--tree-color-chart-4', dashed: false },
  'sns-subscription': { token: '--tree-color-chart-6', dashed: false },
  redrive: { token: '--tree-color-status-warning', dashed: false },
  iam: { token: '--tree-color-chart-7', dashed: true },
  env: { token: '--tree-color-text-muted', dashed: true },
};
