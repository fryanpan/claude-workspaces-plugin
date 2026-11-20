/**
 * The map component with GeoJSON layers: a map of layers alone draws, each
 * layer gets a switch in a list under the map that turns it off and on, a
 * `url` layer is fetched and drawn when it arrives, one that fails says so
 * in its row while the others draw, and the state's `layers` replaces the
 * prop's.
 *
 * happy-dom has no canvas, so Leaflet draws the paths as SVG here and they
 * can be counted; a real browser draws them on the canvas, taps them and
 * colours the heatmap in `layers-browser.test.ts`.
 */
import { snapshotState } from '@claude-workspaces/core/component-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mount, { mountWithSnapshot } from '../src/map.ts';

const square = (lng: number, lat: number, d: number) => [
  [
    [lng, lat],
    [lng + d, lat],
    [lng + d, lat + d],
    [lng, lat + d],
    [lng, lat],
  ],
];
const QUARTERS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: square(-122.45, 37.75, 0.01) },
      properties: { name: 'Saltmarsh' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: square(-122.43, 37.75, 0.01) },
      properties: { name: 'Harborlight' },
    },
  ],
};
const PATHS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-122.45, 37.76],
          [-122.42, 37.76],
        ],
      },
      properties: { name: 'Riverbend Ave' },
    },
  ],
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const v = read();
    if (v !== null && v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never happened');
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('.cw-map-layers li')].map((li) => ({
    id: li.dataset.layer,
    state: li.dataset.state,
    features: Number(li.dataset.features),
    text: li.textContent,
  }));
const box = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLInputElement>(`.cw-map-layers li[data-layer="${id}"] input`);
const drawn = (el: HTMLElement) => el.querySelector<HTMLElement>('.cw-map-slot')?.dataset.layers;

