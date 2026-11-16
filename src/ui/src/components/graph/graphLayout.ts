// Geometry for the wiring diagrams — the service detail card and the stack map:
// where every card, every frame and every connector goes. Pure — no DOM, no
// canvas, no Vue, no clock — so it is the unit under test (`tests/unit/ui/
// graph-layout.test.ts`), and the same layout feeds both the canvas painter
// (`graphCanvas.ts`) and the SVG exporter (`graphSvg.ts`).
//
// Why this file exists at all, and why it is `.ts` and not part of the `.vue`:
// `eslint.config.mjs` gives `**/*.vue` a hand-written list of eleven browser
// globals and leaves `no-undef` at severity ERROR for those files, so canvas
// code written inside a `.vue` fails `npm run lint`. Everything that touches
// the drawing lives in these `.ts` modules.
//
// The picture it produces is an ARCHITECTURE diagram rather than a dependency
// graph: callers and APIs on the left, functions, the role hub, data stores and
// queues in columns to the right, third-party hosts in a column of their own,
// each service inside a frame, and right-angle connectors that never share a
// segment. Everything is derived from the payload — there are no hand-placed
// coordinates anywhere — and it is DETERMINISTIC: the same payload, in any
// order, lays out to the same pixels, so a 10 s refetch never reshuffles it.
//
// Pipeline (see `layoutGraph`):
//   1. fold    — route nodes fold into their API box and the function card;
//   2. zones   — entry · compute · role · data · external columns, with
//                longest-path sub-columns inside compute and data;
//   3. bands   — each service is a band (a frame); collapsed services share a
//                tray band; frames stack vertically in flow order;
//   4. order   — barycenter crossing reduction, a fixed number of sweeps;
//   5. y       — variable card heights, DLQs tucked under their queue,
//                barycenter alignment so single links run straight;
//   6. ports   — spread along each side, bundles share one;
//   7. routes  — orthogonal: channels between columns, corridors between
//                rows, interval-coloured tracks so no two segments overlap;
//   8. x       — channel widths from their track counts, then coordinates.
import type { GraphEdge, GraphEdgeAccess, GraphEdgeKind, GraphNode, GraphNodeKind } from '../../services/api';

/** The part of a graph payload the layout reads — a service graph or the stack graph. */
export interface GraphInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Point {
  x: number;
  y: number;
}

/** A card placed on the drawing surface. */
export interface PlacedNode {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  // Global column index (the zone grid) and the band (frame) it sits in.
  column: number;
  group: string;
  // The routes printed on the card (a function's `GET /orders`), and how many
  // more did not fit.
  routes: { method: string; path: string }[];
  hiddenRoutes: number;
  // A dead-letter queue drawn directly under its source queue.
  dlq: boolean;
}

/** A service frame: the box around one service's cards. */
export interface PlacedFrame {
  group: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How a connector is stroked. `sync` (a call that waits for an answer: an HTTP
 * route, a Lambda invoke, an SDK read or write) is solid; `async` (the platform
 * triggers a function, a message is published or consumed) is dashed;
 * `inferred` (an env-var name match) is thin and dotted; `link` (a function →
 * role spoke, a grant with no data-plane verb) is thin and solid.
 */
export type EdgeStroke = 'sync' | 'async' | 'inferred' | 'link';

/** A connector, as a polyline of right-angle segments. */
export interface PlacedEdge {
  edge: GraphEdge;
  // Every original edge id this connector stands for (route folding merges).
  members: string[];
  points: Point[];
  stroke: EdgeStroke;
  // Arrowheads: at the target end (`end`) and/or at the source end (`start`).
  // A read points AT the function — data flows out of the store.
  arrowStart: boolean;
  arrowEnd: boolean;
  // The kind that colours it. A `cross-service` connector keeps its own
  // colour (the legend's "between services") whatever evidence it came from;
  // that evidence still decides its stroke through `access`.
  colourKind: GraphEdgeKind;
}

/** Legend entries, in display order — only the ones present are listed. */
export type LegendKey = 'sync' | 'async' | 'inferred' | 'read' | 'write' | 'readwrite' | 'cross-service' | 'external';

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  frames: PlacedFrame[];
  legend: LegendKey[];
  // The legend strip's top edge; the strip spans the drawing's width.
  legendY: number;
  width: number;
  height: number;
}

// --- Metrics (CSS pixels at zoom 1) -------------------------------------------

export const CARD_WIDTH = 248;
// Icon tile + title + subtitle.
export const CARD_BASE_HEIGHT = 54;
export const ROUTE_ROW_HEIGHT = 20;
// Past this a function card lists `+N more` instead of growing forever — a
// 30-route monolith would otherwise be a card taller than the screen.
export const MAX_ROUTES_ON_CARD = 4;
const COLLAPSED_HEIGHT = 58;
const ROW_GAP = 18;
// The tray of collapsed services leaves room between rows for corridors: its
// connectors run between cards of the SAME column far more often than a
// framed service's do.
const TRAY_ROW_GAP = 46;
const DLQ_GAP = 22;
const BAND_GAP = 44;
const FRAME_PAD = 18;
export const FRAME_HEADER = 30;
const PADDING = 28;
const MIN_CHANNEL = 56;
const TRACK_SPACING = 9;
const TRACK_MARGIN = 14;
// Clearance a corridor keeps from the cards it runs between.
const CORRIDOR_CLEARANCE = 9;
const PORT_INSET = 14;
const PORT_NUDGE = 7;
const SWEEPS = 8;
export const LEGEND_HEIGHT = 44;

// --- Zones -------------------------------------------------------------------

type Zone = 'entry' | 'compute' | 'role' | 'data' | 'external' | 'tray';

function zoneOf(kind: GraphNodeKind): Zone {
  switch (kind) {
    case 'api':
    case 'route':
    case 'event-rule':
      return 'entry';
    case 'lambda':
      return 'compute';
    case 'iam-role':
      return 'role';
    case 'external':
      return 'external';
    case 'service':
      return 'tray';
    default:
      // dynamodb, s3, sqs, sns, eventbus, opensearch, secret, ssm — and any
      // kind a newer orchestrator adds: data is the safe column for a box this
      // dashboard does not know how to place.
      return 'data';
  }
}

