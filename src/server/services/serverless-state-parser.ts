// Parses `.serverless/serverless-state.json` — the resolved service definition the
// Serverless Framework writes next to the CloudFormation template on `sls package`.
// It is the declarative source for HTTP routes and authorizers (the CFN template
// only carries them as an ApiGateway resource graph, which is much harder to walk),
// keeping LSS's "sls artifacts as the source of truth, no custom manifest" principle.

export interface RegisteredFunction {
  // Short name — the key under `functions:` in serverless.yml.
  name: string;
  // Fully qualified name (`{service}-{stage}-{fn}`) — what AWS SDKs and the
  // LocalStack proxies use.
  fullName: string;
  handler: string;
  runtime: string;
  memorySize: number;
  timeout: number;
  environment: Record<string, string>;
  // Event types feeding this function (http, httpApi, sqs, stream, s3, schedule, sns).
  triggers: string[];
  // Path to the packaged artifact zip, relative to the service root (when known).
  artifact?: string;
}

export interface HttpRoute {
  functionName: string;
  // Uppercase method, or 'ANY'.
  method: string;
  // Normalized with a leading slash. `$default` (httpApi catch-all) is kept verbatim.
  path: string;
  // 'http' → REST API (payload v1); 'httpApi' → HTTP API (payload v2).
  eventType: 'http' | 'httpApi';
  cors: boolean;
  // Name of an entry in the service's authorizers list.
  authorizerName?: string;
  // Cross-service / raw-CFN target ARN when the route does not resolve to a
  // local short name; resolved to a live function at request time via
  // FunctionRegistry.resolve(). Undefined for state-derived local routes.
  functionArn?: string;
  // HTTP API payload format ('2.0' for raw ::Integration routes). Informational;
  // event building keys off eventType. Undefined for state-derived routes.
  payloadVersion?: '1.0' | '2.0';
  // True when the route came from raw AWS::ApiGatewayV2 resources rather than a
  // functions[].events entry (surfaced by GET /apis).
  raw?: boolean;
  // The granting AWS::Lambda::Permission SourceArn (execute-api ARN), when a
  // matching apigateway.amazonaws.com permission was found.
  sourceArn?: string;
  // REST (`http`) routes only: the event declared `private: true`, so API
  // Gateway demands an API key that belongs to a usage plan covering the
  // stage (checked after the authorizer). Absent for public routes.
  apiKeyRequired?: boolean;
  // Where the REST API reads that key from — `provider.apiGateway.apiKeySourceType`:
  // HEADER (the default, the `x-api-key` request header) or AUTHORIZER (the
  // Lambda authorizer's `usageIdentifierKey`). A property of the whole REST
  // API, carried on each key-protected route so the gateway needs nothing
  // beyond the route. Set only alongside `apiKeyRequired`.
  apiKeySourceType?: ApiKeySourceType;
}

export type ApiKeySourceType = 'HEADER' | 'AUTHORIZER';

export interface AuthorizerConfig {
  name: string;
  type: 'request' | 'token';
  // Which flavor of API the authorizer is attached to.
  eventType: 'http' | 'httpApi';
  payloadVersion: '1.0' | '2.0';
  enableSimpleResponses: boolean;
  // Normalized identity source expressions (e.g. "method.request.header.code",
  // "$request.header.authorization").
  identitySource: string[];
  resultTtlInSeconds: number;
  // Local function (short name) when the authorizer lives in this service.
  functionName?: string;
  // External ARN when it lives in another service.
  arn?: string;
}

export interface ParsedServerlessState {
  serviceName?: string;
  stage: string;
  // provider.region, when the service declares one.
  region?: string;
  // Port hints read straight from the packaged state's `custom.lss` block —
  // what the retired 0.x plugin used to POST alongside the registration.
  apiPort?: number;
  invokePort?: number;
  functions: RegisteredFunction[];
  // Each function's environment BEFORE sanitizing (provider + function level,
  // `$ref` pointers followed), keyed by short name. It may still hold CFN
  // intrinsics; the registrar resolves them to physical values once the
  // resources exist (cfn-physical-values.ts).
  rawEnvironment: Record<string, Record<string, unknown>>;
  routes: HttpRoute[];
  authorizers: AuthorizerConfig[];
  // Non-fatal problems (unsupported authorizer types, unparseable events).
  warnings: string[];
}

