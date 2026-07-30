import {
  OpenSearchServerlessClient,
  ListCollectionsCommand,
} from '@aws-sdk/client-opensearchserverless';
import { LocalStackManager } from './localstack-manager.js';
import { ConfigManager } from './config-manager.js';
import { aossEndpoint } from './resource-provisioner.js';

export interface OpenSearchCollectionSummary {
  name: string;
  // Data-plane base URL for the collection: <aossBase>/_aoss/<name>.
  endpoint: string;
}

export interface OpenSearchIndexSummary {
  index: string;
  docsCount: number;
  health: string;
  status: string;
}

export interface OpenSearchSearchInput {
  index?: string;
  q?: string;
  query?: unknown;
  from?: number;
  size?: number;
}

// One row of the _cat/indices JSON response — counts arrive as strings, per
// the _cat contract (see engine/emulators/opensearch/index.ts catIndices).
interface CatIndexRow {
  index: string;
  health: string;
  status: string;
  'docs.count': string;
}

// Data-plane failure carrying the upstream HTTP status, so the route can
// translate it (404 for an unknown collection) instead of a blanket 500.
export class OpenSearchDataPlaneError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenSearchDataPlaneError';
    this.status = status;
  }
}

export class OpenSearchExplorer {
  private static instance: OpenSearchExplorer;
  private clients = new Map<string, OpenSearchServerlessClient>();
  private defaultRegion: string = 'us-east-1';

  // Seeded from the active engine config so a caller that omits `?region=`
  // (CLI, LssClient, curl) still reads the project's own region — see the
  // matching note in DynamoExplorer.
  private constructor() {
    const region = LocalStackManager.getInstance().getConfig().region;
    if (region) this.defaultRegion = region;
  }

  static getInstance(): OpenSearchExplorer {
    if (!OpenSearchExplorer.instance) OpenSearchExplorer.instance = new OpenSearchExplorer();
    return OpenSearchExplorer.instance;
  }

  setDefaultRegion(region: string): void {
    if (region) this.defaultRegion = region;
  }

  // aoss does not answer on the engine endpoint when the sidecar runs (no
  // LocalStack edition provides aoss). Both planes target the base
  // aossEndpoint() picks: the sidecar when enabled, else the engine itself
  // (the self engine serves aoss natively).
  private aossBase(): string {
    return aossEndpoint(ConfigManager.getInstance(), LocalStackManager.getInstance().getConfig().endpoint);
  }

  private clientFor(region?: string): OpenSearchServerlessClient {
    const r = region || this.defaultRegion;
    let client = this.clients.get(r);
    if (!client) {
      const baseConfig = LocalStackManager.getInstance().getConfig();
      client = new OpenSearchServerlessClient({ ...baseConfig, region: r, endpoint: this.aossBase() });
      this.clients.set(r, client);
    }
    return client;
  }

  async listCollections(region?: string): Promise<OpenSearchCollectionSummary[]> {
    const response = await this.clientFor(region).send(new ListCollectionsCommand({}));
    const base = this.aossBase();
    return (response.collectionSummaries ?? [])
      .map(summary => summary.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
      .map(name => ({ name, endpoint: `${base}/_aoss/${name}` }));
  }

  async listIndices(collection: string, region?: string): Promise<OpenSearchIndexSummary[]> {
    const col = encodeURIComponent(collection);
    // format=json matches the real _cat API (plain text by default); the LSS
    // emulator answers JSON either way.
    const rows = (await this.dataPlaneFetch('GET', `${col}/_cat/indices`, undefined, region, {
      format: 'json',
    })) as CatIndexRow[];
    return rows.map(row => ({
      index: row.index,
      docsCount: Number(row['docs.count']),
      health: row.health,
      status: row.status,
    }));
  }

  async search(collection: string, input: OpenSearchSearchInput, region?: string): Promise<unknown> {
    const col = encodeURIComponent(collection);
    const path = input.index !== undefined
      ? `${col}/${encodeURIComponent(input.index)}/_search`
      : `${col}/_search`;
    const body: Record<string, unknown> = {};
    if (input.query !== undefined) body.query = input.query;
    if (input.from !== undefined) body.from = input.from;
    if (input.size !== undefined) body.size = input.size;
    // ?q= is forwarded verbatim: the emulator derives a match (field:value) or
    // multi_match (bare text) query from it, and rejects q alongside a body
    // query with a 400 that passes through to the caller untouched.
    return this.dataPlaneFetch('POST', path, body, region, input.q !== undefined ? { q: input.q } : undefined);
  }

  private async dataPlaneFetch(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    region: string | undefined,
    params?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.aossBase()}/_aoss/${path}`);
    // Pin the data-plane region without signing: the engine router mines
    // {region, service} from the SigV4 credential scope — the Authorization
    // header or the presigned-style X-Amz-Credential query param — and never
    // verifies the signature (engine/http/sigv4.ts resolveSigV4Scope). A
    // scope-shaped credential is therefore enough to route this unsigned
    // request to the effective region instead of the engine's boot region.
    const r = region || this.defaultRegion;
    url.searchParams.set('X-Amz-Credential', `lss-dashboard/00000000/${r}/aoss/aws4_request`);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);

    const response = await fetch(url, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new OpenSearchDataPlaneError(response.status, this.errorReason(text, response.status));
    }
    return JSON.parse(text) as unknown;
  }

  // Mine the OpenSearch error shape ({"error":{"type","reason"},"status":N})
  // for its reason; anything else falls back to a generic message.
  private errorReason(text: string, status: number): string {
    try {
      const payload = JSON.parse(text) as { error?: { reason?: unknown } } | null;
      const reason = payload?.error?.reason;
      if (typeof reason === 'string') return reason;
    } catch {
      // Not JSON — use the generic message.
    }
    return `OpenSearch data plane answered HTTP ${status}`;
  }
}
