import type { EditorView } from '@tiptap/pm/view';
import type { WorkingLine } from '../reading-hold.ts';

/**
 * Where on screen the reader is working in a markdown doc, for the reading
 * hold (`reading-hold.ts`, `WorkingLine`).
 *
 * - Typing in a comment box: the words the comment is about. A reply's box
 *   belongs to a `.thread` card that names its thread, and the prose marks
 *   that thread's words with the same id; a new comment's box is `#composer`,
 *   and its words are the pending highlight. Holding the words holds the box
 *   too — the margin balloon is laid out against them and the in-flow card
 *   sits under their paragraph.
 * - Typing in the doc: the caret. The sync plugin puts it back in the same
 *   words after a remote edit, so where it reads after the edit is where those
 *   words went.
 *
 * Checked in that order because a card in the flow is inside the editor's
 * element, so the editor reports focus while the reader types in its box.
 */
export function docWorkingLine(view: EditorView): WorkingLine {
  return () => {
    const active = document.activeElement;
    const box = active instanceof Element ? active.closest('.thread, #composer') : null;
    if (box) {
      const id = box.getAttribute('data-thread-id');
      const words = id
        ? view.dom.querySelector(`.thread-range[data-thread-id="${CSS.escape(id)}"]`)
        : box.id === 'composer'
          ? view.dom.querySelector('.comment-pending')
          : null;
      return words ? words.getBoundingClientRect().top : null;
    }
    if (!view.hasFocus()) return null;
    try {
      return view.coordsAtPos(view.state.selection.head).top;
    } catch {
      // A position the view has no DOM for yet, mid-update.
      return null;
    }
  };
}
