import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import {
  ThreadDecorations,
  setThreadDecorations,
  threadDecorationsKey,
} from '../src/thread-decorations.ts';

function mount(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit.configure({ undoRedo: false }), ThreadDecorations],
    content,
  });
  return editor;
}

/** The text a thread's highlight currently covers. */
function highlighted(editor: Editor, id: string): string {
  const state = threadDecorationsKey.getState(editor.state);
  // Decoration.inline puts the DOM attrs on `type.attrs`, not on `spec`.
  const found = state?.deco
    .find()
    .find(
      (d) =>
        (d as unknown as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[
          'data-thread-id'
        ] === id,
    );
  if (!found) return '';
  return editor.state.doc.textBetween(found.from, found.to);
}

describe('thread highlights track edits', () => {
  // "Hello brave world" — highlight "brave".
  const CONTENT = '<p>Hello brave world</p>';
  const FROM = 7; // start of "brave" (doc pos 1 = start of paragraph text)
  const TO = 12;

  function withHighlight() {
    const editor = mount(CONTENT);
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: FROM, to: TO, status: 'open' }],
    });
    expect(highlighted(editor, 't1')).toBe('brave');
    return editor;
  }

  it('stays on its words when text is typed BEFORE it', () => {
    const editor = withHighlight();
    // This is the reported bug: every character typed ahead of a comment
    // pushed its highlight further out of alignment.
    editor.chain().focus().insertContentAt(1, 'Oh! ').run();
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('does not drift as more is typed', () => {
    const editor = withHighlight();
    for (const word of ['aaa ', 'bbbb ', 'cc ']) {
      editor.chain().focus().insertContentAt(1, word).run();
    }
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('follows a deletion before it', () => {
    const editor = withHighlight();
    editor.chain().focus().deleteRange({ from: 1, to: 7 }).run(); // drop "Hello "
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('grows when text is typed INSIDE it', () => {
    const editor = withHighlight();
    editor.chain().focus().insertContentAt(9, 'aa').run(); // br|aa|ave
    expect(highlighted(editor, 't1')).toBe('braaave');
    editor.destroy();
  });

  it('does not swallow text typed at either edge', () => {
    const editor = withHighlight();
    editor.chain().focus().insertContentAt(TO, 'XX').run(); // after "brave"
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('is unaffected by edits after it', () => {
    const editor = withHighlight();
    editor
      .chain()
      .focus()
      .insertContentAt(editor.state.doc.content.size - 1, ' indeed')
      .run();
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('still accepts a fresh set of ranges', () => {
    const editor = withHighlight();
    editor.chain().focus().insertContentAt(1, 'Oh! ').run();
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: 1, to: 4, status: 'open' }],
    });
    expect(highlighted(editor, 't1')).toBe('Oh!');
    editor.destroy();
  });
});

/**
 * Inline comment cards — the mobile surface. The card is the CALLER's node,
 * placed after the block its thread is anchored in; ProseMirror compares
 * widgets by that node's identity, which is what lets a card keep animating
 * through an unrelated transaction instead of being rebuilt mid-morph.
 */
describe('inline comment cards', () => {
  const CONTENT = '<p>Hello brave world</p><p>Second paragraph here</p>';

  function card(id: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'thread';
    el.setAttribute('data-thread-id', id);
    el.textContent = `card ${id}`;
    return el;
  }

  function mountWithCard(): { editor: Editor; el: HTMLElement } {
    const editor = mount(CONTENT);
    const el = card('t1');
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: 7, to: 12, status: 'open' }],
      inlineCards: [{ id: 't1', el }],
    });
    return { editor, el };
  }

  it('puts the card in the document, AFTER the block it is anchored in', () => {
    const { editor, el } = mountWithCard();
    expect(el.isConnected).toBe(true);
    const paragraphs = Array.from(editor.view.dom.querySelectorAll('p'));
    // Between the two paragraphs — the GitHub PR-comment position, not
    // spliced into the middle of the sentence it points at.
    expect(el.previousElementSibling).toBe(paragraphs[0]);
    expect(el.nextElementSibling).toBe(paragraphs[1]);
    editor.destroy();
  });

  it('keeps the SAME node through an unrelated edit', () => {
    const { editor, el } = mountWithCard();
    editor.chain().focus().insertContentAt(1, 'Oh! ').run();
    // Not just "a card is still there" — the very element handed in, still
    // attached. A replacement here would mount at its final height mid-morph.
    expect(el.isConnected).toBe(true);
    // `.thread` and not `[data-thread-id]` alone: the HIGHLIGHT span carries
    // that attribute too, so the loose selector would count two and pass
    // whatever happened to the card.
    expect(editor.view.dom.querySelectorAll('.thread[data-thread-id="t1"]')).toHaveLength(1);
    editor.destroy();
  });

  it('travels with its anchor when the anchor moves to another block', () => {
    const { editor, el } = mountWithCard();
    // Re-point the thread at the SECOND paragraph.
    const secondStart = editor.state.doc.content.size - 22;
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: secondStart, to: secondStart + 6, status: 'open' }],
    });
    const paragraphs = Array.from(editor.view.dom.querySelectorAll('p'));
    expect(el.previousElementSibling).toBe(paragraphs[1]);
    editor.destroy();
  });

  it('drops the card when its thread stops being rendered', () => {
    const { editor, el } = mountWithCard();
    expect(el.isConnected).toBe(true); // positive control
    setThreadDecorations(editor.view, { inlineCards: [] });
    expect(el.isConnected).toBe(false);
    editor.destroy();
  });

  it('a resolved thread keeps a faint highlight and its card — folded, not gone', () => {
    const editor = mount(CONTENT);
    const el = card('t1');
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: 7, to: 12, status: 'resolved' }],
      inlineCards: [{ id: 't1', el }],
    });
    const span = editor.view.dom.querySelector('.thread-range[data-thread-id="t1"]');
    expect(span?.classList.contains('resolved')).toBe(true);
    expect(el.isConnected).toBe(true);
    editor.destroy();
  });

  it('carries the thread kind and the new mark as classes on the highlight', () => {
    const editor = mount(CONTENT);
    setThreadDecorations(editor.view, {
      ranges: [
        { id: 'q', from: 1, to: 5, status: 'open', kind: 'question', isNew: true },
        { id: 'a', from: 7, to: 12, status: 'open', kind: 'answered' },
        { id: 'c', from: 14, to: 18, status: 'open', kind: 'comment' },
      ],
    });
    const cls = (id: string) =>
      editor.view.dom.querySelector(`.thread-range[data-thread-id="${id}"]`)?.className ?? '';
    expect(cls('q')).toBe('thread-range question is-new');
    expect(cls('a')).toBe('thread-range answered');
    expect(cls('c')).toBe('thread-range');
    editor.destroy();
  });
});

