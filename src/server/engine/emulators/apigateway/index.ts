// API Gateway (REST v1) control-plane emulator — signing name `apigateway`,
// protocol restJson1. LSS serves the API Gateway DATA plane itself (the
// gateway manager turns function events and raw ApiGatewayV2 resources into
// local HTTP routes), so what this emulator owns is the account-level state
// that plane consults and tooling writes: API keys, usage plans and the
// membership of keys in plans, plus resource tagging.
//
// Paths, members and status codes are exactly what @aws-sdk/client-api-gateway
// sends and parses: `POST /apikeys` → 201, `GET /apikeys/{id}` → 200,
// `PATCH` (JSON Patch `patchOperations`) → 200, `DELETE` → 202 with no body.
// List calls answer `{ item: [...], position }` — the model's `items` member
// carries jsonName `item`, so a body spelled `items` would parse as an empty
// list. Name filters travel as `?name=` (the SDK's `nameQuery`), booleans as
// the strings "true"/"false". Errors are rest-json: `x-amzn-ErrorType` +
// `{ "message": … }` (the router frames them).
//
// Semantics worth knowing:
//   - CreateApiKey defaults `enabled` to FALSE, like AWS — a key created
//     without `enabled: true` is refused by the data plane until enabled.
//     Disabling a key keeps its usage-plan memberships.
//   - A provided value is stored byte for byte (min 20 chars) and must be
//     unique across the whole engine (ConflictException); an omitted one is
//     generated as 40 alphanumerics. Names may repeat. `value` is returned by
//     CreateApiKey and every usage-plan-key read, and by GetApiKey(s) only with
//     includeValue(s)=true. Values are never logged.
//   - Ids are unique engine-wide: 10 characters for keys, 6 for usage plans.
//   - DeleteApiKey drops the key from every usage plan holding it;
//     DeleteUsagePlan succeeds with stages and keys still attached.
//   - Usage-plan apiStages are accepted as given: REST APIs and stages are not
//     modelled here (their routes live in the LSS gateway), so they are never
//     validated against an existing API.
//
// The in-process contract `resolveApiKeyByValue` is what the local gateway
// calls on every request to a `private: true` route: it maps an `x-api-key`
// value to the key and the usage plans (with their stages) holding it, through
// in-memory indexes (value → key, key → plans) rather than a catalog scan.
//
// Persistence: per region, two catalogs (`apigateway/<region>/apikeys` and
// `…/usageplans`) plus `apigateway/regions`, the list of regions ever used, so
// a restart can rebuild the engine-wide uniqueness indexes before the first
// write. `POST /_lss/reset` wipes everything; `?service=apigateway` wipes only
// this emulator (resetState).
//
// Not covered (NotImplemented, HTTP 501, rest-json shape): ImportApiKeys,
// UpdateUsage, and every other API Gateway resource — REST APIs, resources,
// methods, deployments, stages, authorizers, domain names, VPC links…
// GetUsage answers a well-shaped empty result: no request metering happens.

import type {
  AwsRequest,
  AwsResponse,
  EngineContext,
  EngineServiceName,
  ResettableEmulator,
  RestEmulator,
} from '../../types.js';
import type { CatalogStore } from '../../store/store-types.js';
import {
  badRequest,
  conflict,
  emptyResponse,
  epochSeconds,
  invalidPatchPath,
  jsonResponse,
  newApiKeyValue,
  newResourceId,
  notFound,
  notImplemented,
  optionalString,
  paginate,
  parseJsonBody,
  parsePatchNumber,
  readPatchOperations,
  readTags,
  requirePatchValue,
  type PatchOperation,
} from './wire.js';

// AWS rejects caller-supplied API key values shorter than this.
const MIN_KEY_VALUE_LENGTH = 20;
const API_KEY_ID_LENGTH = 10;
const USAGE_PLAN_ID_LENGTH = 6;
const QUOTA_PERIODS = ['DAY', 'WEEK', 'MONTH'];
const API_KEY_TYPE = 'API_KEY';