// What the CloudFormation side knows that the state cannot: which function a
// template logical id names. Lets an authorizer declared as
// `arn: !GetAtt AuthLambdaFunction.Arn` resolve to the function it points at.
export interface StateParseContext {
  // Same-template AWS::Lambda::Function logical id → its FunctionName.
  lambdaNames?: Map<string, string>;
}

// Where an authorizer's code lives, once its reference is resolved.
// `unresolved` carries a reference that named nothing this service knows.
interface AuthorizerTarget {
  functionName?: string;
  arn?: string;
  unresolved?: unknown;
}

interface StateFunctionDef {
  name?: string;
  handler?: string;
  runtime?: string;
  memorySize?: number;
  timeout?: number;
  environment?: Record<string, unknown>;
  events?: unknown[];
  package?: { artifact?: string };
}

interface ServerlessState {
  service?: {
    service?: string;
    custom?: {
      lss?: { apiPort?: unknown; invokePort?: unknown };
    };
    provider?: {
      stage?: string;
      region?: string;
      stackName?: string;
      runtime?: string;
      memorySize?: number;
      timeout?: number;
      environment?: Record<string, unknown>;
      httpApi?: {
        cors?: unknown;
        authorizers?: Record<string, Record<string, unknown>>;
      };
      apiGateway?: {
        apiKeySourceType?: unknown;
      };
    };
    functions?: Record<string, StateFunctionDef>;
  };
  package?: { artifact?: string; individually?: boolean; artifactDirectoryName?: string };
}

const DEFAULT_TIMEOUT_SECONDS = 6;
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_AUTHORIZER_TTL = 300;

// Env values may still carry CloudFormation intrinsics ({Ref}, {Fn::GetAtt}) or
// numbers. Coerce everything to strings; intrinsic objects fall back to the
// referenced logical id so the value is at least recognizable.
export function sanitizeEnvironmentValues(env: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      result[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    } else if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.Ref === 'string') result[key] = obj.Ref;
      else if (Array.isArray(obj['Fn::GetAtt'])) result[key] = (obj['Fn::GetAtt'] as string[]).join('.');
      else result[key] = JSON.stringify(value);
    }
  }
  return result;
}

