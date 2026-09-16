/**
 * A chart drawn as SVG, one user unit per CSS pixel, from the props
 * `mdx-chart-props.ts` read. What it draws follows the published site's own
 * chart component: a band is a shaded x-range spanning the plot's full height,
 * each line carries its name and last value at its own end inside the plot
 * rather than in a legend below, and an indexed chart's reference line is
 * drawn and labelled on the plot.
 *
 * Every string reaches the page as an SVG text node or `textContent`, and a
 * bar's `color` was already narrowed to a plain colour.
 */

import type { BarChart, ChartPoint, LineChart, MdxChart } from './mdx-chart-props.ts';

export type { ChartPoint, LineSeries, LineChart, BarChart, MdxChart } from './mdx-chart-props.ts';
export { chartOf } from './mdx-chart-props.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The reference categorical palette, in its fixed order (light surface). */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7'];
const MUTED_BAR = '#adb5bd';
/** Rough width of a 12px sans glyph; no layout is read, so jsdom draws alike. */
const CH = 6.6;
const MAX_TIPS = 400;
/** A horizontal bar chart's narrowest plot, and narrowest row-label column. */
const MIN_PLOT_W = 40;
const MIN_LABEL_W = 24;

export const seriesColor = (i: number): string => SERIES[i % SERIES.length] ?? '#2a78d6';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function text(
  parent: Element,
  words: string,
  attrs: Record<string, string | number>,
): SVGTextElement {
  const t = el('text', attrs, parent);
  t.textContent = words;
  return t;
}

function tip(parent: Element, words: string): void {
  el('title', {}, parent).textContent = words;
}

/** About `count` round ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

function fmt(v: number, style: 'plain' | 'thousands', unit?: string): string {
  let s: string;
  if (style === 'thousands' && Math.abs(v) >= 1000) {
    s = `${Number((v / 1000).toFixed(1))}k`;
  } else {
    s = Number(v.toFixed(2)).toLocaleString('en-US');
  }
  // A symbol unit rides the number; a word unit captions the axis instead.
  return unit && isSymbolUnit(unit) ? `${s}${unit}` : s;
}

const isSymbolUnit = (unit: string): boolean => unit.length <= 2;

/** The chart as an SVG, one user unit per CSS pixel: the width the chart's own
 *  `width` prop asked for, else `width`. */
export function drawChart(chart: MdxChart, width: number): SVGSVGElement {
  const w = Math.max(240, Math.round(chart.width ?? width));
  return chart.type === 'line' ? drawLines(chart, w) : drawBars(chart, w);
}