export interface ResolvedApiKey {
  id: string;
  name: string;
  enabled: boolean;
  usagePlans: Array<{ id: string; name: string; apiStages: Array<{ apiId: string; stage: string }> }>;
}

interface ThrottleSettings {
  burstLimit?: number;
  rateLimit?: number;
}

interface QuotaSettings {
  limit?: number;
  offset?: number;
  period?: string;
}

interface ApiStage {
  apiId: string;
  stage: string;
  // Per-method throttles keyed "/{resourcePath}/{httpMethod}" — echoed as given.
  throttle?: Record<string, ThrottleSettings>;
}

interface ApiKeyRecord {
  id: string;
  value: string;
  name?: string;
  description?: string;
  enabled: boolean;
  customerId?: string;
  // "{restApiId}/{stageName}" — the legacy stage association of a key.
  stageKeys: string[];
  tags: Record<string, string>;
  createdMs: number;
  updatedMs: number;
}

interface UsagePlanRecord {
  id: string;
  name: string;
  description?: string;
  apiStages: ApiStage[];
  throttle?: ThrottleSettings;
  quota?: QuotaSettings;
  productCode?: string;
  tags: Record<string, string>;
  // API keys added through CreateUsagePlanKey — the persisted source of truth
  // the in-memory `plansByKey` index is rebuilt from.
  keyIds: string[];
}

interface RegionState {
  keys: CatalogStore<ApiKeyRecord>;
  plans: CatalogStore<UsagePlanRecord>;
  // value → key id (resolveApiKeyByValue, value uniqueness).
  byValue: Map<string, string>;
  // key id → ids of the usage plans holding it.
  plansByKey: Map<string, Set<string>>;
}

export class ApiGatewayEmulator implements RestEmulator, ResettableEmulator {
  readonly service: EngineServiceName = 'apigateway';

  private readonly regions = new Map<string, RegionState>();
  // One in-flight open per region, so two first requests racing on a fresh
  // region share one index instead of each building (and losing) their own.
  private readonly opening = new Map<string, Promise<RegionState>>();
  private readonly regionIndex: CatalogStore<{ region: string }>;
  private loaded: Promise<void> | null = null;

  constructor(private readonly ctx: EngineContext) {
    this.regionIndex = ctx.store.catalog<{ region: string }>('apigateway/regions');
  }

  async handle(req: AwsRequest): Promise<AwsResponse> {
    const region = req.region;
    const method = req.method;
    let segments: string[];
    try {
      segments = req.rawPath.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw badRequest(`Invalid request path: ${req.rawPath}`);
    }
    const [root, id, child, childId] = segments;
    const count = segments.length;

    if (root === 'apikeys' && count === 1) {
      if (method === 'POST' && req.query.mode === 'import') throw notImplemented('ImportApiKeys');
      if (method === 'POST') return this.createApiKey(region, parseJsonBody(req.body));
      if (method === 'GET') return this.getApiKeys(region, req.query);
    }
    if (root === 'apikeys' && count === 2) {
      if (method === 'GET') return this.getApiKey(region, id, req.query.includeValue === 'true');
      if (method === 'PATCH') return this.updateApiKey(region, id, parseJsonBody(req.body));
      if (method === 'DELETE') return this.deleteApiKey(region, id);
    }
    if (root === 'usageplans' && count === 1) {
      if (method === 'POST') return this.createUsagePlan(region, parseJsonBody(req.body));
      if (method === 'GET') return this.getUsagePlans(region, req.query);
    }
    if (root === 'usageplans' && count === 2) {
      if (method === 'GET') return jsonResponse(200, toUsagePlan(await this.requirePlan(region, id)));
      if (method === 'PATCH') return this.updateUsagePlan(region, id, parseJsonBody(req.body));
      if (method === 'DELETE') return this.deleteUsagePlan(region, id);
    }
    if (root === 'usageplans' && child === 'keys' && count === 3) {
      if (method === 'POST') return this.createUsagePlanKey(region, id, parseJsonBody(req.body));
      if (method === 'GET') return this.getUsagePlanKeys(region, id, req.query);
    }
    if (root === 'usageplans' && child === 'keys' && count === 4) {
      if (method === 'GET') return this.getUsagePlanKey(region, id, childId);
      if (method === 'DELETE') return this.deleteUsagePlanKey(region, id, childId);
    }
    if (root === 'usageplans' && child === 'usage' && count === 3 && method === 'GET') {
      return this.getUsage(region, id, req.query);
    }
    // The resource ARN is one path label, its own slashes percent-encoded by
    // the SDK; a hand-written client that leaves them raw splits it into
    // several segments, so the remainder is re-joined either way.
    if (root === 'tags' && count >= 2) {
      const arn = segments.slice(1).join('/');
      if (method === 'GET') return this.getTags(region, arn);
      if (method === 'PUT') return this.tagResource(region, arn, parseJsonBody(req.body));
      if (method === 'DELETE') return this.untagResource(region, arn, tagKeysOf(req));
    }
    throw notImplemented(`${method} ${req.rawPath}`);
  }

