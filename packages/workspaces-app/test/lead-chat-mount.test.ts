/**
 * The lead chat on a page, driven by taps: Chat first opens the panel with
 * the cursor in the composer; Voice first brings out the bar and listens on
 * the converse socket, addressed to the lead; the next tap closes it all;
 * a tap on the bar grows it into the panel. The client, the converse socket
 * and the microphone are fakes — no network, no device.
 */
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    onLeadLine: () => {},
    onTaskChange: () => {},
    uploadFile: async () => ({ ok: false, error: 'offline' }),
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
  // The tab remembers an open panel across pages; each case starts closed.
  sessionStorage.clear();
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
  it('Chat first: a tap opens the panel at once with the cursor in the composer, listening', async () => {
    const { view, sent, voice } = mount();
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
        // Typed in the panel, so the lead knows the chat is being read.
        context: { surface: 'doc', docId: 'd-saltmarsh', chatOpen: true },
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(view.composer.value).toBe('');
    expect(view.list.textContent).toContain('what is left on the signup?');
    await settle();
    expect(voice.mic.starts).toBe(1);
    expect(view.button.dataset.listening).toBe('true');

    // Open, the agent button stops and starts listening and never closes.
    view.button.click();
    expect(view.pane.hidden).toBe(false);
    expect(view.button.dataset.listening).toBe('false');
    expect(view.button.getAttribute('aria-pressed')).toBe('false');
    view.button.click();
    await settle();
    expect(view.pane.hidden).toBe(false);
    expect(view.button.dataset.listening).toBe('true');
    expect(view.button.getAttribute('aria-pressed')).toBe('true');
    // Close closes, and stops listening.
    view.close.click();
    expect(view.pane.hidden).toBe(true);
    expect(view.button.dataset.listening).toBe('false');
  });

  it('opens again on the next page of the tab when it was open, and not once it was closed', () => {
    mount().view.button.click();
    mounted?.destroy();
    document.body.innerHTML = '';
    // The next page in the same tab.
    const next = mount();
    expect(next.view.pane.hidden).toBe(false);
    next.view.close.click();
    expect(next.view.pane.hidden).toBe(true);
    mounted?.destroy();
    document.body.innerHTML = '';
    expect(mount().view.pane.hidden).toBe(true);
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
    // Listening from the bar, with the panel shut: the answer is heard only.
    expect(ws.messages()[0]).toMatchObject({
      type: 'start',
      agent: LEAD.agentId,
      context: { surface: 'doc', docId: 'd-saltmarsh', chatOpen: false },
    });
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
    expect(view.button.dataset.listening).toBe('true');
    // The agent button is the one listen control: its tap stops listening,
    // and the panel stays open until Close.
    view.button.click();
    expect(view.pane.hidden).toBe(false);
    expect(view.button.dataset.listening).toBe('false');
    expect(voice.mic.stops).toBe(1);
  });

  it('the composer’s mic is the same voice as the agent button, and names the lead plainly', () => {
    const { view } = mount({ mode: 'voice' });
    view.button.click();
    view.bar.click();
    const buttons = [...view.pane.querySelectorAll('button')];
    const listens = buttons.filter((b) =>
      /listen|talk|mic/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title} ${b.className}`),
    );
    expect(listens).toEqual([view.compose.mic]);
    expect(view.compose.mic.getAttribute('aria-pressed')).toBe(view.button.dataset.listening);
    expect(view.pane.querySelector('.lc-title h2')?.textContent).toBe('Chat with Lead Agent');
    expect(view.composer.placeholder).toBe('Message lead agent');
    expect(view.composer.getAttribute('aria-label')).toBe('Message lead agent');
  });

  it('draws no button for a reader who may not talk to the lead', () => {
    const { view } = mount({ canTalk: false, dock: true });
    const host = view.button.getRootNode() as ShadowRoot;
    expect((host.host as HTMLElement).hidden).toBe(true);
  });
});

describe('voice on, carried to the next page of the tab', () => {
  /** The page unloads, and the next page of the tab mounts its own chat. */
  const nextPage = (opts: Parameters<typeof mount>[0] = {}) => {
    window.dispatchEvent(new Event('pagehide'));
    mounted?.destroy();
    document.body.innerHTML = '';
    window.dispatchEvent(new Event('pageshow'));
    return mount(opts);
  };

  it('Voice first: the next page brings the bar out and listens, with no tap', async () => {
    const first = mount({ mode: 'voice' });
    first.view.button.click();
    await settle();
    expect(first.view.button.dataset.listening).toBe('true');
    const next = nextPage({ mode: 'voice' });
    await settle();
    expect(next.view.bar.hidden).toBe(false);
    expect(next.view.pane.hidden).toBe(true);
    expect(next.view.button.dataset.listening).toBe('true');
    expect(next.voice.mic.starts).toBe(1);
    // Addressed to the lead, as the tap's start was.
    const ws = next.voice.socket();
    ws.open();
    expect(ws.messages().find((m) => m.type === 'start')).toMatchObject({ agent: LEAD.agentId });
    next.voice.speak();
    expect(ws.frames()).toBeGreaterThan(0);
  });

  it('with the panel open: the next page opens the panel and listens', async () => {
    const first = mount();
    first.view.button.click();
    await settle();
    const next = nextPage();
    await settle();
    expect(next.view.pane.hidden).toBe(false);
    expect(next.view.button.dataset.listening).toBe('true');
  });

  it('stays off on the next page once the reader turned it off', async () => {
    const first = mount({ mode: 'voice' });
    first.view.button.click();
    await settle();
    first.view.button.click();
    expect(first.view.button.dataset.listening).toBe('false');
    const next = nextPage({ mode: 'voice' });
    await settle();
    expect(next.view.bar.hidden).toBe(true);
    expect(next.voice.mic.starts).toBe(0);
  });

  it('where the next page waits for a tap, a tap on the agent button is that tap', async () => {
    const first = mount({ mode: 'voice' });
    first.view.button.click();
    await settle();
    // iOS Safari: a context made outside a tap stays suspended.
    const saved = (window as unknown as { AudioContext?: unknown }).AudioContext;
    class Suspended {
      state = 'suspended';
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = Suspended;
    vi.useFakeTimers();
    try {
      const next = nextPage({ mode: 'voice' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(next.view.button.dataset.listening).toBe('true');
      next.view.button.click();
      expect(next.view.button.dataset.listening).toBe('true');
      expect(next.view.bar.hidden).toBe(false);
      // The next tap is the reader's own again: it puts the bar away.
      next.view.button.click();
      expect(next.view.button.dataset.listening).toBe('false');
    } finally {
      vi.useRealTimers();
      (window as unknown as { AudioContext: unknown }).AudioContext = saved;
    }
  });

  it('a tap elsewhere that wakes voice leaves the agent button’s next tap its own', async () => {
    const first = mount({ mode: 'voice' });
    first.view.button.click();
    await settle();
    const saved = (window as unknown as { AudioContext?: unknown }).AudioContext;
    class Suspended {
      state = 'suspended';
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = Suspended;
    vi.useFakeTimers();
    try {
      const next = nextPage({ mode: 'voice' });
      await vi.advanceTimersByTimeAsync(1_000);
      // The tap that wakes it lands on the page, not the button.
      const page = document.createElement('p');
      document.body.append(page);
      page.click();
      expect(next.view.button.dataset.listening).toBe('true');
      // The next tap on the agent button stops voice, as it would anywhere.
      next.view.button.click();
      expect(next.view.button.dataset.listening).toBe('false');
      expect(next.view.bar.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
      (window as unknown as { AudioContext: unknown }).AudioContext = saved;
    }
  });

  it('on a phone, a page in the nav moves the listening panel into the bar', async () => {
    const { view, voice } = mount();
    const nav = document.createElement('a');
    nav.className = 'board-nav-item';
    document.body.append(nav);
    view.button.click();
    await settle();
    view.pane.classList.add('lc-sheet');
    nav.click();
    expect(view.pane.hidden).toBe(true);
    expect(view.bar.hidden).toBe(false);
    expect(view.button.dataset.listening).toBe('true');
    expect(voice.mic.stops).toBe(0);
  });

  it('on a phone, a page in the nav still closes a panel that is not listening', async () => {
    const { view } = mount();
    const nav = document.createElement('a');
    nav.className = 'board-nav-item';
    document.body.append(nav);
    view.button.click();
    await settle();
    view.button.click();
    expect(view.button.dataset.listening).toBe('false');
    view.pane.classList.add('lc-sheet');
    nav.click();
    expect(view.pane.hidden).toBe(true);
    expect(view.bar.hidden).toBe(true);
  });

  it('a touch on a canvas that cancels its click still wakes voice', async () => {
    const first = mount({ mode: 'voice' });
    first.view.button.click();
    await settle();
    const saved = (window as unknown as { AudioContext?: unknown }).AudioContext;
    let resumes = 0;
    class Suspended {
      state = 'suspended';
      resume(): Promise<void> {
        resumes++;
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = Suspended;
    vi.useFakeTimers();
    try {
      const next = nextPage({ mode: 'voice' });
      await vi.advanceTimersByTimeAsync(1_000);
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const asleep = resumes;
      // On the agent button a touch leaves the wake to its click.
      next.view.button.dispatchEvent(new Event('touchend', { bubbles: true, composed: true }));
      expect(resumes).toBe(asleep);
      canvas.dispatchEvent(new Event('touchend', { bubbles: true, composed: true }));
      expect(resumes).toBeGreaterThan(asleep);
      // No click came, so the agent button's next tap stops voice as usual.
      next.view.button.click();
      expect(next.view.button.dataset.listening).toBe('false');
    } finally {
      vi.useRealTimers();
      (window as unknown as { AudioContext: unknown }).AudioContext = saved;
    }
  });

  it('a touch on a board link leaves the wake to its click, so iOS still follows the link', async () => {
    const first = mount({ mode: 'voice' });
    first.view.button.click();
    await settle();
    const saved = (window as unknown as { AudioContext?: unknown }).AudioContext;
    let resumes = 0;
    class Suspended {
      state = 'suspended';
      resume(): Promise<void> {
        resumes++;
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = Suspended;
    vi.useFakeTimers();
    try {
      nextPage({ mode: 'voice' });
      await vi.advanceTimersByTimeAsync(1_000);
      const link = document.createElement('a');
      link.href = '/workspaces/w-1/mockups/d-Riv_B0ab';
      link.addEventListener('click', (e) => e.preventDefault());
      document.body.append(link);
      const asleep = resumes;
      // Waking during the touch changes the page, and iOS then drops the click.
      link.dispatchEvent(new Event('touchend', { bubbles: true, composed: true }));
      expect(resumes).toBe(asleep);
      link.click();
      expect(resumes).toBeGreaterThan(asleep);
    } finally {
      vi.useRealTimers();
      (window as unknown as { AudioContext: unknown }).AudioContext = saved;
    }
  });

  /** A link as the chat draws it, inside the list. */
  const chatLink = (view: LeadChatMount['view'], target?: string): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.href = '/workspaces/w-1/whiteboards/d-ferry';
    if (target) a.target = target;
    a.addEventListener('click', (e) => e.preventDefault());
    view.list.append(a);
    return a;
  };

  it('on a phone, a link in the chat moves the listening panel into the bar', async () => {
    const { view, voice } = mount();
    view.button.click();
    await settle();
    view.pane.classList.add('lc-sheet');
    chatLink(view).click();
    expect(view.pane.hidden).toBe(true);
    expect(view.bar.hidden).toBe(false);
    expect(view.button.dataset.listening).toBe('true');
    expect(voice.mic.stops).toBe(0);
  });

  it('a link that opens a new tab, or any link in a docked chat, leaves the panel open', async () => {
    const { view } = mount();
    view.button.click();
    await settle();
    view.pane.classList.remove('lc-sheet');
    chatLink(view).click();
    expect(view.pane.hidden).toBe(false);
    view.pane.classList.add('lc-sheet');
    chatLink(view, '_blank').click();
    expect(view.pane.hidden).toBe(false);
  });
});
