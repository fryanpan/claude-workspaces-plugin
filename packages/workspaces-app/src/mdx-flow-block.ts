import { MDX_FLOW_LANGUAGE } from '@claude-workspaces/core/prose';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { renderMdxSummary, summarizeMdx } from './mdx-preview.ts';

/**
 * An `.mdx` component, expression or import run in the editor: a code block
 * whose language is `mdx-flow` (the server parses it so — core `prose-mdx.ts`)
 * shown as a quiet block with its source one tap away.
 *
 * The source is the node's text, so a comment anchors to words in it exactly
 * as it does in prose. It is read-only here: `mdxReadOnly` refuses a local
 * edit inside it, since a typo in a prop breaks the post's build and the
 * block's point is to be read.
 */

export { MDX_FLOW_LANGUAGE };

export function isMdxFlowNode(node: PMNode): boolean {
  return node.type.name === 'codeBlock' && node.attrs.language === MDX_FLOW_LANGUAGE;
}

export function mdxFlowNodeView(initial: PMNode, _editor: Editor): NodeView {
  let node = initial;
  const wrapper = document.createElement('div');
  wrapper.className = 'mdx-block';

  const view = document.createElement('div');
  view.className = 'mdx-view';
  view.setAttribute('contenteditable', 'false');
  view.setAttribute('role', 'button');
  view.setAttribute('tabindex', '0');
  view.setAttribute('aria-expanded', 'false');
  wrapper.appendChild(view);

  const pre = document.createElement('pre');
  pre.className = 'mdx-source';
  const code = document.createElement('code');
  code.setAttribute('contenteditable', 'false');
  pre.appendChild(code);
  wrapper.appendChild(pre);

  let rendered = '';
  const render = () => {
    if (node.textContent === rendered) return;
    rendered = node.textContent;
    const summary = summarizeMdx(rendered);
    wrapper.dataset.kind = summary.kind;
    renderMdxSummary(view, summary);
  };
  const toggle = () => {
    const open = !wrapper.classList.contains('is-open');
    wrapper.classList.toggle('is-open', open);
    view.setAttribute('aria-expanded', String(open));
  };
  view.addEventListener('click', toggle);
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  });
  render();

  return {
    dom: wrapper,
    contentDOM: code,
    update(next) {
      if (!isMdxFlowNode(next)) return false;
      node = next;
      render();
      return true;
    },
    // The view is ours, not ProseMirror's; see the same hook on the mermaid
    // block for the re-render loop it prevents.
    ignoreMutation(mutation) {
      const target = mutation.target as Node;
      if (mutation.type === 'selection') return false;
      return !(code === target || code.contains(target));
    },
    stopEvent(event) {
      return view.contains(event.target as Node);
    },
  };
}

/** Refuses a local change that touches an `mdx-flow` block's text without
 *  taking the whole block: typing inside it, or a selection that runs from
 *  the prose beside it into part of its source. Deleting the block whole still
 *  lands, and so does a change from the Yjs sync — the server, another reader. */
export function mdxReadOnly(): Plugin {
  return new Plugin({
    key: new PluginKey('mdxReadOnly'),
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) return true;
      let inside = false;
      tr.steps.forEach((step, k) => {
        // Each step's positions are in the doc as it stood before that step.
        const doc = tr.docs[k] ?? state.doc;
        step.getMap().forEach((from, to) => {
          if (inside) return;
          const lo = Math.max(0, from - 1);
          const hi = Math.min(doc.content.size, to + 1);
          doc.nodesBetween(lo, hi, (n, pos) => {
            if (inside || !isMdxFlowNode(n)) return !inside;
            const end = pos + n.nodeSize;
            const whole = from <= pos && to >= end;
            const touches = from === to ? from > pos && from < end : from < end && to > pos;
            if (touches && !whole) inside = true;
            return false;
          });
        });
      });
      return !inside;
    },
  });
}