  // -- in-process contract ---------------------------------------------------

  /**
   * Resolve an `x-api-key` header value to its key and the usage plans that
   * hold it. Disabled keys ARE returned (with `enabled: false`) so the caller
   * decides how to refuse them. Index lookups only — this runs on every
   * request to a private route.
   */
  async resolveApiKeyByValue(region: string, value: string): Promise<ResolvedApiKey | undefined> {
    const state = await this.stateFor(region);
    const keyId = state.byValue.get(value);
    if (keyId === undefined) return undefined;
    const key = state.keys.get(keyId) as ApiKeyRecord;
    const planIds = state.plansByKey.get(keyId) ?? new Set<string>();
    return {
      id: key.id,
      name: key.name ?? '',
      enabled: key.enabled,
      usagePlans: [...planIds].map((planId) => {
        const plan = state.plans.get(planId) as UsagePlanRecord;
        return {
          id: plan.id,
          name: plan.name,
          apiStages: plan.apiStages.map((stage) => ({ apiId: stage.apiId, stage: stage.stage })),
        };
      }),
    };
  }

  /** Wipe every API key and usage plan in every region (POST /_lss/reset?service=apigateway). */
  async resetState(): Promise<void> {
    await this.ensureLoaded();
    for (const state of this.regions.values()) {
      for (const id of state.keys.keys()) state.keys.delete(id);
      for (const id of state.plans.keys()) state.plans.delete(id);
      state.byValue.clear();
      state.plansByKey.clear();
    }
  }

  // -- state and indexes -----------------------------------------------------