describe('the map with layers', () => {
  it('draws a map of layers alone, with a switch per layer in declared order', async () => {
    const el = host();
    cleanups.push(
      mount(el, {
        layers: [
          { type: 'polygon', id: 'quarters', name: 'Quarters', data: QUARTERS, fill: '#a463f2' },
          { type: 'line', id: 'paths', name: 'Riverbend paths', data: PATHS, color: '#ff725c' },
        ],
      }),
    );
    await until(() => drawn(el) === '2');
    expect(el.querySelector<HTMLElement>('.cw-map-error')?.hidden).toBe(true);
    expect(rows(el)).toEqual([
      { id: 'quarters', state: 'drawn', features: 2, text: 'Quarters' },
      { id: 'paths', state: 'drawn', features: 1, text: 'Riverbend paths' },
    ]);
    expect(el.querySelectorAll('path.cw-map-polygon')).toHaveLength(2);
    expect(el.querySelectorAll('path.cw-map-line')).toHaveLength(1);
  });

  it('switches a layer off and back on from its row', async () => {
    const el = host();
    cleanups.push(
      mount(el, {
        layers: [
          { type: 'polygon', id: 'quarters', data: QUARTERS },
          { type: 'line', id: 'paths', data: PATHS, visible: false },
        ],
      }),
    );
    await until(() => drawn(el) === '2');
    expect(el.querySelectorAll('path.cw-map-line')).toHaveLength(0);
    expect(box(el, 'paths')?.checked).toBe(false);

    const paths = box(el, 'paths') as HTMLInputElement;
    paths.click();
    expect(el.querySelectorAll('path.cw-map-line')).toHaveLength(1);
    const quarters = box(el, 'quarters') as HTMLInputElement;
    quarters.click();
    expect(el.querySelectorAll('path.cw-map-polygon')).toHaveLength(0);
    expect(rows(el).map((r) => r.state)).toEqual(['off', 'drawn']);
  });

  it('fetches a url layer, draws it when it arrives, and names one that failed', async () => {
    let answer: (v: Response) => void = () => {};
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        if (url === 'missing.geojson') return Promise.resolve(new Response('', { status: 404 }));
        return new Promise<Response>((r) => {
          answer = r;
        });
      }),
    );
    const el = host();
    cleanups.push(
      mount(el, {
        markers: [{ lat: 37.76, lng: -122.44, label: 'Harborlight hall' }],
        layers: [
          { type: 'line', id: 'paths', name: 'Paths', url: 'paths.geojson' },
          { type: 'line', id: 'gone', name: 'Gone', url: 'missing.geojson' },
        ],
      }),
    );
    await until(() => rows(el)[1]?.state === 'failed');
    expect(rows(el)).toEqual([
      { id: 'paths', state: 'loading', features: 0, text: 'Pathsloading' },
      { id: 'gone', state: 'failed', features: 0, text: 'Gonecould not load: HTTP 404' },
    ]);
    expect(el.querySelectorAll('path.cw-map-marker')).toHaveLength(1);

    answer(new Response(JSON.stringify(PATHS), { status: 200 }));
    await until(() => rows(el)[0]?.state === 'drawn');
    expect(el.querySelectorAll('path.cw-map-line')).toHaveLength(1);
    expect(fetched).toEqual(['paths.geojson', 'missing.geojson']);
  });

  it('says what is wrong with a layer it cannot read, in place of the map', () => {
    const el = host();
    cleanups.push(mount(el, { layers: [{ type: 'line', data: PATHS, width: 'wide' }] }));
    const error = el.querySelector<HTMLElement>('.cw-map-error');
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe('layers[0].width must be a number');
  });

  it('names a layer whose data is of the wrong kind in its row, and draws the rest', async () => {
    const el = host();
    cleanups.push(
      mount(el, {
        layers: [
          { type: 'line', id: 'wrong', name: 'Quarters as lines', data: QUARTERS },
          { type: 'line', id: 'paths', data: PATHS },
        ],
      }),
    );
    await until(() => drawn(el) === '1');
    expect(rows(el)[0]).toMatchObject({ state: 'failed' });
    expect(rows(el)[0]?.text).toContain('feature 0 is a Polygon');
    expect(el.querySelectorAll('path.cw-map-line')).toHaveLength(1);
  });

  it("draws the state's layers in place of the prop's, and redraws on a write", async () => {
    // The state's depth and size limits leave no room for GeoJSON inline, so
    // a layer in the state names its file.
    const files: Record<string, unknown> = { 'quarters.geojson': QUARTERS, 'paths.geojson': PATHS };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(JSON.stringify(files[url]), { status: 200 })),
    );
    const el = host();
    const state = snapshotState({});
    cleanups.push(mount(el, { layers: [{ type: 'line', id: 'paths', data: PATHS }] }, state));
    await until(() => drawn(el) === '1');
    const wrote = state.set('layers', [
      { type: 'polygon', id: 'quarters', url: 'quarters.geojson' },
      { type: 'line', id: 'paths', url: 'paths.geojson' },
    ]);
    expect(wrote).toEqual({ ok: true });
    await until(() => drawn(el) === '2');
    expect(el.querySelectorAll('path.cw-map-polygon')).toHaveLength(2);
    expect(rows(el).map((r) => r.id)).toEqual(['quarters', 'paths']);
  });

  it('keeps a switched-off layer off when the map redraws', async () => {
    const el = host();
    const state = snapshotState({});
    cleanups.push(mount(el, { layers: [{ type: 'line', id: 'paths', data: PATHS }] }, state));
    await until(() => drawn(el) === '1');
    (box(el, 'paths') as HTMLInputElement).click();
    state.set('title', 'Riverbend, retitled');
    await until(() => el.querySelector('.cw-map-title')?.textContent === 'Riverbend, retitled');
    expect(box(el, 'paths')?.checked).toBe(false);
    expect(el.querySelectorAll('path.cw-map-line')).toHaveLength(0);
  });

  it('hides the switches with the legend', async () => {
    const el = host();
    cleanups.push(mount(el, { legend: false, layers: [{ type: 'line', data: PATHS }] }));
    await until(() => drawn(el) === '1');
    expect(el.querySelector<HTMLElement>('.cw-map-layers')?.hidden).toBe(true);
  });
});

/** 300 reports in a grid around the centre, as one FeatureCollection. */
const REPORTS = {
  type: 'FeatureCollection',
  features: Array.from({ length: 300 }, (_, i) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [-122.45 + (i % 20) * 0.001, 37.75 + Math.floor(i / 20) * 0.001],
    },
    properties: { kind: i % 2 ? 'bike' : 'walk' },
  })),
};

const circles = (el: HTMLElement) => el.querySelectorAll('path.cw-map-circle').length;

