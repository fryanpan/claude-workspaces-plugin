import { afterEach, describe, expect, it } from 'vitest';
import { mountRecentNoteMarkers } from '../src/recent-note-markers.ts';

/**
 * The edge markers (recent-note-markers.ts). happy-dom lays nothing out, so
 * each element is given the rect the browser would have measured; the module
 * reads nothing else. All fixtures are synthetic.
 */

interface Rect {
  top: number;
  bottom: number;
}

function rectOf(el: HTMLElement, r: Rect): void {
  el.getBoundingClientRect = () =>
    ({
      top: r.top,
      bottom: r.bottom,
      left: 0,
      right: 100,
      width: 100,
      height: r.bottom - r.top,
    }) as DOMRect;
}

function harness(lines: Rect[]) {
  const pane = document.createElement('div');
  const scroller = document.createElement('div');
  const prose = document.createElement('div');
  scroller.appendChild(prose);
  pane.appendChild(scroller);
  document.body.appendChild(pane);
  // The scroller's box: 100..500 on screen.
  rectOf(scroller, { top: 100, bottom: 500 });
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(scroller, 'offsetTop', { value: 40, configurable: true });
  const els = lines.map((r) => {
    const li = document.createElement('p');
    li.className = 'recent-note';
    rectOf(li, r);
    prose.appendChild(li);
    return li;
  });
  const markers = mountRecentNoteMarkers({ pane, scroller, prose, reducedMotion: () => true });
  const top = pane.querySelector<HTMLButtonElement>('.recent-edge.top');
  const bottom = pane.querySelector<HTMLButtonElement>('.recent-edge.bottom');
  if (!top || !bottom) throw new Error('pills not mounted');
  return { pane, scroller, prose, els, markers, top, bottom };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('the edge markers', () => {
  it('count the tinted lines wholly past each edge, and hide when there are none', () => {
    const h = harness([
      { top: 0, bottom: 20 }, // above
      { top: 30, bottom: 60 }, // above
      { top: 200, bottom: 230 }, // on screen
      { top: 480, bottom: 520 }, // half visible: on screen
      { top: 600, bottom: 630 }, // below
    ]);
    expect(h.top.hidden).toBe(false);
    expect(h.top.textContent).toBe('↑ 2 new');
    expect(h.bottom.hidden).toBe(false);
    expect(h.bottom.textContent).toBe('↓ 1 new');
    // The top pill clears whatever sits above the scroller in the pane.
    expect(h.top.style.top).toBe('48px');
  });

  it('shows nothing when every tinted line is on screen', () => {
    const h = harness([{ top: 200, bottom: 230 }]);
    expect(h.top.hidden).toBe(true);
    expect(h.bottom.hidden).toBe(true);
  });

  it('a tap scrolls to the nearest line past that edge', () => {
    const h = harness([
      { top: 0, bottom: 20 },
      { top: 30, bottom: 60 },
      { top: 600, bottom: 630 },
      { top: 700, bottom: 730 },
    ]);
    const jumped: HTMLElement[] = [];
    for (const el of h.els) el.scrollIntoView = () => jumped.push(el);
    h.top.click();
    h.bottom.click();
    // Nearest above is the FIRST in document order; nearest below likewise.
    expect(jumped).toEqual([h.els[0], h.els[2]]);
  });

  it('re-counts when told the tint set changed, and goes when the last line ages out', () => {
    const h = harness([{ top: 600, bottom: 630 }]);
    expect(h.bottom.hidden).toBe(false);
    h.els[0]?.classList.remove('recent-note');
    h.markers.sync();
    expect(h.bottom.hidden).toBe(true);
  });

  it('leaves no pills behind once destroyed', () => {
    const h = harness([{ top: 600, bottom: 630 }]);
    h.markers.destroy();
    expect(h.pane.querySelector('.recent-edge')).toBeNull();
  });
});
