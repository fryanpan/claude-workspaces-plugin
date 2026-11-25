/**
 * The Leaflet drawing of the package's map component (`map.ts`), which a
 * board doc's `<StreetMap>` and a site both mount, so they draw the same map
 * from the same spec.
 *
 * It draws a spec `core/map-spec.ts` has already judged, on the basemap
 * `core/map-basemaps.ts` names. Markers and rings are SVG paths, so each is
 * an element a test can count and a reader can tap; the points, which run to
 * thousands, share one canvas. Popups and tooltips are built when opened, as
 * text nodes (`popup-node.ts`). A tap on a marker, a point or a GeoJSON
 * feature is handed to `onFeature`, which `map.ts` turns into a DOM event. A
 * wheel over the map zooms only under `cooperativeGestures`, and then only
 * with Ctrl or Cmd held; a plain wheel shows a hint and scrolls the page.
 * A basemap drawn by its provider's own script (Google's) goes under the same
 * layers through `google.ts`.
 *
 * The board builds it, with `map.ts`, into `/app/map/map.js` through
 * `workspaces-app/src/map-entry.ts`, fetched the first time a doc shows a
 * `<StreetMap>`, so a page with no map pays nothing for it.
 */
import type { Basemap } from '@claude-workspaces/core/map-basemaps';
import type { MapSpec } from '@claude-workspaces/core/map-spec';
import L from 'leaflet';
import { LayerStack, type ReadyLayer } from './draw-layers.ts';
import { addGoogleLayer } from './google.ts';
import { popupNode, tooltipNode } from './popup-node.ts';

/** What the slot carries once drawn: how many of each layer went on. */
export interface MapDrawn {
  markers: number;
  rings: number;
  points: number;
}

/** A tap on something the map drew. `layer` is `markers`, `points`, or the
 *  GeoJSON layer's id; `index` is the row's or the feature's position. */
export interface FeatureHit {
  layer: string;
  index: number;
  lat: number;
  lng: number;
  /** A GeoJSON feature's properties. */
  properties?: Record<string, unknown>;
}

export interface LiveMapHooks {
  onFeature?: (hit: FeatureHit) => void;
}

/** What a plain wheel over a cooperative map says. */
export const gestureHint = (mac: boolean): string =>
  mac ? 'Use ⌘ + scroll to zoom the map' : 'Use Ctrl + scroll to zoom the map';

/** For a basemap its provider's script draws: the key the host handed the
 *  map, the basemap to draw instead if the provider cannot, and who to tell. */
export interface KeyedBase {
  key: string;
  fallback: Basemap;
  fellBack: (why: 'refused' | 'unloaded') => void;
}

function tilesOf(base: Basemap): L.TileLayer {
  return L.tileLayer(base.tiles, {
    attribution: base.attribution,
    maxZoom: base.maxZoom,
    ...(base.subdomains ? { subdomains: base.subdomains } : {}),
  });
}

/** A map on a slot, whose layers can be drawn again from a new spec. */
export interface LiveMap {
  /** Replace every layer with `spec`'s; with `refit`, move the view to it. */
  draw(spec: MapSpec, refit: boolean): MapDrawn;
  /** Replace the GeoJSON layers (`draw-layers.ts`), the ones `hidden` names
   *  switched off; with `refit`, frame the last spec drawn and them. */
  setLayers(ready: readonly ReadyLayer[], hidden: ReadonlySet<string>, refit: boolean): void;
  /** Switch one GeoJSON layer on or off. */
  showLayer(id: string, on: boolean): void;
  /** Move the view; `zoom` defaults to the current one. */
  setView(center: [number, number], zoom?: number): void;
  /** Cells the visible heatmaps stamped on their last redraw. */
  heatCells(): number;
  remove(): void;
}

/** Start a map with its basemap on `slot`. It removes itself once the slot
 *  leaves the page. */
