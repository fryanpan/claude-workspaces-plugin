/**
 * The tidy-up pass: one more read of the notes, against the WHOLE transcript,
 * asked for by a person after the recording has stopped.
 *
 * WHY IT IS THE COMPOSER AGAIN AND NOT A NEW SUBSYSTEM. A tick already turns
 * "here is the doc, here is some speech" into a short list of block-addressed
 * edits. A cleanup is that same question asked once, with the whole meeting as
 * the speech and no clock behind it — so it reuses `NotesComposer`, the same
 * prompt store, the same `applyBlockEdits` write path and the same authorship
 * rules. Nothing here can reach a doc by a route the live note-taker cannot.
 *
 * THE HARD CRITERION IS RESTRAINT, NOT COVERAGE. These notes have been on
 * screen for the length of a meeting; people have read them and commented on
 * them. A pass that rewrites every bullet destroys that, and is worse than no
 * pass at all — so the prompt's first rule is to leave a good note alone, an
 * empty edit list is a documented success, and this module counts what it
 * touched so the number can be measured rather than asserted.
 *
 * WHAT NO WORDING OF A PROMPT CAN UNDO (`confineToSection`):
 *
 * - **A person's line is never REWRITTEN — and it may still be argued
 *   with.** An edit naming a block the doc records as somebody else's never
 *   changes their words; a `replace_block` on one lands as a redline
 *   SUGGESTION they accept or reject, and their line stays byte-identical
 *   until they do (Bryan, 2026-09-10: *"the rule was do not rewrite human
 *   text. But if you spot an improvement, use the suggest and edit tool to
 *   suggest an edit"*). Only the replace is offered that way — a proposed
 *   deletion or nesting of their line is dropped, because neither is an
 *   improvement to what they wrote. What "records as somebody else's" means
 *   is the one thing this gate has to get right, and it is not the same
 *   question as "does the note-taker still own it" — see `claimable`.
 * - **Nothing outside this meeting's own section moves.** The section is the
 *   heading the meeting opened plus its blocks; an edit naming anything else
 *   — an earlier meeting's notes, the doc's own body — is dropped.
 * - **No second section is opened.** `insert_at_end` is refused outright: a
 *   cleanup has a section already, and the one way to grow a duplicate
 *   "Meeting notes" heading is to write at the end of the doc.
 * - **A bullet somebody has commented on is not rewritten.** Rewriting one
 *   re-creates its text and breaks every thread anchored inside it; the pass
 *   adds beside it instead. See `commentedBlockIds`.
 *
 * IT MUST NEVER THROW. It is reached from a route a person pressed a button
 * for; a compose that fails, a doc that has gone, a transcript that will not
 * read are all answers, and every one of them is reported rather than raised.
 */

import { prose, speakerDisplayName } from '@claude-workspaces/core';
import type { NotesComposeInput, NotesComposer, NotesTurn } from './meeting-notes.ts';
import { listMeetings, readTranscript } from './meetings.ts';
import {
  claimForCleanup,
  claimable,
  commentedBlockIds,
  confineToSection,
  notesMarksLive,
  sectionIds,
} from './notes-cleanup-scope.ts';
import {
  NOTES_AUTHOR_ID,
  type NotesDocStore,
  applyNotesBlockEdits,
  readNotesOutline,
} from './notes-doc-access.ts';

/**
 * The instruction block a cleanup adds to the ordinary note-taking rules.
 *
 * It is an ADDITION and not a replacement, because criterion two of the task
 * is that the pass follows the same rules as regular note-taking and simply
 * does them better. The system prompt is therefore the operator's own
 * instructions, unchanged; everything below is about what makes this read
 * different from a tick — the whole meeting is in front of it, and the notes
 * it is reading are finished work somebody has already seen.
 *
 * THE RESTRAINT CLAUSES ARE SAID THREE WAYS ON PURPOSE — as the job ("make
 * these notes better, not write them again"), as the bar ("a note that
 * already says what was said is FINISHED"), and as the permitted answer ("an
 * empty list is a success"). A single polite request to be conservative reads
 * as a hedge on an instruction to improve; the measurement in
 * `packages/server/scripts/notes-cleanup-check.ts` is what says whether the wording holds.
 *
 * AND ONE CLAUSE PULLS THE OTHER WAY ON PURPOSE. A person's line may be
 * argued with, as a suggestion. Said as a flat prohibition — which is how
 * this read until 2026-09-10 — the model proposed nothing at all on their
 * lines, so the suggestion path underneath it never fired and the feature
 * Bryan asked for did not exist. The restraint that matters is on their
 * WORDS, and the doc enforces that whatever the prompt says.
 */
