import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { footnoteRuns } from '../src/doc/footnote-decorations.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * One `^[…]` note draws one superscript number, whatever else sits inside it.
 *
 * THE FAULT. A note holding a link rendered its number three times ("2 2 2").
 * The editor splits a decorated run into one span per piece of differently
 * formatted text — a link mark cuts it in three, a comment highlight that
 * starts inside it cuts it in two — and the stylesheet drew the number
 * (`content: attr(data-cw-fn)`) on every span that carried it.
 *
 * So a marker here is a rendered element carrying `data-cw-fn`: that is the
 * attribute the stylesheet draws, and happy-dom cannot compute `::after`. The
 * count of `.cw-fn` pieces is the control that the run really was split, so
 * one marker means something.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md: string): EditorHandle {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push(() => editor.destroy());
  return editor;
}

const markers = (n: string) => [...document.querySelectorAll<HTMLElement>(`[data-cw-fn="${n}"]`)];
const pieces = () => [...document.querySelectorAll<HTMLElement>('.cw-fn')];

/** The document positions of `words` inside the only note in the doc. */
function inNote(editor: EditorHandle, words: string): { from: number; to: number } {
  const run = footnoteRuns(editor.editor.state.doc)[0];
  if (!run) throw new Error('no footnote in the doc');
  const text = editor.editor.state.doc.textBetween(run.from, run.to);
  const at = text.indexOf(words);
  if (at < 0) throw new Error(`"${words}" is not in the note`);
  return { from: run.from + at, to: run.from + at + words.length };
}

const LINKED =
  'Harborlight spent $321 million^[See the Riverbend Revenue Letter, page 4.] last year.';

describe('a footnote draws one number', () => {
  it('when its note holds a link', () => {
    const editor = mount(LINKED);
    const label = inNote(editor, 'Riverbend Revenue Letter');
    editor.editor
      .chain()
      .setTextSelection(label)
      .setLink({ href: 'https://example.com/letter' })
      .setTextSelection(1)
      .run();
    // Control: the link really is inside the run, cutting it in pieces.
    expect(document.querySelector('.cw-fn a, a .cw-fn')).not.toBeNull();
    expect(pieces().length).toBeGreaterThanOrEqual(3);
    expect(markers('1')).toHaveLength(1);
  });

  it('when its note holds no other formatting', () => {
    mount(LINKED);
    expect(markers('1')).toHaveLength(1);
  });

  it('when a comment highlight starts inside its note', () => {
    const editor = mount(LINKED);
    const run = footnoteRuns(editor.editor.state.doc)[0];
    if (!run) throw new Error('no footnote in the doc');
    const mid = inNote(editor, 'Revenue');
    editor.setThreadRanges([{ id: 'th-1', from: mid.from, to: run.to + 5, status: 'open' }], null);
    // Control: the highlight really cuts the run — some pieces of the note
    // are highlighted and some are not.
    const lit = pieces().filter(
      (el) => el.closest('[data-thread-id="th-1"]') || el.matches('[data-thread-id="th-1"]'),
    );
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThan(pieces().length);
    expect(markers('1')).toHaveLength(1);
  });

  it('keeps the number on the end of the run, where the reader sees it', () => {
    const editor = mount(LINKED);
    const label = inNote(editor, 'Riverbend Revenue Letter');
    editor.editor.chain().setTextSelection(label).setLink({ href: 'https://example.com' }).run();
    const [marker] = markers('1');
    expect(marker?.textContent?.endsWith(']')).toBe(true);
    expect(marker?.dataset.cwFnNote).toBe('See the Riverbend Revenue Letter, page 4.');
  });
});
