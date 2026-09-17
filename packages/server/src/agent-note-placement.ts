/**
 * Where an agent's end-of-turn notes went on a board, named as the reader's
 * question rather than as the resolver's failure.
 *
 * `resolveNoteTarget` answers with a row, or with `ambiguous: true | false`,
 * and the unplaced-note log stores that flag. "Ambiguous" reads as "was there
 * a problem picking", which sent one diagnosis counting rows for an hour. What
 * a person needs is which of four states a note is in:
 *
 *  - `attached`     — it is on the one task the agent holds, on that task's
 *                     Activity tab. Nothing here changes that path.
 *  - `undecidable`  — the agent holds several tasks, and guessing one was
 *                     measured wrong about three times in four, so no task
 *                     took it.
 *  - `unattachable` — the agent holds no task, so there was nothing to take
 *                     it. This one does not resolve by itself: a board parked
 *                     on its owner's call stays parked for days.
 *  - `withheld`     — the session DECLARED that it does not post its turns
 *                     here (a session whose turns concern private material).
 *                     A declaration is a line the session sends each turn with
 *                     no words in it, so "chose not to post" is something the
 *                     board was told, never something a reader infers from a
 *                     blank tab. Silence still means silence.
 *
 * The first is stored on the task; the other three live in the board's
 * unplaced-note log (`agent-note-log.ts`). `agentNotesByAgent` is the
 * per-agent view of that log that the board's Home reads: no task needed,
 * because two of the three states have no task to hang on.
 */
import type { LoggedAgentNote } from './agent-note-log.ts';
import { AT_FUTURE_MS, AT_PAST_MS, type AgentNoteKind, type NoteTarget } from './agent-notes.ts';
import { normalizeAgent } from './chat-audit.ts';

export type NotePlacement = 'attached' | 'unattachable' | 'undecidable' | 'withheld';
/** The three states a note can be in without a task. */
export type UnplacedPlacement = Exclude<NotePlacement, 'attached'>;

/** How far back the board's per-agent read looks. The Home pane's own
 *  window (`ACTIVITY_WINDOW_MS` in the app), so the two halves of the pane
 *  cover the same stretch of time. */
export const AGENT_NOTES_WINDOW_MS = 3 * 60 * 60_000;
/** How many log lines one board read may hand to the grouping. */
export const AGENT_NOTES_BOARD_CAP = 400;
/** Lines kept per agent; the rest are counted in `more`. */
export const AGENT_NOTES_PER_AGENT = 10;

/** The state a logged line records. */
export function placementOfLogged(
  note: Pick<LoggedAgentNote, 'ambiguous' | 'withheld'>,
): UnplacedPlacement {
  if (note.withheld === true) return 'withheld';
  return note.ambiguous ? 'undecidable' : 'unattachable';
}

/** The state a freshly resolved note is in. */
export function placementOfTarget(target: NoteTarget): Exclude<NotePlacement, 'withheld'> {
  if (target.task) return 'attached';
  return target.ambiguous ? 'undecidable' : 'unattachable';
}

export interface AgentNotesLine {
  at: number;
  kind: AgentNoteKind;
  text: string;
  placement: Exclude<UnplacedPlacement, 'withheld'>;
}

export interface AgentNotesView {
  agent: string;
  /**
   * The state of this agent's NEWEST note on the board — what its latest
   * turn did. `attached` only when a note that landed on a task is newer than
   * every line the log holds; `taskId` then names that task.
   */
  placement: NotePlacement;
  taskId?: string;
  latestAt: number;
  /** Notes no task took, newest first, at most `AGENT_NOTES_PER_AGENT`.
   *  Declarations carry no words and are never a line here. */
  notes: AgentNotesLine[];
  more: number;
}

/** A placed note the process still remembers — the ring's answer. */
export type AttachedLookup = (agent: string) => { at: number; taskId: string } | undefined;

/**
 * Group a board's log lines (any order) by agent, newest agent first.
 *
 * `attachedLatest` lets a newer placed note win the header: an agent that
 * held two tasks an hour ago and holds one now is `attached`, and its old
 * notes still show beneath, because they are still on no task. Without it —
 * a restarted server has no ring — the header is the log's newest line.
 */
export function agentNotesByAgent(
  lines: readonly LoggedAgentNote[],
  attachedLatest: AttachedLookup = () => undefined,
  perAgentCap: number = AGENT_NOTES_PER_AGENT,
): AgentNotesView[] {
  const byAgent = new Map<string, LoggedAgentNote[]>();
  for (const line of lines) {
    const key = normalizeAgent(line.agent);
    const list = byAgent.get(key) ?? [];
    list.push(line);
    byAgent.set(key, list);
  }
  const views: AgentNotesView[] = [];
  for (const list of byAgent.values()) {
    list.sort((a, b) => b.at - a.at);
    const newest = list[0];
    if (!newest) continue;
    const words = list.filter((n) => n.withheld !== true);
    const notes = words.slice(0, Math.max(0, perAgentCap)).map((n) => ({
      at: n.at,
      kind: n.kind,
      text: n.text,
      placement: n.ambiguous ? ('undecidable' as const) : ('unattachable' as const),
    }));
    const placed = attachedLatest(newest.agent);
    const view: AgentNotesView =
      placed && placed.at > newest.at
        ? {
            agent: newest.agent,
            placement: 'attached',
            taskId: placed.taskId,
            latestAt: placed.at,
            notes,
            more: words.length - notes.length,
          }
        : {
            agent: newest.agent,
            placement: placementOfLogged(newest),
            latestAt: newest.at,
            notes,
            more: words.length - notes.length,
          };
    views.push(view);
  }
  return views.sort((a, b) => b.latestAt - a.latestAt || a.agent.localeCompare(b.agent));
}

export type ParseWithheldResult =
  | { ok: true; at: number; sessionId?: string }
  | { ok: false; error: string; message: string };

/**
 * The declaration's wire body: `{ withheld: true, at?, sessionId? }`. The
 * agent comes from the URL and there is no `text` — a body that carries one
 * is refused, because a declaration that smuggles the words it withholds
 * would be the leak the declaration exists to prevent.
 */
export function parseWithheld(body: Record<string, unknown>, now: number): ParseWithheldResult {
  if (body.text !== undefined && body.text !== null && body.text !== '') {
    return {
      ok: false,
      error: 'withheld-with-text',
      message: 'a withheld declaration carries no `text`',
    };
  }
  let at = now;
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'number' || !Number.isFinite(body.at)) {
      return { ok: false, error: 'bad-at', message: '`at` must be a millisecond timestamp' };
    }
    if (body.at >= now - AT_PAST_MS && body.at <= now + AT_FUTURE_MS) at = body.at;
  }
  if (body.sessionId !== undefined && body.sessionId !== null) {
    if (typeof body.sessionId !== 'string' || body.sessionId.length > 200) {
      return { ok: false, error: 'bad-session', message: '`sessionId` must be a short string' };
    }
    return { ok: true, at, sessionId: body.sessionId };
  }
  return { ok: true, at };
}
