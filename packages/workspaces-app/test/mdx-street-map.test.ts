import { prose } from '@claude-workspaces/core';
import type { StateHook } from '@claude-workspaces/core/mdx-component-runtime';
import { createStateHook, readComponentState } from '@claude-workspaces/core/mdx-component-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import { mountMap } from '../src/map-entry.ts';
import { setComponentDoc } from '../src/mdx-component.ts';
import { type MapChunk, mapDataUrl, setMapForTest } from '../src/mdx-street-map.ts';

/**
 * A `<StreetMap>` in a bound `.mdx` mounts the components package's map in
 * the doc page from its literal props or the JSON file its `src` names, with
 * the doc's live state for its `id`; a spec it cannot read draws an error box
 * instead; and a change made in another copy of the doc redraws the map
 * already on screen.
 *
 * Driven through the real editor, with the chunk the build serves at
 * `/app/map/map.js` swapped in from source. happy-dom has no layout, so the
 * map's own drawing is checked for its layers here and in a real browser by
 * `mdx-street-map-browser.test.ts`.
 */

/** What the page handed the map on each mount. */
const mounts: Array<{ props: Record<string, unknown>; state?: StateHook }> = [];
const CHUNK: MapChunk = {
  mountMap: (el, props, state) => {
    mounts.push({ props, ...(state ? { state } : {}) });
    // Google's script is never loaded here: its path runs in a real browser,
    // against a stub, in `mdx-street-map-google-browser.test.ts`.
    const drawn = props.basemap === 'google' ? { ...props, basemap: 'osm', basemapKey: '' } : props;
    return mountMap(el, drawn, state);
  },
};
const open: Array<() => void> = [];
beforeEach(() => setMapForTest(CHUNK));
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  mounts.length = 0;
  setMapForTest(null);
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

function mount(md: string, opts: { mdxDoc?: boolean } = {}): { server: Y.Doc; client: Y.Doc } {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  server.on('update', (u: Uint8Array) => Y.applyUpdate(client, u));
  client.on('update', (u: Uint8Array) => Y.applyUpdate(server, u));
  // A synced `.mdx` doc page: the one surface whose maps get live state.
  if (opts.mdxDoc) setComponentDoc(client, true);
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
  return { server, client };
}

const view = () => document.querySelector<HTMLElement>('.ProseMirror .mdx-block .mdx-view');
/** Wait until the map's layers are on, as Leaflet starts once the slot is placed. */
const drawn = (n = 1) =>
  vi.waitFor(() =>
    expect(
      document.querySelectorAll('.mdx-map .cw-map-slot[data-markers]').length,
    ).toBeGreaterThanOrEqual(n),
  );
