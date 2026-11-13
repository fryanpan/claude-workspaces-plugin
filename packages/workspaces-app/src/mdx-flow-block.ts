import { MDX_FLOW_LANGUAGE } from '@claude-workspaces/core/prose';
import type { Editor, NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep, type Step } from '@tiptap/pm/transform';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { ComponentMount, componentKeyOf, componentLiveOf } from './mdx-component.ts';
import { type MdxSummary, renderMdxSummary, summarizeMdx } from './mdx-preview.ts';

/**
 * An `.mdx` component, expression or import run in the editor: a code block
 * whose language is `mdx-flow` (the server parses it so — core `prose-mdx.ts`)
 * shown as a quiet block with its source one tap away.
 *
 * The source is the node's text, so a comment anchors to words in it exactly
 * as it does in prose, and a block holding an open comment shows its source
 * so the comment can be seen. It is read-only until the reader taps Edit on
 * a chart: a typo in a prop breaks the post's build, so `mdxReadOnly` refuses
 * a local edit inside any block not open for editing. While it is open the
 * chart redraws as the reader pauses, and a source that does not draw keeps
 * the last chart that did, with the reason under the source.
 *
 * A component tag — one whose import the server builds — draws the built
 * component itself, live, in place of the preview (`mdx-component.ts`).
 */

export { MDX_FLOW_LANGUAGE };

export function isMdxFlowNode(node: PMNode): boolean {
  return node.type.name === 'codeBlock' && node.attrs.language === MDX_FLOW_LANGUAGE;
}

/** How long the chart waits after the last keystroke before it redraws. */
export const REDRAW_MS = 300;

/** Whether a block's view drew a chart, so a broken edit has one to keep. */
const drewChart = (s: MdxSummary) => !s.error && (s.chart !== undefined || s.plot !== undefined);

/** Whether a block is a chart's tag, drawn or not: a tag left broken must
 *  still offer Edit when the doc is next opened. */
const isChartTag = (s: MdxSummary) => drewChart(s) || (s.kind === 'jsx' && /Chart$/.test(s.label));

/** Draw `next` into `view`, and say why it failed when it did: the tag did not
 *  parse, it no longer reads as a chart, Plot refused its spec, or a drawing
 *  threw. */
