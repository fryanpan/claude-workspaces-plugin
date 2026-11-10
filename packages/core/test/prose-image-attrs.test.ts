import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  parseMarkdownBlocks,
  promoteImageParagraphs,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

/**
 * An image line may carry a display width, `{width=480}`, and footnotes,
 * `^[…]`, after its closing paren. Both parse into the image node, so the
 * picture renders, and both serialize back to the same bytes, so the file on
 * disk does not change when the doc writes back.
 *
 * Fixtures are synthetic. The repo is public.
 */
function blocksOf(markdown: string): Y.XmlElement[] {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(markdown));
  return fragment.toArray() as Y.XmlElement[];
}

function roundTrip(markdown: string): string {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(markdown));
  return serializeFragmentToMarkdown(fragment);
}

describe('an image line with a display width', () => {
  it('parses to an image node carrying the width', () => {
    const [img] = blocksOf('![Riverbend tides](img/tides.png){width=480}\n');
    expect(img?.nodeName).toBe('image');
    expect(img?.getAttribute('src')).toBe('img/tides.png');
    expect(img?.getAttribute('alt')).toBe('Riverbend tides');
    expect(img?.getAttribute('width')).toBe(480);
  });

  it('round-trips byte for byte, with and without a title', () => {
    for (const line of [
      '![Riverbend tides](img/tides.png){width=480}',
      '![Riverbend tides](img/tides.png "Tides"){width=320}',
    ]) {
      expect(roundTrip(`# Riverbend\n\n${line}\n\nEnd.\n`)).toBe(
        `# Riverbend\n\n${line}\n\nEnd.\n`,
      );
    }
  });

  it('a width that is not a whole number of pixels stays text', () => {
    const [p] = blocksOf('![a](b.png){width=wide}\n');
    expect(p?.nodeName).toBe('paragraph');
  });
});

describe('an image line followed by a footnote', () => {
  const LINE = '![Harborlight pier](img/pier.png)^[Survey photo, 2024.]';

  it('renders as an image, and the footnote is kept on the node', () => {
    const [img] = blocksOf(`${LINE}\n`);
    expect(img?.nodeName).toBe('image');
    expect(img?.getAttribute('src')).toBe('img/pier.png');
    expect(img?.getAttribute('footnotes')).toBe('^[Survey photo, 2024.]');
  });

  it('round-trips byte for byte, with a width and with two notes', () => {
    for (const line of [
      LINE,
      '![Harborlight pier](img/pier.png){width=480}^[Survey photo.]',
      '![Harborlight pier](img/pier.png)^[One.]^[Two, with [a link](https://example.com).]',
    ]) {
      expect(roundTrip(`Above.\n\n${line}\n\nBelow.\n`)).toBe(`Above.\n\n${line}\n\nBelow.\n`);
    }
  });

  it('an image followed by words, not a note, is still prose', () => {
    const [p] = blocksOf('![a](b.png) and some words\n');
    expect(p?.nodeName).toBe('paragraph');
  });

  it('a paragraph an edit left holding such a line is promoted to the image', () => {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText(LINE)]);
    fragment.push([p]);
    doc.transact(() => promoteImageParagraphs(doc, fragment));
    const img = fragment.get(0) as Y.XmlElement;
    expect(img.nodeName).toBe('image');
    expect(img.getAttribute('footnotes')).toBe('^[Survey photo, 2024.]');
    expect(serializeFragmentToMarkdown(fragment)).toBe(`${LINE}\n`);
  });
});
