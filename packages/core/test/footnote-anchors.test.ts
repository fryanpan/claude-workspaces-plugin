import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyMarkdownToFragment,
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

/**
 * A comment anchored across a sentence that carries a footnote survives the
 * reparse the file poll runs after every external edit.
 *
 * This is the failure mode a footnote could plausibly have introduced.
 * Anchors are Yjs relative positions into a block's `Y.XmlText`, and the
 * reparse rebuilds only the blocks whose markdown changed. A note parsed as
 * its own delta op is still the same characters in the same text — but if
 * the parser ever split a note differently on the way back in, the block
 * would come out unequal, be rebuilt, and every thread over it would orphan.
 * So the test anchors ACROSS a note and then reparses the identical text and
 * an edit to a different paragraph.
 */

const DOC = [
  'A permit takes 94 days^[Planning Department annual report, 2025, table 4.] on paper.',
  '',
  'Two reviewers serve the whole city.',
  '',
].join('\n');

function docWith(md: string): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(md));
  return { doc, fragment };
}

/** The offsets of "94 days^[…] on paper" inside the first block. */
function anchorSpan(text: Y.XmlText): { start: Y.RelativePosition; end: Y.RelativePosition } {
  const s = text.toString();
  const from = s.indexOf('94 days');
  const to = s.indexOf(' on paper.') + ' on paper.'.length;
  return {
    start: Y.createRelativePositionFromTypeIndex(text, from),
    end: Y.createRelativePositionFromTypeIndex(text, to),
  };
}

describe('a comment anchored over a footnote', () => {
  it('still resolves after a reparse that changes another paragraph', () => {
    const { doc, fragment } = docWith(DOC);
    const block = fragment.get(0) as Y.XmlElement;
    const text = block.get(0) as Y.XmlText;
    const { start, end } = anchorSpan(text);
    const quoted = text
      .toString()
      .slice(
        Y.createAbsolutePositionFromRelativePosition(start, doc)?.index ?? 0,
        Y.createAbsolutePositionFromRelativePosition(end, doc)?.index ?? 0,
      );

    const changed = applyMarkdownToFragment(fragment, DOC.replace('whole city', 'whole county'));

    expect(changed).toBe(true);
    // The block the anchor lives in was not rebuilt…
    expect(fragment.get(0)).toBe(block);
    // …and the anchor still names the same words, footnote and all.
    const from = Y.createAbsolutePositionFromRelativePosition(start, doc);
    const to = Y.createAbsolutePositionFromRelativePosition(end, doc);
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    expect(text.toString().slice(from?.index ?? 0, to?.index ?? 0)).toBe(quoted);
    expect(quoted).toContain('^[Planning Department annual report, 2025, table 4.]');
  });

  it('reads a reparse of the identical text as no change at all', () => {
    const { fragment } = docWith(DOC);
    const block = fragment.get(0);
    expect(applyMarkdownToFragment(fragment, DOC)).toBe(false);
    expect(fragment.get(0)).toBe(block);
    expect(serializeFragmentToMarkdown(fragment)).toBe(DOC);
  });
});
