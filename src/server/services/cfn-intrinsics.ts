// Static CloudFormation intrinsic resolution — the pass that runs before the
// parser reads a single resource property.
//
// A packaged template is not plain data: names are routinely written as
// `!Sub '${AWS::StackName}-orders'`, `!Join ['-', [!Ref Stage, 'orders']]`,
// `!If [IsProd, ..., ...]` or `!FindInMap [Env, !Ref Stage, Table]`. Without
// this pass every one of those reached the parser as an OBJECT, the `as string`
// casts let it through, and the provisioner was then asked to create a table
// literally named "[object Object]" (or skipped it). Everything here is pure —
// no I/O, no engine — so it is exhaustively unit-tested on its own.
//
// What is resolved statically (known before anything is provisioned):
//   - Parameters (an explicit override, else the declared Default),
//   - pseudo parameters (AWS::Region, AccountId, StackName, StackId, Partition,
//     URLSuffix, NotificationARNs, NoValue),
//   - Mappings (Fn::FindInMap) and Conditions (Fn::Equals/And/Or/Not/Condition),
//   - the string/list functions Fn::Sub, Fn::Join, Fn::Select, Fn::Split,
//     Fn::If, Fn::GetAZs and Fn::Base64.
//
// What is deliberately LEFT IN PLACE: a Ref / Fn::GetAtt to a RESOURCE. Its
// value (a queue URL, a stream ARN with its creation-time label, a secret ARN
// with its random suffix) is only known once the resource exists, and the
// parser's own readers (extractArn, extractFunctionName, resolveArnLike) key
// off the logical id inside those nodes to wire event sources, notifications
// and routes. A caller that DOES know physical values (the function
// environment pass, after provisioning) supplies `resolveResource` and the same
// walk reduces them too. A function whose arguments are only partly resolvable
// keeps its shape with the resolvable parts substituted — `Fn::Sub` keeps the
// unresolved `${Token}`s, `Fn::Join` keeps the unresolved parts — so a later
// pass (or resolveArnLike) still sees a valid intrinsic.

export const ACCOUNT_ID = '000000000000';
export const PARTITION = 'aws';
export const URL_SUFFIX = 'amazonaws.com';

// `Ref: AWS::NoValue` removes the enclosing property / list element. A unique
// symbol so no template value can ever collide with it.
export const NO_VALUE: unique symbol = Symbol('AWS::NoValue');

export interface IntrinsicContext {
  // Undefined when the caller does not know the deployment region yet —
  // `AWS::Region` (and everything built from it) then stays unresolved for a
  // later pass that does, rather than defaulting to a region nobody chose.
  region?: string;
  accountId: string;
  partition: string;
  // Undefined when the caller cannot name the stack — `${AWS::StackName}` then
  // stays unresolved rather than being invented.
  stackName?: string;
  // Resolved parameter values (strings, or string[] for list types). A
  // parameter absent from the map stays an unresolved Ref.
  parameters: Map<string, unknown>;
  mappings: Record<string, unknown>;
  // Condition name → its (unevaluated) expression. Evaluated lazily, memoized.
  conditions: Record<string, unknown>;
  // Physical value of a resource (attribute undefined = `Ref`). Returning
  // undefined keeps the node — the static pass passes no resolver at all.
  resolveResource?: (logicalId: string, attribute?: string) => string | undefined;
  // Cross-stack exports for Fn::ImportValue; absent → the node is kept.
  exports?: Map<string, string>;
  warn: (message: string) => void;
}

export interface TemplateResolveOptions {
  region?: string;
  accountId?: string;
  partition?: string;
  stackName?: string;
  // Parameter values that win over a parameter's Default.
  parameterOverrides?: Record<string, unknown>;
}

