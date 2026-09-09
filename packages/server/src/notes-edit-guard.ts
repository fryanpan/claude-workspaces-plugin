/**
 * The two edits the note-taker must never be allowed to make to its own
 * section, refused in the applier rather than argued for in the prompt.
 *
 * WHY NOT THE PROMPT. Both rules below are already in the prompt, in capitals,
 * and both were broken in a measured run. A prompt rule is a request; this is
 * the answer to "what happens when the model does it anyway", and the answer
 * has to be that the notes survive.
 *
 * RULE 1 — THE SECTION HEADING IS NOT AN EDITABLE BLOCK. A `replace_block`
 * against the meeting's own `## Meeting notes` heading replaces the element,
 * so the block id changes. `NotesHeadingMemory` checks its remembered id
 * against the outline every tick and correctly concludes the heading is gone,
 * so the next tick opens a SECOND section. From that moment every reader that
 * finds the section by heading text — `settle-wash.ts` in the client, and the
 * server's own finder — takes the LAST match, and everything written before,
 * including any line a person typed, drops out of the notes view while
 * staying in the doc. Measured on AMI fixture ES2002c: the composer replaced
 * its heading at tick 30, and for the remaining thirteen ticks the doc's
 * outline grew from 55 entries to 76 while the notes section stayed frozen at
 * 21 bullets. The meeting kept being noted; none of it arrived.
 *
 * WHAT IS DELIBERATELY NOT HERE: A DELETE-COVERAGE RULE. The obvious second
 * rule is to refuse a `delete_block` whose content no other edit in the batch
 * carries, on the grounds that the prompt only sanctions a delete as the
 * second half of a regroup. It was built, and it is not here, because two
 * shipped behaviours depend on the delete reaching the applier:
 *
 *   - A delete against a block that is not the note-taker's becomes a
 *     SUGGESTION a person can accept or reject. Refusing it early turns a
 *     visible proposal into silence — `notes-second-meeting.test.ts`.
 *   - A bullet MOVED under the topic it belongs to is a delete in one tick and
 *     an insert in another, so nothing in the delete's own batch carries its
 *     words — `notetaker-behaviour.test.ts`.
 *
 * Both failed against the rule, and neither is a bug. The measured collapse
 * needed no such rule either: the run traced on ES2002c lost its notes to a
 * heading replace with no delete in the batch at all. A guard with no
 * evidence behind it that breaks two behaviours is a worse trade than the
 * failure it was speculating about.
 */

import type { prose } from '@claude-workspaces/core';

/** What the guard decided, for the caller to apply and to log. */
export interface NotesEditGuardResult {
  /** The edits that may be applied, in their original order. */
  edits: prose.BlockEdit[];
  /** One line per refused edit, naming the rule. Empty on a clean batch, so
   *  a caller logs nothing for the overwhelmingly common case. */
  refused: string[];
}

/** What the guard needs to know about the doc it is guarding. */
export interface NotesEditGuardContext {
  /** This meeting's own section heading, when it has opened one. */
  notesHeadingId?: string | undefined;
}

/**
 * Filter a tick's edits down to the ones that cannot destroy the section.
 *
 * Order is preserved and nothing is rewritten: an edit either survives
 * untouched or is dropped with a reason. The applier resolves each edit
 * against the doc as the ones before it left it, so dropping an edit can only
 * ever leave more of the doc standing, never less.
 */
export function guardNotesEdits(
  edits: readonly prose.BlockEdit[],
  ctx: NotesEditGuardContext,
): NotesEditGuardResult {
  const kept: prose.BlockEdit[] = [];
  const refused: string[] = [];
  for (const edit of edits) {
    if (edit.op !== 'replace_block' && edit.op !== 'delete_block') {
      kept.push(edit);
      continue;
    }
    if (ctx.notesHeadingId !== undefined && edit.blockId === ctx.notesHeadingId) {
      refused.push(`${edit.op} on the meeting's own notes heading (${edit.blockId})`);
      continue;
    }
    kept.push(edit);
  }
  return { edits: kept, refused };
}
