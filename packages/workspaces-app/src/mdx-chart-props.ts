/**
 * The chart an `.mdx` component describes, read out of its literal props by
 * shape rather than by component name: a `series` of x/y `values` (or `data`),
 * or a `data` list of x/y points, is lines; a `data` list of `label`/`value`
 * rows is bars, and one whose rows carry a `kind` (or a chart whose `type` is
 * `waterfall`) is a waterfall. So another post's chart with the same shape is
 * read too.
 *
 * The defaults are the published site's (`Chart.astro`, `LineChart.astro`): a
 * bar chart with no `orientation` is horizontal and one with no `unit` is in
 * percent. A prop the preview does not draw is named in `ignored`, and one the
 * site's component accepts but draws nothing for is named in `siteIgnores`, so
 * the preview never drops a prop without saying so.
 *
 * Props arrive already parsed by core `tag-props.ts`'s literal parser, so nothing
 * here runs the source; a prop it could not read arrives as `UNREADABLE`.
 * `mdx-chart.ts` draws what this returns; the two are split so neither file
 * has to be read to change the other.
 */

import { UNREADABLE } from '@claude-workspaces/core/tag-props';

/** A prop whose value is not a literal — a variable, a call, a spread. */
export { UNREADABLE };

export interface ChartPoint {
  x: number;
  y: number;
}

export interface LineSeries {
  label?: string;
  points: ChartPoint[];
  dashed: boolean;
  /** Print the last value under the series' name; the site's default is true. */
  showValue: boolean;
}

interface ChartNotes {
  /** Props this preview draws nothing for, written as the source writes them. */
  ignored: string[];
  /** Props the site's own component accepts and draws nothing for. */
  siteIgnores: string[];
}

export interface LineChart extends ChartNotes {
  type: 'line';
  series: LineSeries[];
  unit?: string;
  /** A shaded x-range highlighting a period of interest. */
  band?: { from: number; to: number; label?: string };
  /** Dated things that happened, drawn as labelled vertical rules. */
  events?: Array<{ x: number; label: string }>;
  zeroBaseline: boolean;
  /** A labelled reference line at this y value, for an indexed chart. */
  baseline?: number;
  baselineLabel?: string;
  yTickFormat: 'plain' | 'thousands';
  xTickLabels?: Array<{ x: number; label: string }>;
  /** The width the post asked for, in CSS pixels. */
  width?: number;
}

export interface BarChart extends ChartNotes {
  type: 'bar';
  /** `sublabel` is the muted line under a horizontal bar's name. */
  bars: Array<{ label: string; value: number; color?: string; sublabel?: string }>;
  orientation: 'horizontal' | 'vertical';
  /** Written straight after every value and tick, as the site does. */
  unit: string;
  width?: number;
}

/** One waterfall bar. A start or end is a total, drawn from 0; a step is a
 *  change, drawn floating from the running total before it to the one after. */
export interface WaterfallBar {
  label: string;
  kind: 'start' | 'step' | 'end';
  /** The change for a step, the total for a start or an end. */
  value: number;
  /** The bar's two ends on the value axis: `from` 0 for a total. */
  from: number;
  to: number;
}

export interface WaterfallChart extends ChartNotes {
  type: 'waterfall';
  bars: WaterfallBar[];
  /** Written straight after every value and tick, as a bar chart's is. */
  unit: string;
  baseline?: number;
  baselineLabel?: string;
  width?: number;
}

export type MdxChart = LineChart | BarChart | WaterfallChart;

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

const BAR_PROPS = ['type', 'orientation', 'title', 'data', 'unit', 'width', 'highlightIndex'];
const BAR_ROW = ['label', 'value', 'color', 'sublabel'];
const LINE_PROPS = [
  'title',
  'series',
  'data',
  'unit',
  'band',
  'events',
  'zeroBaseline',
  'baseline',
  'baselineLabel',
  'width',
  'yTickFormat',
  'yScale',
  'xTickLabels',
];
const WATERFALL_PROPS = ['type', 'title', 'data', 'unit', 'baseline', 'baselineLabel', 'width'];
const WATERFALL_ROW = ['label', 'value', 'kind'];
const KINDS: readonly string[] = ['start', 'step', 'end'];
const SERIES_KEYS = ['label', 'name', 'values', 'data', 'dashed', 'showValue'];

