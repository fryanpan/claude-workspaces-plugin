/**
 * The words on the fleet-wide unfiled-wait item — the half a person reads.
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
import { WAITING_UNFILED_BUCKET } from './waiting-unfiled.ts';

/** One task that has been an `unfiled` finding, with its board. */
export interface AgingWait {
  workspaceId: string;
  taskId: string;
  title: string;
  /** Which of the two ways it got onto the list — `WAITING_UNFILED_BUCKET`
   *  or `OWNER_UNFILED_BUCKET`. Carried because it is the EVIDENCE, and the
   *  item has to say what is actually true of each task: telling the reader
   *  an agent wrote closing words about a task the board simply has down to
   *  a person is a sentence they would correct. */
  bucket: string;
  /** How long the task has been quiet, from the gate's own reading. */
  quietMs: number;
  /** When the escalation first saw it as a finding. */
  firstSeen: number;
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
  const boards = new Set(rows.map((r) => r.workspaceId)).size;
  const headline =
    n === 1
      ? `“${clip(rows[0]?.title ?? '', 40)}” is waiting on a person, with nothing filed`
      : `${n} tasks are waiting on a person with nothing filed`;
  const lines = rows.map((row) => {
    const waited = span(Math.max(0, now - row.firstSeen));
    return `- [${label(row.title)}](${taskDeepLink(row.workspaceId, row.taskId)}) — ${evidence(row.bucket, waited)}`;
  });
  const where = boards === 1 ? 'one board' : `${boards} boards`;
  const detail = [
    `Each of these tasks is waiting on a person with nothing that person can answer. Their leads were told over ${span(agingMs)} ago and the asks are still unfiled. ${n === 1 ? 'It is' : 'They are'} on ${where}.`,
    '',
    ...lines,
    '',
    'Either the ask gets filed where you read it, or the agent says there was no ask. This item is written by the board itself and withdraws on its own once none is left.',
  ].join('\n');
  return { review_type: 'question', headline, detail };
}

/**
 * The half-sentence that says WHY this task is on the list — which is
 * different for the two buckets, and the difference is what the reader would
 * correct. One sentence covering both would either claim an agent wrote
 * closing words it never wrote, or drop the fact that one of them did.
 * Neither says "you": the item is fleet-wide, and the owner a row names need
 * not be its reader (`blocked-on-owner-unfiled` fires on any person owner).
 */
function evidence(bucket: string, waited: string): string {
  return bucket === WAITING_UNFILED_BUCKET
    ? `said it is waiting on a person ${waited} ago, with no question on anybody's queue.`
    : `has been down to its owner for ${waited}, with no question on their queue.`;
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
