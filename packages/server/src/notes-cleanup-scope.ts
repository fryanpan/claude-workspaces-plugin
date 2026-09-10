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
 * THE ORDERING RULE THE WHOLE FILE TURNS ON. There are two ownership rules in
 * the write path, not one — `confineToSection` decides which edits are
 * proposed, and `prose.applyBlockEdits` then decides whether each lands as a
 * rewrite or as a redline. Making them agree is `claimForCleanup`; keeping
 * them deliberately APART, on the blocks this pass may only ask about, is
 * `proposeOnly`. A change to either that forgets the other produces a gate
 * that looks loosened and behaves exactly as it did — or, in the other
 * direction, a suggestion on somebody's line that quietly becomes a rewrite
 * of it.
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
 * Does this doc still carry the note-taker's own marks anywhere in it?
 *
 * The answer decides what an UNMARKED block means, and the two meanings are
 * opposites. `cwAuthor` records the AGENT that wrote a block; nothing records
 * a person. A person's own line is unmarked because they typed it, and
 * `clearAuthorshipOnPersonEdit` unmarks one of the note-taker's the instant a
 * person touches it. So on a doc whose marks are intact, "unmarked" IS the
 * doc's record that a person wrote or edited the line, and criterion 2.3 —
 * respect notes written by humans — puts it out of reach.
 *
 * The two ways the marks go away are both WHOLESALE and neither says anything
 * about a person: a markdown round trip has nowhere to put the attribute (a
 * reparse from disk), and `releaseNotesAuthorship` drops every one of them
 * when the next recording starts. A doc in that state records nothing about
 * anybody, so an unmarked block there is UNKNOWN, not a person's. The gate
 * this replaced read the two states identically and so could not change a
 * single word on such a doc — while still being free to append new bullets
 * under the heading, because an insert names a heading and no owner. Able to
 * add to a document it could not tidy was the worst of both.
 *
 * Read from the ydoc rather than from the outline, because the outline is
 * capped at `CLEANUP_OUTLINE_BLOCKS` entries and a mark older than the cap
 * would read as no mark at all. That is the direction that LOOSENS the gate,
 * so it is the one this must not get wrong.
 *
 * Never throws, and a doc that will not walk answers `true`: claiming nothing
 * costs the pass a tidy-up, claiming everything costs somebody their notes.
 */
export function notesMarksLive(ydoc: Y.Doc): boolean {
  try {
    return prose.blocksAuthoredBy(ydoc, NOTES_AUTHOR_ID).length > 0;
  } catch {
    return true;
  }
}

/**
 * Whose material the pass may bring into line: one predicate, two modes.
 *
 * `owned` is the ids marked as the note-taker's. `attributed` is the ids
 * marked as ANYONE's, the note-taker included. `marksLive` is
 * {@link notesMarksLive} for the whole doc.
 *
 * - **The marks live** — take what is marked ours, and nothing else. An
 *   unmarked block is a person's, per the reasoning above.
 * - **The marks are gone** — take what is marked as nobody's. Another agent's
 *   mark outlives the note-taker's, because a release names one author; a
 *   block that agent is still maintaining is not this pass's to rewrite
 *   either.
 *
 * Neither mode asks about the SECTION or about comments. `confineToSection`
 * asks those separately and every one of them has to say yes.
 */
export function claimable(scope: {
  owned: Set<string>;
  attributed: Set<string>;
  marksLive: boolean;
}): (id: string) => boolean {
  return scope.marksLive
    ? (id: string): boolean => scope.owned.has(id)
    : (id: string): boolean => !scope.attributed.has(id);
}

/**
 * Stamp the note-taker's mark on the blocks the gate has just decided are
 * its own, so the write path agrees with the gate.
 *
 * THERE ARE TWO OWNERSHIP RULES, NOT ONE, and loosening the first alone
 * achieves nothing. `confineToSection` decides which edits are proposed;
 * `prose.applyBlockEdits` then compares each target's `cwAuthor` against the
 * writing agent and turns an unmatched one into a SUGGESTION rather than a
 * rewrite. So on a doc whose marks are gone, a gate that admits the edit
 * still lands a redline on every line — which is the outcome Bryan ruled out
 * twice over: "Bring into line" is the option he picked, and "Show me first"
 * is the one he did not.
 *
 * Claiming is the honest way to say it. The pass has decided this block is
 * its material; recording that decision in the doc is more information than
 * the doc had a moment ago, not less, and it is reversible by the ordinary
 * mechanism — `clearAuthorshipOnPersonEdit` hands the block straight back
 * the first time a person types in it.
 *
 * ONLY THE BLOCKS AN ADMITTED EDIT NAMES, and never a whole section: a pass
 * that stamped everything it MIGHT touch would write to the doc on a run
 * that changed nothing, and a run that changes nothing has to leave the doc
 * alone (criterion 2.4).
 *
 * AND NEVER A BLOCK THE GATE ADMITTED AS AN OFFER. `proposeOnly` is
 * `confineToSection`'s set of blocks this pass may propose on but may not
 * rewrite — somebody else's writing. Claiming one would hand it to
 * `applyBlockEdits` as the pass's own and turn the redline it is supposed to
 * file into a silent rewrite of their line, which is the exact failure this
 * whole file exists to prevent. Passing the set is therefore not optional in
 * any caller that admits an offer; the default is empty so the two callers
 * that admit none do not have to say so.
 *
 * Returns the ids it claimed, so the caller can hand back the ones whose
 * edit then failed — see {@link releaseClaims}.
 */