const slot = () => view()?.querySelector<HTMLElement>('.mdx-map .cw-map-slot');
const legend = () =>
  [...(view()?.querySelectorAll('.mdx-map .cw-map-legend li') ?? [])].map((li) => li.textContent);

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
    const on = slot();
    expect(on?.querySelector('.leaflet-container, .leaflet-pane')).toBeTruthy();
    expect(on?.querySelectorAll('path.cw-map-marker')).toHaveLength(2);
    expect(on?.querySelectorAll('path.cw-map-ring')).toHaveLength(4);
    expect(on?.dataset.points).toBe('2');
    expect(legend()).toEqual(['Noise', 'Litter', '150 ft', '300 ft']);
    expect(v?.querySelector('.cw-map-subtitle')?.textContent).toBe('Within 300 ft of each hall');
    expect(v?.querySelector('.cw-map-note')?.textContent).toBe('Synthetic data.');
    // One map, one legend: the doc draws none of its own.
    expect(v?.querySelectorAll('.cw-map-legend')).toHaveLength(1);
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
    await vi.waitFor(() => expect(legend()).toEqual(['Graffiti', 'Litter', '150 ft']));
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
    await vi.waitFor(() => expect(mounts).toHaveLength(1));
    expect(asked[0]).toBe('/workspaces/w-harbor/docs/d-reports/files/data/reports.json');
    const markers = mounts[0]?.props.markers as Array<{ popup?: string }>;
    expect(markers[0]?.popup).toBe('Saltmarsh hall');
    // The file supplies data, never the basemap: the tag named none, so the
    // map asked for the default's key, got none, and drew on its fallback
    // without a word.
    expect(asked[1]).toBe('/workspaces/w-harbor/docs/d-reports/map-key/google');
    expect(mounts[0]?.props.basemap).toBe('osm');
    expect(view()?.querySelector<HTMLElement>('.cw-map-notice')?.hidden).toBe(true);
    await drawn();
    expect(legend()).toEqual(['Noise', '150 ft']);
  });

  it('refuses a src that climbs out of the doc’s folder', () => {
    history.replaceState(null, '', '/workspaces/w-harbor/docs/d-reports');
    expect(mapDataUrl('../secrets.json')).toBeNull();
    expect(mapDataUrl('/etc/x.json')).toBeNull();
    expect(mapDataUrl('notes.txt')).toBeNull();
    expect(mapDataUrl('./a b.json')).toBe('/workspaces/w-harbor/docs/d-reports/files/a%20b.json');
  });

  describe('on the google basemap', () => {
    const GOOGLE = '<StreetMap basemap="google" markers={[{ lat: 37.77, lng: -122.42 }]} />';
    const notice = () => view()?.querySelector<HTMLElement>('.cw-map-notice');
    const serve = (status: number, body: unknown) => {
      const asked: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify(body), { status });
      });
      return asked;
    };
    beforeEach(() => history.replaceState(null, '', '/workspaces/w-harbor/docs/d-reports'));

    it('draws on Google with the key the server handed this doc, and says nothing', async () => {
      const asked = serve(200, { key: 'fake-maps-key' });
      mount(GOOGLE);
      await vi.waitFor(() => expect(mounts).toHaveLength(1));
      expect(asked).toEqual(['/workspaces/w-harbor/docs/d-reports/map-key/google']);
      expect(mounts[0]?.props.basemap).toBe('google');
      expect(mounts[0]?.props.basemapKey).toBe('fake-maps-key');
      expect(notice()?.hidden).toBe(true);
    });

    it('falls back to OpenStreetMap, and says so, when the server holds no key', async () => {
      serve(404, { error: 'none', reason: 'no-key' });
      mount(GOOGLE);
      await vi.waitFor(() => expect(mounts).toHaveLength(1));
      expect(mounts[0]?.props.basemap).toBe('osm');
      expect(mounts[0]?.props.basemapKey).toBeUndefined();
      expect(slot()?.dataset.basemap).toBe('osm');
      expect(notice()?.hidden).toBe(false);
      expect(notice()?.textContent).toBe(
        'Google Maps is not set up on this server, so this map is drawn on OpenStreetMap.',
      );
    });

    it('asks once more when the server has not yet seen the tag just typed', async () => {
      const answers = [
        new Response(JSON.stringify({ reason: 'not-named' }), { status: 404 }),
        new Response(JSON.stringify({ key: 'fake-maps-key' })),
      ];
      vi.stubGlobal('fetch', async () => answers.shift() ?? new Response('{}', { status: 500 }));
      mount(GOOGLE);
      await vi.waitFor(() => expect(mounts).toHaveLength(1), { timeout: 4_000 });
      expect(answers).toHaveLength(0);
      expect(mounts[0]?.props.basemapKey).toBe('fake-maps-key');
      expect(notice()?.hidden).toBe(true);
    });

    it('draws a map that names no basemap on Google when the server holds a key', async () => {
      const asked = serve(200, { key: 'fixture-maps-key-Riverbend' });
      mount('<StreetMap markers={[{ lat: 37.77, lng: -122.42 }]} />');
      await vi.waitFor(() => expect(mounts).toHaveLength(1));
      expect(asked).toEqual(['/workspaces/w-harbor/docs/d-reports/map-key/google']);
      expect(mounts[0]?.props.basemap).toBe('google');
      expect(mounts[0]?.props.basemapKey).toBe('fixture-maps-key-Riverbend');
      expect(notice()?.hidden).toBe(true);
    });

    it('draws a map that names no basemap on OpenStreetMap, quietly, with no key', async () => {
      serve(404, { error: 'none', reason: 'no-key' });
      mount('<StreetMap markers={[{ lat: 37.77, lng: -122.42 }]} />');
      await vi.waitFor(() => expect(mounts).toHaveLength(1));
      expect(mounts[0]?.props.basemap).toBe('osm');
      expect(slot()?.dataset.basemap).toBe('osm');
      expect(notice()?.hidden).toBe(true);
    });

    it('asks for no key for a map on a keyless basemap', async () => {
      const asked = serve(500, {});
      mount('<StreetMap basemap="carto-light" markers={[{ lat: 37.77, lng: -122.42 }]} />');
      await drawn();
      expect(asked).toEqual([]);
      expect(mounts[0]?.props.basemap).toBe('carto-light');
    });
  });

  describe('with an id, in a synced .mdx doc', () => {
    const HALLS =
      '<StreetMap id="halls" basemap="osm" markers={[{ lat: 37.77, lng: -122.42, label: "Harborlight hall" }]} />';
    const THREE = [
      { lat: 37.77, lng: -122.42, label: 'Harborlight hall' },
      { lat: 37.78, lng: -122.41, label: 'Riverbend hall' },
      { lat: 37.76, lng: -122.43, label: 'Saltmarsh hall' },
    ];
    beforeEach(() => history.replaceState(null, '', '/workspaces/w-harbor/docs/d-reports'));

    it('hands the map the doc’s state for its id: a write through it reads back everywhere', async () => {
      const { server } = mount(HALLS, { mdxDoc: true });
      await drawn();
      expect(slot()?.dataset.markers).toBe('1');
      const state = mounts[0]?.state;
      expect(state?.canWrite).toBe(true);
      expect(state?.set('markers', THREE)).toEqual({ ok: true });
      expect(state?.get('markers')).toEqual(THREE);
      expect(readComponentState(server, 'halls').markers).toEqual(THREE);
      await vi.waitFor(() => expect(slot()?.dataset.markers).toBe('3'));
    });

    it('redraws the map on screen when another copy of the doc writes its state', async () => {
      const { client, server } = mount(HALLS, { mdxDoc: true });
      await drawn();
      const elsewhere = createStateHook(server, 'halls', { canWrite: true });
      expect(elsewhere.set('markers', THREE)).toEqual({ ok: true });
      await vi.waitFor(() => expect(slot()?.dataset.markers).toBe('3'));
      expect(readComponentState(client, 'halls').markers).toEqual(THREE);
      elsewhere.dispose();
    });

    it('hands no state to a map outside a synced .mdx doc', async () => {
      mount(HALLS);
      await drawn();
      expect(mounts[0]?.state).toBeUndefined();
    });
  });
});
