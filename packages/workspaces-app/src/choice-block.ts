import { CHOICE_LANGUAGE, parseChoice, setChoicePick } from '@claude-workspaces/core/prose';
import type { Editor, NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { NodeView } from '@tiptap/pm/view';
import { suggestInputKey } from './suggest-input.ts';

/**
 * A ```` ```choice ```` block (core `prose-choice.ts`) drawn as a row of
 * buttons. A tap rewrites `picked` in the block's own text, the smallest edit
 * that says it, so the pick travels the way typing does: through Yjs to every
 * open page, and out to the `.md` on the next write-back. Tapping the picked
 * option clears it. A reader who cannot write sees the pick and cannot change
 * it. A block that names no option shows its source instead.
 */

export { CHOICE_LANGUAGE };

export function isChoiceNode(node: PMNode): boolean {
  return node.type.name === 'codeBlock' && node.attrs.language === CHOICE_LANGUAGE;
}

/** Replace the node's text with `next`, touching only the bytes that differ. */
function writeText(editor: Editor, pos: number, node: PMNode, next: string): void {
  const prev = node.textContent;
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < prev.length - head &&
    tail < next.length - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  const from = pos + 1 + head;
  const to = pos + 1 + prev.length - tail;
  const inserted = next.slice(head, next.length - tail);
  const tr = editor.state.tr;
  if (inserted) tr.insertText(inserted, from, to);
  else tr.delete(from, to);
  // A pick is a direct edit even in Suggesting mode: it is an answer, not a
  // proposed change to the doc's words.
  tr.setMeta(suggestInputKey, { handled: true });
  editor.view.dispatch(tr);
}

export function choiceNodeView(
  initial: PMNode,
  editor: Editor,
  getPos: NodeViewRendererProps['getPos'],
): NodeView {
  let node = initial;
  const wrapper = document.createElement('div');
  wrapper.className = 'choice-block';

  const row = document.createElement('div');
  row.className = 'choice-row';
  row.setAttribute('contenteditable', 'false');
  row.setAttribute('role', 'group');
  wrapper.appendChild(row);

  const pre = document.createElement('pre');
  pre.className = 'choice-source';
  const code = document.createElement('code');
  code.setAttribute('contenteditable', 'false');
  pre.appendChild(code);
  wrapper.appendChild(pre);

  let drawnOptions = '';
  const render = () => {
    const choice = parseChoice(node.textContent);
    wrapper.classList.toggle('is-choice', choice !== null);
    if (!choice) {
      row.replaceChildren();
      drawnOptions = '';
      return;
    }
    if (choice.id) row.dataset.choiceId = choice.id;
    else delete row.dataset.choiceId;
    const key = choice.options.join('\n');
    if (key !== drawnOptions) {
      drawnOptions = key;
      row.replaceChildren(
        ...choice.options.map((option) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'choice-option';
          b.dataset.option = option;
          b.textContent = option;
          return b;
        }),
      );
    }
    for (const b of row.querySelectorAll<HTMLButtonElement>('.choice-option')) {
      b.setAttribute('aria-pressed', String(b.dataset.option === choice.picked));
    }
  };

  // Keep the tap from moving the caret before the click lands.
  row.addEventListener('mousedown', (e) => e.preventDefault());
  row.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.choice-option');
    if (!b || !editor.isEditable) return;
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;
    const option = b.dataset.option ?? '';
    const picked = parseChoice(node.textContent)?.picked;
    writeText(
      editor,
      pos,
      node,
      setChoicePick(node.textContent, picked === option ? null : option),
    );
  });
  render();

  return {
    dom: wrapper,
    contentDOM: code,
    update(next) {
      if (!isChoiceNode(next)) return false;
      node = next;
      render();
      return true;
    },
    // The buttons are ours, not ProseMirror's; see the same hook on the
    // mermaid block for the re-render loop it prevents.
    ignoreMutation(mutation) {
      const target = mutation.target as Node;
      if (mutation.type === 'selection') return false;
      return !(code === target || code.contains(target));
    },
    stopEvent(event) {
      return row.contains(event.target as Node);
    },
  };
}
