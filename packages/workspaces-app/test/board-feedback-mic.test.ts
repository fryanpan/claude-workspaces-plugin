import type { FeedbackWidgetEl } from '@claude-workspaces/widget';
import { SIGN_IN_NOTE } from '@claude-workspaces/widget/mic';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_LABELS, mountFeedbackMic } from '../src/board/board-feedback-mic.ts';
import type { RecognitionLike, RecognitionResultEvent } from '../src/voice-capture.ts';
import { mountShell } from './support/board-region-harness.ts';

/**
 * Voice feedback about Workspaces itself, from any board.
 *
 * The widget on a board is bound to the Workspaces feedback doc, not to the
 * project on the board — so the button in the thread list's old slot is a mic
 * whose utterance lands in the same place typed feedback does: a thread about
 * that doc as a whole. What the board adds is the capture; the widget only
 * lends the button (`@claude-workspaces/widget/mic`).
 */
class FakeRecognition implements RecognitionLike {
  onresult: ((ev: RecognitionResultEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  started = 0;
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.onend?.();
  }
  say(text: string): void {
    this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: true }] });
  }
}

interface Sent {
  anchor: { kind: string };
  text: string;
}

/**
 * The widget's shell as the mic finds it, plus the two auth fields the mic
 * reads to tell "the workspace wants a signature" from "the post just failed".
 * `signInToWrite` is what the widget's own 401 handling sets before a refused
 * post resolves.
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
  const sent: Sent[] = [];
  let refuse = over.refuse === true;
  // Built ON the host element rather than beside it: the real
  // `FeedbackWidgetEl` IS the element, and the mic writes the panel height it
  // measures into that element's own inline style. A bare object stood in for
  // it until the mic started doing that, and then read as a widget with no
  // `style` at all — which no real one has ever been.
  const widget = Object.assign(host, {
    shadow,
    signInToWrite: over.signInToWrite === true,
    authToken: null,
    retryAfterSignIn: null,
    postNewThread: async (anchor: { kind: string }, text: string) => {
      sent.push({ anchor, text });
      return !refuse;
    },
  }) as unknown as FeedbackWidgetEl;
  const rec = new FakeRecognition();
  const capture = mountFeedbackMic(widget, { createRecognition: () => rec });
  const button = shadow.querySelector('.fab-mic') as HTMLElement;
  const readout = shadow.querySelector('.readout') as HTMLElement;
  /** The workspace takes the post now — what signing in changes. */
  const accept = (): void => {
    refuse = false;
  };
  return { widget, sent, rec, capture, button, readout, accept };
}

/** Hold the mic, say a sentence, let go. */
async function utter(v: ReturnType<typeof widgetWithMic>, text: string): Promise<void> {
  v.button.dispatchEvent(new Event('pointerdown'));
  v.rec.say(text);
  v.button.dispatchEvent(new Event('pointerup'));
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  // The mic is gated on a secure context, which no test environment is. That
  // gate has its own suite (`voice-capture.test.ts`); here it must be open.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the board mic', () => {
  it('posts what it heard as feedback about the whole doc', async () => {
    const v = widgetWithMic();
    await utter(v, 'the phone composer has too many rows');
    expect(v.sent).toEqual([
      { anchor: { kind: 'subject' }, text: 'the phone composer has too many rows' },
    ]);
    v.capture.destroy();
  });

  it('says where it went, in the readout beside the button', async () => {
    const v = widgetWithMic();
    await utter(v, 'the phone composer has too many rows');
    expect(v.readout.classList.contains('hidden')).toBe(false);
    expect(v.readout.textContent).toContain('Workspaces feedback');
    expect(v.readout.textContent).toContain('too many rows');
    v.capture.destroy();
  });

  it('CONTROL: a refused post says so rather than claiming it landed', async () => {
    const v = widgetWithMic({ refuse: true });
    await utter(v, 'the phone composer has too many rows');
    expect(v.sent, 'CONTROL: it did try').toHaveLength(1);
    expect(v.readout.textContent).toContain('failed');
    v.capture.destroy();
  });

  it('leaves Space alone — the board dock owns that gesture', async () => {
    // Two captures listening for one press both record and both post.
    const v = widgetWithMic();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(v.rec.started, 'the widget mic must not start on Space').toBe(0);
    // CONTROL: the same capture does start from its own button.
    v.button.dispatchEvent(new Event('pointerdown'));
    expect(v.rec.started).toBe(1);
    v.button.dispatchEvent(new Event('pointerup'));
    v.capture.destroy();
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
    v.capture.destroy();
  });

  it('is a different glyph from the voice dock, so the board\u2019s two mics are not one control drawn twice', () => {
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
    v.capture.destroy();
  });
});

describe('the board mic when the workspace wants a signature', () => {
  it('keeps what was said and asks for a sign-in, in the composer\u2019s own words', async () => {
    const v = widgetWithMic({ refuse: true, signInToWrite: true });
    await utter(v, 'the phone composer has too many rows');
    expect(v.sent, 'CONTROL: it did try').toHaveLength(1);
    // The typed composer has always held the draft and said this. A spoken
    // one used to be told the request failed, with the sentence already gone.
    expect(v.readout.textContent).toBe(SIGN_IN_NOTE);
    expect(v.readout.textContent).not.toContain('failed');
    v.capture.destroy();
  });

  it('posts the utterance itself once the sign-in lands', async () => {
    // "Your draft is kept" is a promise about what happens next, so the test
    // is that the words go out — not that a flag was set somewhere.
    const v = widgetWithMic({ refuse: true, signInToWrite: true });
    await utter(v, 'the phone composer has too many rows');
    expect(typeof v.widget.retryAfterSignIn, 'the retry is armed').toBe('function');

    v.accept();
    v.widget.retryAfterSignIn?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(v.sent.map((s) => s.text)).toEqual([
      'the phone composer has too many rows',
      'the phone composer has too many rows',
    ]);
    expect(v.sent[1]?.anchor, 'as feedback about the doc as a whole').toEqual({ kind: 'subject' });
    expect(v.readout.textContent, 'and the readout says where it went').toContain(
      'Workspaces feedback',
    );
    v.capture.destroy();
  });

  it('CONTROL: a refusal with nothing to sign in to is still a failure', async () => {
    // The sign-in wording is not the new name for every refusal: a workspace
    // that never asked for a signature gets the plain report back.
    const v = widgetWithMic({ refuse: true });
    await utter(v, 'the phone composer has too many rows');
    expect(v.readout.textContent).toContain('failed');
    expect(v.widget.retryAfterSignIn, 'and nothing is armed').toBeNull();
    v.capture.destroy();
  });
});
