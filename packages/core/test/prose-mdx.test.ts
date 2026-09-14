import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MDX_FLOW_LANGUAGE,
  applyMarkdownToFragment,
  getProseFragment,
  normalizeMarkdown,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
  serializeKeepingSource,
} from '../src/prose.ts';

/**
 * In an `.mdx` file a JSX component, a `{…}` expression and an import/export
 * run are each ONE block holding its exact source, so the editor can show a
 * twenty-line chart as a chart rather than a paragraph of raw props, and the
 * write-back hands its bytes back untouched.
 */
const CHART = `<LineChart
  title="Harborlight ferry riders"
  series={[{ name: 'Riders', color: '#3b82f6' }]}
  data={[
    { x: 1, y: 120 },

    { x: 2, y: 135 },
  ]}
/>`;

const POST = `---
title: Ferries
---

import { LineChart } from '../components/LineChart'
import Callout from '../components/Callout'

# A year of Harborlight ferries

Ridership climbed all year.

${CHART}

{/* TODO: the October numbers, once they're in */}

<Callout type="note">
  The last sailing moved to 21:30 — don't miss it.

  - even a list inside
</Callout>

- Evening sailings
  - 21:30 from Riverbend

The next post looks at where those riders went.
`;

function docOf(markdown: string, mdx = true): Y.XmlFragment {
  const fragment = getProseFragment(new Y.Doc());
  fragment.push(parseMarkdownBlocks(markdown, { mdx }));
  return fragment;
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

describe('parsing an .mdx file', () => {
  it('holds each component, expression and import run as one block of its exact source', () => {
    expect(summary(docOf(POST))).toEqual([
      'codeBlock',
      `mdx:import { LineChart } from '../components/LineChart'\nimport Callout from '../components/Callout'`,
      'heading',
      'paragraph',
      `mdx:${CHART}`,
      `mdx:{/* TODO: the October numbers, once they're in */}`,
      `mdx:<Callout type="note">\n  The last sailing moved to 21:30 — don't miss it.\n\n  - even a list inside\n</Callout>`,
      'bulletList',
      'paragraph',
    ]);
  });

  it('leaves a plain .md parse exactly as it was', () => {
    expect(summary(docOf(POST, false))).not.toContain(`mdx:${CHART}`);
    expect(summary(docOf(POST, false))).toContain('paragraph');
    expect(
      (docOf(POST, false).toArray() as Y.XmlElement[]).some(
        (b) => b.getAttribute('language') === MDX_FLOW_LANGUAGE,
      ),
    ).toBe(false);
  });

  it('reads inline JSX and an unclosed tag as prose', () => {
    expect(summary(docOf('<Badge>new</Badge> permits launch first.\n'))).toEqual(['paragraph']);
    expect(summary(docOf('<Chart title="x"\n\nMore words.\n'))).toEqual(['paragraph', 'paragraph']);
    expect(summary(docOf('{ unbalanced\n'))).toEqual(['paragraph']);
  });

  it('closes a fragment, a nested element and a brace inside a string', () => {
    const src = `<>\n  <Row label="}">\n    <Cell value={"<"} />\n  </Row>\n</>`;
    expect(summary(docOf(`${src}\n\nAfter.\n`))).toEqual([`mdx:${src}`, 'paragraph']);
  });

  it('keeps an export whose body holds a blank line in one block', () => {
    const fn = `export function Fare({ zone }) {\n  const base = 3;\n\n  return base + zone; // "}" is text\n}`;
    const meta = "export const meta = {\n  title: 'Ferries',\n\n  tags: [`transit`],\n}";
    expect(summary(docOf(`${fn}\n\n${meta}\n\nAfter.\n`))).toEqual([
      `mdx:${fn}`,
      `mdx:${meta}`,
      'paragraph',
    ]);
    // A bracket that never closes ends the run at its first blank line.
    expect(summary(docOf('export const broken = {\n\nAfter.\n'))).toEqual([
      'mdx:export const broken = {',
      'paragraph',
    ]);
  });
});

describe('writing an .mdx file back', () => {
  it('serializes to the source byte for byte', () => {
    expect(serializeKeepingSource(docOf(POST), POST, { mdx: true })).toBe(POST);
    // The plain serializer writes every component's own lines too.
    const plain = serializeFragmentToMarkdown(docOf(POST));
    expect(plain).toContain(CHART);
    expect(normalizeMarkdown(plain, { mdx: true })).toBe(plain);
  });

  it('keeps a component byte-identical when the prose beside it is edited', () => {
    const edited = POST.replace('Ridership climbed all year.', 'Ridership doubled.');
    const live = docOf(edited);
    expect(serializeKeepingSource(live, POST, { mdx: true })).toBe(edited);
  });

  it('turns a doc parsed before the MDX grammar into blocks on a reparse', () => {
    const fragment = docOf(POST, false);
    expect(applyMarkdownToFragment(fragment, POST, { mdx: true })).toBe(true);
    expect(summary(fragment)).toEqual(summary(docOf(POST)));
  });
});