/**
 * Reading order inside a column, the tie-breaker of every sort in this file.
 * APIs lead their column (a function's API stays at the top of the entry
 * column); then rules; among stores, queues before tables before buckets.
 */
const KIND_ORDER: readonly GraphNodeKind[] = [
  'api', 'route', 'event-rule', 'lambda', 'iam-role', 'service',
  'sqs', 'sns', 'eventbus', 'dynamodb', 's3', 'opensearch', 'secret', 'ssm', 'external',
];

function kindRank(kind: GraphNodeKind): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function compareNodes(a: GraphNode, b: GraphNode): number {
  return kindRank(a.kind) - kindRank(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

// --- Stroke and arrows -------------------------------------------------------

const ASYNC_ACCESS: ReadonlySet<GraphEdgeAccess> = new Set<GraphEdgeAccess>(['trigger', 'publish', 'consume']);

/** How an edge is stroked — see `EdgeStroke`. */
export function strokeOf(edge: GraphEdge): EdgeStroke {
  if (edge.confidence === 'inferred') return 'inferred';
  if (!edge.access) return 'link';
  return ASYNC_ACCESS.has(edge.access) ? 'async' : 'sync';
}

/**
 * Where the arrowheads go. The edge's own direction is "who holds the
 * reference" (function → table for an IAM grant); the arrow says which way the
 * DATA moves: a read and a consume point back at the function, a write and a
 * publish at the store, readwrite at both. A function → role spoke has no
 * direction of its own and gets none.
 */
export function arrowsOf(edge: GraphEdge, target: GraphNode | undefined): { start: boolean; end: boolean } {
  switch (edge.access) {
    case 'read':
    case 'consume':
      return { start: true, end: false };
    case 'readwrite':
      return { start: true, end: true };
    case undefined:
      return { start: false, end: target?.kind !== 'iam-role' };
    default:
      return { start: false, end: true };
  }
}

// --- 1. Folding ----------------------------------------------------------------

interface DrawnEdge {
  edge: GraphEdge;
  members: string[];
}

/**
 * Route nodes stay in the payload (the table and the MCP tool list them), but
 * the diagram folds each into the API that serves it: `route → fn` becomes
 * `api → fn` (deduplicated — five routes of one function are one connector,
 * and the card itself lists the paths), and an authorizer's `fn → route`
 * becomes `fn → api`. A route with no known API stays a node of its own.
 */
function fold(graph: GraphInput): { nodes: GraphNode[]; edges: DrawnEdge[] } {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const routeToApi = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === 'route' && node.api && byId.get(node.api)?.kind === 'api') routeToApi.set(node.id, node.api);
  }
  const nodes = graph.nodes.filter(node => !routeToApi.has(node.id));
  const edges = new Map<string, DrawnEdge>();
  for (const edge of graph.edges) {
    const from = routeToApi.get(edge.from) ?? edge.from;
    const to = routeToApi.get(edge.to) ?? edge.to;
    // Edges to nodes the payload does not carry cannot be placed; the builder
    // never emits one, and the layout ignores it rather than inventing a box.
    if (from === to || !byId.has(from) || !byId.has(to)) continue;
    const key = `${from}\u0000${to}\u0000${edge.kind}`;
    const existing = edges.get(key);
    if (existing) {
      existing.members.push(edge.id);
      continue;
    }
    const folded = from === edge.from && to === edge.to ? edge : { ...edge, id: key, from, to };
    edges.set(key, { edge: folded, members: [edge.id] });
  }
  return { nodes, edges: [...edges.values()] };
}

// --- 2. Zones and columns ------------------------------------------------------

/**
 * Longest-path depth among the nodes of ONE zone, over the edges inside it —
 * the sub-columns of compute (a function invoking another) and of data (a topic
 * feeding a queue). Cycles are real (a function that invokes itself through a
 * queue), so the walk carries its own stack and treats a revisit as depth 0.
 */
function subColumns(members: GraphNode[], edges: DrawnEdge[]): Map<string, number> {
  const inZone = new Set(members.map(node => node.id));
  const incoming = new Map<string, string[]>();
  for (const id of inZone) incoming.set(id, []);
  for (const { edge } of edges) {
    // A redrive does not push the DLQ a column right: it is tucked UNDER the
    // queue instead (step 5).
    if (edge.kind === 'redrive') continue;
    if (inZone.has(edge.from) && inZone.has(edge.to)) incoming.get(edge.to)!.push(edge.from);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const parent of incoming.get(id)!) best = Math.max(best, walk(parent) + 1);
    visiting.delete(id);
    depth.set(id, best);
    return best;
  };
  for (const node of [...members].sort(compareNodes)) walk(node.id);
  return depth;
}

// --- 3. Bands --------------------------------------------------------------------

/**
 * The vertical order of the service frames: along the flow between services
 * (the producer above its consumer, so most cross-service connectors run
 * downwards), services with no cross-service link last, ties by name.
 */
