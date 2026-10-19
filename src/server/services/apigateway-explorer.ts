// Read-only API Gateway explorer for the dashboard: lists API keys (with the
// usage plans each belongs to) and usage plans (stages, throttle, quota, key
// count), and — on explicit request — reveals one key's value. Mirrors the
// SecretsExplorer pattern: region from the request, default seeded from the
// engine config and pinned at boot by explorer-region.ts, AWS errors mapped
// to plain messages, "not found" mapped to null.
//
// No AWS SDK here: @aws-sdk/client-api-gateway is not a dependency of this
// repo, and the control plane is small rest-json (engine/emulators/apigateway),
// so the explorer speaks it over plain fetch — the same way the OpenSearch
// explorer drives its data plane. The engine router mines {region, service}
// from the SigV4 credential scope and never verifies the signature, so a
// scope-shaped Authorization header is all it takes to route an unsigned
// request to the `apigateway` emulator in the wanted region.
//
// Secrecy: GetApiKeys is called WITHOUT includeValues, and GetUsagePlanKeys
// (which always answers values, like AWS) is read only for the key ids — the
// values are dropped before anything leaves this module. The single path that
// returns a value is getApiKeyValue, backing a dedicated endpoint.

import { EngineManager } from '../engine/engine-manager.js';

// The emulator caps `limit` at 500 (AWS's own maximum); asking for the max
// keeps the number of round trips down when following `position`.
const PAGE_LIMIT = 500;

export interface ApiKeyPlanRef {
  id: string;
  name: string;
}

export interface ApiKeySummary {
  id: string;
  name?: string;
  description?: string;
  enabled: boolean;
  customerId?: string;
  createdDate?: string;
  lastUpdatedDate?: string;
  // "{restApiId}/{stageName}" — the legacy stage association of a key.
  stageKeys: string[];
  tags: Record<string, string>;
  // Usage plans holding this key, sorted by name.
  usagePlans: ApiKeyPlanRef[];
}

export interface ThrottleSettings {
  burstLimit?: number;
  rateLimit?: number;
}

export interface QuotaSettings {
  limit?: number;
  offset?: number;
  period?: string;
}

export interface UsagePlanSummary {
  id: string;
  name: string;
  description?: string;
  apiStages: Array<{ apiId: string; stage: string }>;
  throttle?: ThrottleSettings;
  quota?: QuotaSettings;
  productCode?: string;
  tags: Record<string, string>;
  keyCount: number;
}

export interface ApiKeyValue {
  id: string;
  name?: string;
  value: string;
}

// A non-2xx answer from the control plane, carrying the AWS error type
// (`x-amzn-ErrorType`, e.g. NotFoundException) as the error's name.
export class ApiGatewayControlPlaneError extends Error {
  readonly status: number;

  constructor(status: number, name: string, message: string) {
    super(message);
    this.name = name;
    this.status = status;
  }
}

// Wire shapes, as the emulator answers them.
interface WireApiKey {
  id: string;
  value?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  customerId?: string;
  createdDate?: number;
  lastUpdatedDate?: number;
  stageKeys?: string[];
  tags?: Record<string, string>;
}

interface WireUsagePlan {
  id: string;
  name?: string;
  description?: string;
  apiStages?: Array<{ apiId?: string; stage?: string }>;
  throttle?: ThrottleSettings;
  quota?: QuotaSettings;
  productCode?: string;
  tags?: Record<string, string>;
}

interface WireUsagePlanKey {
  id: string;
}

interface WirePage<T> {
  item?: T[];
  position?: string;
}

export class ApiGatewayExplorer {
  private static instance: ApiGatewayExplorer;
  private defaultRegion = 'us-east-1';

  // Seeded from the active engine config so a caller that omits `?region=`
  // (CLI, curl) still reads the project's own region — see the matching note
  // in DynamoExplorer.
  private constructor() {
    const region = EngineManager.getInstance().getConfig().region;
    if (region) this.defaultRegion = region;
  }

  static getInstance(): ApiGatewayExplorer {
    if (!ApiGatewayExplorer.instance) ApiGatewayExplorer.instance = new ApiGatewayExplorer();
    return ApiGatewayExplorer.instance;
  }

  setDefaultRegion(region: string): void {
    if (region) this.defaultRegion = region;
  }

