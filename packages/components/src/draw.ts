/**
 * The Leaflet drawing of a map: one renderer for the board's `<StreetMap>`
 * and for the package's map component (`map.ts`), so a board doc and a site
 * draw the same map from the same spec.
 *
 * It draws a spec `core/map-spec.ts` has already judged, on the basemap
 * `core/map-basemaps.ts` names. Markers and rings are SVG paths, so each is
 * an element a test can count and a reader can tap; the points, which run to
 * thousands, share one canvas. Popups are built when opened, as text nodes.
 * A basemap drawn by its provider's own script (Google's) goes under the same
 * layers through `google.ts`.
 *
 * The board builds this file into `/app/map/map.js` through
 * `workspaces-app/src/map-entry.ts`, fetched the first time a doc shows a
 * `<StreetMap>`, so a page with no map pays nothing for it.
 */
import type { Basemap } from '@claude-workspaces/core/map-basemaps';
import type { MapSpec } from '@claude-workspaces/core/map-spec';
import L from 'leaflet';
import { LayerStack, type ReadyLayer } from './draw-layers.ts';
import { addGoogleLayer } from './google.ts';

/** What the slot carries once drawn: how many of each layer went on. */
export interface MapDrawn {
  markers: number;
  rings: number;
  points: number;
}

const popupOf = (words: string) => () => {
  const p = document.createElement('div');
  p.className = 'cw-map-popup';
  p.textContent = words;
  return p;
};

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
  /** Cells the visible heatmaps stamped on their last redraw. */
  heatCells(): number;
  remove(): void;
}

/** Start a map with its basemap on `slot`. It removes itself once the slot
 *  leaves the page. */
export function createLiveMap(slot: HTMLElement, base: Basemap, keyed?: KeyedBase): LiveMap {
  const map = L.map(slot, {
    // A doc scrolls; a wheel over the map scrolls the doc, not the map.
    scrollWheelZoom: false,
    // Sized by the ResizeObserver below; Leaflet's own window listener would
    // outlive a map whose block was redrawn.
    trackResize: false,
    zoomSnap: 0.25,
  });
  map.attributionControl.setPrefix(false);
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
  const stack = new LayerStack(map, canvas);
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
      for (const p of spec.points) {
        const dot = L.circleMarker([p.lat, p.lng], {
          renderer: canvas,
          radius: 3,
          stroke: false,
          fillColor: p.color,
          fillOpacity: 0.85,
          interactive: p.popup !== undefined,
        }).addTo(group);
        if (p.popup !== undefined) dot.bindPopup(popupOf(p.popup));
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
      for (const m of spec.markers) {
        const dot = L.circleMarker([m.lat, m.lng], {
          renderer: svg,
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: m.color,
          fillOpacity: 1,
          className: 'cw-map-marker',
        }).addTo(group);
        if (m.popup !== undefined) dot.bindPopup(popupOf(m.popup));
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
    heatCells: () => stack.heatCells(),
    remove() {
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

/** Draw `spec` into `slot`; returns the cleanup that removes the map. */
export function renderMapInto(
  slot: HTMLElement,
  spec: MapSpec,
  base: Basemap,
  keyed?: KeyedBase,
): { drawn: MapDrawn; remove: () => void } {
  const live = createLiveMap(slot, base, keyed);
  return { drawn: live.draw(spec, true), remove: () => live.remove() };
}
