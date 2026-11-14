import { prose } from '@claude-workspaces/core';
import type { MapSpec } from '@claude-workspaces/core/map-spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import { renderMapInto } from '../src/map-entry.ts';
import { type MapChunk, mapDataUrl, setMapForTest } from '../src/mdx-street-map.ts';

/**
 * A `<StreetMap>` in a bound `.mdx` draws a Leaflet map in the doc page from
 * its literal props or the JSON file its `src` names, with a legend under it;
 * a spec it cannot read draws an error box instead; and a change made in
 * another copy of the doc redraws the map already on screen.
 *
 * Driven through the real editor, with the chunk the build serves at
 * `/app/map/map.js` swapped in from source. happy-dom has no layout, so the
 * map's own drawing is checked for its layers here and in a real browser by
 * `mdx-street-map-browser.test.ts`.
 */

const drawnSpecs: MapSpec[] = [];
const CHUNK: MapChunk = {
  renderMapInto: (slot, spec, base) => {
    drawnSpecs.push(spec);
    return renderMapInto(slot, spec, base);
  },
};
const open: Array<() => void> = [];
beforeEach(() => setMapForTest(CHUNK));
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  drawnSpecs.length = 0;
  setMapForTest(null);
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

function mount(md: string): { server: Y.Doc } {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  server.on('update', (u: Uint8Array) => Y.applyUpdate(client, u));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({
    parent,
    ydoc: client,
    awareness: new Awareness(client),
    editable: true,
  });
  open.push(() => handle.destroy());
  return { server };
}

const view = () => document.querySelector<HTMLElement>('.ProseMirror .mdx-block .mdx-view');
/** Wait until the map's layers are on, as Leaflet starts once the slot is placed. */
const drawn = (n = 1) =>
  vi.waitFor(() =>
    expect(document.querySelectorAll('.mdx-map[data-markers]').length).toBeGreaterThanOrEqual(n),
  );
const legend = () =>
  [...(view()?.querySelectorAll('.mdx-map-legend li') ?? [])].map((li) => li.textContent);

const TAG = `<StreetMap
  title="Harborlight reports"
  subtitle="Within 300 ft of each hall"
  rings={[150, 300]}
  markers={[{ lat: 37.77, lng: -122.42, label: "Harborlight hall" }, { lat: 37.78, lng: -122.41, label: "Riverbend hall" }]}
  points={[{ lat: 37.771, lng: -122.421, category: "Noise" }, { lat: 37.779, lng: -122.411, category: "Litter" }]}
  note="Synthetic data."
/>`;

describe('a StreetMap block on the doc page', () => {
  it('draws the map in the page with its title, rings, markers, points and a legend', async () => {
    mount(`Reports by hall.\n\n${TAG}\n`);
    await drawn();
    const v = view();
    expect(v?.querySelector('.mdx-title')?.textContent).toBe('Harborlight reports');
    expect(v?.querySelector('iframe')).toBeNull();
    const slot = v?.querySelector<HTMLElement>('.mdx-map');
    expect(slot?.querySelector('.leaflet-container, .leaflet-pane')).toBeTruthy();
    expect(slot?.querySelectorAll('path.cw-map-marker')).toHaveLength(2);
    expect(slot?.querySelectorAll('path.cw-map-ring')).toHaveLength(4);
    expect(slot?.dataset.points).toBe('2');
    expect(legend()).toEqual(['Noise', 'Litter', '150 ft', '300 ft']);
    expect(v?.querySelector('.mdx-map-note')?.textContent).toBe('Synthetic data.');
  });

  it('opens a marker’s popup on a tap, as text, without opening the source', async () => {
    mount(TAG.replace('label: "Harborlight hall"', 'label: "<b>Harborlight</b> hall"'));
    await drawn();
    const marker = view()?.querySelector('path.cw-map-marker');
    marker?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const popup = view()?.querySelector('.cw-map-popup');
    expect(popup?.textContent).toBe('<b>Harborlight</b> hall');
    expect(popup?.querySelector('b')).toBeNull();
    expect(document.querySelector('.ProseMirror .mdx-block')?.classList.contains('is-open')).toBe(
      false,
    );
  });

  it('draws an error box naming what it could not read, and no map', () => {
    mount('<StreetMap markers={[{ lat: "north", lng: 2 }]} />');
    expect(view()?.querySelector('.plot-spec-error')?.textContent).toBe(
      'markers[0] needs a numeric lat and lng',
    );
    expect(view()?.querySelector('.leaflet-pane')).toBeNull();
    mount('<StreetMap markers={halls} />');
    expect(document.querySelectorAll('.plot-spec-error')[1]?.textContent).toBe(
      'Not a literal, so not drawn: markers',
    );
  });

  it('redraws the map on screen when the doc changes elsewhere', async () => {
    const { server } = mount(`Reports by hall.\n\n${TAG}\n`);
    await drawn();
    expect(legend()).toContain('Noise');
    const fragment = prose.getProseFragment(server);
    server.transact(() => {
      fragment.delete(1, 1);
      fragment.insert(
        1,
        prose.parseMarkdownBlocks(
          TAG.replaceAll('"Noise"', '"Graffiti"').replace('[150, 300]', '[150]'),
          { mdx: true },
        ),
      );
    });
    expect(legend()).toEqual(['Graffiti', 'Litter', '150 ft']);
    await drawn();
    await vi.waitFor(() => expect(view()?.querySelectorAll('path.cw-map-ring')).toHaveLength(2));
  });

  it('reads its data from the JSON file its src names beside the doc', async () => {
    history.replaceState(null, '', '/workspaces/w-harbor/docs/d-reports');
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return new Response(
        JSON.stringify({
          markers: [{ lat: 37.77, lng: -122.42, popup: 'Saltmarsh hall' }],
          points: [{ lat: 37.771, lng: -122.421, category: 'Noise' }],
          basemap: 'not-a-basemap',
        }),
      );
    });
    mount('<StreetMap src="data/reports.json" rings={[150]} />');
    await vi.waitFor(() => expect(drawnSpecs).toHaveLength(1));
    expect(asked).toEqual(['/workspaces/w-harbor/docs/d-reports/files/data/reports.json']);
    expect(drawnSpecs[0]?.markers[0]?.popup).toBe('Saltmarsh hall');
    // The file supplies data, never the basemap.
    expect(drawnSpecs[0]?.basemap).toBe('osm');
    expect(legend()).toEqual(['Noise', '150 ft']);
  });

  it('refuses a src that climbs out of the doc’s folder', () => {
    history.replaceState(null, '', '/workspaces/w-harbor/docs/d-reports');
    expect(mapDataUrl('../secrets.json')).toBeNull();
    expect(mapDataUrl('/etc/x.json')).toBeNull();
    expect(mapDataUrl('notes.txt')).toBeNull();
    expect(mapDataUrl('./a b.json')).toBe('/workspaces/w-harbor/docs/d-reports/files/a%20b.json');
  });
});
