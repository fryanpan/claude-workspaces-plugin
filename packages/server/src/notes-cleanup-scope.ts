/**
 * What a cleanup pass may address, and whose material it is.
 *
 * SPLIT OUT OF `notes-cleanup-pass.ts` because it answers a different
 * question. That module runs one pass — read the transcript, ask the
 * composer, write what comes back. This one decides, for a block the model
 * has named, whether the pass is allowed to touch it at all: whose words
 * would change, and does a comment point into it. Every export here is pure
 * or reads the doc; none of them composes anything.
 *
 * THE BOUNDARY IS AUTHORSHIP, NOT LOCATION (Bryan, 2026-09-15). Moving and
 * renesting is free anywhere in the document, a person's blocks included;
 * changing the WORDS of somebody's line comes back as a suggestion, and the
 * pass revises its own outright. {@link boundByAuthorship} is that rule and
 * carries the story of what the section test cost.
 *
 * THE RULE THE WHOLE FILE TURNS ON. There are two ownership questions in the
 * write path, not one — `boundByAuthorship` decides which edits are proposed,
 * and `prose.applyBlockEdits` then decides whether each lands as a rewrite or
 * as a redline. They agree here because they are asked the SAME question: does
 * the document record this block as the note-taker's own? Nothing in this file
 * writes a mark to make that answer yes. A block the doc does not record as
 * the pass's own is not the pass's to rewrite, and no amount of reasoning
 * about why the mark is missing changes that — the edit still reaches the
 * write path, which files it as an offer, and the reader answers.
 */

import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { NOTES_AUTHOR_ID } from './notes-doc-access.ts';

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
 * Whose material the pass may REWRITE: what the document records as the
 * note-taker's own, and nothing else.
 *
 * `owned` is the ids carrying the note-taker's `cwAuthor` mark. Every other
 * block in the section — a person's line, another agent's, and a line whose
 * author the document no longer records — is out of reach of a rewrite and
 * within reach of an OFFER, which is `boundByAuthorship`'s job.
 *
 * AN UNRECORDED AUTHOR IS NOT A LICENCE, and this is the half that was got
 * wrong twice. `cwAuthor` records the AGENT that wrote a block; nothing
 * records a person. So a block can be unmarked for four different reasons — a
 * person typed it; a person edited one of the note-taker's and
 * `clearAuthorshipOnPersonEdit` took the mark off; the doc went through a
 * markdown round trip, which has nowhere to put the attribute; or
 * `releaseNotesAuthorship` dropped every mark when the next recording started
 * — and THE DOCUMENT RECORDS NO DIFFERENCE BETWEEN THEM.
 *
 * An earlier version tried to tell them apart by whether any of the
 * note-taker's marks survived elsewhere in the doc: marks alive meant an
 * unmarked block was a person's, marks all gone meant it was nobody's and the
 * pass could bring it into line. The test does not hold in the direction that
 * matters. A person editing the LAST note-taker-marked block on a doc clears
 * that mark themselves, and the doc is then indistinguishable from a reparsed
 * one — so their own fresh edit, and every other line in the section, would
 * flip from protected to rewritable in the instant they typed. Bryan's rule
 * is the other way round (2026-09-10: *"do not rewrite human text. But if you
 * spot an improvement, use the suggest and edit tool to suggest an edit"*), so
 * an unprovable author is a line to offer on, never one to take.
 *
 * What the pass loses on such a doc is the rewrite, not the pass: it still
 * adds what the meeting shows is missing, and every improvement to a line
 * already there reaches the reader as a redline they answer.
 *
 * This asks nothing about comments, and nothing about where a block sits.
 * `boundByAuthorship` asks those separately and every one of them has to say
 * yes.
 */
export function claimable(scope: { owned: Set<string> }): (id: string) => boolean {
  return (id: string): boolean => scope.owned.has(id);
}

/**
 * Which blocks the doc records as THIS meeting's own, as of this read.
 *
 * Called TWICE on purpose — once on the outline the model was shown, to say
 * what the prompt claims, and once after the compose, to say what the gate
 * enforces. It is the same field read the same way, and the whole point is
 * that the two reads can legitimately disagree by the time the model answers.
 *
 * `heldByOthers` IS THE ONE PLACE LOCATION STILL DECIDES ANYTHING, and it is
 * not the old section test in another coat. `NOTES_AUTHOR_ID` is one constant
 * for every meeting, so the mark says "a meeting wrote this" and never WHICH.
 * That was harmless while the gate refused everything outside this meeting's
 * own section; once the boundary became authorship, a second meeting's
 * section on the same doc read as this pass's to rewrite and to delete. A
 * meeting is never recording while a cleanup writes — the pass refuses on
 * `recordingNow` — but one that recorded and stopped AFTER this meeting did
 * leaves its bullets marked and this meeting's released, which is the
 * sequence that bites. So the blocks under somebody else's claimed section
 * are subtracted, and everything else in the document stays reachable.
 */
export function ownership(
  outline: readonly prose.OutlineEntry[],
  heldByOthers?: ReadonlySet<string>,
): { owned: Set<string> } {
  return {
    owned: new Set(
      outline
        .filter((e) => e.author === NOTES_AUTHOR_ID && heldByOthers?.has(e.id) !== true)
        .map((e) => e.id),
    ),
  };
}

/**
 * The blocks inside a section some OTHER meeting has claimed.
 *
 * `mine` is this meeting's own heading, skipped; a claim naming a heading the
 * document no longer holds contributes nothing, because {@link sectionIds}
 * answers the empty set for one it cannot find. No claims — a test driving
 * the pass alone, or a doc no meeting has ever claimed — is the empty set,
 * which reads exactly as this module did before the subtraction existed.
 */
export function heldByOtherMeetings(
  outline: readonly prose.OutlineEntry[],
  claimed: Iterable<string>,
  mine: string | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const headingId of claimed) {
    if (headingId === mine) continue;
    for (const id of sectionIds(outline, headingId).blocks) out.add(id);
  }
  return out;
}