function orderGroups(groups: string[], nodes: Map<string, GraphNode>, edges: DrawnEdge[]): string[] {
  const groupOf = (id: string): string => nodes.get(id)!.group ?? '';
  const incoming = new Map<string, Set<string>>();
  const linked = new Set<string>();
  for (const group of groups) incoming.set(group, new Set());
  for (const { edge } of edges) {
    const from = groupOf(edge.from);
    const to = groupOf(edge.to);
    if (from === to || !incoming.has(from) || !incoming.has(to)) continue;
    incoming.get(to)!.add(from);
    linked.add(from);
    linked.add(to);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (group: string): number => {
    const known = depth.get(group);
    if (known !== undefined) return known;
    if (visiting.has(group)) return 0;
    visiting.add(group);
    let best = 0;
    for (const parent of [...incoming.get(group)!].sort()) best = Math.max(best, walk(parent) + 1);
    visiting.delete(group);
    depth.set(group, best);
    return best;
  };
  for (const group of [...groups].sort()) walk(group);
  return [...groups].sort((a, b) =>
    Number(!linked.has(a)) - Number(!linked.has(b)) || depth.get(a)! - depth.get(b)! || a.localeCompare(b));
}

// --- Card heights ----------------------------------------------------------------

function cardHeight(node: GraphNode): { height: number; routes: { method: string; path: string }[]; hidden: number } {
  if (node.kind === 'service') return { height: COLLAPSED_HEIGHT, routes: [], hidden: 0 };
  const all = node.kind === 'lambda' ? node.routes ?? [] : [];
  const routes = all.length > MAX_ROUTES_ON_CARD ? all.slice(0, MAX_ROUTES_ON_CARD - 1) : all;
  const hidden = all.length - routes.length;
  const rows = routes.length + (hidden > 0 ? 1 : 0);
  return { height: CARD_BASE_HEIGHT + (rows ? rows * ROUTE_ROW_HEIGHT + 6 : 0), routes, hidden };
}

// --- Free-space queries (corridors and straight runs) ------------------------------

interface Interval {
  top: number;
  bottom: number;
}

/** The free vertical gaps across a set of columns, as sorted intervals. */
function freeGaps(occupied: Interval[][], from: number, to: number): Interval[] {
  const blocks: Interval[] = [];
  for (let column = from; column <= to; column += 1) {
    for (const block of occupied[column] ?? []) blocks.push(block);
  }
  blocks.sort((a, b) => a.top - b.top);
  const gaps: Interval[] = [];
  let cursor = -Infinity;
  for (const block of blocks) {
    if (block.top > cursor) gaps.push({ top: cursor, bottom: block.top });
    cursor = Math.max(cursor, block.bottom);
  }
  gaps.push({ top: cursor, bottom: Infinity });
  return gaps;
}

// --- Layout ------------------------------------------------------------------------

interface Card {
  node: GraphNode;
  zone: Zone;
  column: number;
  group: string;
  height: number;
  routes: { method: string; path: string }[];
  hidden: number;
  y: number;
  // A DLQ tucked under this queue (or the queue this DLQ hangs from).
  child?: Card;
  parent?: Card;
  // Position inside its (band, column) cell list, for the barycenter sweeps.
  order: number;
}

interface Segment {
  edge: number;
  // A vertical run inside gap `gap` between y1 and y2, or a horizontal run
  // inside a corridor between gap indices g1..g2.
  gap: number;
  y1: number;
  y2: number;
  bundle: string;
  track: number;
}

interface Route {
  index: number;
  edge: DrawnEdge;
  source: Card;
  target: Card;
  sy: number;
  ty: number;
  outGap: number;
  inGap: number;
  // Which vertical segments the route uses: `out` (in outGap, from the
  // source port), `in` (in inGap, to the target port), and the corridor y.
  shape: 'stacked' | 'adjacent' | 'straight-in' | 'straight-out' | 'corridor';
  out?: Segment;
  in?: Segment;
  corridorY?: number;
}

/**
 * Lay out a graph payload.
 *
 * Synchronous and allocation-light: the stack map re-lays out on every refetch
 * (10 s) and on every expand/collapse, so the budget is 50 ms for 600 cards and
 * 1 500 connectors — asserted in the unit suite.
 */
export function layoutGraph(graph: GraphInput): GraphLayout {
  const folded = fold(graph);
  const nodeById = new Map(folded.nodes.map(node => [node.id, node]));

  // --- Cards and zones -------------------------------------------------------
  const cards = new Map<string, Card>();
  for (const node of [...folded.nodes].sort(compareNodes)) {
    const sized = cardHeight(node);
    cards.set(node.id, {
      node,
      zone: zoneOf(node.kind),
      column: 0,
      // An ungrouped node (an old payload) belongs to one anonymous band.
      group: node.kind === 'external' ? 'external' : node.group ?? '',
      height: sized.height,
      routes: sized.routes,
      hidden: sized.hidden,
      y: 0,
      order: 0,
    });
  }
  const edges = folded.edges
    .slice()
    .sort((a, b) => a.edge.from.localeCompare(b.edge.from) || a.edge.to.localeCompare(b.edge.to) || a.edge.kind.localeCompare(b.edge.kind));

  // DLQ pairing: a queue whose `dlqOf` names a queue card in the same band is
  // drawn directly under it.
  for (const card of cards.values()) {
    const source = card.node.facts?.dlqOf;
    if (card.node.kind !== 'sqs' || typeof source !== 'string') continue;
    const parent = cards.get(source);
    if (!parent || parent.group !== card.group || parent.child || parent.parent || card.child) continue;
    parent.child = card;
    card.parent = parent;
  }

  // --- Columns -----------------------------------------------------------------
  const byZone = (zone: Zone) => [...cards.values()].filter(card => card.zone === zone && !card.parent);
  const computeDepth = subColumns(byZone('compute').map(card => card.node), edges);
  const dataDepth = subColumns(byZone('data').map(card => card.node), edges);
  const span = (depths: Map<string, number>) => (depths.size ? Math.max(...depths.values()) + 1 : 0);
  const zoneColumns: Array<{ zone: Zone; count: number }> = [
    { zone: 'entry', count: byZone('entry').length ? 1 : 0 },
    { zone: 'compute', count: span(computeDepth) },
    { zone: 'role', count: byZone('role').length ? 1 : 0 },
    { zone: 'data', count: span(dataDepth) },
  ];
  const zoneStart = new Map<Zone, number>();
  let columnCount = 0;
  for (const { zone, count } of zoneColumns) {
    zoneStart.set(zone, columnCount);
    columnCount += count;
  }
  // The tray of collapsed services spreads over the same grid, at least three
  // and at most eight columns wide — a 40-service stack is a 5 × 8 grid, not a
  // 40-card column.
  const tray = byZone('tray');
  const trayColumns = tray.length
    ? Math.min(Math.max(columnCount, Math.ceil(Math.sqrt(tray.length)), 3), Math.max(columnCount, 8))
    : 0;
  const gridColumns = Math.max(columnCount, trayColumns, 1);
  const externals = byZone('external');
  const externalColumn = gridColumns;
  const totalColumns = gridColumns + (externals.length ? 1 : 0);

  for (const card of cards.values()) {
    if (card.parent) continue;
    switch (card.zone) {
      case 'entry': card.column = zoneStart.get('entry')!; break;
      case 'compute': card.column = zoneStart.get('compute')! + computeDepth.get(card.node.id)!; break;
      case 'role': card.column = zoneStart.get('role')!; break;
      case 'data': card.column = zoneStart.get('data')! + dataDepth.get(card.node.id)!; break;
      case 'external': card.column = externalColumn; break;
      default: break; // tray: assigned with the tray band below
    }
  }
  for (const card of cards.values()) if (card.parent) card.column = card.parent.column;

  // --- Bands -------------------------------------------------------------------
  const groupNames = [...new Set([...cards.values()].filter(card => card.zone !== 'external' && card.zone !== 'tray').map(card => card.group))];
  const nodeGroups = new Map([...cards.values()].map(card => [card.node.id, { ...card.node, group: card.group }]));
  const bandOrder = orderGroups(groupNames, nodeGroups, edges);
  if (tray.length) {
    // Collapsed services in flow order too, row-major across the tray grid.
    const trayOrder = orderGroups(tray.map(card => card.group), nodeGroups, edges);
    const rank = new Map(trayOrder.map((group, index) => [group, index]));
    tray.sort((a, b) => rank.get(a.group)! - rank.get(b.group)!);
    tray.forEach((card, index) => { card.column = index % trayColumns; card.order = index; });
  }

  // Cells: (band, column) → cards in order. The tray is one band.
  const TRAY = '\u0000tray';
  const bands = [...bandOrder, ...(tray.length ? [TRAY] : [])];
  const bandOf = (card: Card) => (card.zone === 'tray' ? TRAY : card.group);
  const cells = new Map<string, Card[]>();
  const cellKey = (band: string, column: number) => `${band}\u0000${column}`;
  for (const card of [...cards.values()].sort((a, b) => compareNodes(a.node, b.node))) {
    if (card.parent || card.zone === 'external') continue;
    const key = cellKey(bandOf(card), card.column);
    const list = cells.get(key) ?? [];
    list.push(card);
    cells.set(key, list);
  }
  // The tray keeps its flow order down each column, not the alphabetical one.
  for (const [key, list] of cells) {
    if (key.startsWith(`${TRAY}\u0000`)) list.sort((a, b) => a.order - b.order);
  }
  const renumber = () => {
    for (const list of cells.values()) list.forEach((card, index) => { card.order = index; });
  };
  renumber();

  // --- 4. Crossing reduction (barycenter, fixed sweeps) ------------------------
  const neighbours = new Map<string, Card[]>();
  for (const card of cards.values()) neighbours.set(card.node.id, []);
  const anchor = (card: Card): Card => card.parent ?? card;
  for (const { edge } of edges) {
    const from = anchor(cards.get(edge.from)!);
    const to = anchor(cards.get(edge.to)!);
    neighbours.get(from.node.id)!.push(to);
    neighbours.get(to.node.id)!.push(from);
  }
  const cellLists = [...cells.values()].sort((a, b) => a[0].column - b[0].column);
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const forward = sweep % 2 === 0;
    for (const list of forward ? cellLists : [...cellLists].reverse()) {
      if (list.length < 2 || list[0].zone === 'tray') continue;
      const column = list[0].column;
      const score = new Map<Card, number>();
      for (const card of list) {
        // Down sweeps look left, up sweeps look right; a card with no
        // neighbour on that side keeps its place.
        const side = neighbours.get(card.node.id)!.filter(other =>
          other.zone !== 'external' && bandOf(other) === bandOf(card)
          && (forward ? other.column < column : other.column > column));
        score.set(card, side.length ? side.reduce((sum, other) => sum + other.order, 0) / side.length : card.order);
      }
      list.sort((a, b) => score.get(a)! - score.get(b)! || compareNodes(a.node, b.node));
      list.forEach((card, index) => { card.order = index; });
    }
  }
  // The API leads its column whatever the sweeps decided.
  for (const list of cells.values()) {
    list.sort((a, b) => Number(b.node.kind === 'api') - Number(a.node.kind === 'api') || a.order - b.order);
  }
  renumber();

  // --- 5. Y coordinates ----------------------------------------------------------
  const blockHeight = (card: Card) => card.height + (card.child ? DLQ_GAP + card.child.height : 0);
  const frames: Array<{ band: string; top: number; bottom: number }> = [];
  let cursor = 0;
  for (const band of bands) {
    const framed = band !== TRAY;
    const top = cursor;
    const contentTop = top + (framed ? FRAME_HEADER : 0);
    let bottom = contentTop;
    const bandCells = [...cells.entries()].filter(([key]) => key.startsWith(`${band}\u0000`)).map(([, list]) => list);
    bandCells.sort((a, b) => a[0].column - b[0].column);
    const rowGap = framed ? ROW_GAP : TRAY_ROW_GAP;
    for (const list of bandCells) {
      let y = contentTop;
      for (const card of list) {
        card.y = y;
        y += blockHeight(card) + rowGap;
      }
    }
    if (framed) {
      // Align each card with what it connects to on its LEFT, keeping the
      // order: a role comes out level with the middle of the functions bound
      // to it, a table level with what writes it, and a single API → function
      // link is a straight line instead of a staircase. Then the cards with
      // nothing on their left (a rule, a source queue) align with what they
      // feed on their right. The API is exempt: it stays at the top of the
      // frame. Every column is re-packed after each move, so nothing overlaps
      // or rises above the frame header.
      const align = (list: Card[], leftward: boolean) => {
        const column = list[0].column;
        for (const card of list) {
          const sideOf = (left: boolean) => neighbours.get(card.node.id)!.filter(other =>
            bandOf(other) === band && other.zone !== 'external' && (left ? other.column < column : other.column > column));
          if (!leftward && (card.node.kind === 'api' || sideOf(true).length)) continue;
          const side = sideOf(leftward);
          if (!side.length) continue;
          const centre = side.reduce((sum, other) => sum + other.y + other.height / 2, 0) / side.length;
          card.y = centre - card.height / 2;
        }
        let floor = contentTop;
        for (const card of list) {
          card.y = Math.max(card.y, floor);
          floor = card.y + blockHeight(card) + ROW_GAP;
        }
      };
      for (const list of bandCells) align(list, true);
      for (const list of [...bandCells].reverse()) align(list, false);
    }
    for (const list of bandCells) {
      for (const card of list) {
        if (card.child) card.child.y = card.y + card.height + DLQ_GAP;
        bottom = Math.max(bottom, card.y + blockHeight(card));
      }
    }
    frames.push({ band, top, bottom: bottom + (framed ? FRAME_PAD : 0) });
    cursor = bottom + (framed ? FRAME_PAD : 0) + BAND_GAP;
  }

  // Externals: one column outside every frame, each at the height of what it
  // connects to, in that order, packed without overlap.
  const desired = new Map<Card, number>();
  for (const card of externals) {
    const side = neighbours.get(card.node.id)!.filter(other => other.zone !== 'external');
    desired.set(card, side.length
      ? side.reduce((sum, other) => sum + other.y + other.height / 2, 0) / side.length - card.height / 2
      : Infinity);
  }
  externals.sort((a, b) => desired.get(a)! - desired.get(b)! || compareNodes(a.node, b.node));
  let floor = 0;
  for (const card of externals) {
    const wanted = desired.get(card)!;
    card.y = Math.max(Number.isFinite(wanted) ? wanted : floor, floor);
    floor = card.y + card.height + ROW_GAP;
  }

  // Occupied vertical intervals per column (cards inflated by the corridor
  // clearance), for the corridor and straight-run queries.
  const occupied: Interval[][] = Array.from({ length: totalColumns }, () => []);
  for (const card of cards.values()) {
    occupied[card.column].push({ top: card.y - CORRIDOR_CLEARANCE, bottom: card.y + card.height + CORRIDOR_CLEARANCE });
  }
  // A frame's header strip carries the service name; a corridor through it
  // would strike the label out.
  for (const frame of frames) {
    if (frame.band === TRAY) continue;
    for (let column = 0; column < gridColumns; column += 1) {
      occupied[column].push({ top: frame.top, bottom: frame.top + FRAME_HEADER - 4 });
    }
  }

  // --- 6. Ports and bundles ------------------------------------------------------
  const routes: Route[] = [];
  edges.forEach((drawn, index) => {
    const source = cards.get(drawn.edge.from)!;
    const target = cards.get(drawn.edge.to)!;
    const stacked = drawn.edge.kind === 'redrive' && target.parent === source;
    routes.push({
      index,
      edge: drawn,
      source,
      target,
      sy: 0,
      ty: 0,
      outGap: source.column + 1,
      inGap: target.column,
      shape: stacked ? 'stacked' : source.column + 1 === target.column ? 'adjacent' : 'corridor',
    });
  });
  // Bundles: connectors of one kind leaving one card through one gap share a
  // port and a track (a trunk with branches), and so do connectors of one kind
  // entering one card. An adjacent-column connector has a single vertical run,
  // so it joins whichever bundle is bigger.
  const count = (key: string, map: Map<string, number>) => map.set(key, (map.get(key) ?? 0) + 1);
  const outCount = new Map<string, number>();
  const inCount = new Map<string, number>();
  const outKey = (route: Route) => `o\u0000${route.source.node.id}\u0000${route.edge.edge.kind}\u0000${route.outGap}`;
  const inKey = (route: Route) => `i\u0000${route.target.node.id}\u0000${route.edge.edge.kind}\u0000${route.inGap}`;
  for (const route of routes) {
    if (route.shape === 'stacked') continue;
    count(outKey(route), outCount);
    count(inKey(route), inCount);
  }
  const outBundle = new Map<Route, string>();
  const inBundle = new Map<Route, string>();
  for (const route of routes) {
    if (route.shape === 'stacked') continue;
    const outs = outCount.get(outKey(route))!;
    const ins = inCount.get(inKey(route))!;
    if (route.shape === 'adjacent') {
      if (outs > 1 && outs >= ins) outBundle.set(route, outKey(route));
      else if (ins > 1) inBundle.set(route, inKey(route));
    } else {
      if (outs > 1) outBundle.set(route, outKey(route));
      if (ins > 1) inBundle.set(route, inKey(route));
    }
  }
  // Ports along each side, sorted by where the far end is so connectors leave
  // in the order they travel and do not cross at the card.
  const sides = new Map<string, Array<{ key: string; far: number; routes: Route[]; start: boolean }>>();
  const addPort = (side: string, key: string, route: Route, far: number, start: boolean) => {
    const list = sides.get(side) ?? [];
    const existing = list.find(port => port.key === key);
    if (existing) {
      existing.routes.push(route);
      existing.far = Math.min(existing.far, far);
    } else {
      list.push({ key, far, routes: [route], start });
    }
    sides.set(side, list);
  };
  const centreOf = (card: Card) => card.y + card.height / 2;
  for (const route of routes) {
    if (route.shape === 'stacked') continue;
    addPort(`r\u0000${route.source.node.id}`, outBundle.get(route) ?? `e${route.index}`, route, centreOf(route.target), true);
    addPort(`l\u0000${route.target.node.id}`, inBundle.get(route) ?? `e${route.index}`, route, centreOf(route.source), false);
  }
  for (const [side, ports] of sides) {
    const card = cards.get(side.slice(2))!;
    ports.sort((a, b) => a.far - b.far || a.key.localeCompare(b.key));
    // Ports sit in the card's header band (icon + title), not over the route
    // rows — a connector ending on a route chip would read as pointing at it —
    // unless there are so many that the header cannot space them apart, in
    // which case they use the whole side.
    const header = Math.min(card.height, CARD_BASE_HEIGHT);
    const top = card.y + PORT_INSET;
    const roomy = (ports.length - 1) * TRACK_SPACING > header - 2 * PORT_INSET;
    const bottom = card.y + (roomy ? card.height : header) - PORT_INSET;
    ports.forEach((port, index) => {
      const y = ports.length === 1 ? card.y + header / 2 : top + ((bottom - top) * index) / (ports.length - 1);
      for (const route of port.routes) {
        if (port.start) route.sy = y;
        else route.ty = y;
      }
    });
  }
  // Two cards facing each other across a channel, level with each other: the
  // left card's outgoing stub and the right card's incoming stub would sit on
  // the same line, and whenever their tracks cross over they share a stretch
  // of it. Nudge the incoming port of a DIFFERENT connector off that line (a
  // straight connector between the two is one route and keeps its line).
  const outgoing = new Map<string, Route[]>();
  for (const route of routes) {
    if (route.shape === 'stacked') continue;
    const key = `${route.outGap}\u0000${Math.round(route.sy)}`;
    outgoing.set(key, [...(outgoing.get(key) ?? []), route]);
  }
  for (const ports of sides.values()) {
    for (const port of ports) {
      if (port.start) continue;
      const first = port.routes[0];
      const facing = outgoing.get(`${first.inGap}\u0000${Math.round(first.ty)}`) ?? [];
      if (!facing.some(route => !port.routes.includes(route))) continue;
      const card = first.target;
      const nudged = first.ty + PORT_NUDGE <= card.y + card.height - 4 ? first.ty + PORT_NUDGE : first.ty - PORT_NUDGE;
      for (const route of port.routes) route.ty = nudged;
    }
  }

  // --- 7. Route topology ----------------------------------------------------------
  const vertical: Segment[] = [];
  // Placed corridor runs, bucketed by height so the clash test only looks at
  // runs near the candidate: (y, gap range) — two runs clash when they are
  // closer than one track AND overlap in the gaps they span.
  const placedRuns = new Map<number, Array<{ y: number; g1: number; g2: number }>>();
  const bucketOf = (y: number) => Math.floor(y / TRACK_SPACING);
  const clashes = (y: number, g1: number, g2: number): boolean => {
    for (let bucket = bucketOf(y) - 1; bucket <= bucketOf(y) + 1; bucket += 1) {
      for (const run of placedRuns.get(bucket) ?? []) {
        if (Math.abs(run.y - y) < TRACK_SPACING - 0.5 && run.g1 <= g2 && g1 <= run.g2) return true;
      }
    }
    return false;
  };
  // The k-th track position inside a free gap: from its middle outwards when
  // it is bounded (null once the gap is full), from the cards outwards when it
  // is the open space above or below everything (which never runs out).
  const trackAt = (gap: Interval, k: number): number | null => {
    if (!Number.isFinite(gap.top)) return gap.bottom - 8 - k * TRACK_SPACING;
    if (!Number.isFinite(gap.bottom)) return gap.top + 8 + k * TRACK_SPACING;
    const middle = (gap.top + gap.bottom) / 2;
    const step = Math.ceil(k / 2) * TRACK_SPACING;
    const y = k % 2 === 1 ? middle - step : middle + step;
    return y >= gap.top + 2 && y <= gap.bottom - 2 ? y : null;
  };
  // Where the search for a given (gap, range) left off: a position that
  // clashed once clashes for good (runs are only ever added), so the next
  // connector over the same columns resumes there instead of re-testing them.
  const resume = new Map<string, number>();
  // Free gaps are asked for the same column ranges over and over (every back
  // edge between the same two zones), so they are computed once per range.
  const gapCache = new Map<string, Interval[]>();
  const gapsFor = (from: number, to: number): Interval[] => {
    const key = `${from}:${to}`;
    let gaps = gapCache.get(key);
    if (!gaps) {
      gaps = freeGaps(occupied, from, to).filter(gap => gap.bottom - gap.top >= 4);
      gapCache.set(key, gaps);
    }
    return gaps;
  };
  const isFree = (from: number, to: number, y: number) => gapsFor(from, to).some(gap => y > gap.top && y < gap.bottom);
  for (const route of routes) {
    if (route.shape === 'stacked') continue;
    const { source, target } = route;
    const forward = target.column > source.column;
    if (route.shape === 'adjacent') {
      route.out = {
        edge: route.index, gap: route.outGap, y1: Math.min(route.sy, route.ty), y2: Math.max(route.sy, route.ty),
        bundle: outBundle.get(route) ?? inBundle.get(route) ?? `e${route.index}`, track: 0,
      };
      vertical.push(route.out);
      continue;
    }
    // Forward across intermediate columns: a straight run at the source's (or
    // the target's) port height when nothing is in the way.
    if (forward && isFree(source.column + 1, target.column - 1, route.sy)) {
      route.shape = 'straight-in';
    } else if (forward && isFree(source.column + 1, target.column - 1, route.ty)) {
      route.shape = 'straight-out';
    }
    if (route.shape === 'straight-in') {
      route.in = { edge: route.index, gap: route.inGap, y1: Math.min(route.sy, route.ty), y2: Math.max(route.sy, route.ty), bundle: inBundle.get(route) ?? `e${route.index}`, track: 0 };
      vertical.push(route.in);
      continue;
    }
    if (route.shape === 'straight-out') {
      route.out = { edge: route.index, gap: route.outGap, y1: Math.min(route.sy, route.ty), y2: Math.max(route.sy, route.ty), bundle: outBundle.get(route) ?? `e${route.index}`, track: 0 };
      vertical.push(route.out);
      continue;
    }
    // Corridor: leave right, run to a free horizontal corridor, cross the
    // columns in between, come down the channel left of the target, enter. A
    // back edge (target at or left of the source) is the same shape run
    // leftwards — it goes AROUND the cards rather than through them.
    const g1 = Math.min(route.outGap, route.inGap);
    const g2 = Math.max(route.outGap, route.inGap);
    const crossFrom = forward ? source.column + 1 : target.column;
    const crossTo = forward ? target.column - 1 : source.column;
    const wanted = (route.sy + route.ty) / 2;
    const gaps = gapsFor(crossFrom, crossTo)
      .map(gap => ({ gap, distance: wanted < gap.top ? gap.top - wanted : wanted > gap.bottom ? wanted - gap.bottom : 0 }))
      .sort((a, b) => a.distance - b.distance || a.gap.top - b.gap.top);
    let y = 0;
    search: for (const { gap } of gaps) {
      const key = `${gap.top}:${gap.bottom}:${g1}:${g2}`;
      for (let k = resume.get(key) ?? 0; ; k += 1) {
        const candidate = trackAt(gap, k);
        if (candidate === null) {
          // One side can run out before the other; both have once k passes
          // twice the gap's height in tracks.
          if (k * TRACK_SPACING > 2 * (gap.bottom - gap.top)) break;
          continue;
        }
        if (clashes(candidate, g1, g2)) continue;
        resume.set(key, k);
        y = candidate;
        break search;
      }
    }
    const runs = placedRuns.get(bucketOf(y)) ?? [];
    runs.push({ y, g1, g2 });
    placedRuns.set(bucketOf(y), runs);
    route.corridorY = y;
    route.out = { edge: route.index, gap: route.outGap, y1: 0, y2: 0, bundle: outBundle.get(route) ?? `e${route.index}`, track: 0 };
    route.in = { edge: route.index, gap: route.inGap, y1: 0, y2: 0, bundle: inBundle.get(route) ?? `e${route.index}`, track: 0 };
    vertical.push(route.out, route.in);
  }

  for (const route of routes) {
    if (route.corridorY === undefined) continue;
    const y = route.corridorY;
    route.out!.y1 = Math.min(route.sy, y);
    route.out!.y2 = Math.max(route.sy, y);
    route.in!.y1 = Math.min(route.ty, y);
    route.in!.y2 = Math.max(route.ty, y);
  }

  // Channel tracks: per gap, merge each bundle into one interval, then
  // interval-colour so no two vertical runs share x where their spans meet.
  const gapTracks = new Array<number>(totalColumns + 1).fill(0);
  const byGap = new Map<number, Map<string, { y1: number; y2: number; segments: Segment[] }>>();
  for (const segment of vertical) {
    const bundles = byGap.get(segment.gap) ?? new Map();
    const merged = bundles.get(segment.bundle);
    if (merged) {
      merged.y1 = Math.min(merged.y1, segment.y1);
      merged.y2 = Math.max(merged.y2, segment.y2);
      merged.segments.push(segment);
    } else {
      bundles.set(segment.bundle, { y1: segment.y1, y2: segment.y2, segments: [segment] });
    }
    byGap.set(segment.gap, bundles);
  }
  for (const [gap, bundles] of byGap) {
    const intervals = [...bundles.entries()].sort((a, b) => a[1].y1 - b[1].y1 || a[1].y2 - b[1].y2 || a[0].localeCompare(b[0]));
    const ends: number[] = [];
    for (const [, interval] of intervals) {
      let track = ends.findIndex(end => end + TRACK_SPACING / 2 < interval.y1);
      if (track === -1) {
        track = ends.length;
        ends.push(interval.y2);
      } else {
        ends[track] = interval.y2;
      }
      for (const segment of interval.segments) segment.track = track;
    }
    gapTracks[gap] = ends.length;
  }

  // --- 8. X coordinates ------------------------------------------------------------
  const gapWidth = (gap: number) => Math.max(MIN_CHANNEL, gapTracks[gap] * TRACK_SPACING + 2 * TRACK_MARGIN);
  const columnX: number[] = [];
  const gapX: number[] = [];
  let x = PADDING;
  for (let gap = 0; gap <= totalColumns; gap += 1) {
    gapX[gap] = x;
    x += gapWidth(gap);
    if (gap < totalColumns) {
      columnX[gap] = x;
      x += CARD_WIDTH;
    }
  }
  // Tracks are centred in their channel so a lone connector runs down the
  // middle of the gap rather than hugging a card.
  const trackX = (segment: Segment) => {
    const width = gapWidth(segment.gap);
    const used = (gapTracks[segment.gap] - 1) * TRACK_SPACING;
    return gapX[segment.gap] + (width - used) / 2 + segment.track * TRACK_SPACING;
  };

  const placed = new Map<string, PlacedNode>();
  for (const card of cards.values()) {
    placed.set(card.node.id, {
      node: card.node,
      x: columnX[card.column],
      y: card.y,
      width: CARD_WIDTH,
      height: card.height,
      column: card.column,
      group: card.group,
      routes: card.routes,
      hiddenRoutes: card.hidden,
      dlq: Boolean(card.parent),
    });
  }

  const placedEdges: PlacedEdge[] = routes.map(route => {
    const { source, target } = route;
    const sx = columnX[source.column] + CARD_WIDTH;
    const tx = columnX[target.column];
    let points: Point[];
    switch (route.shape) {
      case 'stacked': {
        const cx = columnX[source.column] + CARD_WIDTH / 2;
        points = [{ x: cx, y: source.y + source.height }, { x: cx, y: target.y }];
        break;
      }
      case 'adjacent': {
        const cx = trackX(route.out!);
        points = [{ x: sx, y: route.sy }, { x: cx, y: route.sy }, { x: cx, y: route.ty }, { x: tx, y: route.ty }];
        break;
      }
      case 'straight-in': {
        const cx = trackX(route.in!);
        points = [{ x: sx, y: route.sy }, { x: cx, y: route.sy }, { x: cx, y: route.ty }, { x: tx, y: route.ty }];
        break;
      }
      case 'straight-out': {
        const cx = trackX(route.out!);
        points = [{ x: sx, y: route.sy }, { x: cx, y: route.sy }, { x: cx, y: route.ty }, { x: tx, y: route.ty }];
        break;
      }
      default: {
        const ox = trackX(route.out!);
        const ix = trackX(route.in!);
        const cy = route.corridorY!;
        points = [
          { x: sx, y: route.sy }, { x: ox, y: route.sy }, { x: ox, y: cy },
          { x: ix, y: cy }, { x: ix, y: route.ty }, { x: tx, y: route.ty },
        ];
      }
    }
    const arrows = arrowsOf(route.edge.edge, nodeById.get(route.edge.edge.to));
    return {
      edge: route.edge.edge,
      members: route.edge.members,
      points: simplify(points),
      stroke: strokeOf(route.edge.edge),
      arrowStart: arrows.start,
      arrowEnd: arrows.end,
      colourKind: route.edge.edge.kind,
    };
  });

  // Frames span the zone grid, the same width for every service, so the
  // columns read as columns all the way down the stack.
  const frameLeft = columnX[0] - FRAME_PAD;
  const frameRight = columnX[Math.max(gridColumns - 1, 0)] + CARD_WIDTH + FRAME_PAD;
  const placedFrames: PlacedFrame[] = frames
    .filter(frame => frame.band !== TRAY)
    .map(frame => ({ group: frame.band, x: frameLeft, y: frame.top, width: frameRight - frameLeft, height: frame.bottom - frame.top }));

  // --- Normalise: everything inside [PADDING, …], legend underneath -----------
  let minY = Infinity;
  let maxY = -Infinity;
  let maxX = x;
  for (const node of placed.values()) {
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + node.height);
  }
  for (const frame of placedFrames) {
    minY = Math.min(minY, frame.y);
    maxY = Math.max(maxY, frame.y + frame.height);
  }
  for (const edge of placedEdges) {
    for (const point of edge.points) {
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
      maxX = Math.max(maxX, point.x);
    }
  }
  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = 0;
  }
  const shift = PADDING - minY;
  for (const node of placed.values()) node.y += shift;
  for (const frame of placedFrames) frame.y += shift;
  for (const edge of placedEdges) for (const point of edge.points) point.y += shift;

  const legend = legendFor(placedEdges, [...placed.values()]);
  const legendY = maxY + shift + PADDING;
  return {
    nodes: [...placed.values()],
    edges: placedEdges,
    frames: placedFrames,
    legend,
    legendY,
    width: Math.ceil(maxX + PADDING / 2),
    height: Math.ceil(legendY + (legend.length ? LEGEND_HEIGHT : 0) + PADDING / 2),
  };
}

