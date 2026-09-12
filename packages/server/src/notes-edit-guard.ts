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
 * RULE 2 — A REVISION MAY NOT THROW AWAY THE NOTE IT REPLACES. The prompt
 * lets the note-taker rewrite its own bullet, because a note-taker revises
 * the line it wrote a moment ago. What it must not do is answer a tick of NEW
 * speech by replacing an OLD note with a note about the new speech: the words
 * of the earlier turn leave the doc, and nothing downstream can tell they
 * were ever there. Measured in production on 2026-09-11: a sparse meeting
 * carrying roughly one short turn per tick ran fourteen ticks, every one of
 * them composing and writing, and ended with two bullets — the per-meeting
 * summary reporting five of ten ideas in no note while no write was ever
 * refused and no edit ever failed.
 *
 * So a `replace_block` against one of the note-taker's own bullets is checked
 * against the bullet it names: if the replacement does not carry what that
 * bullet said — the same content-word share `notes-idea-coverage.ts` judges
 * an idea by, and the same threshold — it is not a revision, and it is turned
 * into an INSERT under the bullet's own heading. Both notes then stand.
 *
 * TURNED INTO, NOT REFUSED, and that is the whole reason this rule can exist
 * at all. Refusing the edit would drop the note about the speech this tick
 * actually heard, which trades fourteen lost notes for fourteen different
 * ones. Converting it is the only answer that keeps both, and it is why this
 * is the one rule here that rewrites rather than drops.
 *
 * WHICH WAY THE PROXY ERRS. The overlap test is lexical, so it will
 * occasionally read a heavy paraphrase as a different note and leave two
 * bullets where the model meant one. That is the safe direction: a duplicate
 * is visible, is counted in the per-meeting summary, and the end-of-meeting
 * cleanup pass exists to merge one. A destroyed note is none of those things.
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
import { sectionIds } from './notes-cleanup-scope.ts';
import { IDEA_CARRIED_SHARE, contentWords } from './notes-idea-coverage.ts';

/** What the guard decided, for the caller to apply and to log. */
export interface NotesEditGuardResult {
  /** The edits that may be applied, in their original order. */
  edits: prose.BlockEdit[];
  /** One line per refused edit, naming the rule. Empty on a clean batch, so
   *  a caller logs nothing for the overwhelmingly common case. */
  refused: string[];
  /** One line per replace the guard turned into an insert, naming the bullet
   *  it kept. Separate from `refused` because nothing was dropped: the tick's
   *  note is still in `edits`, and a caller that counts refusals must not
   *  count these among them. */
  kept: string[];
}

/** What the guard needs to know about the doc it is guarding. */
export interface NotesEditGuardContext {
  /** This meeting's own section heading, when it has opened one. */
  notesHeadingId?: string | undefined;
  /**
   * The doc as the tick read it — what says whose a block is and what it
   * said. Absent, RULE 2 cannot judge a replacement and every replace passes,
   * which is how this guard behaved before the rule existed.
   */
  outline?: readonly prose.OutlineEntry[] | undefined;
}

/**
 * The fewest content words a note needs before RULE 2 will judge a rewrite of
 * it. See `keepsItsWords`.
 */
const MIN_REVISION_CONTENT_WORDS = 4;

/**
 * Does `now` still carry what `was` said?
 *
 * The same question `ideaCarried` asks of a spoken idea and the notes, at the
 * same threshold, because it is the same question: these words were in the
 * doc, are they still. Both sides go through `contentWords`, so a paraphrase
 * that keeps the nouns and the numbers reads as a revision and a bullet about
 * something else does not.
 */
function keepsItsWords(was: string, now: string): boolean {
  const had = contentWords(was);
  // A SHORT NOTE IS NOT JUDGED AT ALL. Three content words leave no room for
  // a share: "rough note" reworded to "sharper note" keeps one of two and
  // reads as an overwrite by any threshold, so a floorless rule turns every
  // small wording fix into a duplicate. The rule exists for notes with
  // something in them to lose, and a note this short loses little.
  if (had.length < MIN_REVISION_CONTENT_WORDS) return true;
  const has = new Set(contentWords(now));
  const hits = had.filter((w) => has.has(w)).length;
  return hits >= Math.max(2, Math.ceil(had.length * IDEA_CARRIED_SHARE));
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
  const out: prose.BlockEdit[] = [];
  const refused: string[] = [];
  const kept: string[] = [];
  const headingId = ctx.notesHeadingId;
  const outline = ctx.outline;
  // Walked once for the batch, not once per edit: the section is the same
  // section for all of them, and an edit before this one cannot move it.
  const section =
    outline !== undefined && headingId !== undefined ? sectionIds(outline, headingId) : undefined;
  for (const edit of edits) {
    if (edit.op !== 'replace_block' && edit.op !== 'delete_block') {
      out.push(edit);
      continue;
    }
    if (headingId !== undefined && edit.blockId === ctx.notesHeadingId) {
      refused.push(`${edit.op} on the meeting's own notes heading (${edit.blockId})`);
      continue;
    }
    const was =
      edit.op === 'replace_block' && outline !== undefined && section?.blocks.has(edit.blockId)
        ? outline.find((e) => e.id === edit.blockId)
        : undefined;
    // RULE 2, and every clause of this condition is load-bearing. Only a
    // LIST ITEM is a note; only a block the note-taker still owns is one an
    // edit may rewrite at all (anything else reaches a person as a
    // suggestion, which destroys nothing); and only a replacement that drops
    // the bullet's own words is an overwrite rather than a revision.
    if (
      edit.op === 'replace_block' &&
      was !== undefined &&
      was.kind === 'listItem' &&
      was.author !== undefined &&
      headingId !== undefined &&
      !keepsItsWords(was.text, edit.markdown)
    ) {
      // Under the bullet's OWN heading when it has one inside this section,
      // so a note about a topic stays with its topic; under the meeting's
      // heading otherwise.
      const under =
        was.underHeadingId !== undefined && section?.headings.has(was.underHeadingId) === true
          ? was.underHeadingId
          : headingId;
      out.push({ op: 'insert_under_heading', headingId: under, markdown: edit.markdown });
      kept.push(
        `replace_block on ${edit.blockId} wrote a note the bullet did not say — ` +
          'added it instead, so both stand',
      );
      continue;
    }
    out.push(edit);
  }
  return { edits: out, refused, kept };
}