export function claimForCleanup(
  ydoc: Y.Doc,
  edits: readonly prose.BlockEdit[],
  proposeOnly: ReadonlySet<string> = new Set<string>(),
): string[] {
  const wanted = new Set<string>();
  for (const edit of edits) {
    if (edit.op === 'replace_block' || edit.op === 'delete_block') wanted.add(edit.blockId);
    else if (edit.op === 'nest_blocks') {
      wanted.add(edit.leadBlockId);
      for (const id of edit.blockIds) wanted.add(id);
    }
  }
  for (const id of proposeOnly) wanted.delete(id);
  if (wanted.size === 0) return [];
  const fragment = prose.getProseFragment(ydoc);
  const unmarked = [...wanted]
    .map((id) => ({ id, el: prose.findBlockById(fragment, id) }))
    .filter(
      (b): b is { id: string; el: Y.XmlElement } =>
        b.el !== undefined && prose.readBlockAuthor(b.el) === undefined,
    );
  if (unmarked.length === 0) return [];
  ydoc.transact(() => {
    for (const b of unmarked) prose.setBlockAuthor(b.el, NOTES_AUTHOR_ID);
  }, 'agent');
  return unmarked.map((b) => b.id);
}

/**
 * Hand back a claim this pass made and then did not use.
 *
 * A CLAIM IS A WRITE TO THE DOCUMENT, so a claim on a block whose edit went
 * on to FAIL is a write on a run that changed nothing — the thing criterion
 * 2.4 rules out. Worse, the mark outlives the run: the block now reads as the
 * note-taker's own, so the NEXT cleanup would rewrite in silence a line this
 * one was only ever allowed to propose on. Claiming has to be undone when the
 * edit it was for did not land.
 *
 * Only a mark this pass could have written is removed — a block carrying
 * somebody else's id is left exactly as it is, because the claim that failed
 * was never made on it. Returns how many it handed back.
 */
export function releaseClaims(ydoc: Y.Doc, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const fragment = prose.getProseFragment(ydoc);
  const held = ids
    .map((id) => prose.findBlockById(fragment, id))
    .filter(
      (el): el is Y.XmlElement => el !== undefined && prose.readBlockAuthor(el) === NOTES_AUTHOR_ID,
    );
  if (held.length === 0) return 0;
  ydoc.transact(() => {
    for (const el of held) el.removeAttribute(prose.BLOCK_AUTHOR_ATTR);
  }, 'agent');
  return held.length;
}

/**
 * Sort the model's edits into the ones this pass may make, the ones it may
 * only OFFER, and the ones it may not raise at all.
 *
 * Whether a block is the pass's to rewrite is {@link claimable}, which is not
 * the same question as "does the note-taker still own it" — see the reasoning
 * on {@link notesMarksLive}. A block that is somebody else's is not out of
 * the conversation, though: a `replace_block` naming one is KEPT and its id
 * returned in `proposeOnly`, which is how it reaches `applyBlockEdits` as a
 * redline suggestion on their own words rather than as a rewrite of them
 * (Bryan, 2026-09-10: *"the rule was do not rewrite human text. But if you
 * spot an improvement, use the suggest and edit tool to suggest an edit"*).
 * Their text is byte-identical until they accept.
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
    attributed: Set<string>;
    marksLive: boolean;
    headingId: string;
    commented?: Set<string>;
  },
): { kept: prose.BlockEdit[]; proposeOnly: Set<string>; refused: number } {
  const kept: prose.BlockEdit[] = [];
  const proposeOnly = new Set<string>();
  const ours = claimable(scope);
  // Inside this meeting's own notes, and not the section heading itself —
  // deleting that orphans every note under it, and rewriting it moves the
  // address the notes are found at.
  const inSection = (id: string): boolean => scope.blocks.has(id) && id !== scope.headingId;
  const mine = (id: string): boolean => inSection(id) && ours(id);
  const rewritable = (id: string): boolean => mine(id) && !scope.commented?.has(id);
  // Somebody else's, and still inside the notes this pass is tidying: a
  // rewrite is out of the question and an offer is not.
  const offerable = (id: string): boolean =>
    inSection(id) && !ours(id) && !scope.commented?.has(id);
  for (const edit of edits) {
    switch (edit.op) {
      case 'insert_under_heading':
        if (scope.headings.has(edit.headingId)) kept.push(edit);
        break;
      case 'replace_block':
        if (rewritable(edit.blockId)) kept.push(edit);
        else if (offerable(edit.blockId)) {
          kept.push(edit);
          proposeOnly.add(edit.blockId);
        }
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
  return { kept, proposeOnly, refused: edits.length - kept.length };
}
