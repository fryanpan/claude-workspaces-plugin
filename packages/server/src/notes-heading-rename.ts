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
 * WHAT IS REFUSED RATHER THAN PROPOSED. A rename is a rename: the replacement
 * is one heading, at the SAME LEVEL, saying something different. A
 * replacement that is a bullet, or a heading a level deeper, is a
 * restructure — every line under the heading changes what it belongs to
 * without one of them being edited — and a redline showing two lines of text
 * would tell the reader nothing about what they were accepting.
 */

import type { prose } from '@claude-workspaces/core';

/** The rename to file, or why this replace is not one. Null when the edit is
 *  not about a heading at all, which is the ordinary case. */
export type HeadingRename = { edit: prose.BlockEdit } | { refused: string } | null;

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
  return { edit: { ...edit, propose: true } };
}
