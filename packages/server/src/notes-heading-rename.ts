/**
 * A heading the talk has outgrown, renamed BY ASKING.
 *
 * WHY THIS IS NOT AN EDIT. Half an hour into a meeting the heading a topic
 * opened under is often wrong: the room started on "Pricing" and spent forty
 * minutes on packaging tiers. Leaving it is a page filed under a name nobody
 * would search for. Rewriting it silently is worse — a heading is what every
 * line beneath it is filed under, so a rename reorganises, under a different
 * name, a page somebody may be reading. And the note-taker OWNS the heading
 * it wrote, so ownership — which is what decides rewrite-versus-redline
 * everywhere else — would have let it through without a word.
 *
 * So: a replace on a heading is a PROPOSAL, always, whoever owns it. The
 * reader sees the old words struck and the new ones beside them and taps once.
 * `propose` on the edit (`prose-batch.ts`) is what makes that a property of
 * the write path rather than of a prompt the model may or may not follow.
 *
 * THE ONE RENAME THAT IS APPLIED: A BARE PAGE HEADING GIVEN ITS NAME. A
 * speaker dictating a document says "it has two pages" and then "page one is
 * the street repairs". The note-taker opens "Page one" on the first sentence,
 * nothing yet under it, and names it on the second. Filed as a suggestion,
 * that name never reached the page on the synthetic dictation — the heading
 * stayed "Page one" and the speaker's words for it were lost. So a heading
 * the note-taker wrote that is ONLY a page number, replaced by the same
 * words with more after them ("Page one" to "Page one: street repairs"), is
 * applied: nothing under it changes what it is filed under, and no word of
 * the old heading goes.
 *
 * WHAT IS REFUSED RATHER THAN PROPOSED. A rename is a rename: the replacement
 * is one heading, at the SAME LEVEL, saying something different. A
 * replacement that is a bullet, or a heading a level deeper, is a
 * restructure — every line under the heading changes what it belongs to
 * without one of them being edited — and a redline showing two lines of text
 * would tell the reader nothing about what they were accepting.
 */

import type { prose } from '@claude-workspaces/core';
import { pageOfHeading } from './notes-dictation.ts';

/** The rename to file, or why this replace is not one. Null when the edit is
 *  not about a heading at all, which is the ordinary case. */
export type HeadingRename = { edit: prose.BlockEdit; applied?: true } | { refused: string } | null;

/** A heading that is a page number and nothing else: "Page one", "Part 2". */
const BARE_PAGE =
  /^(?:page|part|section)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)[.:]?$/i;

/** The level a markdown heading line declares, or 0 for anything else. */
function levelOf(markdown: string): number {
  const first = markdown.trim().split('\n', 1)[0] ?? '';
  return (first.match(/^(#{1,6})\s+\S/)?.[1] ?? '').length;
}

/** A heading line's words, without its marks. */
function wordsOf(markdown: string): string {
  return (markdown.trim().split('\n', 1)[0] ?? '').replace(/^#{1,6}\s+/, '').trim();
}

export function headingRename(
  edit: prose.BlockEdit,
  outline: readonly prose.OutlineEntry[],
  authorId?: string,
): HeadingRename {
  if (edit.op !== 'replace_block') return null;
  const was = outline.find((e) => e.id === edit.blockId);
  // A block the outline never saw is not a heading as far as anything here
  // can tell, and the applier will report it as unknown on its own.
  if (was === undefined || was.kind !== 'heading') return null;
  const level = levelOf(edit.markdown);
  if (level === 0 || edit.markdown.trim().includes('\n')) {
    return { refused: 'the replacement for a heading is not one heading' };
  }
  if (was.level !== undefined && level !== was.level) {
    return { refused: `the replacement changes the heading’s level (${was.level} to ${level})` };
  }
  const words = wordsOf(edit.markdown);
  if (words.length === 0) return { refused: 'the replacement for a heading has no words' };
  if (words === was.text.trim()) return { refused: 'the replacement says the same words' };
  const old = was.text.trim();
  // The same page by number ("Page 1" named "Page one: …" is still page 1),
  // with words the bare heading did not have.
  const page = pageOfHeading(old);
  const named =
    authorId !== undefined &&
    was.author === authorId &&
    BARE_PAGE.test(old) &&
    page !== undefined &&
    pageOfHeading(words) === page &&
    words.split(/\s+/).length > old.split(/\s+/).length;
  if (named) return { edit, applied: true };
  return { edit: { ...edit, propose: true } };
}
