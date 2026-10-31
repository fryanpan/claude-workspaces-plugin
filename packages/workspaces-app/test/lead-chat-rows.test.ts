/**
 * What each entry of the lead chat looks like, driven through the real
 * panel: a tool call is one line that opens to its input and output; a board
 * event is a compact row the header's toggle hides, and the choice is kept;
 * an answer to something said aloud is a bubble whose words open on a tap;
 * a person's message says where it got to.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModeStorage } from '../src/lead-chat/lead-chat-mode.ts';
import { messageState } from '../src/lead-chat/lead-chat-rows.ts';
import {
  type LeadChatView,
  type LeadChatViewModel,
  createLeadChatView,
} from '../src/lead-chat/lead-chat-view.ts';

const LEAD = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
const BRYAN = { id: 'known-bryan', name: 'Bryan' };
const SESSION = { id: LEAD.agentId, name: LEAD.name };

const msg = (m: Partial<LeadChatMessage> & { id: string }): LeadChatMessage => ({
  role: 'agent',
  author: SESSION,
  text: m.id,
  ts: Number(m.id.replace(/\D/g, '')) || 1,
  ...m,
});

const CONVO: LeadChatMessage[] = [
  msg({
    id: 'p1',
    role: 'person',
    author: BRYAN,
    text: 'Is Saltmarsh fixed?',
    via: 'voice',
    state: 'answered',
  }),
  msg({ id: 'a2', text: 'Yes, the install is fixed.', replyTo: 'p1' }),
  msg({
    id: 'c3',
    role: 'person',
    author: { id: 'lead-channel', name: 'Riverbend' },
    text: 'replied on Deploy plan',
    via: 'channel',
  }),
  msg({
    id: 't4',
    text: 'Bash: git status',
    via: 'terminal',
    tool: { name: 'Bash', input: 'git status', output: 'nothing to commit' },
  }),
  msg({
    id: 'k5',
    role: 'person',
    author: { id: 'lead-terminal', name: 'Terminal' },
    text: 'ship it',
    via: 'terminal',
  }),
];

function memory(): ModeStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

let view: LeadChatView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

function open(messages: LeadChatMessage[], storage: ModeStorage | null = null) {
  const host = document.createElement('span');
  document.body.append(host);
  view = createLeadChatView({ document, buttonHost: host, placement: 'float', storage });
  const model: LeadChatViewModel = {
    lead: LEAD,
    messages,
    canTalk: true,
    loaded: true,
    meId: BRYAN.id,
    open: true,
    barOut: false,
    listening: false,
    heard: '',
    notice: '',
  };
  view.render(model);
  const root = view.root;
  const q = <T extends Element = HTMLElement>(s: string) => root.querySelector<T & HTMLElement>(s);
  return { root, q, model, v: view };
}

describe('the lead chat’s entries', () => {
  it('draws a tool call as one line that opens to its input and output', () => {
    const { q } = open(CONVO);
    const head = q('.lc-tool .lc-row-head');
    expect(head?.textContent).toContain('Bash');
    expect(head?.textContent).toContain('git status');
    expect(q('.lc-tool .lc-row-body')).toBeNull();
    head?.click();
    const body = q('.lc-tool .lc-row-body');
    expect([...(body?.querySelectorAll('pre') ?? [])].map((p) => p.textContent)).toEqual([
      'git status',
      'nothing to commit',
    ]);
    expect(q('.lc-tool .lc-row-head')?.getAttribute('aria-expanded')).toBe('true');
    q('.lc-tool .lc-row-head')?.click();
    expect(q('.lc-tool .lc-row-body')).toBeNull();
  });

  it('hides board events behind the header’s toggle, counts them, and keeps the choice', () => {
    const storage = memory();
    const first = open(CONVO, storage);
    expect(first.q('.lc-chan .lc-row-kind')?.textContent).toBe('Riverbend');
    const toggle = first.q('.lc-chan-toggle');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    toggle?.click();
    expect(first.q('.lc-chan')).toBeNull();
    expect(first.q('.lc-chan-toggle')?.getAttribute('aria-pressed')).toBe('false');
    expect(first.q('.lc-chan-count')?.textContent).toBe('(1)');
    view?.destroy();
    document.body.innerHTML = '';
    // The next page reads the same choice.
    const again = open(CONVO, storage);
    expect(again.q('.lc-chan')).toBeNull();
  });

  it('draws the answer to a spoken question as a bubble whose words open on a tap', () => {
    const { q } = open(CONVO);
    const bubble = q('.lc-voice');
    expect(bubble?.textContent).toContain('Show words');
    expect(bubble?.textContent).not.toContain('the install is fixed');
    q<HTMLButtonElement>('.lc-voice-btn')?.click();
    expect(q('.lc-voice .lc-voice-text')?.textContent).toContain('Yes, the install is fixed.');
    expect(q('.lc-voice-btn')?.textContent).toContain('Hide words');
  });

  it('names a prompt typed in the lead’s terminal as such', () => {
    const { root } = open(CONVO);
    const row = root.querySelector('.lc-msg[data-message-id="k5"] .lc-msg-who');
    expect(row?.textContent).toBe('In the terminal');
  });

  it('draws no toggle while there are no board events', () => {
    const { q } = open(CONVO.filter((m) => m.via !== 'channel'));
    expect(q('.lc-chan-toggle')?.hidden).toBe(true);
  });
});

describe('where a person’s message got to', () => {
  const asked = msg({
    id: 'p10',
    role: 'person',
    author: BRYAN,
    via: 'chat',
    state: 'received',
    receivedAt: 10,
  });
  it('reads Received until the lead’s session shows anything after it, then Working', () => {
    expect(messageState(asked, [asked])?.text).toBe('Received');
    const tool = msg({ id: 't11', via: 'terminal', tool: { name: 'Read', input: 'a.md' } });
    expect(messageState(asked, [asked, tool])?.text).toBe('Working');
  });

  it('reads Sent, Done and Answered, and nothing for a mirrored prompt', () => {
    expect(messageState({ ...asked, state: 'sent' }, [])?.text).toBe('Sent');
    expect(messageState({ ...asked, state: 'done' }, [])?.text).toBe('Done');
    expect(messageState({ ...asked, state: 'answered' }, [])?.text).toBe('Answered');
    expect(messageState({ ...asked, via: 'terminal' }, [])).toBeNull();
  });

  it('shows the line under the message in the panel', () => {
    const { root } = open([{ ...asked, state: 'sent' }]);
    const line = root.querySelector('.lc-state');
    expect(line?.textContent).toBe('Sent');
    expect((line as HTMLElement | null)?.dataset.s).toBe('sent');
  });
});
