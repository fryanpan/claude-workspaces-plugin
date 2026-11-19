/**
 * The map component draws the props it is handed, lets its state replace
 * them and redraws when the state changes, picks its basemap from its props
 * alone, and says what it cannot draw instead of throwing.
 *
 * happy-dom has no layout, so these count the layers Leaflet puts on the
 * page; a real browser draws the same file in `static-page-browser.test.ts`.
 */
import { snapshotState } from '@claude-workspaces/core/component-snapshot';
import { afterEach, describe, expect, it } from 'vitest';
import mount, { MAP_STATE_KEYS, chooseBasemap, mountWithSnapshot, withState } from '../src/map.ts';

const MARKERS = [
  { lat: 37.761, lng: -122.441, label: 'Harborlight hall', category: 'Library' },
  { lat: 37.772, lng: -122.432, label: 'Riverbend school', category: 'School' },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function until<T>(read: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never happened');
}

const slotOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.cw-map-slot');

describe('the map component', () => {
  it("draws the props' markers and rings, with a legend", async () => {
    const el = host();
    cleanups.push(mount(el, { title: 'Harborlight sites', markers: MARKERS, rings: [150] }));
    const slot = await until(() => (slotOf(el)?.dataset.markers ? slotOf(el) : null));
    expect(slot.dataset.markers).toBe('2');
    expect(slot.dataset.rings).toBe('2');
    expect(slot.dataset.basemap).toBe('osm');
    expect(el.querySelectorAll('path.cw-map-marker')).toHaveLength(2);
    expect(el.querySelector('.cw-map-title')?.textContent).toBe('Harborlight sites');
    const legend = [...el.querySelectorAll('.cw-map-legend li')].map((li) => li.textContent);
    expect(legend).toEqual(['Library', 'School', '150 ft']);
  });

  it('draws what its state holds in place of the props, and redraws on a write', async () => {
    const el = host();
    const state = snapshotState({ title: "From the doc's state", markers: MARKERS.slice(0, 1) });
    cleanups.push(mount(el, { title: 'From the props', markers: MARKERS }, state));
    await until(() => slotOf(el)?.dataset.markers);
    expect(slotOf(el)?.dataset.markers).toBe('1');
    expect(el.querySelector('.cw-map-title')?.textContent).toBe("From the doc's state");

    const wrote = state.push('markers', { lat: 37.75, lng: -122.45, label: 'Saltmarsh pier' });
    expect(wrote).toEqual({ ok: true });
    await until(() => (slotOf(el)?.dataset.markers === '2' ? true : null));
    expect(el.querySelectorAll('path.cw-map-marker')).toHaveLength(2);
  });

  it('says what it cannot draw, and draws once the state fixes it', async () => {
    const el = host();
    const state = snapshotState({ markers: [{ lat: 'north' }] });
    cleanups.push(mount(el, {}, state));
    const error = el.querySelector<HTMLElement>('.cw-map-error');
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toContain('markers[0] needs a numeric lat and lng');
    expect(slotOf(el)?.hidden).toBe(true);

    state.set('markers', MARKERS);
    await until(() => slotOf(el)?.dataset.markers);
    expect(error?.hidden).toBe(true);
    expect(slotOf(el)?.hidden).toBe(false);
  });

  it('draws the whole world, not an error, when its state empties the map', async () => {
    const el = host();
    const state = snapshotState({});
    cleanups.push(mount(el, { markers: MARKERS }, state));
    await until(() => slotOf(el)?.dataset.markers);
    state.set('markers', []);
    await until(() => (slotOf(el)?.dataset.markers === '0' ? true : null));
    expect(el.querySelector<HTMLElement>('.cw-map-error')?.hidden).toBe(true);
  });

  it('stops drawing and removes the map when cleaned up', async () => {
    const el = host();
    const state = snapshotState({});
    const cleanup = mount(el, { markers: MARKERS }, state);
    await until(() => slotOf(el)?.dataset.markers);
    cleanup();
    expect(el.querySelector('.leaflet-pane')).toBeNull();
    state.set('markers', MARKERS.slice(0, 1));
    expect(slotOf(el)?.dataset.markers).toBe('2');
  });

  it('puts its styles on the page once, however many maps draw', async () => {
    const a = host();
    const b = host();
    cleanups.push(mount(a, { markers: MARKERS }), mount(b, { markers: MARKERS }));
    await until(() => slotOf(a)?.dataset.markers && slotOf(b)?.dataset.markers);
    const styles = document.head.querySelectorAll('style[data-cw-components-map]');
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain('.leaflet-container');
  });
});

describe('mountWithSnapshot', () => {
  it("draws the snapshot's state and leaves the caller's object alone", async () => {
    const el = host();
    const snapshot = { markers: MARKERS.slice(0, 1) };
    cleanups.push(mountWithSnapshot(el, { id: 'sites', markers: MARKERS }, snapshot));
    await until(() => slotOf(el)?.dataset.markers);
    expect(slotOf(el)?.dataset.markers).toBe('1');
    expect(snapshot.markers).toHaveLength(1);
  });
});

describe('the basemap', () => {
  it('is OpenStreetMap with no key, and Google with one', () => {
    expect(chooseBasemap({})).toMatchObject({ name: 'osm' });
    expect(chooseBasemap({ basemapKey: 'k' })).toMatchObject({
      name: 'google',
      keyed: { key: 'k', fallback: 'osm' },
    });
  });

  it('draws a keyed basemap named without a key on its fallback, and says so', () => {
    const choice = chooseBasemap({ basemap: 'google' });
    expect(choice).toMatchObject({ name: 'osm' });
    expect('notice' in choice ? choice.notice : '').toContain('needs a key from the page');
    const el = host();
    cleanups.push(mount(el, { basemap: 'google', markers: MARKERS }));
    expect(el.querySelector('.cw-map-notice')?.textContent).toContain('OpenStreetMap');
  });

  it('takes a named keyless basemap as it is, and refuses an unknown one', () => {
    expect(chooseBasemap({ basemap: 'carto-light', basemapKey: 'k' })).toMatchObject({
      name: 'carto-light',
    });
    expect(chooseBasemap({ basemap: 'atlas' })).toEqual({ error: 'basemap "atlas" is unknown' });
  });
});

describe('withState', () => {
  it('replaces only the keys the state may hold', () => {
    const merged = withState(
      { title: 'a', basemap: 'osm', height: 300 },
      { title: 'b', basemap: 'google', height: 900 },
    );
    expect(merged).toEqual({ title: 'b', basemap: 'osm', height: 300 });
    expect(MAP_STATE_KEYS).not.toContain('basemap');
  });
});
