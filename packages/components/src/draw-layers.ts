/**
 * The map's GeoJSON layers on a Leaflet map (`layers.ts` reads them; this
 * draws them), under the map's points and markers.
 *
 * Line and polygon layers share the canvas the points draw on, in the order
 * the props declare them and beneath every point. One canvas, because a
 * Leaflet canvas answers taps for its own paths only: a second canvas above
 * it would swallow every tap meant for a path below. After any change the
 * paths are restacked (`restack`), so a layer switched back on goes back to
 * its place rather than on top.
 *
 * A heatmap is a canvas of its own that takes no taps (`heat.ts`). One
 * declared before every line and polygon layer draws beneath them; one
 * declared after any draws above them and the points, still under the
 * markers.
 *
 * A path layer goes on in chunks of `CHUNK` features, the first at once and
 * one per frame after, so tens of thousands of paths never hold the page
 * for one long task while Leaflet builds them.
 *
 * Popups are built when a path is tapped, from the layer's template, as text.
 */
import L from 'leaflet';
import { HeatLayer } from './heat.ts';
import {
  type Bbox,
  type LayerData,
  type LayerFeature,
  type MapLayer,
  popupText,
} from './layers.ts';

/** A layer with its data judged, ready to draw. */
export interface ReadyLayer {
  layer: MapLayer;
  data: LayerData;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Above the tiles (200), around the points' canvas pane (350). */
const HEAT_BELOW_Z = 340;
const HEAT_ABOVE_Z = 360;

/** Path features built per frame. */
export const CHUNK = 2_000;

const boundsOf = (b: Bbox): L.LatLngBounds | null =>
  b ? L.latLngBounds([b[1], b[0]], [b[3], b[2]]) : null;

interface Drawn {
  id: string;
  layer: L.Layer;
  /** Paths restack on the shared canvas; a heatmap has its own. */
  paths: L.GeoJSON | null;
  heat: HeatLayer | null;
  bounds: L.LatLngBounds | null;
  visible: boolean;
}

export class LayerStack {
  private drawn: Drawn[] = [];
  /** Bumped by every `set`, so a chunk left over from the last one stops. */
  private generation = 0;
  private readonly group = L.layerGroup();

  constructor(
    private readonly map: L.Map,
    /** The renderer the points draw with. */
    private readonly renderer: L.Renderer,
  ) {
    for (const [name, z] of [
      ['cw-heat-below', HEAT_BELOW_Z],
      ['cw-heat-above', HEAT_ABOVE_Z],
    ] as const) {
      const pane = map.createPane(name);
      pane.style.zIndex = String(z);
      pane.style.pointerEvents = 'none';
    }
    this.group.addTo(map);
  }

  /** Replace every layer with `ready`, in declared order. A layer `hidden`
   *  names is drawn switched off. */
  set(ready: readonly ReadyLayer[], hidden: ReadonlySet<string>): void {
    this.group.clearLayers();
    this.drawn = [];
    const generation = ++this.generation;
    const pending: Array<{ paths: L.GeoJSON; features: LayerFeature[] }> = [];
    let pathsSeen = false;
    for (const { layer, data } of ready) {
      const visible = !hidden.has(layer.id);
      if (data.kind === 'heat' && layer.type === 'heatmap') {
        const heat = new HeatLayer(
          layer,
          data.points,
          pathsSeen ? 'cw-heat-above' : 'cw-heat-below',
        );
        const bounds = boundsOf(data.bbox);
        this.drawn.push({ id: layer.id, layer: heat, paths: null, heat, bounds, visible });
        continue;
      }
      if (data.kind !== 'paths' || layer.type === 'heatmap') continue;
      pathsSeen = true;
      const paths = this.pathsOf(layer);
      pending.push({ paths, features: data.features });
      const bounds = boundsOf(data.bbox);
      this.drawn.push({ id: layer.id, layer: paths, paths, heat: null, bounds, visible });
    }
    for (const d of this.drawn) if (d.visible) this.group.addLayer(d.layer);
    this.build(pending, generation, 0, 0);
  }

