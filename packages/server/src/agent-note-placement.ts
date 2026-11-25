/**
 * Where an agent's end-of-turn notes went on a board, named as the reader's
 * question rather than as the resolver's failure.
 *
 * `resolveNoteTarget` answers with a task, or with `ambiguous: true | false`,
 * and the unplaced-note log stores that flag. "Ambiguous" reads as "was there
 * a problem picking". What a person needs is which of three states a note is
 * in:
 *
 *  - `attached`     — it is on the one task the agent holds, on that task's
 *                     Activity tab. Nothing here changes that path.
 *  - `undecidable`  — the agent holds several tasks, and guessing one was
 *                     measured wrong about three times in four, so no task
 *                     took it.
 *  - `unattachable` — the agent holds no task, so there was nothing to take
 *                     it. This one does not clear by itself: a board parked
 *                     on its owner's call stays parked for days.
 *
 * The first is stored on the task; the other two live in the board's
 * unplaced-note log (`agent-note-log.ts`). `agentNotesByAgent` is the
 * per-agent view of that log that Home's "Not on a task" list reads
 * (`routes/board-agent-notes.ts`): per agent, because two of the three states
 * have no task to hang on.
 */
import type { LoggedAgentNote } from './agent-note-log.ts';
import type { AgentNoteKind } from './agent-notes.ts';
import { normalizeAgent } from './chat-audit.ts';

export type NotePlacement = 'attached' | 'unattachable' | 'undecidable';
/** The two states a note can be in without a task. */
export type UnplacedPlacement = Exclude<NotePlacement, 'attached'>;

/** How far back the board's per-agent read looks. The Home pane's own
 *  window (`ACTIVITY_WINDOW_MS` in the app), so both halves of the pane
 *  cover the same stretch of time. */
export const AGENT_NOTES_WINDOW_MS = 3 * 60 * 60_000;
/** Lines kept per agent; the rest are counted in `more`. */
export const AGENT_NOTES_PER_AGENT = 10;

/** The state a logged line records. */
export function placementOfLogged(note: Pick<LoggedAgentNote, 'ambiguous'>): UnplacedPlacement {
  return note.ambiguous ? 'undecidable' : 'unattachable';
}

export interface AgentNotesLine {
  at: number;
  kind: AgentNoteKind;
  text: string;
  placement: UnplacedPlacement;
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
  /** Notes no task took, newest first, at most the per-agent cap. */
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
  /** Notes the read already left out, per agent (keyed by `normalizeAgent`). */
  skipped: ReadonlyMap<string, number> = new Map(),
): AgentNotesView[] {
  const cap = Math.max(0, perAgentCap);
  const byAgent = new Map<string, LoggedAgentNote[]>();
  for (const line of lines) {
    const key = normalizeAgent(line.agent);
    const list = byAgent.get(key) ?? [];
    list.push(line);
    byAgent.set(key, list);
  }
  const views: AgentNotesView[] = [];
  for (const [key, list] of byAgent) {
    list.sort((a, b) => b.at - a.at);
    const newest = list[0];
    if (!newest) continue;
    const more = Math.max(0, list.length - cap) + (skipped.get(key) ?? 0);
    const notes = list.slice(0, cap).map((n) => ({
      at: n.at,
      kind: n.kind,
      text: n.text,
      placement: placementOfLogged(n),
    }));
    const placed = attachedLatest(newest.agent);
    views.push(
      placed && placed.at > newest.at
        ? {
            agent: newest.agent,
            placement: 'attached',
            taskId: placed.taskId,
            latestAt: placed.at,
            notes,
            more,
          }
        : {
            agent: newest.agent,
            placement: placementOfLogged(newest),
            latestAt: newest.at,
            notes,
            more,
          },
    );
  }
  return views.sort((a, b) => b.latestAt - a.latestAt || a.agent.localeCompare(b.agent));
}
