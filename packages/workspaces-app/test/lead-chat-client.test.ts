/**
 * The lead chat's page client: it reads the board's conversation, applies a
 * frame from the board stream in place, folds the POST's own answer in once,
 * and reads again when a dropped stream comes back.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { describe, expect, it } from 'vitest';
import { createLeadChatClient } from '../src/lead-chat/lead-chat-client.ts';

class FakeStream {
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  fire(type: string, data?: unknown) {
    const ev = new MessageEvent(type, data === undefined ? {} : { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

const msg = (id: string, text: string, ts: number, extra: Partial<LeadChatMessage> = {}) =>
  ({
    id,
    role: 'person',
    author: { id: 'known-bryan', name: 'Bryan' },
    text,
    ts,
    ...extra,
  }) as LeadChatMessage;

function setup(reads: unknown[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let stream: FakeStream | null = null;
  const fetchFake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (init?.method === 'POST') {
      return new Response(
        JSON.stringify({ message: msg('m-post', 'hello', 50, { state: 'sent' }) }),
        {
          status: 201,
        },
      );
    }
    return new Response(
      JSON.stringify(reads.shift() ?? { lead: null, messages: [], canTalk: false }),
    );
  }) as unknown as typeof fetch;
  const client = createLeadChatClient({
    workspaceId: 'w-harbor',
    fetch: fetchFake,
    openStream: (u) => {
      stream = new FakeStream(u);
      return stream as unknown as EventSource;
    },
  });
  return { client, calls, stream: () => stream as unknown as FakeStream };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the lead chat client', () => {
  it('reads the board conversation and listens on the board stream', async () => {
    const lead = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
    const { client, stream } = setup([{ lead, messages: [msg('a', 'hi', 1)], canTalk: true }]);
    expect(stream().url).toBe('/workspaces/w-harbor/events:stream');
    await settle();
    expect(client.state()).toMatchObject({ lead, canTalk: true, loaded: true });
    expect(client.state().messages.map((m) => m.id)).toEqual(['a']);
  });

  it('applies a frame in place, and a later frame for the same message replaces it', async () => {
    const { client, stream } = setup([{ lead: null, messages: [], canTalk: true }]);
    await settle();
    const seen: number[] = [];
    client.onChange((s) => seen.push(s.messages.length));
    const frame = (m: LeadChatMessage) =>
      stream().fire('lead-chat.changed', {
        event: 'lead-chat.changed',
        workspaceId: 'w-harbor',
        message: m,
      });
    frame(msg('q', 'status?', 10, { state: 'sent' }));
    frame(msg('q', 'status?', 10, { state: 'answered' }));
    frame(msg('r', 'Two left.', 11, { role: 'agent' }));
    // Another board's frame changes nothing here.
    stream().fire('lead-chat.changed', {
      event: 'lead-chat.changed',
      workspaceId: 'w-riverbend',
      message: msg('x', 'elsewhere', 12),
    });
    expect(client.state().messages.map((m) => [m.id, m.state ?? null])).toEqual([
      ['q', 'answered'],
      ['r', null],
    ]);
    expect(seen).toEqual([1, 1, 2]);
  });

  it('sends with the author, the context and how it was said, and keeps one row', async () => {
    const { client, calls, stream } = setup([{ lead: null, messages: [], canTalk: true }]);
    await settle();
    const res = await client.send(
      'hello',
      { id: 'known-bryan', name: 'Bryan' },
      { surface: 'doc', docId: 'd-1' },
      'voice',
    );
    expect(res.ok).toBe(true);
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      text: 'hello',
      author: { id: 'known-bryan', name: 'Bryan' },
      via: 'voice',
      context: { surface: 'doc', docId: 'd-1' },
    });
    stream().fire('lead-chat.changed', {
      event: 'lead-chat.changed',
      workspaceId: 'w-harbor',
      message: msg('m-post', 'hello', 50, { state: 'sent' }),
    });
    expect(client.state().messages).toHaveLength(1);
  });

  it('reads again when a dropped stream comes back, and not on its first open', async () => {
    const { client, calls, stream } = setup([
      { lead: null, messages: [], canTalk: true },
      { lead: null, messages: [msg('missed', 'while away', 5)], canTalk: true },
    ]);
    await settle();
    stream().fire('open');
    await settle();
    expect(calls).toHaveLength(1);
    stream().fire('error');
    stream().fire('open');
    await settle();
    expect(calls).toHaveLength(2);
    expect(client.state().messages.map((m) => m.id)).toEqual(['missed']);
    client.close();
    expect(stream().closed).toBe(true);
  });

  it('shares the page’s board feed rather than opening a second, and leaves it open', async () => {
    const feed = new FakeStream('/workspaces/w-harbor/events:stream');
    let opened = 0;
    const fetchFake = (async () =>
      new Response(
        JSON.stringify({ lead: null, messages: [], canTalk: true }),
      )) as unknown as typeof fetch;
    const client = createLeadChatClient({
      workspaceId: 'w-harbor',
      fetch: fetchFake,
      stream: feed as unknown as EventSource,
      openStream: () => {
        opened++;
        return new FakeStream('x') as unknown as EventSource;
      },
    });
    await settle();
    feed.fire('lead-chat.changed', {
      event: 'lead-chat.changed',
      workspaceId: 'w-harbor',
      message: msg('s', 'shared', 5),
    });
    expect(client.state().messages.map((m) => m.id)).toEqual(['s']);
    client.close();
    expect([opened, feed.closed]).toEqual([0, false]);
  });
});