/**
 * Every block the document holds, and every heading in it.
 *
 * WHAT THIS REPLACED, AND WHY. The gate below used to be handed
 * {@link sectionIds} — the meeting's own heading and the blocks under it —
 * so an edit naming anything else was dropped for being "outside the
 * section". That is a LOCATION test, and location is not a thing the
 * note-taker controls: a person moves a bullet, the meeting's notes land
 * under a heading somebody else opened, the doc goes through a markdown round
 * trip, and the section the pass believes it owns stops containing its own
 * work. A tidy-up whose every edit is then refused reports nothing wrong with
 * itself. The boundary that matters is AUTHORSHIP — whose words are being
 * changed — and it is asked per edit below.
 *
 * Headings are kept apart from blocks for the same reason `sectionIds` keeps
 * them apart: an `insert_under_heading` has to name a heading, and answering
 * that question from the block set would let a bullet pass as a destination.
 * `listItems` is the third set for the mirror of that question: a
 * `nest_blocks` moves list items and nothing else, so a paragraph or a table
 * named as one is refused HERE with a reason rather than kept and failed in
 * the write path.
 */
export function docIds(outline: readonly prose.OutlineEntry[]): {
  blocks: Set<string>;
  headings: Set<string>;
  listItems: Set<string>;
} {
  const blocks = new Set<string>();
  const headings = new Set<string>();
  const listItems = new Set<string>();
  for (const entry of outline) {
    blocks.add(entry.id);
    if (entry.kind === 'heading') headings.add(entry.id);
    if (entry.kind === 'listItem') listItems.add(entry.id);
  }
  return { blocks, headings, listItems };
}

