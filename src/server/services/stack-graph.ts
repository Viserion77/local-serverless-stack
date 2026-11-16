// The wiring of the WHOLE stack: every registered service's graph on one
// canvas, with the cross-service references resolved into real edges.
//
// Why this is a second module and not a loop in the route: a single-service
// graph can only say "billing reads a queue called orders-to-process that I do
// not declare" — an `external` stub. Which service DOES declare it is only
// knowable with every template in hand, and that join is the whole reason a
// monorepo wants one stack instead of fifteen. Keeping it pure (graphs in,
// graph out, no cache, no clock) is what lets the 40-service benchmark run in
// the unit suite.
//
// Two jobs, in order:
//  1. RESOLVE — every external stub whose (kind, physical name) matches a
//     resource another service declares becomes an edge to that real node, of
//     kind `cross-service`, keeping the evidence it came from in `via`. The
//     index is the same one `GET /api/resources/owners` answers from: the
//     declared names in the cached templates.
//  2. COLLAPSE — a service that is not expanded becomes ONE node carrying
//     aggregate counts, and every edge that touched it is re-pointed at that
//     node and aggregated with a `weight`. At 40 services × 60 functions the
//     expanded stack is ~4 000 nodes; collapsed it is 40 boxes and the few
//     dozen arrows between them, which is the picture a person can read.
import type {
  EdgeAccess,
  GraphEdge,
  GraphEdgeKind,
  GraphFactValue,
  GraphNode,
  GraphNodeKind,
  ServiceGraph,
} from './service-graph.js';
import { externalTarget, physicalName } from './service-graph.js';

/**
 * Past this many services the stack opens collapsed. Eight frames of ~6 cards
 * each still fit one screen at a readable zoom; nine is where the expanded
 * picture starts needing a scrollbar in both axes. A request can always ask
 * for any explicit set with `?expand=`.
 */
export const COLLAPSE_THRESHOLD = 8;

/** One row of the stack's service list — what the expand/collapse control shows. */
export interface StackServiceSummary {
  name: string;
  expanded: boolean;
  // Declared resources by kind (`lambda: 58, dynamodb: 9, …`) — the same numbers
  // a collapsed node carries in its facts.
  counts: Partial<Record<GraphNodeKind, number>>;
  warnings: number;
}

export interface StackGraph {
  services: StackServiceSummary[];
  // The services drawn in full, in name order.
  expanded: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  edgeKinds: GraphEdgeKind[];
  // Every service's warnings, prefixed with the service name.
  warnings: string[];
}

/**
 * Which services to draw in full.
 *
 * - no `expand` parameter → the default: everything expanded up to
 *   `COLLAPSE_THRESHOLD` services, everything collapsed past it;
 * - `expand=*` → everything;
 * - `expand=` (empty) → nothing;
 * - `expand=orders,billing` → those (unknown names are ignored, so a stale
 *   bookmark after a service was removed still opens).
 */
export function resolveExpansion(serviceNames: readonly string[], expand: string | undefined): Set<string> {
  if (expand === undefined) {
    return new Set(serviceNames.length > COLLAPSE_THRESHOLD ? [] : serviceNames);
  }
  if (expand.trim() === '*') return new Set(serviceNames);
  const known = new Set(serviceNames);
  return new Set(expand.split(',').map(name => name.trim()).filter(name => known.has(name)));
}

// Stack-wide node ids. A declared node keeps its per-service id behind the
// service name (`orders-service/sqs:OrdersToProcessQueue`) because two services
// may both declare an `OrdersTable`; an external keeps its own id, because the
// same third-party host or unregistered ARN referenced by two services is ONE
// box in the right-hand column, not two.
function stackId(service: string, node: GraphNode): string {
  return node.kind === 'external' ? node.id : `${service}/${node.id}`;
}

function collapsedId(service: string): string {
  return `service:${service}`;
}

// Same NUL-separated shape the per-service builder keys its edges with.
function edgeKey(from: string, to: string, kind: GraphEdgeKind): string {
  return `${from}\u0000${to}\u0000${kind}`;
}

// The index key a declared node is found under. Secrets are additionally
// matched by prefix (AWS appends six random characters to a secret's ARN).
function resolveKey(kind: GraphNodeKind, name: string): string {
  return `${kind}\u0000${kind === 'ssm' ? name.replace(/^\//, '') : name}`;
}

