import { Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { keepComposerFocusThroughEdits } from '../src/composer-keep.ts';
import { ThreadDecorations, setThreadDecorations } from '../src/thread-decorations.ts';

/**
 * The caret stays in an in-flow card's reply box through a document change.
 *
 * In a real browser ProseMirror's renderer takes the card's element out and
 * puts it back while it re-lays the blocks out after a remote edit, and a
 * focused element taken out of the document drops focus to `body`
 * (`comment-focus-remote-edit-browser.test.ts` measures that). happy-dom does
 * not blur on removal, so a plugin view here does what the renderer does to
 * focus during the view update: it moves the caret off the box.
 */

let editors: Editor[] = [];
afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
  document.body.innerHTML = '';
});

/** Drops focus during the view update of every document change, the way the
 *  renderer moving the card does. */
const DropFocusOnDocChange = Extension.create({
  name: 'dropFocusOnDocChange',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: () => ({
          update: (view, prev) => {
            if (view.state.doc.eq(prev.doc)) return;
            (document.activeElement as HTMLElement | null)?.blur();
          },
        }),
      }),
    ];
  },
});

function mountWithReplyBox(keep: boolean): { editor: Editor; box: HTMLTextAreaElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      ThreadDecorations,
      DropFocusOnDocChange,
    ],
    content: '<p>Hello brave world</p><p>Second paragraph here</p>',
  });
  editors.push(editor);
  if (keep) keepComposerFocusThroughEdits(editor);
  const card = document.createElement('div');
  card.className = 'thread';
  card.setAttribute('data-thread-id', 't1');
  const box = document.createElement('textarea');
  card.appendChild(box);
  setThreadDecorations(editor.view, {
    ranges: [{ id: 't1', from: 7, to: 12, status: 'open' }],
    inlineCards: [{ id: 't1', el: card }],
  });
  box.value = 'Alice signs off';
  box.focus();
  box.setSelectionRange(6, 11);
  return { editor, box };
}

/** An edit somebody else made: text inserted above the card. */
function remoteEdit(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.insertText('Harborlight. ', 1));
}

describe('the reply box in an in-flow card keeps the caret through an edit', () => {
  it('gets the caret back, with its selection, once the update is done', () => {
    const { editor, box } = mountWithReplyBox(true);
    remoteEdit(editor);
    expect(document.activeElement).toBe(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([6, 11]);
  });

  it('loses it without the keep — the control for the stand-in renderer', () => {
    const { editor, box } = mountWithReplyBox(false);
    remoteEdit(editor);
    expect(document.activeElement).not.toBe(box);
  });

  it('leaves the caret where the reader put it when nothing in a card held it', () => {
    const { editor, box } = mountWithReplyBox(true);
    box.blur();
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    editor.view.dispatch(editor.state.tr.insertText('Riverbend. ', 1));
    // The stand-in renderer blurred the input; the keep must not have pulled
    // the caret into the card the reader had left.
    expect(document.activeElement).not.toBe(box);
  });
});
