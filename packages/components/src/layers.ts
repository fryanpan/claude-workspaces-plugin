/**
 * The map's `layers` prop, read and judged before anything draws: GeoJSON
 * line, polygon, circle and heatmap layers over the basemap, under the map's
 * own points and markers.
 *
 *   layers: [
 *     { type: 'polygon', name: 'Saltmarsh quarter', data, fill: '#a463f2' },
 *     { type: 'line', name: 'Riverbend paths', url: './paths.geojson',
 *       color: '#ff725c', width: 3, popup: '{name}: {speed} mph' },
 *     { type: 'circle', name: 'Riverbend reports', data, fill: '#e11d48',
 *       radius: 5, popup: '{kind}' },
 *     { type: 'heatmap', name: 'Harborlight reports', data, weight: 'count' },
 *   ]
 *
 * A layer's data is inline (`data`: a FeatureCollection, a Feature, a list
 * of Features or a bare geometry) or a GeoJSON file the page fetches (`url`,
 * relative to the page or http(s)). `readLayers` judges the props alone and
 * leaves a `url` layer waiting; `readLayerData` judges the data once it is
 * here, so a file that fails names its own layer and the rest still draw.
 *
 * Nothing here touches Leaflet or the DOM. A popup is a template whose
 * `{key}` names a feature property, filled as text (`popupText`).
 */

export type LayerType = 'line' | 'polygon' | 'circle' | 'heatmap';

/** The most a map's layers hold, so one page cannot stall a reader's. Lines
 *  and polygons are canvas paths Leaflet reprojects on every zoom, so their
 *  cap counts vertices; a circle is one canvas path per position, so its cap
 *  counts positions; heatmap points are binned into cells per redraw. */
export const LAYER_LIMITS = {
  layers: 24,
  /** Line and polygon features across every layer of a map. */
  features: 50_000,
  /** Line and polygon vertices across every layer of a map. */
  vertices: 1_000_000,
  /** Heatmap points across every layer of a map. */
  heatPoints: 200_000,
  /** Circle positions across every layer of a map: each is a path of its
   *  own, held to the same order as the map's 50,000 `points`. */
  circles: 20_000,
} as const;

/** Heatmap colours, cold to hot, when a layer names none. */
export const HEAT_COLORS: readonly string[] = Object.freeze([
  '#2563eb',
  '#22d3ee',
  '#a3e635',
  '#facc15',
  '#ef4444',
]);

const DEFAULT_COLOR = '#4269d0';

/** What a layer looks like once read; its features arrive with `data`. */
interface LayerBase {
  /** The layer's id: the one given, else `layer-<index>`. */
  id: string;
  name: string;
  visible: boolean;
  /** The zooms it draws at, both ends included; an end not given is open. */
  minZoom?: number;
  maxZoom?: number;
  /** Inline data, or a URL still to fetch. */
  source: { data: unknown } | { url: string };
}

export interface LineLayer extends LayerBase {
  type: 'line';
  color: string;
  width: number;
  opacity: number;
  /** Leaflet's `dashArray`, e.g. `"6 4"`. */
  dash?: string;
  popup?: string;
}

export interface PolygonLayer extends LayerBase {
  type: 'polygon';
  fill: string;
  fillOpacity: number;
  outline: string;
  outlineWidth: number;
  outlineOpacity: number;
  popup?: string;
}

export interface CircleLayer extends LayerBase {
  type: 'circle';
  fill: string;
  fillOpacity: number;
  stroke: string;
  /** Pixels; 0 draws no stroke. */
  strokeWidth: number;
  strokeOpacity: number;
  /** Pixels, the same at every zoom. */
  radius: number;
  popup?: string;
}

export interface HeatmapLayer extends LayerBase {
  type: 'heatmap';
  /** The feature property each point's weight is read from; 1 without. */
  weight?: string;
  /** Pixels. */
  radius: number;
  intensity: number;
  colors: string[];
  opacity: number;
}

export type MapLayer = LineLayer | PolygonLayer | CircleLayer | HeatmapLayer;

/** One GeoJSON feature as the renderer takes it: a geometry of the layer's
 *  kind, and its properties. Coordinates are GeoJSON's `[lng, lat]`. */
export interface LayerFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

/** A heatmap point. */
export interface HeatPoint {
  lat: number;
  lng: number;
  weight: number;
}

/** `[west, south, east, north]`, or null for a layer with no positions. */
export type Bbox = [number, number, number, number] | null;

