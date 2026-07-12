// EventBridge emulator (JSON 1.1, X-Amz-Target "AWSEvents.<Operation>").
// Buses and rules are catalog metadata; PutEvents matches ENABLED pattern
// rules and emits 'events:rule-matched' on the engine bus — the dispatcher
// applies Input/InputPath per target and invokes. Delivered events are the
// canonical EventBridge envelope, never wrapped in Records.
//
// Fidelity anchors: resource-provisioner.ts (createEventBus/createEventRule/
// deleteEventRule idempotency error names, hand-built rule ARNs) and the
// self-hosted example (PutEvents per-entry results against a named bus).

import { randomUUID } from 'crypto';
import type {
  AwsRequest,
  EngineContext,
  EngineServiceName,
  EventRuleTarget,
  TargetEmulator,
} from '../../types.js';
import type { CatalogStore } from '../../store/store-types.js';
import { AwsError, notImplemented } from '../../http/errors.js';
import { matches, validatePattern } from './pattern.js';

const DEFAULT_BUS = 'default';

export interface EventBusRecord {
  name: string;
}

export interface EventRuleRecord {
  name: string;
  busName: string;
  eventPattern?: string;
  scheduleExpression?: string;
  state: 'ENABLED' | 'DISABLED';
  targets: EventRuleTarget[];
}

// Scheduler-facing view of the rules that carry a ScheduleExpression.
export interface ScheduleRuleView {
  busName: string;
  ruleName: string;
  scheduleExpression: string;
  state: 'ENABLED' | 'DISABLED';
  targets: EventRuleTarget[];
}

interface PutEventsResultEntry {
  EventId?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

export class EventsEmulator implements TargetEmulator {
  readonly service: EngineServiceName = 'events';
  readonly targetPrefix = 'AWSEvents';
  readonly jsonVersion = '1.1' as const;

  private ctx: EngineContext;
  private readonly rulesChangedListeners: Array<(region: string) => void> = [];

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
  }

  // Fired after every rule mutation (PutRule, DeleteRule, Enable/DisableRule,
  // PutTargets, RemoveTargets and the cascade drop in DeleteEventBus) so the
  // dispatcher's scheduler can resync without polling.
  onRulesChanged(cb: (region: string) => void): void {
    this.rulesChangedListeners.push(cb);
  }

