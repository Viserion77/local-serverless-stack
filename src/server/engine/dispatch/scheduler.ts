// EventBridge schedule rules (rate + 6-field AWS cron) for the self engine.
// Timer discipline (PRD RF6.3): ONE unref'd setTimeout armed for the earliest
// next-fire across every schedule rule — and zero timers when there are no
// ENABLED schedule rules. resync() re-reads the rules catalog; the events
// emulator's onRulesChanged hook calls it, so there is no polling anywhere.

import { randomUUID } from 'crypto';
import type { EngineContext, EventRuleTarget } from '../types.js';
import type { EventsEmulator } from '../emulators/events/index.js';

// ---------------------------------------------------------------------------
// Target payload resolution (shared with the dispatcher's rule-matched path).
// Lives here because this module has no heavy imports, so tests of either
// consumer can use it without mocking the Lambda runtime modules.
// ---------------------------------------------------------------------------

// EventBridge target semantics: Input (literal JSON) wins over InputPath
// (dot-path subset: '$', '$.detail', '$.detail.x.y'); neither → full envelope.
export function resolveTargetInput(target: EventRuleTarget, envelope: Record<string, unknown>): unknown {
  if (target.input !== undefined) {
    try {
      return JSON.parse(target.input);
    } catch {
      console.warn(`[engine-scheduler] target ${target.id}: Input is not valid JSON, delivering null`);
      return null;
    }
  }
  if (target.inputPath !== undefined) return extractInputPath(envelope, target.inputPath);
  return envelope;
}

function extractInputPath(envelope: Record<string, unknown>, path: string): unknown {
  if (path === '$') return envelope;
  if (!path.startsWith('$.')) return null;
  let current: unknown = envelope;
  for (const segment of path.slice(2).split('.')) {
    if (segment === '' || current === null || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return null;
  }
  return current ?? null;
}

// ---------------------------------------------------------------------------
// Schedule expression parsing
// ---------------------------------------------------------------------------

interface CronField {
  kind: 'any' | 'question' | 'set';
  values?: Set<number>;
}

export type ParsedSchedule =
  | { kind: 'rate'; intervalMs: number }
  | { kind: 'cron'; minute: CronField; hour: CronField; dayOfMonth: CronField; month: CronField; dayOfWeek: CronField; year: CronField };

const RATE_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

// AWS cron day-of-week numbering: 1 = SUN … 7 = SAT.
const DOW_NAMES: Record<string, number> = {
  SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7,
};

// Returns undefined for anything unsupported (bad syntax, L/W/# operators);
// the caller warns and skips the rule.
export function parseScheduleExpression(expression: string): ParsedSchedule | undefined {
  const rate = /^rate\((\d+)\s+(minutes?|hours?|days?)\)$/.exec(expression.trim());
  if (rate) {
    const count = parseInt(rate[1], 10);
    if (count < 1) return undefined;
    // AWS also rejects "rate(1 minutes)" / "rate(5 minute)" plural mismatches.
    const singular = count === 1;
    if (singular !== !rate[2].endsWith('s')) return undefined;
    return { kind: 'rate', intervalMs: count * RATE_UNIT_MS[rate[2]] };
  }

  const cron = /^cron\((.+)\)$/.exec(expression.trim());
  if (!cron) return undefined;
  const fields = cron[1].trim().split(/\s+/);
  if (fields.length !== 6) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek, year] = fields;
  try {
    return {
      kind: 'cron',
      minute: parseCronField(minute, 0, 59),
      hour: parseCronField(hour, 0, 23),
      dayOfMonth: parseCronField(dayOfMonth, 1, 31),
      month: parseCronField(month, 1, 12, MONTH_NAMES),
      dayOfWeek: parseCronField(dayOfWeek, 1, 7, DOW_NAMES),
      year: parseCronField(year, 1970, 2199),
    };
  } catch {
    return undefined;
  }
}

// L/W/# operator forms ("L", "3L", "FRIL", "15W", "6#2") — matched precisely
// so month/day names containing those letters (JUL, WED) stay valid.
const UNSUPPORTED_CRON_OPERATOR = /^(?:\d+|[A-Z]{3})?[LW]$/i;

