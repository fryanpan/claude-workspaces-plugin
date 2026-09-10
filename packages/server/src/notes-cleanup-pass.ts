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
 * FOUR THINGS IT REFUSES STRUCTURALLY, so no wording of a prompt can undo
 * them (`confineToSection`):
 *
 * - **A person's line is never addressed.** An edit naming a block the
 *   note-taker does not still own is DROPPED, not turned into a redline. The
 *   live path's answer — a suggestion on their words — is right for a meeting
 *   in progress, where the note-taker is writing beside them. It is wrong
 *   here: nobody asked for their own writing to be marked up, and a tidy-up
 *   that leaves twelve redlines on somebody's paragraph is the disruption the
 *   feature exists to avoid.
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
import * as Y from 'yjs';
import type { NotesComposeInput, NotesComposer, NotesTurn } from './meeting-notes.ts';
import { listMeetings, readTranscript } from './meetings.ts';
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
  '- Lines marked "theirs" were written by a PERSON. Never rewrite, delete,',
  '  move or nest one — work around them, and do not repeat what they say.',
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
  /** Edits `confineToSection` dropped — outside the section, or aimed at a
   *  person's line. */
  refused: number;
  applied: number;
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

/**
 * The ids inside one meeting's notes section: the heading itself, then every
 * block after it until a heading at that level or above.
 *
 * Returned as two sets because the gate asks two different questions of them
 * — "may an edit name this block?" and "is this a heading a bullet may be
 * inserted under?" — and answering the second by re-walking would let a
 * heading BELOW the section pass as one inside it.
 */
export function sectionIds(
  outline: readonly prose.OutlineEntry[],
  headingId: string,
): { blocks: Set<string>; headings: Set<string> } {
  const blocks = new Set<string>();
  const headings = new Set<string>();
  const start = outline.findIndex((e) => e.id === headingId);
  if (start < 0) return { blocks, headings };
  const openLevel = outline[start]?.level ?? 2;
  for (let i = start; i < outline.length; i++) {
    const entry = outline[i];
    if (entry === undefined) continue;
    if (i > start && entry.kind === 'heading' && (entry.level ?? 1) <= openLevel) break;
    blocks.add(entry.id);
    if (entry.kind === 'heading') headings.add(entry.id);
  }
  return { blocks, headings };
}

/**
 * Which blocks somebody has left a comment on.
 *
 * A `replace_block` swaps the block's `Y.XmlText` for a new one, so every
 * relative position inside it stops resolving — and a comment thread whose
 * anchor stops resolving is a comment the reader has to be re-shown and
 * re-placed, on words that may no longer exist. The auto-reanchor sweep
 * recovers some of them by snippet, and a recovery is not the same as never
 * having moved.
 *
 * During a meeting that risk is worth taking: the note-taker is writing beside
 * the reader and a bullet a minute old has usually been read by nobody. At the
 * END of a meeting it is not. So a commented block is out of this pass's
 * reach, and the pass ADDS beside it instead. `nest_blocks` is deliberately
 * still allowed on one: nesting moves the block without re-creating its text,
 * which `notes-grouping.test.ts` proves keeps an anchor pointing at its own
 * words.
 *
 * Never throws: a doc whose threads map will not read reports no comments,
 * which is the same answer as a doc with none and costs only restraint.
 */
export function commentedBlockIds(ydoc: Y.Doc): Set<string> {
  const out = new Set<string>();
  try {
    const threads = ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    if (threads.size === 0) return out;
    const walk = prose.walkProse(prose.getProseFragment(ydoc));
    const blockOf = new Map<unknown, string>();
    for (const seg of walk.segments) {
      // Climb from the text to the NEAREST ancestor carrying a block id. A
      // bullet's words sit in a paragraph inside a list item inside a list,
      // and only one of those three is the block an edit addresses — the
      // innermost that has an id, which `seg.block` and `seg.topBlock` between
      // them can miss in either direction.
      let node: Y.XmlText | Y.XmlElement | Y.XmlFragment | null = seg.node;
      while (node) {
        const id = node instanceof Y.XmlElement ? prose.readBlockId(node) : undefined;
        if (id !== undefined) {
          blockOf.set(seg.node, id);
          break;
        }
        node = node.parent as Y.XmlElement | Y.XmlFragment | null;
      }
    }
    threads.forEach((thread) => {
      const anchor = thread.get('anchor') as { kind?: string; startRel?: Uint8Array } | undefined;
      if (anchor?.kind !== 'text-range' || !anchor.startRel) return;
      const abs = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(anchor.startRel),
        ydoc,
      );
      const id = abs ? blockOf.get(abs.type) : undefined;
      if (id !== undefined) out.add(id);
    });
  } catch {
    return out;
  }
  return out;
}

/**
 * Keep only the edits a cleanup is allowed to make.
 *
 * `owned` is the set of block ids still marked as the note-taker's own. An
 * edit naming anything else is DROPPED rather than proposed — see the header
 * for why a redline on a person's line is the wrong answer here. `commented`
 * is the set a thread points into; see `commentedBlockIds`.
 */
export function confineToSection(
  edits: readonly prose.BlockEdit[],
  scope: {
    blocks: Set<string>;
    headings: Set<string>;
    owned: Set<string>;
    headingId: string;
    commented?: Set<string>;
  },
): { kept: prose.BlockEdit[]; refused: number } {
  const kept: prose.BlockEdit[] = [];
  // Ours to rewrite: inside the section, still the note-taker's, and not the
  // section heading itself — deleting that orphans every note under it.
  const mine = (id: string): boolean =>
    scope.blocks.has(id) && scope.owned.has(id) && id !== scope.headingId;
  const rewritable = (id: string): boolean => mine(id) && !scope.commented?.has(id);
  for (const edit of edits) {
    switch (edit.op) {
      case 'insert_under_heading':
        if (scope.headings.has(edit.headingId)) kept.push(edit);
        break;
      case 'replace_block':
      case 'delete_block':
        if (rewritable(edit.blockId)) kept.push(edit);
        break;
      // Nesting keeps every block's own text, so a comment inside one rides
      // along — which is why this asks `mine` and not `rewritable`.
      case 'nest_blocks':
        if (mine(edit.leadBlockId) && edit.blockIds.every(mine)) kept.push(edit);
        break;
      // A cleanup has a section already; writing at the end of the doc is the
      // one way to grow a second one.
      case 'insert_at_end':
        break;
    }
  }
  return { kept, refused: edits.length - kept.length };
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
  const input: NotesComposeInput = {
    docId,
    meetingId,
    tick: { tick: 0, reason: 'end', turns },
    outline,
    notesHeadingId: headingId,
    extraPrompt: CLEANUP_DIRECTIVE,
    transcriptLabel: CLEANUP_TRANSCRIPT_LABEL,
    humanNotes: outline.filter((e) => e.author === undefined).map((e) => e.text),
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

  const owned = new Set(outline.filter((e) => e.author === NOTES_AUTHOR_ID).map((e) => e.id));
  // Read AFTER the compose, not before: the doc is live, and somebody can
  // leave a comment while the model is thinking.
  const commented = commentedBlockIds(doc.ydoc);
  const { kept, refused } = confineToSection(edits, { ...scope, owned, headingId, commented });
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
      (result.failed > 0 ? `, ${result.failed} failed` : ''),
  };
}
