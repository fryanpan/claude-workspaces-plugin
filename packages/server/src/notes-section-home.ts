/**
 * A MEETING'S NOTES GO UNDER THE MEETING'S OWN HEADING, wherever in the doc
 * that heading happens to sit.
 *
 * WHAT WENT WRONG. A tick is handed the whole doc as a table of block ids —
 * every heading in it, whoever wrote them — and it answers with edits
 * addressed to those ids. Nothing between the model and the document asked
 * whether the id it named was inside this meeting's section. On a doc whose
 * notes heading is NOT the last heading — a page with a `## Meeting notes`
 * near the top and an agenda below it, which is how a person prepares for a
 * meeting — both of the model's two ways of adding a note write outside it:
 *
 * - `insert_at_end` appends to the END OF THE DOCUMENT, which is under the
 *   agenda, not under the notes heading. The prompt itself names this op for
 *   the first notes of a meeting, so it is not a model mistake.
 * - `insert_under_heading` naming one of the agenda's headings lands there.
 *   The agenda headings genuinely are the topics being discussed, so "put a
 *   note under the heading of its topic" points straight at them.
 *
 * Measured on a real 41-minute meeting: 192 bullets, none of them under the
 * meeting's own heading, which held nothing at the end. Reproduced here in
 * both shapes — see `notes-section-home.test.ts` and the harness test in
 * `notes-own-heading.test.ts`, which drives the real write path.
 *
 * AND THE DAMAGE IS NOT ONLY WHERE THE WORDS SIT. Everything downstream is
 * scoped to the section: `notes-regroup.ts` reads it to decide whether a
 * topic has become a wall, `notes-section-tidy.ts` tidies it, the per-meeting
 * quality line counts it, and the end-of-meeting cleanup pass refuses every
 * edit naming a block outside it (`confineToSection`). A meeting writing
 * outside its section therefore gets no regroup directives, no tidy and no
 * cleanup — which is exactly the run above: zero topic headings asked for,
 * and all sixteen cleanup edits refused.
 *
 * RE-ADDRESSED, NEVER REFUSED. The cleanup pass may drop an out-of-section
 * edit because it is one read of finished notes and the words are already in
 * the doc. A live tick is the only copy of what was just said: refusing it
 * loses the note. So an insert that would land outside the section is
 * rewritten to land under the section heading instead — the same trade
 * `notes-edit-address.ts` makes for an edit the applier rejected, and for the
 * same reason. A note under the section instead of under its topic is in the
 * wrong place; a note nobody has is gone.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE:
 *
 * - **A meeting with no section yet.** `notesHeadingId` undefined means the
 *   section-opening write itself, which is an `insert_at_end` and has to
 *   stay one. Nothing is re-addressed on that path.
 * - **A heading id that is in NO outline entry.** That is an address the
 *   applier will fail as `unknown-block`, and `repairNotesEditAddresses`
 *   already re-homes it after the fact using the id the write itself
 *   learned. Handling it here as well would re-home it against a heading
 *   memory read BEFORE the write, which is stale on the tick that opens the
 *   section.
 * - **`replace_block`, `delete_block` and `nest_blocks`.** A replace naming
 *   somebody's line is how the note-taker corrects an error, and the write
 *   path turns it into a suggestion on their words; re-addressing it would
 *   turn a correction into a duplicate note. This module moves notes that
 *   are being ADDED, and nothing else.
 *
 * Pure: edits and an outline in, edits out. Nothing here reads a doc or
 * writes one.
 */

import type { prose } from '@claude-workspaces/core';
import { sectionIds } from './notes-cleanup-scope.ts';

export interface NotesSectionHomeResult {
  /** The batch to apply, in its original order and length. */
  edits: prose.BlockEdit[];
  /** One line per re-addressed edit, naming where it would have landed. The
   *  log's only evidence that a tick was aiming outside its section, and
   *  empty on the ordinary batch. */
  rehomed: string[];
}

export interface NotesSectionHomeContext {
  /** This meeting's own notes heading. Undefined for a meeting that has not
   *  opened one — nothing is re-addressed then. */
  notesHeadingId: string | undefined;
  /** The doc as this write reads it. */
  outline: readonly prose.OutlineEntry[];
}

/** The ops that ADD words and so have a landing place to be wrong about. */
function isInsert(
  edit: prose.BlockEdit,
): edit is Extract<prose.BlockEdit, { op: 'insert_at_end' | 'insert_under_heading' }> {
  return edit.op === 'insert_at_end' || edit.op === 'insert_under_heading';
}

/**
 * The batch with every added note aimed inside this meeting's own section.
 *
 * `outline` is the doc the write is about to touch, so the section's extent
 * is read from the blocks that are actually there rather than from anything
 * remembered.
 */
export function homeNotesEdits(
  edits: readonly prose.BlockEdit[],
  ctx: NotesSectionHomeContext,
): NotesSectionHomeResult {
  const headingId = ctx.notesHeadingId;
  if (headingId === undefined) return { edits: [...edits], rehomed: [] };
  const { headings } = sectionIds(ctx.outline, headingId);
  // A section heading the outline does not carry is a memory this write
  // cannot check. Re-homing against it would address a block that is gone.
  if (headings.size === 0) return { edits: [...edits], rehomed: [] };
  const out: prose.BlockEdit[] = [];
  const rehomed: string[] = [];
  for (const edit of edits) {
    if (!isInsert(edit)) {
      out.push(edit);
      continue;
    }
    if (edit.op === 'insert_under_heading') {
      if (headings.has(edit.headingId)) {
        out.push(edit);
        continue;
      }
      // An address no block answers to is the applier's to fail and the
      // address repair's to recover — see the header.
      if (!ctx.outline.some((e) => e.id === edit.headingId)) {
        out.push(edit);
        continue;
      }
      out.push({ op: 'insert_under_heading', headingId, markdown: edit.markdown });
      rehomed.push(
        `a note addressed to ${edit.headingId}, outside this meeting's notes, ` +
          'was written under the section instead',
      );
      continue;
    }
    out.push({ op: 'insert_under_heading', headingId, markdown: edit.markdown });
    rehomed.push(
      "a note addressed to the end of the doc was written under this meeting's notes instead",
    );
  }
  return { edits: out, rehomed };
}
