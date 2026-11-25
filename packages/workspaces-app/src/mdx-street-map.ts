/**
 * A `<StreetMap>` in a bound `.mdx`: the components package's map
 * (`components/src/map.ts`, its default export) mounted in the doc page
 * itself (components design, decision 2: no frames). This file draws nothing
 * of its own. It reads the tag, fetches what the mount needs, and hands it
 * over: the tag's literal props merged with the JSON file its `src` names
 * beside the doc, the doc's live state hook for the tag's `id`, and the key
 * for a keyed basemap, which the server hands only to a doc that draws on it.
 *
 * The tag's props and the `src` file are judged by core `map-spec.ts`; the
 * basemap comes from core `map-basemaps.ts` by name, so tiles load only from
 * the origins listed there (decision 7). The map, with Leaflet and its
 * stylesheet, is fetched the first time a doc shows a map, from
 * `/app/map/map.js`, by the same by-value import `mdx-plot-chart.ts` uses.
 *
 * A tag that does not read draws an error box in the map's place, in the
 * class `mdx-flow-block.ts` reads a chart's failure from.
 */
import { DEFAULT_BASEMAP, basemapOf } from '@claude-workspaces/core/map-basemaps';
import { mapDataSegments, mergeMapData, readMapSpec } from '@claude-workspaces/core/map-spec';
import type { StateHook } from '@claude-workspaces/core/mdx-component-runtime';
import { api, docIdFromPathOrNull } from './doc-path.ts';
import type { mountMap } from './map-entry.ts';
import { UNREADABLE } from './mdx-chart-props.ts';

/** What `/app/map/map.js` exports. */
export interface MapChunk {
  mountMap: typeof mountMap;
}

/** Where the build puts the map and Leaflet. */
export const MAP_BASE = '/app/map/';

export interface StreetMapSummary {
  subtitle?: string;
  note?: string;
  /** The `src` file's path under the doc, when the tag names one. */
  src?: string;
  /** Every literal prop, as the literal parser read it. */
  props: Record<string, unknown>;
  /** The props that were not literals, so the box can name them. */
  unreadable: string[];
}

/** The `<StreetMap>` props, as the literal parser read them. */
export function streetMapOf(props: Map<string, unknown>): StreetMapSummary {
  const out: StreetMapSummary = { props: {}, unreadable: [] };
  for (const [key, v] of props) {
    if (v === UNREADABLE) out.unreadable.push(key);
    else out.props[key] = v;
  }
  if (typeof out.props.subtitle === 'string') out.subtitle = out.props.subtitle;
  if (typeof out.props.note === 'string') out.note = out.props.note;
  if (typeof out.props.src === 'string') out.src = out.props.src;
  return out;
}

let loading: Promise<MapChunk | null> | null = null;

function fetchFromApp(): Promise<MapChunk | null> {
  // The map puts Leaflet's stylesheet on the page itself. The address is
  // built at runtime so the bundler cannot fold it into a literal it might
  // try to resolve and inline.
  const url = new URL(`${MAP_BASE}map.js`, location.href).href;
  return (import(url) as Promise<MapChunk>).then(
    (m) => m,
    () => null,
  );
}

let fetchMap: () => Promise<MapChunk | null> = fetchFromApp;

/** How a test swaps in its own Leaflet chunk, or its own fetch of one. */
export function setMapForTest(
  api: MapChunk | null,
  fetcher: (() => Promise<MapChunk | null>) | null = null,
): void {
  loading = api ? Promise.resolve(api) : null;
  fetchMap = fetcher ?? fetchFromApp;
}

function loadMap(): Promise<MapChunk | null> {
  if (loading) return loading;
  const pending = fetchMap().then((chunk) => {
    if (!chunk && loading === pending) loading = null;
    return chunk;
  });
  loading = pending;
  return pending;
}

/** The address the page reads a map's `src` file at, or null outside a doc
 *  page or for a path the server would refuse anyway. */
export function mapDataUrl(src: string): string | null {
  const segs = mapDataSegments(src);
  const docId = typeof location === 'undefined' ? null : docIdFromPathOrNull(location.pathname);
  if (!segs || !docId) return null;
  return api(`docs/${encodeURIComponent(docId)}/files/${segs.map(encodeURIComponent).join('/')}`);
}

async function fetchData(src: string): Promise<unknown> {
  const url = mapDataUrl(src);
  if (!url) throw new Error(`src "${src}" must be a .json file beside the doc`);
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`src "${src}" could not be read (${res.status})`);
  return res.json();
}

/** Why a keyed map is drawn on its fallback instead, as the reader is told. */
const FELL_BACK: Record<string, (label: string, instead: string) => string> = {
  'no-key': (label, instead) =>
    `${label} is not set up on this server, so this map is drawn on ${instead}.`,
  'not-named': (label, instead) =>
    `${label} draws only for a basemap="…" written as a string, so this map is drawn on ${instead}.`,
  refused: (label, instead) =>
    `${label} refused this server's key, so this map is drawn on ${instead}.`,
  unloaded: (label, instead) => `${label} did not load, so this map is drawn on ${instead}.`,
};

/** How long to wait before asking once more after a `not-named` answer: a
 *  tag just typed redraws here before the server has the edit. */
const NOT_NAMED_RETRY_MS = 1_000;

/** The key the server holds for `basemap`, if it hands it to this doc, or
 *  why not. Asked again on every draw: a doc that starts naming the basemap
 *  gets the key on its next draw. */
