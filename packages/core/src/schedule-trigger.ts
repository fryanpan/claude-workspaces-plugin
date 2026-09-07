/**
 * The ON-CHANGE rule — a schedule owed a run when a doc or task changes,
 * rather than at an instant (docs/architecture/scheduled-tasks.md, "A rule
 * can watch a doc or a task"). Asked for by Personal CRM, whose event-driven
 * work otherwise needs a session sitting awake to notice.
 *
 * It is a RULE, not a listener. The scheduler's loop already asks every rule
 * "what are you owed, and is it due?", so an on-change rule answers with the
 * watched thing's last change plus a quiet window: `changedAt + debounceMs`.
 * Every edit inside the window moves the answer later, which is what "once
 * per change, debounced" means for a doc somebody is typing in — one run
 * after they stop, never one per keystroke. The runner supplies `changedAt`
 * on the cursor the way it supplies a completion for an after-completion
 * rule; this module never reads a doc.
 *
 * Restart-safe for the same reason the rest of the family is: the change
 * time is read off durable state (a task's `updatedAt`, a doc's `.ydoc`
 * mtime), and the cursor remembers the last occurrence acted on, so a change
 * that landed while the box was down is still owed and one already acted on
 * cannot come out due twice.
 */

export const TRIGGER_DEFAULT_DEBOUNCE_MS = 60_000;

export type TriggerSource = { kind: 'doc'; docId: string } | { kind: 'task'; taskId: string };

export interface ScheduleOnChange {
  kind: 'on-change';
  source: TriggerSource;
  /** The quiet window after the last change. Absent → `TRIGGER_DEFAULT_DEBOUNCE_MS`. */
  debounceMs?: number;
}

export function triggerDebounceMs(rule: ScheduleOnChange): number {
  return rule.debounceMs ?? TRIGGER_DEFAULT_DEBOUNCE_MS;
}

/** The watched thing, as the phrase and the chips name it: `doc d-x`, `task t-x`. */
export function triggerSourceWords(source: TriggerSource): string {
  return source.kind === 'doc' ? `doc ${source.docId}` : `task ${source.taskId}`;
}

/**
 * The next occurrence: the change's own quiet window, when that change is
 * newer than the rule's arming and lands past the last occurrence acted on.
 * `after` is the floor `nextOccurrence` uses for every kind — the last
 * occurrence, else the arming.
 */
export function nextChangeOccurrence(
  rule: ScheduleOnChange,
  armedAt: number,
  after: number,
  changedAt: number | undefined,
): number | undefined {
  if (changedAt === undefined || changedAt <= armedAt) return undefined;
  const next = changedAt + triggerDebounceMs(rule);
  return next > after ? next : undefined;
}

/** A doc or task id as the wire carries them: one token, no path characters. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/;

export type OnChangeParse = { ok: true; rule: ScheduleOnChange } | { ok: false; error: string };

/** Read a caller's JSON for this kind (`schedule-parse.ts` dispatches here). */
export function parseOnChangeRule(input: Record<string, unknown> | undefined): OnChangeParse {
  const source = input?.source as Record<string, unknown> | undefined;
  const kind = source?.kind;
  let parsed: TriggerSource | undefined;
  if (kind === 'doc' && typeof source?.docId === 'string' && ID_RE.test(source.docId)) {
    parsed = { kind: 'doc', docId: source.docId };
  } else if (kind === 'task' && typeof source?.taskId === 'string' && ID_RE.test(source.taskId)) {
    parsed = { kind: 'task', taskId: source.taskId };
  }
  if (parsed === undefined) {
    return {
      ok: false,
      error: 'on-change needs source: {kind: "doc", docId} or {kind: "task", taskId}',
    };
  }
  const debounceMs = input?.debounceMs;
  if (debounceMs !== undefined) {
    if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
      return { ok: false, error: 'debounceMs must be a non-negative number of ms' };
    }
    return { ok: true, rule: { kind: 'on-change', source: parsed, debounceMs } };
  }
  return { ok: true, rule: { kind: 'on-change', source: parsed } };
}
