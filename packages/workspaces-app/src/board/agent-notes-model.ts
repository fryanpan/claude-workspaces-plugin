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
 *  - `undecidable`  — the agent holds several tasks, so no one task took it.
 *  - `unattachable` — the agent holds no task, so nothing could take it.
 *    These do not clear on their own: a board parked on a decision stays
 *    parked for days.
 *  - `withheld`     — the session DECLARED it does not post its turns here.
 *    Shown so a blank Activity tab reads as a choice, not a fault. An agent
 *    that simply said nothing is not listed at all: silence is never turned
 *    into a state.
 *  - `attached`     — the agent's latest note did land on a task; the older
 *    notes listed are still on none.
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

export type NotePlacement = 'attached' | 'unattachable' | 'undecidable' | 'withheld';

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
  age: string;
  notes: ActivityNote[];
  more: number;
}

const PLACEMENTS: ReadonlySet<string> = new Set<NotePlacement>([
  'attached',
  'unattachable',
  'undecidable',
  'withheld',
]);
const KINDS: ReadonlySet<string> = new Set(['turn', 'denial', 'status']);

/** The state line. `title` is the attached task's title when the board has it.
 *  The two no-task states are past tense: they describe the newest logged
 *  note, and after a restart the server cannot see that a later note landed
 *  on a task, so a present-tense "holds" could be false. */
export function statePhrase(placement: NotePlacement, title?: string): string {
  switch (placement) {
    case 'undecidable':
      return 'held several tasks, so no one task took these';
    case 'unattachable':
      return 'held no task, so there was nothing to put these on';
    case 'withheld':
      return 'said it does not post its turns on this board';
    case 'attached':
      return title ? `latest note went to “${title}”` : 'latest note went to a task';
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
 * with the rest counted. A `withheld` agent is a header with no lines.
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
    // A latest note that DID land on a task, with nothing unplaced left in
    // the window, is not this list's business: the task group shows it.
    if (a.placement === 'attached' && inWindow.length === 0) continue;
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
      state: statePhrase(a.placement, a.taskId ? titles.get(a.taskId) : undefined),
      ...(a.placement === 'attached' && a.taskId ? { taskId: a.taskId } : {}),
      latestAt: a.latestAt,
      age: ageShort(a.latestAt, now),
      notes: shown.map((n) => ({
        at: n.at,
        age: ageShort(n.at, now),
        text: n.kind === 'denial' ? `${DENIAL_PREFIX}${n.text}` : firstLine(n.text),
        kind: n.kind,
      })),
      more: Math.max(0, hidden),
    });
  }
  return groups.sort((x, y) => y.latestAt - x.latestAt || x.agent.localeCompare(y.agent));
}