describe("the map's circle layers and setVisible", () => {
  it('draws no circles from a layer marked visible:false until the host calls setVisible', async () => {
    const el = host();
    const handle = mountWithSnapshot(el, {
      layers: [
        {
          type: 'circle',
          id: 'reports',
          name: 'Harborlight reports',
          data: REPORTS,
          fill: '#e11d48',
          stroke: '#ffffff',
          strokeWidth: 1,
          radius: 4,
          visible: false,
        },
      ],
    });
    cleanups.push(handle);
    await until(() => drawn(el) === '1');
    expect(circles(el)).toBe(0);
    expect(rows(el)).toEqual([
      { id: 'reports', state: 'off', features: 300, text: 'Harborlight reports' },
    ]);

    handle.setVisible('reports', true);
    expect(circles(el)).toBe(300);
    expect(box(el, 'reports')?.checked).toBe(true);
    expect(rows(el)[0]?.state).toBe('drawn');
  });

  it('styles each circle from the layer and opens its popup from the feature', async () => {
    const el = host();
    cleanups.push(
      mount(el, {
        layers: [
          {
            type: 'circle',
            id: 'reports',
            data: REPORTS,
            fill: '#e11d48',
            stroke: '#7f1d1d',
            strokeWidth: 2,
            radius: 6,
            popup: 'Report: {kind}',
          },
        ],
      }),
    );
    await until(() => circles(el) === 300);
    const first = el.querySelector<SVGPathElement>('path.cw-map-circle');
    expect(first?.getAttribute('fill')).toBe('#e11d48');
    expect(first?.getAttribute('stroke')).toBe('#7f1d1d');
    expect(first?.getAttribute('stroke-width')).toBe('2');
    first?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
    const popup = await until(() => el.querySelector<HTMLElement>('.cw-map-popup'));
    expect(popup.textContent).toBe('Report: walk');
  });

  const POINT_DATA = {
    type: 'FeatureCollection',
    features: REPORTS.features.slice(0, 5),
  };
  /** Each layer type, inline, and how many of its elements the page holds. */
  const TYPES = [
    {
      layer: { type: 'line', id: 'it', data: PATHS },
      count: (el: HTMLElement) => el.querySelectorAll('path.cw-map-line').length,
      on: 1,
    },
    {
      layer: { type: 'polygon', id: 'it', data: QUARTERS },
      count: (el: HTMLElement) => el.querySelectorAll('path.cw-map-polygon').length,
      on: 2,
    },
    {
      layer: { type: 'heatmap', id: 'it', data: POINT_DATA },
      count: (el: HTMLElement) => el.querySelectorAll('canvas.cw-map-heat[data-layer="it"]').length,
      on: 1,
    },
    {
      layer: { type: 'circle', id: 'it', data: POINT_DATA },
      count: circles,
      on: 5,
    },
  ] as const;

  it.each(TYPES)(
    'switches an inline $layer.type layer with setVisible, and its row follows',
    async ({ layer, count, on }) => {
      const el = host();
      const handle = mount(el, { layers: [layer] });
      cleanups.push(handle);
      await until(() => drawn(el) === '1');
      expect(count(el)).toBe(on);

      handle.setVisible('it', false);
      expect(count(el)).toBe(0);
      expect(box(el, 'it')?.checked).toBe(false);
      expect(rows(el)[0]?.state).toBe('off');

      handle.setVisible('it', true);
      expect(count(el)).toBe(on);
      expect(box(el, 'it')?.checked).toBe(true);
      expect(rows(el)[0]?.state).toBe('drawn');
    },
  );

  it("keeps the host's choice through a redraw, and ignores an id it does not draw", async () => {
    const el = host();
    const state = snapshotState({});
    const handle = mount(el, { layers: [{ type: 'circle', id: 'reports', data: REPORTS }] }, state);
    cleanups.push(handle);
    await until(() => circles(el) === 300);
    handle.setVisible('reports', false);
    handle.setVisible('nowhere', false);
    state.set('title', 'Riverbend, retitled');
    await until(() => el.querySelector('.cw-map-title')?.textContent === 'Riverbend, retitled');
    expect(circles(el)).toBe(0);
    expect(box(el, 'reports')?.checked).toBe(false);
  });
});
