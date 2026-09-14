import { MDX_FLOW_LANGUAGE } from '@claude-workspaces/core/prose';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep, type Step } from '@tiptap/pm/transform';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { renderMdxSummary, summarizeMdx } from './mdx-preview.ts';

/**
 * An `.mdx` component, expression or import run in the editor: a code block
 * whose language is `mdx-flow` (the server parses it so — core `prose-mdx.ts`)
 * shown as a quiet block with its source one tap away.
 *
 * The source is the node's text, so a comment anchors to words in it exactly
 * as it does in prose, and a block holding an open comment shows its source
 * so the comment can be seen. It is read-only here: `mdxReadOnly` refuses a
 * local edit inside it, since a typo in a prop breaks the post's build and
 * the block's point is to be read.
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
  const setOpen = (open: boolean) => {
    wrapper.classList.toggle('is-open', open);
    view.setAttribute('aria-expanded', String(open));
  };
  // Once the reader has opened or closed it, the block stays as they left it.
  let chosen = false;
  const toggle = () => {
    chosen = true;
    setOpen(!wrapper.classList.contains('is-open'));
  };
  // A comment's highlight is drawn inside the source, which a closed block
  // hides. ProseMirror paints the decorations after `update` returns.
  const showComment = () =>
    queueMicrotask(() => {
      if (!chosen && code.querySelector('.thread-range:not(.resolved)')) setOpen(true);
    });
  view.addEventListener('click', toggle);
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  });
  render();
  showComment();

  return {
    dom: wrapper,
    contentDOM: code,
    update(next) {
      if (!isMdxFlowNode(next)) return false;
      node = next;
      render();
      showComment();
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

/** How a range meets the `mdx-flow` blocks it reaches: whether it takes any
 *  whole, and whether it reaches into any without taking all of it. A
 *  collapsed range touches a block only strictly inside it. */
function meet(doc: PMNode, from: number, to: number): { whole: PMNode[]; partial: boolean } {
  const whole: PMNode[] = [];
  let partial = false;
  const lo = Math.max(0, from - 1);
  const hi = Math.min(doc.content.size, to + 1);
  doc.nodesBetween(lo, hi, (n, pos) => {
    if (!isMdxFlowNode(n)) return !partial;
    const end = pos + n.nodeSize;
    if (from <= pos && to >= end) whole.push(n);
    else if (from === to ? from > pos && from < end : from < end && to > pos) partial = true;
    return false;
  });
  return { whole, partial };
}

/** Whether `slice` carries a block's source back in as something else — how a
 *  browser's own edit across a block reads once ProseMirror parses the DOM. */
function carriesSource(slice: Slice, blocks: PMNode[]): boolean {
  const text = slice.content.textBetween(0, slice.content.size, '\n');
  return blocks.some((b) => {
    const head = b.textContent.split('\n').find((l) => l.trim() !== '');
    return head !== undefined && text.includes(head.trim());
  });
}

function refusesStep(step: Step, doc: PMNode): boolean {
  // A mark cannot land in a code block's text, so a bold over a component is
  // no change to it.
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return false;
  if (step instanceof ReplaceStep) {
    const { whole, partial } = meet(doc, step.from, step.to);
    return partial || carriesSource(step.slice, whole);
  }
  // Every other step rewraps, retypes or re-attributes what it spans: a quote,
  // a list, a heading, a language change. None may reach a component at all.
  const at = step as unknown as { from?: number; to?: number; pos?: number };
  const from = at.from ?? at.pos;
  if (from === undefined) return false;
  const to = at.to ?? from + 1;
  const { whole, partial } = meet(doc, from, Math.max(from + 1, to));
  return partial || whole.length > 0;
}

/** Keep the browser from editing the DOM across a block: its own delete moves
 *  the rest of the source into the paragraph beside it, where ProseMirror
 *  reads it back as inline code. A change that takes whole blocks is made
 *  here instead, as a transaction the guard below reads. */
function beforeInput(view: EditorView, event: InputEvent): boolean {
  const { from, to } = view.state.selection;
  const { whole, partial } = meet(view.state.doc, from, to);
  if (!partial && whole.length === 0) return false;
  event.preventDefault();
  if (partial) return true;
  const type = event.inputType;
  if ((type === 'insertText' || type === 'insertReplacementText') && event.data) {
    view.dispatch(view.state.tr.insertText(event.data, from, to).scrollIntoView());
  } else if (type.startsWith('delete')) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  }
  return true;
}

/** Refuses a local change that touches an `mdx-flow` block without taking
 *  the whole block — typing inside it, a selection from the prose beside it
 *  into part of its source, a quote or list wrapped around it — on every
 *  path: a command, a key, the browser's own input. Deleting the block whole
 *  still lands, and so does a change from the Yjs sync — the server, another
 *  reader. */
export function mdxReadOnly(): Plugin {
  return new Plugin({
    key: new PluginKey('mdxReadOnly'),
    props: {
      handleDOMEvents: { beforeinput: beforeInput },
      handleTextInput: (view, from, to) => meet(view.state.doc, from, to).partial,
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) return true;
      // Each step's positions are in the doc as it stood before that step.
      return !tr.steps.some((step, k) => refusesStep(step, tr.docs[k] ?? state.doc));
    },
  });
}