export const CLEANUP_DIRECTIVE = [
  'FINAL PASS OVER THE WHOLE MEETING. The recording has stopped and a person',
  'asked for one more read of these notes. The transcript below is the ENTIRE',
  'meeting, not the last minute of it, and the notes are what you wrote while',
  'it was running.',
  '',
  'Your job is to make these notes BETTER, not to write them again.',
  '',
  '- CHANGE AS LITTLE AS POSSIBLE. A note that already says what was said, in',
  "  a reader's own words, is FINISHED — leave it exactly as it is, word for",
  '  word. People have already read these notes and commented on them, and a',
  '  rewrite that only moves words around destroys that. If the notes are',
  '  already good, answer with an empty list. That is a success, not a',
  '  failure.',
  '- ADD what is missing: an idea this meeting carried that no note mentions,',
  '  a decision, an owner, an open question. This is the main thing you are',
  '  for — you can now see the whole conversation at once.',
  '- FIX what the whole transcript shows to be wrong: a note that misread a',
  '  garbled word, a point marked (unconfirmed) that the rest of the meeting',
  '  confirms or refutes.',
  '- REORGANISE only where the notes are actually hard to read: a point filed',
  '  under the wrong heading, a topic left as a wall of bullets past the',
  '  regrouping bar. Bullets that read fine where they are stay where they',
  '  are.',
  '- Lines marked "theirs" were written by a PERSON. Never delete one, never',
  '  move or nest one, and do not repeat what they say.',
  '- YOU MAY STILL OFFER AN IMPROVEMENT ON A LINE MARKED "theirs", and you',
  '  cannot rewrite one by accident: name it in a replace_block with your',
  '  better wording and it reaches them as a SUGGESTION on their own line,',
  '  which they accept or reject. Their words do not change unless they say',
  '  so. Offer one only where the meeting shows something real — a figure or',
  '  a name the transcript contradicts, a point the room settled differently,',
  '  a note left hanging — never to restyle a line you would have worded',
  '  another way. One offer at most per line, and none at all if the line is',
  '  simply fine.',
  '- Do not open a new section, do not restate the transcript, and do not',
  '  write a summary of the meeting at the end.',
].join('\n');

/** How the transcript block is introduced, in place of the tick's own line. */
export const CLEANUP_TRANSCRIPT_LABEL = 'The whole meeting, as it was transcribed';

/**
 * The most transcript one pass may carry, in characters.
 *
 * Refused rather than trimmed. Dropping the opening of a meeting to fit would
 * make the pass silently worse at exactly the meeting where it is hardest to
 * tell — and this is above three hours of speech, which is past the length a
 * single streaming session even reaches.
 */
export const MAX_CLEANUP_TRANSCRIPT_CHARS = 120_000;

/** How much of the doc the pass reads. The whole notes section and then
 *  some: unlike a tick, it is allowed to see the start of the meeting. */
export const CLEANUP_OUTLINE_BLOCKS = 400;

/** Why a pass did nothing. Each is a settled state, never an error. */
export type NotesCleanupRefusal =
  | 'no-composer'
  | 'no-doc'
  | 'no-section'
  | 'no-transcript'
  | 'transcript-too-long'
  | 'compose-failed';

