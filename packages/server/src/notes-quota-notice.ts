/**
 * Saying, in the meeting's own notes, that the note-taker has stopped.
 *
 * WHY IT GOES IN THE DOC. A meeting that loses its note-taker looks exactly
 * like a meeting nobody is saying anything quotable in: the section simply
 * stops growing. On 2026-09-09 the model account hit its monthly limit, the
 * server logged a refusal per tick, and the people in the room found out
 * hours later from a log. The one surface everybody in that room already had
 * open was the notes themselves, so that is where the sentence goes.
 *
 * ONCE PER OUTAGE, NOT ONCE PER TICK. A quota refusal repeats every tick for
 * as long as the account is empty — a notice per refusal would bury the
 * meeting under its own error message within a minute. Two things hold the
 * line, deliberately both: an in-memory flag, which is what makes the second
 * refusal in a row cost nothing, and a look for the notice in the outline the
 * tick already read, which survives a session that restarts mid-outage and a
 * flag that a reconnect resets.
 *
 * AND IT LEAVES WHEN THE OUTAGE DOES. A doc still claiming "notes are
 * paused" underneath a paragraph of fresh notes is worse than no notice: it
 * teaches the reader to disbelieve the next one. The first tick that composes
 * successfully deletes it.
 *
 * Nothing here reads a response body, a header or a credential. It is handed
 * a verdict and an outline and answers with block edits.
 */
import type { prose } from '@claude-workspaces/core';

/**
 * The sentence the doc gets.
 *
 * Written for somebody glancing at the notes mid-sentence: what stopped,
 * what did not stop, and that it will come back on its own. It names no
 * account, no key and no status code — a person in a meeting cannot act on
 * any of those, and the log already has them.
 */
export const QUOTA_NOTICE_TEXT =
  'Live notes are paused: the note-taking model is out of quota. ' +
  'The meeting is still being recorded, and notes resume as soon as it is back.';

/**
 * The prefix the notice is found again by. It is the START of the sentence
 * because an outline entry's text is TRUNCATED — a marker at the end would
 * be invisible to the very read that has to find it.
 */
export const QUOTA_NOTICE_MARK = 'Live notes are paused';

/** The subset of an outline entry this module needs, so a test need not
 *  build a Yjs doc to drive it. */
export interface NoticeOutlineEntry {
  id: string;
  text: string;
  author?: string;
}

/** Whether this block is a notice this note-taker wrote. An unauthored block
 *  is a person's own words — `clearAuthorshipOnPersonEdit` makes "written by
 *  somebody else" and "since touched by somebody" the same answer — and this
 *  module never proposes anything about those. */
function isOurNotice(entry: NoticeOutlineEntry): boolean {
  return entry.author !== undefined && entry.text.trimStart().startsWith(QUOTA_NOTICE_MARK);
}

/** Live for one notes session. `open` is true from the notice being written
 *  until a successful compose takes it away again. */
export interface QuotaNoticeState {
  open: boolean;
}

export function createQuotaNoticeState(): QuotaNoticeState {
  return { open: false };
}

/**
 * The edits that tell the doc about a quota refusal — one insert, or nothing
 * at all when this outage has already said its piece.
 *
 * `notesHeadingId` is where the meeting's section is; without one the notice
 * goes at the end of the doc, which is where a section that does not exist
 * yet would have been opened anyway.
 */
export function quotaNoticeEdits(
  state: QuotaNoticeState,
  outline: readonly NoticeOutlineEntry[],
  notesHeadingId: string | undefined,
): prose.BlockEdit[] {
  if (state.open) return [];
  if (outline.some(isOurNotice)) {
    // Already in the doc from an earlier tick this session cannot remember.
    // Adopt it rather than adding a second one.
    state.open = true;
    return [];
  }
  state.open = true;
  return [
    notesHeadingId === undefined
      ? { op: 'insert_at_end', markdown: QUOTA_NOTICE_TEXT }
      : { op: 'insert_under_heading', headingId: notesHeadingId, markdown: QUOTA_NOTICE_TEXT },
  ];
}

/**
 * The edits that take the notice away once notes are flowing again — one
 * delete per notice block still standing, and nothing when there is none.
 *
 * Every match is deleted, not just the first: a session restarted mid-outage
 * can have written a second one before this module's outline check existed
 * to see the first, and leaving one behind is the failure this function is
 * for.
 */
export function quotaNoticeClearEdits(
  state: QuotaNoticeState,
  outline: readonly NoticeOutlineEntry[],
): prose.BlockEdit[] {
  state.open = false;
  return outline
    .filter(isOurNotice)
    .map((entry) => ({ op: 'delete_block', blockId: entry.id }) satisfies prose.BlockEdit);
}