  // Opens every region ever used, once, so the engine-wide uniqueness checks
  // (ids, values) see keys created before a restart in regions not yet touched.
  private ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      await this.regionIndex.load();
      for (const region of this.regionIndex.keys()) await this.openRegion(region);
    })();
    return this.loaded;
  }

  private openRegion(region: string): Promise<RegionState> {
    let pending = this.opening.get(region);
    if (!pending) {
      pending = (async () => {
        const state: RegionState = {
          keys: this.ctx.store.catalog<ApiKeyRecord>(`apigateway/${region}/apikeys`),
          plans: this.ctx.store.catalog<UsagePlanRecord>(`apigateway/${region}/usageplans`),
          byValue: new Map(),
          plansByKey: new Map(),
        };
        await state.keys.load();
        await state.plans.load();
        for (const key of state.keys.values()) state.byValue.set(key.value, key.id);
        for (const plan of state.plans.values()) {
          for (const keyId of plan.keyIds) linkKey(state, keyId, plan.id);
        }
        this.regions.set(region, state);
        return state;
      })();
      this.opening.set(region, pending);
    }
    return pending;
  }

  private async stateFor(region: string): Promise<RegionState> {
    await this.ensureLoaded();
    const state = await this.openRegion(region);
    if (this.regionIndex.get(region) === undefined) this.regionIndex.set(region, { region });
    return state;
  }

  private idTaken(id: string): boolean {
    return [...this.regions.values()].some((state) => state.keys.get(id) !== undefined || state.plans.get(id) !== undefined);
  }

  private async requireKey(region: string, id: string): Promise<ApiKeyRecord> {
    const key = (await this.stateFor(region)).keys.get(id);
    if (!key) throw notFound('Invalid API Key identifier specified');
    return key;
  }

  private async requirePlan(region: string, id: string): Promise<UsagePlanRecord> {
    const plan = (await this.stateFor(region)).plans.get(id);
    if (!plan) throw notFound('Invalid Usage Plan ID specified');
    return plan;
  }

  // -- API keys --------------------------------------------------------------

  private async createApiKey(region: string, input: Record<string, unknown>): Promise<AwsResponse> {
    const state = await this.stateFor(region);
    const provided = optionalString(input, 'value');
    if (provided !== undefined && provided.length < MIN_KEY_VALUE_LENGTH) {
      throw badRequest(`API Key value should be at least ${MIN_KEY_VALUE_LENGTH} characters`);
    }
    if (provided !== undefined && [...this.regions.values()].some((other) => other.byValue.has(provided))) {
      throw conflict('API Key already exists');
    }
    // `generateDistinctId` is a deprecated no-op in AWS too: ids are always
    // distinct from values.
    const now = Date.now();
    const record: ApiKeyRecord = {
      id: newResourceId(API_KEY_ID_LENGTH, (id) => this.idTaken(id)),
      value: provided ?? newApiKeyValue(),
      name: optionalString(input, 'name'),
      description: optionalString(input, 'description'),
      enabled: input.enabled === true,
      customerId: optionalString(input, 'customerId'),
      stageKeys: readStageKeys(input.stageKeys),
      tags: readTags(input.tags),
      createdMs: now,
      updatedMs: now,
    };
    state.keys.set(record.id, record);
    state.byValue.set(record.value, record.id);
    return jsonResponse(201, toApiKey(record, true));
  }

  private async getApiKey(region: string, id: string, includeValue: boolean): Promise<AwsResponse> {
    return jsonResponse(200, toApiKey(await this.requireKey(region, id), includeValue));
  }

  private async getApiKeys(region: string, query: Record<string, string>): Promise<AwsResponse> {
    const { keys } = await this.stateFor(region);
    // `name` (the SDK's nameQuery) is a prefix match; customerId is exact.
    const matching = keys.values().filter(
      (key) =>
        (query.name === undefined || (key.name ?? '').startsWith(query.name)) &&
        (query.customerId === undefined || key.customerId === query.customerId),
    );
    const { page, position } = paginate(matching, query);
    const includeValues = query.includeValues === 'true';
    return jsonResponse(200, { item: page.map((key) => toApiKey(key, includeValues)), position });
  }

  private async updateApiKey(region: string, id: string, input: Record<string, unknown>): Promise<AwsResponse> {
    const key = await this.requireKey(region, id);
    for (const operation of readPatchOperations(input)) applyApiKeyPatch(key, operation);
    key.updatedMs = Date.now();
    (await this.stateFor(region)).keys.set(key.id, key);
    return jsonResponse(200, toApiKey(key, false));
  }

  private async deleteApiKey(region: string, id: string): Promise<AwsResponse> {
    const key = await this.requireKey(region, id);
    const state = await this.stateFor(region);
    state.keys.delete(id);
    state.byValue.delete(key.value);
    // A deleted key leaves no dangling usage-plan membership behind.
    for (const planId of state.plansByKey.get(id) ?? []) {
      const plan = state.plans.get(planId) as UsagePlanRecord;
      plan.keyIds = plan.keyIds.filter((keyId) => keyId !== id);
      state.plans.set(plan.id, plan);
    }
    state.plansByKey.delete(id);
    return emptyResponse(202);
  }

  // -- usage plans -----------------------------------------------------------

  private async createUsagePlan(region: string, input: Record<string, unknown>): Promise<AwsResponse> {
    const { plans } = await this.stateFor(region);
    const name = optionalString(input, 'name');
    if (!name) throw badRequest('Invalid usage plan name specified: name is required');
    const record: UsagePlanRecord = {
      id: newResourceId(USAGE_PLAN_ID_LENGTH, (id) => this.idTaken(id)),
      name,
      description: optionalString(input, 'description'),
      apiStages: readApiStages(input.apiStages),
      throttle: readThrottle(input.throttle),
      quota: readQuota(input.quota),
      productCode: optionalString(input, 'productCode'),
      tags: readTags(input.tags),
      keyIds: [],
    };
    plans.set(record.id, record);
    return jsonResponse(201, toUsagePlan(record));
  }

  private async getUsagePlans(region: string, query: Record<string, string>): Promise<AwsResponse> {
    const state = await this.stateFor(region);
    // keyId narrows to the plans that hold that key (an unknown key → none).
    const holding = query.keyId === undefined ? undefined : state.plansByKey.get(query.keyId) ?? new Set<string>();
    const matching = state.plans.values().filter((plan) => !holding || holding.has(plan.id));
    const { page, position } = paginate(matching, query);
    return jsonResponse(200, { item: page.map(toUsagePlan), position });
  }

  private async updateUsagePlan(region: string, id: string, input: Record<string, unknown>): Promise<AwsResponse> {
    const plan = await this.requirePlan(region, id);
    for (const operation of readPatchOperations(input)) applyUsagePlanPatch(plan, operation);
    (await this.stateFor(region)).plans.set(plan.id, plan);
    return jsonResponse(200, toUsagePlan(plan));
  }

  // Succeeds with stages and keys still attached; the keys themselves survive.
  private async deleteUsagePlan(region: string, id: string): Promise<AwsResponse> {
    const plan = await this.requirePlan(region, id);
    const state = await this.stateFor(region);
    for (const keyId of plan.keyIds) unlinkKey(state, keyId, plan.id);
    state.plans.delete(id);
    return emptyResponse(202);
  }

  // -- usage plan keys -------------------------------------------------------

  private async createUsagePlanKey(region: string, planId: string, input: Record<string, unknown>): Promise<AwsResponse> {
    const plan = await this.requirePlan(region, planId);
    const keyType = optionalString(input, 'keyType');
    if (keyType !== API_KEY_TYPE) throw badRequest(`Invalid keyType specified: ${String(keyType)}. Must be ${API_KEY_TYPE}`);
    const keyId = optionalString(input, 'keyId');
    if (!keyId) throw badRequest('Invalid API Key identifier specified: keyId is required');
    const key = await this.requireKey(region, keyId);
    if (plan.keyIds.includes(keyId)) throw conflict('Usage Plan Key already exists');
    const state = await this.stateFor(region);
    plan.keyIds.push(keyId);
    state.plans.set(plan.id, plan);
    linkKey(state, keyId, plan.id);
    return jsonResponse(201, toUsagePlanKey(key));
  }

  private async getUsagePlanKeys(region: string, planId: string, query: Record<string, string>): Promise<AwsResponse> {
    const plan = await this.requirePlan(region, planId);
    const { keys } = await this.stateFor(region);
    // Membership only ever names live keys: DeleteApiKey prunes it.
    const members = plan.keyIds
      .map((keyId) => keys.get(keyId) as ApiKeyRecord)
      .filter((key) => query.name === undefined || (key.name ?? '').startsWith(query.name));
    const { page, position } = paginate(members, query);
    return jsonResponse(200, { item: page.map(toUsagePlanKey), position });
  }

  private async getUsagePlanKey(region: string, planId: string, keyId: string): Promise<AwsResponse> {
    return jsonResponse(200, toUsagePlanKey(await this.requirePlanMember(region, planId, keyId)));
  }

  private async deleteUsagePlanKey(region: string, planId: string, keyId: string): Promise<AwsResponse> {
    await this.requirePlanMember(region, planId, keyId);
    const plan = await this.requirePlan(region, planId);
    const state = await this.stateFor(region);
    plan.keyIds = plan.keyIds.filter((member) => member !== keyId);
    state.plans.set(plan.id, plan);
    unlinkKey(state, keyId, plan.id);
    return emptyResponse(202);
  }

  private async requirePlanMember(region: string, planId: string, keyId: string): Promise<ApiKeyRecord> {
    const plan = await this.requirePlan(region, planId);
    const key = (await this.stateFor(region)).keys.get(keyId);
    if (!key || !plan.keyIds.includes(keyId)) throw notFound('Invalid Usage Plan Key identifier specified');
    return key;
  }

  // -- usage -----------------------------------------------------------------

  // No request metering happens locally, so the result is well-shaped and
  // empty: `items` maps key id → per-day [used, remaining] pairs in AWS (this
  // member has no jsonName override, unlike the list `item`).
  private async getUsage(region: string, planId: string, query: Record<string, string>): Promise<AwsResponse> {
    await this.requirePlan(region, planId);
    if (!query.startDate || !query.endDate) throw badRequest('Both startDate and endDate are required');
    return jsonResponse(200, { usagePlanId: planId, startDate: query.startDate, endDate: query.endDate, items: {} });
  }

  // -- tags ------------------------------------------------------------------

  private async taggable(
    requestRegion: string,
    arn: string,
  ): Promise<{ record: { tags: Record<string, string> }; save: () => void }> {
    // arn:aws:apigateway:<region>::/apikeys/<id> | /usageplans/<id>
    const match = /^arn:aws[\w-]*:apigateway:([^:]*)::\/(apikeys|usageplans)\/([^/]+)$/.exec(arn);
    if (!match) throw notFound(`Invalid resource identifier specified: ${arn}`);
    const { keys, plans } = await this.stateFor(match[1] || requestRegion);
    if (match[2] === 'apikeys') {
      const key = keys.get(match[3]);
      if (key) return { record: key, save: () => keys.set(key.id, key) };
    } else {
      const plan = plans.get(match[3]);
      if (plan) return { record: plan, save: () => plans.set(plan.id, plan) };
    }
    throw notFound(`Invalid resource identifier specified: ${arn}`);
  }

  private async getTags(region: string, arn: string): Promise<AwsResponse> {
    const { record } = await this.taggable(region, arn);
    return jsonResponse(200, { tags: record.tags });
  }

  private async tagResource(region: string, arn: string, input: Record<string, unknown>): Promise<AwsResponse> {
    const { record, save } = await this.taggable(region, arn);
    Object.assign(record.tags, readTags(input.tags));
    save();
    return emptyResponse(204);
  }

  private async untagResource(region: string, arn: string, tagKeys: string[]): Promise<AwsResponse> {
    const { record, save } = await this.taggable(region, arn);
    for (const key of tagKeys) delete record.tags[key];
    save();
    return emptyResponse(204);
  }
}

