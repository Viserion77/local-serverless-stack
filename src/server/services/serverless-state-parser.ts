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
}

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
  functions: RegisteredFunction[];
  routes: HttpRoute[];
  authorizers: AuthorizerConfig[];
  // Non-fatal problems (unsupported authorizer types, unparseable events).
  warnings: string[];
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
    provider?: {
      stage?: string;
      runtime?: string;
      memorySize?: number;
      timeout?: number;
      environment?: Record<string, unknown>;
      httpApi?: {
        cors?: unknown;
        authorizers?: Record<string, Record<string, unknown>>;
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

export class ServerlessStateParser {
  parse(state: ServerlessState): ParsedServerlessState {
    const warnings: string[] = [];
    const provider = state.service?.provider || {};
    const stage = provider.stage || 'dev';
    const serviceName = state.service?.service;
    const httpApiCors = Boolean(provider.httpApi?.cors);

    const authorizers = this.parseHttpApiAuthorizers(provider.httpApi?.authorizers || {}, warnings);
    const functions: RegisteredFunction[] = [];
    const routes: HttpRoute[] = [];

    const fnDefs = state.service?.functions || {};
    for (const [shortName, def] of Object.entries(fnDefs)) {
      const events = Array.isArray(def.events) ? def.events : [];
      const triggers = new Set<string>();

      for (const rawEvent of events) {
        if (!rawEvent || typeof rawEvent !== 'object') continue;
        const event = rawEvent as Record<string, unknown>;
        const [eventType] = Object.keys(event);
        if (!eventType) continue;
        triggers.add(this.normalizeTriggerName(eventType));

        if (eventType === 'http' || eventType === 'httpApi') {
          const route = this.parseHttpEvent(
            shortName,
            eventType,
            event[eventType],
            authorizers,
            httpApiCors,
            warnings,
          );
          if (route) routes.push(route);
        }
      }

      functions.push({
        name: shortName,
        fullName: def.name || `${serviceName || 'unknown'}-${stage}-${shortName}`,
        handler: def.handler || '',
        runtime: def.runtime || provider.runtime || 'nodejs20.x',
        memorySize: def.memorySize ?? provider.memorySize ?? DEFAULT_MEMORY_MB,
        timeout: def.timeout ?? provider.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        environment: sanitizeEnvironmentValues({ ...(provider.environment || {}), ...(def.environment || {}) }),
        triggers: [...triggers],
        artifact: def.package?.artifact || state.package?.artifact,
      });
    }

    return { serviceName, stage, functions, routes, authorizers, warnings };
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
    for (const [name, def] of Object.entries(defs)) {
      const type = String(def.type || 'request').toLowerCase();
      if (type === 'jwt') {
        warnings.push(`Authorizer "${name}" is a JWT authorizer — not supported by the LSS gateway yet; routes using it will return 500.`);
        continue;
      }
      if (type !== 'request') {
        warnings.push(`Authorizer "${name}" has unsupported type "${type}"; routes using it will return 500.`);
        continue;
      }
      authorizers.push({
        name,
        type: 'request',
        eventType: 'httpApi',
        payloadVersion: String(def.payloadVersion || '2.0') as '1.0' | '2.0',
        enableSimpleResponses: Boolean(def.enableSimpleResponses),
        identitySource: this.normalizeIdentitySource(def.identitySource),
        resultTtlInSeconds: this.parseTtl(def.resultTtlInSeconds),
        functionName: typeof def.functionName === 'string' ? def.functionName : undefined,
        arn: this.extractArn(def.arn ?? def.functionArn),
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

      authorizerName = this.registerEventAuthorizer(functionName, eventType, event.authorizer, authorizers, warnings);
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
    };
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

    // REST event authorizer: string shorthand → local function reference.
    if (typeof raw === 'string') {
      const name = `${functionName}:${raw}`;
      authorizers.push({
        name,
        type: 'token',
        eventType: 'http',
        payloadVersion: '1.0',
        enableSimpleResponses: false,
        identitySource: ['method.request.header.Authorization'],
        resultTtlInSeconds: DEFAULT_AUTHORIZER_TTL,
        functionName: raw,
      });
      return name;
    }

    if (typeof raw === 'object') {
      const def = raw as Record<string, unknown>;
      const arn = this.extractArn(def.arn);
      const localFn = typeof def.name === 'string' && !arn ? def.name : undefined;
      const displayName = typeof def.name === 'string' ? def.name : `${functionName}-authorizer`;
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

  private extractArn(raw: unknown): string | undefined {
    if (typeof raw === 'string') return raw;
    // CFN intrinsics (Fn::GetAtt on the authorizer function) mean "local function",
    // which the caller captures via `name`/`functionName` instead.
    return undefined;
  }

  private normalizePath(path: string): string {
    if (path === '$default') return path;
    const trimmed = path.trim().replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '/') return '/';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}
