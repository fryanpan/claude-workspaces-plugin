/**
 * The lead chat on a page, driven by taps: Chat first opens the panel with
 * the cursor in the composer; Voice first brings out the bar and listens on
 * the converse socket, addressed to the lead; the next tap closes it all;
 * a tap on the bar grows it into the panel. The client, the converse socket
 * and the microphone are fakes — no network, no device.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeadChatClient, LeadChatState } from '../src/lead-chat/lead-chat-client.ts';
import { LEAD_CHAT_MODE_KEY, type ModeStorage } from '../src/lead-chat/lead-chat-mode.ts';
import { type LeadChatMount, mountLeadChat } from '../src/lead-chat/lead-chat-mount.ts';
import { fakeVoice, settle } from './lead-chat-voice-fakes.ts';

const LEAD = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
const ME = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

function fakeClient(canTalk = true) {
  let state: LeadChatState = {
    lead: LEAD,
    messages: [],
    canTalk,
    loaded: true,
    meeting: null,
    more: false,
    loadingOlder: false,
  };
  const fns: Array<(s: LeadChatState) => void> = [];
  const sent: Array<{ text: string; via: string; context: unknown }> = [];
  let n = 0;
  const push = (m: LeadChatMessage) => {
    state = { ...state, messages: [...state.messages.filter((x) => x.id !== m.id), m] };
    for (const fn of fns) fn(state);
  };
  const client: LeadChatClient = {
    state: () => state,
    onChange: (fn) => {
      fns.push(fn);
    },
    loadOlder: async () => {},
    async send(text, author, context, via) {
      sent.push({ text, via, context });
      const m: LeadChatMessage = {
        id: `m${++n}`,
        role: 'person',
        author: { id: author.id, name: author.name },
        text,
        ts: n,
        via,
        state: 'sent',
      };
      push(m);
      return { ok: true, message: m };
    },
    async meeting() {
      return { ok: false, error: 'not in this test' };
    },
    close() {},
  };
  return { client, sent, push };
}

function memoryStorage(mode?: string): ModeStorage {
  const m = new Map<string, string>(mode ? [[LEAD_CHAT_MODE_KEY, mode]] : []);
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

let mounted: LeadChatMount | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  document.body.innerHTML = '';
});

function mount(opts: { mode?: string; canTalk?: boolean; dock?: boolean } = {}) {
  const fake = fakeClient(opts.canTalk ?? true);
  const voice = fakeVoice();
  const dock = opts.dock ? document.createElement('span') : undefined;
  if (dock) document.body.append(dock);
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: ME,
    getContext: () => ({ surface: 'doc', docId: 'd-saltmarsh' }),
    ...(dock ? { dock } : {}),
    client: fake.client,
    storage: memoryStorage(opts.mode),
    voice: voice.seams,
    reducedMotion: () => true,
  });
  return { ...fake, voice, view: mounted.view };
}

describe('the lead chat on a page', () => {
  it('Chat first: a tap opens the panel at once with the cursor in the composer', async () => {
    const { view, sent } = mount();
    expect(view.pane.hidden).toBe(true);
    view.button.click();
    expect(view.pane.hidden).toBe(false);
    expect(view.bar.hidden).toBe(true);
    expect(view.button.getAttribute('aria-expanded')).toBe('true');
    expect(view.composer.getRootNode()).toBeInstanceOf(ShadowRoot);
    expect((view.composer.getRootNode() as ShadowRoot).activeElement).toBe(view.composer);

    view.composer.value = 'what is left on the signup?';
    view.composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(sent).toEqual([
      {
        text: 'what is left on the signup?',
        via: 'chat',
        context: { surface: 'doc', docId: 'd-saltmarsh' },
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(view.composer.value).toBe('');
    expect(view.list.textContent).toContain('what is left on the signup?');

    view.button.click();
    expect(view.pane.hidden).toBe(true);
  });

  it('shows the lead’s answer in the open panel the moment it arrives', () => {
    const { view, push } = mount();
    view.button.click();
    push({
      id: 'a1',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.name },
      text: 'The email field.',
      ts: 9,
    });
    expect(view.list.textContent).toContain('Harborlight Lead');
    expect(view.list.textContent).toContain('The email field.');
  });

  it('Voice first: a tap brings out the bar and listens to the lead; the next tap stops', async () => {
    const { view, voice, sent } = mount({ mode: 'voice' });
    view.button.click();
    expect(view.bar.hidden).toBe(false);
    expect(view.pane.hidden).toBe(true);
    expect(view.button.dataset.listening).toBe('true');
    await settle();
    const ws = voice.socket();
    ws.open();
    expect(ws.messages()[0]).toMatchObject({ type: 'start', agent: LEAD.agentId });
    expect(voice.mic.starts).toBe(1);

    ws.serve({ type: 'heard', text: 'read me the' });
    expect(view.bar.textContent).toContain('read me the');
    ws.serve({ type: 'turn-end', text: 'read me the next one' });
    // The server writes the spoken turn into the chat; the page sends nothing.
    expect(sent).toEqual([]);

    view.button.click();
    expect(view.bar.hidden).toBe(true);
    expect(view.button.dataset.listening).toBe('false');
    expect(ws.messages().at(-1)).toEqual({ type: 'stop' });
  });

  it('grows the bar into the panel on a tap, still listening', async () => {
    const { view, voice } = mount({ mode: 'voice' });
    view.button.click();
    await settle();
    view.bar.click();
    expect(view.pane.hidden).toBe(false);
    expect(view.bar.hidden).toBe(true);
    expect(voice.mic.stops).toBe(0);
    expect(view.mic.getAttribute('aria-pressed')).toBe('true');
  });

  it('the composer mic turns listening on and off in Chat first', async () => {
    const { view, voice } = mount();
    view.button.click();
    view.mic.click();
    await settle();
    expect(voice.mic.starts).toBe(1);
    view.mic.click();
    expect(voice.mic.stops).toBe(1);
    expect(voice.socket().closed).toBe(true);
    expect(view.pane.hidden).toBe(false);
  });

  it('draws no button for a reader who may not talk to the lead', () => {
    const { view } = mount({ canTalk: false, dock: true });
    const host = view.button.getRootNode() as ShadowRoot;
    expect((host.host as HTMLElement).hidden).toBe(true);
  });
});