export interface TemplateResolution {
  // A copy of the template with Resources/Outputs resolved and every resource
  // or output whose Condition is false removed.
  template: Record<string, unknown>;
  // Resource logical ids dropped because their Condition evaluated to false
  // (a conditioned-out Output is dropped too, but is nothing to report).
  droppedByCondition: string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

// An intrinsic is a single-key object whose key is `Ref` or `Fn::*`.
export function intrinsicName(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const [key] = keys;
  return key === 'Ref' || key.startsWith('Fn::') ? key : undefined;
}

// The pseudo parameters. `undefined` means "not a pseudo parameter" OR "not
// knowable here" (StackName without a stack name) — both leave the token alone.
function pseudoParameter(name: string, ctx: IntrinsicContext): unknown {
  switch (name) {
    case 'AWS::Region': return ctx.region;
    case 'AWS::AccountId': return ctx.accountId;
    case 'AWS::Partition': return ctx.partition;
    case 'AWS::URLSuffix': return URL_SUFFIX;
    case 'AWS::NotificationARNs': return [];
    case 'AWS::NoValue': return NO_VALUE;
    case 'AWS::StackName': return ctx.stackName;
    case 'AWS::StackId':
      // Deterministic stand-in: a real stack id ends in a UUID minted at
      // creation, which has no local meaning — a stable one keeps re-registers
      // idempotent.
      return ctx.stackName && ctx.region
        ? `arn:${ctx.partition}:cloudformation:${ctx.region}:${ctx.accountId}:stack/${ctx.stackName}/00000000-0000-0000-0000-000000000000`
        : undefined;
    default: return undefined;
  }
}

// `Fn::GetAtt` accepts `[LogicalId, Attr]` or the dotted `"LogicalId.Attr"`
// (the attribute itself may contain dots: `Endpoint.Address`).
function splitGetAtt(raw: unknown): [string, string] | undefined {
  if (Array.isArray(raw) && typeof raw[0] === 'string' && typeof raw[1] === 'string') {
    return [raw[0], raw[1]];
  }
  if (typeof raw === 'string') {
    const dot = raw.indexOf('.');
    if (dot > 0) return [raw.slice(0, dot), raw.slice(dot + 1)];
  }
  return undefined;
}

export class IntrinsicResolver {
  private conditionCache = new Map<string, boolean | undefined>();
  private evaluating = new Set<string>();

  constructor(private readonly ctx: IntrinsicContext) {}

  // Resolve any template value. Returns a concrete value, NO_VALUE, or the
  // (partially resolved) intrinsic when something inside it is not knowable.
  resolve(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(item => this.resolve(item)).filter(item => item !== NO_VALUE);
    }
    if (!isObject(node)) return node;

