/**
 * A caller's JSON into a rule, or why not (`task-schedule.ts` holds the
 * rules; this is the one door they reach disk through). Split out of that
 * module when the on-change kind arrived and the file crossed its line —
 * the arithmetic and the validation were always two subjects.
 */
import { MISSED_RUN_POLICIES, type MissedRunPolicy } from './schedule-missed.ts';
import { type ScheduleOutput, parseScheduleOutput } from './schedule-output.ts';
import { isKnownTimezone } from './schedule-timezone.ts';
import { parseOnChangeRule } from './schedule-trigger.ts';
import {
  SCHEDULE_RULE_KINDS,
  type ScheduleRule,
  type TimeOfDay,
  type Weekday,
} from './task-schedule.ts';

export type ScheduleParse =
  | {
      ok: true;
      rule: ScheduleRule;
      timezone?: string;
      until?: number;
      onMissed?: MissedRunPolicy;
      /** Absent: the caller said nothing, keep what is stored. `null` clears. */
      output?: ScheduleOutput | null;
    }
  | { ok: false; error: string };

function parseTimes(raw: unknown): TimeOfDay[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: TimeOfDay[] = [];
  for (const entry of raw) {
    const hour = (entry as TimeOfDay | undefined)?.hour;
    const minute = (entry as TimeOfDay | undefined)?.minute;
    if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) return undefined;
    if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) {
      return undefined;
    }
    out.push({ hour: hour as number, minute: minute as number });
  }
  return out;
}

function parseWeekdays(raw: unknown): { ok: true; weekdays?: Weekday[] } | { ok: false } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false };
  for (const day of raw) {
    if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) return { ok: false };
  }
  return { ok: true, weekdays: [...new Set(raw as Weekday[])].sort() };
}

/**
 * Read a caller's JSON into a rule, or say why not. The one door: the REST
 * route, and every later door (the MCP verb, the phrase editor's writer), get
 * their validation from here so a rule that reaches disk always computes.
 */
export function parseSchedule(raw: unknown): ScheduleParse {
  const body = raw as
    | { rule?: unknown; timezone?: unknown; until?: unknown; onMissed?: unknown; output?: unknown }
    | null
    | undefined;
  const input = body?.rule as Record<string, unknown> | undefined;
  const kind = input?.kind;
  if (typeof kind !== 'string' || !(SCHEDULE_RULE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `rule.kind must be one of ${SCHEDULE_RULE_KINDS.join(' | ')}` };
  }
  let timezone: string | undefined;
  if (body?.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || !isKnownTimezone(body.timezone)) {
      return { ok: false, error: 'timezone must be a known IANA zone' };
    }
    timezone = body.timezone;
  }
  let until: number | undefined;
  if (body?.until !== undefined) {
    if (typeof body.until !== 'number' || !Number.isFinite(body.until)) {
      return { ok: false, error: 'until must be an epoch-ms number' };
    }
    until = body.until;
  }
  const onMissed = body?.onMissed as MissedRunPolicy | undefined;
  if (onMissed !== undefined && !(MISSED_RUN_POLICIES as readonly unknown[]).includes(onMissed)) {
    return { ok: false, error: `onMissed must be one of ${MISSED_RUN_POLICIES.join(' | ')}` };
  }
  const output = parseScheduleOutput(body?.output);
  if (!output.ok) return output;
  const tail = {
    ...(timezone !== undefined ? { timezone } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(onMissed !== undefined ? { onMissed } : {}),
    ...(output.output !== undefined ? { output: output.output } : {}),
  };
  switch (kind) {
    case 'once': {
      const at = input?.at;
      if (typeof at !== 'number' || !Number.isFinite(at)) {
        return { ok: false, error: 'once needs at (epoch ms)' };
      }
      return { ok: true, rule: { kind: 'once', at }, ...tail };
    }
    case 'every': {
      const everyMs = input?.everyMs;
      if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) {
        return { ok: false, error: 'every needs a positive everyMs' };
      }
      return { ok: true, rule: { kind: 'every', everyMs }, ...tail };
    }
    case 'calendar': {
      const times = parseTimes(input?.times);
      if (!times) return { ok: false, error: 'calendar needs times: [{hour: 0-23, minute: 0-59}]' };
      const weekdays = parseWeekdays(input?.weekdays);
      if (!weekdays.ok) return { ok: false, error: 'weekdays must be a non-empty array of 0-6' };
      return {
        ok: true,
        rule: {
          kind: 'calendar',
          times,
          ...(weekdays.weekdays !== undefined ? { weekdays: weekdays.weekdays } : {}),
        },
        ...tail,
      };
    }
    case 'on-change': {
      const rule = parseOnChangeRule(input);
      return rule.ok ? { ok: true, rule: rule.rule, ...tail } : rule;
    }
    default: {
      const delayMs = input?.delayMs;
      if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) {
        return { ok: false, error: 'after-completion needs a positive delayMs' };
      }
      return { ok: true, rule: { kind: 'after-completion', delayMs }, ...tail };
    }
  }
}