function frame(w: number, h: number, type: string): SVGSVGElement {
  const svg = el('svg', {
    class: 'mdx-chart',
    'data-chart': type,
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
  });
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** The name and last value each labelled line carries at its own end. Two that
 *  would land on each other are pushed apart, as the site's chart does. */
const END_GAP = 28;

function drawLines(chart: LineChart, w: number): SVGSVGElement {
  const h = w < 520 ? 220 : 280;
  const all = chart.series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  // The band is an x-range, so it says nothing about the y axis: the extent is
  // the series' own, exactly as the published chart's is.
  if (chart.zeroBaseline) ys.push(0);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
  const yTicks = niceTicks(y0, y1);
  // A reference line the reader cannot read a number off is just a stripe.
  if (chart.baseline !== undefined && chart.baseline >= y0 && chart.baseline <= y1) {
    if (!yTicks.some((v) => Math.abs(v - chart.baseline!) < 1e-9)) yTicks.push(chart.baseline);
    yTicks.sort((a, b) => a - b);
  }
  y0 = Math.min(y0, yTicks[0] ?? y0);
  y1 = Math.max(y1, yTicks[yTicks.length - 1] ?? y1);
  // Points that share one x sit mid-plot, not against the y axis.
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const [x0, x1] = xLo === xHi ? [xLo - 1, xHi + 1] : [xLo, xHi];

  const unitCaption = chart.unit && !isSymbolUnit(chart.unit) ? chart.unit : undefined;
  const yLabels = yTicks.map((v) => fmt(v, chart.yTickFormat, chart.unit));
  const left = Math.ceil(Math.max(...yLabels.map((l) => l.length)) * CH) + 10;
  // A band's label captions the plot from above, so it takes its own strip.
  const top = (unitCaption ? 22 : 8) + (chart.band?.label ? 14 : 0);
  const ends = chart.series
    .map((s, i) => {
      const last = [...s.points].sort((a, b) => a.x - b.x).at(-1);
      if (!s.label || !last) return undefined;
      return { label: s.label, value: fmt(last.y, chart.yTickFormat, chart.unit), point: last, i };
    })
    .filter((e): e is { label: string; value: string; point: ChartPoint; i: number } => !!e);
  // Room at the right for those labels, never more than a third of the chart.
  const wanted =
    Math.max(0, ...ends.map((e) => Math.max(e.label.length, e.value.length))) * CH + 14;
  const right = ends.length > 0 ? Math.max(12, Math.min(Math.round(w * 0.34), wanted)) : 12;
  const bottom = 24;
  const pw = w - left - right;
  const ph = h - top - bottom;
  const sx = (x: number) => left + ((x - x0) / (x1 - x0)) * pw;
  const sy = (y: number) => top + ph - ((y - y0) / (y1 - y0)) * ph;

  const svg = frame(w, h, 'line');
  if (unitCaption) text(svg, unitCaption, { class: 'mdx-axis-unit', x: 0, y: 12 });

  // A vertical region over the whole plot: the band names a stretch of x.
  if (chart.band) {
    const g = el('g', { class: 'mdx-band' }, svg);
    const xa = Math.max(left, Math.min(left + pw, sx(chart.band.from)));
    const xb = Math.max(left, Math.min(left + pw, sx(chart.band.to)));
    el('rect', { x: xa, y: top, width: Math.max(1, xb - xa), height: ph }, g);
  }

  const grid = el('g', { class: 'mdx-grid' }, svg);
  yTicks.forEach((v, i) => {
    const y = sy(v);
    el('line', { x1: left, x2: left + pw, y1: y, y2: y }, grid);
    text(grid, yLabels[i] ?? '', { x: left - 6, y: y + 4, 'text-anchor': 'end' });
  });

  // A year is not a quantity, so an x tick never takes a thousands separator,
  // and a short series is ticked at its own points — both as the site does.
  const own = [...new Set(chart.series[0]?.points.map((p) => p.x) ?? [])].sort((a, b) => a - b);
  const xTicks =
    chart.xTickLabels?.filter((t) => t.x >= x0 && t.x <= x1) ??
    (own.length > 1 && own.length <= 8
      ? own
      : niceTicks(x0, x1, Math.max(2, Math.floor(pw / 90)))
          // Whole-number data (years, months, days) gets whole-number ticks.
          .filter((x) => !xs.every(Number.isInteger) || Number.isInteger(x))
    ).map((x) => ({ x, label: String(Number(x.toFixed(2))) }));
  const widest = Math.max(...xTicks.map((t) => t.label.length), 1) * CH + 8;
  const every = Math.max(1, Math.ceil((xTicks.length * widest) / pw));
  const axis = el('g', { class: 'mdx-x-axis' }, svg);
  el('line', { x1: left, x2: left + pw, y1: top + ph, y2: top + ph }, axis);
  xTicks.forEach((t, i) => {
    if (i % every !== 0) return;
    const x = sx(t.x);
    const anchor = x - widest / 2 < 0 ? 'start' : x + widest / 2 > left + pw ? 'end' : 'middle';
    text(axis, t.label, { x, y: h - 6, 'text-anchor': anchor });
  });

  drawBaseline(svg, chart, { sx, sy, x0, x1 });

  let tips = 0;
  chart.series.forEach((s, i) => {
    const g = el('g', { class: 'mdx-series', 'data-series': i }, svg);
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    const line = el(
      'polyline',
      {
        points: pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: seriesColor(i),
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      },
      g,
    );
    if (s.dashed) line.setAttribute('stroke-dasharray', '6 4');
    // One point draws no line, so it shows as a dot in the series' colour.
    if (pts.length === 1 && pts[0]) {
      const p = pts[0];
      el(
        'circle',
        { cx: sx(p.x), cy: sy(p.y), r: 4, fill: seriesColor(i), class: 'mdx-marker' },
        g,
      );
    }
    for (const p of pts) {
      if (tips++ >= MAX_TIPS) break;
      const hit = el('circle', { cx: sx(p.x), cy: sy(p.y), r: 8, class: 'mdx-hit' }, g);
      const xLabel =
        chart.xTickLabels?.find((t) => t.x === p.x)?.label ?? String(Number(p.x.toFixed(2)));
      const name = s.label ? `${s.label} · ` : '';
      tip(
        hit,
        `${name}${xLabel}: ${fmt(p.y, 'plain', chart.unit)}${unitCaption ? ` ${unitCaption}` : ''}`,
      );
    }
  });

  // Each line's own name at its end, in its colour: what lets the chart drop
  // the legend the published post does not have.
  const placed = ends
    .map((e) => ({ ...e, y: sy(e.point.y) }))
    .sort((a, b) => a.y - b.y)
    .map((e, k, list) => {
      const above = list[k - 1];
      return above && e.y - above.y < END_GAP ? { ...e, y: above.y + END_GAP } : e;
    });
  for (const e of placed) {
    const g = el('g', { class: 'mdx-end-labels' }, svg);
    const x = Math.min(sx(e.point.x) + 8, w - 2);
    const t = text(g, '', { x, y: e.y, class: 'mdx-end-label', fill: seriesColor(e.i) });
    el('tspan', { x, dy: -2 }, t).textContent = clip(e.label, right - 12);
    el('tspan', { x, dy: 13 }, t).textContent = e.value;
  }

  // Over the lines, so its halo keeps it legible where a line crosses it.
  if (chart.band?.label) {
    const mid = Math.max(left, Math.min(left + pw, sx((chart.band.from + chart.band.to) / 2)));
    text(el('g', { class: 'mdx-band' }, svg), chart.band.label, {
      x: mid,
      y: top - 4,
      'text-anchor': 'middle',
      class: 'mdx-band-label',
    });
  }
  return svg;
}

/** The reference line an indexed chart is read against, labelled at whichever
 *  end of the plot the series leave more room, on the side of the rule they
 *  are not using. */
function drawBaseline(
  svg: SVGSVGElement,
  chart: LineChart,
  scale: { sx: (x: number) => number; sy: (y: number) => number; x0: number; x1: number },
): void {
  const { baseline } = chart;
  if (baseline === undefined) return;
  const g = el('g', { class: 'mdx-baseline' }, svg);
  const y = scale.sy(baseline);
  el('line', { x1: scale.sx(scale.x0), x2: scale.sx(scale.x1), y1: y, y2: y }, g);
  const sorted = chart.series.map((s) => [...s.points].sort((a, b) => a.x - b.x));
  const atStart = startRoom(sorted, baseline);
  const ends = sorted.map((p) => (atStart ? p[0] : p.at(-1)));
  const below = ends.some((p) => (p?.y ?? baseline) > baseline);
  text(g, chart.baselineLabel ?? fmt(baseline, chart.yTickFormat, chart.unit), {
    x: atStart ? scale.sx(scale.x0) + 4 : scale.sx(scale.x1) - 4,
    y: y + (below ? 14 : -6),
    'text-anchor': atStart ? 'start' : 'end',
    class: 'mdx-baseline-label',
  });
}

function startRoom(sorted: ChartPoint[][], baseline: number): boolean {
  const room = (pick: (p: ChartPoint[]) => ChartPoint | undefined) =>
    Math.min(...sorted.map((p) => Math.abs((pick(p)?.y ?? baseline) - baseline)));
  return room((p) => p[0]) >= room((p) => p.at(-1));
}

function drawBars(chart: BarChart, w: number): SVGSVGElement {
  const values = chart.bars.map((b) => b.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values) === lo ? lo + 1 : Math.max(0, ...values);
  const valueLabels = chart.bars.map((b) =>
    chart.unit && !isSymbolUnit(chart.unit)
      ? `${fmt(b.value, 'plain')} ${chart.unit}`
      : fmt(b.value, 'plain', chart.unit),
  );
  const valueW = Math.max(...valueLabels.map((l) => l.length)) * CH + 8;
  const fill = (i: number) => {
    const own = chart.bars[i]?.color;
    if (chart.highlightIndex === undefined) return own ?? seriesColor(0);
    return i === chart.highlightIndex ? (own ?? seriesColor(0)) : MUTED_BAR;
  };
  const mark = (g: Element, i: number, attrs: Record<string, number>) => {
    const r = el('rect', { ...attrs, rx: 3, fill: fill(i), class: 'mdx-bar' }, g);
    if (i === chart.highlightIndex) r.setAttribute('data-highlight', 'true');
    tip(r, `${chart.bars[i]?.label ?? ''}: ${valueLabels[i] ?? ''}`);
  };

  if (chart.orientation === 'horizontal') {
    const row = 30;
    const h = chart.bars.length * row + 8;
    // A value sits beside its bar's far end: left of a negative bar, right of
    // any other, so each side keeps a gutter only when some bar needs it (the
    // right keeps a hair so an all-negative chart's bars stop short of the edge).
    const wantLeft = lo < 0 ? valueW : 0;
    const wantRight = values.some((v) => v >= 0) ? valueW : 4;
    // Too narrow for both gutters whole, they shrink alike; then row labels
    // give way. The plot keeps its floor, so no bar runs past the edge.
    const fit = Math.min(1, (w - MIN_LABEL_W - MIN_PLOT_W) / (wantLeft + wantRight));
    const leftValueW = wantLeft * fit;
    const rightValueW = wantRight * fit;
    const labelW = Math.max(
      MIN_LABEL_W,
      Math.min(
        Math.round(w * 0.38),
        Math.ceil(Math.max(...chart.bars.map((b) => b.label.length)) * CH) + 12,
        w - leftValueW - rightValueW - MIN_PLOT_W,
      ),
    );
    const pw = w - labelW - leftValueW - rightValueW;
    const sx = (v: number) => labelW + leftValueW + ((v - lo) / (hi - lo)) * pw;
    const svg = frame(w, h, 'bar');
    chart.bars.forEach((b, i) => {
      const g = el('g', { class: 'mdx-bar-row' }, svg);
      const y = 4 + i * row;
      text(g, clip(b.label, labelW - 12), {
        x: labelW - 10,
        y: y + row / 2 + 4,
        'text-anchor': 'end',
        class: 'mdx-bar-label',
      });
      const a = sx(Math.min(0, b.value));
      const z = sx(Math.max(0, b.value));
      mark(g, i, { x: a, y: y + 5, width: Math.max(1, z - a), height: row - 10 });
      text(g, valueLabels[i] ?? '', {
        x: b.value < 0 ? a - 6 : z + 6,
        y: y + row / 2 + 4,
        'text-anchor': b.value < 0 ? 'end' : 'start',
        class: i === chart.highlightIndex ? 'mdx-bar-value is-highlight' : 'mdx-bar-value',
      });
    });
    return svg;
  }

  const h = w < 520 ? 220 : 260;
  const top = 20;
  // A value under a negative bar sits below the plot, clear of the day labels.
  const bottom = lo < 0 ? 40 : 24;
  const ph = h - top - bottom;
  const slot = (w - 8) / chart.bars.length;
  const sy = (v: number) => top + ph - ((v - lo) / (hi - lo)) * ph;
  const svg = frame(w, h, 'bar');
  el('line', { x1: 4, x2: w - 4, y1: sy(0), y2: sy(0), class: 'mdx-baseline' }, svg);
  chart.bars.forEach((b, i) => {
    const g = el('g', { class: 'mdx-bar-row' }, svg);
    const cx = 4 + slot * (i + 0.5);
    const bw = Math.max(4, Math.min(56, slot * 0.64));
    const a = sy(Math.max(0, b.value));
    const z = sy(Math.min(0, b.value));
    mark(g, i, { x: cx - bw / 2, y: a, width: bw, height: Math.max(1, z - a) });
    text(g, valueLabels[i] ?? '', {
      x: cx,
      y: b.value < 0 ? z + 14 : a - 6,
      'text-anchor': 'middle',
      class: i === chart.highlightIndex ? 'mdx-bar-value is-highlight' : 'mdx-bar-value',
    });
    text(g, clip(b.label, slot - 4), {
      x: cx,
      y: h - 6,
      'text-anchor': 'middle',
      class: 'mdx-bar-label',
    });
  });
  return svg;
}

/** `s` cut with an ellipsis to fit about `px` pixels. */
function clip(s: string, px: number): string {
  const n = Math.max(1, Math.floor(px / CH));
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}
