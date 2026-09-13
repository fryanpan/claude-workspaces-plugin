import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  normalizeMarkdown,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
  serializeKeepingSource,
} from '../src/prose.ts';

/**
 * `serializeKeepingSource` is what a bound file's write-back writes: the
 * source's own bytes for every block the live doc still holds unchanged, the
 * serializer's for the rest, and never anything that parses differently from
 * the plain serializer.
 */
function docOf(markdown: string): Y.XmlFragment {
  const fragment = getProseFragment(new Y.Doc());
  fragment.push(parseMarkdownBlocks(markdown));
  return fragment;
}

const SOURCE = `import A from './a'
import B from './b'

Para one
wrapped.

* star
    * deep

Para two.
`;

describe('serializeKeepingSource', () => {
  it('returns the source unchanged when nothing was edited', () => {
    expect(serializeKeepingSource(docOf(SOURCE), SOURCE)).toBe(SOURCE);
  });

  it('keeps the untouched blocks and their gaps around an inserted block', () => {
    const live = docOf(`${SOURCE.replace('Para two.', 'New para.\n\nPara two.')}`);
    expect(serializeKeepingSource(live, SOURCE)).toBe(
      SOURCE.replace('Para two.', 'New para.\n\nPara two.'),
    );
  });

  it('drops a deleted block and keeps its neighbours byte for byte', () => {
    const live = docOf(SOURCE.replace('* star\n    * deep\n\n', ''));
    expect(serializeKeepingSource(live, SOURCE)).toBe(SOURCE.replace('* star\n    * deep\n\n', ''));
  });

  it('keeps a missing trailing newline, and blank lines ahead of the first block', () => {
    const source = '\n\nOnly para\nwrapped';
    expect(serializeKeepingSource(docOf(source), source)).toBe(source);
  });

  it('writes plain serializer output when there is no source or it has CRLF line ends', () => {
    const live = docOf(SOURCE);
    const plain = serializeFragmentToMarkdown(live);
    expect(plain).not.toBe(SOURCE);
    expect(serializeKeepingSource(live, undefined)).toBe(plain);
    expect(serializeKeepingSource(live, SOURCE.replace(/\n/g, '\r\n'))).toBe(plain);
  });

  it('a stale source changes formatting only, never content', () => {
    const live = docOf('# Heading\n\nFresh text.\n');
    const out = serializeKeepingSource(live, SOURCE);
    expect(normalizeMarkdown(out)).toBe(serializeFragmentToMarkdown(live));
  });

  it('keeps the source around an edit in a doc too long for a whole-doc LCS', () => {
    // 2,100 blocks squared is past the diff table's budget; only the run
    // between the first and last difference should need the table.
    const source = Array.from({ length: 2100 }, (_, i) => `Para ${i}\nwrapped.`).join('\n\n');
    const edited = source.replace('Para 1050\nwrapped.', 'Para 1050 edited.');
    expect(serializeKeepingSource(docOf(edited), source)).toBe(edited);
  });

  it('nests a list under an ordered item past the marker width', () => {
    expect(serializeFragmentToMarkdown(docOf('1. one\n  - child\n10. ten\n  - child\n'))).toBe(
      '1. one\n   - child\n2. ten\n   - child\n',
    );
  });
});
