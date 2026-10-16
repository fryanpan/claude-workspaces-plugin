import { prose } from '@claude-workspaces/core';
import { BLOCK_ID_ATTR } from '@claude-workspaces/core/prose';
import { AGENT_FOCUS_FIELD } from '@claude-workspaces/core/spoken-reply';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { agentFocusOf, focusRange, wireAgentFocus } from '../src/doc/agent-focus.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The planning voice's cursor on a page: the server's presence state names a
 * block and the words in it, and the page highlights exactly those words in
 * the agent's colour, with its name on a caret, and scrolls there once per
 * question. Through the real `createEditor`, with the server's awareness a
 * second instance whose updates are applied as the socket applies them.
 */

const PLAN =
  '# Harborlight ferry plan\n\n## Goals\n\n## Requirements\n\n- Carries twelve cars.\n- Who signs off the berth design?\n';

const open: Array<{ handle: EditorHandle; parent: HTMLElement; scope: MountScope }> = [];
const realScroll = Element.prototype.scrollIntoView;
afterEach(() => {
  Element.prototype.scrollIntoView = realScroll;
  for (const o of open.splice(0)) {
    o.scope.dispose();
    o.handle.destroy();
    o.parent.remove();
  }
});

function mount() {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(PLAN));
  prose.ensureBlockIds(ydoc);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const page = new Awareness(ydoc);
  page.setLocalStateField('user', { name: 'Alice', color: '#335' });
  const handle = createEditor({ parent, ydoc, awareness: page });
  const scope = new MountScope();
  open.push({ handle, parent, scope });
  const scrolled: number[] = [];
  // The doc's own scroller moves, and nothing else does.
  Element.prototype.scrollIntoView = () => {
    throw new Error('scrollIntoView moves every ancestor scroller');
  };
  parent.scrollTo = ((o: ScrollToOptions) => {
    scrolled.push(o.top ?? -1);
  }) as typeof parent.scrollTo;
  wireAgentFocus({ editor: handle, presence: page, scroller: parent, scope });
  // The server: its own awareness, no `user`, relayed to the page.
  const server = new Awareness(new Y.Doc());
  const relay = () =>
    applyAwarenessUpdate(page, encodeAwarenessUpdate(server, [server.clientID]), 'server');
  const idOf = (text: string): string => {
    let id = '';
    handle.editor.state.doc.descendants((n) => {
      if (n.textContent === text && typeof n.attrs[BLOCK_ID_ATTR] === 'string' && !id) {
        id = n.attrs[BLOCK_ID_ATTR] as string;
      }
      return true;
    });
    return id;
  };
  const focusNow = (blockId: string, quote: string, seq: number) => {
    server.setLocalStateField(AGENT_FOCUS_FIELD, {
      blockId,
      quote,
      name: 'Claude',
      color: '#2e7dd7',
      seq,
    });
    relay();
  };
  const clear = () => {
    server.setLocalStateField(AGENT_FOCUS_FIELD, null);
    relay();
  };
  const marked = () =>
    Array.from(parent.querySelectorAll('.agent-focus')).map((e) => e.textContent);
  return { handle, parent, page, server, idOf, focusNow, clear, marked, scrolled };
}

describe("the agent's cursor on the page", () => {
  it('highlights the words it names, in its colour, with its name on a caret', () => {
    const h = mount();
    const id = h.idOf('Who signs off the berth design?');
    expect(id).not.toBe('');
    h.focusNow(id, 'Who signs off the berth design?', 1);
    expect(h.marked()).toEqual(['Who signs off the berth design?']);
    const mark = h.parent.querySelector<HTMLElement>('.agent-focus');
    expect(mark?.style.getPropertyValue('--agent-color')).toBe('#2e7dd7');
    expect(h.parent.querySelector('.agent-focus-caret .agent-focus-name')?.textContent).toBe(
      'Claude',
    );
  });

  it('scrolls to the block once per question, not on every repaint', () => {
    const h = mount();
    const goals = h.idOf('Goals');
    h.focusNow(goals, 'Goals', 1);
    expect(h.scrolled).toHaveLength(1);
    // The server renews its presence every fifteen seconds; same question.
    h.focusNow(goals, 'Goals', 1);
    expect(h.scrolled).toHaveLength(1);
    // Asked again: scrolls again.
    h.focusNow(goals, 'Goals', 2);
    expect(h.scrolled).toHaveLength(2);
  });

  it('comes off when the server clears it', () => {
    const h = mount();
    h.focusNow(h.idOf('Goals'), 'Goals', 1);
    expect(h.marked()).toEqual(['Goals']);
    h.clear();
    expect(h.marked()).toEqual([]);
    expect(h.parent.querySelector('.agent-focus-caret')).toBeNull();
  });

  it('never moves the reader’s caret', () => {
    const h = mount();
    const before = h.handle.editor.state.selection.toJSON();
    h.focusNow(h.idOf('Who signs off the berth design?'), 'Who signs off the berth design?', 1);
    expect(h.handle.editor.state.selection.toJSON()).toEqual(before);
  });
});

describe('agentFocusOf', () => {
  it('reads a focus only from a state with no user, and only a well-formed one', () => {
    const states = new Map<number, unknown>([
      [
        1,
        {
          user: { name: 'Bob' },
          agentFocus: { blockId: 'b', quote: 'x', name: 'Claude', color: '#000', seq: 9 },
        },
      ],
      [2, { agentFocus: { blockId: 'b', quote: 'x', name: 'Claude', color: 'red;x', seq: 8 } }],
      [
        3,
        { agentFocus: { blockId: 'b2', quote: 'Goals', name: 'Claude', color: '#2e7dd7', seq: 3 } },
      ],
    ]);
    expect(agentFocusOf({ clientID: 0, getStates: () => states })).toMatchObject({
      blockId: 'b2',
      seq: 3,
    });
  });
});

describe('focusRange', () => {
  it('falls back to the whole block when the words have changed', () => {
    const h = mount();
    const id = h.idOf('Carries twelve cars.');
    const r = focusRange(h.handle.editor.state.doc, { blockId: id, quote: 'Carries ten cars.' });
    expect(r && h.handle.editor.state.doc.textBetween(r.from, r.to)).toBe('Carries twelve cars.');
    expect(focusRange(h.handle.editor.state.doc, { blockId: 'nope', quote: 'x' })).toBeNull();
  });
});
