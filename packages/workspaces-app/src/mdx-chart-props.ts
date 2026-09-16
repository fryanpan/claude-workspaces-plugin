/**
 * The chart an `.mdx` component describes, read out of its literal props by
 * shape rather than by component name: a `series` of x/y `values` (or `data`),
 * or a `data` list of x/y points, is lines; a `data` list of `label`/`value`
 * rows is bars. So another post's chart with the same shape is read too.
 *
 * Props arrive already parsed by `mdx-preview.ts`'s literal parser, so nothing
 * here runs the source. `mdx-chart.ts` draws what this returns; the two are
 * split so neither file has to be read to change the other.
 */

export interface ChartPoint {
  x: number;
  y: number;
}

export interface LineSeries {
  label?: string;
  points: ChartPoint[];
  dashed: boolean;
}

export interface LineChart {
  type: 'line';
  series: LineSeries[];
  unit?: string;
  /** A shaded x-range highlighting a period of interest. */
  band?: { from: number; to: number; label?: string };
  zeroBaseline: boolean;
  /** A labelled reference line at this y value, for an indexed chart. */
  baseline?: number;
  baselineLabel?: string;
  yTickFormat: 'plain' | 'thousands';
  xTickLabels?: Array<{ x: number; label: string }>;
  /** The width the post asked for, in CSS pixels. */
  width?: number;
}

export interface BarChart {
  type: 'bar';
  bars: Array<{ label: string; value: number; color?: string }>;
  orientation: 'horizontal' | 'vertical';
  unit?: string;
  highlightIndex?: number;
  width?: number;
}

export type MdxChart = LineChart | BarChart;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const numOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** A width a chart can actually be drawn at; anything else falls back. */
const widthOf = (v: unknown): number | undefined => {
  const n = numOf(v);
  return n !== undefined && n >= 1 && n <= 4000 ? n : undefined;
};

/** The chart `props` describe, or undefined when they describe none. */
export function chartOf(props: Map<string, unknown>): MdxChart | undefined {
  const unit = strOf(props.get('unit'));
  const width = widthOf(props.get('width'));
  const data = props.get('data');
  const bars = barsOf(data);
  if (bars) {
    const chart: BarChart = {
      type: 'bar',
      bars,
      orientation: props.get('orientation') === 'horizontal' ? 'horizontal' : 'vertical',
    };
    if (unit) chart.unit = unit;
    if (width !== undefined) chart.width = width;
    const hi = numOf(props.get('highlightIndex'));
    if (hi !== undefined && Number.isInteger(hi) && hi >= 0 && hi < bars.length) {
      chart.highlightIndex = hi;
    }
    return chart;
  }
  const single = pointsOf(data);
  const series = seriesOf(props.get('series')) ?? (single && [{ points: single, dashed: false }]);
  // Every series has a point, and a lone point draws as a dot, so any series draws.
  if (!series) return undefined;
  const chart: LineChart = {
    type: 'line',
    series,
    zeroBaseline: props.get('zeroBaseline') !== false,
    yTickFormat: props.get('yTickFormat') === 'thousands' ? 'thousands' : 'plain',
  };
  if (unit) chart.unit = unit;
  if (width !== undefined) chart.width = width;
  const baseline = numOf(props.get('baseline'));
  if (baseline !== undefined) {
    chart.baseline = baseline;
    const label = strOf(props.get('baselineLabel'));
    if (label) chart.baselineLabel = label;
  }
  const band = props.get('band');
  if (isRec(band)) {
    const from = numOf(band.from);
    const to = numOf(band.to);
    if (from !== undefined && to !== undefined) {
      chart.band = { from: Math.min(from, to), to: Math.max(from, to) };
      const label = strOf(band.label);
      if (label) chart.band.label = label;
    }
  }
  const ticks = props.get('xTickLabels');
  if (isRec(ticks)) {
    const labels = Object.keys(ticks)
      .map((k) => ({ x: Number(k), label: strOf(ticks[k]) }))
      .filter((t): t is { x: number; label: string } => Number.isFinite(t.x) && !!t.label)
      .sort((a, b) => a.x - b.x);
    if (labels.length > 0) chart.xTickLabels = labels;
  }
  return chart;
}

function pointsOf(value: unknown): ChartPoint[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: ChartPoint[] = [];
  for (const p of value) {
    if (!isRec(p)) return undefined;
    const x = numOf(p.x);
    const y = numOf(p.y);
    if (x === undefined || y === undefined) return undefined;
    out.push({ x, y });
  }
  return out;
}

function seriesOf(value: unknown): LineSeries[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: LineSeries[] = [];
  for (const s of value) {
    if (!isRec(s)) continue;
    const points = pointsOf(s.values) ?? pointsOf(s.data);
    if (!points) continue;
    const line: LineSeries = { points, dashed: s.dashed === true };
    const label = strOf(s.label) ?? strOf(s.name);
    if (label) line.label = label;
    out.push(line);
  }
  return out.length > 0 ? out : undefined;
}

function barsOf(value: unknown): BarChart['bars'] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: BarChart['bars'] = [];
  for (const b of value) {
    if (!isRec(b)) return undefined;
    const label = strOf(b.label);
    const v = numOf(b.value);
    if (label === undefined || v === undefined) return undefined;
    const bar: BarChart['bars'][number] = { label, value: v };
    const color = strOf(b.color);
    if (color && PLAIN_COLOR.test(color)) bar.color = color;
    out.push(bar);
  }
  return out;
}

/** A hex, a named colour or an rgb()/hsl() of numbers: nothing that can load a URL. */
const PLAIN_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i;