// ---------------------------------------------------------------------------
// Membership index
// ---------------------------------------------------------------------------

function linkKey(state: RegionState, keyId: string, planId: string): void {
  let plans = state.plansByKey.get(keyId);
  if (!plans) {
    plans = new Set();
    state.plansByKey.set(keyId, plans);
  }
  plans.add(planId);
}

// Only called for a membership the plan record holds, so the entry exists.
function unlinkKey(state: RegionState, keyId: string, planId: string): void {
  const plans = state.plansByKey.get(keyId) as Set<string>;
  plans.delete(planId);
  if (plans.size === 0) state.plansByKey.delete(keyId);
}

// ---------------------------------------------------------------------------
// Output shapes (restJson1 member names, exactly as the SDK model spells them)
// ---------------------------------------------------------------------------

function toApiKey(key: ApiKeyRecord, includeValue: boolean): Record<string, unknown> {
  return {
    id: key.id,
    value: includeValue ? key.value : undefined,
    name: key.name,
    customerId: key.customerId,
    description: key.description,
    enabled: key.enabled,
    createdDate: epochSeconds(key.createdMs),
    lastUpdatedDate: epochSeconds(key.updatedMs),
    stageKeys: key.stageKeys,
    tags: key.tags,
  };
}

function toUsagePlan(plan: UsagePlanRecord): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    apiStages: plan.apiStages,
    throttle: plan.throttle,
    quota: plan.quota,
    productCode: plan.productCode,
    tags: plan.tags,
  };
}