    const fn = intrinsicName(node);
    if (fn) return this.resolveIntrinsic(fn, node[fn], node);

    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      const resolved = this.resolve(value);
      if (resolved !== NO_VALUE) out[key] = resolved;
    }
    return out;
  }

  // Condition name → boolean; undefined when it cannot be decided (unknown
  // name, an unresolvable operand, a cycle) — each reported once.
  evaluateCondition(name: string): boolean | undefined {
    if (this.conditionCache.has(name)) return this.conditionCache.get(name);
    let result: boolean | undefined;
    if (!(name in this.ctx.conditions)) {
      this.ctx.warn(`Condition "${name}" is not declared in the template's Conditions — treating it as undecidable.`);
    } else if (this.evaluating.has(name)) {
      this.ctx.warn(`Condition "${name}" references itself — treating it as undecidable.`);
      return undefined;
    } else {
      this.evaluating.add(name);
      result = this.evaluateExpression(this.ctx.conditions[name]);
      this.evaluating.delete(name);
      if (result === undefined) {
        this.ctx.warn(`Condition "${name}" could not be evaluated statically (an operand is not a known value).`);
      }
    }
    this.conditionCache.set(name, result);
    return result;
  }

  private evaluateExpression(expr: unknown): boolean | undefined {
    if (!isObject(expr)) return undefined;
    if ('Condition' in expr && Object.keys(expr).length === 1) {
      return typeof expr.Condition === 'string' ? this.evaluateCondition(expr.Condition) : undefined;
    }
    const fn = intrinsicName(expr);
    const args = fn ? expr[fn] : undefined;
    switch (fn) {
      case 'Fn::Equals': {
        if (!Array.isArray(args) || args.length !== 2) return undefined;
        const [a, b] = args.map(arg => this.resolve(arg));
        // CFN compares string forms: `!Equals [!Ref Count, 3]` is legal.
        return isScalar(a) && isScalar(b) ? String(a) === String(b) : undefined;
      }
      case 'Fn::Not': {
        const inner = Array.isArray(args) ? this.evaluateExpression(args[0]) : undefined;
        return inner === undefined ? undefined : !inner;
      }
      case 'Fn::And':
      case 'Fn::Or': {
        if (!Array.isArray(args)) return undefined;
        const values = args.map(arg => this.evaluateExpression(arg));
        if (values.some(v => v === undefined)) return undefined;
        return fn === 'Fn::And' ? values.every(Boolean) : values.some(Boolean);
      }
      default:
        return undefined;
    }
  }

  private resolveIntrinsic(fn: string, args: unknown, node: Json): unknown {
    switch (fn) {
      case 'Ref': return this.resolveRef(args, node);
      case 'Fn::GetAtt': return this.resolveGetAtt(args, node);
      case 'Fn::Sub': return this.resolveSub(args, node);
      case 'Fn::Join': return this.resolveJoin(args, node);
      case 'Fn::Select': return this.resolveSelect(args, node);
      case 'Fn::Split': return this.resolveSplit(args, node);
      case 'Fn::If': return this.resolveIf(args, node);
      case 'Fn::FindInMap': return this.resolveFindInMap(args, node);
      case 'Fn::GetAZs': return this.resolveGetAZs(args, node);
      case 'Fn::Base64': {
        const value = this.resolve(args);
        return typeof value === 'string' ? Buffer.from(value, 'utf-8').toString('base64') : { [fn]: value };
      }
      case 'Fn::ImportValue': {
        const name = this.resolve(args);
        const exported = typeof name === 'string' ? this.ctx.exports?.get(name) : undefined;
        return exported ?? { [fn]: name };
      }
      default:
        // Fn::Cidr, Fn::Transform, language extensions…: not evaluated, but
        // their arguments still get the static substitutions.
        return { [fn]: this.resolve(args) };
    }
  }

  private resolveRef(args: unknown, node: Json): unknown {
    if (typeof args !== 'string') return node;
    const pseudo = pseudoParameter(args, this.ctx);
    if (pseudo !== undefined) return pseudo;
    if (this.ctx.parameters.has(args)) return this.ctx.parameters.get(args);
    return this.ctx.resolveResource?.(args) ?? node;
  }

  private resolveGetAtt(args: unknown, node: Json): unknown {
    // The attribute name may itself be a `Ref` to a parameter.
    const resolvedArgs = Array.isArray(args) ? this.resolve(args) : args;
    const parts = splitGetAtt(resolvedArgs);
    if (!parts) return node;
    return this.ctx.resolveResource?.(parts[0], parts[1]) ?? { 'Fn::GetAtt': resolvedArgs };
  }

  // Fn::Sub — string form or [template, { Var: value }]. Resolvable tokens are
  // substituted; the rest stay as `${Token}` in a still-valid Fn::Sub.
  private resolveSub(args: unknown, node: Json): unknown {
    let template: unknown = args;
    const rawVars: Json = {};
    if (Array.isArray(args)) {
      template = args[0];
      if (isObject(args[1])) Object.assign(rawVars, args[1]);
    }
    if (typeof template !== 'string') return node;

    const vars: Json = {};
    for (const [key, value] of Object.entries(rawVars)) vars[key] = this.resolve(value);

    let unresolved = false;
    const substituted = template.replace(/\$\{([^}]*)\}/g, (match, token: string) => {
      // `${!Literal}` is the escape for a literal `${Literal}`; kept escaped
      // until the whole string is known.
      if (token.startsWith('!')) return match;
      const key = token.trim();
      const value = this.subToken(key, vars);
      if (isScalar(value)) return String(value).replace(/\$\{/g, '${!');
      unresolved = true;
      return match;
    });

    if (!unresolved) return substituted.replace(/\$\{!/g, '${');
    const remaining: Json = {};
    for (const [key, value] of Object.entries(vars)) {
      if (!isScalar(value)) remaining[key] = value;
    }
    return { 'Fn::Sub': Object.keys(remaining).length > 0 ? [substituted, remaining] : substituted };
  }

  private subToken(key: string, vars: Json): unknown {
    if (key in vars) return vars[key];
    const pseudo = pseudoParameter(key, this.ctx);
    if (pseudo !== undefined) return pseudo;
    if (this.ctx.parameters.has(key)) return this.ctx.parameters.get(key);
    const dot = key.indexOf('.');
    return dot > 0
      ? this.ctx.resolveResource?.(key.slice(0, dot), key.slice(dot + 1))
      : this.ctx.resolveResource?.(key);
  }

  private resolveJoin(args: unknown, node: Json): unknown {
    if (!Array.isArray(args) || typeof args[0] !== 'string') return node;
    const list = this.resolve(args[1]);
    if (Array.isArray(list) && list.every(isScalar)) return list.map(String).join(args[0]);
    return { 'Fn::Join': [args[0], list] };
  }

  private resolveSelect(args: unknown, node: Json): unknown {
    if (!Array.isArray(args)) return node;
    const index = this.resolve(args[0]);
    const list = this.resolve(args[1]);
    const i = Number(index);
    if (isScalar(index) && Number.isInteger(i) && Array.isArray(list)) {
      if (i >= 0 && i < list.length) return list[i];
      this.ctx.warn(`Fn::Select index ${i} is out of range for a list of ${list.length} element(s).`);
    }
    return { 'Fn::Select': [index, list] };
  }

  private resolveSplit(args: unknown, node: Json): unknown {
    if (!Array.isArray(args) || typeof args[0] !== 'string') return node;
    const source = this.resolve(args[1]);
    return typeof source === 'string' ? source.split(args[0]) : { 'Fn::Split': [args[0], source] };
  }

  private resolveIf(args: unknown, node: Json): unknown {
    if (!Array.isArray(args) || typeof args[0] !== 'string') return node;
    const verdict = this.evaluateCondition(args[0]);
    if (verdict === undefined) return { 'Fn::If': [args[0], this.resolve(args[1]), this.resolve(args[2])] };
    return this.resolve(verdict ? args[1] : args[2]);
  }

  private resolveFindInMap(args: unknown, node: Json): unknown {
    if (!Array.isArray(args) || args.length < 3) return node;
    const [map, top, second] = args.slice(0, 3).map(arg => this.resolve(arg));
    if (!isScalar(map) || !isScalar(top) || !isScalar(second)) return { 'Fn::FindInMap': [map, top, second] };
    const level1 = this.ctx.mappings[String(map)];
    const level2 = isObject(level1) ? level1[String(top)] : undefined;
    const value = isObject(level2) ? level2[String(second)] : undefined;
    if (value === undefined) {
      this.ctx.warn(`Fn::FindInMap [${map}, ${top}, ${second}] matches nothing in the template's Mappings.`);
      return { 'Fn::FindInMap': [map, top, second] };
    }
    return this.resolve(value);
  }

  // Local stand-in: three zones of the requested (or current) region. Only the
  // count and the names' shape matter to a template that indexes into it.
  private resolveGetAZs(args: unknown, node: Json): unknown {
    const region = this.resolve(args);
    const name = region || this.ctx.region;
    if (typeof name !== 'string') return node;
    return ['a', 'b', 'c'].map(zone => `${name}${zone}`);
  }
}

