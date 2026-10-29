/**
 * The lead chat on a page, driven by taps: Chat first opens the panel with
 * the cursor in the composer; Voice first brings out the bar and listens, and
 * a line heard goes to the lead marked as said; the next tap closes it all;
 * a tap on the bar grows it into the panel. The client and the recognition
 * are fakes — no network, no microphone.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeadChatClient, LeadChatState } from '../src/lead-chat/lead-chat-client.ts';
import { LEAD_CHAT_MODE_KEY, type ModeStorage } from '../src/lead-chat/lead-chat-mode.ts';
import { type LeadChatMount, mountLeadChat } from '../src/lead-chat/lead-chat-mount.ts';
import type { RecognitionLike, RecognitionResultEvent } from '../src/voice-capture.ts';

const LEAD = { agentId: 'harborlight-lead', name: 'Harborlight Lead' };
const ME = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

function fakeClient(canTalk = true) {
  let state: LeadChatState = { lead: LEAD, messages: [], canTalk, loaded: true };
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
    close() {},
  };
  return { client, sent, push };
}

class FakeRecognition implements RecognitionLike {
  started = 0;
  stopped = 0;
  onresult: ((ev: RecognitionResultEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  hear(transcript: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript }, isFinal }] });
  }
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
  const rec = new FakeRecognition();
  const dock = opts.dock ? document.createElement('span') : undefined;
  if (dock) document.body.append(dock);
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: ME,
    getContext: () => ({ surface: 'doc', docId: 'd-saltmarsh' }),
    ...(dock ? { dock } : {}),
    client: fake.client,
    storage: memoryStorage(opts.mode),
    createRecognition: () => rec,
    reducedMotion: () => true,
  });
  return { ...fake, rec, view: mounted.view };
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

  it('Voice first: a tap brings out the bar and listens; a line heard goes as said', async () => {
    const { view, rec, sent } = mount({ mode: 'voice' });
    view.button.click();
    expect(view.bar.hidden).toBe(false);
    expect(view.pane.hidden).toBe(true);
    expect(rec.started).toBe(1);
    expect(view.button.dataset.listening).toBe('true');

    rec.hear('read me the', false);
    expect(view.bar.textContent).toContain('read me the');
    rec.hear('read me the next one', true);
    await Promise.resolve();
    expect(sent.map((s) => [s.text, s.via])).toEqual([['read me the next one', 'voice']]);
    // Recognition ends itself after a silence; listening goes on.
    rec.onend?.();
    expect(rec.started).toBe(2);

    view.button.click();
    expect(view.bar.hidden).toBe(true);
    expect(rec.stopped).toBe(1);
    expect(view.button.dataset.listening).toBe('false');
  });

  it('grows the bar into the panel on a tap, still listening', () => {
    const { view, rec } = mount({ mode: 'voice' });
    view.button.click();
    view.bar.click();
    expect(view.pane.hidden).toBe(false);
    expect(view.bar.hidden).toBe(true);
    expect(rec.stopped).toBe(0);
    expect(view.mic.getAttribute('aria-pressed')).toBe('true');
  });

  it('the composer mic turns listening on and off in Chat first', () => {
    const { view, rec } = mount();
    view.button.click();
    view.mic.click();
    expect(rec.started).toBe(1);
    view.mic.click();
    expect(rec.stopped).toBe(1);
    expect(view.pane.hidden).toBe(false);
  });

  it('draws no button for a reader who may not talk to the lead', () => {
    const { view } = mount({ canTalk: false, dock: true });
    const host = view.button.getRootNode() as ShadowRoot;
    expect((host.host as HTMLElement).hidden).toBe(true);
  });
});