// Drop zero-length legs and merge collinear ones, so a straight connector is
// one segment and the overlap test downstream compares real segments.
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - point.x) < 0.01)
        || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - point.y) < 0.01);
      if (collinear) {
        out[out.length - 1] = point;
        continue;
      }
    }
    out.push(point);
  }
  return out;
}

function legendFor(edges: PlacedEdge[], nodes: PlacedNode[]): LegendKey[] {
  const present = new Set<LegendKey>();
  for (const edge of edges) {
    if (edge.stroke === 'sync' || edge.stroke === 'async' || edge.stroke === 'inferred') present.add(edge.stroke);
    if (edge.edge.access === 'read' || edge.edge.access === 'write' || edge.edge.access === 'readwrite') present.add(edge.edge.access);
    if (edge.edge.kind === 'cross-service') present.add('cross-service');
  }
  if (nodes.some(node => node.node.kind === 'external')) present.add('external');
  const order: LegendKey[] = ['sync', 'async', 'inferred', 'read', 'write', 'readwrite', 'cross-service', 'external'];
  return order.filter(key => present.has(key));
}

// --- Hit-testing ---------------------------------------------------------------

/** The card under a point (diagram coordinates), or null. */
export function nodeAt(layout: GraphLayout, x: number, y: number): PlacedNode | null {
  for (let index = layout.nodes.length - 1; index >= 0; index -= 1) {
    const node = layout.nodes[index];
    if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) return node;
  }
  return null;
}