// Resolve every parameter to its effective value: an override wins, then the
// Default. List types become string[] (what `Ref` yields for them in AWS).
// SSM-typed parameters are NOT resolved from their Default — that is the
// parameter-store PATH, not the value, and substituting it would give a table
// a name like "/acme/orders/table".
function resolveParameters(
  declared: Json,
  overrides: Record<string, unknown>,
  warn: (message: string) => void,
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [name, rawDef] of Object.entries(declared)) {
    const def = isObject(rawDef) ? rawDef : {};
    const type = typeof def.Type === 'string' ? def.Type : 'String';
    let value: unknown;
    if (name in overrides) {
      value = overrides[name];
    } else if (type.startsWith('AWS::SSM::Parameter::Value')) {
      warn(`Parameter "${name}" is an SSM parameter (${type}) — its value lives in the parameter store, not the template; Refs to it stay unresolved.`);
      continue;
    } else if ('Default' in def) {
      value = def.Default;
    } else {
      warn(`Parameter "${name}" has no Default and no override — Refs to it stay unresolved.`);
      continue;
    }
    const isList = type === 'CommaDelimitedList' || type.startsWith('List<');
    values.set(name, isList && typeof value === 'string' ? value.split(',') : value);
  }
  return values;
}

/**
 * The resolution context a template defines: its Parameters (with overrides),
 * Mappings and Conditions plus the deployment's pseudo parameters. Each
 * distinct finding is pushed to `warnings` once.
 */
export function createIntrinsicContext(
  template: Record<string, unknown>,
  options: TemplateResolveOptions,
  warnings?: string[],
): IntrinsicContext {
  const warn = (message: string): void => {
    if (warnings && !warnings.includes(message)) warnings.push(message);
  };
  return {
    region: options.region,
    accountId: options.accountId ?? ACCOUNT_ID,
    partition: options.partition ?? PARTITION,
    stackName: options.stackName,
    parameters: resolveParameters(
      isObject(template.Parameters) ? template.Parameters : {},
      options.parameterOverrides ?? {},
      warn,
    ),
    mappings: isObject(template.Mappings) ? template.Mappings : {},
    conditions: isObject(template.Conditions) ? template.Conditions : {},
    warn,
  };
}

/**
 * The static pass over a whole template: Resources and Outputs come back with
 * every statically knowable intrinsic resolved, and the entries whose
 * `Condition` is false are removed (AWS never creates them). An undecidable
 * condition keeps its resource — dropping something the template may well
 * create is the worse failure.
 */
export function resolveTemplate(
  template: Record<string, unknown>,
  options: TemplateResolveOptions,
  warnings?: string[],
): TemplateResolution {
  const resolver = new IntrinsicResolver(createIntrinsicContext(template, options, warnings));
  const droppedByCondition: string[] = [];

  const resolveSection = (section: unknown, dropped?: string[]): Json | undefined => {
    if (!isObject(section)) return undefined;
    const out: Json = {};
    for (const [logicalId, entry] of Object.entries(section)) {
      if (isObject(entry) && typeof entry.Condition === 'string' && resolver.evaluateCondition(entry.Condition) === false) {
        dropped?.push(logicalId);
        continue;
      }
      out[logicalId] = resolver.resolve(entry);
    }
    return out;
  };

  const resolved: Json = { ...template };
  const resources = resolveSection(template.Resources, droppedByCondition);
  if (resources) resolved.Resources = resources;
  const outputs = resolveSection(template.Outputs);
  if (outputs) resolved.Outputs = outputs;
  return { template: resolved, droppedByCondition };
}