export type LayerData =
  | { kind: 'paths'; features: LayerFeature[]; vertices: number; bbox: Bbox }
  | { kind: 'heat'; points: HeatPoint[]; bbox: Bbox };

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Colours a canvas and a style attribute both take: hex, a CSS name, or
 *  an `rgb()`/`hsl()` call. Anything else is refused, not passed on. */
const COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgb|hsl)a?\([\d\s.,%/a-z]{1,60}\))$/i;

const GEOMETRIES: Record<LayerType, readonly string[]> = {
  line: ['LineString', 'MultiLineString'],
  polygon: ['Polygon', 'MultiPolygon'],
  circle: ['Point', 'MultiPoint'],
  heatmap: ['Point', 'MultiPoint'],
};

/** Fill `{key}` in `template` from `props`, as text. A key the feature
 *  lacks, or whose value is not a string, number or boolean, fills empty. */
export function popupText(template: string, props: Record<string, unknown>): string {
  return template.replace(/\{([^{}]{1,64})\}/g, (_, key: string) => {
    const v = props[key.trim()];
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';
  });
}

/** Whether `url` is one a layer may fetch: relative to the page, or http(s). */
export function layerUrlAllowed(url: string): boolean {
  if (url === '' || url.includes('\\') || [...url].some((c) => c.charCodeAt(0) < 0x20)) {
    return false;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!scheme) return !url.startsWith('//');
  return /^https?$/i.test(scheme[1] ?? '');
}

/** Read every layer's props. Data is judged later, by `readLayerData`. */
export function readLayers(v: unknown): Read<MapLayer[]> {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, error: 'layers must be a list' };
  if (v.length > LAYER_LIMITS.layers) {
    return { ok: false, error: `a map draws at most ${LAYER_LIMITS.layers} layers` };
  }
  const out: MapLayer[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of v.entries()) {
    const read = readLayer(raw, i);
    if (!read.ok) return read;
    if (ids.has(read.value.id)) {
      return { ok: false, error: `layers[${i}]: the id "${read.value.id}" is used twice` };
    }
    ids.add(read.value.id);
    out.push(read.value);
  }
  return { ok: true, value: out };
}

/** A reader of one layer's fields that remembers the first problem. */
class Fields {
  error = '';
  constructor(
    private readonly row: Record<string, unknown>,
    private readonly at: string,
  ) {}
  private fail(message: string): void {
    if (!this.error) this.error = `${this.at}.${message}`;
  }
  color(key: string, fallback: string): string {
    const v = this.row[key];
    if (v === undefined) return fallback;
    if (typeof v === 'string' && COLOR.test(v)) return v;
    this.fail(`${key} must be a colour like "#4269d0"`);
    return fallback;
  }
  /** A number clamped into `[min, max]`. */
  number(key: string, fallback: number, min: number, max: number): number {
    const v = this.row[key];
    if (v === undefined) return fallback;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.min(max, Math.max(min, v));
    this.fail(`${key} must be a number`);
    return fallback;
  }
  text(key: string): string | undefined {
    const v = this.row[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v;
    this.fail(`${key} must be text`);
    return undefined;
  }
  dash(): string | undefined {
    const v = this.row.dash;
    if (v === undefined) return undefined;
    const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.trim().split(/[\s,]+/) : null;
    const nums = parts?.map((p) => (typeof p === 'string' ? Number(p) : p));
    if (
      !nums ||
      nums.length === 0 ||
      nums.length > 8 ||
      !nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100)
    ) {
      this.fail('dash must be a list of lengths like [6, 4]');
      return undefined;
    }
    return nums.join(' ');
  }
  /** `minZoom` and `maxZoom`, each 0 to 24, the first not above the second. */
  zoomRange(): { minZoom?: number; maxZoom?: number } {
    const out: { minZoom?: number; maxZoom?: number } = {};
    for (const key of ['minZoom', 'maxZoom'] as const) {
      if (this.row[key] !== undefined) out[key] = this.number(key, 0, 0, 24);
    }
    if ((out.minZoom ?? 0) > (out.maxZoom ?? 24)) this.fail('minZoom must not be above maxZoom');
    return out;
  }
  colors(): string[] {
    const v = this.row.colors;
    if (v === undefined) return [...HEAT_COLORS];
    if (
      Array.isArray(v) &&
      v.length >= 2 &&
      v.length <= 8 &&
      v.every((c) => typeof c === 'string' && COLOR.test(c))
    ) {
      return v as string[];
    }
    this.fail('colors must be 2 to 8 colours, cold to hot');
    return [...HEAT_COLORS];
  }
}

