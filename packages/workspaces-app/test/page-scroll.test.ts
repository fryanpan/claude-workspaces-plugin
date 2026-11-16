/**
 * A followed scroll waits for the page in front to be drawn. A board's
 * settings fills in as its data arrives; a fraction applied while it had no
 * room left the follower at the top while the person they followed was
 * further down (point-targets-browser "person board scroll").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollToFractionWhenDrawn } from '../src/presence/page-scroll.ts';

/** jsdom lays nothing out: give an element a box and the room it scrolls. */
function lay(el: HTMLElement, room: () => number): void {
  el.style.overflowY = 'auto';
  el.getClientRects = () => [{}] as unknown as DOMRectList;
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 100 + room() });
}

describe('a followed scroll', () => {
  let front: HTMLElement;
  let behind: HTMLElement;
  let frontRoom = 0;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] });
    document.body.innerHTML = '<div id="front"></div><div id="behind"></div>';
    front = document.getElementById('front') as HTMLElement;
    behind = document.getElementById('behind') as HTMLElement;
    frontRoom = 0;
    lay(front, () => frontRoom);
    lay(behind, () => 400);
  });
  afterEach(() => vi.useRealTimers());

  it('lands on the page in front once it has room, not on the page behind it', () => {
    scrollToFractionWhenDrawn(document, ['#front', '#behind'], 0.5);
    vi.advanceTimersByTime(500);
    expect(front.scrollTop).toBe(0);
    expect(behind.scrollTop).toBe(0);
    frontRoom = 200;
    vi.advanceTimersByTime(50);
    expect(front.scrollTop).toBe(100);
    expect(behind.scrollTop).toBe(0);
  });

  it('scrolls whatever has room when the page in front never gets any', () => {
    scrollToFractionWhenDrawn(document, ['#front', '#behind'], 0.5);
    vi.advanceTimersByTime(3_500);
    expect(behind.scrollTop).toBe(200);
  });

  it('stops waiting when a newer spot replaces it', () => {
    const stop = scrollToFractionWhenDrawn(document, ['#front', '#behind'], 0.5);
    vi.advanceTimersByTime(100);
    stop();
    frontRoom = 200;
    vi.advanceTimersByTime(3_500);
    expect(front.scrollTop).toBe(0);
    expect(behind.scrollTop).toBe(0);
  });
});
