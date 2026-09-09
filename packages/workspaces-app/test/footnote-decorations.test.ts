import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * A `^[…]` note as the reader meets it in the editor: the raw characters
 * folded away behind a number, and the words the note supports underlined.
 *
 * Everything here is a decoration, so the test drives the real editor and
 * reads the rendered DOM. Nothing may reach the document itself — the
 * serialized markdown after a render must be the markdown that went in, or
 * the next write-back changes the author's file.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md: string): { editor: EditorHandle; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push(() => editor.destroy());
  return { editor, ydoc };
}

const notes = () => [...document.querySelectorAll<HTMLElement>('.cw-fn')];
const facts = () => [...document.querySelectorAll<HTMLElement>('.cw-fn-fact')];

const DOC = [
  'A permit takes 94 days^[Planning Department annual report, 2025, table 4.],',
  'and about a third of that waits^[Estimate from three applicants. Unconfirmed.].',
].join(' ');

describe('a footnote in the editor', () => {
  it('numbers every note in document order', () => {
    mount(`${DOC}\n\nTwo reviewers serve the city^[Staffing page, 2 Sep 2026.].`);
    expect(notes().map((el) => el.dataset.cwFn)).toEqual(['1', '2', '3']);
  });

  it('carries the note text out of the prose, where the margin can read it', () => {
    mount(DOC);
    expect(notes()[0]?.dataset.cwFnNote).toBe('Planning Department annual report, 2025, table 4.');
  });

  it('marks the note the author did not confirm, and only that one', () => {
    mount(DOC);
    expect(notes().map((el) => el.dataset.cwFnUnsure)).toEqual([undefined, '']);
  });

  it('underlines the fact each note is about, not the whole paragraph', () => {
    mount(DOC);
    expect(facts().map((el) => el.textContent)).toEqual([
      'A permit takes 94 days',
      'about a third of that waits',
    ]);
    expect(facts().map((el) => el.dataset.cwFnFor)).toEqual(['1', '2']);
  });

  it('marks the unsure fact so the underline can differ', () => {
    mount(DOC);
    expect(facts().map((el) => el.classList.contains('cw-fn-fact-unsure'))).toEqual([false, true]);
  });

  it('leaves the document itself untouched', () => {
    const { ydoc } = mount(DOC);
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc))).toBe(`${DOC}\n`);
  });

  it('finds a note in a list item and in a blockquote', () => {
    mount('- Bring the checklist^[Submittal guide, rev. 3.]\n\n> Two reviewers^[Staffing page.]');
    expect(notes().map((el) => el.dataset.cwFn)).toEqual(['1', '2']);
  });

  it('follows the text when the paragraph before it grows', () => {
    const { editor } = mount(DOC);
    editor.editor.commands.insertContentAt(1, 'Filed in March. ');
    expect(notes()[0]?.textContent).toBe('^[Planning Department annual report, 2025, table 4.]');
    expect(facts()[0]?.textContent).toBe('A permit takes 94 days');
  });

  it('opens the raw note when the caret is inside it, and folds it again after', () => {
    const { editor } = mount(DOC);
    const el = notes()[0];
    if (!el) throw new Error('no footnote rendered');
    const from = editor.editor.view.posAtDOM(el.firstChild ?? el, 0);
    editor.editor.commands.setTextSelection(from + 3);
    expect(notes()[0]?.classList.contains('cw-fn-open')).toBe(true);
    editor.editor.commands.setTextSelection(1);
    expect(notes()[0]?.classList.contains('cw-fn-open')).toBe(false);
  });

  it('leaves a `^[…]` inside a code span alone — it is documentation, not a note', () => {
    mount('Write `^[a note]` to add one, and the characters stay text.');
    expect(notes()).toHaveLength(0);
    expect(facts()).toHaveLength(0);
  });

  it('reads the same characters outside a code span as a real note (control)', () => {
    mount('Write ^[a note] to add one, and the characters stay text.');
    expect(notes().map((el) => el.dataset.cwFnNote)).toEqual(['a note']);
  });

  it('draws nothing for prose with no notes (control)', () => {
    mount('A permit takes 94 days on paper, and nobody has measured the rest.');
    expect(notes()).toHaveLength(0);
    expect(facts()).toHaveLength(0);
  });
});
