import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BLOCK_ID_ATTR } from '../src/prose-identity.ts';
import {
  MDX_FLOW_LANGUAGE,
  getProseFragment,
  parseMarkdownBlocks,
  retypeMdxParagraphs,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';
import { SUGGEST_DELETE_MARK } from '../src/suggest.ts';

/**
 * A doc parsed before the MDX grammar holds its components as paragraphs.
 * Re-typing turns each into the block the grammar makes, in place, and the
 * doc serializes to exactly the text it did before.
 */
const LEGACY = `import { LineChart } from '../components/LineChart'
import Chart from '../components/Chart'

# Riverbend ferries

<Chart title="Saltmarsh crossings" data={[ { x: 1, y: 40 } ]} />

{/* TODO: the spring numbers */}

<Badge>new</Badge> permits launch first.

Ridership climbed all year.
`;

function legacyDoc(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(LEGACY));
  return { doc, fragment };
}

function summary(fragment: Y.XmlFragment): string[] {
  return (fragment.toArray() as Y.XmlElement[]).map((b) =>
    b.getAttribute('language') === MDX_FLOW_LANGUAGE
      ? `mdx:${b
          .toArray()
          .map((t) => t.toString())
          .join('')}`
      : b.nodeName,
  );
}

describe('re-typing an .mdx doc read as paragraphs', () => {
  it('turns each component, expression and import run into a block, keeping the text', () => {
    const { doc, fragment } = legacyDoc();
    const before = serializeFragmentToMarkdown(fragment);

    let retyped = 0;
    doc.transact(() => {
      retyped = retypeMdxParagraphs(fragment);
    });

    expect(retyped).toBe(3);
    expect(summary(fragment)).toEqual([
      "mdx:import { LineChart } from '../components/LineChart' import Chart from '../components/Chart'",
      'heading',
      'mdx:<Chart title="Saltmarsh crossings" data={[ { x: 1, y: 40 } ]} />',
      'mdx:{/* TODO: the spring numbers */}',
      'paragraph',
      'paragraph',
    ]);
    expect(serializeFragmentToMarkdown(fragment)).toBe(before);
    // A second pass has nothing left to do.
    expect(retypeMdxParagraphs(fragment)).toBe(0);
  });

  it('keeps the block id an outline handed out', () => {
    const { doc, fragment } = legacyDoc();
    const chart = fragment.get(2) as Y.XmlElement;
    chart.setAttribute(BLOCK_ID_ATTR, 'b-chart');

    doc.transact(() => retypeMdxParagraphs(fragment));

    const now = fragment.get(2) as Y.XmlElement;
    expect(now.getAttribute('language')).toBe(MDX_FLOW_LANGUAGE);
    expect(now.getAttribute(BLOCK_ID_ATTR)).toBe('b-chart');
  });

  it('leaves a paragraph that carries a pending suggestion as it is', () => {
    const { doc, fragment } = legacyDoc();
    const chart = fragment.get(2) as Y.XmlElement;
    const text = chart.get(0) as Y.XmlText;
    doc.transact(() => {
      text.format(1, 5, { [SUGGEST_DELETE_MARK]: { id: 's-1', author: 'a-editor' } });
    });

    doc.transact(() => retypeMdxParagraphs(fragment));

    expect(fragment.get(2)).toBe(chart);
    expect(chart.nodeName).toBe('paragraph');
  });
});
