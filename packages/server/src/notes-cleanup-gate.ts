/**
 * Everything between a cleanup's compose and its write, in the one order that
 * is safe.
 *
 * SPLIT OUT OF `notes-cleanup-pass.ts` because it is not one rule but the
 * composition of two, and the composition is the part that was wrong.
 * `boundByAuthorship` (`notes-cleanup-scope.ts`) answers "may this pass touch
 * that block"; `dedupeNotesEdits` (`notes-edit-dedupe.ts`) answers "is this
 * note already in the section". Each is right on its own. Running them in the
 * wrong order is what let a refused edit change the document.
 *
 * WHY THE GATE RUNS TWICE, WHICH IS THE WHOLE POINT OF THIS MODULE.
 *
 * The dedupe REWRITES a batch: a note the section already carries under a
 * different topic is read as the note-taker moving its own bullet, so the
 * dedupe emits a `delete_block` on the earlier copy beside the insert that
 * replaces it. Those two only make sense together.
 *
 * Handed the model's answer directly, it will do that for an insert aimed
 * ANYWHERE — `insert_under_heading` naming a block that is not a heading at
 * all is still a destination as far as the dedupe is concerned. The gate then
 * refuses the insert, for exactly the reason it exists, and keeps the delete,
 * because the delete names the pass's own uncommented bullet and there is
 * nothing wrong with it in isolation. The note
 * is gone and nothing has replaced it. Measured 2026-09-15 on a one-note
 * section: one copy before, none after, the log reading "1 refused, 1 blocks
 * touched".
 *
 * So the model's own edits are gated FIRST, and the dedupe only ever sees
 * destinations this pass is allowed to write to; the batch it returns is
 * gated again, because the edits it invents are edits like any other and the
 * gate stays the last word before the store. A refused edit cannot produce an
 * authorised side effect, which is the invariant this file exists to hold.
 *
 * `refused` is the two passes added together and `reasons` their lines in
 * order, so the log still accounts for every edit the model proposed.
 */

import type { prose } from '@claude-workspaces/core';
import { type NotesEditScope, boundByAuthorship } from './notes-cleanup-scope.ts';
import { dedupeNotesEdits } from './notes-edit-dedupe.ts';

/** Which blocks this pass may touch: `boundByAuthorship`'s scope. */
export type CleanupScope = NotesEditScope;

/** What the dedupe needs beyond the scope: the doc as it stands, the words
 *  the pass composed from, and whose notes may be moved. */
export interface CleanupDedupeInput {
  /** THE WHOLE DOC, never the windowed outline the model was shown — a note
   *  the window dropped is one this check exists to find. */
  outline: readonly prose.OutlineEntry[];
  speech: readonly string[];
  authorId: string;
  commented?: () => ReadonlySet<string>;
}

export interface CleanupWriteSet {
  /** The edits that reach the store, in the order they were proposed. */
  kept: prose.BlockEdit[];
  /** Edits the gate dropped, across both passes. */
  refused: number;
  /** One line per dropped edit, naming the op, the block and the rule. */
  reasons: string[];
  /** Notes the section already carried, dropped by the dedupe. Counted apart
   *  from `refused`: a block the pass may not touch and a note already
   *  written are different answers to different questions. */
  alreadyWritten: number;
}

/** Gate, dedupe, gate again — see the header for why the order is the fix. */
export function cleanupWriteSet(
  edits: readonly prose.BlockEdit[],
  scope: CleanupScope,
  dedupe: CleanupDedupeInput,
): CleanupWriteSet {
  const addressed = boundByAuthorship(edits, scope);
  const deduped = dedupeNotesEdits(addressed.kept, {
    notesHeadingId: scope.headingId,
    // The pass's own notes wherever they landed, not only the ones the
    // section reaches — see `NotesDedupeContext.ownedElsewhere`. Without it a
    // gate bounded by authorship would admit an insert restating a note the
    // doc already carries under another heading.
    ownedElsewhere: scope.owned,
    ...dedupe,
  });
  const written = boundByAuthorship(deduped.edits, scope);
  return {
    kept: written.kept,
    refused: addressed.refused + written.refused,
    reasons: [...addressed.reasons, ...written.reasons],
    alreadyWritten: deduped.alreadyWritten,
  };
}
