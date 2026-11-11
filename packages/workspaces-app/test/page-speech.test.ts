/**
 * Whether this page, or a frame on it, speaks (`lead-chat/page-speech.ts`):
 * messages from the page and its frames count, any other window's do not, a
 * frame that stops beating lapses, and the last word's echo is waited out.
 * Driven with posted messages on a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEECH_HOLD_MS, SPEECH_TAIL_MS, watchPageSpeech } from '../src/lead-chat/page-speech.ts';

let stop: (() => void) | null = null;

/** A page holding one frame. happy-dom loads no frame, so its window and the
 *  frame's are stand-ins; the watcher reads only these parts. */
const frameWindow = { name: 'frame' };
const frames: Array<{ contentWindow: unknown }> = [];
const page = Object.assign(new EventTarget(), {
  document: { querySelectorAll: () => frames },
});

beforeEach(() => {
  vi.useFakeTimers();
  frames.splice(0, frames.length, { contentWindow: frameWindow });
});
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

function watching() {
  const changes: boolean[] = [];
  stop = watchPageSpeech((s) => changes.push(s), page as unknown as Window);
  return changes;
}

/** A message as the browser hands it on: `source` is the posting window. */
const post = (on: boolean, source: unknown, data: unknown = { cw: 'speaking', on }): void => {
  const ev = new Event('message') as Event & { data: unknown; source: unknown };
  Object.assign(ev, { data, source });
  page.dispatchEvent(ev);
};

describe('watchPageSpeech', () => {
  it('turns on when a frame on the page speaks, and off after the echo once it stops', () => {
    const changes = watching();
    post(true, frameWindow);
    expect(changes).toEqual([true]);
    post(false, frameWindow);
    vi.advanceTimersByTime(SPEECH_TAIL_MS - 1);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]);
  });

  it('counts the page itself', () => {
    const changes = watching();
    post(true, page);
    expect(changes).toEqual([true]);
  });

  it('ignores a window that is not this page or a frame on it', () => {
    const changes = watching();
    post(true, { name: 'stranger' });
    post(true, null);
    post(true, page, { cw: 'here' });
    expect(changes).toEqual([]);
  });

  it('ignores a frame once it is gone from the page', () => {
    const changes = watching();
    frames.splice(0, frames.length);
    post(true, frameWindow);
    expect(changes).toEqual([]);
  });

  it('stays on through a pause shorter than the echo', () => {
    const changes = watching();
    post(true, frameWindow);
    post(false, frameWindow);
    vi.advanceTimersByTime(SPEECH_TAIL_MS / 2);
    post(true, frameWindow);
    vi.advanceTimersByTime(SPEECH_TAIL_MS);
    expect(changes).toEqual([true]);
  });

  it('lets a frame that stopped beating lapse, and holds one that beats', () => {
    const changes = watching();
    post(true, frameWindow);
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(500);
      post(true, frameWindow);
    }
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(SPEECH_HOLD_MS + SPEECH_TAIL_MS);
    expect(changes).toEqual([true, false]);
  });

  it('hears nothing once unsubscribed', () => {
    const changes = watching();
    stop?.();
    stop = null;
    post(true, frameWindow);
    expect(changes).toEqual([]);
  });
});