/** Declared-resource counts per kind for one service — what a collapsed node shows. */
function countsOf(graph: ServiceGraph): Partial<Record<GraphNodeKind, number>> {
  const counts: Partial<Record<GraphNodeKind, number>> = {};
  for (const node of graph.nodes) {
    // Routes are folded into the API, externals belong to nobody, and the role
    // hub is a rendering device rather than a resource the service declared
    // for itself — none of them is something a person counts.
    if (node.kind === 'route' || node.kind === 'external' || node.kind === 'iam-role') continue;
    counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  }
  return counts;
}

interface Located {
  service: string;
  id: string;
}

/**
 * Join every service's graph into one.
 *
 * Deterministic by construction — services in name order, nodes and edges in
 * each service's own (template) order — so the dashboard's 10 s refetch never
 * reorders the payload and the layout above it never reshuffles.
 */
export function buildStackGraph(graphs: readonly ServiceGraph[], expand: ReadonlySet<string>): StackGraph {
  const ordered = [...graphs].sort((a, b) => a.service.localeCompare(b.service));

  // --- 1. Index every declared node by (kind, physical name) -----------------
  const declared = new Map<string, Located>();
  const secrets: Array<{ name: string; at: Located }> = [];
  for (const graph of ordered) {
    for (const node of graph.nodes) {
      const name = physicalName(node);
      if (!name) continue;
      const at = { service: graph.service, id: stackId(graph.service, node) };
      const key = resolveKey(node.kind, name);
      // First declaration wins (name order): two services declaring the same
      // physical name is a conflict the engine would refuse anyway, and a
      // stable winner keeps the picture stable.
      if (!declared.has(key)) declared.set(key, at);
      if (node.kind === 'secret') secrets.push({ name, at });
    }
  }

  const resolve = (node: GraphNode): Located | null => {
    const target = externalTarget(node);
    if (!target) return null;
    const exact = declared.get(resolveKey(target.kind, target.name));
    if (exact) return exact;
    if (target.kind !== 'secret') return null;
    return secrets.find(secret => target.name.startsWith(secret.name))?.at ?? null;
  };

  // --- 2. Nodes, edges, with externals resolved --------------------------------
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const ownerOf = new Map<string, string>(); // stack node id → owning service
  const warnings: string[] = [];
  const summaries: StackServiceSummary[] = [];

  for (const graph of ordered) {
    summaries.push({
      name: graph.service,
      expanded: expand.has(graph.service),
      counts: countsOf(graph),
      warnings: graph.warnings.length,
    });
    for (const warning of graph.warnings) warnings.push(`[${graph.service}] ${warning}`);
    // A collapsed service whose graph has NO nodes (registered, nothing
    // cached) still deserves its box — an absent box would be a service
    // silently missing from the map. Seeded here, in service order, so the
    // collapse pass below finds it in the right slot.
    if (!expand.has(graph.service) && graph.nodes.length === 0) {
      const id = collapsedId(graph.service);
      nodes.set(id, { id, kind: 'service', label: graph.service, group: graph.service, facts: {} });
      ownerOf.set(id, graph.service);
    }

    // Where each of this graph's node ids lands in the stack.
    const mapped = new Map<string, Located>();
    for (const node of graph.nodes) {
      const resolved = node.kind === 'external' ? resolve(node) : null;
      if (resolved) {
        mapped.set(node.id, resolved);
        continue;
      }
      const id = stackId(graph.service, node);
      mapped.set(node.id, { service: node.kind === 'external' ? 'external' : graph.service, id });
      if (nodes.has(id)) continue; // an external another service already added
      const copy: GraphNode = { ...node, id };
      if (copy.api) copy.api = `${graph.service}/${copy.api}`;
      if (copy.facts?.dlqOf !== undefined) {
        copy.facts = { ...copy.facts, dlqOf: `${graph.service}/${String(copy.facts.dlqOf)}` };
      }
      nodes.set(id, copy);
      ownerOf.set(id, node.kind === 'external' ? 'external' : graph.service);
    }

    for (const edge of graph.edges) {
      const from = mapped.get(edge.from)!;
      const to = mapped.get(edge.to)!;
      // An edge whose far end was resolved into ANOTHER service is the point of
      // this whole module: it becomes `cross-service`, and `via` remembers
      // whether it was an event-source mapping, an IAM grant, an env match…
      const crosses = from.service !== to.service && from.service !== 'external' && to.service !== 'external';
      const kind: GraphEdgeKind = crosses ? 'cross-service' : edge.kind;
      const key = edgeKey(from.id, to.id, kind);
      if (edges.has(key)) continue;
      const next: GraphEdge = { ...edge, id: key, from: from.id, to: to.id, kind };
      if (crosses) next.via = edge.kind;
      edges.set(key, next);
    }
  }

  // --- 3. Collapse ---------------------------------------------------------------
  const collapsed = new Set(ordered.map(graph => graph.service).filter(service => !expand.has(service)));
  if (collapsed.size > 0) {
    collapse(nodes, edges, ownerOf, collapsed, summaries);
  }

  const edgeList = [...edges.values()];
  return {
    services: summaries,
    expanded: summaries.filter(summary => summary.expanded).map(summary => summary.name),
    nodes: [...nodes.values()],
    edges: edgeList,
    edgeKinds: [...new Set(edgeList.map(edge => edge.kind))],
    warnings,
  };
}

