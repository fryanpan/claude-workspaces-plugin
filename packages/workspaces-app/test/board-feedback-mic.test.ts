import type { FeedbackWidgetEl } from '@claude-workspaces/widget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_LABELS, mountFeedbackMic } from '../src/board/board-feedback-mic.ts';
import type { RecognitionLike, RecognitionResultEvent } from '../src/voice-capture.ts';

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

function widgetWithMic(refuse = false) {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  for (const cls of ['fab-list', 'fab']) {
    const b = document.createElement('button');
    b.className = cls;
    shadow.append(b);
  }
  document.body.append(host);
  const sent: Sent[] = [];
  const widget = {
    shadow,
    postNewThread: async (anchor: { kind: string }, text: string) => {
      sent.push({ anchor, text });
      return !refuse;
    },
  } as unknown as FeedbackWidgetEl;
  const rec = new FakeRecognition();
  const capture = mountFeedbackMic(widget, { createRecognition: () => rec });
  const button = shadow.querySelector('.fab-mic') as HTMLElement;
  const readout = shadow.querySelector('.readout') as HTMLElement;
  return { widget, sent, rec, capture, button, readout };
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
    const v = widgetWithMic(true);
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
    }
    const tips = [...v.widget.shadow.querySelectorAll('[data-tip]')].map(
      (b) => (b as HTMLElement).dataset.tip,
    );
    expect(new Set(tips)).toEqual(
      new Set([FEEDBACK_LABELS.comment, FEEDBACK_LABELS.voice, FEEDBACK_LABELS.history]),
    );
    v.capture.destroy();
  });
});
