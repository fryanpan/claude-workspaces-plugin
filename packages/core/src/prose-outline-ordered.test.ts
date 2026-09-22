/**
 * The outline says which list items are numbered, because a dictated order
 * is structure a flat-run check must not regroup. All text is invented.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getProseFragment } from './prose-fragment.ts';
import { parseMarkdownBlocks } from './prose-markdown.ts';
import { readOutline } from './prose-outline.ts';

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks(markdown));
  return doc;
}

describe('readOutline on a numbered list', () => {
  it('marks a numbered item ordered, and a dash item and its sub-bullet not', () => {
    const doc = docOf(
      [
        '## Page one',
        '',
        '1. List of streets',
        '   - High street first',
        '2. Crew schedule',
        '',
        '- Riverbend note',
      ].join('\n'),
    );
    const items = readOutline(doc)
      .filter((e) => e.kind === 'listItem')
      .map((e) => [e.text, e.ordered === true, e.depth]);
    expect(items).toEqual([
      ['List of streets', true, 0],
      ['High street first', false, 1],
      ['Crew schedule', true, 0],
      ['Riverbend note', false, 0],
    ]);
  });
});