// A usage plan key always carries the key's value (no includeValue switch).
function toUsagePlanKey(key: ApiKeyRecord): Record<string, unknown> {
  return { id: key.id, type: API_KEY_TYPE, name: key.name, value: key.value };
}

// ---------------------------------------------------------------------------
// Input readers
// ---------------------------------------------------------------------------

// CreateApiKey `stageKeys`: [{ restApiId, stageName }] → "restApiId/stageName".
function readStageKeys(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('stageKeys must be a list');
  return raw.map((entry: unknown) => {
    const { restApiId, stageName } = (entry ?? {}) as Record<string, unknown>;
    if (typeof restApiId !== 'string' || typeof stageName !== 'string' || !restApiId || !stageName) {
      throw badRequest('Invalid stage key specified: restApiId and stageName are required');
    }
    return `${restApiId}/${stageName}`;
  });
}

function readApiStages(raw: unknown): ApiStage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('apiStages must be a list');
  const stages: ApiStage[] = [];
  for (const entry of raw as unknown[]) {
    const { apiId, stage, throttle } = (entry ?? {}) as Record<string, unknown>;
    if (typeof apiId !== 'string' || typeof stage !== 'string' || !apiId || !stage) {
      throw badRequest('Invalid API stage specified: apiId and stage are required');
    }
    if (stages.some((existing) => existing.apiId === apiId && existing.stage === stage)) continue;
    let perMethod: Record<string, ThrottleSettings> | undefined;
    if (throttle !== undefined && throttle !== null) {
      if (typeof throttle !== 'object' || Array.isArray(throttle)) throw badRequest('apiStages[].throttle must be a map');
      perMethod = {};
      for (const [route, settings] of Object.entries(throttle as Record<string, unknown>)) {
        const parsed = readThrottle(settings);
        if (parsed) perMethod[route] = parsed;
      }
    }
    stages.push({ apiId, stage, throttle: perMethod });
  }
  return stages;
}