/**
 * The words a comment is being WRITTEN about, before there is a thread.
 *
 * On a doc the composer takes the caret, and with it the editor's selection —
 * on iOS the moment the box opens. The owner, 2026-09-11: "the area we're
 * commenting on does get scrolled up into view properly, but it's no longer
 * highlighted, so I can't tell what I had selected for commenting."
 */
describe('the pending comment range', () => {
  const CONTENT = '<p>Hello brave world</p>';
  const pending = (editor: Editor): string => {
    const found = threadDecorationsKey
      .getState(editor.state)
      ?.deco.find()
      .find(
        (d) =>
          (d as unknown as { type?: { attrs?: Record<string, string> } }).type?.attrs?.class ===
          'comment-pending',
      );
    return found ? editor.state.doc.textBetween(found.from, found.to) : '';
  };

  it('marks the range while the comment is open, and clears on null', () => {
    const editor = mount(CONTENT);
    expect(pending(editor), 'CONTROL: nothing is marked before a comment is started').toBe('');
    setThreadDecorations(editor.view, { pending: { from: 7, to: 12 } });
    expect(pending(editor)).toBe('brave');
    setThreadDecorations(editor.view, { pending: null });
    expect(pending(editor)).toBe('');
    editor.destroy();
  });

  it('stays on its words while the doc is edited around it', () => {
    // The composer is open for as long as it takes to type a comment, and a
    // collaborator can be editing the whole time.
    const editor = mount(CONTENT);
    setThreadDecorations(editor.view, { pending: { from: 7, to: 12 } });
    editor.chain().focus().insertContentAt(1, 'Oh! ').run();
    expect(pending(editor)).toBe('brave');
    editor.destroy();
  });

  it('is what the markdown surface marks when the doc asks it to', () => {
    // The plugin above is driven by `setThreadDecorations`; what the composer
    // actually calls is `markPending` on the surface. Without this the two
    // halves could pass separately while the doc editor marked nothing.
    const ydoc = new Y.Doc();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
    handle.setMarkdown('Hello brave world');
    expect(pending(handle.editor), 'CONTROL: nothing marked yet').toBe('');
    handle.markPending({ from: 7, to: 12 });
    expect(pending(handle.editor)).toBe('brave');
    handle.markPending(null);
    expect(pending(handle.editor)).toBe('');
    handle.destroy();
    parent.remove();
  });

  it('survives an unrelated decoration update', () => {
    // Threads repaint constantly — every Yjs update lands a fresh `ranges`.
    const editor = mount(CONTENT);
    setThreadDecorations(editor.view, { pending: { from: 7, to: 12 } });
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: 1, to: 6, status: 'open' }],
    });
    expect(pending(editor)).toBe('brave');
    editor.destroy();
  });
});
