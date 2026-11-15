/**
 * The lead chat says "Compacting…" while the lead's session compacts its
 * context, in the place "Listening…" sits, and goes back to "Listening…"
 * when the compaction ends. The page's real client reads the board stream;
 * the stream, the converse socket and the microphone are fakes.
 */
import {
  LEAD_CHAT_MODEL_EVENT,
  type LeadChatModelFrame,
  type LeadModelState,
} from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
import { createLeadChatClient } from '../src/lead-chat/lead-chat-client.ts';
import { LEAD_CHAT_MODE_KEY } from '../src/lead-chat/lead-chat-mode.ts';
import { type LeadChatMount, mountLeadChat } from '../src/lead-chat/lead-chat-mount.ts';
import { fakeVoice, settle } from './lead-chat-voice-fakes.ts';

const LEAD = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
const ME = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

class FakeStream {
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  readyState = 1;
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  fire(type: string, data: unknown) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

let mounted: LeadChatMount | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  document.body.innerHTML = '';
  sessionStorage.clear();
});

async function listeningChat() {
  const stream = new FakeStream();
  const client = createLeadChatClient({
    workspaceId: 'w-harbor',
    fetch: (async () =>
      new Response(
        JSON.stringify({ lead: LEAD, messages: [], canTalk: true, leadModel: {} }),
      )) as unknown as typeof fetch,
    openStream: () => stream as unknown as EventSource,
  });
  const voice = fakeVoice();
  const kept = new Map([[LEAD_CHAT_MODE_KEY, 'voice']]);
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: ME,
    client,
    storage: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) },
    voice: voice.seams,
    reducedMotion: () => true,
  });
  await settle();
  const view = mounted.view;
  view.button.click();
  await settle();
  voice.socket().open();
  await settle();
  const model = (state: LeadModelState) =>
    stream.fire(LEAD_CHAT_MODEL_EVENT, {
      event: LEAD_CHAT_MODEL_EVENT,
      workspaceId: 'w-harbor',
      state,
    } satisfies LeadChatModelFrame);
  const status = () => view.root.querySelector('.lc-status')?.textContent ?? '';
  return { view, model, status };
}

describe('the lead chat while the lead compacts', () => {
  it('the bar says Compacting… in place of Listening…, and goes back when it ends', async () => {
    const { view, model } = await listeningChat();
    expect(view.bar.hidden).toBe(false);
    expect(view.bar.textContent).toBe('You: Listening…');

    model({ model: 'claude-opus-5-5', compacting: true });
    expect(view.bar.textContent).toBe('Harborlight Lead: Compacting…');
    expect(view.bar.textContent).not.toContain('Listening…');

    model({ model: 'claude-opus-5-5' });
    expect(view.bar.textContent).toBe('You: Listening…');
  });

  it('the open panel’s status line says Compacting…, then Listening… again', async () => {
    const { view, model, status } = await listeningChat();
    view.bar.click();
    expect(view.pane.hidden).toBe(false);
    expect(status()).toBe('Listening…');

    model({ compacting: true });
    expect(status()).toBe('Compacting…');

    model({});
    expect(status()).toBe('Listening…');
  });
});