export function createLiveMap(
  slot: HTMLElement,
  base: Basemap,
  keyed?: KeyedBase,
  hooks: LiveMapHooks = {},
): LiveMap {
  const map = L.map(slot, {
    // On, but a wheel reaches Leaflet only through `wheelGate` below.
    scrollWheelZoom: true,
    // Sized by the ResizeObserver below; Leaflet's own window listener would
    // outlive a map whose block was redrawn.
    trackResize: false,
    zoomSnap: 0.25,
  });
  map.attributionControl.setPrefix(false);
  const doc = slot.ownerDocument;
  const hit = (layer: string, index: number, at: L.LatLng, properties?: Record<string, unknown>) =>
    hooks.onFeature?.({
      layer,
      index,
      lat: at.lat,
      lng: at.lng,
      ...(properties ? { properties } : {}),
    });

  // A doc scrolls; a wheel over the map scrolls the doc, not the map, unless
  // the spec asks for cooperative gestures and Ctrl or Cmd is held. Caught on
  // the way down, before Leaflet's own listener on the same element.
  let cooperative = false;
  const hint = doc.createElement('div');
  hint.className = 'cw-map-gesture-hint';
  hint.setAttribute('aria-hidden', 'true');
  const mac = /Mac|iPhone|iPad/.test(doc.defaultView?.navigator.platform ?? '');
  hint.textContent = gestureHint(mac);
  slot.appendChild(hint);
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const wheelGate = (e: WheelEvent): void => {
    if (cooperative && (e.ctrlKey || e.metaKey)) {
      hint.classList.remove('is-shown');
      return;
    }
    e.stopImmediatePropagation();
    if (!cooperative) return;
    hint.classList.add('is-shown');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('is-shown'), 1200);
  };
  slot.addEventListener('wheel', wheelGate, { capture: true });
  if (base.script) {
    if (!keyed) throw new Error(`${base.label} needs a key`);
    addGoogleLayer(map, base.script, keyed.key, base.maxZoom, (why) => {
      tilesOf(keyed.fallback).addTo(map);
      keyed.fellBack(why);
    });
  } else {
    tilesOf(base).addTo(map);
  }

  // The points get a pane of their own under the overlay pane, so the
  // markers' paths are always above the points and take a reader's tap. A
  // page with no 2D canvas (a test's DOM) draws its points as SVG instead.
  const pointsPane = map.createPane('cw-points');
  pointsPane.style.zIndex = '350';
  const canvas = document.createElement('canvas').getContext('2d')
    ? L.canvas({ padding: 0.5, pane: 'cw-points' })
    : L.svg({ pane: 'cw-points' });
  const svg = L.svg();
  let layers: L.LayerGroup | null = null;
  // The GeoJSON layers draw on the points' renderer, beneath the points.
  const stack = new LayerStack(map, canvas, (id, index, at, props) => hit(id, index, at, props));
  /** A row's popup and hover tooltip, each built when it opens. */
  const dress = (dot: L.CircleMarker, row: MapSpec['markers'][number]): void => {
    const { popup, tooltip } = row;
    if (popup !== undefined) dot.bindPopup(() => popupNode(doc, popup));
    if (tooltip !== undefined) {
      dot.bindTooltip(() => tooltipNode(doc, tooltip), { direction: 'top', offset: [0, -6] });
    }
  };
  let last: MapSpec | null = null;

  // The column can change width after the first draw (a sidebar opens, the
  // phone turns), and Leaflet sizes itself only when told.
  // A redrawn block drops its slot: the map is removed with it, so nothing
  // keeps the old one alive.
  const resized =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (slot.isConnected) {
            map.invalidateSize();
            return;
          }
          // Checked again a frame later: the editor may move a block's DOM
          // and put it straight back.
          requestAnimationFrame(() => {
            if (slot.isConnected) return;
            resized?.disconnect();
            map.remove();
          });
        });
  resized?.observe(slot);

  return {
    draw(spec, refit) {
      layers?.remove();
      const group = L.layerGroup();
      cooperative = spec.cooperativeGestures;
      for (const [i, p] of spec.points.entries()) {
        const interactive = p.popup !== undefined || p.tooltip !== undefined;
        const dot = L.circleMarker([p.lat, p.lng], {
          renderer: canvas,
          radius: 3,
          stroke: false,
          fillColor: p.color,
          fillOpacity: 0.85,
          interactive,
        }).addTo(group);
        dress(dot, p);
        if (interactive) dot.on('click', (e: L.LeafletMouseEvent) => hit('points', i, e.latlng));
      }
      for (const m of spec.markers) {
        for (const r of spec.rings) {
          L.circle([m.lat, m.lng], {
            renderer: svg,
            radius: r.meters,
            color: r.color,
            weight: 1.5,
            opacity: 0.9,
            fill: false,
            interactive: false,
            className: 'cw-map-ring',
          }).addTo(group);
        }
      }
      for (const [i, m] of spec.markers.entries()) {
        const dot = L.circleMarker([m.lat, m.lng], {
          renderer: svg,
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: m.color,
          fillOpacity: 1,
          className: 'cw-map-marker',
        }).addTo(group);
        dress(dot, m);
        dot.on('click', (e: L.LeafletMouseEvent) => hit('markers', i, e.latlng));
      }
      // Leaflet holds back a layer added to a map with no view yet, so on a
      // first draw the view goes first and the layers are placed in it.
      if (refit) fitView(map, spec, stack.bounds());
      group.addTo(map);
      layers = group;
      last = spec;
      return {
        markers: spec.markers.length,
        rings: spec.markers.length * spec.rings.length,
        points: spec.points.length,
      };
    },
    setLayers(ready, hidden, refit) {
      stack.set(ready, hidden);
      if (refit && last) fitView(map, last, stack.bounds());
    },
    showLayer(id, on) {
      stack.show(id, on);
    },
    setView(center, zoom) {
      const go = () => map.setView(center, zoom ?? map.getZoom());
      // Leaflet drops a setView made while a zoom animates, so wait it out.
      if ((map as L.Map & { _animatingZoom?: boolean })._animatingZoom) map.once('zoomend', go);
      else go();
    },
    heatCells: () => stack.heatCells(),
    remove() {
      clearTimeout(hintTimer);
      slot.removeEventListener('wheel', wheelGate, { capture: true });
      resized?.disconnect();
      stack.remove();
      map.remove();
    },
  };
}

function fitView(map: L.Map, spec: MapSpec, extra: L.LatLngBounds | null = null): void {
  if (spec.center) {
    map.setView(spec.center, spec.zoom ?? 15);
    return;
  }
  const all = [...spec.markers, ...spec.points].map((p) => L.latLng(p.lat, p.lng));
  if (all.length === 0 && !extra) {
    // Nothing to frame and no view named: the whole world.
    map.setView([20, 0], 1);
    return;
  }
  const reach = Math.max(0, ...spec.rings.map((r) => r.meters));
  let bounds = L.latLngBounds(all);
  if (extra) bounds = bounds.extend(extra);
  for (const m of spec.markers) {
    bounds = bounds.extend(L.latLng(m.lat, m.lng).toBounds(reach * 2));
  }
  map.fitBounds(bounds, { padding: [16, 16], maxZoom: spec.zoom ?? 17 });
}
