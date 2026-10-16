/**
 * The planning voice's cursor on the review doc: while the agent asks about
 * some of the plan's words, every open view of the doc scrolls to them and
 * shows them highlighted in the agent's own colour, with its name on a caret
 * at their start.
 *
 * The server says where through the doc's presence — the `agentFocus` field
 * of its own awareness state (`AGENT_FOCUS_FIELD`, set by the server's
 * `spoken-reply/interview-docs.ts`) — so it reaches every page with the doc
 * open, a reader's as well as a writer's, and nothing else: no event, no
 * stored content. A page that opens the doc while the agent is asking gets
 * the state with everyone else's presence and scrolls there too.
 *
 * Decorations only, so nothing here syncs. A page scrolls once per question
 * (`seq`), never on a repaint, and never moves the reader's caret. The
 * scroll moves the doc's own scroller and nothing else: `scrollIntoView`
 * walks up and scrolls every ancestor too, the page itself included
 * (`mobile-review.ts` and `edit-viewport.ts` avoid it for the same reason).
 *
 * Presence is whatever a page set, so a focus is read only from a state with
 * no `user` — the server's; every page announces one — and its colour and
 * name are checked before they reach the DOM (`parseAgentFocus`).
 */
import { BLOCK_ID_ATTR } from '@claude-workspaces/core/prose';
import {
  AGENT_FOCUS_FIELD,
  type AgentFocus,
  parseAgentFocus,
} from '@claude-workspaces/core/spoken-reply';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorHandle } from '../editor.ts';
import { centreScrollTop } from '../mobile-review.ts';
import type { MountScope } from '../mount-scope.ts';
import { prefersReducedMotion } from '../thread-morph.ts';

export const agentFocusKey = new PluginKey<DecorationSet>('agentFocus');

/** The slice of a Yjs awareness this needs. */
export interface FocusPresence {
  clientID: number;
  getStates(): Map<number, unknown>;
  on(event: 'change', fn: () => void): void;
  off(event: 'change', fn: () => void): void;
}

/** The newest focus among the doc's presence, from a state with no `user`. */
export function agentFocusOf(
  presence: Pick<FocusPresence, 'clientID' | 'getStates'>,
): AgentFocus | null {
  let best: AgentFocus | null = null;
  presence.getStates().forEach((raw, id) => {
    if (id === presence.clientID || !raw || typeof raw !== 'object') return;
    const state = raw as Record<string, unknown>;
    if (state.user !== undefined) return;
    const f = parseAgentFocus(state[AGENT_FOCUS_FIELD]);
    if (f && (!best || f.seq > best.seq)) best = f;
  });
  return best;
}

/**
 * Where the focus sits in `doc`: the quoted words inside the block with its
 * id, or the block's whole text when the words have since changed. Null when
 * the block is not in this page's copy yet.
 */
export function focusRange(
  doc: ProseNode,
  f: Pick<AgentFocus, 'blockId' | 'quote'>,
): { block: number; from: number; to: number } | null {
  let hit: { block: number; from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.attrs[BLOCK_ID_ATTR] !== f.blockId) return true;
    const text = node.textContent;
    const at = f.quote ? text.indexOf(f.quote) : -1;
    const start = at >= 0 ? at : 0;
    const len = at >= 0 ? f.quote.length : text.length;
    // Text offset to document position: walk the block's text nodes.
    let from = -1;
    let to = -1;
    let seen = 0;
    node.descendants((child, childPos) => {
      if (!child.isText) return true;
      const len2 = child.text?.length ?? 0;
      const abs = pos + 1 + childPos;
      if (from < 0 && start <= seen + len2) from = abs + (start - seen);
      if (to < 0 && start + len <= seen + len2) to = abs + (start + len - seen);
      seen += len2;
      return true;
    });
    hit = {
      block: pos,
      from: from < 0 ? pos + 1 : from,
      to: to < 0 ? pos + node.nodeSize - 1 : to,
    };
    return false;
  });
  return hit;
}

function caret(f: AgentFocus): HTMLElement {
  const el = document.createElement('span');
  el.className = 'agent-focus-caret';
  el.style.setProperty('--agent-color', f.color);
  el.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'agent-focus-name';
  label.textContent = f.name;
  el.append(label);
  return el;
}

/** Centre `el` in `scroller`, moving that scroller alone. */
function centreIn(scroller: HTMLElement, el: HTMLElement): void {
  if (!scroller.contains(el)) return;
  const top = centreScrollTop({
    elTop:
      el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
    elHeight: el.offsetHeight,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
  });
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  } else {
    scroller.scrollTop = top;
  }
}

export function wireAgentFocus(opts: {
  editor: EditorHandle;
  presence: FocusPresence;
  /** The element the doc scrolls in: `#editor` on the doc page. */
  scroller: HTMLElement;
  scope: MountScope;
}): void {
  const { editor: handle, presence, scroller, scope } = opts;
  const tiptap = handle.editor;
  tiptap.registerPlugin(
    new Plugin<DecorationSet>({
      key: agentFocusKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => {
          const next = tr.getMeta(agentFocusKey) as DecorationSet | undefined;
          return next ?? set.map(tr.mapping, tr.doc);
        },
      },
      props: { decorations: (state) => agentFocusKey.getState(state) },
    }),
  );

  let scrolledSeq: number | null = null;
  /** The focus is set but its block has not reached this page yet. */
  let pending = false;
  let painted: string | null = null;

  const paint = (): void => {
    if (scope.disposed || tiptap.isDestroyed) return;
    const view = tiptap.view;
    const f = agentFocusOf(presence);
    const r = f ? focusRange(view.state.doc, f) : null;
    pending = f !== null && r === null;
    const sig = f && r ? `${f.seq}:${r.from}:${r.to}` : null;
    if (sig === painted) return;
    painted = sig;
    const set =
      f && r
        ? DecorationSet.create(view.state.doc, [
            Decoration.inline(r.from, r.to, {
              class: 'agent-focus',
              style: `--agent-color: ${f.color}`,
            }),
            Decoration.widget(r.from, () => caret(f), { side: -1, key: `agent-focus-${f.seq}` }),
          ])
        : DecorationSet.empty;
    view.dispatch(view.state.tr.setMeta(agentFocusKey, set).setMeta('addToHistory', false));
    if (f && r && f.seq !== scrolledSeq) {
      scrolledSeq = f.seq;
      const dom = view.nodeDOM(r.block);
      if (dom instanceof HTMLElement) centreIn(scroller, dom);
    }
  };
  const onTransaction = (): void => {
    if (pending) paint();
  };

  presence.on('change', paint);
  tiptap.on('transaction', onTransaction);
  scope.onCleanup(() => {
    presence.off('change', paint);
    tiptap.off('transaction', onTransaction);
    if (!tiptap.isDestroyed) tiptap.unregisterPlugin(agentFocusKey);
  });
  paint();
}