function readNonNegative(source: Record<string, unknown>, member: string, integer: boolean): number | undefined {
  const value = source[member];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || value < 0 || (integer && !Number.isInteger(value))) {
    throw badRequest(`Invalid value for ${member}: expected a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function readThrottle(raw: unknown): ThrottleSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('throttle must be an object');
  const source = raw as Record<string, unknown>;
  return { burstLimit: readNonNegative(source, 'burstLimit', true), rateLimit: readNonNegative(source, 'rateLimit', false) };
}

function readQuota(raw: unknown): QuotaSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('quota must be an object');
  const source = raw as Record<string, unknown>;
  const period = source.period;
  if (typeof period !== 'string' || !QUOTA_PERIODS.includes(period)) {
    throw badRequest(`Invalid quota period specified: ${String(period)}. Must be one of: [${QUOTA_PERIODS.join(', ')}]`);
  }
  return { limit: readNonNegative(source, 'limit', true), offset: readNonNegative(source, 'offset', true) ?? 0, period };
}

// DELETE /tags/{arn}?tagKeys=a&tagKeys=b — a repeated query member, so it is
// read off the raw query string (the parsed map keeps only the last value).
function tagKeysOf(req: AwsRequest): string[] {
  if (req.rawQuery !== undefined) return new URLSearchParams(req.rawQuery).getAll('tagKeys');
  return req.query.tagKeys !== undefined ? [req.query.tagKeys] : [];
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

const API_KEY_PATCH_PATHS = ['/name', '/description', '/enabled', '/customerId', '/stages'];

function applyApiKeyPatch(key: ApiKeyRecord, operation: PatchOperation): void {
  const { op, path } = operation;
  if (op === 'replace' && path === '/name') key.name = requirePatchValue(operation);
  else if (op === 'replace' && path === '/description') key.description = operation.value ?? '';
  else if (op === 'replace' && path === '/customerId') key.customerId = operation.value ?? '';
  else if (op === 'replace' && path === '/enabled') {
    // Idempotent: disabling a disabled key is a 200 like any other update.
    const value = requirePatchValue(operation);
    if (value !== 'true' && value !== 'false') throw badRequest(`Invalid value '${value}' for /enabled: must be true or false`);
    key.enabled = value === 'true';
  } else if ((op === 'add' || op === 'remove') && path === '/stages') {
    // Value "{restApiId}/{stageName}".
    const value = requirePatchValue(operation);
    if (!/^[^/]+\/[^/]+$/.test(value)) throw badRequest(`Invalid stage key '${value}': expected {restApiId}/{stageName}`);
    key.stageKeys = key.stageKeys.filter((stageKey) => stageKey !== value);
    if (op === 'add') key.stageKeys.push(value);
  } else {
    throw invalidPatchPath(operation, API_KEY_PATCH_PATHS);
  }
}

const USAGE_PLAN_PATCH_PATHS = [
  '/name', '/description', '/productCode', '/apiStages', '/throttle', '/throttle/burstLimit', '/throttle/rateLimit',
  '/quota', '/quota/limit', '/quota/offset', '/quota/period',
];

function applyUsagePlanPatch(plan: UsagePlanRecord, operation: PatchOperation): void {
  const { op, path } = operation;
  if (op === 'replace') {
    switch (path) {
      case '/name': plan.name = requirePatchValue(operation); return;
      case '/description': plan.description = operation.value ?? ''; return;
      case '/productCode': plan.productCode = operation.value ?? ''; return;
      case '/throttle/burstLimit': plan.throttle = { ...plan.throttle, burstLimit: parsePatchNumber(operation, true) }; return;
      case '/throttle/rateLimit': plan.throttle = { ...plan.throttle, rateLimit: parsePatchNumber(operation, false) }; return;
      case '/quota/limit': plan.quota = { ...plan.quota, limit: parsePatchNumber(operation, true) }; return;
      case '/quota/offset': plan.quota = { ...plan.quota, offset: parsePatchNumber(operation, true) }; return;
      case '/quota/period': {
        const period = requirePatchValue(operation);
        if (!QUOTA_PERIODS.includes(period)) {
          throw badRequest(`Invalid quota period specified: ${period}. Must be one of: [${QUOTA_PERIODS.join(', ')}]`);
        }
        plan.quota = { ...plan.quota, period };
        return;
      }
    }
  }
  if (op === 'remove' && path === '/throttle') {
    plan.throttle = undefined;
    return;
  }
  if (op === 'remove' && path === '/quota') {
    plan.quota = undefined;
    return;
  }
  if ((op === 'add' || op === 'remove') && path === '/apiStages') {
    // Value "{apiId}:{stage}".
    const value = requirePatchValue(operation);
    const match = /^([^:]+):([^:]+)$/.exec(value);
    if (!match) throw badRequest(`Invalid API stage '${value}': expected {apiId}:{stage}`);
    const [, apiId, stage] = match;
    const present = plan.apiStages.some((entry) => entry.apiId === apiId && entry.stage === stage);
    if (op === 'add' && !present) plan.apiStages.push({ apiId, stage });
    if (op === 'remove') plan.apiStages = plan.apiStages.filter((entry) => entry.apiId !== apiId || entry.stage !== stage);
    return;
  }
  throw invalidPatchPath(operation, USAGE_PLAN_PATCH_PATHS);
}
