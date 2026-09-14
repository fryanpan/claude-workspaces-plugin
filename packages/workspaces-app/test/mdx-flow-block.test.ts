import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { summarizeMdx } from '../src/mdx-preview.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

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
      blocks().map((b) => [
        b.dataset.kind,
        [...b.querySelectorAll('.mdx-view > :is(.mdx-head, .mdx-children)')]
          .map((e) => e.textContent)
          .join(''),
      ]),
    ).toEqual([
      ['esm', 'import LineChart, Callout'],
      ['jsx', 'Harborlight ferry riders'],
      ['expr', 'TODO: the October numbers'],
      ['jsx', 'The last sailing moved to 21:30.'],
    ]);
    const line = blocks()[1]?.querySelector('svg.mdx-chart polyline');
    expect(line?.getAttribute('points')?.split(' ')).toHaveLength(3);
    expect(blocks()[3]?.querySelector('svg')).toBeNull();
  });

  it('names a component only when it has nothing else to show', () => {
    mount('<Divider />\n\nAfter the break.\n');
    expect(blocks()[0]?.querySelector('.mdx-view')?.textContent).toBe('Divider');
  });

  for (const vp of [IPAD, PHONE]) {
    it(`sets a chart's title at the doc's subheading size at ${vp.width}px`, () => {
      setViewport(vp);
      open.push(installSheets('styles.css', 'doc.css'));
      mount(`### Riders by month\n\n${POST}`);
      const h3 = styleOf(document.querySelector('.ProseMirror h3') as Element);
      const read = (st: CSSStyleDeclaration) => [st.fontSize, st.fontWeight, st.fontFamily];
      const heading = read(h3);
      expect(read(styleOf(document.querySelector('.mdx-title') as Element))).toEqual(heading);
    });
  }

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

  it('refuses a delete that runs from the prose into part of a component, and takes the whole block', () => {
    const { handle, ydoc } = mount();
    const md = () => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    const before = md();
    handle.editor
      .chain()
      .setTextSelection({ from: posOf(handle, 'climbed'), to: posOf(handle, 'ferry riders') })
      .deleteSelection()
      .run();
    expect(md()).toBe(before);

    let chartEnd = -1;
    handle.editor.state.doc.forEach((n, pos) => {
      if (n.textContent.startsWith('<LineChart')) chartEnd = pos + n.nodeSize;
    });
    handle.editor
      .chain()
      .deleteRange({ from: posOf(handle, 'climbed'), to: chartEnd })
      .run();
    expect(md()).not.toContain('<LineChart');
    expect(md()).toContain('Ridership \n\n{/* TODO');
    expect(md()).toContain('{/* TODO: the October numbers */}');
  });

  it('keeps the browser from typing over a selection that runs into a component', () => {
    const { handle, ydoc } = mount();
    const md = () => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    const before = md();
    const into = { from: posOf(handle, 'climbed'), to: posOf(handle, 'ferry riders') };
    handle.editor.chain().setTextSelection(into).run();
    const typed = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'k',
      bubbles: true,
      cancelable: true,
    });
    handle.editor.view.dom.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(true);
    expect(md()).toBe(before);

    // What ProseMirror reads back if the browser edits the DOM anyway: the
    // paragraph and the whole chart replaced by the paragraph with the
    // chart's source run into it.
    const { state } = handle.editor;
    let chartEnd = -1;
    state.doc.forEach((n, pos) => {
      if (n.textContent.startsWith('<LineChart')) chartEnd = pos + n.nodeSize;
    });
    const para = state.doc.resolve(into.from).before();
    const merged = state.schema.nodes.paragraph?.create(
      null,
      state.schema.text('Ridership <LineChart title="Harborlight ferry riders" />'),
    );
    if (!merged) throw new Error('no paragraph node');
    handle.editor.view.dispatch(state.tr.replaceWith(para, chartEnd, merged));
    expect(md()).toBe(before);
  });

  it('takes typing over a selection that holds a whole component', () => {
    const { handle, ydoc } = mount();
    let chart = { from: -1, to: -1 };
    handle.editor.state.doc.forEach((n, pos) => {
      if (n.textContent.startsWith('<LineChart')) chart = { from: pos, to: pos + n.nodeSize };
    });
    handle.editor
      .chain()
      .setTextSelection({ from: posOf(handle, 'climbed'), to: chart.to })
      .run();
    const typed = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'rose.',
      bubbles: true,
      cancelable: true,
    });
    handle.editor.view.dom.dispatchEvent(typed);
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    expect(md).not.toContain('<LineChart');
    expect(md).toContain('Ridership rose.');
  });

  it('refuses a quote, a list or a heading around a component', () => {
    const { handle, ydoc } = mount();
    const md = () => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    const before = md();
    const inChart = posOf(handle, 'Harborlight');
    const select = () => handle.editor.chain().setTextSelection({ from: inChart, to: inChart + 5 });
    select().toggleBlockquote().run();
    expect(md()).toBe(before);
    select().toggleBulletList().run();
    expect(md()).toBe(before);
    select().setHeading({ level: 2 }).run();
    expect(md()).toBe(before);
    handle.editor
      .chain()
      .setTextSelection({ from: posOf(handle, 'climbed'), to: inChart })
      .toggleBlockquote()
      .run();
    expect(md()).toBe(before);

    // A quote on the prose alone still lands.
    handle.editor.chain().setTextSelection(posOf(handle, 'climbed')).toggleBlockquote().run();
    expect(md()).toContain('> Ridership climbed all year.');
  });

  it('shows the source of a closed component that holds an open comment', async () => {
    const { handle } = mount();
    const from = posOf(handle, 'Harborlight ferry riders');
    const chart = () => blocks()[1];
    expect(chart()?.classList.contains('is-open')).toBe(false);
    handle.setThreadRanges([{ id: 't-chart', from, to: from + 11, status: 'open' }], null);
    await Promise.resolve();
    expect(chart()?.querySelector('.thread-range')).not.toBeNull();
    expect(chart()?.classList.contains('is-open')).toBe(true);

    // Closed by the reader, it stays closed.
    chart()?.querySelector<HTMLElement>('.mdx-view')?.click();
    handle.setThreadRanges([{ id: 't-chart', from, to: from + 12, status: 'open' }], null);
    await Promise.resolve();
    expect(chart()?.classList.contains('is-open')).toBe(false);
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
    const pointsOf = (src: string) => {
      const chart = summarizeMdx(src).chart;
      return chart?.type === 'line' ? chart.series[0]?.points : undefined;
    };
    expect(pointsOf('<Chart data={[{ x: 1, y: 2 }, { "x": 2, y: -3.5e1 }]} />')).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: -35 },
    ]);
    expect(pointsOf('<Chart data={rows} />')).toBeUndefined();
    expect(pointsOf('<Chart data={[{ x: 1, y: fetch("/x") }, { x: 2, y: 3 }]} />')).toBeUndefined();
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
    expect(s.chart?.type === 'line' && s.chart.series[0]?.points).toHaveLength(2);
  });

  it('keeps a __proto__ key as a plain key', () => {
    const s = summarizeMdx(
      '<Chart data={[{ "__proto__": { polluted: true }, x: 1, y: 1 }, { x: 2, y: 2 }]} />',
    );
    expect(s.chart?.type === 'line' && s.chart.series[0]?.points).toHaveLength(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('puts markup-looking text on the page as text', () => {
    mount('<Callout title="<img src=x onerror=alert(1)>">\n  <b>bold</b> words\n</Callout>\n');
    const view = blocks()[0]?.querySelector('.mdx-view');
    expect(view?.querySelector('img, b')).toBeNull();
    expect(view?.querySelector('.mdx-title')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
