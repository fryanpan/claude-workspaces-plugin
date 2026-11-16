import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { renderThreadsInto } from '../src/widget-threads.ts';
import { box, pinOf, pins, thread, widgetAt } from './page-fixture.ts';

/**
 * "I can't see where I made comments on the page. It's very disorienting."
 *
 * A site that keeps every control in its address — `?o=ss`, `?all=1` — moved
 * the address under each comment, and a pin matched on the whole address, so
 * a toggle took the earlier pins off the page. A map drew one canvas that many
 * threads anchored to, and its pins stood at the canvas's corner rather than
 * where they were put. A chart rebuilt its bars on every render, and a bar
 * has no words to be found by again.
 *
 * Each case here is one of those, driven through the widget's own renderer.
 * Fixture names only; the clock is injected.
 */

const T0 = 1_760_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

/** The page at `url`, holding one heading to comment on. */
function pageAt(url: string): HTMLElement {
  history.replaceState(null, '', url);
  document.body.innerHTML = '<main><h1 id="h">Harborlight case</h1></main>';
  return document.getElementById('h') as HTMLElement;
}

describe('a pin on a page whose address carries its controls', () => {
  it('stands, dimmed, when only the query differs, and its tap opens the thread', () => {
    const h = pageAt('/case/harborlight/?all=1');
    const ydoc = new Y.Doc();
    const at = (url: string) => ({ ...createAnchor(h), context: { url } });
    thread(ydoc, 't-here', at('/case/harborlight/?all=1'), T0);
    thread(ydoc, 't-view', at('/case/harborlight/?top=5&o=ss%2Cwb'), T0 + 1);
    thread(ydoc, 't-away', at('/case/riverbend/?all=1'), T0 + 2);
    const el = widgetAt(ydoc, '/case/harborlight/?all=1');
    renderThreadsInto(el);

    // The thread made in this very state is pinned as it always was.
    expect(pinOf(el, 't-here')?.hasAttribute('data-dim')).toBe(false);
    // The one made with other controls set is pinned too, dimmed.
    expect(pinOf(el, 't-view')?.hasAttribute('data-dim')).toBe(true);
    // A thread on another page is not pinned here at all.
    expect(pinOf(el, 't-away')).toBeUndefined();
    expect(pins(el)).toHaveLength(2);

    // "Tapping on done icons reloads the page": a tap opens the thread where
    // the reader is, and the page stays as it was. The way back to the state
    // it was made in is the page list's (`page-list.test.ts`).
    pinOf(el, 't-view')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(location.pathname + location.search).toBe('/case/harborlight/?all=1');
    expect(el.shadow.querySelector('.thread-popover')?.textContent).toContain('Say which pier');
  });

  it('keeps a view-keyed thread off a page in another view, as before', () => {
    const h = pageAt('/case/harborlight/');
    const ydoc = new Y.Doc();
    thread(
      ydoc,
      't-modal',
      { ...createAnchor(h), context: { url: '/case/harborlight/?o=ss', view: 'modal=edit' } },
      T0,
    );
    const el = widgetAt(ydoc, '/case/harborlight/');
    renderThreadsInto(el);
    expect(pins(el)).toHaveLength(0);
  });
});

describe('pins on a map canvas', () => {
  /** A page-wide map, as a site draws one: a canvas with no words of its own. */
  function mapPage(): HTMLCanvasElement {
    history.replaceState(null, '', '/map');
    document.body.innerHTML =
      '<main><div class="map"><canvas aria-label="Map" class="maplibregl-canvas"></canvas></div></main>';
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    box(canvas, 0, 100, 1000, 600);
    document.elementsFromPoint = () => [];
    return canvas;
  }

  it('stands each pin at the spot it was put, and spreads pins put on one spot', () => {
    const canvas = mapPage();
    const ydoc = new Y.Doc();
    const at = (x: number, y: number) => ({
      ...createAnchor(canvas),
      at: { x, y },
      context: { url: '/map' },
    });
    thread(ydoc, 't-a', at(0.5, 0.5), T0);
    thread(ydoc, 't-b', at(0.5, 0.5), T0 + 1);
    thread(ydoc, 't-c', at(0.5, 0.5), T0 + 2);
    thread(ydoc, 't-d', at(0.2, 0.25), T0 + 3);
    const el = widgetAt(ydoc, '/map');
    renderThreadsInto(el);

    const tip = (id: string): [number, number] => {
      const p = pinOf(el, id) as HTMLElement;
      return [Number.parseFloat(p.style.left), Number.parseFloat(p.style.top)];
    };
    // Where the tap was: half way across a canvas at (0, 100), 1000 by 600.
    expect(tip('t-a')).toEqual([500, 400]);
    expect(tip('t-d')).toEqual([200, 250]);
    // Two more on that same spot sit beside it, near it, and apart enough to tap.
    const all = ['t-a', 't-b', 't-c', 't-d'].map(tip);
    for (const [i, a] of all.entries()) {
      for (const b of all.slice(i + 1)) {
        expect(Math.abs(a[0] - b[0]) >= 22 || Math.abs(a[1] - b[1]) >= 27).toBe(true);
      }
    }
    for (const id of ['t-b', 't-c']) {
      const [x, y] = tip(id);
      expect(Math.hypot(x - 500, y - 400)).toBeLessThanOrEqual(40);
    }
  });
});

describe('a pin whose element the page rebuilt', () => {
  const svg = (n: number) =>
    `<svg class="chart">${Array.from({ length: n }, (_, i) => `<rect x="${i * 10}" width="8" height="${20 + i}"></rect>`).join('')}</svg>`;

  it('finds a chart bar again by where it sits once the chart is redrawn', () => {
    history.replaceState(null, '', '/chart');
    document.body.innerHTML = `<main>${svg(3)}</main>`;
    const bar = document.querySelectorAll('rect')[1] as unknown as HTMLElement;
    const ydoc = new Y.Doc();
    thread(ydoc, 't-bar', { ...createAnchor(bar), context: { url: '/chart' } }, T0);
    const el = widgetAt(ydoc, '/chart');

    // The chart replaces every bar, as it does on each render.
    (document.querySelector('main') as HTMLElement).innerHTML = svg(3);
    renderThreadsInto(el);
    expect(pinOf(el, 't-bar')).toBeDefined();
    expect(el.threadPositions.get('t-bar')?.el).toBe(document.querySelectorAll('rect')[1]);
  });

  it('keeps the thread in the panel, with no spot, when the bar is gone', () => {
    history.replaceState(null, '', '/chart');
    document.body.innerHTML = `<main>${svg(3)}</main>`;
    const bar = document.querySelectorAll('rect')[2] as unknown as HTMLElement;
    const ydoc = new Y.Doc();
    thread(ydoc, 't-bar', { ...createAnchor(bar), context: { url: '/chart' } }, T0);
    const el = widgetAt(ydoc, '/chart');
    let rows: { id: string; status: string }[] = [];
    el.listHook = (r) => {
      rows = r.map((x) => ({ id: x.thread.id, status: x.status }));
    };

    (document.querySelector('main') as HTMLElement).innerHTML = svg(2);
    renderThreadsInto(el);
    expect(pinOf(el, 't-bar')).toBeUndefined();
    expect(rows).toEqual([{ id: 't-bar', status: 'orphan' }]);
  });
});
