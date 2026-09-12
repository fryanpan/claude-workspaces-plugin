/**
 * Saying, in the meeting's own notes, that something has gone wrong with the
 * note-taking — the two things a person in the room cannot otherwise see.
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
 * TWO NOTICES, ONE MECHANISM. The quota outage was the first; the second is a
 * tick whose words could not be written at all. They differ only in their
 * sentence, and everything above — announce once, adopt one already in the
 * doc, retract when it stops being true, believe nothing until the write is
 * accepted — is the same reasoning twice. So a notice is a `NoticeKind` and
 * the verbs take one, rather than this file growing a parallel copy of itself.
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
function isOurNotice(entry: NoticeOutlineEntry, kind: NoticeKind): boolean {
  return entry.author !== undefined && entry.text.trimStart().startsWith(kind.mark);
}

/** Live for one notes session. `open` is true only while the doc is KNOWN to
 *  be carrying the notice — set when a write is accepted, cleared when a
 *  deletion is accepted, and never on the strength of an attempt. */
export interface NoticeState {
  open: boolean;
}

/**
 * One notice the note-taker can raise: what it says, and the prefix it is
 * found again by.
 */
export interface NoticeKind {
  text: string;
  /** The START of the sentence, because an outline entry's text is TRUNCATED
   *  — a marker at the end would be invisible to the read that must find it. */
  mark: string;
}

export const QUOTA_NOTICE: NoticeKind = { text: QUOTA_NOTICE_TEXT, mark: QUOTA_NOTICE_MARK };

/**
 * The sentence for a tick whose words did not reach the doc.
 *
 * WHY IT IS WORTH A LINE IN THE NOTES. A failed write already puts its turns
 * back on the live transcript, where they read as "still being written up" —
 * which is TRUE for a failure the next tick recovers, and a lie for one that
 * repeats. The person then watches phrases sit there for the rest of the
 * meeting and has no way to know the notes stopped taking them. Nothing else
 * they can see says so; the only other trace is a line in the server log.
 *
 * It asks for nothing and blames nothing — a person in a meeting cannot act
 * on a block id — and it says the recording is unaffected, because the one
 * decision this sentence has to inform is whether to stop and write by hand.
 */
export const NOTES_NOT_WRITTEN_TEXT =
  'Some of what was just said could not be written into these notes. ' +
  'The meeting is still being recorded, and the full transcript is kept.';

export const NOTES_NOT_WRITTEN_MARK = 'Some of what was just said';

export const NOTES_NOT_WRITTEN_NOTICE: NoticeKind = {
  text: NOTES_NOT_WRITTEN_TEXT,
  mark: NOTES_NOT_WRITTEN_MARK,
};

/**
 * How many writes must fail in a row before the doc says so.
 *
 * TWO, and the number is the whole judgement. One failed write is recovered
 * by the pipeline itself — the turns carry and the next compose writes them
 * up — so announcing on the first would put a sentence in the notes about
 * words that arrive a few seconds later. From the second on, `retriedFailure`
 * has already been spent and nothing is recovering anything.
 */
export const NOTES_NOT_WRITTEN_AFTER = 2;

export function createNoticeState(): NoticeState {
  return { open: false };
}

/**
 * How this module puts words in the doc: it hands over edits and is told
 * whether they landed.
 *
 * The boolean is the whole point of the seam. A notes sink can throw, answer
 * `false`, or refuse on policy, and a state machine that assumed success
 * would then be describing a doc that says something else — which is exactly
 * how a notice gets suppressed forever, or a retraction gets lost.
 */
export type NoticeWriter = (edits: readonly prose.BlockEdit[]) => boolean;

/**
 * Tell the doc the note-taker is out of quota, unless it already says so.
 *
 * Nothing is remembered until the write is ACCEPTED. A refused write leaves
 * the outage un-announced, so the next refusal tries again — the room being
 * told late is a far smaller failure than the room never being told because
 * one write bounced.
 */
export function announceNotice(
  kind: NoticeKind,
  state: NoticeState,
  outline: readonly NoticeOutlineEntry[],
  notesHeadingId: string | undefined,
  write: NoticeWriter,
): void {
  if (state.open) return;
  if (outline.some((e) => isOurNotice(e, kind))) {
    // Already in the doc from an earlier tick this session cannot remember.
    // Adopt it rather than adding a second one.
    state.open = true;
    return;
  }
  const edit: prose.BlockEdit =
    notesHeadingId === undefined
      ? { op: 'insert_at_end', markdown: kind.text }
      : { op: 'insert_under_heading', headingId: notesHeadingId, markdown: kind.text };
  if (write([edit])) state.open = true;
}

/** The quota outage, announced. The kind this module was written for. */
export function announceQuotaOutage(
  state: NoticeState,
  outline: readonly NoticeOutlineEntry[],
  notesHeadingId: string | undefined,
  write: NoticeWriter,
): void {
  announceNotice(QUOTA_NOTICE, state, outline, notesHeadingId, write);
}

/**
 * Take the notice away now that notes are flowing again.
 *
 * IT READS THE OUTLINE RATHER THAN THIS SESSION'S MEMORY. A session that
 * started after the outage began remembers writing nothing, and if quota
 * recovered before its first compose, a guard on `open` would mean nobody
 * ever looks and the doc claims an outage forever. What decides is what the
 * doc actually says.
 *
 * Every match is deleted, not just the first, and `open` closes only once the
 * deletion is accepted — a rejected delete leaves the session still believing
 * the doc is claiming an outage, which is true, and the next successful tick
 * tries again.
 */
export function retractNotice(
  kind: NoticeKind,
  state: NoticeState,
  outline: readonly NoticeOutlineEntry[],
  write: NoticeWriter,
): void {
  const edits = outline
    .filter((e) => isOurNotice(e, kind))
    .map((entry) => ({ op: 'delete_block', blockId: entry.id }) satisfies prose.BlockEdit);
  if (edits.length === 0) {
    // The doc carries no notice, so there is nothing to be wrong about.
    state.open = false;
    return;
  }
  if (write(edits)) state.open = false;
}

/** The quota outage, taken away. */
export function retractQuotaNotice(
  state: NoticeState,
  outline: readonly NoticeOutlineEntry[],
  write: NoticeWriter,
): void {
  retractNotice(QUOTA_NOTICE, state, outline, write);
}