function parseCronField(raw: string, min: number, max: number, names?: Record<string, number>): CronField {
  if (raw.includes('#')) throw new Error(`unsupported cron operator in "${raw}"`);
  if (raw === '*') return { kind: 'any' };
  if (raw === '?') return { kind: 'question' };

  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (part === '') throw new Error('empty cron list entry');
    if (UNSUPPORTED_CRON_OPERATOR.test(part)) throw new Error(`unsupported cron operator in "${part}"`);
    const step = part.split('/');
    if (step.length > 2) throw new Error(`bad step in "${part}"`);
    const stepBy = step.length === 2 ? parseInt(step[1], 10) : 1;
    if (!Number.isInteger(stepBy) || stepBy < 1) throw new Error(`bad step in "${part}"`);

    let start: number;
    let end: number;
    const base = step[0];
    if (base === '*') {
      start = min;
      end = max;
    } else if (base.includes('-')) {
      const [rawFrom, rawTo] = base.split('-');
      start = parseCronValue(rawFrom, names);
      end = parseCronValue(rawTo, names);
    } else {
      start = parseCronValue(base, names);
      // "a/n" steps from a to the field max; a bare value is just itself.
      end = step.length === 2 ? max : start;
    }
    if (start < min || end > max || start > end) throw new Error(`out of range: "${part}"`);
    for (let value = start; value <= end; value += stepBy) values.add(value);
  }
  return { kind: 'set', values };
}

function parseCronValue(raw: string, names?: Record<string, number>): number {
  if (names) {
    const named = names[raw.toUpperCase()];
    if (named !== undefined) return named;
  }
  const value = parseInt(raw, 10);
  if (!Number.isInteger(value) || String(value) !== raw) throw new Error(`bad cron value "${raw}"`);
  return value;
}

// ---------------------------------------------------------------------------
// Next-fire computation
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const SEARCH_WINDOW_MS = 366 * 24 * 3_600_000;

// Strictly-after-`fromMs` next fire time (epoch ms), or undefined when the
// schedule never fires inside the 366-day search window.
export function nextFireAt(schedule: ParsedSchedule, fromMs: number): number | undefined {
  if (schedule.kind === 'rate') return fromMs + schedule.intervalMs;

  // Simple and correct beats clever: walk minute boundaries in UTC.
  let candidate = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = fromMs + SEARCH_WINDOW_MS;
  while (candidate <= end) {
    if (cronMatches(schedule, candidate)) return candidate;
    candidate += MINUTE_MS;
  }
  return undefined;
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.kind === 'set') return (field.values as Set<number>).has(value);
  return true; // 'any' and 'question' match everything
}

