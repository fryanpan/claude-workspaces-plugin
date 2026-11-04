import { prose } from '@claude-workspaces/core';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * A person types inside a quote that holds several paragraphs and a list, and
 * the write-back keeps every line of it.
 *
 * The quote used to be parsed into ONE paragraph whose text carried the
 * quote's line breaks as literal newlines. The editor cannot keep a newline
 * in a paragraph: a keystroke re-reads the edited text from the page
 * (ProseMirror's DOM read, `preserveWhitespace: true`), which turns each
 * newline into a space, and the next flush wrote the whole quote as one
 * `> ` line. This drives that read through the REAL editor: the text node is
 * changed on the page and the editor's DOM observer reads it back, as it does
 * for a keystroke.
 */

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

const QUOTE = [
  '> Harborlight opens at nine.',
  '>',
  '> **Alice will chair**',
  '>',
  '> - the harbour report',
  '> - the ferry timetable',
];
const DOC = `# Plan\n\n${QUOTE.join('\n')}\n\nAfter the quote.\n`;

function mount(md: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push({ handle, parent });
  return { fragment, view: handle.editor.view as EditorView };
}

/** Change the page's text node holding `needle`, then let the editor read it. */
function typeInto(view: EditorView, needle: string, word: string): void {
  const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.includes(needle)) {
      t.data = t.data.replace(needle, `${needle} ${word}`);
      (view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
      return;
    }
  }
  throw new Error(`no text node holds ${needle}`);
}

describe('a person’s edit inside a multi-paragraph quote', () => {
  it('keeps every quoted line and its break on the write-back', () => {
    const { fragment, view } = mount(DOC);
    typeInto(view, 'Harborlight opens', 'early');
    const out = prose.serializeFragmentToMarkdown(fragment);
    expect(out).toContain('> Harborlight opens early at nine.');
    expect(out).toContain(['>', ...QUOTE.slice(2)].join('\n'));
    expect(out).toContain('After the quote.');
  });

  it('POSITIVE CONTROL: the edit reached the doc', () => {
    const { fragment, view } = mount('Harborlight opens at nine.\n');
    typeInto(view, 'Harborlight opens', 'early');
    expect(prose.serializeFragmentToMarkdown(fragment)).toContain(
      'Harborlight opens early at nine.',
    );
  });
});
