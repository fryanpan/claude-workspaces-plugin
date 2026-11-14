/**
 * A `<StreetMap>` in a bound `.mdx`: a street map with markers, popups,
 * radius rings and category-coloured points, drawn in the doc page itself
 * (components design, decision 2: no frames), with a legend under it.
 *
 * The tag's literal props, and the JSON file its `src` names beside the doc,
 * are judged by core `map-spec.ts`; the basemap comes from core
 * `map-basemaps.ts` by name, so tiles load only from the origins listed there
 * (decision 7). Leaflet is fetched the first time a doc shows a map, from
 * `/app/map/map.js`, by the same by-value import `mdx-plot-chart.ts` uses, and
 * its stylesheet from beside it.
 *
 * A spec that does not read draws an error box in the map's place, in the
 * class `mdx-flow-block.ts` reads a chart's failure from.
 */
import { basemapOf } from '@claude-workspaces/core/map-basemaps';
import {
  type MapSpec,
  mapDataSegments,
  mergeMapData,
  readMapSpec,
} from '@claude-workspaces/core/map-spec';
import { api, docIdFromPathOrNull } from './doc-path.ts';
import type { renderMapInto } from './map-entry.ts';
import { UNREADABLE } from './mdx-chart-props.ts';

/** What `/app/map/map.js` exports. */
export interface MapChunk {
  renderMapInto: typeof renderMapInto;
}

/** Where the build puts Leaflet and its stylesheet. */
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

let ready: MapChunk | null = null;
let loading: Promise<MapChunk | null> | null = null;