function cronMatches(schedule: Extract<ParsedSchedule, { kind: 'cron' }>, epochMs: number): boolean {
  const date = new Date(epochMs);
  if (!fieldMatches(schedule.minute, date.getUTCMinutes())) return false;
  if (!fieldMatches(schedule.hour, date.getUTCHours())) return false;
  if (!fieldMatches(schedule.month, date.getUTCMonth() + 1)) return false;
  if (!fieldMatches(schedule.year, date.getUTCFullYear())) return false;

  const domMatch = fieldMatches(schedule.dayOfMonth, date.getUTCDate());
  const dowMatch = fieldMatches(schedule.dayOfWeek, date.getUTCDay() + 1);
  // AWS requires one of dom/dow to be '?': that one is ignored. Both
  // unrestricted → any day; both restricted (rejected by AWS at PutRule) → OR,
  // the classic cron semantics.
  if (schedule.dayOfMonth.kind === 'question') return dowMatch;
  if (schedule.dayOfWeek.kind === 'question') return domMatch;
  if (schedule.dayOfMonth.kind === 'any' && schedule.dayOfWeek.kind === 'any') return true;
  if (schedule.dayOfMonth.kind === 'any') return dowMatch;
  if (schedule.dayOfWeek.kind === 'any') return domMatch;
  return domMatch || dowMatch;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface EngineSchedulerDeps {
  ctx: EngineContext;
  events: EventsEmulator;
  // Delivers a resolved event to one rule target, dispatching by ARN service
  // (Lambda invoke vs SQS enqueue) — shared with the dispatcher's rule-matched
  // path so scheduled rules reach SQS targets too.
  deliverToTarget: (target: EventRuleTarget, envelope: Record<string, unknown>, sourceLabel: string) => void;
}

interface ScheduleEntry {
  region: string;
  busName: string;
  ruleName: string;
  targets: EventRuleTarget[];
  schedule: ParsedSchedule;
  nextFireAtMs: number;
}

export class EngineScheduler {
  private readonly deps: EngineSchedulerDeps;
  private entries: ScheduleEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly warnedUnsupported = new Set<string>();
  // Serializes overlapping resyncs (rule churn during a slow catalog load).
  private resyncChain: Promise<void> = Promise.resolve();

  constructor(deps: EngineSchedulerDeps) {
    this.deps = deps;
    deps.events.onRulesChanged(region => {
      void this.resync(region).catch(err => {
        console.warn('[engine-scheduler] resync after rule change failed:', err);
      });
    });
  }

  resync(region: string): Promise<void> {
    this.resyncChain = this.resyncChain.then(() => this.doResync(region));
    return this.resyncChain;
  }

  stop(): void {
    this.stopped = true;
    this.entries = [];
    this.clearTimer();
  }

  // For health/introspection: number of armed schedule rules.
  scheduleCount(): number {
    return this.entries.length;
  }

  private async doResync(region: string): Promise<void> {
    if (this.stopped) return;
    const rules = await this.deps.events.listScheduleRules(region);
    const now = Date.now();
    const fresh: ScheduleEntry[] = [];
    for (const rule of rules) {
      if (rule.state !== 'ENABLED') continue;
      const schedule = parseScheduleExpression(rule.scheduleExpression);
      const key = `${region}|${rule.busName}|${rule.ruleName}`;
      if (!schedule) {
        if (!this.warnedUnsupported.has(key)) {
          this.warnedUnsupported.add(key);
          console.warn(
            `[engine-scheduler] rule ${rule.ruleName}: unsupported schedule expression ` +
              `"${rule.scheduleExpression}" (L/W/# and malformed expressions are not supported) — rule skipped`,
          );
        }
        continue;
      }
      const nextFireAtMs = nextFireAt(schedule, now);
      if (nextFireAtMs === undefined) continue;
      fresh.push({
        region,
        busName: rule.busName,
        ruleName: rule.ruleName,
        targets: rule.targets,
        schedule,
        nextFireAtMs,
      });
    }
    this.entries = [...this.entries.filter(entry => entry.region !== region), ...fresh];
    this.arm();
  }

  private arm(): void {
    this.clearTimer();
    if (this.stopped || this.entries.length === 0) return;
    const earliest = Math.min(...this.entries.map(entry => entry.nextFireAtMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fireDue();
    }, Math.max(0, earliest - Date.now()));
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fireDue(): void {
    const now = Date.now();
    const surviving: ScheduleEntry[] = [];
    for (const entry of this.entries) {
      if (entry.nextFireAtMs <= now) {
        this.deliver(entry);
        const next = nextFireAt(entry.schedule, now);
        if (next === undefined) continue; // never fires again inside the window
        entry.nextFireAtMs = next;
      }
      surviving.push(entry);
    }
    this.entries = surviving;
    this.arm();
  }

  private deliver(entry: ScheduleEntry): void {
    const { account } = this.deps.ctx.config;
    // Matches the ARN shape the events emulator builds (default bus omits the
    // bus segment).
    const busSegment = entry.busName === 'default' ? '' : `${entry.busName}/`;
    const ruleArn = `arn:aws:events:${entry.region}:${account}:rule/${busSegment}${entry.ruleName}`;
    const envelope: Record<string, unknown> = {
      version: '0',
      id: randomUUID(),
      'detail-type': 'Scheduled Event',
      source: 'aws.events',
      account,
      time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      region: entry.region,
      resources: [ruleArn],
      detail: {},
    };
    for (const target of entry.targets) {
      this.deps.deliverToTarget(target, envelope, `schedule ${entry.ruleName}`);
    }
  }
}
