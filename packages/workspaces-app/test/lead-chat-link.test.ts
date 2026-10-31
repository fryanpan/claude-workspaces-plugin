/**
 * The link a message to the lead carries, per page: the most specific thing
 * open there — the review item, the doc thread, the doc, the task, the mock
 * or app door, then the plain board page — and nothing else of the address.
 * Then the same link riding both channels out of a mounted chat: a typed
 * message, and the `start` of a spoken turn. Fakes for the client and the
 * converse socket; no network.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeadChatClient } from '../src/lead-chat/lead-chat-client.ts';
import { messageLinkOf, withMessageLink } from '../src/lead-chat/lead-chat-link.ts';
import { LEAD_CHAT_MODE_KEY } from '../src/lead-chat/lead-chat-mode.ts';
import { type LeadChatMount, mountLeadChat } from '../src/lead-chat/lead-chat-mount.ts';
import type { VoiceContext } from '../src/voice-capture.ts';
import { fakeVoice, settle } from './lead-chat-voice-fakes.ts';

const WS = '/workspaces/w-harbor';
const ITEM = encodeURIComponent('w-harbor:task-review:t-1:ri-1');

describe('messageLinkOf', () => {
  const pages: Array<[string, string, string, string | null | undefined, string | undefined]> = [
    [
      'a review item on Home',
      `${WS}/home`,
      `?item=${ITEM}&as=riverbend`,
      undefined,
      `${WS}/home?item=${ITEM}`,
    ],
    ['a doc thread', `${WS}/docs/d-plan`, '', 'th-1', `${WS}/docs/d-plan?thread=th-1`],
    [
      'a doc whose deep-linked thread was closed',
      `${WS}/docs/d-plan`,
      '?thread=th-1',
      null,
      `${WS}/docs/d-plan`,
    ],
    ['a doc', `${WS}/docs/d-plan`, '', null, `${WS}/docs/d-plan`],
    ['a task thread', WS, '?task=t-1&thread=th-2', undefined, `${WS}?task=t-1&thread=th-2`],
    ['a task', WS, '?task=t-1&walk=1', undefined, `${WS}?task=t-1`],
    ['a goal', WS, '?goal=g-1', undefined, `${WS}?goal=g-1`],
    ['a mock', `${WS}/mockups/m-signup`, '', undefined, `${WS}/mockups/m-signup`],
    ['an app door', `${WS}/apps/a-signup/`, '', undefined, `${WS}/apps/a-signup/`],
    ['the plain board page', `${WS}/library`, '?view=archived', undefined, `${WS}/library`],
    ['a page off any board', '/settings', '?task=t-1', undefined, undefined],
  ];
  for (const [name, pathname, search, thread, want] of pages) {
    it(`from ${name}`, () => {
      expect(messageLinkOf(pathname, search, thread)).toBe(want);
    });
  }

  it('adds the link to the page context, on the board surface when there is none', () => {
    const doc: VoiceContext = { surface: 'doc', docId: 'd-plan' };
    expect(withMessageLink(doc, `${WS}/docs/d-plan`)).toEqual({
      surface: 'doc',
      docId: 'd-plan',
      link: `${WS}/docs/d-plan`,
    });
    expect(withMessageLink(undefined, `${WS}/library`)).toEqual({
      surface: 'board',
      link: `${WS}/library`,
    });
    expect(withMessageLink(doc, undefined)).toBe(doc);
  });
});

describe('a mounted chat sends the page link', () => {
  const ME = { id: 'known-alice', name: 'Alice', kind: 'known' };
  let mounted: LeadChatMount | null = null;
  afterEach(() => {
    mounted?.destroy();
    mounted = null;
    document.body.innerHTML = '';
    // The tab remembers an open panel across pages; each case starts closed.
    sessionStorage.clear();
    history.replaceState(null, '', '/');
  });

  function mount(mode: 'chat' | 'voice', openThread?: () => string | null) {
    const sent: unknown[] = [];
    let n = 0;
    const client: LeadChatClient = {
      state: () => ({
        lead: { agentId: 'harborlight-lead', name: 'Harborlight Lead' },
        messages: [],
        canTalk: true,
        loaded: true,
        more: false,
        loadingOlder: false,
        meeting: null,
      }),
      onLeadLine: () => {},
      onChange: () => {},
      async loadOlder() {},
      async send(text, author, context, via) {
        sent.push(context);
        const m: LeadChatMessage = {
          id: `m${++n}`,
          role: 'person',
          author: { id: author.id, name: author.name },
          text,
          ts: n,
          via,
          state: 'sent',
        };
        return { ok: true, message: m };
      },
      async meeting() {
        return { ok: false, error: 'not in this test' };
      },
      close() {},
    };
    const voice = fakeVoice();
    const store = new Map<string, string>([[LEAD_CHAT_MODE_KEY, mode]]);
    mounted = mountLeadChat({
      workspaceId: 'w-harbor',
      author: ME,
      getContext: () => ({ surface: 'board' }),
      ...(openThread ? { openThread } : {}),
      client,
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
      voice: voice.seams,
      reducedMotion: () => true,
    });
    return { view: mounted.view, sent, voice };
  }

  it('typed, from an open review item', async () => {
    history.replaceState(null, '', `${WS}/home?item=${ITEM}`);
    const { view, sent } = mount('chat');
    view.button.click();
    view.composer.value = 'yes, ship it';
    view.composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(sent).toEqual([{ surface: 'board', link: `${WS}/home?item=${ITEM}` }]);
  });

  it('spoken, from a doc thread the panel has open', async () => {
    history.replaceState(null, '', `${WS}/docs/d-plan`);
    const { view, voice } = mount('voice', () => 'th-1');
    view.button.click();
    await settle();
    const ws = voice.socket();
    ws.open();
    expect(ws.messages()[0]).toMatchObject({
      type: 'start',
      context: { surface: 'board', link: `${WS}/docs/d-plan?thread=th-1` },
    });
  });
});

describe('the doc page’s open thread', () => {
  it('reads the mounted doc’s panel, and a doc that unmounts drops only its own reader', async () => {
    const { openThreadId, setOpenThreadReader } = await import('../src/doc/open-thread.ts');
    expect(openThreadId()).toBeNull();
    const dropFirst = setOpenThreadReader(() => 'th-1');
    expect(openThreadId()).toBe('th-1');
    const dropSecond = setOpenThreadReader(() => 'th-2');
    dropFirst();
    expect(openThreadId()).toBe('th-2');
    dropSecond();
    expect(openThreadId()).toBeNull();
  });
});
