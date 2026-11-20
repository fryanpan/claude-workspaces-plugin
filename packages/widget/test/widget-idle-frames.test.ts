import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An idle page asks for no frames.
 *
 * The widget used to keep pins on their elements with a rAF loop that ran
 * every frame for as long as the page was open, so an untouched board or doc
 * woke the renderer on every frame of the display. The loop
 * now runs only for a moment after something on the page moves.
 *
 * Driven in happy-dom with fake timers: rAF fires every 16ms of fake time and
 * the test counts how many frames the page asked for.
 */

let frames = 0;

async function mountWidget(): Promise<void> {
  (globalThis as unknown as { fetch: unknown }).fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  const mod = await import('../src/widget.ts');
  mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'd-riverbend', user: 'Alice' });
}

describe('the position loop', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'performance',
      ],
    });
    const raf = window.requestAnimationFrame.bind(window);
    frames = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames++;
      return raf(cb);
    });
    document.body.innerHTML = '<main><p id="saltmarsh">Saltmarsh notes</p></main>';
  });

  afterEach(() => {
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stops asking for frames once nothing on the page has moved for a while', async () => {
    await mountWidget();
    await vi.advanceTimersByTimeAsync(3000);
    const settled = frames;
    await vi.advanceTimersByTimeAsync(10_000);
    // A loop that never stops asks for ~625 frames in ten seconds.
    expect(frames - settled).toBe(0);
  });

  it('runs again when the page scrolls, then settles', async () => {
    await mountWidget();
    await vi.advanceTimersByTimeAsync(3000);
    const before = frames;
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(500);
    expect(frames).toBeGreaterThan(before + 10);
    await vi.advanceTimersByTimeAsync(3000);
    const settled = frames;
    await vi.advanceTimersByTimeAsync(5000);
    expect(frames).toBe(settled);
  });

  it('runs again when an element on the page changes its class', async () => {
    await mountWidget();
    await vi.advanceTimersByTimeAsync(3000);
    const before = frames;
    document.getElementById('saltmarsh')?.classList.add('open');
    await vi.advanceTimersByTimeAsync(500);
    expect(frames).toBeGreaterThan(before + 10);
  });
});