/**
 * Replace every node of a collapsed service with one `service` node and fold
 * the edges onto it.
 *
 * An edge with both ends inside one collapsed service is internal and goes. An
 * edge with at least one collapsed end is re-pointed and aggregated by
 * (from, to): the result carries `weight` (how many edges it stands for), keeps
 * the members' kind/`via`/`access` when they all agree, and is `declared` if
 * any member is — the strongest evidence among them is what the arrow claims.
 */
function collapse(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  ownerOf: Map<string, string>,
  collapsed: ReadonlySet<string>,
  summaries: readonly StackServiceSummary[],
): void {
  const target = (id: string): string => {
    const owner = ownerOf.get(id)!;
    return collapsed.has(owner) ? collapsedId(owner) : id;
  };

  // Rebuild the node map in place, keeping its order: every collapsed service's
  // node takes the slot of that service's first node.
  const rebuilt = new Map<string, GraphNode>();
  for (const [id, node] of nodes) {
    const owner = ownerOf.get(id)!;
    if (!collapsed.has(owner)) {
      rebuilt.set(id, node);
      continue;
    }
    const serviceNode = collapsedId(owner);
    if (rebuilt.has(serviceNode)) continue;
    const counts = summaries.find(summary => summary.name === owner)!.counts;
    const facts: Record<string, GraphFactValue> = {};
    for (const [kind, count] of Object.entries(counts)) facts[kind] = count as number;
    rebuilt.set(serviceNode, { id: serviceNode, kind: 'service', label: owner, group: owner, facts });
  }
  nodes.clear();
  for (const [id, node] of rebuilt) nodes.set(id, node);

  const groups = new Map<string, GraphEdge[]>();
  const order: string[] = [];
  const kept = new Map<string, GraphEdge>();
  for (const [key, edge] of edges) {
    const from = target(edge.from);
    const to = target(edge.to);
    if (from === edge.from && to === edge.to) {
      kept.set(key, edge);
      order.push(key);
      continue;
    }
    if (from === to) continue; // internal to one collapsed service
    const pair = `${from}\u0000${to}`;
    const members = groups.get(pair);
    if (members) {
      members.push(edge);
    } else {
      groups.set(pair, [edge]);
      order.push(pair);
    }
  }

  edges.clear();
  for (const key of order) {
    const plain = kept.get(key);
    if (plain) {
      edges.set(key, plain);
      continue;
    }
    const members = groups.get(key)!;
    const [from, to] = key.split('\u0000');
    const kinds = new Set(members.map(edge => edge.kind));
    const kind: GraphEdgeKind = kinds.size === 1 ? members[0].kind : 'cross-service';
    const aggregated: GraphEdge = {
      id: edgeKey(from, to, kind),
      from,
      to,
      kind,
      confidence: members.some(edge => edge.confidence === 'declared') ? 'declared' : 'inferred',
      weight: members.length,
    };
    const vias = new Set(members.map(edge => edge.via ?? edge.kind));
    if (kind === 'cross-service' && vias.size === 1) aggregated.via = [...vias][0];
    const accesses = new Set(members.map(edge => edge.access));
    const access = accesses.size === 1 ? [...accesses][0] : mergedAccess(accesses);
    if (access) aggregated.access = access;
    aggregated.detail = members.length === 1 ? members[0].detail : `${members.length} links`;
    if (aggregated.detail === undefined) delete aggregated.detail;
    edges.set(aggregated.id, aggregated);
  }
}

// Mixed directions among the members of one aggregated arrow: if any of them
// moves data, the arrow is two-way data; otherwise it has no single direction.
function mergedAccess(accesses: ReadonlySet<EdgeAccess | undefined>): EdgeAccess | undefined {
  const data: ReadonlySet<EdgeAccess | undefined> = new Set<EdgeAccess>(['read', 'write', 'readwrite']);
  return [...accesses].some(access => data.has(access)) ? 'readwrite' : undefined;
}
