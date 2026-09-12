/**
 * Words that composed and did not land get a home, instead of being dropped.
 *
 * WHAT THIS ANSWERS. A tick's edits are addressed by the MODEL: it reads the
 * outline and names the block its note belongs under. When that address is
 * one the doc cannot honour, `applyBlockEdits` fails the edit and the note it
 * carried is gone — and nothing downstream can put it back, because the only
 * copy of those words was in the batch.
 *
 * The pipeline does have a recovery, and it is not enough. A failed write
 * carries its turns into the next tick and spends a second compose on them
 * (`meeting-notes.ts`, `retryAfterFailure`), which is why ONE bad address
 * costs a compose rather than a note. But `retriedFailure` is cleared only by
 * a SUCCESS, so a mistake that REPEATS — the same prompt, the same doc shape,
 * the same wrong id, tick after tick — loses everything after the first
 * failure, the final pass at `end()` included. Measured on a scripted meeting
 * through the real write path: ticks 2-4 mis-addressed, and the doc ends
 * holding the tick-1 note and nothing else, with three turns of speech gone
 * and a `console.error` line the only trace.
 *
 * WHY IT RUNS ON OUTCOMES RATHER THAN BEFORE THE WRITE. The alternative is to
 * judge each address against the outline first and rewrite the doubtful ones.
 * That has to PREDICT what the applier will do, and it is wrong at the edges —
 * the outline omits list containers, so a block that is really there reads as
 * missing and a correct edit would be turned into a duplicate note. Reading
 * the applier's own verdicts needs no prediction: an edit that failed is one
 * that did nothing, so the words it carried are not in the doc under that
 * edit. It also costs nothing on the overwhelmingly common path, because a
 * batch with no failures produces no repair.
 *
 * The one place that is not the whole story is a `replace_block` whose block
 * is gone because a reparse RE-KEYED it: the old wording is still in the doc
 * under a new id, so recovering the rewrite puts the revised bullet beside
 * the stale one instead of over it. A visible duplicate the cleanup pass can
 * fold, against a correction the meeting never sees — the same trade RULE 2
 * of `notes-edit-guard.ts` already makes, and the reason this is worth
 * saying out loud rather than filing as an edge case.
 *
 * WHICH FAILURES ARE THIS MODULE'S. Only the ones that are about the ADDRESS:
 *
 * - `unknown-block` — the block is not in the doc. A person deleted it, or a
 *   reparse from disk replaced it (`applyMarkdownToFragment` keys blocks by
 *   their serialized markdown, so a block whose text changed comes back as a
 *   new element with a new id).
 * - `not-a-heading` — the block IS in the doc and is not a heading. The
 *   prompt lists bullets and headings side by side with their ids and asks
 *   for a note "under the heading of its topic", so a model that takes the
 *   bullet's id has named a real block for a slot that wants a heading. This
 *   is the failure the log's fallback sentence — "every edit named a block
 *   that is no longer in the doc" — describes wrongly.
 *
 * `empty` and `parse-failed` are NOT address failures: the markdown itself
 * carried nothing, and re-addressing it would write a blank note. A batch
 * that failed for those reasons is left exactly as it was.
 *
 * AND ONLY EDITS THAT CARRY WORDS. A `delete_block` or a `nest_blocks` that
 * failed moved nothing, which is a regroup that did not happen rather than a
 * note that did not arrive — the distinction `meeting-notes-doc.ts` already
 * draws, for the same reason.
 *
 * WHERE THE WORDS GO. Under this meeting's own notes section, resolved at
 * repair time rather than taken from the failed edit; with no section, at the
 * end of the doc, which is where a meeting with no section writes anyway.
 * A note landing under the section instead of under its topic heading is a
 * note in the wrong place, and a note in the wrong place is visible, is one
 * the end-of-meeting cleanup pass can move, and is worth a great deal more
 * than a note nobody has. That is the same trade `notes-edit-guard.ts` RULE 2
 * makes when it turns a destructive replace into an insert.
 *
 * Pure: it is handed edits, verdicts and a heading id, and answers with
 * edits. Nothing here reads a doc or writes one.
 */
import type { prose } from '@claude-workspaces/core';

/** The verdicts this module treats as "the address was wrong", as opposed to
 *  "the words were wrong". */
const ADDRESS_ERRORS: ReadonlySet<string> = new Set(['unknown-block', 'not-a-heading']);

/** The ops that would have PUT WORDS in the doc. A move and a delete carry
 *  none, so a failed one loses nothing to recover. */
const CARRIES_WORDS: ReadonlySet<prose.BlockEditOp> = new Set([
  'insert_under_heading',
  'insert_at_end',
  'replace_block',
]);

export interface NotesAddressRepair {
  /** The second batch to apply, in the order the failed edits were composed.
   *  Empty when there is nothing to recover, which is the ordinary case. */
  edits: prose.BlockEdit[];
  /** One line per recovered note, naming the op and the verdict it is
   *  recovering from — what the log says instead of nothing. */
  repaired: string[];
}

/**
 * The edits that would put a failed batch's words back into the doc.
 *
 * `outcomes` is the applier's verdict list, which carries exactly one entry
 * per edit in order. A list of any other length is not something to guess
 * about: no repair is offered, because pairing a note with the wrong verdict
 * could rewrite an edit that landed.
 */
export function repairNotesEditAddresses(
  edits: readonly prose.BlockEdit[],
  outcomes: readonly prose.BlockEditOutcome[],
  notesHeadingId: string | undefined,
): NotesAddressRepair {
  const repair: NotesAddressRepair = { edits: [], repaired: [] };
  if (outcomes.length !== edits.length) return repair;
  for (const [i, outcome] of outcomes.entries()) {
    if (outcome.status !== 'failed') continue;
    if (outcome.error === undefined || !ADDRESS_ERRORS.has(outcome.error)) continue;
    if (!CARRIES_WORDS.has(outcome.op)) continue;
    const edit = edits[i];
    if (edit === undefined) continue;
    const markdown = markdownOf(edit);
    // A word-carrying op always has markdown; the check is what keeps this
    // total rather than a cast, and an edit with none has nothing to recover.
    if (markdown === undefined || markdown.trim().length === 0) continue;
    repair.edits.push(
      notesHeadingId === undefined
        ? { op: 'insert_at_end', markdown }
        : { op: 'insert_under_heading', headingId: notesHeadingId, markdown },
    );
    repair.repaired.push(
      `${outcome.op}/${outcome.error} re-addressed to ` +
        `${notesHeadingId === undefined ? 'the end of the doc' : 'this meeting’s notes section'}`,
    );
  }
  return repair;
}

/** The words an edit was going to write, for the ops that write any. */
function markdownOf(edit: prose.BlockEdit): string | undefined {
  return 'markdown' in edit ? edit.markdown : undefined;
}