/** The keys of `rec` outside `known`, each written `prefix` + key. */
function unknownKeys(rec: Rec, known: readonly string[], prefix: string, out: Set<string>): void {
  for (const k of Object.keys(rec)) if (!known.includes(k)) out.add(`${prefix}${k}`);
}

/** Top-level props outside `known`, and known ones the parser could not read. */
function unknownProps(props: Map<string, unknown>, known: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of props) if (!known.includes(k) || v === UNREADABLE) out.add(k);
  return out;
}

/** The chart `props` describe, or undefined when they describe none. */
export function chartOf(props: Map<string, unknown>): MdxChart | undefined {
  // A malformed waterfall draws nothing rather than bars from 0, which would
  // show each step as a total.
  if (isWaterfall(props)) return waterfallChartOf(props);
  const bars = barsOf(props.get('data'));
  if (bars) return barChartOf(props, bars.rows, bars.ignored);
  return lineChartOf(props);
}

function barChartOf(
  props: Map<string, unknown>,
  bars: BarChart['bars'],
  rowIgnored: Set<string>,
): BarChart {
  const ignored = unknownProps(props, BAR_PROPS);
  for (const k of rowIgnored) ignored.add(k);
  const siteIgnores: string[] = [];
  // The site draws horizontal bars unless told otherwise, and any other word
  // it is told gives vertical ones.
  const o = props.get('orientation');
  const orientation =
    o === undefined || o === UNREADABLE || o === 'horizontal' ? 'horizontal' : 'vertical';
  const type = props.get('type');
  if (type !== undefined && type !== 'bar') ignored.add('type');
  // Accepted by the site's Chart and never read by it: every bar is one colour.
  if (props.has('highlightIndex')) siteIgnores.push('highlightIndex');
  // A sublabel is drawn under a horizontal bar's name only.
  if (orientation === 'vertical' && bars.some((b) => b.sublabel)) {
    siteIgnores.push('data[].sublabel');
  }
  const chart: BarChart = {
    type: 'bar',
    bars,
    orientation,
    unit: strOf(props.get('unit')) ?? '%',
    ignored: [...ignored],
    siteIgnores,
  };
  const width = widthOf(props.get('width'));
  if (width !== undefined) chart.width = width;
  return chart;
}

function isWaterfall(props: Map<string, unknown>): boolean {
  const type = props.get('type');
  if (type === 'waterfall') return true;
  const data = props.get('data');
  return type === undefined && Array.isArray(data) && data.some((r) => isRec(r) && 'kind' in r);
}

/** Each row's floating range from the running total, or undefined when a row
 *  is not a labelled start, step or end with the number its kind needs. */
function waterfallChartOf(props: Map<string, unknown>): WaterfallChart | undefined {
  const data = props.get('data');
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const ignored = unknownProps(props, WATERFALL_PROPS);
  const bars: WaterfallBar[] = [];
  let total = 0;
  for (const r of data) {
    if (!isRec(r)) return undefined;
    const label = strOf(r.label);
    const kind = strOf(r.kind);
    if (label === undefined || kind === undefined || !KINDS.includes(kind)) return undefined;
    unknownKeys(r, WATERFALL_ROW, 'data[].', ignored);
    const given = numOf(r.value);
    // An end with no value is the running total; a given one is drawn as written.
    const value = given ?? (kind === 'end' ? total : undefined);
    if (value === undefined) return undefined;
    if (kind === 'step') {
      bars.push({ label, kind, value, from: total, to: total + value });
      total += value;
    } else {
      bars.push({ label, kind: kind as 'start' | 'end', value, from: 0, to: value });
      total = value;
    }
  }
  const chart: WaterfallChart = {
    type: 'waterfall',
    bars,
    unit: strOf(props.get('unit')) ?? '%',
    ignored: [...ignored],
    siteIgnores: [],
  };
  const baseline = numOf(props.get('baseline'));
  if (baseline !== undefined) {
    chart.baseline = baseline;
    const label = strOf(props.get('baselineLabel'));
    if (label) chart.baselineLabel = label;
  }
  const width = widthOf(props.get('width'));
  if (width !== undefined) chart.width = width;
  return chart;
}