/**
 * Sort the model's edits into the ones that reach the document and the ones
 * that are dropped before it.
 *
 * TWO BOUNDARIES, AND NEITHER OF THEM IS LOCATION (Bryan, 2026-09-15).
 *
 * - **Structure is free.** Moving a block, renesting it, reordering it under
 *   a lead — allowed anywhere in the document, including blocks a person
 *   wrote. A move keeps every word, mark, id and authorship attribute of what
 *   it moves (`prose-nest.ts`), so nobody's writing changes; where a bullet
 *   sits is the pass's job to get right.
 * - **Words are not.** A `replace_block` reaches the document whoever owns
 *   the block, and `applyBlockEdits` then decides what it BECOMES from the
 *   block's own `cwAuthor` — the pass's own line is rewritten, anybody
 *   else's comes back as a redline SUGGESTION, byte-identical until they
 *   answer it (Bryan, 2026-09-10: *"do not rewrite human text. But if you
 *   spot an improvement, use the suggest and edit tool to suggest an edit"*).
 *
 * WHAT THE OLD RULE COST. Every edit used to be tested for membership of the
 * meeting's own section first, and on 2026-09-15 a tidy-up over a real
 * meeting proposed sixteen edits and had all sixteen refused, because the
 * meeting's notes had not landed inside the section the pass believed it
 * owned. The pass reported "16 proposed, 16 refused, 0 blocks touched" and
 * nothing about the notes was wrong. Location is not the note-taker's to
 * control; authorship is what the rule was always trying to protect.
 *
 * KEPT IS NOT THE SAME AS REWRITTEN, and this gate deliberately does not
 * decide which. {@link claimable} still answers "is this the pass's own", and
 * it still decides the two ops that cannot be offered — see below — but for a
 * replace it decides nothing here: the write path reads the block's mark and
 * files a rewrite or a redline off that.
 *
 * NOTHING HERE EVER MAKES A BLOCK THE PASS'S OWN, which is what lets the two
 * modules be two halves of one rule rather than two rules that must be kept
 * in step. An earlier version stamped the note-taker's mark on the blocks the
 * gate had decided to rewrite so the write path would agree with it, and had
 * to carry a set of exceptions — the blocks it must NOT stamp — to stop that
 * move turning somebody's redline into a silent rewrite. Both are gone: a
 * cleanup that changes no words now writes no attribute either.
 *
 * WHAT IS STILL REFUSED, AND WHY EACH ONE SURVIVED THE CHANGE:
 *
 * - **A `delete_block` on a line that is not the pass's own.** Striking a
 *   line out proposes nothing a reader can answer — `applyBlockEdits` files a
 *   redline that strikes the whole of it — and a tidy-up that can delete
 *   somebody's note is the one failure the notes cannot come back from.
 * - **The meeting's own section heading, either way.** Replacing it changes
 *   the block id the section is addressed at, and deleting it orphans every
 *   note under it.
 * - **`insert_at_end`.** A cleanup has a section already; writing at the end
 *   of the doc is the one way to grow a second one.
 * - **A commented block, for a replace or a delete.** Rewriting one
 *   re-creates its text, so a thread anchored inside it can only be recovered
 *   onto words that may no longer exist; at the end of a meeting a bullet
 *   somebody is discussing is the last one to reopen. A `nest_blocks` is
 *   explicitly still allowed on one, and now on one the pass does not own: a
 *   move re-creates no text, so the block's own snippet still matches and
 *   `autoReanchorDoc` puts the thread back on it. Measured both halves —
 *   broken by the clone-and-delete, recovered by the sweep — in
 *   `notes-cleanup-anchors.test.ts`.
 *
 * `commented` is the set a thread points into; see {@link commentedBlockIds}.
 */

/** The one reason that is about WHOSE SECTION a block is in rather than whose
 *  words it holds — see `NotesEditScope.heldByOthers`. */
const ELSEWHERE = 'the block is in another meeting’s section on this doc';

/** One dropped edit's reason, in the words the log prints. */
function why(op: prose.BlockEditOp, id: string, rule: string): string {
  return `${op} ${id}: ${rule}`;
}

/**
 * What the gate is asked about, as the caller builds it.
 *
 * `blocks` and `headings` are the WHOLE DOCUMENT's now ({@link docIds}), not
 * a section's. `headingId` is still the meeting's own section heading —
 * kept because it is the one block the pass may not touch, not because it
 * bounds anything.
 */
export interface NotesEditScope {
  blocks: Set<string>;
  /** Which of `blocks` are list items — the only kind a nest may name. */
  listItems: Set<string>;
  /**
   * Blocks and headings inside a section ANOTHER meeting on this doc claimed
   * ({@link heldByOtherMeetings}). Out of this pass's reach entirely — not
   * merely unowned.
   *
   * IT HAS TO BE THE GATE, because the write path cannot tell two meetings
   * apart: `applyBlockEdits` reads the block's own `cwAuthor`, every meeting
   * writes the same `NOTES_AUTHOR_ID`, so a `replace_block` naming the other
   * meeting's bullet lands as a direct rewrite of it however this module has
   * answered "is it ours". Withholding it from `owned` alone was measured
   * doing exactly that. Absent is the empty set — a doc with one meeting.
   */
  heldByOthers?: Set<string>;
  headings: Set<string>;
  owned: Set<string>;
  headingId: string;
  commented?: Set<string>;
}

