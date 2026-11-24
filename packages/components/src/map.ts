/**
 * The street map as a component: one file that draws the same map a board
 * doc's `<StreetMap>` draws, and runs unchanged in a doc and on a site
 * (components design, "One component, three hosts").
 *
 *   mount(el, { markers: [...], rings: [150, 300] }, state?)
 *
 * Its props are the `<StreetMap>` props `core/map-spec.ts` reads (`markers`,
 * `points`, `rings`, `categories`, `center`, `zoom`, `height`, `legend`,
 * `basemap`), plus a `title`, `subtitle` and `note`, plus `basemapKey`.
 * Every key of `MAP_STATE_KEYS` the state holds replaces the prop of that
 * name, so an agent or a reader can move pins or change what is shown without
 * touching the tag, and the map redraws whenever the state changes. The view
 * moves only when what it frames changed, so a title edit leaves a reader's
 * pan alone.
 *
 * `layers` adds GeoJSON line, polygon, circle and heatmap layers beneath the
 * points and markers, each switched on and off from a list under the map or
 * by the host through the handle's `setVisible` (`layers.ts` reads them,
 * `layer-control.ts` loads them, `draw-layers.ts` draws them). A map of
 * layers alone needs no markers or points.
 *
 * The basemap is a prop. With none named it is OpenStreetMap, which needs no
 * key, or Google's roadmap when the host passes `basemapKey`. A host that
 * names a keyed basemap and passes no key gets its fallback and a line
 * saying so. In a doc the state hook is live over the doc's Y.Doc; on a site
 * it is a hook over a JSON snapshot (`mountWithSnapshot`), whose writes stay
 * on the page. With no hook it draws its props.
 *
 * Text reaches the page only as text nodes.
 */
import {
  type SnapshotOptions,
  mountFromSnapshot,
} from '@claude-workspaces/core/component-snapshot';
import { type Basemap, basemapOf } from '@claude-workspaces/core/map-basemaps';
import { type MapSpec, readMapSpec } from '@claude-workspaces/core/map-spec';
import type { StateHook } from '@claude-workspaces/core/mdx-component-runtime';
import { type KeyedBase, type LiveMap, createLiveMap } from './draw.ts';
import { LayerControl, type LayersNow } from './layer-control.ts';
import { readLayers } from './layers.ts';
import { whenPlaced } from './placed.ts';
import { ensureStyles } from './styles.ts';

/** The state keys that replace the prop of the same name. */
export const MAP_STATE_KEYS = [
  'markers',
  'points',
  'rings',
  'categories',
  'center',
  'zoom',
  'title',
  'subtitle',
  'note',
  'layers',
] as const;

/** A marker or a point. `latitude`, `lon` and `longitude` are read too. */
export type MapRow = {
  lat: number;
  lng: number;
  label?: string;
  popup?: string;
  category?: string;
};

/** A ring around every marker: feet as a number, or an object. */
export type MapRingProp =
  | number
  | { feet: number; color?: string; label?: string }
  | { meters: number; color?: string; label?: string };

/** A GeoJSON layer: `data` inline or a `url` to fetch, and how to draw it.
 *  `layers.ts` holds the defaults and ranges each field is read with. */
export type MapLayerProp = {
  /** Unique on the map; `layer-<index>` without. */
  id?: string;
  /** The words beside its switch. */
  name?: string;
  /** A FeatureCollection, a Feature, a list of Features or a geometry. */
  data?: unknown;
  /** A GeoJSON file, relative to the page or http(s). */
  url?: string;
  /** `false` starts it switched off. */
  visible?: boolean;
  /** The zooms it draws at, 0 to 24, both ends included: outside them the
   *  map takes it off and puts it back as the zoom returns. */
  minZoom?: number;
  maxZoom?: number;
  /** `{key}` is filled from each feature's properties, as text. */
  popup?: string;
} & (
  | { type: 'line'; color?: string; width?: number; opacity?: number; dash?: number[] | string }
  | {
      type: 'polygon';
      fill?: string;
      fillOpacity?: number;
      outline?: string;
      outlineWidth?: number;
      outlineOpacity?: number;
    }
  | {
      type: 'heatmap';
      /** The property each point's weight is read from. */
      weight?: string;
      radius?: number;
      intensity?: number;
      /** 2 to 8 colours, cold to hot. */
      colors?: string[];
      opacity?: number;
    }
  | {
      type: 'circle';
      fill?: string;
      fillOpacity?: number;
      stroke?: string;
      /** Pixels, 0 to 20; 0 draws no stroke. */
      strokeWidth?: number;
      strokeOpacity?: number;
      /** Pixels, 1 to 40, the same at every zoom. */
      radius?: number;
    }
);

/** What `mount` returns: call it to remove the map. */
export type MapHandle = (() => void) & {
  /** Switch the layer with this id on or off, as its row's switch would;
   *  the row shows the change. An id the map does not draw changes nothing
   *  now and holds if a layer with that id arrives later. */
  setVisible(id: string, on: boolean): void;
};