/** The frame whose header strip is under a point — the collapse target. */
export function frameHeaderAt(layout: GraphLayout, x: number, y: number): PlacedFrame | null {
  for (const frame of layout.frames) {
    if (x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + FRAME_HEADER) return frame;
  }
  return null;
}

/** Ids of a node and everything one connector away from it — the hover focus. */
export function neighbourhood(layout: GraphLayout, id: string): Set<string> {
  const ids = new Set([id]);
  for (const edge of layout.edges) {
    if (edge.edge.from === id) ids.add(edge.edge.to);
    if (edge.edge.to === id) ids.add(edge.edge.from);
  }
  return ids;
}

/**
 * Every edge kind paired with the token that colours it. Colour is never the
 * only difference — the stroke (solid / dashed / dotted) carries sync vs async
 * vs inferred, and the arrowheads carry read vs write — so the diagram stays
 * readable under deuteranopia, where the status tokens sit at ΔE 4.4.
 */
export const EDGE_COLOURS: Readonly<Record<GraphEdgeKind, string>> = {
  'http-route': '--tree-color-chart-1',
  authorizer: '--tree-color-chart-5',
  'event-source': '--tree-color-chart-2',
  's3-notification': '--tree-color-chart-3',
  'event-rule-target': '--tree-color-chart-4',
  'event-bus-rule': '--tree-color-chart-4',
  'sns-subscription': '--tree-color-chart-6',
  redrive: '--tree-color-status-warning',
  iam: '--tree-color-chart-7',
  env: '--tree-color-text-muted',
  'cross-service': '--tree-color-chart-8',
};