function drawInto(view: HTMLElement, next: MdxSummary, width: number): string | undefined {
  try {
    renderMdxSummary(view, next, width);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (next.error) return next.error;
  if (!drewChart(next))
    return 'This no longer reads as a chart: check its brackets, quotes and commas';
  return view.querySelector('.plot-spec-error')?.textContent ?? undefined;
}

export function mdxFlowNodeView(
  initial: PMNode,
  editor: Editor,
  getPos: NodeViewRendererProps['getPos'],
): NodeView {
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

  // Shown on a chart to a reader who can write; CSS hides it when the editor
  // is read-only. Its label swaps between two words of one width.
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'mdx-edit';
  edit.setAttribute('contenteditable', 'false');
  edit.setAttribute('aria-pressed', 'false');
  edit.textContent = 'Edit';
  wrapper.appendChild(edit);

  const pre = document.createElement('pre');
  pre.className = 'mdx-source';
  const code = document.createElement('code');
  code.setAttribute('contenteditable', 'false');
  pre.appendChild(code);
  wrapper.appendChild(pre);

  const error = document.createElement('div');
  error.className = 'mdx-edit-error';
  error.setAttribute('contenteditable', 'false');
  error.setAttribute('role', 'status');
  error.hidden = true;
  wrapper.appendChild(error);

  // A component tag's live drawing, made the first time the block is one.
  const live = componentLiveOf(editor);
  let component: ComponentMount | null = null;
  const drawComponent = () => {
    if (!live) return;
    if (!component) {
      component = new ComponentMount(live);
      // A tap inside the component works the component; it does not open
      // the source.
      component.host.addEventListener('click', (e) => e.stopPropagation());
    }
    if (component.host.parentNode !== view) view.replaceChildren(component.host, component.status);
    component.follow(() => componentKeyOf(editor.state.doc, node.textContent));
  };

  let rendered = '';
  // The summary the view shows: the last one that drew, while a broken edit
  // keeps it.
  let summary = summarizeMdx('');
  let drawnAt = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const render = () => {
    pending = null;
    if (node.textContent === rendered) return;
    rendered = node.textContent;
    const next = summarizeMdx(rendered);
    const key = live && next.kind === 'jsx' ? componentKeyOf(editor.state.doc, rendered) : null;
    if (key) {
      summary = next;
      drawComponent();
      view.dataset.kind = 'component';
      wrapper.dataset.kind = 'component';
      return;
    }
    if (component?.host.parentNode === view) view.replaceChildren();
    const kept = drewChart(summary) ? [...view.childNodes] : null;
    drawnAt = view.clientWidth;
    const failed = drawInto(view, next, drawnAt);
    if (failed && kept) {
      view.replaceChildren(...kept);
      error.textContent = failed;
      error.hidden = false;
    } else {
      summary = next;
      error.hidden = true;
      error.textContent = '';
    }
    view.dataset.kind = summary.kind;
    wrapper.dataset.kind = summary.kind;
    wrapper.classList.toggle('has-chart', isChartTag(summary));
  };
  const editing = () => wrapper.classList.contains('is-editing');
  // Typing redraws once the reader pauses; a change from elsewhere draws at once.
  const schedule = () => {
    if (pending) clearTimeout(pending);
    if (editing()) pending = setTimeout(render, REDRAW_MS);
    else render();
  };
  // A chart is drawn one unit per pixel so its words stay readable on a
  // phone, so it is redrawn when the column's width changes.
  const resized =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const width = view.clientWidth;
          if (!summary.chart || width === 0 || Math.abs(width - drawnAt) < 4) return;
          drawnAt = width;
          renderMdxSummary(view, summary, width);
        });
  resized?.observe(view);
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
    if (e.target !== view) return; // a key inside a component is the component's
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  });
  const setEditing = (on: boolean) => {
    if (on && !editor.isEditable) return;
    wrapper.classList.toggle('is-editing', on);
    edit.textContent = on ? 'Done' : 'Edit';
    edit.setAttribute('aria-pressed', String(on));
    // The source takes the editor's own editability while it is open.
    if (on) code.removeAttribute('contenteditable');
    else code.setAttribute('contenteditable', 'false');
    if (!on) {
      if (pending) render();
      return;
    }
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;
    editor
      .chain()
      .focus()
      .setTextSelection(pos + node.nodeSize - 1)
      .run();
  };
  // Keep the tap from moving the caret before the click lands.
  edit.addEventListener('mousedown', (e) => e.preventDefault());
  edit.addEventListener('click', () => setEditing(!editing()));
  render();
  // A node view is made while the editor builds its view, before the doc it
  // reads the imports from is settled: a tag that did not read as a
  // component then is asked again once it is.
  if (live && summary.kind === 'jsx' && !component)
    queueMicrotask(() => {
      rendered = '';
      render();
    });
  showComment();

  return {
    dom: wrapper,
    contentDOM: code,
    update(next) {
      if (!isMdxFlowNode(next)) return false;
      node = next;
      schedule();
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
      const target = event.target as Node;
      return view.contains(target) || edit.contains(target);
    },
    destroy() {
      if (pending) clearTimeout(pending);
      resized?.disconnect();
      component?.destroy();
    },
  };
}

/** How a range meets the `mdx-flow` blocks it reaches: the ones it takes
 *  whole, and the positions of those it reaches into without taking all of
 *  them. A collapsed range touches a block only strictly inside it. */
