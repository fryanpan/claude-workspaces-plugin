/**
 * A `<PlotChart>` in a bound `.mdx`: an Observable Plot chart drawn from the
 * component's literal props by `buildPlot` (core `plot-spec.mjs`, the copy
 * other repos take verbatim), with its `subtitle` and `note` as text around it.
 *
 * Plot and `buildPlot` are fetched the first time a doc shows a
 * `<PlotChart>`, never before.
 * Not an `import('@observablehq/plot')`: the doc bundle was built with
 * splitting off when this was written, which inlined a dynamic import into
 * every page load. `scripts/build.ts` builds `plot-entry.ts` to `/app/plot/plot.js`
 * and this module asks for that URL by value, as `math-katex.ts` does.
 *
 * A spec that names anything outside the allowlists, or a prop that is not a
 * literal, draws an error box in the chart's place and calls no Plot function.
 */

import { type PlotSpec, plotHeight } from '@claude-workspaces/core/plot-spec';
import { UNREADABLE } from './mdx-chart-props.ts';
import type { renderPlotInto } from './plot-entry.ts';

/** What `/app/plot/plot.js` exports. */
export interface PlotChunk {
  renderPlotInto: typeof renderPlotInto;
}

/** Where the build puts Plot. */
export const PLOT_URL = '/app/plot/plot.js';

export interface PlotChartSummary {
  subtitle?: string;
  note?: string;
  data?: unknown;
  options?: unknown;
  marks?: unknown;
  preset?: unknown;
  /** The props that were not literals, so the box can name them. */
  unreadable: string[];
}

const SPEC_PROPS = ['data', 'options', 'marks', 'preset'] as const;

/** The `<PlotChart>` props, as the literal parser read them. */
export function plotChartOf(props: Map<string, unknown>): PlotChartSummary {
  const out: PlotChartSummary = { unreadable: [] };
  const subtitle = props.get('subtitle');
  if (typeof subtitle === 'string') out.subtitle = subtitle;
  const note = props.get('note');
  if (typeof note === 'string') out.note = note;
  for (const key of SPEC_PROPS) {
    const v = props.get(key);
    if (v === UNREADABLE) out.unreadable.push(key);
    else if (v !== undefined) out[key] = v;
  }
  return out;
}

let ready: PlotChunk | null = null;
let loading: Promise<PlotChunk | null> | null = null;

function fetchFromApp(): Promise<PlotChunk | null> {
  // Built at runtime so the bundler cannot fold it into a literal it might
  // try to resolve and inline.
  const url = new URL(PLOT_URL, location.href).href;
  return (import(url) as Promise<PlotChunk>).then(
    (m) => m,
    () => null,
  );
}

let fetchPlot: () => Promise<PlotChunk | null> = fetchFromApp;

/** How a test swaps in its own Plot, or its own fetch of one. The page never
 *  calls it. */
export function setPlotForTest(
  api: PlotChunk | null,
  fetcher: (() => Promise<PlotChunk | null>) | null = null,
): void {
  ready = api;
  loading = api ? Promise.resolve(api) : null;
  fetchPlot = fetcher ?? fetchFromApp;
}

/** Plot, fetching it the first time. Null when the fetch fails; a later call
 *  tries again. */
export function loadPlot(): Promise<PlotChunk | null> {
  if (loading) return loading;
  const pending = fetchPlot().then((api) => {
    if (api) ready = api;
    else if (loading === pending) loading = null;
    return api;
  });
  loading = pending;
  return pending;
}

/** The box `renderPlot` draws for a spec it refuses, for a prop it never saw. */
function errorBox(slot: HTMLElement, message: string): void {
  const box = document.createElement('div');
  box.className = 'plot-spec-error';
  box.setAttribute('role', 'alert');
  box.textContent = message;
  slot.style.removeProperty('height');
  slot.replaceChildren(box);
}

const specOf = (chart: PlotChartSummary): PlotSpec => ({
  data: chart.data as Record<string, unknown> | undefined,
  options: chart.options as Record<string, unknown> | undefined,
  marks: chart.marks,
  preset: chart.preset,
});

function draw(chunk: PlotChunk, slot: HTMLElement, chart: PlotChartSummary): void {
  if (chart.unreadable.length > 0) {
    errorBox(slot, `Not a literal, so not drawn: ${chart.unreadable.join(', ')}`);
    return;
  }
  chunk.renderPlotInto(slot, specOf(chart));
}

/** Append the chart, its subtitle above and its note below, to `host`. The
 *  slot is the chart's height from the start, so the doc does not move when
 *  Plot arrives; `renderPlot` keeps that height and follows the width. */
export function renderPlotChart(host: HTMLElement, chart: PlotChartSummary): void {
  if (chart.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'mdx-subtitle';
    sub.textContent = chart.subtitle;
    host.appendChild(sub);
  }
  const slot = document.createElement('div');
  slot.className = 'mdx-plot';
  // A tap on the chart moves its tip; it does not open the source. A tap on
  // an error box still does, since the source is what the reader fixes.
  slot.addEventListener('click', (e) => {
    if (slot.querySelector('svg')) e.stopPropagation();
  });
  slot.style.height = `${plotHeight(specOf(chart))}px`;
  host.appendChild(slot);
  if (chart.note) {
    const note = document.createElement('div');
    note.className = 'mdx-chart-note mdx-plot-note';
    note.textContent = chart.note;
    host.appendChild(note);
  }
  if (ready) {
    draw(ready, slot, chart);
    return;
  }
  slot.classList.add('is-pending');
  void loadPlot().then((chunk) => {
    // Re-rendered while the fetch was in flight: that render won.
    if (!slot.isConnected) return;
    slot.classList.remove('is-pending');
    if (chunk) draw(chunk, slot, chart);
    else errorBox(slot, 'Plot could not be loaded');
  });
}
