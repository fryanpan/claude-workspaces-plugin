import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchPageBar } from '../src/widget-page-bar.ts';

/**
 * When the widget re-measures the page's bottom bar. A bar that slides into
 * place is measured by the mutation that starts it, mid-slide; a doc's
 * comment composer caught crossing the bottom edge left the corner buttons
 * lifted after it had settled clear. The end of the slide has to re-measure.
 */

let frames: Array<() => void> = [];
let stop: () => void = () => {};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** Run the frames queued so far. */
const flush = (): void => {
  const run = frames;
  frames = [];
  for (const fn of run) fn();
};

describe('watchPageBar', () => {
  it('re-measures when a transition on the page ends', () => {
    const update = vi.fn();
    stop = watchPageBar(update);
    const sheet = document.createElement('div');
    document.body.append(sheet);
    flush();
    update.mockClear();
    sheet.dispatchEvent(new Event('transitionend', { bubbles: true }));
    flush();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('re-measures on a scroll inside the page, which does not bubble', () => {
    const update = vi.fn();
    stop = watchPageBar(update);
    const pane = document.createElement('div');
    document.body.append(pane);
    flush();
    update.mockClear();
    pane.dispatchEvent(new Event('scroll'));
    flush();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('stops listening once torn down', () => {
    const update = vi.fn();
    watchPageBar(update)();
    window.dispatchEvent(new Event('transitionend'));
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(update).not.toHaveBeenCalled();
  });
});