export interface NotesCleanupResult {
  /** Whether a compose ran and its edits reached the doc. An `ok` pass that
   *  changed nothing is the good case, not a null one. */
  ok: boolean;
  reason?: NotesCleanupRefusal;
  /** Edits the model returned. */
  proposed: number;
  /** Edits `confineToSection` dropped — outside the section, aimed at the
   *  section heading, at a commented bullet, or proposing to delete or move
   *  somebody else's line. An edit it turned into an offer is NOT one of
   *  these: it was kept, and comes back under `suggested`. */
  refused: number;
  applied: number;
  /** Edits that reached somebody's line as a redline to accept or reject,
   *  rather than as a rewrite of it. */
  suggested: number;
  failed: number;
  /**
   * Blocks the doc actually changed — the restraint number, and the one the
   * measurement in the PR body reports. `applied` counts edits; a batch whose
   * every edit failed touched nothing.
   */
  touched: number;
  /** Settled turns the pass read. */
  turns: number;
  /** One line for the log, and for the route's reply. */
  line: string;
}

export interface NotesCleanupDeps {
  docStore: () => NotesDocStore;
  /** The live note-taker's composer, or null when no key is configured — in
   *  which case a cleanup is refused in the same words a meeting's notes are. */
  composer: NotesComposer | null;
  /** Where the transcript and the meeting record live. */
  dataDir?: string;
  /** The block id of the heading this meeting wrote under. */
  headingIdOf: (docId: string, meetingId: string) => string | undefined;
}

/** The meeting's transcript as the composer reads turns: the name a person
 *  gave each voice, with the engine's label kept beside it so a later rename
 *  still finds the tags this pass writes. */
export function cleanupTurns(
  transcript: readonly { turn: number; text: string; speaker?: string }[],
  names: Record<string, string>,
): NotesTurn[] {
  return transcript.map((t) => ({
    turn: t.turn,
    text: t.text,
    ...(t.speaker
      ? { speaker: speakerDisplayName(t.speaker, names), speakerLabel: t.speaker }
      : {}),
  }));
}

/** The names this meeting's record gave its voices. Empty for a record that
 *  cannot be read — a voice then reads as "Speaker A", which is what it read
 *  as in the notes too. */
function namesOf(
  dataDir: string | undefined,
  docId: string,
  meetingId: string,
): Record<string, string> {
  if (dataDir === undefined) return {};
  try {
    for (const record of listMeetings(dataDir, docId)) {
      if (record.meetingId === meetingId) return record.speakers ?? {};
    }
  } catch {
    // A record that will not read costs the pass its names, never itself.
  }
  return {};
}

const refusal = (reason: NotesCleanupRefusal, line: string): NotesCleanupResult => ({
  ok: false,
  reason,
  proposed: 0,
  refused: 0,
  applied: 0,
  suggested: 0,
  failed: 0,
  touched: 0,
  turns: 0,
  line,
});

/**
 * Run one tidy-up over a finished meeting's notes.
 *
 * The caller has already decided a person asked for this: the route behind it
 * refuses share visitors and refuses a meeting that is still recording, and
 * the button that reaches it is the approval.
 */
