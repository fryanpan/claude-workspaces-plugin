/**
 * Home's "Not on a task" list, as a pure view model: the end-of-turn notes no
 * task took, one group per AGENT, each headed by the state its notes are in.
 *
 * The rest of Recent activity is grouped by task, never by agent (Bryan,
 * 2026-08-29: "I care about the work"). These notes have no task — that is
 * the whole of what is wrong with them — so the agent is the only heading
 * left, and the state line says why they sit here instead of under a task.
 *
 * The states come from the server (`agent-note-placement.ts`), and the
 * phrases below are the one place a reader meets them:
 *
 *  - `undecidable`  — the agent held several tasks, so no one task took it.
 *  - `unattachable` — the agent held no task, so nothing could take it.
 *  - `attached`     — the agent's latest note did land on a task; the older
 *                     notes listed are still on none.
 */
import {
  ACTIVITY_NOTE_CAP,
  ACTIVITY_WINDOW_MS,
  type ActivityNote,
  DENIAL_PREFIX,
  ageShort,
  firstLine,
} from './activity-model.ts';
import type { BoardTask } from './board-model.ts';

export type NotePlacement = 'attached' | 'unattachable' | 'undecidable';

/** One agent as `GET /workspaces/:ws/agent-notes` answers it. */
export interface AgentNotesWire {
  agent: string;
  placement: NotePlacement;
  taskId?: string;
  latestAt: number;
  notes: { at: number; kind: 'turn' | 'denial' | 'status'; text: string }[];
  more: number;
}

export interface AgentNoteGroup {
  /** `agent:<name>` — never collides with a task group's id. */
  key: string;
  agent: string;
  placement: NotePlacement;
  /** What the state means, in the reader's words. */
  state: string;
  /** Set only for `attached`: the task the agent's latest note went to. */
  taskId?: string;
  latestAt: number;
  /** The newest LISTED note's age. Not `latestAt`'s: for `attached` that is
   *  the note the task took, which this group does not show. */
  age: string;
  notes: AgentNote[];
  more: number;
}

/** A listed note: its first line to draw, and its whole text to expand to.
 *  `age` is empty in a one-note group, whose header already carries it. */
export interface AgentNote extends ActivityNote {
  full: string;
}

const PLACEMENTS: ReadonlySet<string> = new Set<NotePlacement>([
  'attached',
  'unattachable',
  'undecidable',
]);
const KINDS: ReadonlySet<string> = new Set(['turn', 'denial', 'status']);

/** The state line, for `count` listed notes. `title` is the attached task's
 *  title when the board has it. The two no-task states are past tense: they
 *  describe the newest logged note, and after a restart the server cannot
 *  see that a later note landed on a task, so a present-tense "holds" could
 *  be false. `attached` says first that the listed notes went nowhere, so it
 *  never reads as though they are on the task it names. */
export function statePhrase(placement: NotePlacement, title?: string, count = 1): string {
  const it = count === 1 ? 'this' : 'these';
  switch (placement) {
    case 'undecidable':
      return `held several tasks, so no one task took ${it}`;
    case 'unattachable':
      return `held no task, so there was nothing to put ${it} on`;
    case 'attached': {
      const where = title ? `“${title}”` : 'a task';
      const what = count === 1 ? 'this earlier note' : 'these earlier notes';
      return `${what} went nowhere; the latest is on ${where}`;
    }
  }
}

/** The wire answer, narrowed. Anything malformed is dropped rather than
 *  drawn: a half-read agent is worse than a missing one. */
export function parseAgentNotes(raw: unknown): AgentNotesWire[] {
  const list = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(list)) return [];
  const out: AgentNotesWire[] = [];
  for (const item of list) {
    const r = item as Record<string, unknown> | null;
    if (!r || typeof r.agent !== 'string' || r.agent === '') continue;
    if (typeof r.placement !== 'string' || !PLACEMENTS.has(r.placement)) continue;
    if (typeof r.latestAt !== 'number' || !Array.isArray(r.notes)) continue;
    const notes: AgentNotesWire['notes'] = [];
    for (const n of r.notes as unknown[]) {
      const x = n as Record<string, unknown> | null;
      if (!x || typeof x.at !== 'number' || typeof x.text !== 'string') continue;
      if (typeof x.kind !== 'string' || !KINDS.has(x.kind)) continue;
      notes.push({
        at: x.at,
        kind: x.kind as AgentNotesWire['notes'][number]['kind'],
        text: x.text,
      });
    }
    out.push({
      agent: r.agent,
      placement: r.placement as NotePlacement,
      ...(typeof r.taskId === 'string' ? { taskId: r.taskId } : {}),
      latestAt: r.latestAt,
      notes,
      more: typeof r.more === 'number' ? r.more : 0,
    });
  }
  return out;
}

/**
 * The groups Home draws, newest agent first: inside the pane's window, each
 * note by its first line (as a task group's are), at most `ACTIVITY_NOTE_CAP`
 * with the rest counted.
 */
export function agentNoteGroups(
  agents: readonly AgentNotesWire[],
  tasks: readonly BoardTask[],
  now: number,
): AgentNoteGroup[] {
  const since = now - ACTIVITY_WINDOW_MS;
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const groups: AgentNoteGroup[] = [];
  for (const a of agents) {
    if (a.latestAt < since) continue;
    const inWindow = a.notes.filter((n) => n.at >= since && n.at <= now);
    // An agent with nothing unplaced left in the window is not this list's
    // business: if its latest note landed on a task, the task group shows it.
    if (inWindow.length === 0) continue;
    const shown = inWindow.slice(0, ACTIVITY_NOTE_CAP);
    // The server's `more` is older than every note it sent. Count it only
    // when none of those notes fell outside the window: if some did, the
    // older ones the server held back are outside it too.
    const hidden =
      inWindow.length - shown.length + (inWindow.length === a.notes.length ? a.more : 0);
    groups.push({
      key: `agent:${a.agent}`,
      agent: a.agent,
      placement: a.placement,
      state: statePhrase(a.placement, a.taskId ? titles.get(a.taskId) : undefined, shown.length),
      ...(a.placement === 'attached' && a.taskId ? { taskId: a.taskId } : {}),
      latestAt: a.latestAt,
      age: ageShort(shown[0]?.at ?? a.latestAt, now),
      notes: shown.map((n) => {
        const full = n.kind === 'denial' ? `${DENIAL_PREFIX}${n.text}` : n.text;
        return {
          at: n.at,
          age: shown.length === 1 ? '' : ageShort(n.at, now),
          text: n.kind === 'denial' ? full : firstLine(n.text),
          full,
          kind: n.kind,
        };
      }),
      more: Math.max(0, hidden),
    });
  }
  return groups.sort((x, y) => y.latestAt - x.latestAt || x.agent.localeCompare(y.agent));
}
