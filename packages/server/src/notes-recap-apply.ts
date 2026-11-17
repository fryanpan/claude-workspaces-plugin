/**
 * Write the shaped recap (`notes-recap-shape.ts`) into a meeting's section,
 * once, at the meeting's stop.
 *
 * WHY AT THE STOP. A tick sees a slice of the doc and a clock behind it; the
 * stop is the first moment the whole meeting is on the page and nothing else
 * is about to write into it. It runs no model, so it costs nothing and needs
 * no press: Bryan's feedback was that no pass ran after
 * the meeting and he cleaned up every recap by hand.
 *
 * WHAT IT WILL NOT TOUCH. Moving a bullet re-creates it, which would take a
 * comment anchor or a pending suggestion with it, and a person's line is
 * never the note-taker's to move. So the section is rewritten only when every
 * heading and bullet in it still carries the note-taker's authorship, none
 * holds a comment and none holds a suggestion. Anything else leaves the
 * section exactly as it was, and the caller logs why.
 *
 * IDS ARE KEPT where the words are. The section's first heading keeps the id
 * the heading store holds for this meeting, so the next recording still
 * finds it; every other heading and bullet whose words survived keeps its
 * own id, so `notes-written-blocks.ts` still knows them as the note-taker's.
 */

import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type RecapShapeCounts, shapeRecap } from './notes-recap-shape.ts';
import { endsMeetingNotes } from './notes-section-fit.ts';
import { holdsASuggestion } from './notes-section-tidy.ts';

export type RecapApplyResult =
  | { applied: true; counts: RecapShapeCounts }
  | {
      applied: false;
      reason: 'no-section' | 'unchanged' | 'not-shapeable' | 'person' | 'commented';
    };

function levelOf(el: Y.XmlElement): number | undefined {
  if (el.nodeName !== 'heading') return undefined;
  const n = Number(el.getAttribute('level'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Every heading and list item at or under `el`. */
function blocksIn(el: Y.XmlElement, out: Y.XmlElement[] = []): Y.XmlElement[] {
  if (el.nodeName === 'heading' || el.nodeName === 'listItem') out.push(el);
  for (const child of el.toArray()) if (child instanceof Y.XmlElement) blocksIn(child, out);
  return out;
}

/** The words a heading or a list item's own line carries, for matching ids. */
const lineOf = (el: Y.XmlElement): string => prose.outlineTextOf(el).trim().toLowerCase();

export function applyRecapShape(
  ydoc: Y.Doc,
  headingId: string,
  spoken: readonly string[],
  opts: { author: string; commented: () => ReadonlySet<string> },
): RecapApplyResult {
  const fragment = prose.getProseFragment(ydoc);
  const top = fragment.toArray() as Y.XmlElement[];
  const start = top.findIndex((el) => prose.readBlockId(el) === headingId);
  if (start < 0) return { applied: false, reason: 'no-section' };
  const openLevel = levelOf(top[start] as Y.XmlElement) ?? 2;
  let end = start + 1;
  for (; end < top.length; end++) {
    const el = top[end] as Y.XmlElement;
    const level = levelOf(el);
    if (
      level !== undefined &&
      endsMeetingNotes({ level, author: prose.readBlockAuthor(el) }, openLevel, opts.author)
    ) {
      break;
    }
  }
  const span = top.slice(start, end);
  const markdown = `${span.map((el) => prose.serializeBlockToMarkdown(el)).join('\n\n')}\n`;
  const shaped = shapeRecap(markdown, spoken);
  if (!shaped) return { applied: false, reason: 'not-shapeable' };
  if (!shaped.changed) return { applied: false, reason: 'unchanged' };

  const old = span.flatMap((el) => blocksIn(el));
  if (old.some((b) => prose.readBlockAuthor(b) !== opts.author || holdsASuggestion(b))) {
    return { applied: false, reason: 'person' };
  }
  const commented = opts.commented();
  if (old.some((b) => commented.has(prose.readBlockId(b) ?? ''))) {
    return { applied: false, reason: 'commented' };
  }

  // Each old id, offered once, to the first new block with the same words.
  const idsByLine = new Map<string, string[]>();
  for (const b of old) {
    const id = prose.readBlockId(b);
    if (id === undefined || id === headingId) continue;
    const key = `${b.nodeName}:${lineOf(b)}`;
    idsByLine.set(key, [...(idsByLine.get(key) ?? []), id]);
  }
  const fresh = prose.parseMarkdownBlocks(shaped.markdown);
  ydoc.transact(() => {
    fragment.delete(start, end - start);
    fragment.insert(start, fresh);
    const inserted = (fragment.toArray() as Y.XmlElement[]).slice(start, start + fresh.length);
    inserted.forEach((el, i) => {
      for (const b of blocksIn(el)) {
        const claimed = i === 0 && b === el ? headingId : undefined;
        const reuse = claimed ?? idsByLine.get(`${b.nodeName}:${lineOf(b)}`)?.shift();
        b.setAttribute(prose.BLOCK_ID_ATTR, reuse ?? prose.newBlockId());
        prose.setBlockAuthor(b, opts.author);
      }
    });
  }, 'agent');
  return { applied: true, counts: shaped.counts };
}
