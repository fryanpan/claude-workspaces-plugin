import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spokenHarness as harness } from './support/spoken-reply-harness.ts';

/**
 * A spoken reply's notes on the page: each lands just before its point is
 * heard, in a row the reply laid out for it, and its lead rides the turn's
 * timing report.
 */

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('spoken reply notes', () => {
  it('each note lands just before its point is heard, in a row laid out for it', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.socket.open();
    h.frame(true); // the question's last word: the timing runs from here
    h.socket.reply({
      type: 'reply',
      spoken: 'Moved "Sign-in" from todo to done. Waiting on you: “approve the mock”.',
      detail: [],
      points: [
        { say: 'Moved "Sign-in" from todo to done.', note: '“Sign-in”: todo → done' },
        { say: 'Waiting on you: “approve the mock”.', note: 'Waiting on you: “approve the mock”' },
      ],
      asking: false,
      route: 'fast-path-action',
    });
    const rows = [...h.panel.root.querySelectorAll<HTMLElement>('.vr-notes li')];
    const unlanded = () => rows.map((r) => r.classList.contains('vr-unlanded'));
    // Both rows exist, with their text, before either note lands.
    expect(rows.map((r) => r.textContent)).toEqual([
      '“Sign-in”: todo → done',
      'Waiting on you: “approve the mock”',
    ]);
    expect(unlanded()).toEqual([true, true]);
    const layout = [...h.panel.root.querySelectorAll('.vr-body *')];

    // Point 0: its note, then its audio — one second of it.
    h.socket.reply({ type: 'note', point: 0, text: '“Sign-in”: todo → done' });
    expect(unlanded()).toEqual([true, true]);
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    h.socket.audio(new Array(24000).fill(4000));
    expect(unlanded()).toEqual([false, true]);
    // Point 1's note arrives with point 0 still playing: it waits.
    h.socket.reply({ type: 'note', point: 1, text: 'Waiting on you: “approve the mock”' });
    h.socket.audio(new Array(2400).fill(4000));
    // The wait is 880 ms to within a float's rounding, so it is held to a
    // millisecond either side.
    h.tick(878);
    await vi.advanceTimersByTimeAsync(878);
    expect(unlanded()).toEqual([false, true]);
    h.tick(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(unlanded()).toEqual([false, false]);
    // Landing changed which rows show, not which elements are there.
    expect([...h.panel.root.querySelectorAll('.vr-body *')]).toEqual(layout);

    h.socket.reply({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(2000);
    const timing = h.socket.json().find((m) => m.type === 'timing');
    // Point 0 shows as its audio is queued, 30 ms ahead; point 1 NOTE_LEAD_MS ahead.
    expect(timing?.noteLeadMs).toEqual([-30, -150]);
  });

  it('stopping shows every note still waiting', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({
      type: 'reply',
      spoken: 'One. Two.',
      detail: [],
      points: [{ say: 'One.' }, { say: 'Two.', note: 'Two' }],
      asking: false,
      route: 'x',
    });
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    h.socket.audio(new Array(24000).fill(4000));
    h.socket.reply({ type: 'note', point: 1, text: 'Two' });
    h.panel.root.querySelector<HTMLButtonElement>('.vr-stop')?.click();
    const row = h.panel.root.querySelector('.vr-notes li');
    expect(row?.classList.contains('vr-unlanded')).toBe(false);
  });
});
