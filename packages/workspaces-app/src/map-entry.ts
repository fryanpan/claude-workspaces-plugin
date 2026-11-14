/**
 * The entry `scripts/build.ts` builds into `/app/map/map.js`: Leaflet, fetched
 * by `mdx-street-map.ts` the first time a doc shows a `<StreetMap>`. No page
 * bundle imports this file, so a page with no map pays nothing for it.
 *
 * It draws a spec `core/map-spec.ts` has already judged, on the basemap
 * `core/map-basemaps.ts` names. Markers and rings are SVG paths, so each is
 * an element a test can count and a reader can tap; the points, which run to
 * thousands, share one canvas. Popups are built when opened, as text nodes.
 */
import type { Basemap } from '@claude-workspaces/core/map-basemaps';
import type { MapSpec } from '@claude-workspaces/core/map-spec';
import L from 'leaflet';

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

/** Draw `spec` into `slot`; returns the cleanup that removes the map. */
export function renderMapInto(
  slot: HTMLElement,
  spec: MapSpec,
  base: Basemap,
): { drawn: MapDrawn; remove: () => void } {
  const map = L.map(slot, {
    // A doc scrolls; a wheel over the map scrolls the doc, not the map.
    scrollWheelZoom: false,
    // Sized by the ResizeObserver below; Leaflet's own window listener would
    // outlive a map whose block was redrawn.
    trackResize: false,
    zoomSnap: 0.25,
  });
  map.attributionControl.setPrefix(false);
  L.tileLayer(base.tiles, {
    attribution: base.attribution,
    maxZoom: base.maxZoom,
    ...(base.subdomains ? { subdomains: base.subdomains } : {}),
  }).addTo(map);

  // The points get a pane of their own under the overlay pane, so the
  // markers' paths are always above the points and take a reader's tap. A
  // page with no 2D canvas (a test's DOM) draws its points as SVG instead.
  const pointsPane = map.createPane('cw-points');
  pointsPane.style.zIndex = '350';
  const canvas = document.createElement('canvas').getContext('2d')
    ? L.canvas({ padding: 0.5, pane: 'cw-points' })
    : L.svg({ pane: 'cw-points' });
  for (const p of spec.points) {
    const dot = L.circleMarker([p.lat, p.lng], {
      renderer: canvas,
      radius: 3,
      stroke: false,
      fillColor: p.color,
      fillOpacity: 0.85,
      interactive: p.popup !== undefined,
    }).addTo(map);
    if (p.popup !== undefined) dot.bindPopup(popupOf(p.popup));
  }

  const svg = L.svg();
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
      }).addTo(map);
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
    }).addTo(map);
    if (m.popup !== undefined) dot.bindPopup(popupOf(m.popup));
  }

  if (spec.center) {
    map.setView(spec.center, spec.zoom ?? 15);
  } else {
    const all = [...spec.markers, ...spec.points].map((p) => L.latLng(p.lat, p.lng));
    const reach = Math.max(0, ...spec.rings.map((r) => r.meters));
    let bounds = L.latLngBounds(all);
    for (const m of spec.markers) {
      bounds = bounds.extend(L.latLng(m.lat, m.lng).toBounds(reach * 2));
    }
    map.fitBounds(bounds, { padding: [16, 16], maxZoom: spec.zoom ?? 17 });
  }

  // The column can change width after the first draw (a sidebar opens, the
  // phone turns), and Leaflet sizes itself only when told.
  const resized =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => map.invalidateSize());
  resized?.observe(slot);

  return {
    drawn: {
      markers: spec.markers.length,
      rings: spec.markers.length * spec.rings.length,
      points: spec.points.length,
    },
    remove: () => {
      resized?.disconnect();
      map.remove();
    },
  };
}