async function keyFor(basemap: string): Promise<{ key: string } | { reason: string }> {
  const docId = typeof location === 'undefined' ? null : docIdFromPathOrNull(location.pathname);
  if (!docId) return { reason: 'no-key' };
  const url = api(`docs/${encodeURIComponent(docId)}/map-key/${encodeURIComponent(basemap)}`);
  for (let tries = 0; ; tries++) {
    let got: { key: string } | { reason: string };
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const body = (await res.json()) as { key?: unknown; reason?: unknown };
      got =
        res.ok && typeof body.key === 'string' && body.key
          ? { key: body.key }
          : { reason: typeof body.reason === 'string' ? body.reason : 'no-key' };
    } catch {
      got = { reason: 'no-key' };
    }
    if (!('reason' in got) || got.reason !== 'not-named' || tries > 0) return got;
    await new Promise((r) => setTimeout(r, NOT_NAMED_RETRY_MS));
  }
}

function errorBox(box: HTMLElement, message: string): void {
  const err = document.createElement('div');
  err.className = 'plot-spec-error';
  err.setAttribute('role', 'alert');
  err.textContent = message;
  box.style.removeProperty('height');
  box.classList.remove('is-pending');
  box.replaceChildren(err);
}

/** A tag's live state, as `renderStreetMap` is handed it: a hook the page
 *  made for this drawing alone carries `dispose`, run when the drawing goes. */
export type MapStateFor = (id: string) => (StateHook & { dispose?: () => void }) | undefined;

/** Whether the state holds anything, so the tag's own props are not the
 *  whole map. */
const holds = (state: StateHook | undefined): boolean => {
  const v = state?.get();
  return typeof v === 'object' && v !== null && Object.keys(v).length > 0;
};

/**
 * Mount the map in a box appended to `host`. The box holds the map's height
 * from the start, so the doc does not move when the map and its data arrive.
 * Returns the release: it removes the map and drops its state hook.
 *
 * A tag whose props do not read, with no state to read instead, fails here
 * and at once, so `mdx-flow-block.ts` sees it while the block is drawing.
 */
export function renderStreetMap(
  host: HTMLElement,
  summary: StreetMapSummary,
  stateFor?: MapStateFor,
): () => void {
  const box = document.createElement('div');
  box.className = 'mdx-map is-pending';
  const height = summary.props.height;
  box.style.height = `${typeof height === 'number' ? Math.min(1200, Math.max(160, height)) : 480}px`;
  // A tap or drag on the map works the map; it does not open the source.
  for (const type of ['click', 'mousedown', 'pointerdown', 'touchstart']) {
    box.addEventListener(type, (e) => {
      if (box.querySelector('.leaflet-container, .leaflet-pane')) e.stopPropagation();
    });
  }
  host.appendChild(box);
  let handle: (() => void) | null = null;
  let released = false;
  const id = typeof summary.props.id === 'string' ? summary.props.id : undefined;
  const state = id === undefined ? undefined : stateFor?.(id);
  const release = (): void => {
    released = true;
    handle?.();
    handle = null;
    state?.dispose?.();
  };
  const fail = (err: unknown) => errorBox(box, err instanceof Error ? err.message : String(err));
  if (summary.unreadable.length > 0) {
    fail(new Error(`Not a literal, so not drawn: ${summary.unreadable.join(', ')}`));
    return release;
  }
  if (summary.src === undefined && !holds(state)) {
    const read = readMapSpec(summary.props);
    if (!read.ok) {
      fail(new Error(read.error));
      return release;
    }
  }
  // The card draws the title; the map draws the subtitle, legend and note.
  const { title: _title, ...props } = summary.props;
  const mount = (chunk: MapChunk, merged: Record<string, unknown>, notice?: string): void => {
    if (released || !box.isConnected) return;
    box.classList.remove('is-pending');
    box.style.removeProperty('height');
    try {
      handle = chunk.mountMap(box, merged, state);
    } catch (err) {
      fail(err);
      return;
    }
    const line = box.querySelector<HTMLElement>('.cw-map-notice');
    if (notice && line) {
      line.textContent = notice;
      line.hidden = false;
    }
  };
  const draw = (chunk: MapChunk, merged: Record<string, unknown>): void => {
    const read = readMapSpec(merged);
    const named = typeof merged.basemap === 'string';
    const name = read.ok ? read.spec.basemap : named ? String(merged.basemap) : DEFAULT_BASEMAP;
    const base = basemapOf(name);
    if (!base) throw new Error(`no basemap "${name}"`);
    if (!base.key) {
      mount(chunk, { ...merged, basemap: name });
      return;
    }
    const insteadName = base.fallback ?? DEFAULT_BASEMAP;
    const instead = basemapOf(insteadName);
    if (!instead) throw new Error(`no basemap "${insteadName}"`);
    void keyFor(name).then((got) => {
      if ('key' in got) {
        mount(chunk, { ...merged, basemap: name, basemapKey: got.key });
        return;
      }
      // A map that took the default basemap draws on the fallback quietly
      // when the server holds no key: nobody asked for Google.
      const why = named ? (FELL_BACK[got.reason] ?? FELL_BACK['no-key']) : undefined;
      mount(chunk, { ...merged, basemap: insteadName }, why?.(base.label, instead.label));
    });
  };
  const file = summary.src === undefined ? Promise.resolve(undefined) : fetchData(summary.src);
  void Promise.all([loadMap(), file]).then(
    ([chunk, data]) => {
      // Re-rendered while the fetch was in flight: that render won.
      if (released || !box.isConnected) return;
      if (!chunk) return fail(new Error('The map could not be loaded'));
      try {
        draw(chunk, mergeMapData(props, data));
      } catch (err) {
        fail(err);
      }
    },
    (err) => {
      if (box.isConnected) fail(err);
    },
  );
  return release;
}