// The framework's logical id for a function: `getLambdaLogicalId` normalizes
// `-` → Dash and `_` → Underscore, upper-cases the first letter and appends
// "LambdaFunction" (`create-order` → `CreateDashorderLambdaFunction`).
export function lambdaLogicalIdFor(shortName: string): string {
  const normalized = shortName.replace(/-/g, 'Dash').replace(/_/g, 'Underscore');
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}LambdaFunction`;
}

// serverless-state.json is written with a cycle-safe serializer: an object
// reachable twice is emitted once and every other occurrence becomes
// `{"$ref": "$[\"service\"][\"provider\"]…"}`. A reader that does not follow
// those pointers sees an authorizer, an event or an env value that is just
// `{$ref}`. Follows a chain of pointers (bounded — a malformed file must not
// loop) and returns the value it lands on; anything that is not a pointer is
// returned untouched.
export function derefStatePointer(value: unknown, root: unknown): unknown {
  let current = value;
  for (let hops = 0; hops < 16 && isStatePointer(current); hops++) {
    const target = followPointer((current as { $ref: string }).$ref, root);
    if (target === undefined) return current;
    current = target;
  }
  return current;
}

// `{"$ref": "$…"}` and nothing else. One left after derefStatePointer is a
// dangling pointer, which readers skip rather than mistake for data.
export function isStatePointer(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pointer = (value as Record<string, unknown>).$ref;
  return typeof pointer === 'string' && pointer.startsWith('$') && Object.keys(value).length === 1;
}

// `$["a"]["b"][0]` (and the dotted `$.a.b`) → the value at that path, or
// undefined when any step is missing.
function followPointer(pointer: string, root: unknown): unknown {
  const steps = /\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\.([A-Za-z_$][\w$]*)/gy;
  steps.lastIndex = 1;
  let node: unknown = root;
  while (steps.lastIndex < pointer.length) {
    const match = steps.exec(pointer);
    if (!match || !node || typeof node !== 'object') return undefined;
    const key = match[1] !== undefined
      ? Number(match[1])
      : match[2] !== undefined ? (JSON.parse(`"${match[2]}"`) as string) : match[3];
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

// The bits of the packaged state the registrar needs BEFORE parsing anything:
// the stack's name, stage and region feed the CloudFormation pseudo parameters.
export function readStateIdentity(state: ServerlessState | null): {
  serviceName?: string;
  stage: string;
  region?: string;
  stackName?: string;
} {
  const provider = state?.service?.provider || {};
  const stage = provider.stage || 'dev';
  const serviceName = state?.service?.service;
  const region = typeof provider.region === 'string' && provider.region ? provider.region : undefined;
  const stackName = typeof provider.stackName === 'string' && provider.stackName
    ? provider.stackName
    : serviceName ? `${serviceName}-${stage}` : undefined;
  return { serviceName, stage, region, stackName };
}

// The stage a packaging command asks for: `--stage X`, `--stage=X`, `-s X`.
export function stageFromPackageArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const inline = /^--stage=(.+)$/.exec(arg);
    if (inline) return inline[1];
    if ((arg === '--stage' || arg === '-s') && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
  }
  return undefined;
}

/**
 * A `.serverless/` directory is whatever the LAST package run left there, for
 * whichever stage it was run with. Registering it silently meant a service
 * packaged for `prod` came up locally with prod table names and ARNs and no
 * hint as to why nothing matched. Returns one warning per expectation the
 * packaged stage contradicts.
 */
export function stageMismatchWarnings(
  packagedStage: string,
  expectations: Array<{ stage?: string; source: string }>,
): string[] {
  return expectations
    .filter(e => e.stage && e.stage !== packagedStage)
    .map(e =>
      `The packaged artifacts are for stage "${packagedStage}", but ${e.source} says "${e.stage}" — ` +
      'resource and function names follow the packaged stage. Re-package for the stage you mean (lss register --repackage).',
    );
}

// A usable port or nothing — the state file is user-authored, so a string "3010"
// is accepted but garbage never propagates into a listen() call.
function asPort(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

export class ServerlessStateParser {
  // Per-parse state: the document `$ref` pointers resolve against, and the
  // function names an authorizer reference may resolve to.
  private root: unknown = {};
  private shortNames: string[] = [];
  private lambdaNames = new Map<string, string>();
  private fullNames = new Map<string, string>();

  parse(state: ServerlessState, context: StateParseContext = {}): ParsedServerlessState {
    const warnings: string[] = [];
    this.root = state;
    const provider = (this.deref(state.service?.provider) || {}) as NonNullable<NonNullable<ServerlessState['service']>['provider']>;
    const { stage, serviceName } = readStateIdentity(state);
    const httpApi = this.deref(provider.httpApi) as NonNullable<typeof provider.httpApi> | undefined;
    const httpApiCors = Boolean(httpApi?.cors);
    const apiKeySourceType = this.parseApiKeySourceType(provider.apiGateway, warnings);

    const lss = state.service?.custom?.lss || {};
    const apiPort = asPort(lss.apiPort);
    const invokePort = asPort(lss.invokePort);

    const fnDefs = (this.deref(state.service?.functions) || {}) as Record<string, StateFunctionDef>;
    this.shortNames = Object.keys(fnDefs);
    this.lambdaNames = context.lambdaNames ?? new Map();
    this.fullNames = new Map();
    for (const [shortName, rawDef] of Object.entries(fnDefs)) {
      const def = (this.deref(rawDef) || {}) as StateFunctionDef;
      this.fullNames.set(def.name || `${serviceName || 'unknown'}-${stage}-${shortName}`, shortName);
    }

    const authorizers = this.parseHttpApiAuthorizers(
      (this.deref(httpApi?.authorizers) || {}) as Record<string, Record<string, unknown>>,
      warnings,
    );
    const functions: RegisteredFunction[] = [];
    const rawEnvironment: Record<string, Record<string, unknown>> = {};
    const routes: HttpRoute[] = [];

    for (const [shortName, rawDef] of Object.entries(fnDefs)) {
      const def = (this.deref(rawDef) || {}) as StateFunctionDef;
      const rawEvents = this.deref(def.events);
      const events = Array.isArray(rawEvents) ? rawEvents : [];
      const triggers = new Set<string>();

      for (const rawEvent of events) {
        const event = this.deref(rawEvent) as Record<string, unknown> | null;
        if (!event || typeof event !== 'object' || isStatePointer(event)) continue;
        const [eventType] = Object.keys(event);
        if (!eventType) continue;
        triggers.add(this.normalizeTriggerName(eventType));

        if (eventType === 'http' || eventType === 'httpApi') {
          const route = this.parseHttpEvent(
            shortName,
            eventType,
            this.deref(event[eventType]),
            authorizers,
            httpApiCors,
            warnings,
          );
          if (route) {
            if (route.apiKeyRequired) route.apiKeySourceType = apiKeySourceType;
            routes.push(route);
          }
        }
      }

      const env: Record<string, unknown> = {};
      for (const scope of [provider.environment, def.environment]) {
        const vars = this.deref(scope);
        if (!vars || typeof vars !== 'object' || isStatePointer(vars)) continue;
        for (const [key, value] of Object.entries(vars as Record<string, unknown>)) env[key] = this.deref(value);
      }
      rawEnvironment[shortName] = env;

      functions.push({
        name: shortName,
        fullName: def.name || `${serviceName || 'unknown'}-${stage}-${shortName}`,
        handler: def.handler || '',
        runtime: def.runtime || provider.runtime || 'nodejs20.x',
        memorySize: def.memorySize ?? provider.memorySize ?? DEFAULT_MEMORY_MB,
        timeout: def.timeout ?? provider.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        environment: sanitizeEnvironmentValues(env),
        triggers: [...triggers],
        artifact: def.package?.artifact || state.package?.artifact,
      });
    }

    this.checkAuthorizerTargets(authorizers, warnings);

    return {
      serviceName,
      stage,
      region: readStateIdentity(state).region,
      apiPort,
      invokePort,
      functions,
      rawEnvironment,
      routes,
      authorizers,
      warnings,
    };
  }

  private deref(value: unknown): unknown {
    return derefStatePointer(value, this.root);
  }

  // An authorizer pointing at a function this service does not declare is a
  // route that will answer 500 on every request — say so now, at registration,
  // rather than at the first call. Cross-service ARNs are not checked: their
  // owner may simply register later.
  private checkAuthorizerTargets(authorizers: AuthorizerConfig[], warnings: string[]): void {
    for (const auth of authorizers) {
      if (auth.functionName && !this.shortNames.includes(auth.functionName)) {
        warnings.push(`Authorizer "${auth.name}" targets function "${auth.functionName}", which this service does not declare — routes using it will answer 500.`);
      } else if (!auth.functionName && !auth.arn) {
        warnings.push(`Authorizer "${auth.name}" has no function to invoke (neither a function name nor a resolvable ARN) — routes using it will answer 500.`);
      }
    }
  }

  /**
   * An authorizer's function reference → the function to invoke. A string is
   * an ARN (or a name) handed through as-is. A CFN reference to a Lambda in
   * the same template — `!GetAtt AuthLambdaFunction.Arn`, `!Ref …`, or a lone
   * `!Sub '${AuthLambdaFunction.Arn}'` — is resolved to the LOCAL function it
   * names, via the template's FunctionName or, failing that, the framework's
   * logical-id convention. Used to be dropped, which left the authorizer keyed
   * by its display name and every route behind it answering 500.
   */
  private resolveAuthorizerTarget(raw: unknown): AuthorizerTarget {
    const value = this.deref(raw);
    if (value === undefined || value === null) return {};
    if (typeof value === 'string') return { arn: value };
    const logicalId = this.lambdaLogicalIdOf(value);
    if (logicalId) {
      const fullName = this.lambdaNames.get(logicalId);
      const shortName = (fullName && this.fullNames.get(fullName))
        ?? this.shortNames.find(name => lambdaLogicalIdFor(name) === logicalId);
      if (shortName) return { functionName: shortName };
      if (fullName) return { arn: fullName };
    }
    return { unresolved: value };
  }

  private warnUnresolvedAuthorizer(label: string, target: AuthorizerTarget, warnings: string[]): void {
    warnings.push(`Authorizer "${label}": function reference ${JSON.stringify(target.unresolved).slice(0, 160)} does not resolve to a Lambda in this service — routes using it will answer 500.`);
  }

  // The logical id inside `{Ref}`, `{Fn::GetAtt: [Id, Arn]}` / `"Id.Arn"`, or
  // a Fn::Sub whose whole template is `${Id}` / `${Id.Arn}`.
  private lambdaLogicalIdOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const obj = value as Record<string, unknown>;
    if (typeof obj.Ref === 'string') return obj.Ref;
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
    if (typeof getAtt === 'string') return getAtt.split('.')[0];
    const sub = obj['Fn::Sub'];
    const template = Array.isArray(sub) ? sub[0] : sub;
    const token = typeof template === 'string' ? /^\$\{([^}.]+)(?:\.Arn)?\}$/.exec(template.trim()) : null;
    return token ? token[1] : undefined;
  }

  private normalizeTriggerName(eventType: string): string {
    if (eventType === 'stream') return 'stream';
    return eventType;
  }

  private parseHttpApiAuthorizers(
    defs: Record<string, Record<string, unknown>>,
    warnings: string[],
  ): AuthorizerConfig[] {
    const authorizers: AuthorizerConfig[] = [];
    for (const [name, rawDef] of Object.entries(defs)) {
      const def = (this.deref(rawDef) || {}) as Record<string, unknown>;
      const type = String(def.type || 'request').toLowerCase();
      if (type === 'jwt') {
        warnings.push(`Authorizer "${name}" is a JWT authorizer — not supported by the LSS gateway yet; routes using it will return 500.`);
        continue;
      }
      if (type !== 'request') {
        warnings.push(`Authorizer "${name}" has unsupported type "${type}"; routes using it will return 500.`);
        continue;
      }
      const functionName = typeof def.functionName === 'string' ? def.functionName : undefined;
      const target = functionName ? {} : this.resolveAuthorizerTarget(def.arn ?? def.functionArn);
      if (target.unresolved !== undefined) this.warnUnresolvedAuthorizer(name, target, warnings);
      authorizers.push({
        name,
        type: 'request',
        eventType: 'httpApi',
        payloadVersion: String(def.payloadVersion || '2.0') as '1.0' | '2.0',
        enableSimpleResponses: Boolean(def.enableSimpleResponses),
        identitySource: this.normalizeIdentitySource(def.identitySource),
        resultTtlInSeconds: this.parseTtl(def.resultTtlInSeconds),
        functionName: functionName ?? target.functionName,
        arn: target.arn,
      });
    }
    return authorizers;
  }

  private parseHttpEvent(
    functionName: string,
    eventType: 'http' | 'httpApi',
    raw: unknown,
    authorizers: AuthorizerConfig[],
    httpApiCors: boolean,
    warnings: string[],
  ): HttpRoute | null {
    let method: string | undefined;
    let path: string | undefined;
    let cors = eventType === 'httpApi' ? httpApiCors : false;
    let authorizerName: string | undefined;
    let apiKeyRequired = false;

    if (typeof raw === 'string') {
      // Shorthand: "GET /users" or "post users" — httpApi also allows "*".
      if (raw.trim() === '*') {
        method = 'ANY';
        path = '$default';
      } else {
        const [m, p] = raw.trim().split(/\s+/);
        method = m;
        path = p;
      }
    } else if (raw && typeof raw === 'object') {
      const event = raw as Record<string, unknown>;
      method = typeof event.method === 'string' ? event.method : undefined;
      path = typeof event.path === 'string' ? event.path : undefined;
      if (!method && !path && typeof event.routeKey === 'string') {
        // httpApi may normalize into routeKey ("GET /users" or "$default").
        if (event.routeKey === '$default') {
          method = 'ANY';
          path = '$default';
        } else {
          const [m, p] = event.routeKey.trim().split(/\s+/);
          method = m;
          path = p;
        }
      }
      if (event.cors !== undefined) cors = Boolean(event.cors);
      // `private: true` is the framework's spelling of a method with
      // ApiKeyRequired. HTTP APIs have no API keys — the framework rejects
      // the flag there, and so does the gateway: only REST routes carry it.
      if (eventType === 'http' && event.private === true) apiKeyRequired = true;

      authorizerName = this.registerEventAuthorizer(functionName, eventType, this.deref(event.authorizer), authorizers, warnings);
    }

    if (!method || !path) {
      warnings.push(`Function "${functionName}": could not parse ${eventType} event (${JSON.stringify(raw).slice(0, 120)}); route skipped.`);
      return null;
    }

    return {
      functionName,
      method: method.toUpperCase() === '*' ? 'ANY' : method.toUpperCase(),
      path: this.normalizePath(path),
      eventType,
      cors,
      authorizerName,
      ...(apiKeyRequired ? { apiKeyRequired } : {}),
    };
  }

  // provider.apiGateway.apiKeySourceType → HEADER (the AWS default when
  // unset) or AUTHORIZER, read case-insensitively as the framework accepts
  // both spellings. Anything else is a typo AWS would reject at deploy time;
  // the gateway falls back to HEADER and says so.
  private parseApiKeySourceType(rawApiGateway: unknown, warnings: string[]): ApiKeySourceType {
    const apiGateway = this.deref(rawApiGateway);
    const raw = apiGateway && typeof apiGateway === 'object'
      ? this.deref((apiGateway as Record<string, unknown>).apiKeySourceType)
      : undefined;
    if (raw === undefined || raw === null) return 'HEADER';
    const value = String(raw).toUpperCase();
    if (value === 'HEADER' || value === 'AUTHORIZER') return value;
    warnings.push(`provider.apiGateway.apiKeySourceType "${String(raw)}" is not HEADER or AUTHORIZER — API keys are read from the x-api-key header.`);
    return 'HEADER';
  }

  // REST (v1) authorizers are declared inline on the event; httpApi (v2) events
  // reference a named entry in provider.httpApi.authorizers. Inline definitions
  // are appended to the shared list so the gateway resolves both the same way.
  private registerEventAuthorizer(
    functionName: string,
    eventType: 'http' | 'httpApi',
    raw: unknown,
    authorizers: AuthorizerConfig[],
    warnings: string[],
  ): string | undefined {
    if (!raw) return undefined;

    if (eventType === 'httpApi') {
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'object') {
        const ref = raw as Record<string, unknown>;
        if (typeof ref.name === 'string') return ref.name;
      }
      warnings.push(`Function "${functionName}": unsupported httpApi authorizer reference; route will return 500.`);
      return `__unresolved__:${functionName}`;
    }

    // REST event authorizer: string shorthand → local function reference, or
    // the ARN of a function elsewhere (the framework accepts both spellings).
    if (typeof raw === 'string') {
      const name = `${functionName}:${raw}`;
      const isArn = raw.startsWith('arn:');
      authorizers.push({
        name,
        type: 'token',
        eventType: 'http',
        payloadVersion: '1.0',
        enableSimpleResponses: false,
        identitySource: ['method.request.header.Authorization'],
        resultTtlInSeconds: DEFAULT_AUTHORIZER_TTL,
        functionName: isArn ? undefined : raw,
        arn: isArn ? raw : undefined,
      });
      return name;
    }

    if (typeof raw === 'object') {
      const def = raw as Record<string, unknown>;
      const displayName = typeof def.name === 'string' ? def.name : `${functionName}-authorizer`;
      // `arn` wins when present; `name` alone names a local function. An `arn`
      // that does not resolve still falls back to `name` when that IS one of
      // this service's functions — the common `{ name: auth, arn: !GetAtt … }`.
      const target = def.arn !== undefined ? this.resolveAuthorizerTarget(def.arn) : {};
      const arn = target.arn;
      const nameIsFallback = typeof def.name === 'string' && !arn
        && (def.arn === undefined || this.shortNames.includes(def.name));
      const localFn = target.functionName ?? (nameIsFallback ? def.name as string : undefined);
      if (target.unresolved !== undefined && !localFn) this.warnUnresolvedAuthorizer(displayName, target, warnings);
      const type = String(def.type || 'token').toLowerCase();
      if (type !== 'token' && type !== 'request') {
        warnings.push(`Function "${functionName}": authorizer "${displayName}" has unsupported type "${type}"; route will return 500.`);
        return `__unresolved__:${displayName}`;
      }
      const name = `${functionName}:${displayName}`;
      authorizers.push({
        name,
        type: type as 'request' | 'token',
        eventType: 'http',
        payloadVersion: '1.0',
        enableSimpleResponses: false,
        identitySource: this.normalizeIdentitySource(def.identitySource ?? 'method.request.header.Authorization'),
        resultTtlInSeconds: this.parseTtl(def.resultTtlInSeconds),
        functionName: localFn,
        arn,
      });
      return name;
    }

    return undefined;
  }

  private normalizeIdentitySource(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }

  private parseTtl(raw: unknown): number {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return DEFAULT_AUTHORIZER_TTL;
  }

  private normalizePath(path: string): string {
    if (path === '$default') return path;
    const trimmed = path.trim().replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '/') return '/';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}