function fetchFromApp(): Promise<MapChunk | null> {
  if (!document.querySelector('link[data-cw-leaflet]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${MAP_BASE}leaflet.css`;
    css.dataset.cwLeaflet = '';
    document.head.appendChild(css);
  }
  // Built at runtime so the bundler cannot fold it into a literal it might
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
  ready = api;
  loading = api ? Promise.resolve(api) : null;
  fetchMap = fetcher ?? fetchFromApp;
}

function loadMap(): Promise<MapChunk | null> {
  if (loading) return loading;
  const pending = fetchMap().then((chunk) => {
    if (chunk) ready = chunk;
    else if (loading === pending) loading = null;
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

function errorBox(slot: HTMLElement, message: string): void {
  const box = document.createElement('div');
  box.className = 'plot-spec-error';
  box.setAttribute('role', 'alert');
  box.textContent = message;
  slot.style.removeProperty('height');
  slot.classList.remove('is-pending');
  slot.replaceChildren(box);
}

/** The legend: a swatch per category, then a ring swatch per ring. */
function legendOf(spec: MapSpec): HTMLElement | null {
  if (!spec.legend || (spec.categories.length === 0 && spec.rings.length === 0)) return null;
  const list = document.createElement('ul');
  list.className = 'mdx-map-legend';
  const item = (label: string, color: string, ring: boolean) => {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = ring ? 'mdx-map-swatch is-ring' : 'mdx-map-swatch';
    swatch.style.setProperty(ring ? 'border-color' : 'background-color', color);
    const words = document.createElement('span');
    words.textContent = label;
    li.append(swatch, words);
    list.appendChild(li);
  };
  for (const c of spec.categories) item(c.name, c.color, false);
  for (const r of spec.rings) item(r.label, r.color, true);
  return list;
}

/** The spec the summary describes, its `src` file read first. */
async function specOf(summary: StreetMapSummary): Promise<MapSpec> {
  if (summary.unreadable.length > 0) {
    throw new Error(`Not a literal, so not drawn: ${summary.unreadable.join(', ')}`);
  }
  const file = summary.src === undefined ? undefined : await fetchData(summary.src);
  const read = readMapSpec(mergeMapData(summary.props, file));
  if (!read.ok) throw new Error(read.error);
  return read.spec;
}

/**
 * Call `fn` once the slot is in the document and laid out. A node view is
 * built before ProseMirror puts it in the page, and Leaflet measures its
 * container when it starts, so a map started then has no size. A page that
 * never lays out (a test's DOM) draws once the slot is connected.
 */
function whenPlaced(slot: HTMLElement, fn: () => void): void {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    seen?.disconnect();
    fn();
  };
  const seen =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (slot.isConnected && slot.clientWidth > 0) go();
        });
  seen?.observe(slot);
  const tick = (n: number) => {
    if (done) return;
    if (slot.isConnected && (slot.clientWidth > 0 || n >= PLACE_FRAMES)) return go();
    if (n < GIVE_UP_FRAMES) requestAnimationFrame(() => tick(n + 1));
    else seen?.disconnect();
  };
  queueMicrotask(() => tick(0));
}

/** Frames to wait for a connected slot to get a width before drawing anyway. */
const PLACE_FRAMES = 3;
/** Frames after which a slot never connected (redrawn away) is let go. */
const GIVE_UP_FRAMES = 600;

function draw(chunk: MapChunk, slot: HTMLElement, legendAt: HTMLElement, spec: MapSpec): void {
  const base = basemapOf(spec.basemap);
  if (!base) throw new Error(`no basemap "${spec.basemap}"`);
  slot.style.height = `${spec.height}px`;
  const legend = legendOf(spec);
  if (legend) legendAt.replaceChildren(legend);
  whenPlaced(slot, () => {
    slot.classList.remove('is-pending');
    try {
      const { drawn } = chunk.renderMapInto(slot, spec, base);
      slot.dataset.markers = String(drawn.markers);
      slot.dataset.rings = String(drawn.rings);
      slot.dataset.points = String(drawn.points);
    } catch (err) {
      errorBox(slot, err instanceof Error ? err.message : String(err));
    }
  });
}

/** Append the map, its subtitle above and its legend and note below, to
 *  `host`. The slot holds the map's height from the start, so the doc does
 *  not move when Leaflet and the data arrive. */
export function renderStreetMap(host: HTMLElement, summary: StreetMapSummary): void {
  if (summary.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'mdx-subtitle';
    sub.textContent = summary.subtitle;
    host.appendChild(sub);
  }
  const slot = document.createElement('div');
  slot.className = 'mdx-map is-pending';
  const height = summary.props.height;
  slot.style.height = `${typeof height === 'number' ? Math.min(1200, Math.max(160, height)) : 480}px`;
  // A tap or drag on the map works the map; it does not open the source.
  for (const type of ['click', 'mousedown', 'pointerdown', 'touchstart']) {
    slot.addEventListener(type, (e) => {
      if (slot.querySelector('.leaflet-container, .leaflet-pane')) e.stopPropagation();
    });
  }
  host.appendChild(slot);
  const legendAt = document.createElement('div');
  host.appendChild(legendAt);
  if (summary.note) {
    const note = document.createElement('div');
    note.className = 'mdx-chart-note mdx-map-note';
    note.textContent = summary.note;
    host.appendChild(note);
  }
  const fail = (err: unknown) => errorBox(slot, err instanceof Error ? err.message : String(err));
  // Synchronous when nothing has to be fetched, so a spec that does not read
  // fails while the block is still drawing and `mdx-flow-block.ts` sees it.
  if (ready && summary.src === undefined) {
    try {
      const read = readMapSpec(summary.props);
      if (summary.unreadable.length > 0) {
        throw new Error(`Not a literal, so not drawn: ${summary.unreadable.join(', ')}`);
      }
      if (!read.ok) throw new Error(read.error);
      draw(ready, slot, legendAt, read.spec);
    } catch (err) {
      fail(err);
    }
    return;
  }
  void Promise.all([loadMap(), specOf(summary)]).then(
    ([chunk, spec]) => {
      // Re-rendered while the fetch was in flight: that render won.
      if (!slot.isConnected) return;
      if (!chunk) return fail(new Error('The map could not be loaded'));
      try {
        draw(chunk, slot, legendAt, spec);
      } catch (err) {
        fail(err);
      }
    },
    (err) => {
      if (slot.isConnected) fail(err);
    },
  );
}
