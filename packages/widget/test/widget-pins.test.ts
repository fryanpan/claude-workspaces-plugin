import { afterEach, describe, expect, it, vi } from 'vitest';
import { positionPins } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * Where a thread's pin stands: at the top right of its element. Two threads on
 * one element (a comment said twice about it, or typed then spoken) must both
 * be seen and tapped.
 */

function element(right: number, top: number): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: right - 200, y: top, width: 200, height: 40 }),
  );
  return el;
}

function widgetWith(pins: Array<[string, HTMLElement]>) {
  const pinLayer = document.createElement('div');
  const threadPositions = new Map<string, { el: HTMLElement; status: 'open' }>();
  for (const [id, el] of pins) {
    const pin = document.createElement('div');
    pin.dataset.threadId = id;
    pinLayer.append(pin);
    threadPositions.set(id, { el, status: 'open' });
  }
  const pin = (id: string) => pinLayer.querySelector(`[data-thread-id="${id}"]`) as HTMLElement;
  return { el: { pinLayer, threadPositions } as unknown as FeedbackWidgetEl, pin };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('positionPins', () => {
  it('stands a second pin on the same element beside the first, not on it', () => {
    const row = element(400, 80);
    const other = element(400, 200);
    const w = widgetWith([
      ['t1', row],
      ['t2', other],
      ['t3', row],
      ['t4', row],
    ]);
    positionPins(w.el);
    const at = (id: string) => [w.pin(id).style.left, w.pin(id).style.top];
    expect(at('t1')).toEqual(['394px', '86px']);
    expect(at('t2'), 'CONTROL: a pin alone on its element is where it always was').toEqual([
      '394px',
      '206px',
    ]);
    expect(at('t3')).toEqual(['368px', '86px']);
    expect(at('t4')).toEqual(['342px', '86px']);
  });
});