function meet(doc: PMNode, from: number, to: number): { whole: PMNode[]; partial: number[] } {
  const whole: PMNode[] = [];
  const partial: number[] = [];
  const lo = Math.max(0, from - 1);
  const hi = Math.min(doc.content.size, to + 1);
  doc.nodesBetween(lo, hi, (n, pos) => {
    if (!isMdxFlowNode(n)) return true;
    const end = pos + n.nodeSize;
    if (from <= pos && to >= end) whole.push(n);
    else if (from === to ? from > pos && from < end : from < end && to > pos) partial.push(pos);
    return false;
  });
  return { whole, partial };
}

/** Whether a block is open for editing: its view says so. */
type IsOpen = (pos: number) => boolean;

/** Whether `from`..`to` lies inside the source of one block open for editing,
 *  and reaches no other block. */
function insideOpen(doc: PMNode, from: number, to: number, isOpen: IsOpen): boolean {
  const { whole, partial } = meet(doc, from, to);
  const at = partial[0];
  if (whole.length > 0 || partial.length !== 1 || at === undefined || !isOpen(at)) return false;
  const block = doc.nodeAt(at);
  return block !== null && from >= at + 1 && to <= at + block.nodeSize - 1;
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

function refusesStep(step: Step, doc: PMNode, isOpen: IsOpen): boolean {
  // A mark cannot land in a code block's text, so a bold over a component is
  // no change to it.
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return false;
  if (step instanceof ReplaceStep) {
    // Text typed or deleted inside an open block lands; a slice that would
    // split the block or carry another node into it does not.
    const { slice } = step;
    const flat = slice.openStart === 0 && slice.openEnd === 0;
    let textOnly = true;
    slice.content.forEach((n) => {
      if (!n.isText) textOnly = false;
    });
    if (flat && textOnly && insideOpen(doc, step.from, step.to, isOpen)) return false;
    const { whole, partial } = meet(doc, step.from, step.to);
    return partial.length > 0 || carriesSource(step.slice, whole);
  }
  // Every other step rewraps, retypes or re-attributes what it spans: a quote,
  // a list, a heading, a language change. None may reach a component at all.
  const at = step as unknown as { from?: number; to?: number; pos?: number };
  const from = at.from ?? at.pos;
  if (from === undefined) return false;
  const to = at.to ?? from + 1;
  const { whole, partial } = meet(doc, from, Math.max(from + 1, to));
  return partial.length > 0 || whole.length > 0;
}

/** Keep the browser from editing the DOM across a block: its own delete moves
 *  the rest of the source into the paragraph beside it, where ProseMirror
 *  reads it back as inline code. A change that takes whole blocks is made
 *  here instead, as a transaction the guard below reads. */
function beforeInput(view: EditorView, event: InputEvent, isOpen: IsOpen): boolean {
  const { from, to } = view.state.selection;
  if (insideOpen(view.state.doc, from, to, isOpen)) return false;
  const { whole, partial } = meet(view.state.doc, from, to);
  if (partial.length === 0 && whole.length === 0) return false;
  event.preventDefault();
  if (partial.length > 0) return true;
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
 *  reader. A block whose Edit is on takes a change that stays inside its
 *  source; every other block still refuses. */
export function mdxReadOnly(): Plugin {
  let pm: EditorView | null = null;
  const isOpen: IsOpen = (pos) => {
    const dom = pm?.nodeDOM(pos);
    return dom instanceof HTMLElement && dom.classList.contains('is-editing');
  };
  return new Plugin({
    key: new PluginKey('mdxReadOnly'),
    view(editorView) {
      pm = editorView;
      return {
        destroy: () => {
          pm = null;
        },
      };
    },
    props: {
      handleDOMEvents: { beforeinput: (view, event) => beforeInput(view, event, isOpen) },
      handleTextInput: (view, from, to) =>
        !insideOpen(view.state.doc, from, to, isOpen) &&
        meet(view.state.doc, from, to).partial.length > 0,
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) return true;
      // Each step's positions are in the doc as it stood before that step.
      return !tr.steps.some((step, k) => refusesStep(step, tr.docs[k] ?? state.doc, isOpen));
    },
  });
}
