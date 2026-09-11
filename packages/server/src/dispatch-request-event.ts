/**
 * The moment a lead decides to run a task, written down.
 *
 * The board already records two of the three timestamps a ticket's front half
 * is made of: `task.transitioned → in-progress` says the lead picked the row
 * up, and the builder's first `task.noted` says a lane started breathing. The
 * 2026-09-10 phase split measured the gap between them at 18.4 minutes in week
 * one and 79.8 in week three — 85% of a ticket's elapsed clock — and could
 * attribute none of it, because three different waits look identical from
 * outside: the lead planning, a human gate on the ticket body, and a builder
 * queueing behind the parallelism cap.
 *
 * `dispatch.requested` is the missing marker in the middle. It is written when
 * `POST /workspaces/<ws>/dispatches` arrives — the lead asking for a lane —
 * whether or not a lane was free, so a request the cap refused is recorded at
 * the moment it was made rather than at the moment it finally succeeded. That
 * splits one opaque interval into two attributable ones:
 *
 *   transitioned → requested   planning, or a gate somebody had to answer
 *   requested → first note     queueing for capacity
 *
 * **Nothing in the dispatch path waits on this, and nothing in it can fail a
 * dispatch.** The emit is handed to the scheduler and returns immediately, so
 * the response is written without the audit append in front of it; the
 * scheduled call is wrapped, so an emit that throws costs a log line and
 * nothing else. Both halves are injected (`sink`, `schedule`) so a test can
 * make either one misbehave without a filesystem.
 */
import type { DispatchRequestedEvent, TaskActor, TaskStoreEvent } from './tasks.ts';

/** How long a lead's stated reason may be before it is cut. Long enough for a
 *  sentence, short enough that a runaway body cannot bloat the audit log. */
export const DISPATCH_REASON_MAX = 500;

/** Just enough of the task store to write one event — narrower than
 *  `TaskStore` so the unit test needs no store at all. */
export interface DispatchEventSink {
  emit(event: TaskStoreEvent): void;
}

/** Defers work past the response. Injected so a test runs it in hand. */
export type DispatchEventScheduler = (run: () => void) => void;

/** What the route knows at the moment the request is answered. */
export interface DispatchRequestInput {
  workspaceId: string;
  taskId: string;
  /**
   * What the request did, the instant it was made.
   *
   * `cap-reached` is the row the whole event exists for: it is the only
   * recorded evidence that a lane was ASKED FOR before it was available, and
   * it is written even though the dispatch did not happen.
   */
  outcome: 'registered' | 'cap-reached' | 'refused';
  /** Why the lead is running this row now, in the lead's own words. */
  reason?: string;
  /** The builder being put on the lane, when the caller named one. */
  agentName?: string;
  /** Who asked. Absent when the request carried no author at all. */
  actor?: { id: string; name: string; kind?: string };
  /** Injected rather than read, so an event's time is the request's time even
   *  though the write happens after the response. */
  ts: number;
}

/** Trim a caller-supplied reason to something an audit log can hold; answers
 *  `undefined` for a value that is not a usable string. */
export function normalizeDispatchReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, DISPATCH_REASON_MAX);
}

/**
 * The event, built from what the route holds.
 *
 * `kind` defaults to `agent` rather than being carried through: every caller
 * of this route is a lead session's MCP child, and the author shape a request
 * carries (`known` / `anon`) says nothing about whether a person typed it.
 * A caller that explicitly says `person` is believed.
 */
export function buildDispatchRequestedEvent(input: DispatchRequestInput): DispatchRequestedEvent {
  const actor: TaskActor | undefined = input.actor
    ? {
        id: input.actor.id,
        name: input.actor.name,
        kind: input.actor.kind === 'person' ? 'person' : 'agent',
      }
    : undefined;
  const reason = normalizeDispatchReason(input.reason);
  return {
    type: 'dispatch.requested',
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    outcome: input.outcome,
    ...(reason !== undefined ? { reason } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(actor ? { actor } : {}),
    ts: input.ts,
  };
}

/**
 * Write the event without the caller waiting for it or hearing about it.
 *
 * Returns nothing on purpose: a caller that could read a verdict would
 * eventually branch on one, and this must stay a measurement nobody's
 * behaviour depends on.
 */
export function recordDispatchRequested(
  sink: DispatchEventSink,
  input: DispatchRequestInput,
  schedule: DispatchEventScheduler = defaultSchedule,
): void {
  let event: DispatchRequestedEvent;
  try {
    event = buildDispatchRequestedEvent(input);
  } catch (err) {
    // Building it is pure, so this is unreachable today — caught anyway
    // because "the telemetry cannot break the dispatch" has to hold for the
    // whole call, not for the half that touches the filesystem.
    console.error('[dispatch] failed to build dispatch.requested:', err);
    return;
  }
  try {
    schedule(() => {
      try {
        sink.emit(event);
      } catch (err) {
        console.error('[dispatch] failed to record dispatch.requested:', err);
      }
    });
  } catch (err) {
    console.error('[dispatch] failed to schedule dispatch.requested:', err);
  }
}

/** Past the response, not merely past the current microtask: a microtask still
 *  runs before the route's promise resolves, which is the blocking call this
 *  event is required not to add. */
const defaultSchedule: DispatchEventScheduler = (run) => {
  setTimeout(run, 0);
};
