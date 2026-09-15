import {
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  type SuggestionAttrs,
  prose,
} from '@claude-workspaces/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * Moving a section in the browser editor keeps every block's id its own and
 * keeps a pending suggestion pending.
 *
 * Two things were seen together on one doc right after a section was moved
 * under a new heading: one block id on several blocks, and a list item whose
 * pending replace-suggestion had become plain text holding both of its texts.
 * These drive the real `createEditor` over a real Y.Doc and read the Yjs
 * elements back — the thing the server reads and the outline hands out.
 */

const SUGGESTER: SuggestionAttrs = {
  sid: 's-kiln',
  authorId: 'agent-harborlight',
  authorName: 'Harborlight',
  authorColor: '#aa5500',
  ts: 1_700_000_000_000,
};

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

/** The fixture: two sections, the first holding a list whose second item
 *  carries a pending replace of "ferry" with "bridge". Every addressable
 *  block has an id, minted the way the server's outline read mints them. */
function mountDoc() {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.push(
    prose.parseMarkdownBlocks(
      '## Riverbend\n\n- dock opens\n- take the ferry\n\nSaltmarsh closes.\n\n## Kiln\n\nLast words.\n',
    ),
  );
  const item = (fragment.get(1) as Y.XmlElement).get(1) as Y.XmlElement;
  const text = (item.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const at = 'take the '.length;
  text.format(at, 'ferry'.length, { [SUGGEST_DELETE_MARK]: SUGGESTER });
  text.insert(at + 'ferry'.length, 'bridge', { [SUGGEST_INSERT_MARK]: SUGGESTER });
  prose.ensureBlockIds(ydoc);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push({ handle, parent });
  return { ydoc, fragment, handle, view: handle.editor.view as EditorView };
}

/** Every id that more than one block carries. */
function duplicateIds(fragment: Y.XmlFragment): string[] {
  const seen = new Map<string, number>();
  for (const el of prose.addressableBlocks(fragment)) {
    const id = prose.readBlockId(el);
    if (id !== undefined) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** Every block id in the doc, in document order, with the text each block's
 *  own words start with — a list item reads as its paragraph. */
function idsInOrder(fragment: Y.XmlFragment): Array<[string | undefined, string]> {
  return prose
    .addressableBlocks(fragment)
    .filter((el) => el.nodeName !== 'bulletList')
    .map((el) => [prose.readBlockId(el), prose.outlineTextOf(el)]);
}

type Run = { insert?: string; attributes?: Record<string, unknown> };

/** The runs of the list item whose words include `word`, with only the two
 *  suggestion marks kept, so a failure prints what the item became. */
function itemRuns(fragment: Y.XmlFragment, word: string): Array<[string, string]> {
  for (const el of prose.addressableBlocks(fragment)) {
    if (el.nodeName !== 'listItem') continue;
    const para = el.get(0);
    if (!(para instanceof Y.XmlElement)) continue;
    const runs = para
      .toArray()
      .filter((t): t is Y.XmlText => t instanceof Y.XmlText)
      .flatMap((t) => t.toDelta() as Run[]);
    if (
      !runs
        .map((r) => r.insert ?? '')
        .join('')
        .includes(word)
    )
      continue;
    return runs.map((r) => {
      const kind =
        r.attributes?.[SUGGEST_INSERT_MARK] != null
          ? 'ins'
          : r.attributes?.[SUGGEST_DELETE_MARK] != null
            ? 'del'
            : 'plain';
      return [r.insert ?? '', kind];
    });
  }
  throw new Error(`no list item holding ${word}`);
}

/** Doc positions of the top-level section headed `title`: from the heading
 *  up to the next heading or the end. */
function sectionRange(doc: PMNode, title: string): { from: number; to: number } {
  let from = -1;
  let to = doc.content.size;
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading') return;
    if (from < 0 && node.textContent === title) from = offset;
    else if (from >= 0 && offset > from && to === doc.content.size) to = offset;
  });
  if (from < 0) throw new Error(`no section ${title}`);
  return { from, to };
}

/** End of the doc's last top-level block. */
function docEnd(doc: PMNode): number {
  return doc.content.size;
}

/** Cut the range the way ProseMirror's own `cut` handler does, and paste the
 *  clipboard HTML it wrote through the editor's paste path. */
function cutAndPaste(view: EditorView, range: { from: number; to: number }, at: () => number) {
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)),
  );
  const slice = view.state.selection.content();
  const { dom } = view.serializeForClipboard(slice);
  const html = dom.innerHTML;
  view.dispatch(view.state.tr.deleteSelection().setMeta('uiEvent', 'cut'));
  const pos = at();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  view.pasteHTML(html);
}

/** An internal drag of the range dropped at `at`, as ProseMirror's own drop
 *  handler builds it for a slice dragged inside one editor. `move: false` is
 *  the copy-drag (a modifier held). */
