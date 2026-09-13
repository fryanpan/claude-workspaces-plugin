import type { VoiceTarget } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STOP_LABEL, mountVoiceMode } from '../src/voice/voice-mode.ts';
import { SIGN_IN_NOTE, addMic } from '../src/widget-mic.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';
import { FakeSocket, commentFrame, fakeMic } from './voice-fakes.ts';

/**
 * Voice feedback mounted on a widget, against a page: the socket and the
 * microphone are stand-ins, the thread routes are a recorded `fetch`, and the
 * page is real DOM a test taps on.
 */

const LABELS = {
  comment: 'Type: comment on this mock',
  voice: 'Talk: voice feedback on this mock',
  history: 'Past comments on this mock',
  icon: '<svg class="idle-glyph"></svg>',
};

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

const cleanups: Array<() => void> = [];

function setup(over: { signInToWrite?: boolean } = {}) {
  document.body.innerHTML =
    '<main><h1 id="goal">Goal</h1><button id="done">Done <b></b></button></main>';
  const host = document.createElement('claude-feedback-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  for (const cls of ['fab-list', 'fab']) {
    const b = document.createElement('button');
    b.className = cls;
    shadow.append(b);
  }
  document.body.append(host);
  const widget = Object.assign(host, {
    shadow,
    opts: { serverUrl: 'http://host:8787', workspaceId: 'w-1', docId: 'd-1' },
    user: { name: 'Ada', color: '#123456' },
    feedbackMode: false,
    signInToWrite: over.signInToWrite === true,
    authToken: null,
    currentContext: undefined,
  }) as unknown as FeedbackWidgetEl;

  const posted: Posted[] = [];
  const server = { refuse: false, n: 0 };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (server.refuse) return new Response('{}', { status: 500 });
    server.n += 1;
    return new Response(
      JSON.stringify({ thread: { id: `t${server.n}`, comments: [{ id: `c${server.n}` }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const sockets: FakeSocket[] = [];
  const mic = fakeMic();
  const micParts = addMic(widget, LABELS);
  const mode = mountVoiceMode(widget, micParts, {
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    startCapture: mic.start,
    shown: () => true,
  });
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket was opened');
    return s;
  };
  // A recording left running keeps its document listeners, which would take
  // the next test's taps.
  cleanups.push(() => {
    if (mode.session.state === 'idle') return;
    mode.session.stop();
    sockets.at(-1)?.recv({ type: 'stopped' });
  });
  /** The catalog index the page sent for the element with this id. */
  const indexOf = (id: string): number => {
    const start = socket()
      .json()
      .find((m) => m.type === 'start') as { targets: VoiceTarget[] } | undefined;
    const text = (document.getElementById(id) as HTMLElement).textContent?.trim();
    const t = start?.targets.find((x) => x.text === text);
    if (!t) throw new Error(`no target for #${id}`);
    return t.i;
  };
  const tap = (el: Element): MouseEvent => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    el.dispatchEvent(ev);
    return ev;
  };
  return { widget, mode, mic, micParts, sockets, socket, posted, server, indexOf, tap, shadow };
}

/** Tap the mic's toggle, and the server's engine comes up. */
async function recording(t: ReturnType<typeof setup>): Promise<void> {
  t.mode.toggle();
  t.socket().open();
  t.socket().recv({ type: 'ready', segment: 1 });
  await vi.waitFor(() => expect(t.mic.opts).not.toBeNull());
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('tapping the page while recording', () => {
  it('pins the next words to the tapped element instead of clicking it', async () => {
    const t = setup();
    await recording(t);
    const pageHandler = vi.fn();
    document.getElementById('goal')?.addEventListener('click', pageHandler);
    const ev = t.tap(document.getElementById('goal') as HTMLElement);
    expect(ev.defaultPrevented).toBe(true);
    expect(pageHandler, 'the page’s own click does not run').not.toHaveBeenCalled();
    expect(t.socket().json().at(-1)).toEqual({ type: 'pin', target: t.indexOf('goal') });
    expect(t.mode.session.pinned).toBe(t.indexOf('goal'));
  });

  it('pins the nearest element the catalog names when the tap lands inside it', async () => {
    const t = setup();
    await recording(t);
    t.tap(document.querySelector('#done b') as HTMLElement);
    expect(t.socket().json().at(-1)).toEqual({ type: 'pin', target: t.indexOf('done') });
  });

  it('describes an element added since the start before pinning it', async () => {
    const t = setup();
    await recording(t);
    const late = document.createElement('button');
    late.textContent = 'Harborlight follow-up';
    document.body.append(late);
    t.tap(late);
    const sent = t.socket().json();
    const pin = sent.at(-1) as { type: string; target: number };
    expect(pin.type).toBe('pin');
    const described = sent
      .slice(0, -1)
      .filter((m) => m.type === 'targets')
      .at(-1) as { targets: VoiceTarget[] } | undefined;
    expect(
      described?.targets.find((x) => x.i === pin.target)?.text,
      'the server heard of the element before the pin named it',
    ).toBe('Harborlight follow-up');
  });

  it('leaves taps inside the widget to the widget', async () => {
    const t = setup();
    await recording(t);
    const before = t.socket().json().length;
    const ev = t.tap(t.shadow.querySelector('.fab') as HTMLElement);
    expect(ev.defaultPrevented).toBe(false);
    expect(t.socket().json().length).toBe(before);
  });

  it('moves the open comment to the element tapped after Move', async () => {
    const t = setup();
    await recording(t);
    t.socket().recv(commentFrame({ key: 'v1', target: null }));
    await vi.waitFor(() => expect(t.mode.session.comments.get('1.v1')?.posted).toBeTruthy());
    expect(t.posted[0]?.url).toBe('http://host:8787/workspaces/w-1/docs/d-1/threads');
    expect(t.posted[0]?.body.anchor, 'about the page as a whole').toEqual({ kind: 'subject' });

    t.tap(t.mode.view.live.querySelector('.vmove') as HTMLElement);
    expect(t.mode.view.picking, 'Move is inside the widget, so it reaches its button').toBe('1.v1');
    t.tap(document.getElementById('done') as HTMLElement);
    expect(t.socket().json().at(-1)).toEqual({
      type: 'move',
      key: 'v1',
      target: t.indexOf('done'),
    });
    expect(t.mode.view.picking).toBeNull();
    expect(
      t
        .socket()
        .json()
        .some((m) => m.type === 'pin'),
      'a Move tap is not a pin',
    ).toBe(false);
    await vi.waitFor(() => expect(t.posted).toHaveLength(2));
    expect(t.posted[1]?.url).toBe('http://host:8787/workspaces/w-1/docs/d-1/threads/t1/reanchor');
    expect(t.posted[1]?.body.anchor).toMatchObject({ kind: 'element' });
  });

  it('anchors a comment the server placed on an element to that element', async () => {
    const t = setup();
    await recording(t);
    t.socket().recv(commentFrame({ key: 'v1', target: t.indexOf('goal') }));
    await vi.waitFor(() => expect(t.posted).toHaveLength(1));
    expect(t.posted[0]?.body).toMatchObject({
      text: 'the goal bar is too tall',
      anchor: { kind: 'element', snippet: { text: 'Goal' } },
      voice: { clip: '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=2,9' },
    });
  });

  it('stops taking the page’s clicks once the recording has ended', async () => {
    const t = setup();
    await recording(t);
    expect(t.tap(document.getElementById('goal') as HTMLElement).defaultPrevented).toBe(true);
    t.mode.toggle();
    expect(t.socket().json().at(-1)).toEqual({ type: 'stop' });
    t.socket().recv({ type: 'stopped' });
    expect(t.mode.session.state).toBe('idle');
    const pageHandler = vi.fn();
    document.getElementById('goal')?.addEventListener('click', pageHandler);
    const ev = t.tap(document.getElementById('goal') as HTMLElement);
    expect(ev.defaultPrevented).toBe(false);
    expect(pageHandler).toHaveBeenCalledTimes(1);
  });

  it('stops on Escape', async () => {
    const t = setup();
    await recording(t);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(t.mode.session.state).toBe('stopping');
  });

  it('describes the page again once it has changed and gone still', async () => {
    const t = setup();
    await recording(t);
    vi.useFakeTimers();
    try {
      const added = document.createElement('p');
      added.textContent = 'New row';
      document.querySelector('main')?.append(added);
      await vi.advanceTimersByTimeAsync(1500);
      const frame = t.socket().json().at(-1) as { type: string; targets?: VoiceTarget[] };
      expect(frame.type).toBe('targets');
      expect(frame.targets?.map((x) => x.text)).toContain('New row');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the mic button', () => {
  it('starts and stops recording, and wears the state it is in', async () => {
    const t = setup();
    const button = t.micParts.button;
    button.click();
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0]?.url).toBe('http://host:8787/workspaces/w-1/docs/d-1/voice');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('voice-active')).toBe(true);
    expect(button.querySelector('.vstop'), 'a Stop square while recording').not.toBeNull();
    expect(button.dataset.tip, 'its label says what a tap does now').toBe(STOP_LABEL);
    t.socket().open();
    t.socket().recv({ type: 'ready', segment: 1 });
    await vi.waitFor(() => expect(t.mic.opts).not.toBeNull());
    button.click();
    t.socket().recv({ type: 'stopped' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.classList.contains('voice-active')).toBe(false);
    expect(button.querySelector('.idle-glyph'), 'its own glyph back').not.toBeNull();
    expect(button.dataset.tip, 'and its own label').toBe(LABELS.voice);
  });

  it('says why voice is unavailable in the readout', async () => {
    const t = setup();
    t.mode.toggle();
    t.socket().open();
    t.socket().recv({ type: 'unavailable', reason: 'not_configured' });
    expect(t.micParts.readout.textContent).toBe('Voice feedback is not set up on this server.');
    expect(t.micParts.readout.classList.contains('hidden')).toBe(false);
  });

  it('is mounted once per widget', () => {
    const t = setup();
    const again = mountVoiceMode(t.widget, t.micParts);
    expect(again).toBe(t.mode);
    expect(t.shadow.querySelectorAll('.vlive')).toHaveLength(1);
    t.micParts.button.click();
    expect(t.sockets, 'one tap, one recording').toHaveLength(1);
  });
});

describe('a workspace that wants a signature', () => {
  it('asks for a sign-in and posts the comment once it lands', async () => {
    const t = setup({ signInToWrite: true });
    t.server.refuse = true;
    await recording(t);
    t.socket().recv(commentFrame({ key: 'v1' }));
    await vi.waitFor(() => expect(t.micParts.readout.textContent).toBe(SIGN_IN_NOTE));
    const slot = t.widget as unknown as { retryAfterSignIn: (() => void) | null };
    expect(typeof slot.retryAfterSignIn, 'the retry is armed').toBe('function');

    t.server.refuse = false;
    slot.retryAfterSignIn?.();
    await vi.waitFor(() => expect(t.mode.session.comments.get('1.v1')?.posted).toBeTruthy());
    expect(t.posted.map((p) => p.body.text)).toEqual([
      'the goal bar is too tall',
      'the goal bar is too tall',
    ]);
  });
});
