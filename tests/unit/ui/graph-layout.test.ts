// The dashboard's diagram layout (`src/ui/src/components/graph/graphLayout.ts`)
// and its SVG exporter. Both are pure — no DOM, no canvas — which is what lets
// the properties the stack map promises be asserted here: zones, DLQs under
// their queues, determinism across shuffled input, no two connector segments
// sharing a line, back edges routed around the cards, and the 50 ms budget.
import {
  layoutGraph,
  nodeAt,
  frameHeaderAt,
  neighbourhood,
  strokeOf,
  arrowsOf,
  GraphInput,
  GraphLayout,
  PlacedEdge,
  MAX_ROUTES_ON_CARD,
} from '../../../src/ui/src/components/graph/graphLayout';
import { renderGraphSvg, textWidth, roundedPolyline } from '../../../src/ui/src/components/graph/graphSvg';
import { createGraphText, nodeSubtitle, methodTone } from '../../../src/ui/src/components/graph/graphText';
import type { GraphEdge, GraphNode } from '../../../src/ui/src/services/api';
import { MESSAGES } from '../../../src/ui/src/i18n/messages';

const t = (key: string, params: Record<string, string | number> = {}) =>
  (MESSAGES.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));

function edge(from: string, to: string, kind: GraphEdge['kind'], extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${from}>${to}>${kind}`, from, to, kind, confidence: 'declared', ...extra };
}

// The bundled demo's shape: two services, an API with routes folded into it, a
// role hub, a queue with its DLQ, a cross-service trigger back up the stack
// and a third-party host.
function demo(): GraphInput {
  const nodes: GraphNode[] = [
    { id: 'o/api', kind: 'api', label: 'dev-orders', group: 'orders', facts: { protocol: 'HTTP', routes: 2 } },
    { id: 'o/route:POST /orders', kind: 'route', label: 'POST /orders', group: 'orders', api: 'o/api' },
    { id: 'o/route:GET /orders', kind: 'route', label: 'GET /orders', group: 'orders', api: 'o/api' },
    { id: 'o/create', kind: 'lambda', label: 'createOrder', group: 'orders', routes: [{ method: 'POST', path: '/orders' }] },
    { id: 'o/list', kind: 'lambda', label: 'listOrders', group: 'orders', routes: [{ method: 'GET', path: '/orders' }] },
    { id: 'o/role', kind: 'iam-role', label: 'Role', group: 'orders', facts: { functions: 2 } },
    { id: 'o/table', kind: 'dynamodb', label: 'orders-Orders', group: 'orders', facts: { pk: 'id' } },
    { id: 'o/queue', kind: 'sqs', label: 'orders-jobs', group: 'orders', facts: { maxReceiveCount: 2 } },
    { id: 'o/dlq', kind: 'sqs', label: 'orders-jobs-dlq', group: 'orders', facts: { dlqOf: 'o/queue' } },
    { id: 'b/process', kind: 'lambda', label: 'processOrder', group: 'billing' },
    { id: 'b/bus', kind: 'eventbus', label: 'billing-events', group: 'billing' },
    { id: 'external:http:api.payments.example.com', kind: 'external', label: 'api.payments.example.com', service: 'http', group: 'external' },
  ];
  const edges: GraphEdge[] = [
    edge('o/route:POST /orders', 'o/create', 'http-route', { access: 'invoke' }),
    edge('o/route:GET /orders', 'o/list', 'http-route', { access: 'invoke' }),
    edge('o/create', 'o/role', 'iam'),
    edge('o/list', 'o/role', 'iam'),
    edge('o/role', 'o/table', 'iam', { access: 'readwrite' }),
    edge('o/role', 'o/queue', 'iam', { access: 'publish' }),
    edge('o/queue', 'o/dlq', 'redrive', { access: 'publish' }),
    edge('o/queue', 'b/process', 'cross-service', { via: 'event-source', access: 'trigger' }),
    edge('b/process', 'b/bus', 'iam', { access: 'publish' }),
    edge('b/process', 'external:http:api.payments.example.com', 'env', { confidence: 'inferred' }),
  ];
  return { nodes, edges };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

function placed(layout: GraphLayout, id: string) {
  return layout.nodes.find(node => node.node.id === id)!;
}

interface Segment { x1: number; y1: number; x2: number; y2: number; edge: PlacedEdge }

function segments(layout: GraphLayout): Segment[] {
  return layout.edges.flatMap(placedEdge => placedEdge.points.slice(1).map((point, index) => ({
    x1: placedEdge.points[index].x, y1: placedEdge.points[index].y, x2: point.x, y2: point.y, edge: placedEdge,
  })));
}

// Two segments of different connectors that run along the same line and share
// a stretch of it. Connectors of one kind leaving one card (or entering one
// card) form a bundle and share a trunk on purpose, so those pairs are exempt.
function overlaps(layout: GraphLayout): string[] {
  const found: string[] = [];
  const all = segments(layout);
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      if (a.edge === b.edge) continue;
      const sameSource = a.edge.edge.from === b.edge.edge.from && a.edge.edge.kind === b.edge.edge.kind;
      const sameTarget = a.edge.edge.to === b.edge.edge.to && a.edge.edge.kind === b.edge.edge.kind;
      if (sameSource || sameTarget) continue;
      const vertical = (s: Segment) => Math.abs(s.x1 - s.x2) < 0.01;
      const horizontal = (s: Segment) => Math.abs(s.y1 - s.y2) < 0.01;
      if (vertical(a) && vertical(b) && Math.abs(a.x1 - b.x1) < 0.5) {
        const lo = Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
        const hi = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
        if (hi - lo > 1) found.push(`${a.edge.edge.id} | ${b.edge.edge.id} (x=${a.x1})`);
      }
      if (horizontal(a) && horizontal(b) && Math.abs(a.y1 - b.y1) < 0.5) {
        const lo = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
        const hi = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
        if (hi - lo > 1) found.push(`${a.edge.edge.id} | ${b.edge.edge.id} (y=${a.y1})`);
      }
    }
  }
  return found;
}

// Every connector is made of right angles only.
function orthogonal(layout: GraphLayout): boolean {
  return segments(layout).every(s => Math.abs(s.x1 - s.x2) < 0.01 || Math.abs(s.y1 - s.y2) < 0.01);
}

describe('layoutGraph — zones and folding', () => {
  const layout = layoutGraph(demo());

  it('folds route nodes into their API: no route card, one api → function connector each', () => {
    expect(layout.nodes.some(node => node.node.kind === 'route')).toBe(false);
    const fromApi = layout.edges.filter(e => e.edge.from === 'o/api');
    expect(fromApi.map(e => e.edge.to).sort()).toEqual(['o/create', 'o/list']);
    expect(fromApi[0].members).toHaveLength(1);
  });

  it('puts entry → compute → role → data in columns left to right, externals last', () => {
    const column = (id: string) => placed(layout, id).column;
    expect(column('o/api')).toBeLessThan(column('o/create'));
    expect(column('o/create')).toBeLessThan(column('o/role'));
    expect(column('o/role')).toBeLessThan(column('o/table'));
    expect(column('external:http:api.payments.example.com')).toBeGreaterThan(column('o/table'));
    // Same zone, same column — across services too.
    expect(column('b/process')).toBe(column('o/create'));
  });

  it('keeps the API at the top of its frame and frames stacked in flow order', () => {
    const orders = layout.frames.find(frame => frame.group === 'orders')!;
    const billing = layout.frames.find(frame => frame.group === 'billing')!;
    expect(orders.y).toBeLessThan(billing.y);
    expect(placed(layout, 'o/api').y).toBeLessThan(placed(layout, 'o/create').y + 1);
    expect(layout.frames).toHaveLength(2);
    expect(orders.width).toBe(billing.width);
  });

  it('tucks the DLQ directly under its queue, joined by a vertical connector', () => {
    const queue = placed(layout, 'o/queue');
    const dlq = placed(layout, 'o/dlq');
    expect(dlq.column).toBe(queue.column);
    expect(dlq.x).toBe(queue.x);
    expect(dlq.y).toBeGreaterThan(queue.y + queue.height);
    expect(dlq.dlq).toBe(true);
    const redrive = layout.edges.find(e => e.edge.kind === 'redrive')!;
    expect(redrive.points).toEqual([
      { x: queue.x + queue.width / 2, y: queue.y + queue.height },
      { x: dlq.x + dlq.width / 2, y: dlq.y },
    ]);
  });

  it('grows a card for its routes and caps the list', () => {
    expect(placed(layout, 'o/create').height).toBeGreaterThan(placed(layout, 'o/role').height);
    const many = demo();
    many.nodes[3].routes = Array.from({ length: MAX_ROUTES_ON_CARD + 3 }, (_, i) => ({ method: 'GET', path: `/r${i}` }));
    const card = placed(layoutGraph(many), 'o/create');
    expect(card.routes).toHaveLength(MAX_ROUTES_ON_CARD - 1);
    expect(card.hiddenRoutes).toBe(4);
  });

  it('puts a web function in the compute column with a WEB chip for its URL (or endpoint names)', () => {
    const graph = demo();
    graph.nodes.push(
      { id: 'o/web', kind: 'web-function', label: 'orders-web', group: 'orders', facts: { url: 'http://localhost:15000', endpoints: 'live' } },
      { id: 'o/web2', kind: 'web-function', label: 'orders-admin', group: 'orders', facts: { endpoints: 'admin' } },
      { id: 'o/web3', kind: 'web-function', label: 'orders-bare', group: 'orders', facts: { revisions: 0 } },
    );
    graph.edges.push(edge('o/list', 'o/web', 'env', { access: 'invoke' }));
    const out = layoutGraph(graph);
    const web = placed(out, 'o/web');
    // Compute zone: next to the event functions, one sub-column right of the
    // function that calls it, still left of the role hub.
    expect(placed(out, 'o/web2').column).toBe(placed(out, 'o/create').column);
    expect(web.column).toBe(placed(out, 'o/list').column + 1);
    expect(web.column).toBeLessThan(placed(out, 'o/role').column);
    expect(web.routes).toEqual([{ method: 'WEB', path: 'http://localhost:15000' }]);
    expect(placed(out, 'o/web2').routes).toEqual([{ method: 'WEB', path: 'admin' }]);
    expect(placed(out, 'o/web3').routes).toEqual([]);
  });

  it('keeps a route whose API is unknown as a card of its own, and drops edges to unknown nodes', () => {
    const graph = demo();
    graph.nodes.push({ id: 'o/route:GET /lost', kind: 'route', label: 'GET /lost', group: 'orders' });
    graph.edges.push(edge('o/route:GET /lost', 'o/list', 'http-route'), edge('o/list', 'ghost', 'iam'));
    const out = layoutGraph(graph);
    expect(out.nodes.some(node => node.node.id === 'o/route:GET /lost')).toBe(true);
    expect(out.edges.some(e => e.edge.to === 'ghost')).toBe(false);
  });
});

describe('layoutGraph — routing', () => {
  it('draws every connector with right angles, and no two connectors share a segment', () => {
    const layout = layoutGraph(demo());
    expect(orthogonal(layout)).toBe(true);
    expect(overlaps(layout)).toEqual([]);
  });

  it('routes a back edge around the cards: out right, through a corridor, in from the left', () => {
    const layout = layoutGraph(demo());
    const back = layout.edges.find(e => e.edge.kind === 'cross-service')!;
    const queue = placed(layout, 'o/queue');
    const target = placed(layout, 'b/process');
    const [first] = back.points;
    const last = back.points[back.points.length - 1];
    expect(first.x).toBe(queue.x + queue.width);
    expect(last.x).toBe(target.x);
    // It leaves rightwards and arrives rightwards, so it must double back
    // somewhere — through a horizontal corridor clear of every card.
    expect(back.points.length).toBe(6);
    const corridor = back.points[2].y;
    for (const node of layout.nodes) {
      const crosses = corridor > node.y && corridor < node.y + node.height;
      const spans = Math.min(back.points[2].x, back.points[3].x) < node.x + node.width && Math.max(back.points[2].x, back.points[3].x) > node.x;
      expect(crosses && spans).toBe(false);
    }
  });

  it('bundles connectors of one kind leaving one card on a shared port', () => {
    const layout = layoutGraph(demo());
    const fromRole = layout.edges.filter(e => e.edge.from === 'o/role');
    expect(fromRole).toHaveLength(2);
    expect(new Set(fromRole.map(e => e.points[0].y)).size).toBe(1);
  });

  it('strokes and arrows follow the access: read points at the function, write at the store', () => {
    const layout = layoutGraph(demo());
    const rw = layout.edges.find(e => e.edge.to === 'o/table')!;
    expect([rw.stroke, rw.arrowStart, rw.arrowEnd]).toEqual(['sync', true, true]);
    const trigger = layout.edges.find(e => e.edge.kind === 'cross-service')!;
    expect([trigger.stroke, trigger.colourKind]).toEqual(['async', 'cross-service']);
    const spoke = layout.edges.find(e => e.edge.to === 'o/role')!;
    expect([spoke.stroke, spoke.arrowEnd]).toEqual(['link', false]);
    expect(layout.edges.find(e => e.edge.kind === 'env')!.stroke).toBe('inferred');
    expect(arrowsOf(edge('a', 'b', 'iam', { access: 'read' }), undefined)).toEqual({ start: true, end: false });
    expect(arrowsOf(edge('a', 'b', 'iam', { access: 'consume' }), undefined)).toEqual({ start: true, end: false });
    expect(arrowsOf(edge('a', 'b', 'iam', { access: 'write' }), undefined)).toEqual({ start: false, end: true });
    expect(arrowsOf(edge('a', 'b', 'iam'), { id: 'b', kind: 'sqs', label: 'b' })).toEqual({ start: false, end: true });
    expect(strokeOf(edge('a', 'b', 'iam', { access: 'invoke' }))).toBe('sync');
  });

  it('lists only the legend entries the drawing uses', () => {
    expect(layoutGraph(demo()).legend).toEqual(['sync', 'async', 'inferred', 'readwrite', 'cross-service', 'external']);
    expect(layoutGraph({ nodes: [{ id: 'a', kind: 'lambda', label: 'a' }], edges: [] }).legend).toEqual([]);
  });
});

describe('layoutGraph — determinism', () => {
  it('lays out a shuffled payload to the same pixels', () => {
    const reference = JSON.stringify(layoutGraph(demo()));
    for (const seed of [1, 7, 42]) {
      const graph = demo();
      const shuffledGraph = { nodes: shuffled(graph.nodes, seed), edges: shuffled(graph.edges, seed + 1) };
      const out = layoutGraph(shuffledGraph);
      // Node and edge ARRAY order follows a canonical sort, so the whole
      // payload — not just the coordinates — is identical.
      expect(JSON.stringify(out)).toBe(reference);
    }
  });

  it('handles an empty graph', () => {
    const out = layoutGraph({ nodes: [], edges: [] });
    expect(out.nodes).toEqual([]);
    expect(out.width).toBeGreaterThan(0);
  });
});

describe('layoutGraph — collapsed services', () => {
  function ring(count: number): GraphInput {
    const nodes: GraphNode[] = Array.from({ length: count }, (_, i) => ({
      id: `service:svc-${String(i).padStart(2, '0')}`, kind: 'service', label: `svc-${String(i).padStart(2, '0')}`,
      group: `svc-${String(i).padStart(2, '0')}`, facts: { lambda: 60, dynamodb: 10 },
    }));
    const edges = nodes.map((node, i) => edge(node.id, nodes[(i + 1) % count].id, 'cross-service', { via: 'event-source', access: 'trigger', weight: 2 }));
    return { nodes, edges };
  }

  it('spreads 40 collapsed services over a grid, frameless, with clean connectors', () => {
    const layout = layoutGraph(ring(40));
    expect(layout.frames).toEqual([]);
    const columns = new Set(layout.nodes.map(node => node.column));
    expect(columns.size).toBeGreaterThanOrEqual(5);
    expect(columns.size).toBeLessThanOrEqual(8);
    expect(orthogonal(layout)).toBe(true);
    expect(overlaps(layout)).toEqual([]);
  });

  it('mixes an expanded frame with the tray of collapsed ones', () => {
    const graph = ring(3);
    graph.nodes.push(...demo().nodes);
    graph.edges.push(...demo().edges, edge('service:svc-00', 'o/create', 'cross-service', { via: 'iam', access: 'invoke' }));
    const layout = layoutGraph(graph);
    expect(layout.frames.map(frame => frame.group)).toEqual(['orders', 'billing']);
    const tray = layout.nodes.filter(node => node.node.kind === 'service');
    expect(Math.min(...tray.map(node => node.y))).toBeGreaterThan(Math.max(...layout.frames.map(f => f.y + f.height)));
  });
});

describe('layoutGraph — hit-testing helpers', () => {
  const layout = layoutGraph(demo());

  it('finds the card and the frame header under a point', () => {
    const card = placed(layout, 'o/table');
    expect(nodeAt(layout, card.x + 5, card.y + 5)!.node.id).toBe('o/table');
    expect(nodeAt(layout, -100, -100)).toBeNull();
    const frame = layout.frames[0];
    expect(frameHeaderAt(layout, frame.x + 10, frame.y + 10)!.group).toBe(frame.group);
    expect(frameHeaderAt(layout, frame.x + 10, frame.y + frame.height - 2)).toBeNull();
  });

  it('isolates a node’s neighbourhood', () => {
    expect([...neighbourhood(layout, 'o/role')].sort()).toEqual(['o/create', 'o/list', 'o/queue', 'o/role', 'o/table']);
  });
});

describe('layoutGraph — budget', () => {
  // 600 cards and 1 500 connectors, in ten framed services: the size of an
  // expanded slice of the 40-service scale target.
  function large(): GraphInput {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let state = 17;
    const random = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let s = 0; s < 10; s += 1) {
      const group = `svc-${s}`;
      nodes.push({ id: `${group}/api`, kind: 'api', label: `${group}-api`, group });
      for (let f = 0; f < 40; f += 1) {
        nodes.push({ id: `${group}/fn${f}`, kind: 'lambda', label: `fn${f}`, group, routes: f % 3 ? [{ method: 'GET', path: `/r${f}` }] : [] });
      }
      nodes.push({ id: `${group}/role`, kind: 'iam-role', label: 'role', group });
      for (let d = 0; d < 18; d += 1) nodes.push({ id: `${group}/t${d}`, kind: d % 4 ? 'dynamodb' : 'sqs', label: `t${d}`, group });
    }
    for (let s = 0; s < 10; s += 1) {
      const group = `svc-${s}`;
      for (let f = 0; f < 40; f += 1) {
        edges.push(edge(`${group}/api`, `${group}/fn${f}`, 'http-route', { access: 'invoke' }));
        edges.push(edge(`${group}/fn${f}`, `${group}/role`, 'iam'));
      }
      for (let d = 0; d < 18; d += 1) edges.push(edge(`${group}/role`, `${group}/t${d}`, 'iam', { access: 'readwrite' }));
      while (edges.length < (s + 1) * 150) {
        const other = `svc-${random(10)}`;
        edges.push(edge(`${other}/t${random(18)}`, `${group}/fn${random(40)}`, 'cross-service', { via: 'event-source', access: 'trigger' }));
      }
    }
    return { nodes, edges };
  }

  it('lays out 600 cards and 1 500 connectors inside 50 ms', () => {
    const graph = large();
    expect(graph.nodes).toHaveLength(600);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1500);
    // Warm-up: the budget is for the steady state of a refetch, not for the
    // first call through a cold JIT.
    for (let warm = 0; warm < 3; warm += 1) layoutGraph(graph);
    // Best of ten: the suite runs in parallel workers, and a neighbour
    // hogging the core for one sample must not count against this layout.
    const runs = Array.from({ length: 10 }, () => {
      const started = performance.now();
      layoutGraph(graph);
      return performance.now() - started;
    });
    // Generous on shared CI runners: the dashboard's own
    // budget is 50 ms on the reference machine.
    expect(Math.min(...runs)).toBeLessThan(process.env.CI ? 150 : 50);
  });
});

describe('graph text', () => {
  it('describes each kind from its facts', () => {
    const subtitle = (node: Partial<GraphNode>) => nodeSubtitle({ id: 'x', label: 'x', kind: 'lambda', ...node } as GraphNode, t);
    expect(subtitle({ facts: { runtime: 'nodejs20.x', timeout: 6, memory: 1024 } })).toBe('nodejs20.x · 6 s · 1024 MB');
    expect(subtitle({ kind: 'dynamodb', facts: { pk: 'id', sk: 'at', gsis: 2, vectorIndexes: 1, stream: 'NEW_IMAGE', ttl: 'exp' } }))
      .toBe('pk id · sk at · 2 GSI · 1 vector idx · stream · TTL');
    expect(subtitle({ kind: 'sqs', facts: { dlqOf: 'q' } })).toBe('dead-letter queue');
    expect(subtitle({ kind: 'sqs', facts: { fifo: true, visibilityTimeout: 5, maxReceiveCount: 2 } })).toBe('FIFO · visibility 5 s · DLQ after 2');
    expect(subtitle({ kind: 'sqs' })).toBe('queue');
    expect(subtitle({ kind: 'sns' })).toBe('topic');
    expect(subtitle({ kind: 's3' })).toBe('bucket');
    expect(subtitle({ kind: 's3', facts: { events: 's3:ObjectCreated:*' } })).toBe('s3:ObjectCreated:*');
    expect(subtitle({ kind: 'eventbus' })).toBe('event bus');
    expect(subtitle({ kind: 'event-rule', facts: { schedule: 'rate(1 day)' } })).toBe('rate(1 day)');
    expect(subtitle({ kind: 'event-rule' })).toBe('rule');
    expect(subtitle({ kind: 'opensearch', facts: { type: 'SEARCH' } })).toBe('collection · SEARCH');
    expect(subtitle({ kind: 'secret' })).toBe('secret');
    expect(subtitle({ kind: 'ssm', facts: { type: 'String' } })).toBe('parameter · String');
    expect(subtitle({ kind: 'api', facts: { protocol: 'HTTP', routes: 3, authorizers: 'jwt' } })).toBe('HTTP API · 3 routes · auth jwt');
    expect(subtitle({ kind: 'iam-role', facts: { functions: 4 } })).toBe('execution role · 4 functions');
    expect(subtitle({ kind: 'route' })).toBe('route');
    expect(subtitle({ kind: 'web-function', facts: { runtime: 'nodejs24.x', revisions: 2 } })).toBe('web function · nodejs24.x · 2 revisions');
    expect(subtitle({ kind: 'web-function', facts: { revisions: 1 } })).toBe('web function · 1 revision');
    expect(subtitle({ kind: 'web-function' })).toBe('web function · 0 revisions');
    expect(subtitle({ kind: 'service', facts: { lambda: 58, dynamodb: 9, sqs: 6 } })).toBe('58 functions · 9 tables · 6 queues');
    expect(subtitle({ kind: 'service', facts: { lambda: 3, 'web-function': 1, api: 1 } })).toBe('3 functions · 1 web function · 1 API');
    expect(subtitle({ kind: 'service', facts: {} })).toBe('nothing cached');
    expect(subtitle({ kind: 'external', service: 'http' })).toBe('third-party HTTP');
    expect(subtitle({ kind: 'external', service: 'sqs' })).toBe('sqs · declared elsewhere');
  });

  it('colours verbs by family', () => {
    expect(['GET', 'POST', 'PUT', 'DELETE', 'ANY', 'WEB'].map(methodTone)).toEqual(['success', 'info', 'warning', 'error', 'neutral', 'warning']);
  });
});

describe('renderGraphSvg', () => {
  const palette = {
    surface: '#fff', subtle: '#f6f7f9', page: '#fff', border: '#e2e5ea', borderStrong: '#9ca3af', text: '#111827', muted: '#6b7280',
    brand: '#0d9488', focus: '#2563eb', danger: '#dc2626', successSoft: '#dcfce7', successOn: '#166534', infoSoft: '#dbeafe',
    infoOn: '#1e40af', warningSoft: '#fef3c7', warningOn: '#92400e', errorSoft: '#fee2e2', errorOn: '#991b1b',
    fontSans: 'system-ui, sans-serif', fontMono: 'ui-monospace, monospace',
    edge: {
      'http-route': '#2563eb', authorizer: '#9333ea', 'event-source': '#0d9488', 's3-notification': '#ea580c', 'event-rule-target': '#db2777',
      'event-bus-rule': '#db2777', 'sns-subscription': '#65a30d', redrive: '#d97706', iam: '#7c3aed', env: '#6b7280', 'cross-service': '#0891b2',
    },
  };
  const counters = new Map([['o/create', { text: '3 calls', tone: 'muted' as const }], ['b/process', { text: '1 errors', tone: 'danger' as const }]]);

  it('renders a small graph to a stable, self-contained document', () => {
    const svg = renderGraphSvg(layoutGraph(demo()), palette, createGraphText(t, counters, true), 'Demo <stack>');
    expect(svg).toMatchSnapshot();
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<title>Demo &lt;stack&gt;</title>');
    // No external references of any kind: nothing for an <img> to fail to load.
    expect(svg).not.toMatch(/href=|url\(|@import|<style|<image|<script/);
    expect(svg).toContain('createOrder');
    expect(svg).toContain('3 calls');
  });

  it('weights aggregated arrows with a pill and fits long labels', () => {
    const graph: GraphInput = {
      nodes: [
        { id: 'service:a', kind: 'service', label: 'a-service-with-a-name-far-too-long-for-any-card', group: 'a', facts: { lambda: 3 } },
        { id: 'service:b', kind: 'service', label: 'b', group: 'b', facts: {} },
        { id: 'external:x', kind: 'external', label: 'x', service: 'sqs', group: 'external' },
      ],
      edges: [edge('service:a', 'service:b', 'cross-service', { weight: 3, via: 'iam', access: 'read' }), edge('service:b', 'external:x', 'iam', { access: 'write' })],
    };
    const svg = renderGraphSvg(layoutGraph(graph), palette, createGraphText(t, new Map(), false), 'x');
    expect(svg).toMatch(/>3<\/text>/);
    expect(svg).toContain('…');
  });

  it('measures and rounds like the canvas', () => {
    expect(textWidth('iii', 10)).toBeLessThan(textWidth('MMM', 10));
    expect(textWidth('abc', 10, true)).toBeCloseTo(18);
    expect(roundedPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 4)).toBe('M0 0 L6 0 Q10 0 10 4 L10 10');
  });
});