export function boundByAuthorship(
  edits: readonly prose.BlockEdit[],
  scope: NotesEditScope,
): { kept: prose.BlockEdit[]; refused: number; reasons: string[] } {
  const kept: prose.BlockEdit[] = [];
  const reasons: string[] = [];
  const ours = claimable(scope);
  // In the document at all, not the section heading itself, and not inside
  // another meeting's section — see `NotesEditScope.heldByOthers`.
  const addressable = (id: string): boolean =>
    scope.blocks.has(id) && id !== scope.headingId && scope.heldByOthers?.has(id) !== true;
  const mine = (id: string): boolean => addressable(id) && ours(id);
  const uncommented = (id: string): boolean => scope.commented?.has(id) !== true;
  // A better wording reaches the document whoever the line belongs to —
  // ownership decides whether it lands as a rewrite or as a redline, and that
  // is `applyBlockEdits`' call rather than this one.
  const worthSaying = (id: string): boolean => addressable(id) && uncommented(id);
  // Striking a line out is only ever the pass's own to propose.
  const rewritable = (id: string): boolean => mine(id) && uncommented(id);
  /**
   * What a `nest_blocks` may name: a LIST ITEM of this document that is not
   * the meeting's own section heading.
   *
   * THE LIST-ITEM CLAUSE IS NOT TIDINESS. `nestBlocksUnderLead` moves list
   * items and nothing else — anything else named as the lead comes back
   * `not-a-list-item`, and named as a member it is stepped over — so a gate
   * that asked only "is it in the document" kept an edit the write path could
   * never make, and the pass reported it FAILED rather than refused, with no
   * reason a reader could act on. A heading is the case the model reaches for
   * most (it is the topic it is thinking about), a paragraph note of its own
   * the next most. Refusing them here is the difference between a log that
   * says what the model got wrong and one that says only that something did.
   */
  const nestable = (id: string): boolean => addressable(id) && scope.listItems.has(id);
  /** Why a block is out of reach, asked in the order the rules are asked. */
  const blockRule = (id: string): string =>
    !scope.blocks.has(id)
      ? 'the block is not in the document'
      : scope.heldByOthers?.has(id) === true
        ? ELSEWHERE
        : id === scope.headingId
          ? "the block is the meeting's own section heading"
          : scope.commented?.has(id) === true
            ? 'somebody has commented on the block'
            : 'the document does not record the block as the note-taker’s own';
  /**
   * The same question for a nest, which asks neither ownership nor comments —
   * so answering it from `blockRule` named a comment, or a missing mark, as
   * the reason a move was dropped when neither was ever consulted. That is
   * misleading exactly where somebody is reading the log to find out why.
   */
  const nestRule = (id: string): string =>
    !scope.blocks.has(id)
      ? 'the block is not in the document'
      : scope.heldByOthers?.has(id) === true
        ? ELSEWHERE
        : id === scope.headingId
          ? "the block is the meeting's own section heading"
          : scope.headings.has(id)
            ? 'the block is a heading, and a heading is not moved under a bullet'
            : 'the block is not a bullet, and only bullets are moved under a bullet';
  for (const edit of edits) {
    switch (edit.op) {
      case 'insert_under_heading':
        if (scope.headings.has(edit.headingId) && scope.heldByOthers?.has(edit.headingId) !== true)
          kept.push(edit);
        else
          reasons.push(
            why(
              edit.op,
              edit.headingId,
              scope.heldByOthers?.has(edit.headingId) === true
                ? ELSEWHERE
                : scope.blocks.has(edit.headingId)
                  ? 'the block named is not a heading'
                  : 'the heading is not in the document',
            ),
          );
        break;
      case 'replace_block':
        if (worthSaying(edit.blockId)) kept.push(edit);
        else reasons.push(why(edit.op, edit.blockId, blockRule(edit.blockId)));
        break;
      case 'delete_block':
        if (rewritable(edit.blockId)) kept.push(edit);
        else reasons.push(why(edit.op, edit.blockId, blockRule(edit.blockId)));
        break;
      // STRUCTURE IS FREE. A nest moves blocks and rewrites none of them, so
      // it asks only that every id it names is a list block of this document
      // — see {@link nestable} for why a heading is not one. Ownership is not
      // asked, and neither is a comment: the move keeps the block's words, so
      // the snippet sweep re-anchors the thread onto them (see the header).
      case 'nest_blocks':
        if (nestable(edit.leadBlockId) && edit.blockIds.every(nestable)) kept.push(edit);
        else {
          const bad =
            [edit.leadBlockId, ...edit.blockIds].find((id) => !nestable(id)) ?? edit.leadBlockId;
          reasons.push(why(edit.op, bad, nestRule(bad)));
        }
        break;
      // A cleanup has a section already; writing at the end of the doc is the
      // one way to grow a second one.
      case 'insert_at_end':
        reasons.push(
          why(edit.op, 'the end of the doc', 'a cleanup may not open a second notes section'),
        );
        break;
    }
  }
  return { kept, refused: edits.length - kept.length, reasons };
}