  /** Add the next `CHUNK` features, then come back next frame for more. */
  private build(
    pending: Array<{ paths: L.GeoJSON; features: LayerFeature[] }>,
    generation: number,
    layer: number,
    from: number,
  ): void {
    if (generation !== this.generation) return;
    let budget = CHUNK;
    while (layer < pending.length && budget > 0) {
      const p = pending[layer];
      if (!p) break;
      const take = p.features.slice(from, from + budget);
      if (take.length > 0) {
        const chunk = { type: 'FeatureCollection', features: take };
        p.paths.addData(chunk as unknown as Parameters<L.GeoJSON['addData']>[0]);
      }
      budget -= take.length;
      from += take.length;
      if (from >= p.features.length) {
        layer++;
        from = 0;
      }
    }
    this.restack();
    if (layer < pending.length) {
      requestAnimationFrame(() => this.build(pending, generation, layer, from));
    }
  }

  private pathsOf(layer: Exclude<MapLayer, { type: 'heatmap' }>): L.GeoJSON {
    const template = layer.popup;
    const style: L.PathOptions =
      layer.type === 'line'
        ? {
            color: layer.color,
            weight: layer.width,
            opacity: layer.opacity,
            fill: false,
            ...(layer.dash ? { dashArray: layer.dash } : {}),
          }
        : {
            fillColor: layer.fill,
            fillOpacity: layer.fillOpacity,
            color: layer.outline,
            weight: layer.outlineWidth,
            opacity: layer.outlineOpacity,
            stroke: layer.outlineWidth > 0,
          };
    const paths = L.geoJSON(undefined, {
      renderer: this.renderer,
      interactive: template !== undefined,
      className: `cw-map-${layer.type}`,
      style: () => style,
    } as L.GeoJSONOptions);
    if (template !== undefined) {
      paths.on('click', (e: L.LeafletMouseEvent) => {
        const from = e.propagatedFrom as { feature?: { properties?: unknown } } | undefined;
        const props = from?.feature?.properties;
        const words = popupText(template, isRecord(props) ? props : {});
        const node = this.map.getContainer().ownerDocument.createElement('div');
        node.className = 'cw-map-popup';
        node.dataset.layer = layer.id;
        node.textContent = words;
        L.popup().setLatLng(e.latlng).setContent(node).openOn(this.map);
      });
    }
    return paths;
  }

  /** Switch one layer on or off; the rest stay as they are. */
  show(id: string, on: boolean): void {
    const d = this.drawn.find((x) => x.id === id);
    if (!d || d.visible === on) return;
    d.visible = on;
    if (on) this.group.addLayer(d.layer);
    else {
      this.group.removeLayer(d.layer);
      this.map.closePopup();
    }
    this.restack();
  }

  /** Put the paths back in declared order, beneath the points: each layer,
   *  last to first, goes to the back of the shared canvas. */
  restack(): void {
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const d = this.drawn[i];
      if (d?.paths && d.visible) d.paths.bringToBack();
    }
  }

  /** What every layer covers, switched on or off, or null with nothing. */
  bounds(): L.LatLngBounds | null {
    let out: L.LatLngBounds | null = null;
    for (const d of this.drawn) {
      if (!d.bounds) continue;
      out = out
        ? out.extend(d.bounds)
        : L.latLngBounds(d.bounds.getSouthWest(), d.bounds.getNorthEast());
    }
    return out;
  }

  /** Cells the visible heatmaps stamped on their last redraw. */
  heatCells(): number {
    return this.drawn.reduce((n, d) => n + (d.heat && d.visible ? d.heat.stamped : 0), 0);
  }

  remove(): void {
    this.generation++;
    this.group.remove();
    this.drawn = [];
  }
}