function lineChartOf(props: Map<string, unknown>): LineChart | undefined {
  const ignored = unknownProps(props, LINE_PROPS);
  const single = pointsOf(props.get('data'));
  const series =
    seriesOf(props.get('series'), ignored) ??
    (single && [{ points: single, dashed: false, showValue: true }]);
  // Every series has a point, and a lone point draws as a dot, so any series draws.
  if (!series) return undefined;
  // A log axis is drawn linear here, which flattens the early years.
  if (props.get('yScale') === 'log') ignored.add('yScale');
  const chart: LineChart = {
    type: 'line',
    series,
    zeroBaseline: props.get('zeroBaseline') !== false,
    yTickFormat: props.get('yTickFormat') === 'thousands' ? 'thousands' : 'plain',
    ignored: [],
    siteIgnores: [],
  };
  const unit = strOf(props.get('unit'));
  if (unit) chart.unit = unit;
  const width = widthOf(props.get('width'));
  if (width !== undefined) chart.width = width;
  const baseline = numOf(props.get('baseline'));
  if (baseline !== undefined) {
    chart.baseline = baseline;
    const label = strOf(props.get('baselineLabel'));
    if (label) chart.baselineLabel = label;
  }
  const band = props.get('band');
  if (isRec(band)) {
    unknownKeys(band, ['from', 'to', 'label'], 'band.', ignored);
    const from = numOf(band.from);
    const to = numOf(band.to);
    if (from !== undefined && to !== undefined) {
      chart.band = { from: Math.min(from, to), to: Math.max(from, to) };
      const label = strOf(band.label);
      if (label) chart.band.label = label;
    }
  }
  const events = eventsOf(props.get('events'), ignored);
  if (events) chart.events = events;
  const ticks = props.get('xTickLabels');
  if (isRec(ticks)) {
    const labels = Object.keys(ticks)
      .map((k) => ({ x: Number(k), label: strOf(ticks[k]) }))
      .filter((t): t is { x: number; label: string } => Number.isFinite(t.x) && !!t.label)
      .sort((a, b) => a.x - b.x);
    if (labels.length > 0) chart.xTickLabels = labels;
  }
  chart.ignored = [...ignored];
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

function seriesOf(value: unknown, ignored: Set<string>): LineSeries[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: LineSeries[] = [];
  for (const s of value) {
    if (!isRec(s)) continue;
    const points = pointsOf(s.values) ?? pointsOf(s.data);
    if (!points) continue;
    unknownKeys(s, SERIES_KEYS, 'series[].', ignored);
    const line: LineSeries = {
      points,
      dashed: s.dashed === true,
      showValue: s.showValue !== false,
    };
    const label = strOf(s.label) ?? strOf(s.name);
    if (label) line.label = label;
    out.push(line);
  }
  return out.length > 0 ? out : undefined;
}

function eventsOf(value: unknown, ignored: Set<string>): LineChart['events'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<LineChart['events']> = [];
  for (const e of value) {
    if (!isRec(e)) continue;
    unknownKeys(e, ['x', 'label'], 'events[].', ignored);
    const x = numOf(e.x);
    const label = strOf(e.label);
    if (x !== undefined && label) out.push({ x, label });
  }
  return out.length > 0 ? out.sort((a, b) => a.x - b.x) : undefined;
}

function barsOf(value: unknown): { rows: BarChart['bars']; ignored: Set<string> } | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rows: BarChart['bars'] = [];
  const ignored = new Set<string>();
  for (const b of value) {
    if (!isRec(b)) return undefined;
    const label = strOf(b.label);
    const v = numOf(b.value);
    if (label === undefined || v === undefined) return undefined;
    unknownKeys(b, BAR_ROW, 'data[].', ignored);
    const bar: BarChart['bars'][number] = { label, value: v };
    const color = strOf(b.color);
    if (color && PLAIN_COLOR.test(color)) bar.color = color;
    // The site paints whatever it is given; the preview paints no colour that
    // could load a URL, and says it left one out.
    else if (b.color !== undefined) ignored.add('data[].color');
    const sub = strOf(b.sublabel);
    if (sub) bar.sublabel = sub;
    rows.push(bar);
  }
  return { rows, ignored };
}

/** A hex, a named colour or an rgb()/hsl() of numbers: nothing that can load a URL. */
const PLAIN_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i;
