import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BLOCK_ID_ATTR,
  findAndReplace,
  getProseFragment,
  insertAfterRange,
  parseMarkdownBlocks,
  promoteImageParagraphs,
  resolveTextRangeFromFind,
  rewriteRange,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

/**
 * A paragraph that holds a standalone image line as its text becomes the
 * image node the parser makes, and the doc serializes to the same text.
 * The agent text edits leave an image node, not the line, when they make one.
 */
const LINE = '![Saltmarsh at dawn](images/saltmarsh_dawn.png)';

function docWith(markdown: string): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(markdown));
  return { doc, fragment };
}

function names(fragment: Y.XmlFragment): string[] {
  return (fragment.toArray() as Y.XmlElement[]).map((b) => b.nodeName);
}

/** A paragraph whose text is `text`, as an in-place edit leaves it. */
function textParagraph(text: string, attrs?: Record<string, unknown>): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text, attrs);
  p.insert(0, [t]);
  return p;
}

describe('promoting an image line held as paragraph text', () => {
  it('turns the paragraph into an image node with the same id and the same bytes', () => {
    const { doc, fragment } = docWith('Riverbend.\n');
    const p = textParagraph(LINE);
    fragment.push([p]);
    p.setAttribute(BLOCK_ID_ATTR, 'b-photo');
    const before = serializeFragmentToMarkdown(fragment);

    let promoted = 0;
    doc.transact(() => {
      promoted = promoteImageParagraphs(doc, fragment);
    });

    expect(promoted).toBe(1);
    const img = fragment.get(1) as Y.XmlElement;
    expect(img.nodeName).toBe('image');
    expect(img.getAttribute('src')).toBe('images/saltmarsh_dawn.png');
    expect(img.getAttribute('alt')).toBe('Saltmarsh at dawn');
    expect(img.getAttribute(BLOCK_ID_ATTR)).toBe('b-photo');
    expect(serializeFragmentToMarkdown(fragment)).toBe(before);
  });

  it('leaves a marked line, a line with other words, and ordinary prose alone', () => {
    const { doc, fragment } = docWith('Riverbend.\n');
    fragment.push([
      textParagraph(LINE, { bold: true }),
      textParagraph(`See ${LINE}`),
      textParagraph('Harborlight ferries.'),
    ]);

    doc.transact(() => promoteImageParagraphs(doc, fragment));

    expect(names(fragment)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
  });
});

describe('the agent text edits', () => {
  it('find-and-replace over a whole paragraph writes an image node', () => {
    const { doc, fragment } = docWith('Riverbend.\n\nPHOTO\n');
    expect(findAndReplace(doc, { find: 'PHOTO', replace: LINE }).ok).toBe(true);
    expect(names(fragment)).toEqual(['paragraph', 'image']);
  });

  it('replace-all writes an image node for each paragraph it fills', () => {
    const { doc, fragment } = docWith('PHOTO\n\nRiverbend.\n\nPHOTO\n');
    expect(findAndReplace(doc, { find: 'PHOTO', replace: LINE, replaceAll: true }).ok).toBe(true);
    expect(names(fragment)).toEqual(['image', 'paragraph', 'image']);
  });

  it('a range rewrite over a whole paragraph writes an image node', () => {
    const { doc, fragment } = docWith('Riverbend.\n\nPHOTO\n');
    const range = resolveTextRangeFromFind(doc, { find: 'PHOTO' });
    if (!range.ok) throw new Error(range.error);
    const res = rewriteRange(doc, {
      startRel: range.startRel,
      endRel: range.endRel,
      replacement: LINE,
    });
    expect(res.ok).toBe(true);
    expect(names(fragment)).toEqual(['paragraph', 'image']);
  });

  it('an insert that completes an image line writes an image node and reports it landed', () => {
    const { doc, fragment } = docWith('Riverbend.\n\n![Saltmarsh at dawn]\n');
    const range = resolveTextRangeFromFind(doc, { find: '![Saltmarsh at dawn]' });
    if (!range.ok) throw new Error(range.error);
    const res = insertAfterRange(doc, {
      endRel: range.endRel,
      text: '(images/saltmarsh_dawn.png)',
    });
    expect(res.ok).toBe(true);
    expect(names(fragment)).toEqual(['paragraph', 'image']);
  });

  it('an edit leaving other words beside the line keeps the paragraph', () => {
    const { doc, fragment } = docWith('Riverbend PHOTO\n');
    expect(findAndReplace(doc, { find: 'PHOTO', replace: LINE }).ok).toBe(true);
    expect(names(fragment)).toEqual(['paragraph']);
  });
});
