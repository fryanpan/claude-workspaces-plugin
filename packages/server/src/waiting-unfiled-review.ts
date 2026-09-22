/**
 * The words on a board's unfiled-wait item — the half a person reads.
 *
 * What it claims is an AGE, matching the Team Lead frame's first line
 * (`nudge-line.ts`'s `unfiledCarryLine`): these rows have been unfiled asks on
 * this board's list for over the window. It used to say the board's lead "was
 * told over X ago", which nothing here knows — the escalation records that a
 * row is aging, never that a particular agent read a particular wake, and a
 * seat can change hands or stand empty while a row ages. The item and the
 * frame say the same thing on purpose: a reader who meets both must not be
 * told two different stories about the same rows.
 *
 * Split out of `waiting-unfiled-escalation.ts` for the reason
 * `docs/architecture/exceptions.md` already names as the obvious seam on its
 * sibling `stall-escalation.ts`: rendering is a pure function of the due rows
 * and nothing else, it was already exported so its tests could read what a
 * person would see rather than assert on the call that wrote it, and keeping
 * it beside the aging machinery meant one file answering two questions — when
 * a wait goes past its lead, and what the reader is then shown.
 *
 * `AgingWait` lives here rather than there because it is the INPUT to these
 * words: every field on it exists to be rendered, and the escalation imports
 * it back.
 */
import { taskDeepLink } from './home-brief.ts';
import { span } from './stall-escalation.ts';

/** One task that has been an `unfiled` finding, with its board. */
export interface AgingWait {
  workspaceId: string;
  taskId: string;
  title: string;
  /** The bucket that put it on the list — `WAITING_UNFILED_BUCKET`, the only
   *  one that reaches here. Carried for the Team Lead FRAME, which names each
   *  row's bucket so the reader knows what kind of evidence it is looking at;
   *  these words no longer branch on it, because there is nothing to branch
   *  to (`waiting-unfiled-escalation.ts`, 2026-09-22). */
  bucket: string;
  /** The board's lead seat as it stands at the tick this row was read,
   *  absent when the seat is empty. Who the filing goes back to — not a
   *  record that anybody was told, which nothing here holds. Read by the Team
   *  Lead FRAME; these words never render it, because the person reading the
   *  item is on that board already. */
  leadAgentId?: string;
  /** How long the task has been quiet, from the gate's own reading. */
  quietMs: number;
  /** When the escalation first saw it as a finding. */
  firstSeen: number;
  /** How many fleet wakes have already carried it. Read by the escalation,
   *  not by these words: the reader of the item is being shown the finding,
   *  not the history of who was woken about it. */
  tells: number;
}

/** The due tasks' words. Exported so a test reads what a person would see
 *  rather than asserting on the call that wrote it. */
export function buildWaitingUnfiledReview(input: {
  rows: readonly AgingWait[];
  agingMs: number;
  now: number;
}): Record<string, unknown> {
  const { rows, agingMs, now } = input;
  const n = rows.length;
  const headline =
    n === 1
      ? `“${clip(rows[0]?.title ?? '', 40)}” is waiting on a person, with nothing filed`
      : `${n} tasks are waiting on a person with nothing filed`;
  const lines = rows.map((row) => {
    const waited = span(Math.max(0, now - row.firstSeen));
    return `- [${label(row.title)}](${taskDeepLink(row.workspaceId, row.taskId)}) — said it is waiting on a person ${waited} ago, with no question on anybody's queue.`;
  });
  const detail = [
    `Each of these tasks is waiting on a person with nothing that person can answer. ${n === 1 ? 'It has' : 'Each has'} been an unfiled ask on this board's list for over ${span(agingMs)}. ${n === 1 ? 'It is' : 'They are'} on this board.`,
    '',
    ...lines,
    '',
    'Either the ask gets filed where you read it, or the agent says there was no ask. This item is written by the board itself and withdraws on its own once none is left.',
  ].join('\n');
  return { review_type: 'question', headline, detail };
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** A title as a markdown LINK LABEL — brackets dropped rather than escaped,
 *  the same call `home-brief.ts` makes. */
function label(title: string): string {
  return title.replace(/[[\]]/g, '');
}
