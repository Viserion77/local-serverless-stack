import type { Http } from '../http';
import type { ServiceGraphEdge, ServiceGraphEdgeKind, ServiceGraphNode, ServiceGraphNodeKind } from './services';

// --- GET /api/stack/graph ----------------------------------------------------
// Every registered service on one map, cross-service references resolved into
// real edges. Mirrored from the orchestrator's `stack-graph.ts` for the same
// rootDir reason the per-service graph is (see namespaces/services.ts).

export interface StackServiceSummary {
  name: string;
  expanded: boolean;
  // Declared resources by node kind — what a collapsed node shows.
  counts: Partial<Record<ServiceGraphNodeKind, number>>;
  warnings: number;
}

export interface StackGraph {
  services: StackServiceSummary[];
  expanded: string[];
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
  edgeKinds: ServiceGraphEdgeKind[];
  warnings: string[];
}

export interface StackGraphOptions {
  /**
   * Which services to draw in full. Omitted: everything when the stack has 8
   * services or fewer, nothing past that. `'*'`: everything. `[]`: nothing (every
   * service collapsed to one node with aggregate counts).
   */
  expand?: readonly string[] | '*';
}

export interface StackApi {
  /** GET /api/stack/graph — the whole stack's declared wiring. */
  graph(options?: StackGraphOptions): Promise<StackGraph>;
}

export function createStackApi(http: Http): StackApi {
  return {
    graph: (options = {}) => http.json('GET', '/api/stack/graph', {
      query: { expand: options.expand === undefined ? undefined : options.expand === '*' ? '*' : options.expand.join(',') },
    }),
  };
}