function readLayer(raw: unknown, i: number): Read<MapLayer> {
  const at = `layers[${i}]`;
  if (!isRecord(raw)) return { ok: false, error: `${at} must be an object` };
  const type = raw.type;
  if (type !== 'line' && type !== 'polygon' && type !== 'circle' && type !== 'heatmap') {
    return { ok: false, error: `${at}.type must be "line", "polygon", "circle" or "heatmap"` };
  }
  const hasData = raw.data !== undefined;
  const hasUrl = raw.url !== undefined;
  if (hasData === hasUrl) return { ok: false, error: `${at} needs data or a url, not both` };
  let source: MapLayer['source'];
  if (hasUrl) {
    if (typeof raw.url !== 'string' || !layerUrlAllowed(raw.url)) {
      return { ok: false, error: `${at}.url must be a path on this site or an http(s) URL` };
    }
    source = { url: raw.url };
  } else {
    source = { data: raw.data };
  }
  const f = new Fields(raw, at);
  const id = f.text('id') ?? `layer-${i}`;
  const base = {
    id,
    name: f.text('name') ?? id,
    visible: raw.visible !== false,
    ...f.zoomRange(),
    source,
  };
  let layer: MapLayer;
  if (type === 'line') {
    const line: LineLayer = {
      ...base,
      type,
      color: f.color('color', DEFAULT_COLOR),
      width: f.number('width', 2, 0.5, 20),
      opacity: f.number('opacity', 0.9, 0, 1),
    };
    const dash = f.dash();
    if (dash) line.dash = dash;
    layer = line;
  } else if (type === 'polygon') {
    const fill = f.color('fill', DEFAULT_COLOR);
    const polygon: PolygonLayer = {
      ...base,
      type,
      fill,
      fillOpacity: f.number('fillOpacity', 0.25, 0, 1),
      outline: f.color('outline', fill),
      outlineWidth: f.number('outlineWidth', 1, 0, 20),
      outlineOpacity: f.number('outlineOpacity', 0.9, 0, 1),
    };
    layer = polygon;
  } else if (type === 'circle') {
    const circle: CircleLayer = {
      ...base,
      type,
      fill: f.color('fill', DEFAULT_COLOR),
      fillOpacity: f.number('fillOpacity', 0.8, 0, 1),
      stroke: f.color('stroke', '#ffffff'),
      strokeWidth: f.number('strokeWidth', 1, 0, 20),
      strokeOpacity: f.number('strokeOpacity', 1, 0, 1),
      radius: f.number('radius', 5, 1, 40),
    };
    layer = circle;
  } else {
    const heat: HeatmapLayer = {
      ...base,
      type,
      radius: f.number('radius', 18, 2, 80),
      intensity: f.number('intensity', 1, 0.05, 10),
      colors: f.colors(),
      opacity: f.number('opacity', 0.8, 0, 1),
    };
    const weight = f.text('weight');
    if (weight !== undefined) heat.weight = weight;
    layer = heat;
  }
  if (layer.type !== 'heatmap') {
    const popup = f.text('popup');
    if (popup !== undefined) layer.popup = popup;
  }
  return f.error ? { ok: false, error: f.error } : { ok: true, value: layer };
}

/** The features of a GeoJSON value: a FeatureCollection, a Feature, a list
 *  of Features, or a bare geometry. */
function featuresOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return null;
  if (data.type === 'FeatureCollection') return Array.isArray(data.features) ? data.features : null;
  if (data.type === 'Feature') return [data];
  if (typeof data.type === 'string' && 'coordinates' in data) {
    return [{ type: 'Feature', geometry: data, properties: {} }];
  }
  return null;
}

const isPosition = (p: unknown): p is [number, number] =>
  Array.isArray(p) &&
  p.length >= 2 &&
  typeof p[0] === 'number' &&
  typeof p[1] === 'number' &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

/** The positions of a geometry, `depth` lists down; null if any is not a
 *  finite `[lng, lat]`. */
function positions(c: unknown, depth: number): Array<[number, number]> | null {
  if (!Array.isArray(c)) return null;
  if (depth === 0) return isPosition(c) ? [c] : null;
  const out: Array<[number, number]> = [];
  for (const part of c) {
    const inner = positions(part, depth - 1);
    if (!inner) return null;
    for (const p of inner) out.push(p);
  }
  return out;
}

