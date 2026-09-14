/**
 * Telling a person that a meeting's notes came out badly — on the row the
 * meeting's doc belongs to, in the words of what went wrong.
 *
 * THE POINT OF THE TICKET THIS SERVES. A broken meeting used to cost a
 * write-up: somebody read the notes, noticed the repeats, went back through
 * the transcript and wrote up what had been lost. Everything in that write-up
 * except the judgement is countable, so the countable half arrives on its own
 * and the person is left with the judgement.
 *
 * IT FILES ON THE ROW, NOT IN CHAT AND NOT AS A COMMENT. A review item on the
 * meeting doc's own row is answerable where the reader already is, and it is
 * the shape the board's own gates and queues understand. The path is exactly
 * the one the stale-schedule item uses (`task-run-record.ts`) — the store's
 * `addReviewItem`, an actor of the server's own, one item — because a second
 * way of filing the same kind of ask is a second thing to keep true.
 *
 * A DOC THAT BELONGS TO NO ROW GETS THE ITEM ON THE DOC ITSELF. Meetings are
 * held on docs that nobody has linked to a task, and inventing a row to hang
 * an item on would put a ticket on the board that nobody asked for. They used
 * to get nothing at all — a meeting flagged BAD and "NOT filed (no-row)" in a
 * log nobody reads (2026-09-14), which is the silence this module exists to
 * end. So the item goes on a thread about the whole doc: the Home queue reads
 * a doc thread's declared item exactly as it reads a row's, and the reader
 * lands on the notes it is about. Only a board with no way to reach threads
 * still answers `no-row`.
 *
 * ONE ITEM PER MEETING, and no memory is needed for that: a meeting stops
 * once. The repeat this must not become is one item per TICK, and it cannot,
 * because nothing calls it until the stop.
 */

import {
  type Anchor,
  type Ref,
  type ReviewPayload,
  type TaskReviewItem,
  type User,
  readReviewPayload,
} from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import { taskDeepLink } from './home-brief.ts';
import { docLookupUrl } from './meeting-lookup.ts';
import type { NotesQualityReport } from './notes-quality-report.ts';

/** What this module reaches in the store. `TaskStore` satisfies it. */
export interface NotesQualityBoard {
  /** Rows linking this ref. `backlinksFor` on the store. */
  backlinksFor(ref: Ref): Task[];
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ):
    | { ok: true; task: Task; item: TaskReviewItem; advice?: string }
    | { ok: false; error: string; message?: string };
  /**
   * File the item on the meeting doc as a thread about the whole doc, for a
   * doc no row links. `false` when the doc could not take it. Absent, such a
   * meeting is reported `no-row`. {@link fileOnMeetingDoc} is the server's.
   */
  fileOnDoc?(
    docId: string,
    review: Record<string, unknown>,
    actor: { id: string; name: string; kind?: string },
  ): boolean;
}

/** What {@link fileOnMeetingDoc} reaches in the doc store. `DocStore` satisfies it. */
export interface NotesQualityThreads {
  get(docId: string): unknown;
  postComment(
    docId: string,
    threadId: null,
    author: User,
    text: string,
    anchor: Anchor,
    opts: { generate: boolean; review: ReviewPayload },
  ): Promise<unknown>;
}

/**
 * Post the item as a subject thread on the doc — the same anchor and the same
 * payload reader a `create_thread` with a review takes, so the queue cannot
 * tell it from one an agent filed.
 *
 * SYNCHRONOUS ANSWER, because the stop's one log line is built right after
 * it. The two ways `postComment` declines a new thread are a doc it cannot
 * find and a missing anchor; the first is asked here first and the second
 * cannot happen, so `true` is what the post will do. A throw after that is
 * logged rather than lost.
 */
export function fileOnMeetingDoc(
  threads: NotesQualityThreads,
  docId: string,
  review: Record<string, unknown>,
  actor: { id: string; name: string; kind?: string },
): boolean {
  const payload = readReviewPayload(review);
  if (!payload || !threads.get(docId)) return false;
  // `kind: 'agent'` so the queue reads it as an ask waiting on a person.
  const author = { ...actor, kind: 'agent' } as unknown as User;
  threads
    .postComment(
      docId,
      null,
      author,
      payload.headline,
      { kind: 'subject' },
      {
        generate: false,
        review: payload,
      },
    )
    .catch((err) => console.error(`[meeting-notes] quality item on ${docId} failed:`, err));
  return true;
}

/**
 * The row a meeting's item goes on: the newest OPEN row linking the doc, and
 * the newest row of any status when none is open.
 *
 * Newest rather than first, because a doc that has carried meetings for weeks
 * accumulates rows and the one somebody is working is the recent one. Open
 * ahead of newest, because an item on a closed row is an item nobody will
 * see — closing a row is how a person says they are done looking at it.
 */
export function rowForMeetingDoc(board: NotesQualityBoard, docId: string): Task | undefined {
  const rows = board.backlinksFor({ kind: 'doc', docId }).filter((t) => t.archivedAt === undefined);
  if (rows.length === 0) return undefined;
  const newest = (a: Task, b: Task): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const open = rows.filter((t) => t.status !== 'done').sort(newest);
  return open[0] ?? rows.sort(newest)[0];
}