/** What a host passes the map. Every field is optional except that a map
 *  needs `markers` or `points`, here or in its state. */
export type MapProps = {
  /** The state's id: in a doc, the tag's `id`. */
  id?: string;
  markers?: MapRow[];
  points?: MapRow[];
  rings?: MapRingProp[];
  /** GeoJSON layers beneath the points and markers, in drawing order. */
  layers?: MapLayerProp[];
  /** `{ name: "#hex" }` or `[{ name, color }]`: the legend's order and colours. */
  categories?: Record<string, string> | Array<{ name: string; color?: string }>;
  center?: [number, number];
  zoom?: number;
  /** Pixels, 160 to 1200; 480 by default. */
  height?: number;
  legend?: boolean;
  /** `osm`, `carto-light` (drawn on OpenStreetMap) or `google`. */
  basemap?: string;
  /** The key for a basemap that needs one (Google's browser key). */
  basemapKey?: string;
  title?: string;
  subtitle?: string;
  note?: string;
};

/** The basemap a map draws on, from its props alone. */
export type BasemapChoice =
  | { name: string; base: Basemap; keyed?: { key: string; fallback: string }; notice?: string }
  | { error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Which basemap `props` draw on: the one named, else Google with a key and
 *  OpenStreetMap without. A keyed basemap with no key draws its fallback. */
export function chooseBasemap(props: Record<string, unknown>): BasemapChoice {
  const key = typeof props.basemapKey === 'string' && props.basemapKey ? props.basemapKey : null;
  const named = props.basemap;
  const name = named === undefined ? (key ? 'google' : 'osm') : named;
  const base = typeof name === 'string' ? basemapOf(name) : undefined;
  if (typeof name !== 'string' || !base) return { error: `basemap "${String(name)}" is unknown` };
  if (!base.key) return { name, base };
  const fallbackName = base.fallback ?? 'osm';
  const fallback = basemapOf(fallbackName);
  if (!fallback) return { error: `basemap "${fallbackName}" is unknown` };
  if (key) return { name, base, keyed: { key, fallback: fallbackName } };
  return {
    name: fallbackName,
    base: fallback,
    notice: `${base.label} needs a key from the page (basemapKey), so this map is drawn on ${fallback.label}.`,
  };
}

/** The props with each state key the state holds in place of its prop. */
export function withState(props: Record<string, unknown>, state: unknown): Record<string, unknown> {
  const out = { ...props };
  if (!isRecord(state)) return out;
  for (const key of MAP_STATE_KEYS) if (state[key] !== undefined) out[key] = state[key];
  return out;
}

/** What the view frames: a change here moves it. */
const viewOf = (spec: MapSpec, layers: string): string =>
  JSON.stringify([spec.center, spec.zoom, spec.markers, spec.points, spec.rings, layers]);

const FELL_BACK: Record<'refused' | 'unloaded', string> = {
  refused: 'refused this key',
  unloaded: 'did not load',
};

export default function mount(
  el: HTMLElement,
  props: Record<string, unknown>,
  state?: StateHook,
): MapHandle {
  const doc = el.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) => {
    const node = doc.createElement(tag);
    node.className = cls;
    return node;
  };
  const figure = make('figure', 'cw-map');
  const title = make('figcaption', 'cw-map-title');
  const subtitle = make('p', 'cw-map-subtitle');
  const error = make('div', 'cw-map-error');
  error.setAttribute('role', 'alert');
  const slot = make('div', 'cw-map-slot');
  // Says so when a keyed basemap is drawn on its fallback instead.
  const notice = make('p', 'cw-map-notice');
  notice.setAttribute('role', 'status');
  const layersAt = make('ul', 'cw-map-layers');
  layersAt.hidden = true;
  const legendAt = make('div', 'cw-map-legend-at');
  const note = make('p', 'cw-map-note');
  figure.append(title, subtitle, error, slot, notice, layersAt, legendAt, note);
  el.replaceChildren(figure);

  const choice = chooseBasemap(props);
  const say = (node: HTMLElement, words: string): void => {
    node.textContent = words;
    node.hidden = words === '';
  };
  say(notice, 'notice' in choice ? (choice.notice ?? '') : '');

  let live: LiveMap | null = null;
  let placed = false;
  let pending: MapSpec | null = null;
  let framed = '';
  let drawnSpec: MapSpec | null = null;
  let gone = false;
  // Set while `draw` runs, whose own paint puts the layers.
  let drawing = false;

  // The layers redraw on their own when a file arrives or a switch flips.
  const putLayers = (now: LayersNow): void => {
    if (drawing || !live || !drawnSpec) return;
    const view = viewOf(drawnSpec, now.frame);
    live.setLayers(now.ready, now.hidden, view !== framed);
    framed = view;
    slot.dataset.layers = String(now.ready.length);
    slot.dataset.heatCells = String(live.heatCells());
  };
  const control = new LayerControl(layersAt, putLayers, (id, on) => {
    live?.showLayer(id, on);
    if (live) slot.dataset.heatCells = String(live.heatCells());
  });

  const fail = (message: string): void => {
    say(error, message);
    slot.hidden = true;
    layersAt.hidden = true;
  };

  const paint = (spec: MapSpec): void => {
    if ('error' in choice) return;
    try {
      if (!live) {
        let keyed: KeyedBase | undefined;
        if (choice.keyed) {
          const { fallback } = choice.keyed;
          keyed = {
            key: choice.keyed.key,
            fallback: basemapOf(fallback) as Basemap,
            fellBack: (why) => {
              slot.dataset.basemap = fallback;
              const instead = basemapOf(fallback)?.label ?? fallback;
              say(
                notice,
                `${choice.base.label} ${FELL_BACK[why]}, so this map is drawn on ${instead}.`,
              );
            },
          };
        }
        slot.dataset.basemap = choice.name;
        live = createLiveMap(slot, choice.base, keyed);
      }
      const layers = control.current();
      const view = viewOf(spec, layers.frame);
      // The layers go first, so the first view frames them too.
      live.setLayers(layers.ready, layers.hidden, false);
      const drawn = live.draw(spec, view !== framed);
      framed = view;
      drawnSpec = spec;
      slot.dataset.markers = String(drawn.markers);
      slot.dataset.rings = String(drawn.rings);
      slot.dataset.points = String(drawn.points);
      slot.dataset.layers = String(layers.ready.length);
      slot.dataset.heatCells = String(live.heatCells());
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const draw = (): void => {
    const merged = withState(props, state?.get());
    const words = (key: 'title' | 'subtitle' | 'note', node: HTMLElement) =>
      say(node, typeof merged[key] === 'string' ? (merged[key] as string) : '');
    words('title', title);
    words('subtitle', subtitle);
    words('note', note);
    if ('error' in choice) {
      fail(choice.error);
      return;
    }
    const layers = readLayers(merged.layers);
    if (!layers.ok) {
      fail(layers.error);
      return;
    }
    // A map of layers alone has no markers or points to require.
    const bare = merged.markers === undefined && merged.points === undefined;
    const read = readMapSpec({
      ...merged,
      ...(bare && layers.value.length > 0 ? { markers: [] } : {}),
      basemap: choice.name,
    });
    if (!read.ok) {
      fail(read.error);
      return;
    }
    // Nothing to frame and no view named draws the whole world (`draw.ts`).
    const spec = read.spec;
    say(error, '');
    slot.hidden = false;
    slot.style.height = `${spec.height}px`;
    legendAt.replaceChildren(...legendOf(doc, spec));
    // Before the paint, so it draws the layers already here; one still
    // loading arrives through `putLayers`.
    drawing = true;
    control.update(layers.value, spec.legend);
    drawing = false;
    if (placed) paint(spec);
    else pending = spec;
  };

  draw();
  whenPlaced(slot, () => {
    if (gone) return;
    placed = true;
    ensureStyles(slot);
    if (pending) paint(pending);
    pending = null;
  });
  const off = state?.on(draw);
  const cleanup = (): void => {
    gone = true;
    off?.();
    control.remove();
    live?.remove();
    live = null;
  };
  return Object.assign(cleanup, {
    setVisible: (id: string, on: boolean): void => {
      if (!gone) control.setVisible(id, on);
    },
  });
}

/** The legend: a swatch per category, then a ring swatch per ring. */
function legendOf(doc: Document, spec: MapSpec): HTMLElement[] {
  if (!spec.legend || (spec.categories.length === 0 && spec.rings.length === 0)) return [];
  const list = doc.createElement('ul');
  list.className = 'cw-map-legend';
  const item = (label: string, color: string, ring: boolean) => {
    const li = doc.createElement('li');
    const swatch = doc.createElement('span');
    swatch.className = ring ? 'cw-map-swatch is-ring' : 'cw-map-swatch';
    swatch.style.setProperty(ring ? 'border-color' : 'background-color', color);
    const words = doc.createElement('span');
    words.textContent = label;
    li.append(swatch, words);
    list.appendChild(li);
  };
  for (const c of spec.categories) item(c.name, c.color, false);
  for (const r of spec.rings) item(r.label, r.color, true);
  return [list];
}

/**
 * Mount the map on a page that is not a doc, with a state hook over
 * `snapshot`: the JSON `get_component_state` returned for the doc's map.
 * Writes change this page's copy only. Returns the map's handle: the
 * cleanup, with `setVisible`.
 */
export function mountWithSnapshot(
  el: HTMLElement,
  props: MapProps,
  snapshot?: unknown,
  opts: SnapshotOptions = {},
): MapHandle {
  // `mountFromSnapshot` hands back what `mount` returned, the handle itself.
  return mountFromSnapshot(el, mount, props, snapshot, {
    id: props.id ?? 'map',
    ...opts,
  }) as MapHandle;
}
