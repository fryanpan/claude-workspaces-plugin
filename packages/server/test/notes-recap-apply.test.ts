/**
 * The shaped recap written into a real Y.Doc at the meeting's stop: what
 * moves, which ids survive, and what makes it leave the section alone.
 *
 * All notes are invented; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyRecapShape } from '../src/notes-recap-apply.ts';
import { RECAP_ACTIONS_HEADING } from '../src/notes-recap-shape.ts';

const AUTHOR = 'meeting-notes';

function docOf(markdown: string, author: string | undefined = AUTHOR): Y.Doc {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.insert(0, prose.parseMarkdownBlocks(markdown));
  prose.ensureBlockIds(ydoc);
  if (author !== undefined) {
    for (const el of fragment.toArray()) {
      if (el instanceof Y.XmlElement) prose.claimSubtree(el, author);
    }
  }
  return ydoc;
}

const markdownOf = (ydoc: Y.Doc): string =>
  prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

const idOf = (ydoc: Y.Doc, text: string): string | undefined =>
  prose.readOutline(ydoc).find((e) => e.text === text)?.id;

const NOTES = [
  '# Harbour review',
  '',
  'Written by Alice before the meeting.',
  '',
  '### Ferry timetable',
  '',
  '- Winter timetable starts in December',
  '- Weekend plans',
  '  - Saturday sailings drop to two',
  '    - Bob will tell the Harborlight crew by Friday',
  '',
  '### Slipway costs',
  '',
  '- Slipway quote from Riverbend came in high',
  '- Winter timetable draft goes to the crews next week',
  '',
].join('\n');

/** The doc with the title and the paragraph above the meeting left as a
 *  person's, and the meeting's section claimed by the note-taker. */
function meetingDoc(): { ydoc: Y.Doc; section: string } {
  const ydoc = docOf(NOTES);
  const top = prose.getProseFragment(ydoc).toArray() as Y.XmlElement[];
  for (const el of top.slice(0, 2)) el.removeAttribute(prose.BLOCK_AUTHOR_ATTR);
  const section = idOf(ydoc, 'Ferry timetable');
  if (section === undefined) throw new Error('no section heading');
  return { ydoc, section };
}

describe('the recap shaped at the stop', () => {
  it('rewrites the section: actions first, late point home, two levels', () => {
    const { ydoc, section } = meetingDoc();
    const kept = idOf(ydoc, 'Slipway quote from Riverbend came in high');
    const result = applyRecapShape(ydoc, section, [], {
      author: AUTHOR,
      commented: () => new Set(),
    });
    expect(result.applied).toBe(true);
    const out = markdownOf(ydoc);
    expect(out).toContain('Written by Alice before the meeting.');
    const headings = prose
      .readOutline(ydoc)
      .filter((e) => e.kind === 'heading')
      .map((e) => e.text);
    expect(headings).toEqual([
      'Harbour review',
      RECAP_ACTIONS_HEADING,
      'Ferry timetable',
      'Slipway costs',
    ]);
    // The heading store's id now opens the section, and a surviving bullet
    // kept its own.
    expect(idOf(ydoc, RECAP_ACTIONS_HEADING)).toBe(section);
    expect(idOf(ydoc, 'Slipway quote from Riverbend came in high')).toBe(kept);
    expect(out.indexOf('Winter timetable draft goes to the crews next week')).toBeLessThan(
      out.indexOf('### Slipway costs'),
    );
    expect(out).not.toMatch(/^ {4,}[-*]/m);
    for (const block of prose.readOutline(ydoc).slice(2)) {
      const el = prose.findBlockById(prose.getProseFragment(ydoc), block.id);
      if (el) expect(prose.readBlockAuthor(el)).toBe(AUTHOR);
    }
  });

  it('leaves the section alone when a bullet in it has a comment', () => {
    const { ydoc, section } = meetingDoc();
    const before = markdownOf(ydoc);
    const commentedId = idOf(ydoc, 'Winter timetable starts in December') ?? '';
    const result = applyRecapShape(ydoc, section, [], {
      author: AUTHOR,
      commented: () => new Set([commentedId]),
    });
    expect(result).toEqual({ applied: false, reason: 'commented' });
    expect(markdownOf(ydoc)).toBe(before);
  });

  it('leaves the section alone when a person wrote a line in it', () => {
    const { ydoc, section } = meetingDoc();
    const before = markdownOf(ydoc);
    const id = idOf(ydoc, 'Slipway quote from Riverbend came in high') ?? '';
    const el = prose.findBlockById(prose.getProseFragment(ydoc), id);
    el?.removeAttribute(prose.BLOCK_AUTHOR_ATTR);
    const result = applyRecapShape(ydoc, section, [], {
      author: AUTHOR,
      commented: () => new Set(),
    });
    expect(result).toEqual({ applied: false, reason: 'person' });
    expect(markdownOf(ydoc)).toBe(before);
  });
});