  // Keys WITHOUT values, each with the usage plans holding it. Membership is
  // only modelled on the plan side (GetUsagePlanKeys), so this reads every
  // plan's key list once — one call per plan, not per key.
  async listApiKeys(region?: string): Promise<ApiKeySummary[]> {
    const r = region || this.defaultRegion;
    const [keys, plans] = await Promise.all([
      this.listAll<WireApiKey>('/apikeys', r),
      this.listAll<WireUsagePlan>('/usageplans', r),
    ]);
    const membership = await this.planMembership(plans, r);
    return keys
      .map(key => ({
        id: key.id,
        name: key.name,
        description: key.description,
        enabled: key.enabled === true,
        customerId: key.customerId,
        createdDate: isoDate(key.createdDate),
        lastUpdatedDate: isoDate(key.lastUpdatedDate),
        stageKeys: key.stageKeys ?? [],
        tags: key.tags ?? {},
        usagePlans: (membership.get(key.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort(byNameThenId);
  }

  async listUsagePlans(region?: string): Promise<UsagePlanSummary[]> {
    const r = region || this.defaultRegion;
    const plans = await this.listAll<WireUsagePlan>('/usageplans', r);
    const keyIds = await Promise.all(plans.map(plan => this.planKeyIds(plan.id, r)));
    return plans
      .map((plan, index) => ({
        id: plan.id,
        name: plan.name ?? '',
        description: plan.description,
        apiStages: (plan.apiStages ?? []).map(stage => ({ apiId: stage.apiId ?? '', stage: stage.stage ?? '' })),
        throttle: plan.throttle,
        quota: plan.quota,
        productCode: plan.productCode,
        tags: plan.tags ?? {},
        keyCount: keyIds[index].length,
      }))
      .sort(byNameThenId);
  }

  // Reveals one key's value — an explicit, separate call so a plain list never
  // ships key material to the browser. Null when the key does not exist.
  async getApiKeyValue(id: string, region?: string): Promise<ApiKeyValue | null> {
    const r = region || this.defaultRegion;
    try {
      const key = await this.call<WireApiKey>(`/apikeys/${encodeURIComponent(id)}`, r, { includeValue: 'true' });
      return { id: key.id, name: key.name, value: key.value ?? '' };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // key id → the plans holding it.
  private async planMembership(plans: WireUsagePlan[], region: string): Promise<Map<string, ApiKeyPlanRef[]>> {
    const keyIds = await Promise.all(plans.map(plan => this.planKeyIds(plan.id, region)));
    const membership = new Map<string, ApiKeyPlanRef[]>();
    plans.forEach((plan, index) => {
      for (const keyId of keyIds[index]) {
        const refs = membership.get(keyId) ?? [];
        refs.push({ id: plan.id, name: plan.name ?? '' });
        membership.set(keyId, refs);
      }
    });
    return membership;
  }

  // GetUsagePlanKeys always carries `value`; only the id survives this line.
  private async planKeyIds(planId: string, region: string): Promise<string[]> {
    const keys = await this.listAll<WireUsagePlanKey>(`/usageplans/${encodeURIComponent(planId)}/keys`, region);
    return keys.map(key => key.id);
  }

  // Follows `position` until the control plane stops returning one.
  private async listAll<T>(path: string, region: string): Promise<T[]> {
    const items: T[] = [];
    let position: string | undefined;
    do {
      const query: Record<string, string> = { limit: String(PAGE_LIMIT) };
      if (position) query.position = position;
      const page = await this.call<WirePage<T>>(path, region, query);
      items.push(...(page.item ?? []));
      position = page.position;
    } while (position);
    return items;
  }

  private async call<T>(path: string, region: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${EngineManager.getInstance().getConfig().endpoint}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        // Scope-shaped, unsigned — see the header comment.
        authorization:
          `AWS4-HMAC-SHA256 Credential=lss-dashboard/00000000/${region}/apigateway/aws4_request, ` +
          'SignedHeaders=host, Signature=lss',
      },
    });
    const text = await response.text();
    if (!response.ok) throw toError(response, text);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

// rest-json errors: `x-amzn-ErrorType` (possibly "Type:namespace-uri") plus a
// `{ "message": … }` body. Anything less falls back to generic wording.
function toError(response: Response, text: string): ApiGatewayControlPlaneError {
  const type = (response.headers.get('x-amzn-errortype') ?? '').split(':')[0] || 'ApiGatewayError';
  let message = `API Gateway control plane answered HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text) as { message?: unknown } | null;
    if (typeof payload?.message === 'string' && payload.message) message = payload.message;
  } catch {
    // Not JSON — keep the generic message.
  }
  return new ApiGatewayControlPlaneError(response.status, type, message);
}

// The control plane answers dates as epoch seconds.
function isoDate(seconds: number | undefined): string | undefined {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : undefined;
}

function byNameThenId(a: { id: string; name?: string }, b: { id: string; name?: string }): number {
  return (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id);
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiGatewayControlPlaneError && error.name === 'NotFoundException';
}
