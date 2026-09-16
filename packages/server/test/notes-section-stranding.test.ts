/**
 * THE STRANDING IS GONE, AND THIS FILE IS WHAT SAYS SO.
 *
 * WHAT IT WAS. A doc already carrying a `## Meeting notes` heading, and a
 * meeting that had opened no section of its own, wrote its bullets under the
 * heading that was there. When it later opened its own, both readers of a
 * notes section took the LAST heading with that text, so everything written
 * in that window stopped being in the notes while staying in the doc. Traced
 * on AMI fixture ES2003c: the section grew to 23 bullets over fifteen ticks
 * and read 0 at tick 16 while the whole doc read 26. The fix was to open the
 * section before the first bullet.
 *
 * WHY IT CANNOT HAPPEN NOW. There is no reserved section (owner, 2026-09-15)
 * and no reader that finds one by its words: the notes are the whole doc, and
 * a heading a meeting writes is addressed by block id. A second heading with
 * the same words moves nothing and hides nothing, because nothing is looking
 * for those words.
 *
 * So the eager open is gone with the failure it guarded, and what is pinned
 * here is the guarantee underneath it: a bullet stays under the heading it
 * was written under, for the life of the doc.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { SCRIPT_TOPIC } from './notes-tick-harness.ts';

const AUTHOR = 'notes-agent';
const WHO = {
  author: AUTHOR,
  suggestionAuthor: { id: AUTHOR, name: 'Note-taker', color: '#888888' },
};
const HUMAN_LINE = 'my own note: check this against the brief before we commit';

/** A doc as a meeting finds it: somebody's heading, and their line. */
function seededDoc(): Y.Doc {
  const doc = new Y.Doc();
  prose.applyMarkdownToFragment(
    prose.getProseFragment(doc),
    `## ${SCRIPT_TOPIC}\n\n- ${HUMAN_LINE}\n`,
  );
  prose.ensureBlockIds(doc);
  return doc;
}

function headingIdIn(doc: Y.Doc, text: string): string {
  const found = prose
    .readOutline(doc)
    .filter((e) => e.kind === 'heading' && e.text.trim() === text);
  const last = found[found.length - 1];
  if (!last) throw new Error(`no heading ${text}`);
  return last.id;
}

function apply(doc: Y.Doc, edits: readonly prose.BlockEdit[]): void {
  prose.applyBlockEdits(doc, [...edits], WHO);
}

function markdown(doc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc));
}

/** How many bullets are anywhere in the doc. */
function docBullets(doc: Y.Doc): number {
  return markdown(doc)
    .split('\n')
    .filter((l) => l.trim().startsWith('-')).length;
}

/** The bullets between `heading` and the next heading of its level or above —
 *  what a reader sees under it, read by POSITION rather than by any text. */
function bulletsUnder(doc: Y.Doc, headingId: string): string[] {
  const outline = prose.readOutline(doc);
  const at = outline.findIndex((e) => e.id === headingId);
  if (at < 0) throw new Error('no such heading');
  const level = outline[at]?.level ?? 2;
  const out: string[] = [];
  for (let i = at + 1; i < outline.length; i++) {
    const entry = outline[i];
    if (entry === undefined) continue;
    if (entry.kind === 'heading' && (entry.level ?? 0) <= level) break;
    if (entry.kind === 'listItem') out.push(entry.text);
  }
  return out;
}

/** Fifteen ticks of bullets written under whatever heading is offered. */
function writeFifteenTicks(doc: Y.Doc, headingId: string): void {
  for (let tick = 1; tick <= 15; tick++) {
    apply(doc, [
      { op: 'insert_under_heading', headingId, markdown: `- point ${tick} from the meeting` },
    ]);
  }
}

describe('a meeting that writes under a heading somebody else wrote', () => {
  test('every bullet stays under that heading, and a later topic moves none of them', () => {
    const doc = seededDoc();
    const theirs = headingIdIn(doc, SCRIPT_TOPIC);
    writeFifteenTicks(doc, theirs);
    expect(bulletsUnder(doc, theirs)).toHaveLength(16); // fifteen, plus the person's line

    // The meeting then starts a topic of its own, which is what it does when
    // nothing there fits what is being said any more.
    apply(doc, [{ op: 'insert_at_end', markdown: '## Ferry timetable\n\n- point 16' }]);

    // Nothing moved and nothing was deleted.
    expect(docBullets(doc)).toBe(17);
    expect(bulletsUnder(doc, theirs)).toHaveLength(16);
    expect(bulletsUnder(doc, theirs)).toContain(HUMAN_LINE);
    expect(bulletsUnder(doc, headingIdIn(doc, 'Ferry timetable'))).toEqual(['point 16']);
  });

  test('MUTATION CONTROL: a SECOND heading with the same words still moves nothing', () => {
    // The old failure's exact shape. It was never a delete — the bullets
    // stayed where they were — and what made it a loss was a reader that
    // found the notes by those words. There is no such reader now, so this
    // doc reads exactly as the one above.
    const doc = seededDoc();
    const theirs = headingIdIn(doc, SCRIPT_TOPIC);
    writeFifteenTicks(doc, theirs);
    apply(doc, [{ op: 'insert_at_end', markdown: `## ${SCRIPT_TOPIC}\n\n- point 16` }]);
    expect(docBullets(doc)).toBe(17);
    expect(bulletsUnder(doc, theirs)).toHaveLength(16);
    expect(bulletsUnder(doc, theirs)).toContain(HUMAN_LINE);
  });

  test('the person’s line is never replaced, whatever else is written', () => {
    const doc = seededDoc();
    writeFifteenTicks(doc, headingIdIn(doc, SCRIPT_TOPIC));
    expect(markdown(doc)).toContain(HUMAN_LINE);
  });
});