const DEPTH: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

/** What a map's layers have already spent of the caps, across layers. */
export interface LayerBudget {
  features: number;
  vertices: number;
  heatPoints: number;
  circles: number;
}

export const emptyBudget = (): LayerBudget => ({
  features: 0,
  vertices: 0,
  heatPoints: 0,
  circles: 0,
});

/** The refusal for a layer that takes the map past one of its caps. */
const over = (name: string, what: string, total: number, cap: keyof typeof LAYER_LIMITS) => ({
  ok: false as const,
  error: `${name} brings the map's ${what} to ${total}; a map draws at most ${LAYER_LIMITS[cap]}`,
});

/**
 * Judge a layer's GeoJSON: every feature's geometry must be of the layer's
 * kind (a null geometry is skipped), every position a finite `[lng, lat]`,
 * and the map's caps unspent. `budget` is what earlier layers used, and is
 * added to on success.
 */
export function readLayerData(
  layer: MapLayer,
  data: unknown,
  budget: LayerBudget,
): Read<LayerData> {
  const name = `layer "${layer.name}"`;
  const rows = featuresOf(data);
  if (!rows) return { ok: false, error: `${name} is not GeoJSON` };
  const kinds = GEOMETRIES[layer.type];
  const features: LayerFeature[] = [];
  const points: HeatPoint[] = [];
  let vertices = 0;
  let bbox: Bbox = null;
  for (const [i, row] of rows.entries()) {
    if (!isRecord(row) || row.type !== 'Feature') {
      return { ok: false, error: `${name}: feature ${i} is not a GeoJSON Feature` };
    }
    const g = row.geometry;
    if (g === null || g === undefined) continue;
    if (!isRecord(g) || typeof g.type !== 'string' || !kinds.includes(g.type)) {
      const what = isRecord(g) && typeof g.type === 'string' ? `a ${g.type}` : 'not a geometry';
      return {
        ok: false,
        error: `${name}: feature ${i} is ${what}; a ${layer.type} layer draws ${kinds.join(' and ')}`,
      };
    }
    const at = positions(g.coordinates, DEPTH[g.type] ?? 0);
    if (!at || at.length === 0) {
      return { ok: false, error: `${name}: feature ${i} has a position that is not [lng, lat]` };
    }
    for (const [lng, lat] of at) {
      if (!bbox) bbox = [lng, lat, lng, lat];
      else {
        if (lng < bbox[0]) bbox[0] = lng;
        if (lat < bbox[1]) bbox[1] = lat;
        if (lng > bbox[2]) bbox[2] = lng;
        if (lat > bbox[3]) bbox[3] = lat;
      }
    }
    const props = isRecord(row.properties) ? row.properties : {};
    if (layer.type === 'heatmap') {
      const w = layer.weight === undefined ? 1 : props[layer.weight];
      const weight = typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0;
      for (const [lng, lat] of at) points.push({ lat, lng, weight: layer.weight ? weight : 1 });
    } else {
      vertices += at.length;
      features.push({
        type: 'Feature',
        geometry: { type: g.type, coordinates: g.coordinates },
        properties: props,
      });
    }
  }
  if (layer.type === 'heatmap') {
    const total = budget.heatPoints + points.length;
    if (total > LAYER_LIMITS.heatPoints) return over(name, 'heatmap points', total, 'heatPoints');
    budget.heatPoints = total;
    return { ok: true, value: { kind: 'heat', points, bbox } };
  }
  if (layer.type === 'circle') {
    const total = budget.circles + vertices;
    if (total > LAYER_LIMITS.circles) return over(name, 'circles', total, 'circles');
    budget.circles = total;
    return { ok: true, value: { kind: 'paths', features, vertices, bbox } };
  }
  const featureTotal = budget.features + features.length;
  if (featureTotal > LAYER_LIMITS.features)
    return over(name, 'line and polygon features', featureTotal, 'features');
  const vertexTotal = budget.vertices + vertices;
  if (vertexTotal > LAYER_LIMITS.vertices) return over(name, 'vertices', vertexTotal, 'vertices');
  budget.features = featureTotal;
  budget.vertices = vertexTotal;
  return { ok: true, value: { kind: 'paths', features, vertices, bbox } };
}
