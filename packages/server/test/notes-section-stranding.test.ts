import { describe, expect, test } from 'bun:test';
/**
 * The stranding this file pins is the one that cost the most measured ideas,
 * and it is not a delete: nothing is ever removed from the doc.
 *
 * On a doc that already carries a `## Meeting notes` heading, a meeting that
 * has opened no section of its own writes its bullets under the heading that
 * is there. When it later opens its own section, both readers of a notes
 * section — `notesSectionStart` in the client and the server's finder — take
 * the LAST heading with that text, so everything written in that window stops
 * being in the notes while staying in the doc.
 *
 * Traced on AMI fixture ES2003c under `scripts/notes-eval.ts`: the section
 * grew to 23 bullets over fifteen ticks, and at tick 16 it read 0 while the
 * whole doc read 26.
 *
 * The MUTATION CONTROL is the first test in each pair. It replays the traced
 * tick order against a doc with the seeded heading and asserts the strand
 * happens, so the guarded assertions below are not passing vacuously.
 */
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { MEETING_NOTES_HEADING } from '../src/notes-doc-access.ts';
import { sectionBody } from './notes-doc-helpers.ts';

const AUTHOR = 'notes-agent';
const WHO = {
  author: AUTHOR,
  suggestionAuthor: { id: AUTHOR, name: 'Note-taker', color: '#888888' },
};
const HUMAN_LINE = 'my own note: check this against the brief before we commit';

/** A doc as a meeting finds it: somebody's notes heading, and their line. */
function seededDoc(): Y.Doc {
  const doc = new Y.Doc();
  prose.applyMarkdownToFragment(
    prose.getProseFragment(doc),
    `## ${MEETING_NOTES_HEADING}\n\n- ${HUMAN_LINE}\n`,
  );
  prose.ensureBlockIds(doc);
  return doc;
}

function headingIdIn(doc: Y.Doc): string {
  const found = prose
    .readOutline(doc)
    .filter((e) => e.kind === 'heading' && e.text.trim() === MEETING_NOTES_HEADING);
  const last = found[found.length - 1];
  if (!last) throw new Error('no notes heading');
  return last.id;
}

function apply(doc: Y.Doc, edits: readonly prose.BlockEdit[]): void {
  prose.applyBlockEdits(doc, [...edits], WHO);
}

/** How many bullets a reader of the notes would see. */
function notesBullets(doc: Y.Doc): number {
  return sectionBody(doc, MEETING_NOTES_HEADING)
    .split('\n')
    .filter((l) => l.trim().startsWith('-')).length;
}

/** How many bullets are anywhere in the doc. */
function docBullets(doc: Y.Doc): number {
  return prose
    .serializeFragmentToMarkdown(prose.getProseFragment(doc))
    .split('\n')
    .filter((l) => l.trim().startsWith('-')).length;
}

/** Fifteen ticks of bullets written under whatever heading is offered. */
function writeFifteenTicks(doc: Y.Doc, headingId: string): void {
  for (let tick = 1; tick <= 15; tick++) {
    apply(doc, [
      { op: 'insert_under_heading', headingId, markdown: `- point ${tick} from the meeting` },
    ]);
  }
}

describe('a meeting that writes before it opens its own section', () => {
  test('MUTATION CONTROL: the bullets leave the notes when the second section appears', () => {
    const doc = seededDoc();
    // The window: fifteen ticks written under the heading that was there.
    writeFifteenTicks(doc, headingIdIn(doc));
    expect(notesBullets(doc)).toBe(16); // fifteen, plus the person's line
    // Tick sixteen opens the meeting's own section, exactly as the composer
    // is asked to when it has none.
    apply(doc, [
      {
        op: 'insert_at_end',
        markdown: `## ${MEETING_NOTES_HEADING}\n\n- point 16 from the meeting`,
      },
    ]);
    // Nothing was deleted — the doc still holds every line.
    expect(docBullets(doc)).toBe(17);
    // And the notes hold one of them.
    expect(notesBullets(doc)).toBe(1);
    // Including the person's own line, which is now invisible to every reader.
    expect(sectionBody(doc, MEETING_NOTES_HEADING)).not.toContain(HUMAN_LINE);
  });

  test('opening the section FIRST leaves nothing behind to strand', () => {
    const doc = seededDoc();
    // What the fix does: the section is opened before the first bullet.
    apply(doc, [{ op: 'insert_at_end', markdown: `## ${MEETING_NOTES_HEADING}` }]);
    const own = headingIdIn(doc);
    writeFifteenTicks(doc, own);
    // Every bullet the meeting wrote is in the notes a reader sees.
    expect(notesBullets(doc)).toBe(15);
    expect(docBullets(doc)).toBe(16);
    // A later tick opening nothing changes nothing.
    apply(doc, [{ op: 'insert_under_heading', headingId: own, markdown: '- point 16' }]);
    expect(notesBullets(doc)).toBe(16);
  });

  test('the person’s earlier section keeps every line it had', () => {
    // The owner's rule: a new recording never replaces what is already
    // written. It does not, and this is the assertion that says so.
    const doc = seededDoc();
    apply(doc, [{ op: 'insert_at_end', markdown: `## ${MEETING_NOTES_HEADING}` }]);
    writeFifteenTicks(doc, headingIdIn(doc));
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(doc))).toContain(HUMAN_LINE);
  });

  test('two sections still read as two, so nothing here hides a restart', () => {
    const doc = seededDoc();
    apply(doc, [{ op: 'insert_at_end', markdown: `## ${MEETING_NOTES_HEADING}` }]);
    const sections = prose
      .readOutline(doc)
      .filter((e) => e.kind === 'heading' && e.text.trim() === MEETING_NOTES_HEADING);
    expect(sections).toHaveLength(2);
  });
});