export async function runNotesCleanupPass(
  deps: NotesCleanupDeps,
  meeting: { docId: string; meetingId: string },
): Promise<NotesCleanupResult> {
  const { docId, meetingId } = meeting;
  const composer = deps.composer;
  if (!composer) return refusal('no-composer', 'notes cleanup: no composer configured');
  const docStore = deps.docStore();
  const doc = docStore.get(docId);
  if (!doc) return refusal('no-doc', 'notes cleanup: no such doc');
  const headingId = deps.headingIdOf(docId, meetingId);
  if (headingId === undefined) {
    return refusal('no-section', 'notes cleanup: this meeting opened no notes section');
  }

  let transcript: readonly { turn: number; text: string; speaker?: string }[] = [];
  if (deps.dataDir !== undefined) {
    try {
      transcript = readTranscript(deps.dataDir, docId, meetingId);
    } catch {
      transcript = [];
    }
  }
  if (transcript.length === 0) {
    return refusal('no-transcript', 'notes cleanup: this meeting left no transcript');
  }
  const chars = transcript.reduce((n, t) => n + t.text.length, 0);
  if (chars > MAX_CLEANUP_TRANSCRIPT_CHARS) {
    return refusal(
      'transcript-too-long',
      `notes cleanup: transcript is ${chars} chars, past the ${MAX_CLEANUP_TRANSCRIPT_CHARS} a single pass carries`,
    );
  }

  const outline = readNotesOutline(docStore, docId, { recentBlocks: CLEANUP_OUTLINE_BLOCKS });
  const scope = sectionIds(outline, headingId);
  if (scope.blocks.size === 0) {
    return refusal('no-section', 'notes cleanup: the notes section is no longer in the doc');
  }
  const turns = cleanupTurns(transcript, namesOf(deps.dataDir, docId, meetingId));
  const owned = new Set(outline.filter((e) => e.author === NOTES_AUTHOR_ID).map((e) => e.id));
  const attributed = new Set(outline.filter((e) => e.author !== undefined).map((e) => e.id));
  const marksLive = notesMarksLive(doc.ydoc);
  const ours = claimable({ owned, attributed, marksLive });
  // WHAT THE MODEL IS TOLD AND WHAT THE GATE ENFORCES ARE ONE ANSWER. A gate
  // that admits a block the prompt has just called a person's writing changes
  // nothing, because the model does as it is told; the outline's `theirs` is
  // read straight off the mark, so on a doc whose marks are gone it would
  // call every line a person's. `claimed` is the same predicate the gate
  // uses, and `humanNotes` is its complement among the unmarked lines: a line
  // this pass may not claim, either because the marks are live and it is not
  // ours or because it sits outside this meeting's section, where nothing is.
  // Headings are left out of the list — it is about lines, and the outline
  // already says which heading each line sits under.
  const claimed = new Set(
    outline.filter((e) => ours(e.id) && scope.blocks.has(e.id)).map((e) => e.id),
  );
  const humanNotes = outline
    .filter(
      (e) =>
        e.kind !== 'heading' && e.text.length > 0 && e.author === undefined && !claimed.has(e.id),
    )
    .map((e) => e.text);
  const input: NotesComposeInput = {
    docId,
    meetingId,
    tick: { tick: 0, reason: 'end', turns },
    outline,
    notesHeadingId: headingId,
    extraPrompt: CLEANUP_DIRECTIVE,
    transcriptLabel: CLEANUP_TRANSCRIPT_LABEL,
    claimed,
    ...(humanNotes.length > 0 ? { humanNotes } : {}),
    multiSpeaker: turns.some((t) => t.speaker !== undefined),
  };

  let edits: readonly prose.BlockEdit[];
  try {
    edits = await composer.compose(input);
  } catch (err) {
    return refusal(
      'compose-failed',
      `notes cleanup: compose failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Read AFTER the compose, not before: the doc is live, and somebody can
  // leave a comment while the model is thinking.
  const commented = commentedBlockIds(doc.ydoc);
  const { kept, proposeOnly, refused } = confineToSection(edits, {
    ...scope,
    owned,
    attributed,
    marksLive,
    headingId,
    commented,
  });
  // BOTH HALVES OF THE SAME SENTENCE. The blocks the gate called ours have to
  // be marked ours, or every one of them lands as a redline instead of a
  // rewrite; the blocks it admitted only as an OFFER must not be, or the
  // redline somebody is meant to accept or reject becomes a silent rewrite of
  // their line. See `claimForCleanup`.
  claimForCleanup(doc.ydoc, kept, proposeOnly);
  // A store that refuses the whole batch — the doc has gone, or is not prose —
  // reports no counts at all. Reading that as zeros is the honest answer: it
  // changed nothing, which is what the numbers below say.
  const written = kept.length === 0 ? null : applyNotesBlockEdits(docStore, docId, kept);
  const result =
    written !== null && 'applied' in written
      ? { applied: written.applied, suggested: written.suggested, failed: written.failed }
      : { applied: 0, suggested: 0, failed: written === null ? 0 : kept.length };
  const touched = result.applied + result.suggested;
  return {
    ok: true,
    proposed: edits.length,
    refused,
    applied: result.applied,
    suggested: result.suggested,
    failed: result.failed,
    touched,
    turns: turns.length,
    line:
      `notes cleanup ${docId}/${meetingId}: ${turns.length} turns read, ` +
      `${edits.length} edits proposed, ${refused} refused, ${touched} blocks touched` +
      (result.suggested > 0 ? `, ${result.suggested} offered as suggestions` : '') +
      (result.failed > 0 ? `, ${result.failed} failed` : ''),
  };
}
