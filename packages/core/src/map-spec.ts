/**
 * What a `<StreetMap>` tag in an `.mdx` doc draws, read out of its literal
 * props (and the JSON file its `src` names) into a spec the page's Leaflet
 * chunk draws without judging anything itself.
 *
 *   <StreetMap title="Harborlight reports" src="data/reports.json"
 *              rings={[150, 300]} categories={{ Noise: "#4269d0" }} />
 *
 * - `markers`: `{ lat, lng, label?, popup?, category? }`, each drawn as a dot
 *   with a popup, and with every ring around it.
 * - `rings`: radius circles around every marker, in feet (`150`), or
 *   `{ feet | meters, color?, label? }`.
 * - `points`: `{ lat, lng, category?, popup? }`, small dots coloured by
 *   category; thousands draw on one canvas.
 * - `categories`: `{ name: "#hex" }` or `[{ name, color }]`, the legend's
 *   order and colours; a category with no colour takes the next one from the
 *   palette PlotChart uses (Observable 10), in order of first appearance.
 * - `center` `[lat, lng]` and `zoom`, else the map fits its data; `height`
 *   in pixels; `legend={false}` hides the legend; `basemap` names an entry in
 *   `map-basemaps.ts`.
 *
 * `lat`/`latitude` and `lng`/`lon`/`longitude` are all read. Nothing here runs
 * the source: props arrive parsed by the page's literal parser, and every
 * string reaches the DOM as text.
 */
import { BASEMAPS, DEFAULT_BASEMAP, basemapOf } from './map-basemaps.ts';

/** Observable 10, the scheme PlotChart's categories draw in. */
export const CATEGORY_COLORS: readonly string[] = Object.freeze([
  '#4269d0',
  '#efb118',
  '#ff725c',
  '#6cc5b0',
  '#3ca951',
  '#ff8ab7',
  '#a463f2',
  '#97bbf5',
  '#9c6b4e',
  '#9498a0',
]);

/** Ring colours when a ring names none: dark to light, inner to outer. */
const RING_COLORS = ['#1f2937', '#6b7280', '#9ca3af', '#d1d5db'];

export const FEET_TO_METERS = 0.3048;

/** The most a map draws, so one doc cannot stall every reader's page. */
export const MAP_LIMITS = { markers: 2_000, points: 50_000, rings: 6 } as const;

const DEFAULT_HEIGHT = 480;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 1_200;

export interface MapMarker {
  lat: number;
  lng: number;
  label?: string;
  popup?: string;
  color: string;
}

export interface MapPoint {
  lat: number;
  lng: number;
  popup?: string;
  color: string;
}

export interface MapRing {
  meters: number;
  label: string;
  color: string;
}

export interface MapCategory {
  name: string;
  color: string;
}

export interface MapSpec {
  markers: MapMarker[];
  points: MapPoint[];
  rings: MapRing[];
  categories: MapCategory[];
  center?: [number, number];
  zoom?: number;
  height: number;
  legend: boolean;
  basemap: string;
}

export type MapRead = { ok: true; spec: MapSpec } | { ok: false; error: string };

/** The props a `src` file may supply: its data, never the page's layout or
 *  the basemap, which are the doc's call. */
