/**
 * The lead chat redraws without replacing a row that did not change, driven
 * through the real panel. A redraw on a word the listener heard, or on news
 * about another message, leaves the link a reader is pressing in place, so
 * the press's release still lands on it (Bryan, 1 Nov: "Your links don't work
 * in chat in board"). A row that did change is drawn anew, and the list holds
 * the conversation in order.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
import { patchRows } from '../src/lead-chat/lead-chat-patch.ts';
import {
  type LeadChatView,
  type LeadChatViewModel,
  createLeadChatView,
} from '../src/lead-chat/lead-chat-view.ts';

const LEAD = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice' };

const REPLY: LeadChatMessage = {
  id: 'a1',
  role: 'agent',
  author: { id: LEAD.agentId, name: LEAD.name },
  text: '- [What We Know](/workspaces/w-riverbend/docs/d-saltmarsh): the research summary',
  ts: 1,
};
const ASKED: LeadChatMessage = {
  id: 'p2',
  role: 'person',
  author: ALICE,
  text: 'And the plan?',
  ts: 2,
  via: 'chat',
  state: 'sent',
};

let view: LeadChatView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

function open(messages: LeadChatMessage[]): (m: Partial<LeadChatViewModel>) => void {
  const host = document.createElement('span');
  document.body.append(host);
  const v = createLeadChatView({ document, buttonHost: host, placement: 'float', storage: null });
  view = v;
  const model: LeadChatViewModel = {
    lead: LEAD,
    messages,
    canTalk: true,
    loaded: true,
    meId: ALICE.id,
    open: true,
    barOut: false,
    listening: false,
    heard: '',
    notice: '',
  };
  v.render(model);
  return (m) => v.render({ ...model, ...m });
}

const row = (id: string): Element | null =>
  view?.list.querySelector(`[data-message-id="${id}"]`) ?? null;
const link = (): HTMLAnchorElement | null => row('a1')?.querySelector('a') ?? null;
const order = (): string[] =>
  [...(view?.list.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].map(
    (e) => e.dataset.messageId ?? '',
  );

describe('the lead chat redraws in place', () => {
  it('keeps the link a reader is pressing through a redraw on what the listener heard', () => {
    const render = open([REPLY, ASKED]);
    const pressed = link();
    // CONTROL: the reply drew a link to the doc.
    expect(pressed?.getAttribute('href')).toContain('/docs/d-saltmarsh');
    render({ listening: true, voice: 'listening', heard: 'what about' });
    render({ listening: true, voice: 'listening', heard: 'what about the plan' });
    expect(link()).toBe(pressed);
    expect(pressed?.isConnected).toBe(true);
  });

  it('keeps the reply when another message changes, and draws that one anew', () => {
    const render = open([REPLY, ASKED]);
    const pressed = link();
    const before = row('p2');
    expect(before?.querySelector('.lc-state')?.textContent).toContain('Sent');
    render({ messages: [REPLY, { ...ASKED, state: 'received', receivedAt: 3 }] });
    expect(link()).toBe(pressed);
    expect(row('p2')).not.toBe(before);
    expect(row('p2')?.querySelector('.lc-state')?.textContent).toContain('Received');
  });

  it('keeps what was done to a kept row, and the order of the conversation', () => {
    const render = open([REPLY]);
    // A link's title filled in after it was drawn.
    link()?.setAttribute('data-filled', '');
    render({ messages: [REPLY, ASKED] });
    expect(link()?.hasAttribute('data-filled')).toBe(true);
    expect(order()).toEqual(['a1', 'p2']);
    render({ messages: [ASKED] });
    expect(order()).toEqual(['p2']);
    expect(link()).toBeNull();
  });
});

describe('patchRows', () => {
  const p = (text: string): HTMLElement => {
    const e = document.createElement('p');
    e.textContent = text;
    return e;
  };

  it('moves a kept row into its new place and drops one that went', () => {
    const list = document.createElement('div');
    const kept = new Map();
    patchRows(
      list,
      [
        ['a', p('a')],
        ['b', p('b')],
        ['c', p('c')],
      ],
      kept,
    );
    const b = list.children[1];
    patchRows(
      list,
      [
        ['c', p('c')],
        ['b', p('b')],
      ],
      kept,
    );
    expect([...list.children].map((e) => e.textContent)).toEqual(['c', 'b']);
    expect(list.children[1]).toBe(b);
  });

  it('draws a row anew when its markup changed', () => {
    const list = document.createElement('div');
    const kept = new Map();
    patchRows(list, [['a', p('one')]], kept);
    const first = list.firstElementChild;
    patchRows(list, [['a', p('two')]], kept);
    expect(list.firstElementChild).not.toBe(first);
    expect(list.textContent).toBe('two');
  });
});
