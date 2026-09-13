import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { summarizeMdx } from '../src/mdx-preview.ts';
import { installSheets, styleOf } from './css-harness.ts';

/**
 * An `.mdx` component in the doc editor: a quiet block with its name, title
 * and — for literal chart data — a line, whose source opens on a tap, cannot
 * be typed into, and takes a comment like any other words.
 *
 * Driven through the real editor over a Yjs fragment parsed the way the server
 * parses an `.mdx` bound file. Fixtures are fictional.
 */

const POST = `import { LineChart } from '../components/LineChart'
import Callout from '../components/Callout'

Ridership climbed all year.

<LineChart
  title="Harborlight ferry riders"
  data={[
    { x: 1, y: 120 },
    { x: 2, y: 135 },
    { x: 3, y: 128 },
  ]}
/>

{/* TODO: the October numbers */}

<Callout type="note">
  The last sailing moved to 21:30.
</Callout>
`;

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md = POST): { handle: EditorHandle; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: true });
  open.push(() => handle.destroy());
  return { handle, ydoc };
}

const blocks = () => [...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-block')];

/** The document position of `text`'s first character, found in the PM doc. */
function posOf(handle: EditorHandle, text: string): number {
  let at = -1;
  handle.editor.state.doc.descendants((n, pos) => {
    if (at >= 0 || !n.isText) return at < 0;
    const i = (n.text ?? '').indexOf(text);
    if (i >= 0) at = pos + i;
    return false;
  });
  if (at < 0) throw new Error(`no ${text} in the doc`);
  return at;
}

describe('an .mdx block in the editor', () => {
  it('shows each component, comment and import run as its own quiet block', () => {
    mount();
    expect(
      blocks().map((b) => [b.dataset.kind, b.querySelector('.mdx-view')?.textContent]),
    ).toEqual([
      ['esm', 'import LineChart, Callout'],
      ['jsx', 'Harborlight ferry riders'],
      ['expr', 'TODO: the October numbers'],
      ['jsx', 'The last sailing moved to 21:30.'],
    ]);
    const line = blocks()[1]?.querySelector('svg.mdx-preview polyline');
    expect(line?.getAttribute('points')?.split(' ')).toHaveLength(3);
    expect(blocks()[3]?.querySelector('svg')).toBeNull();
  });

  it('names a component only when it has nothing else to show', () => {
    mount('<Divider />\n\nAfter the break.\n');
    expect(blocks()[0]?.querySelector('.mdx-view')?.textContent).toBe('Divider');
  });

  it("sets a chart's title at the doc's subheading size", () => {
    open.push(installSheets('styles.css', 'doc.css'));
    mount(`### Riders by month\n\n${POST}`);
    const h3 = styleOf(document.querySelector('.ProseMirror h3') as Element);
    const title = styleOf(document.querySelector('.mdx-title') as Element);
    expect([title.fontSize, title.fontWeight, title.fontFamily]).toEqual([
      h3.fontSize,
      h3.fontWeight,
      h3.fontFamily,
    ]);
  });

  it('opens the source on a tap and closes it on the next', () => {
    mount();
    const chart = blocks()[1];
    const view = chart?.querySelector<HTMLElement>('.mdx-view');
    expect(chart?.classList.contains('is-open')).toBe(false);
    view?.click();
    expect(chart?.classList.contains('is-open')).toBe(true);
    expect(chart?.querySelector('.mdx-source')?.textContent).toContain('{ x: 2, y: 135 },');
    view?.click();
    expect(chart?.classList.contains('is-open')).toBe(false);
  });

  it('refuses typing inside a component, and still takes it in the prose', () => {
    const { handle, ydoc } = mount();
    const before = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    const inChart = posOf(handle, 'Harborlight');
    handle.editor.chain().setTextSelection(inChart).insertContent('X').run();
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc))).toBe(before);

    handle.editor.chain().setTextSelection(posOf(handle, 'climbed')).insertContent('really ').run();
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc))).toBe(
      before.replace('climbed', 'really climbed'),
    );
  });

  it('takes a comment on words in a component', () => {
    const { handle } = mount();
    const from = posOf(handle, 'Harborlight ferry riders');
    handle.editor.commands.setTextSelection({ from, to: from + 'Harborlight ferry riders'.length });
    const rel = handle.getSelectionRel();
    expect(rel?.snippet).toBe('Harborlight ferry riders');
    expect(rel && handle.resolveRel(rel.start, rel.end)).toEqual({
      from,
      to: from + 'Harborlight ferry riders'.length,
    });
  });

  it('a plain code block is still a code block', () => {
    mount('```ts\nconst a = 1;\n```\n');
    expect(blocks()).toHaveLength(0);
    expect(document.querySelector('.ProseMirror pre code')?.textContent).toBe('const a = 1;');
  });
});

describe('reading a component without running it', () => {
  it('draws only literal x/y data', () => {
    expect(summarizeMdx('<Chart data={[{ x: 1, y: 2 }, { "x": 2, y: -3.5e1 }]} />').points).toEqual(
      [
        { x: 1, y: 2 },
        { x: 2, y: -35 },
      ],
    );
    expect(summarizeMdx('<Chart data={rows} />').points).toBeUndefined();
    expect(
      summarizeMdx('<Chart data={[{ x: 1, y: fetch("/x") }, { x: 2, y: 3 }]} />').points,
    ).toBeUndefined();
    expect(summarizeMdx('<Chart data={[...rows]} title={`t`} />')).toEqual({
      kind: 'jsx',
      label: 'Chart',
    });
  });

  it('finds points under series, and a title after a non-literal prop', () => {
    const s = summarizeMdx(
      `<LineChart\n  format={(v) => v + "}"}\n  series={[{ name: 'Riders', data: [{ x: 0, y: 1 }, { x: 1, y: 4 }] }]}\n  title="Riders"\n/>`,
    );
    expect(s.title).toBe('Riders');
    expect(s.points).toHaveLength(2);
  });

  it('keeps a __proto__ key as a plain key', () => {
    const s = summarizeMdx(
      '<Chart data={[{ "__proto__": { polluted: true }, x: 1, y: 1 }, { x: 2, y: 2 }]} />',
    );
    expect(s.points).toHaveLength(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('puts markup-looking text on the page as text', () => {
    mount('<Callout title="<img src=x onerror=alert(1)>">\n  <b>bold</b> words\n</Callout>\n');
    const view = blocks()[0]?.querySelector('.mdx-view');
    expect(view?.querySelector('img, b')).toBeNull();
    expect(view?.querySelector('.mdx-title')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
