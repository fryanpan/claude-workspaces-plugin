import { prose } from '@claude-workspaces/core';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * Block identity survives a local edit (block-identity.ts).
 *
 * y-prosemirror's `updateYFragment` removes every Yjs attribute the
 * ProseMirror node does not carry, so `cwId` / `cwAuthor` only survive the
 * browser if the editor's schema declares them. These tests drive the real
 * `createEditor` over a real Y.Doc and read the attributes back off the Yjs
 * elements — the thing the server reads — rather than off the PM node.
 */

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

function mountEditor(md: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.push(prose.parseMarkdownBlocks(md));
  // Stamp identity on every top-level block, the way the server's outline
  // read does before it hands an id out.
  const blocks = fragment.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement);
  blocks.forEach((el, i) => {
    el.setAttribute(prose.BLOCK_ID_ATTR, `blk-${i}`);
    prose.setBlockAuthor(el, 'note-taker');
  });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push({ handle, parent });
  return { ydoc, fragment, handle, view: handle.editor.view as EditorView };
}

/** Identity attributes of the fragment's top-level blocks, in order. */
function identities(fragment: Y.XmlFragment): Array<[string | undefined, string | undefined]> {
  return fragment
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement)
    .map((el) => [prose.readBlockId(el), prose.readBlockAuthor(el)]);
}

/** Position of the first text node whose text is `text`. */
function posOf(handle: EditorHandle, text: string): number {
  let at = -1;
  handle.editor.state.doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text === text) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`no text node ${text}`);
  return at;
}

describe('block identity survives the browser', () => {
  it('a local edit inside a block leaves that block its id and author', () => {
    const { fragment, handle } = mountEditor('First para.\n\nSecond para.\n');
    expect(identities(fragment)).toEqual([
      ['blk-0', 'note-taker'],
      ['blk-1', 'note-taker'],
    ]);

    handle.editor.commands.setTextSelection(posOf(handle, 'First para.') + 5);
    handle.editor.commands.insertContent('XYZ');
    expect(handle.editor.state.doc.textContent).toContain('XYZ');

    expect(identities(fragment)[0]).toEqual(['blk-0', 'note-taker']);
  });

  it('a block the edit never touched keeps its id and author too', () => {
    const { fragment, handle } = mountEditor('First para.\n\nSecond para.\n');
    handle.editor.commands.setTextSelection(posOf(handle, 'First para.') + 5);
    handle.editor.commands.insertContent('XYZ');

    expect(identities(fragment)[1]).toEqual(['blk-1', 'note-taker']);
  });

  it('a bullet typed into repeatedly keeps them across every keystroke', () => {
    const { fragment, handle } = mountEditor('- alpha\n');
    for (const ch of 'abc') {
      const text = handle.editor.state.doc.textContent;
      handle.editor.commands.insertContentAt(posOf(handle, text) + text.length, ch);
    }
    expect(handle.editor.state.doc.textContent).toBe('alphaabc');
    expect(identities(fragment)[0]).toEqual(['blk-0', 'note-taker']);
  });
});