const DATA_KEYS = ['markers', 'points', 'rings', 'categories'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const colorOr = (v: unknown, fallback: string): string =>
  typeof v === 'string' && HEX.test(v) ? v : fallback;

const text = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

function coords(row: Record<string, unknown>): { lat: number; lng: number } | null {
  const lat = row.lat ?? row.latitude;
  const lng = row.lng ?? row.lon ?? row.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** The tag's own props, with each data prop it left out taken from the file. */
export function mergeMapData(
  props: Record<string, unknown>,
  file: unknown,
): Record<string, unknown> {
  const out = { ...props };
  if (!isRecord(file)) return out;
  for (const key of DATA_KEYS) {
    if (out[key] === undefined && file[key] !== undefined) out[key] = file[key];
  }
  return out;
}

class Palette {
  private readonly byName = new Map<string, string>();
  private next = 0;
  constructor(authored: unknown) {
    const rows: Array<[unknown, unknown]> = Array.isArray(authored)
      ? authored.map((r) => (isRecord(r) ? [r.name, r.color] : [undefined, undefined]))
      : isRecord(authored)
        ? Object.entries(authored)
        : [];
    for (const [name, color] of rows) {
      if (typeof name !== 'string' || this.byName.has(name)) continue;
      this.byName.set(name, colorOr(color, ''));
    }
  }
  colorOf(name: string): string {
    const held = this.byName.get(name);
    if (held) return held;
    const color = CATEGORY_COLORS[this.next++ % CATEGORY_COLORS.length] ?? '#4269d0';
    this.byName.set(name, color);
    return color;
  }
  /** The categories a row used, plus every one the author listed, in the
   *  author's order then first appearance. */
  legend(used: ReadonlySet<string>): MapCategory[] {
    const out: MapCategory[] = [];
    for (const name of this.byName.keys()) {
      if (!used.has(name) && !this.byName.get(name)) continue;
      out.push({ name, color: this.colorOf(name) });
    }
    return out;
  }
}

function rows(v: unknown, what: string, limit: number): Record<string, unknown>[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return `${what} must be a list`;
  if (v.length > limit) return `${what} holds ${v.length}; a map draws at most ${limit}`;
  const out: Record<string, unknown>[] = [];
  for (const [i, row] of v.entries()) {
    if (!isRecord(row) || !coords(row)) return `${what}[${i}] needs a numeric lat and lng`;
    out.push(row);
  }
  return out;
}

function readRings(v: unknown): MapRing[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return 'rings must be a list of distances in feet';
  if (v.length > MAP_LIMITS.rings) return `a map draws at most ${MAP_LIMITS.rings} rings`;
  const out: MapRing[] = [];
  for (const [i, r] of v.entries()) {
    const fallback = RING_COLORS[Math.min(i, RING_COLORS.length - 1)] ?? '#6b7280';
    if (typeof r === 'number' && r > 0) {
      out.push({ meters: r * FEET_TO_METERS, label: `${r} ft`, color: fallback });
      continue;
    }
    if (isRecord(r) && typeof r.feet === 'number' && r.feet > 0) {
      out.push({
        meters: r.feet * FEET_TO_METERS,
        label: text(r.label) ?? `${r.feet} ft`,
        color: colorOr(r.color, fallback),
      });
      continue;
    }
    if (isRecord(r) && typeof r.meters === 'number' && r.meters > 0) {
      out.push({
        meters: r.meters,
        label: text(r.label) ?? `${r.meters} m`,
        color: colorOr(r.color, fallback),
      });
      continue;
    }
    return `rings[${i}] must be feet (150) or { feet } or { meters }`;
  }
  return out;
}

/** Read `props` (the tag's, merged with its file's) into what the map draws. */
export function readMapSpec(props: Record<string, unknown>): MapRead {
  const fail = (error: string): MapRead => ({ ok: false, error });
  const basemap = props.basemap === undefined ? DEFAULT_BASEMAP : props.basemap;
  if (typeof basemap !== 'string' || !basemapOf(basemap)) {
    return fail(`basemap "${String(basemap)}" is not one of: ${Object.keys(BASEMAPS).join(', ')}`);
  }
  const markerRows = rows(props.markers, 'markers', MAP_LIMITS.markers);
  if (typeof markerRows === 'string') return fail(markerRows);
  const pointRows = rows(props.points, 'points', MAP_LIMITS.points);
  if (typeof pointRows === 'string') return fail(pointRows);
  if (props.markers === undefined && props.points === undefined) {
    return fail('A StreetMap needs markers or points, inline or in its src file');
  }
  const rings = readRings(props.rings);
  if (typeof rings === 'string') return fail(rings);

  const palette = new Palette(props.categories);
  const used = new Set<string>();
  const categoryColor = (row: Record<string, unknown>, fallback: string): string => {
    const name = text(row.category);
    if (name === undefined) return fallback;
    used.add(name);
    return palette.colorOf(name);
  };
  const markers: MapMarker[] = markerRows.map((row) => {
    const at = coords(row) as { lat: number; lng: number };
    const m: MapMarker = { ...at, color: categoryColor(row, '#1f2937') };
    const label = text(row.label);
    if (label !== undefined) m.label = label;
    const popup = text(row.popup) ?? label;
    if (popup !== undefined) m.popup = popup;
    return m;
  });
  const points: MapPoint[] = pointRows.map((row) => {
    const at = coords(row) as { lat: number; lng: number };
    const p: MapPoint = { ...at, color: categoryColor(row, CATEGORY_COLORS[0] ?? '#4269d0') };
    const popup = text(row.popup);
    if (popup !== undefined) p.popup = popup;
    return p;
  });

  const spec: MapSpec = {
    markers,
    points,
    rings,
    categories: palette.legend(used),
    height: DEFAULT_HEIGHT,
    legend: props.legend !== false,
    basemap,
  };
  const c = props.center;
  if (Array.isArray(c) && c.length === 2) {
    const at = coords({ lat: c[0], lng: c[1] });
    if (at) spec.center = [at.lat, at.lng];
  }
  if (typeof props.zoom === 'number' && props.zoom >= 1 && props.zoom <= 20) spec.zoom = props.zoom;
  if (typeof props.height === 'number' && Number.isFinite(props.height)) {
    spec.height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, props.height)));
  }
  return { ok: true, spec };
}

/** A `src` relative to the doc, as path segments, or null for one that is
 *  absolute, climbs out, or is not a `.json` file. */
export function mapDataSegments(src: string): string[] | null {
  if (!/\.json$/i.test(src) || src.startsWith('/') || src.includes('\\')) return null;
  const segs = src.split('/').filter((s, i) => !(i === 0 && s === '.'));
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0'))) return null;
  return segs;
}

/** The literal `src` of the tag whose attributes start at `from`, read by a
 *  scan that skips quoted strings and `{…}` values, so a `>` inside a popup
 *  does not end the tag early. */
function srcOf(s: string, from: number): string | undefined {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return undefined;
      i = end;
    } else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 0 && ch === '>') return undefined;
    else if (depth === 0 && /\s/.test(ch ?? '')) {
      const m = /^\s+src\s*=\s*(["'])([^"'\n]*)\1/.exec(s.slice(i));
      if (m) return m[2];
    }
  }
  return undefined;
}

/**
 * The data files a doc's `<StreetMap>` tags name in a literal `src`, in doc
 * order, given the text of its `mdx-flow` blocks. The server serves these
 * files and no others beside the doc for a map (`doc-file-scope.ts`).
 */
export function mapDataPaths(blocks: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const block of blocks) {
    for (const m of block.matchAll(/<StreetMap(?![\w$.-])/g)) {
      const src = srcOf(block, (m.index ?? 0) + m[0].length);
      const segs = src === undefined ? null : mapDataSegments(src);
      if (segs) out.push(segs);
    }
  }
  return out;
}
