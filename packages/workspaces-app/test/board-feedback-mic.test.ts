import type { FeedbackWidgetEl } from '@claude-workspaces/widget';
import { SIGN_IN_NOTE } from '@claude-workspaces/widget/mic';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_LABELS, mountFeedbackMic } from '../src/board/board-feedback-mic.ts';
import { mountShell } from './support/board-region-harness.ts';

/**
 * Voice feedback about Workspaces itself, from any board.
 *
 * The widget on a board is bound to the Workspaces feedback doc, not to the
 * project on the board — so the button in the thread list's old slot is a
 * tap-to-talk mic whose comments land where typed feedback does. The capture,
 * the socket and the live comment are the widget's voice mode; what the board
 * adds is the wording on the buttons and a glyph of its own.
 */

/** The voice relay's socket, as far as the page can tell. */
class FakeSocket {
  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: unknown): void {
    if (typeof data === 'string') this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  recv(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

interface Posted {
  url: string;
  body: { text?: string; anchor?: { kind: string } };
}

const cleanups: Array<() => void> = [];

/**
 * The widget's shell as the mic finds it, plus the fields voice mode reads:
 * where the server is, who is speaking, and the two auth fields that tell
 * "the workspace wants a signature" from "the post just failed".
 */
function widgetWithMic(over: { refuse?: boolean; signInToWrite?: boolean } = {}) {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  for (const cls of ['fab-list', 'fab']) {
    const b = document.createElement('button');
    b.className = cls;
    shadow.append(b);
  }
  document.body.append(host);
  const widget = Object.assign(host, {
    shadow,
    opts: { serverUrl: 'http://host:8787', workspaceId: 'w-hub', docId: 'workspaces-feedback' },
    user: { name: 'Ada', color: '#123456' },
    feedbackMode: false,
    signInToWrite: over.signInToWrite === true,
    authToken: null,
  }) as unknown as FeedbackWidgetEl;

  const posted: Posted[] = [];
  let refuse = over.refuse === true;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init.body)) as Posted['body'] });
    if (refuse) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ thread: { id: 't1', comments: [{ id: 'c1' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const sockets: FakeSocket[] = [];
  let micStops = 0;
  const mode = mountFeedbackMic(widget, {
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    startCapture: async () => {
      return {
        ok: true,
        capture: {
          stop: () => {
            micStops += 1;
          },
        },
      };
    },
    shown: () => true,
  });
  // A recording left running keeps its document listeners, which would take
  // the next test's taps.
  cleanups.push(() => {
    if (mode.session.state === 'idle') return;
    mode.session.stop();
    sockets.at(-1)?.recv({ type: 'stopped' });
  });
  const button = shadow.querySelector('.fab-mic') as HTMLElement;
  const readout = shadow.querySelector('.readout') as HTMLElement;
  return {
    widget,
    mode,
    button,
    readout,
    posted,
    sockets,
    socket: () => sockets.at(-1) as FakeSocket,
    micStops: () => micStops,
    accept: () => {
      refuse = false;
    },
  };
}

/** Tap the mic, and the server's engine comes up. */
async function tapToTalk(v: ReturnType<typeof widgetWithMic>): Promise<void> {
  v.button.click();
  v.socket().readyState = 1;
  v.socket().onopen?.();
  v.socket().recv({ type: 'ready', segment: 1 });
  await vi.waitFor(() => expect(v.mode.session.state).toBe('recording'));
}

/** A settled spoken comment from the server. */
function said(v: ReturnType<typeof widgetWithMic>, text: string, key = 'v1'): void {
  v.socket().recv({
    type: 'comment',
    key,
    text,
    raw: text,
    clip: '/workspaces/w-hub/docs/workspaces-feedback/voice-feedback/seg-1.wav#t=0,4',
    target: null,
    final: true,
  });
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

describe('the board mic', () => {
  it('records on a tap, talking to the feedback doc’s voice relay', async () => {
    const v = widgetWithMic();
    v.button.click();
    expect(v.sockets.map((s) => s.url)).toEqual([
      'http://host:8787/workspaces/w-hub/docs/workspaces-feedback/voice',
    ]);
    expect(v.button.getAttribute('aria-pressed')).toBe('true');
    v.socket().readyState = 1;
    v.socket().onopen?.();
    expect(JSON.parse(v.socket().sent[0] as string)).toMatchObject({
      type: 'start',
      sampleRate: 16000,
    });
  });

  it('posts what was said as feedback on the Workspaces feedback doc', async () => {
    const v = widgetWithMic();
    await tapToTalk(v);
    said(v, 'the phone composer has too many rows');
    await vi.waitFor(() => expect(v.posted).toHaveLength(1));
    expect(v.posted[0]?.url).toBe(
      'http://host:8787/workspaces/w-hub/docs/workspaces-feedback/threads',
    );
    expect(v.posted[0]?.body).toMatchObject({
      text: 'the phone composer has too many rows',
      anchor: { kind: 'subject' },
    });
  });

  it('stops on a second tap, and lets go of the microphone at once', async () => {
    const v = widgetWithMic();
    await tapToTalk(v);
    v.button.click();
    expect(v.micStops()).toBe(1);
    expect(v.socket().sent.map((s) => JSON.parse(s).type)).toContain('stop');
    v.socket().recv({ type: 'stopped' });
    expect(v.button.getAttribute('aria-pressed')).toBe('false');
  });

  it('leaves Space alone — the board dock owns that gesture', () => {
    // Two captures listening for one press would both record.
    const v = widgetWithMic();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    expect(v.sockets, 'the widget mic must not start on Space').toHaveLength(0);
    v.button.click();
    expect(v.sockets, 'CONTROL: the same mic does start from its own button').toHaveLength(1);
  });

  it('names the app, not the project, on every button', () => {
    const v = widgetWithMic();
    for (const label of [FEEDBACK_LABELS.comment, FEEDBACK_LABELS.voice, FEEDBACK_LABELS.history]) {
      expect(label).toMatch(/Workspaces app/);
      // Including the history button, which used to say only "on the
      // Workspaces app so far" — so beside two buttons that both disclaimed
      // the project, it read as the one that WAS about the project.
      expect(label, 'every button disclaims the project').toMatch(/not this project/);
    }
    const tips = [...v.widget.shadow.querySelectorAll('[data-tip]')].map(
      (b) => (b as HTMLElement).dataset.tip,
    );
    expect(new Set(tips)).toEqual(
      new Set([FEEDBACK_LABELS.comment, FEEDBACK_LABELS.voice, FEEDBACK_LABELS.history]),
    );
  });

  it('is a different glyph from the voice dock, so the board’s two mics are not one control drawn twice', () => {
    // A board carries both at once: the dock's mic bottom-left talks to the
    // board, this one bottom-right sends feedback about the app. They drew the
    // same icon, so the only thing separating them was a hover label — which
    // a finger never sees.
    const el = mountShell();
    const v = widgetWithMic();
    const dock = el('board-mic');
    const feedback = v.widget.shadow.querySelector('.fab-mic') as HTMLElement;
    expect(dock.querySelector('svg'), 'CONTROL: the dock draws a glyph').toBeTruthy();
    expect(feedback.querySelector('svg'), 'CONTROL: and so does the mic').toBeTruthy();
    expect(feedback.innerHTML, 'the two mics are drawn differently').not.toBe(dock.innerHTML);
  });
});

describe('the board mic when the workspace wants a signature', () => {
  it('keeps what was said and asks for a sign-in, in the composer’s own words', async () => {
    const v = widgetWithMic({ refuse: true, signInToWrite: true });
    await tapToTalk(v);
    said(v, 'the phone composer has too many rows');
    await vi.waitFor(() => expect(v.readout.textContent).toBe(SIGN_IN_NOTE));
    expect(v.posted, 'CONTROL: it did try').toHaveLength(1);
  });

  it('posts every comment said before the sign-in, once it lands', async () => {
    const v = widgetWithMic({ refuse: true, signInToWrite: true });
    await tapToTalk(v);
    said(v, 'the ferry times are wrong', 'v1');
    said(v, 'and the map is upside down', 'v2');
    await vi.waitFor(() => expect(v.posted).toHaveLength(2));
    await vi.waitFor(() =>
      expect(typeof v.widget.retryAfterSignIn, 'the retry is armed').toBe('function'),
    );

    v.accept();
    v.widget.retryAfterSignIn?.();
    await vi.waitFor(() => expect(v.posted).toHaveLength(4));
    expect(v.posted.slice(2).map((p) => p.body.text)).toEqual([
      'the ferry times are wrong',
      'and the map is upside down',
    ]);
  });

  it('CONTROL: a refusal with nothing to sign in to is still a failure', async () => {
    const v = widgetWithMic({ refuse: true });
    await tapToTalk(v);
    said(v, 'the phone composer has too many rows');
    await vi.waitFor(() =>
      expect(v.readout.textContent).toBe('A comment could not be saved. Its words are kept.'),
    );
    expect(v.widget.retryAfterSignIn, 'and nothing is armed').toBeNull();
  });
});