  private fireRulesChanged(region: string): void {
    for (const listener of this.rulesChangedListeners) {
      try {
        listener(region);
      } catch (err) {
        console.warn(`events: onRulesChanged listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async handle(operation: string, input: Record<string, unknown>, req: AwsRequest): Promise<object> {
    const region = req.region;
    switch (operation) {
      case 'CreateEventBus': return this.createEventBus(region, input);
      case 'DeleteEventBus': return this.deleteEventBus(region, input);
      case 'DescribeEventBus': return this.describeEventBus(region, input);
      case 'ListEventBuses': return this.listEventBuses(region, input);
      case 'PutRule': return this.putRule(region, input);
      case 'DeleteRule': return this.deleteRule(region, input);
      case 'EnableRule': return this.setRuleState(region, input, 'ENABLED');
      case 'DisableRule': return this.setRuleState(region, input, 'DISABLED');
      case 'PutTargets': return this.putTargets(region, input);
      case 'RemoveTargets': return this.removeTargets(region, input);
      case 'ListRules': return this.listRules(region, input);
      case 'ListTargetsByRule': return this.listTargetsByRule(region, input);
      case 'PutEvents': return this.putEvents(region, input);
      default: throw notImplemented('events', operation);
    }
  }

  // Rules with a ScheduleExpression, for the dispatcher's scheduler to (re)arm.
  async listScheduleRules(region: string): Promise<ScheduleRuleView[]> {
    const rules = await this.rules(region);
    return rules.values()
      .filter(rule => rule.scheduleExpression !== undefined)
      .map(rule => ({
        busName: rule.busName,
        ruleName: rule.name,
        scheduleExpression: rule.scheduleExpression as string,
        state: rule.state,
        targets: rule.targets,
      }));
  }

  // -------------------------------------------------------------------------
  // Buses
  // -------------------------------------------------------------------------

  private async createEventBus(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    const buses = await this.buses(region);
    if (name === DEFAULT_BUS || buses.get(name)) {
      throw new AwsError('ResourceAlreadyExistsException', `Event bus ${name} already exists.`);
    }
    buses.set(name, { name });
    return { EventBusArn: this.busArn(region, name) };
  }

  private async deleteEventBus(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    if (name === DEFAULT_BUS) {
      throw new AwsError('ValidationException', 'Cannot delete event bus default.');
    }
    const buses = await this.buses(region);
    buses.delete(name);
    // A bus takes its rules with it — orphan rules would silently match nothing.
    const rules = await this.rules(region);
    let droppedRules = false;
    for (const key of rules.keys()) {
      if (rules.get(key)?.busName === name) {
        rules.delete(key);
        droppedRules = true;
      }
    }
    if (droppedRules) this.fireRulesChanged(region);
    return {};
  }

  private async describeEventBus(region: string, input: Record<string, unknown>): Promise<object> {
    const name = this.resolveBusName(input.EventBusName ?? input.Name);
    await this.assertBusExists(region, name);
    return { Name: name, Arn: this.busArn(region, name) };
  }

  private async listEventBuses(region: string, input: Record<string, unknown>): Promise<object> {
    const buses = await this.buses(region);
    const prefix = typeof input.NamePrefix === 'string' ? input.NamePrefix : '';
    const names = [DEFAULT_BUS, ...buses.values().map(bus => bus.name)]
      .filter(name => name.startsWith(prefix))
      .sort();
    return { EventBuses: names.map(name => ({ Name: name, Arn: this.busArn(region, name) })) };
  }

  // -------------------------------------------------------------------------
  // Rules and targets
  // -------------------------------------------------------------------------

  private async putRule(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    const busName = this.resolveBusName(input.EventBusName);
    await this.assertBusExists(region, busName);

    const eventPattern = typeof input.EventPattern === 'string' ? input.EventPattern : undefined;
    const scheduleExpression = typeof input.ScheduleExpression === 'string' ? input.ScheduleExpression : undefined;
    if (!eventPattern && !scheduleExpression) {
      throw new AwsError('ValidationException', 'Parameter(s) EventPattern or ScheduleExpression must be specified.');
    }
    if (eventPattern) this.assertPatternSupported(eventPattern);
    if (scheduleExpression) {
      if (busName !== DEFAULT_BUS) {
        throw new AwsError('ValidationException', 'ScheduleExpression is supported only on the default event bus.');
      }
      if (!/^(rate|cron)\(.+\)$/.test(scheduleExpression)) {
        throw new AwsError('ValidationException', 'Parameter ScheduleExpression is not valid.');
      }
    }

    const rules = await this.rules(region);
    const existing = rules.get(ruleKey(busName, name));
    // Upsert semantics: an omitted State keeps the current state.
    const state = String(input.State ?? existing?.state ?? 'ENABLED');
    if (state !== 'ENABLED' && state !== 'DISABLED') {
      throw new AwsError('ValidationException', `1 validation error detected: Value '${state}' at 'state' failed to satisfy constraint: Member must satisfy enum value set: [ENABLED, DISABLED]`);
    }
    rules.set(ruleKey(busName, name), {
      name,
      busName,
      eventPattern,
      scheduleExpression,
      state,
      targets: existing?.targets ?? [],
    });
    this.fireRulesChanged(region);
    return { RuleArn: this.ruleArn(region, busName, name) };
  }

  private assertPatternSupported(eventPattern: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(eventPattern);
    } catch {
      throw new AwsError('InvalidEventPatternException', 'Event pattern is not valid. Reason: Invalid JSON');
    }
    let unsupported: string[];
    try {
      unsupported = validatePattern(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AwsError('InvalidEventPatternException', `Event pattern is not valid. Reason: ${reason}`);
    }
    if (unsupported.length > 0) {
      throw new AwsError(
        'InvalidEventPatternException',
        `Event pattern is not valid. Reason: operator(s) not supported by the LSS self engine in v1: ${unsupported.join(', ')}`,
      );
    }
  }

  private async deleteRule(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Name');
    const busName = this.resolveBusName(input.EventBusName);
    await this.assertBusExists(region, busName);
    const rules = await this.rules(region);
    const rule = rules.get(ruleKey(busName, name));
    // Deleting an absent rule is a silent success, matching AWS.
    if (!rule) return {};
    if (rule.targets.length > 0 && input.Force !== true) {
      throw new AwsError('ValidationException', "Rule can't be deleted since it has targets.");
    }
    rules.delete(ruleKey(busName, name));
    this.fireRulesChanged(region);
    return {};
  }

  private async setRuleState(region: string, input: Record<string, unknown>, state: 'ENABLED' | 'DISABLED'): Promise<object> {
    const name = requireString(input, 'Name');
    const busName = this.resolveBusName(input.EventBusName);
    const rules = await this.rules(region);
    const rule = rules.get(ruleKey(busName, name));
    if (!rule) throw this.ruleNotFound(name, busName);
    rules.set(ruleKey(busName, name), { ...rule, state });
    this.fireRulesChanged(region);
    return {};
  }

  private async putTargets(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Rule');
    const busName = this.resolveBusName(input.EventBusName);
    const rules = await this.rules(region);
    const rule = rules.get(ruleKey(busName, name));
    if (!rule) throw this.ruleNotFound(name, busName);

    const entries = requireArray(input, 'Targets');
    const targets = [...rule.targets];
    for (const entry of entries) {
      const raw = entry as Record<string, unknown>;
      const target: EventRuleTarget = {
        id: requireString(raw, 'Id'),
        arn: requireString(raw, 'Arn'),
        ...(typeof raw.Input === 'string' ? { input: raw.Input } : {}),
        ...(typeof raw.InputPath === 'string' ? { inputPath: raw.InputPath } : {}),
      };
      const index = targets.findIndex(existing => existing.id === target.id);
      if (index === -1) targets.push(target);
      else targets[index] = target;
    }
    rules.set(ruleKey(busName, name), { ...rule, targets });
    this.fireRulesChanged(region);
    return { FailedEntryCount: 0, FailedEntries: [] };
  }

  private async removeTargets(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Rule');
    const busName = this.resolveBusName(input.EventBusName);
    const rules = await this.rules(region);
    const rule = rules.get(ruleKey(busName, name));
    if (!rule) throw this.ruleNotFound(name, busName);
    const ids = new Set(requireArray(input, 'Ids').map(String));
    rules.set(ruleKey(busName, name), {
      ...rule,
      targets: rule.targets.filter(target => !ids.has(target.id)),
    });
    this.fireRulesChanged(region);
    return { FailedEntryCount: 0, FailedEntries: [] };
  }

  private async listRules(region: string, input: Record<string, unknown>): Promise<object> {
    const busName = this.resolveBusName(input.EventBusName);
    await this.assertBusExists(region, busName);
    const prefix = typeof input.NamePrefix === 'string' ? input.NamePrefix : '';
    const rules = await this.rules(region);
    return {
      Rules: rules.values()
        .filter(rule => rule.busName === busName && rule.name.startsWith(prefix))
        .map(rule => ({
          Name: rule.name,
          Arn: this.ruleArn(region, busName, rule.name),
          EventBusName: busName,
          State: rule.state,
          ...(rule.eventPattern !== undefined ? { EventPattern: rule.eventPattern } : {}),
          ...(rule.scheduleExpression !== undefined ? { ScheduleExpression: rule.scheduleExpression } : {}),
        })),
    };
  }

  private async listTargetsByRule(region: string, input: Record<string, unknown>): Promise<object> {
    const name = requireString(input, 'Rule');
    const busName = this.resolveBusName(input.EventBusName);
    const rules = await this.rules(region);
    const rule = rules.get(ruleKey(busName, name));
    if (!rule) throw this.ruleNotFound(name, busName);
    return {
      Targets: rule.targets.map(target => ({
        Id: target.id,
        Arn: target.arn,
        ...(target.input !== undefined ? { Input: target.input } : {}),
        ...(target.inputPath !== undefined ? { InputPath: target.inputPath } : {}),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // PutEvents
  // -------------------------------------------------------------------------

  private async putEvents(region: string, input: Record<string, unknown>): Promise<object> {
    const entries = requireArray(input, 'Entries');
    const buses = await this.buses(region);
    const rules = await this.rules(region);

    const results: PutEventsResultEntry[] = [];
    for (const raw of entries) {
      results.push(this.putOneEvent(region, buses, rules, raw as Record<string, unknown>));
    }
    return {
      FailedEntryCount: results.filter(entry => entry.ErrorCode !== undefined).length,
      Entries: results,
    };
  }

  // Per-entry semantics: an entry problem (unknown bus, malformed detail) is
  // reported in its result slot, never as a request-level error.
  private putOneEvent(
    region: string,
    buses: CatalogStore<EventBusRecord>,
    rules: CatalogStore<EventRuleRecord>,
    entry: Record<string, unknown>,
  ): PutEventsResultEntry {
    const busName = this.resolveBusName(entry.EventBusName);
    if (busName !== DEFAULT_BUS && !buses.get(busName)) {
      return { ErrorCode: 'ResourceNotFoundException', ErrorMessage: `Event bus ${busName} does not exist.` };
    }
    const source = typeof entry.Source === 'string' ? entry.Source : '';
    const detailType = typeof entry.DetailType === 'string' ? entry.DetailType : '';
    if (source === '') {
      return { ErrorCode: 'InvalidArgument', ErrorMessage: 'Parameter Source is not valid. Reason: Source is a required argument.' };
    }
    if (detailType === '') {
      return { ErrorCode: 'InvalidArgument', ErrorMessage: 'Parameter DetailType is not valid. Reason: DetailType is a required argument.' };
    }

    let detail: unknown;
    try {
      detail = JSON.parse(typeof entry.Detail === 'string' ? entry.Detail : '{}');
    } catch {
      return { ErrorCode: 'MalformedDetail', ErrorMessage: 'Detail is malformed.' };
    }
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
      return { ErrorCode: 'MalformedDetail', ErrorMessage: 'Detail is malformed.' };
    }

    const eventId = randomUUID();
    const envelope: Record<string, unknown> = {
      version: '0',
      id: eventId,
      'detail-type': detailType,
      source,
      account: this.ctx.config.account,
      time: toEventTime(entry.Time),
      region,
      resources: Array.isArray(entry.Resources) ? entry.Resources : [],
      detail,
    };

    for (const rule of rules.values()) {
      if (rule.busName !== busName || rule.state !== 'ENABLED' || rule.eventPattern === undefined) continue;
      if (!matches(JSON.parse(rule.eventPattern), envelope)) continue;
      this.ctx.bus.emit('events:rule-matched', {
        region,
        busName,
        ruleName: rule.name,
        targets: rule.targets,
        event: envelope,
      });
    }
    return { EventId: eventId };
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private async buses(region: string): Promise<CatalogStore<EventBusRecord>> {
    const catalog = this.ctx.store.catalog<EventBusRecord>(`events/${region}/buses`);
    await catalog.load();
    return catalog;
  }

  private async rules(region: string): Promise<CatalogStore<EventRuleRecord>> {
    const catalog = this.ctx.store.catalog<EventRuleRecord>(`events/${region}/rules`);
    await catalog.load();
    return catalog;
  }

  // EventBusName parameters accept a bus name or a full event-bus ARN.
  private resolveBusName(raw: unknown): string {
    if (typeof raw !== 'string' || raw === '') return DEFAULT_BUS;
    if (raw.startsWith('arn:')) return raw.slice(raw.indexOf('/') + 1);
    return raw;
  }

  private async assertBusExists(region: string, busName: string): Promise<void> {
    if (busName === DEFAULT_BUS) return;
    const buses = await this.buses(region);
    if (!buses.get(busName)) {
      throw new AwsError('ResourceNotFoundException', `Event bus ${busName} does not exist.`);
    }
  }

  private ruleNotFound(name: string, busName: string): AwsError {
    const suffix = busName === DEFAULT_BUS ? '' : ` on EventBus ${busName}`;
    return new AwsError('ResourceNotFoundException', `Rule ${name} does not exist${suffix}.`);
  }

  private busArn(region: string, name: string): string {
    return `arn:aws:events:${region}:${this.ctx.config.account}:event-bus/${name}`;
  }

  // Matches the ARN the provisioner hand-builds for AddPermission SourceArn:
  // the default bus omits the bus segment.
  private ruleArn(region: string, busName: string, ruleName: string): string {
    const busSegment = busName === DEFAULT_BUS ? '' : `${busName}/`;
    return `arn:aws:events:${region}:${this.ctx.config.account}:rule/${busSegment}${ruleName}`;
  }
}

function ruleKey(busName: string, ruleName: string): string {
  return `${busName}|${ruleName}`;
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value === '') {
    throw new AwsError('ValidationException', `Parameter ${field} is required.`);
  }
  return value;
}

function requireArray(input: Record<string, unknown>, field: string): unknown[] {
  const value = input[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new AwsError('ValidationException', `Parameter ${field} is required.`);
  }
  return value;
}

// JSON 1.1 timestamps arrive as epoch seconds; ISO strings are accepted from
// hand-built payloads. The envelope uses second-resolution ISO time like AWS.
function toEventTime(raw: unknown): string {
  let date = new Date();
  if (typeof raw === 'number') date = new Date(raw * 1000);
  else if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) date = new Date(raw);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
