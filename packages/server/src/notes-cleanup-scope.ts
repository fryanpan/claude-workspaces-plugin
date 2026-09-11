/**
 * What a cleanup pass may address, and whose material it is.
 *
 * SPLIT OUT OF `notes-cleanup-pass.ts` because it answers a different
 * question. That module runs one pass — read the transcript, ask the
 * composer, write what comes back. This one decides, for a block the model
 * has named, whether the pass is allowed to touch it at all: is it inside
 * this meeting's section, is it somebody's, does a comment point into it.
 * Every export here is pure or reads the doc; none of them composes anything.
 *
 * THE RULE THE WHOLE FILE TURNS ON. There are two ownership questions in the
 * write path, not one — `confineToSection` decides which edits are proposed,
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
 * within reach of an OFFER, which is `confineToSection`'s job.
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
 * This asks nothing about the SECTION or about comments. `confineToSection`
 * asks those separately and every one of them has to say yes.
 */
export function claimable(scope: { owned: Set<string> }): (id: string) => boolean {
  return (id: string): boolean => scope.owned.has(id);
}

/**
 * Sort the model's edits into the ones that reach the document and the ones
 * that are dropped before it.
 *
 * KEPT IS NOT THE SAME AS REWRITTEN, and this gate deliberately does not
 * decide which. A `replace_block` naming a block inside the section is kept
 * whether or not {@link claimable} calls it the pass's own; what happens to it
 * then is `applyBlockEdits`' answer, read off the block's own `cwAuthor` — the
 * pass's own block is rewritten, and anybody else's becomes a redline
 * SUGGESTION on their words, byte-identical until they accept it (Bryan,
 * 2026-09-10: *"the rule was do not rewrite human text. But if you spot an
 * improvement, use the suggest and edit tool to suggest an edit"*).
 *
 * NOTHING HERE EVER MAKES A BLOCK THE PASS'S OWN, which is what lets the two
 * modules be two halves of one rule rather than two rules that must be kept
 * in step. An earlier version stamped the note-taker's mark on the blocks the
 * gate had decided to rewrite so the write path would agree with it, and had
 * to carry a set of exceptions — the blocks it must NOT stamp — to stop that
 * move turning somebody's redline into a silent rewrite. The stamping existed
 * only for the marks-gone rewrite mode {@link claimable} no longer has, and
 * both it and its exception list are gone: a cleanup that changes no words now
 * writes no attribute either.
 *
 * ONLY A REPLACE IS OFFERED THAT WAY. A `delete_block` on somebody's line
 * proposes striking the whole of it and a `nest_blocks` proposes moving it
 * under something else; neither is an improvement to their writing, and
 * `applyBlockEdits` cannot express the second as a suggestion at all. Both
 * are dropped, which is also what the prompt asks for.
 *
 * `commented` is the set a thread points into; see `commentedBlockIds`. A
 * commented block is out of reach BOTH ways — the pass adds beside it — which
 * is a stricter rule than the anchor argument alone requires (a suggestion
 * re-creates no text), and it is deliberate: at the end of a meeting a bullet
 * somebody is already discussing is the last one to reopen.
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
  const ours = claimable(scope);
  // Inside this meeting's own notes, and not the section heading itself —
  // deleting that orphans every note under it, and rewriting it moves the
  // address the notes are found at.
  const inSection = (id: string): boolean => scope.blocks.has(id) && id !== scope.headingId;
  const mine = (id: string): boolean => inSection(id) && ours(id);
  const uncommented = (id: string): boolean => scope.commented?.has(id) !== true;
  // A better wording reaches the document whoever the line belongs to —
  // ownership decides whether it lands as a rewrite or as a redline, and that
  // is `applyBlockEdits`' call rather than this one.
  const worthSaying = (id: string): boolean => inSection(id) && uncommented(id);
  // Striking a line out is only ever the pass's own to propose.
  const rewritable = (id: string): boolean => mine(id) && uncommented(id);
  for (const edit of edits) {
    switch (edit.op) {
      case 'insert_under_heading':
        if (scope.headings.has(edit.headingId)) kept.push(edit);
        break;
      case 'replace_block':
        if (worthSaying(edit.blockId)) kept.push(edit);
        break;
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
