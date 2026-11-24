/**
 * A layer's `minZoom` / `maxZoom`: the map itself takes a layer off as the
 * zoom leaves its range and puts it back as the zoom returns, so a heatmap
 * hands over to the dots beneath it as a reader zooms in. The reader zooms
 * with the map's own + and − buttons, as on a page; the host's handle hears
 * of no zoom.
 *
 * happy-dom has no canvas, so the circles are SVG paths and the heatmap is a
 * canvas element that can be counted (see `map-layers.test.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import mount from '../src/map.ts';

const REPORTS = {
  type: 'FeatureCollection',
  features: Array.from({ length: 12 }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-122.45 + i * 0.001, 37.75] },
    properties: { kind: i % 2 ? 'bike' : 'walk' },
  })),
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const v = read();
    if (v !== null && v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never happened');
}

const circles = (el: HTMLElement) => el.querySelectorAll('path.cw-map-circle').length;
const heat = (el: HTMLElement) =>
  el.querySelectorAll('canvas.cw-map-heat[data-layer="heat"]').length;
/** Tap the map's + or − and wait for the basemap to reach `to`. */
async function zoomTo(el: HTMLElement, button: 'in' | 'out', to: number): Promise<void> {
  el.querySelector<HTMLElement>(`.leaflet-control-zoom-${button}`)?.click();
  await until(() => zoomNow(el) === to);
}
/** The zoom the basemap draws: the level in its tiles' URLs. */
const zoomNow = (el: HTMLElement) =>
  Number(
    /\/(\d+)\/\d+\/\d+\.png$/.exec(
      el.querySelector<HTMLImageElement>('img.leaflet-tile')?.src ?? '',
    )?.[1],
  );
const box = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLInputElement>(`.cw-map-layers li[data-layer="${id}"] input`);

/** A heatmap up to zoom 13.75 and the same reports as dots from 14. */
function handOver(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  cleanups.push(
    mount(el, {
      center: [37.75, -122.445],
      zoom: 13,
      layers: [
        { type: 'heatmap', id: 'heat', name: 'Harborlight reports', data: REPORTS, maxZoom: 13.75 },
        {
          type: 'circle',
          id: 'dots',
          name: 'Harborlight crashes',
          data: REPORTS,
          minZoom: 14,
          popup: 'Crash: {kind}',
        },
      ],
    }),
  );
  return el;
}

describe("a layer's zoom range", () => {
  it('hands the heatmap over to the dots as the reader zooms in, and back as they zoom out', async () => {
    const el = handOver();
    await until(() => el.querySelector<HTMLElement>('.cw-map-slot')?.dataset.layers === '2');
    // Zoom 13: inside the heatmap's range, below the dots'.
    expect(zoomNow(el)).toBe(13);
    expect(heat(el)).toBe(1);
    expect(circles(el)).toBe(0);

    await zoomTo(el, 'in', 14); // the dots' first zoom, past the heatmap's last
    expect(circles(el)).toBe(12);
    expect(heat(el)).toBe(0);

    await zoomTo(el, 'in', 15);
    expect(circles(el)).toBe(12);
    expect(heat(el)).toBe(0);

    await zoomTo(el, 'out', 14);
    await zoomTo(el, 'out', 13);
    expect(heat(el)).toBe(1);
    expect(circles(el)).toBe(0);
  });

  it("keeps the reader's switch apart from the zoom", async () => {
    const el = handOver();
    await until(() => heat(el) === 1);

    // Switched off below its range, the dots stay off once the zoom enters it.
    box(el, 'dots')?.click();
    await zoomTo(el, 'in', 14);
    expect(circles(el)).toBe(0);
    expect(heat(el)).toBe(0);
    // Switched on inside it, they draw.
    box(el, 'dots')?.click();
    expect(circles(el)).toBe(12);
    // The heatmap switched off and on above its range is still not drawn.
    box(el, 'heat')?.click();
    box(el, 'heat')?.click();
    expect(heat(el)).toBe(0);
    await zoomTo(el, 'out', 13);
    expect(heat(el)).toBe(1);
    expect(circles(el)).toBe(0);
  });

  it("closes a layer's popup when the zoom takes the layer off", async () => {
    const el = handOver();
    await until(() => heat(el) === 1);
    await zoomTo(el, 'in', 14);
    el.querySelector('path.cw-map-circle')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }),
    );
    const popup = await until(() => el.querySelector<HTMLElement>('.cw-map-popup'));
    expect(popup.textContent).toMatch(/^Crash: (walk|bike)$/);
    await zoomTo(el, 'out', 13);
    expect(el.querySelector('.cw-map-popup')).toBeNull();
  });

  it('draws a layer with no range at every zoom', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    cleanups.push(
      mount(el, {
        center: [37.75, -122.445],
        zoom: 13,
        layers: [{ type: 'circle', data: REPORTS }],
      }),
    );
    await until(() => circles(el) === 12);
    for (const [button, to] of [
      ['in', 14],
      ['in', 15],
      ['out', 14],
      ['out', 13],
      ['out', 12],
    ] as const) {
      await zoomTo(el, button, to);
      expect(circles(el)).toBe(12);
    }
  });
});
