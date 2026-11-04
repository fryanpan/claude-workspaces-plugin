import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteEditsKeepScroll, isRemoteSync } from '../src/doc/remote-edit-scroll.ts';

/**
 * A scroll a remote edit asks for is dropped; the reader's own still runs.
 * `body-typing-remote-edit-browser.test.ts` measures what the dropped scroll
 * did in a real browser (300px at 430x932). happy-dom lays nothing out, so
 * this asks the view what it would do with a scroll request: a plugin that
 * answers `handleScrollToSelection` with true is the view not scrolling.
 */

let editors: Editor[] = [];
afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
  document.body.innerHTML = '';
});

function mount(withGuard: boolean): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      ...(withGuard ? [RemoteEditsKeepScroll] : []),
    ],
    content: '<p>Harborlight</p><p>Riverbend</p>',
  });
  editors.push(editor);
  return editor;
}

/** Whether the view would skip its own scroll-to-selection now. */
const scrollClaimed = (editor: Editor): boolean =>
  editor.view.someProp('handleScrollToSelection', (f) => f(editor.view)) === true;

const remote = { isChangeOrigin: true, isUndoRedoOperation: false };
const remoteEdit = (editor: Editor) =>
  editor.state.tr.insertText('Saltmarsh ', 1).setMeta(ySyncPluginKey, remote).scrollIntoView();

describe('a remote edit does not scroll the page', () => {
  it('drops the scroll the sync plugin asks for', () => {
    const editor = mount(true);
    editor.view.dispatch(remoteEdit(editor));
    expect(scrollClaimed(editor)).toBe(true);
  });

  it('leaves that scroll to the view without the guard', () => {
    // The control: nothing else in the editor claims the scroll.
    const editor = mount(false);
    editor.view.dispatch(remoteEdit(editor));
    expect(scrollClaimed(editor)).toBe(false);
  });

  it("still runs the reader's own scroll after a remote edit", () => {
    const editor = mount(true);
    editor.view.dispatch(remoteEdit(editor));
    editor.view.dispatch(editor.state.tr.insertText('Alice ', 1).scrollIntoView());
    expect(scrollClaimed(editor)).toBe(false);
  });

  it("counts an undo as the reader's own", () => {
    const editor = mount(true);
    const undo = { isChangeOrigin: true, isUndoRedoOperation: true };
    expect(isRemoteSync(editor.state.tr.setMeta(ySyncPluginKey, undo))).toBe(false);
    expect(isRemoteSync(editor.state.tr.setMeta(ySyncPluginKey, remote))).toBe(true);
    expect(isRemoteSync(editor.state.tr)).toBe(false);
  });
});
