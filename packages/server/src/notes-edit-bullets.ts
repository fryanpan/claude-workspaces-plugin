/**
 * Every note the note-taker writes is a bullet, whatever the model answered.
 *
 * WHY THIS EXISTS. A three-voice huddle on 2026-09-14 ended as three bullets
 * followed by twelve paragraphs. The instructions ask for a `**Question:**`
 * prefix on an open question, and the model wrote that line with no `- `
 * marker, which parses to a paragraph. From the next tick on, the outline
 * showed the notes as a `para`, and the model wrote every later note in the
 * same shape. Nothing on the write path put the marker back. The paragraphs
 * also escaped every check that counts notes as list items. The flat-run
 * count never reached the bar, so no topic heading was ever asked for.
 *
 * WHAT IT DOES, per edit, before the guard reads the batch: a top-level line
 * of plain prose becomes a bullet. Headings, list items, indented lines,
 * blank lines, fenced code, tables, quotes and rules are left as written.
 * Each prose line becomes its own bullet. The instructions say one point per
 * note, and `**Question:** …` on the line after a bullet would otherwise be
 * folded into that bullet as a lazy continuation.
 *
 * WHICH EDITS. Every insert. A `replace_block` only when it names a
 * PARAGRAPH the note-taker still owns: that is a note in the wrong shape, and
 * rewriting it is how it gets fixed. A replace naming a list item already
 * lands inside that item, so a marker would open a list inside the bullet. A
 * replace naming a person's block becomes a suggestion on their words, and
 * changing its shape is not the note-taker's call.
 */

import type { prose } from '@claude-workspaces/core';
import { proseNote } from './notes-quality.ts';

/**
 * The markdown with each top-level prose line turned into a bullet, and how
 * many lines that changed.
 */
export function bulletProseLines(markdown: string): { markdown: string; bulleted: number } {
  // The fence that is open, if any. Only the same marker, at least as long and
  // with nothing after it, closes it: a ``` line inside a ~~~ block is code.
  let fence: string | undefined;
  let bulleted = 0;
  const source = markdown.split('\n');
  const lines = source.map((line, i) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      const run = marker[1]!;
      const rest = marker[2] ?? '';
      if (fence === undefined) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length && rest.trim() === '') {
        fence = undefined;
      }
      return line;
    }
    if (fence !== undefined || proseNote(line) === undefined) return line;
    // A line underlined with `===` or `---` is a heading's text, not a note,
    // and the underline is the heading's too.
    const underline = /^ {0,3}(?:=+|-+)\s*$/;
    if (underline.test(source[i + 1] ?? '') || underline.test(line)) return line;
    bulleted++;
    return `- ${line}`;
  });
  return { markdown: lines.join('\n'), bulleted };
}

export interface BulletNotesContext {
  /** The doc as the tick read it: says what kind of block a replace names,
   *  and whose it is. */
  outline: readonly prose.OutlineEntry[];
}

/** The batch with its prose notes turned into bullets. See the header. */
export function bulletNotesEdits(
  edits: readonly prose.BlockEdit[],
  ctx: BulletNotesContext,
): { edits: prose.BlockEdit[]; bulleted: number } {
  let bulleted = 0;
  const out = edits.map((edit) => {
    if (!('markdown' in edit)) return edit;
    if (edit.op === 'replace_block') {
      const target = ctx.outline.find((e) => e.id === edit.blockId);
      if (target?.nodeName !== 'paragraph' || target.author === undefined) return edit;
    }
    const next = bulletProseLines(edit.markdown);
    if (next.bulleted === 0) return edit;
    bulleted += next.bulleted;
    return { ...edit, markdown: next.markdown };
  });
  return { edits: out, bulleted };
}
