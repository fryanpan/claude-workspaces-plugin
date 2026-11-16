/**
 * M10: the lead chat's heading is a channel picker. #general is the board's
 * chat with its lead; the reader's own lead agent and each other person on
 * the board are one-to-one channels. The steps the approved mock shows:
 * open, switch channel, send, a reply arrives, close, reopen on the same
 * channel. The server is a fake fetch and a fake stream; the chat, the
 * picker and the one-to-one client are the real ones.
 */
import type { DirectMessage } from '@claude-workspaces/core/direct-messages';
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDmClient } from '../src/lead-chat/dm-client.ts';
import type { LeadChatClient, LeadChatState } from '../src/lead-chat/lead-chat-client.ts';
import type { ModeStorage } from '../src/lead-chat/lead-chat-mode.ts';
import { type LeadChatMount, mountLeadChat } from '../src/lead-chat/lead-chat-mount.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

const LEAD = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
const ME = { id: 'user-alice', name: 'Alice' };
const BOB = { id: 'user-bob', name: 'Bob' };

function boardChat(): { client: LeadChatClient; push: (m: LeadChatMessage) => void } {
  let state: LeadChatState = {
    lead: LEAD,
    messages: [],
    canTalk: true,
    loaded: true,
    meeting: null,
    more: false,
    loadingOlder: false,
  };
  const fns: Array<(s: LeadChatState) => void> = [];
  const push = (m: LeadChatMessage) => {
    state = { ...state, messages: [...state.messages, m] };
    for (const fn of fns) fn(state);
  };
  return {
    push,
    client: {
      state: () => state,
      onChange: (fn) => void fns.push(fn),
      onLeadLine: () => {},
      onTaskChange: () => {},
      uploadFile: async () => ({ ok: false, error: 'offline' }),
      loadOlder: async () => {},
      send: async () => ({ ok: false, error: 'not in this test' }),
      meeting: async () => ({ ok: false, error: 'not in this test' }),
      close() {},
    },
  };
}

/** The server: the channel list, Bob's conversation, and Alice's sends. */
function fakeServer(opts: { signedIn?: boolean } = {}) {
  const bobLog: DirectMessage[] = [
    { id: 'pm-1', author: BOB, to: ME.id, text: 'The mooring list is confirmed.', ts: 1 },
  ];
  const posts: Array<{ url: string; body: unknown }> = [];
  let n = 1;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (opts.signedIn === false) return json(401, { error: 'not_signed_in' });
    if (url === '/workspaces/w-harbor/me/dm' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { to: string; text: string };
      posts.push({ url, body });
      const message: DirectMessage = {
        id: `pm-${++n}`,
        author: ME,
        to: body.to,
        text: body.text,
        ts: n,
      };
      bobLog.push(message);
      return json(200, { ok: true, message });
    }
    if (url === '/workspaces/w-harbor/me/dm') {
      return json(200, { me: ME, people: [BOB], lead: { agentId: 'agent-a1', name: 'Riverbend' } });
    }
    if (url === `/workspaces/w-harbor/me/dm?with=${BOB.id}`) {
      return json(200, { messages: bobLog, more: false });
    }
    if (url === '/api/me/messages')
      return json(200, { agentId: 'agent-a1', messages: [], more: false });
    return json(404, {});
  });
  return { fetchFn, posts };
}

class Stream extends EventTarget {
  readyState = 1;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.readyState = 2;
  }
  emit(event: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}

const storage = (): ModeStorage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

let mounted: LeadChatMount | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  document.body.innerHTML = '';
  sessionStorage.clear();
});

function mount(opts: { signedIn?: boolean } = {}) {
  const server = fakeServer(opts);
  const streams: Stream[] = [];
  const board = boardChat();
  const dm = createDmClient({
    workspaceId: 'w-harbor',
    fetch: server.fetchFn as unknown as typeof fetch,
    openStream: (url) => {
      const s = new Stream(url);
      streams.push(s);
      return s as unknown as EventSource;
    },
  });
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: { ...ME, kind: 'known' },
    client: board.client,
    dm,
    storage: storage(),
    voice: fakeVoice().seams,
    reducedMotion: () => true,
  });
  const m = mounted;
  const seen: Array<{ available: boolean; unread: boolean }> = [];
  m.onMessages((x) => seen.push(x));
  const root = m.view.root;
  return {
    ...server,
    ...board,
    m,
    view: m.view,
    streams,
    seen,
    rows: () => [...root.querySelectorAll('[data-chan]')].map((b) => b.textContent ?? ''),
    pick: (name: string) => {
      const row = [...root.querySelectorAll<HTMLElement>('[data-chan]')].find((b) =>
        b.textContent?.includes(name),
      );
      if (!row) throw new Error(`no channel row for ${name}`);
      row.click();
    },
  };
}

