import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { setSuggesting } from '../src/suggest-input.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * A ```choice block in the doc editor: a row of buttons whose tap writes the
 * pick into the block's text in the Yjs doc, and from there into the markdown.
 * Driven through the real editor over a fragment parsed the way the server
 * parses a bound file. Fixtures are fictional.
 */

const DOC = [
  '## Riverbend',
  '',
  '```choice',
  'id=lead-riverbend options="yes,maybe,no"',
  '```',
  '',
  '## Saltmarsh',
  '',
  '```choice',
  'id=lead-saltmarsh options="yes,maybe,no" picked=no',
  '```',
  '',
].join('\n');

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(editable = true, md = DOC): { handle: EditorHandle; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable });
  open.push(() => handle.destroy());
  return { handle, ydoc };
}

const markdown = (ydoc: Y.Doc) => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

function button(id: string, option: string): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>(
    `.choice-row[data-choice-id="${id}"] .choice-option[data-option="${option}"]`,
  );
  if (!b) throw new Error(`no ${option} button on ${id}`);
  return b;
}

const pressed = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(`.choice-row[data-choice-id="${id}"] .choice-option`)]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.dataset.option);

describe('a choice block in the editor', () => {
  it('draws one button per option and marks the pick', () => {
    mount();
    const labels = [...document.querySelectorAll('.choice-block')].map((b) =>
      [...b.querySelectorAll('.choice-option')].map((o) => o.textContent),
    );
    expect(labels).toEqual([
      ['yes', 'maybe', 'no'],
      ['yes', 'maybe', 'no'],
    ]);
    expect(pressed('lead-riverbend')).toEqual([]);
    expect(pressed('lead-saltmarsh')).toEqual(['no']);
  });

  it('a tap writes the pick into the doc, and a tap on the pick clears it', () => {
    const { ydoc } = mount();
    button('lead-riverbend', 'yes').click();
    expect(markdown(ydoc)).toContain('id=lead-riverbend options="yes,maybe,no" picked=yes\n');
    expect(pressed('lead-riverbend')).toEqual(['yes']);

    button('lead-riverbend', 'maybe').click();
    expect(markdown(ydoc)).toContain('id=lead-riverbend options="yes,maybe,no" picked=maybe\n');

    button('lead-riverbend', 'maybe').click();
    expect(markdown(ydoc)).toBe(DOC);
    expect(pressed('lead-riverbend')).toEqual([]);
  });

  it('a pick that arrives from elsewhere redraws the buttons', () => {
    const { ydoc } = mount();
    const block = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[])[1];
    const text = block?.get(0) as Y.XmlText;
    ydoc.transact(() => {
      const next = prose.setChoicePick(text.toString(), 'maybe');
      text.delete(0, text.length);
      text.insert(0, next);
    });
    expect(pressed('lead-riverbend')).toEqual(['maybe']);
  });

  it('a reader who cannot write sees the pick and cannot change it', () => {
    const { ydoc } = mount(false);
    expect(pressed('lead-saltmarsh')).toEqual(['no']);
    button('lead-saltmarsh', 'yes').click();
    expect(markdown(ydoc)).toBe(DOC);
  });

  it('a pick is a direct edit even while Suggesting is on', () => {
    const { handle, ydoc } = mount();
    setSuggesting(handle.editor.view, {
      on: true,
      author: { id: 'u-harborlight', name: 'Harborlight', color: '#2e7dd7' },
    });
    button('lead-riverbend', 'no').click();
    expect(markdown(ydoc)).toContain('id=lead-riverbend options="yes,maybe,no" picked=no\n');
  });

  it('a block that names no option shows its source', () => {
    mount(true, '```choice\nid=empty\n```\n');
    const block = document.querySelector('.choice-block');
    expect(block?.classList.contains('is-choice')).toBe(false);
    expect(block?.querySelectorAll('.choice-option').length).toBe(0);
    expect(block?.querySelector('.choice-source')?.textContent).toBe('id=empty');
  });

  for (const vp of [IPAD, PHONE]) {
    it(`a button is a 44px target and keeps its box when picked at ${vp.width}px`, () => {
      setViewport(vp);
      open.push(installSheets('styles.css', 'doc.css'));
      mount();
      const box = (b: Element) => {
        const st = styleOf(b);
        return [st.minWidth, st.minHeight, st.padding, st.borderWidth, st.font];
      };
      const picked = button('lead-saltmarsh', 'no');
      const other = button('lead-saltmarsh', 'yes');
      expect(styleOf(other).minHeight).toBe('44px');
      expect(box(picked)).toEqual(box(other));
      expect(styleOf(picked).borderColor).not.toBe(styleOf(other).borderColor);
    });
  }
});
