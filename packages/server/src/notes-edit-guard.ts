/**
 * The three edits the note-taker must never be allowed to make to its own
 * section, refused in the applier rather than argued for in the prompt.
 *
 * WHY NOT THE PROMPT. The rules below are already in the prompt, in capitals,
 * and every one of them was broken in a measured run. A prompt rule is a request; this is
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
 * RULE 3 — A BULLET WITH NO WORDS IN IT IS NOT A NOTE. Markdown reading `- `
 * parses to a real list item holding nothing, and `applyBlockEdits` applies
 * it: the core refusal is for markdown that parses to NO BLOCKS, and this
 * parses to one. So the tick counts as a write, the turns it was answering
 * are marked composed and never offered again, and what the reader gets is a
 * blank line carrying the fresh-note tint — the blue bar on nothing.
 * Measured in production on 2026-09-11: a meeting's section opened with one
 * empty bullet, the first thing said never reached the notes at all, and the
 * blank line stood for the rest of the recording, because
 * `notes-section-tidy.ts` removes empty PARAGRAPHS and an empty bullet is a
 * list item.
 *
 * So a wordless bullet is stripped out of the markdown it rides in, and if
 * stripping it leaves an edit with no words at all, that edit is refused.
 * When the batch's ONLY note was wordless — the shape above, a section
 * heading opening beside an empty bullet — the whole batch is refused, which
 * is the half of this rule that saves the words: a refused write carries its
 * turns into the next tick, so the first thing said is composed again with a
 * section already open, instead of being counted as written up.
 *
 * REFUSED RATHER THAN CONVERTED, unlike RULE 2, because there is nothing to
 * keep. RULE 2 converts because both notes are real; here one of them is a
 * blank line, and the only thing worth saving is the speech it failed to
 * write up.
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

/** Any letter or digit at all — what tells a note from a list marker. */
const WORD = /[\p{L}\p{N}]/u;

/** A line that is a list marker and nothing else: `- `, `*`, `1.`, `2)`. */
const BARE_MARKER = /^\s*(?:[-*+]|\d+[.)])\s*$/;

/** A line that opens a heading, whether or not it carries words after the
 *  hashes. */
const HEADING_LINE = /^\s*#{1,6}(?:\s|$)/;

/**
 * The same markdown with its wordless bullets taken out.
 *
 * Line by line, because a bullet with no words occupies exactly one line and
 * everything around it — the section heading the model opened beside it, the
 * bullets that did carry words — has to survive untouched.
 *
 * A MARKER LINE WHOSE WORDS ARE INDENTED UNDER IT IS NOT EMPTY. `- ` followed
 * by an indented line is a wrapped bullet or a nested list, and dropping the
 * marker would orphan whatever hangs off it. Only a marker with nothing
 * indented after it is a blank line pretending to be a note.
 *
 * AND BLANK LINES BETWEEN THEM CHANGE NOTHING. `- \n\n  - point` parses to
 * exactly the same nested list as `- \n  - point` — measured — so the search
 * for indented content looks past however many blank lines the model put in.
 * Reading only the next line flattened that hierarchy: the parent went, and
 * its child came back as a top-level bullet.
 */
export function stripWordlessBullets(markdown: string): { markdown: string; stripped: number } {
  const lines = markdown.split('\n');
  const keep: string[] = [];
  let stripped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (BARE_MARKER.test(line) && !hasIndentedContent(lines, i + 1)) {
      stripped++;
      continue;
    }
    keep.push(line);
  }
  return { markdown: keep.join('\n'), stripped };
}

/** Whether the next non-blank line at or after `from` is indented — the words
 *  a bare marker is carrying, wrapped or nested under it. */
function hasIndentedContent(lines: readonly string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    return /^\s+\S/.test(line);
  }
  return false;
}

/**
 * Does this markdown put a NOTE in the doc — words that are not a heading?
 *
 * The heading lines are dropped before the question is asked, because opening
 * `## Meeting notes` is structure the next tick would open again anyway. A
 * batch that carries nothing else wrote no note, however many blocks it
 * added.
 */
function writesANote(markdown: string): boolean {
  return WORD.test(
    markdown
      .split('\n')
      .filter((l) => !HEADING_LINE.test(l))
      .join('\n'),
  );
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
  // RULE 3, first half: every wordless bullet leaves the batch before any
  // other rule looks at it, so a replace judged below is judged on the words
  // it will actually write.
  let strippedBullets = 0;
  const worded: prose.BlockEdit[] = [];
  for (const edit of edits) {
    if (!('markdown' in edit)) {
      worded.push(edit);
      continue;
    }
    const { markdown, stripped } = stripWordlessBullets(edit.markdown);
    strippedBullets += stripped;
    if (stripped === 0) {
      worded.push(edit);
      continue;
    }
    if (!WORD.test(markdown)) {
      refused.push(`${edit.op} carrying nothing but an empty bullet`);
      continue;
    }
    worded.push({ ...edit, markdown });
  }
  for (const edit of worded) {
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
  // RULE 3, second half. A tick that took a blank line out of its own batch
  // and has no note left in it did not write this tick's speech up, however
  // much structure it added. Refusing the rest is what carries the words to
  // the next tick — applying the heading alone would mark them composed and
  // the first thing said would be gone.
  if (strippedBullets > 0 && !out.some((e) => 'markdown' in e && writesANote(e.markdown))) {
    for (const edit of out)
      refused.push(`${edit.op} in a batch whose only note was an empty bullet`);
    return { edits: [], refused, kept };
  }
  return { edits: out, refused, kept };
}