function dragTo(view: EditorView, range: { from: number; to: number }, at: number, move: boolean) {
  const slice = view.state.doc.slice(range.from, range.to);
  const tr = view.state.tr;
  if (move) tr.delete(range.from, range.to);
  const pos = tr.mapping.map(at);
  tr.replaceRange(pos, pos, slice);
  view.dispatch(tr.setMeta('uiEvent', 'drop'));
}

describe('moving a section in the editor', () => {
  it('Enter at the end of a bullet gives the new bullet no copy of the id', () => {
    const { fragment, handle, view } = mountDoc();
    const range = sectionRange(view.state.doc, 'Riverbend');
    let end = -1;
    view.state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'dock opens') {
        end = pos + node.nodeSize - 1;
      }
    });
    const before = idsInOrder(fragment).find(([, text]) => text === 'dock opens')?.[0];
    handle.editor.commands.setTextSelection(end);
    handle.editor.commands.keyboardShortcut('Enter');
    handle.editor.commands.insertContent('new bullet');
    expect(duplicateIds(fragment)).toEqual([]);
    // The bullet that was there keeps the address; the new one has none yet.
    const after = idsInOrder(fragment);
    expect(after.find(([, text]) => text === 'dock opens')?.[0]).toBe(before);
    expect(after.find(([, text]) => text === 'new bullet')?.[0]).toBeUndefined();
  });

  it('Enter at the end of a paragraph gives the new paragraph no copy of the id', () => {
    const { fragment, handle, view } = mountDoc();
    let end = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.textContent === 'Saltmarsh closes.') end = offset + node.nodeSize - 1;
    });
    handle.editor.commands.setTextSelection(end);
    handle.editor.commands.keyboardShortcut('Enter');
    handle.editor.commands.insertContent('Next line.');
    expect(duplicateIds(fragment)).toEqual([]);
  });

  it('cut and paste of a section keeps a pending replace pending, its two texts apart', () => {
    const { fragment, view } = mountDoc();
    cutAndPaste(view, sectionRange(view.state.doc, 'Riverbend'), () => docEnd(view.state.doc));
    expect(duplicateIds(fragment)).toEqual([]);
    expect(itemRuns(fragment, 'ferry')).toEqual([
      ['take the ', 'plain'],
      ['ferry', 'del'],
      ['bridge', 'ins'],
    ]);
  });

  it('a drag-move of a section keeps a pending replace pending, its two texts apart', () => {
    const { fragment, view } = mountDoc();
    const before = idsInOrder(fragment);
    dragTo(view, sectionRange(view.state.doc, 'Riverbend'), docEnd(view.state.doc), true);
    expect(duplicateIds(fragment)).toEqual([]);
    // Nothing collided, so every block keeps the id it had and none is cleared
    // or added: same ids, same blocks, moved section now after Kiln.
    const after = idsInOrder(fragment);
    expect(new Map(after)).toEqual(new Map(before));
    expect(after.map(([, text]) => text)[0]).toBe('Kiln');
    expect(itemRuns(fragment, 'ferry')).toEqual([
      ['take the ', 'plain'],
      ['ferry', 'del'],
      ['bridge', 'ins'],
    ]);
  });

  it('a copy-drag of a section leaves the ids on the original and none on the copy', () => {
    const { fragment, view } = mountDoc();
    const before = idsInOrder(fragment);
    const section = before.slice(
      0,
      before.findIndex(([, text]) => text === 'Kiln'),
    );
    // Dropped at the very top, so the copy comes first in document order: the
    // original keeps its ids because it is outside what the drop wrote, not
    // because a lookup meets it first.
    dragTo(view, sectionRange(view.state.doc, 'Riverbend'), 0, false);
    expect(duplicateIds(fragment)).toEqual([]);
    const after = idsInOrder(fragment);
    const copy = after.slice(0, section.length);
    expect(copy.map(([, text]) => text)).toEqual(section.map(([, text]) => text));
    expect(copy.map(([id]) => id)).toEqual(section.map(() => undefined));
    expect(after.slice(section.length, 2 * section.length)).toEqual(section);
  });

  it('the narrowed backstop still strips a mark typing or a plain-text paste inherits inside a span', () => {
    const { fragment, view } = mountDoc();
    let inside = -1;
    view.state.doc.descendants((node, pos) => {
      if (inside < 0 && node.isText && node.text === 'bridge') inside = pos + 3;
      return inside < 0;
    });
    // Typing, the way the default input path does: tr.insertText takes the
    // caret's marks.
    view.dispatch(view.state.tr.insertText('X', inside, inside));
    // Between the "g" and the "e" of what is now "bri" X "dge".
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inside + 3)));
    view.pasteText('Y');
    expect(itemRuns(fragment, 'ferry')).toEqual([
      ['take the ', 'plain'],
      ['ferry', 'del'],
      ['bri', 'ins'],
      ['X', 'plain'],
      ['dg', 'ins'],
      ['Y', 'plain'],
      ['e', 'ins'],
    ]);
  });
});