/** How many offenders the detail names before it stops listing. A card is a
 *  card; past a few the count is the information and the list is scenery. */
export const NAMED_OFFENDER_LIMIT = 3;

/** One line naming up to {@link NAMED_OFFENDER_LIMIT} of a list. */
function naming(items: readonly string[]): string {
  const shown = items.slice(0, NAMED_OFFENDER_LIMIT).map((s) => `“${s.replace(/[[\]]/g, '')}”`);
  const rest = items.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

/**
 * The item's words.
 *
 * Exported so a test reads what a person would see, the same reason
 * `buildStaleReview` is. Links are relative and inline, like every other
 * item the server writes.
 */
export function buildNotesQualityReview(input: {
  workspaceId: string;
  docId: string;
  docTitle?: string;
  report: NotesQualityReport;
}): Record<string, unknown> {
  const { workspaceId, docId, report } = input;
  const title = (input.docTitle ?? 'this meeting').replace(/[[\]]/g, '');
  const headline = `The notes for “${title}” came out badly — ${report.flags
    .map((f) => f.text)
    .join('; ')}`;
  const lines: string[] = [
    'The server read the notes at the stop and counted what it could without a model. ' +
      'Each number below is decidable; whether the meeting needs re-doing is not, which is why ' +
      'this is a question rather than a fix.',
    '',
  ];
  if (report.duplicateBulletLines > 0) {
    lines.push(
      `- **${report.duplicateBulletLines} repeated bullets** of ${report.bullets} — ` +
        `${report.repeatedBullets.length} lines written more than once.`,
    );
  }
  if (report.duplicateHeadings.length > 0) {
    lines.push(`- **Topics opened twice:** ${naming(report.duplicateHeadings)}.`);
  }
  if (report.longRuns.length > 0) {
    lines.push(
      `- **${report.longRuns.length} topics left as a wall of bullets**, the longest ` +
        `${Math.max(...report.longRuns.map((r) => r.bullets.length))} bullets deep.`,
    );
  }
  if (report.unknownVoices.length > 0) {
    lines.push(
      '- **Speakers the meeting never had:** ' +
        `${naming(report.unknownVoices.map((v) => v.name))}. ` +
        'The transcript carries no voice by that name.',
    );
  }
  if (report.uncoveredShare !== null) {
    lines.push(
      `- **${report.uncoveredIdeas} of ${report.ideas} things said reached no note** ` +
        `(${Math.round(report.uncoveredShare * 100)}%). This one is a lexical proxy and ` +
        'over-reports paraphrase, so read it as an upper bound.',
    );
  }
  if (report.lateness.source === 'ticks' && report.lateness.lateShare !== null) {
    lines.push(
      `- **${report.lateness.late} of ${report.lateness.measured} notes landed over a minute ` +
        `after the words settled**, the worst at ${Math.round(
          (report.lateness.maxMs ?? 0) / 1000,
        )}s.`,
    );
  } else {
    lines.push(`- **How late the notes landed is not known** — ${report.lateness.missing}.`);
  }
  lines.push(
    '',
    `Read them in [${title}](${docLookupUrl(workspaceId, docId)}). ` +
      'Answering this closes it; the next meeting on this doc is judged on its own.',
  );
  return { review_type: 'question', headline, detail: lines.join('\n') };
}

/** What happened when a reading was filed. */
export type NotesQualityFiling =
  | { filed: true; taskId: string; itemId: string }
  | { filed: true; docId: string }
  | { filed: false; reason: 'healthy' | 'no-row' | 'no-board' | 'refused'; message?: string };

/**
 * File the item for a meeting whose notes went past a bar. A healthy meeting
 * files nothing — the log line and the stored record are the whole record of
 * one that went fine.
 */
export function fileNotesQualityReview(
  board: NotesQualityBoard,
  actor: { id: string; name: string; kind?: string },
  input: {
    workspaceId: string | undefined;
    docId: string;
    docTitle?: string;
    report: NotesQualityReport;
  },
): NotesQualityFiling {
  if (input.report.flags.length === 0) return { filed: false, reason: 'healthy' };
  if (input.workspaceId === undefined) return { filed: false, reason: 'no-board' };
  const review = buildNotesQualityReview({
    workspaceId: input.workspaceId,
    docId: input.docId,
    ...(input.docTitle !== undefined ? { docTitle: input.docTitle } : {}),
    report: input.report,
  });
  const row = rowForMeetingDoc(board, input.docId);
  if (!row) {
    if (!board.fileOnDoc) return { filed: false, reason: 'no-row' };
    return board.fileOnDoc(input.docId, review, actor)
      ? { filed: true, docId: input.docId }
      : { filed: false, reason: 'refused', message: 'the doc took no thread' };
  }
  const res = board.addReviewItem(row.id, review, { actor });
  if (!res.ok) {
    return { filed: false, reason: 'refused', message: res.message ?? res.error };
  }
  return { filed: true, taskId: row.id, itemId: res.item.id };
}

/** The row's own deep link, for the log line that says where the item went. */
export function filedItemLink(workspaceId: string, taskId: string): string {
  return taskDeepLink(workspaceId, taskId);
}