describe('the chat’s channels', () => {
  it('opens on #general, switches to Bob, sends, hears his reply live, and reopens on Bob', async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.streams.length).toBe(1));
    expect(t.streams[0]?.url).toBe('/workspaces/w-harbor/me/events:stream');

    t.m.toggle();
    expect(t.view.pane.hidden).toBe(false);
    expect(t.view.picker.name.textContent).toBe('#general');

    t.view.picker.button.click();
    expect(t.view.picker.menu.hidden).toBe(false);
    expect(t.rows()).toHaveLength(3);
    expect(t.rows().join('|')).toMatch(/#general.*Riverbend.*Bob/);

    t.pick('Bob');
    expect(t.view.picker.menu.hidden).toBe(true);
    expect(t.view.picker.name.textContent).toBe('Bob');
    expect(t.view.composer.placeholder).toBe('Message Bob');
    await vi.waitFor(() =>
      expect(t.view.list.textContent).toContain('The mooring list is confirmed.'),
    );
    // Bob's line is a person's, not the agent's.
    expect(t.view.list.querySelector('.lc-person')).not.toBeNull();

    t.view.composer.value = 'Thanks, Bob.';
    t.view.composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    expect(t.posts[0]?.body).toEqual({ to: BOB.id, text: 'Thanks, Bob.' });
    await vi.waitFor(() => expect(t.view.list.textContent).toContain('Thanks, Bob.'));
    expect(t.view.composer.value).toBe('');

    // Bob's reply arrives on Alice's own stream while she is looking.
    t.streams[0]?.emit('direct.message', {
      workspaceId: 'w-harbor',
      message: { id: 'pm-9', author: BOB, to: ME.id, text: 'Any time.', ts: 9 },
    });
    expect(t.view.list.textContent).toContain('Any time.');
    expect(t.seen.at(-1)?.unread).toBe(false);

    t.view.close.click();
    expect(t.view.pane.hidden).toBe(true);
    t.m.toggle();
    expect(t.view.picker.name.textContent).toBe('Bob');
    expect(t.view.list.textContent).toContain('Any time.');
  });

  it('marks a channel unread when a message lands while the chat is closed', async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.streams.length).toBe(1));
    expect(t.seen.at(-1)).toEqual({ available: true, unread: false });
    t.streams[0]?.emit('direct.message', {
      workspaceId: 'w-harbor',
      message: { id: 'pm-7', author: BOB, to: ME.id, text: 'Are you there?', ts: 7 },
    });
    expect(t.seen.at(-1)?.unread).toBe(true);
    t.m.toggle();
    t.view.picker.button.click();
    expect(t.rows().find((r) => r.includes('Bob'))).toContain('Bob: Are you there?');
    t.pick('Bob');
    expect(t.seen.at(-1)?.unread).toBe(false);
    // A frame for another board is not this chat's.
    t.streams[0]?.emit('direct.message', {
      workspaceId: 'w-riverbend',
      message: { id: 'pm-8', author: BOB, to: ME.id, text: 'Other board', ts: 8 },
    });
    expect(t.view.list.textContent).not.toContain('Other board');
  });

  it('marks #general unread when the lead answers while another channel is shown', async () => {
    const t = mount();
    await vi.waitFor(() => expect(t.streams.length).toBe(1));
    t.m.toggle();
    t.view.picker.button.click();
    t.pick('Bob');
    t.push({
      id: 'g1',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.name },
      text: 'Filed it.',
      ts: 5,
    });
    expect(t.seen.at(-1)?.unread).toBe(true);
    t.view.picker.button.click();
    t.pick('#general');
    expect(t.view.composer.placeholder).toBe('Message lead agent');
    expect(t.view.list.textContent).toContain('Filed it.');
    expect(t.seen.at(-1)?.unread).toBe(false);
  });

  it('is the lead chat as it was, with no picker, for a reader with no one-to-one channels', async () => {
    const t = mount({ signedIn: false });
    await vi.waitFor(() => expect(t.fetchFn).toHaveBeenCalled());
    t.m.toggle();
    expect(t.view.picker.name.textContent).toBe('Chat with Lead Agent');
    expect(t.view.picker.button.disabled).toBe(true);
    expect(t.streams).toHaveLength(0);
  });
});
