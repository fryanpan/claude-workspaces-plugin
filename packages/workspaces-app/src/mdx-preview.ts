/**
 * What an `.mdx` block shows in place of its source: a component's `title` and
 * words, the chart its literal props describe (`mdx-chart.ts`, or for a
 * `<PlotChart>` `mdx-plot-chart.ts`, for a `<StreetMap>` `mdx-street-map.ts`),
 * a muted line
 * for a comment or the imports. A component's name shows only when it has
 * nothing else to show.
 *
 * The source is somebody's document text, so nothing here runs it. Props are
 * read by `@claude-workspaces/core/tag-props`, the literal parser the server
 * also reads a `<StreetMap src>` with, so the file the page asks for is the
 * file the server serves. Every string reaches the DOM through `textContent`.
 */

import { readOpenTag } from '@claude-workspaces/core/tag-props';
import { type MdxChart, chartOf, drawChart } from './mdx-chart.ts';
import { type PlotChartSummary, plotChartOf, renderPlotChart } from './mdx-plot-chart.ts';
import {
  type MapStateFor,
  type StreetMapSummary,
  renderStreetMap,
  streetMapOf,
} from './mdx-street-map.ts';

export type MdxKind = 'esm' | 'expr' | 'jsx';

export interface MdxSummary {
  kind: MdxKind;
  /** The line shown: a component's name, a comment's words, the imports. */
  label: string;
  /** A component's `title` prop, when it is a string literal. */
  title?: string;
  /** The chart its props describe, when they are literals of a chart's shape. */
  chart?: MdxChart;
  /** A `<PlotChart>`'s spec and the words around it. */
  plot?: PlotChartSummary;
  /** A `<StreetMap>`'s props and the words around it. */
  map?: StreetMapSummary;
  /** A component's children as plain words, tags removed. */
  children?: string;
  /** Why the opening tag could not be read, when it could not. */
  error?: string;
}

export function summarizeMdx(source: string): MdxSummary {
  const text = source.trim();
  if (/^(?:import|export)\b/.test(text)) {
    const names = [...text.matchAll(/^import\s+(.+?)\s+from\b/gm)].flatMap((m) =>
      (m[1] ?? '')
        .replace(/[{}*]/g, ' ')
        .split(/[\s,]+/)
        .filter(isImportName),
    );
    return {
      kind: 'esm',
      label: names.length > 0 ? `import ${names.join(', ')}` : (text.split('\n')[0] ?? ''),
    };
  }
  if (text.startsWith('{')) {
    const comment = text.match(/^\{\s*\/\*([\s\S]*?)\*\/\s*\}$/);
    return { kind: 'expr', label: (comment?.[1] ?? text).trim() };
  }
  const tag = readOpenTag(text);
  const name = tag.name || 'Fragment';
  const summary: MdxSummary = { kind: 'jsx', label: name };
  const { props, end: openEnd } = tag;
  if (openEnd < 0) summary.error = `<${name}> is not closed: a quote, a brace or the > is missing`;
  const title = props.get('title');
  if (typeof title === 'string') summary.title = title;
  if (name === 'PlotChart') summary.plot = plotChartOf(props);
  else if (name === 'StreetMap') summary.map = streetMapOf(props);
  else {
    const chart = chartOf(props);
    if (chart) summary.chart = chart;
  }
  const close = text.lastIndexOf(`</${name === 'Fragment' ? '' : name}>`);
  if (close > 0 && openEnd > 0 && close > openEnd) {
    const words = text
      .slice(openEnd, close)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (words) summary.children = words;
  }
  return summary;
}

function isImportName(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s) && s !== 'as' && s !== 'type';
}

// ---- DOM --------------------------------------------------------------------

/** Width a chart is drawn at when its block has not been laid out yet. */
const DEFAULT_WIDTH = 640;

/** Replace `host`'s children with the block's quiet view, a chart drawn
 *  `width` pixels wide (the host's own width when it has one). A
 *  `<StreetMap>` with an `id` reads its live state from `stateFor`. Returns
 *  the release for what the view mounted: the map, and its state hook. */
export function renderMdxSummary(
  host: HTMLElement,
  summary: MdxSummary,
  width?: number,
  stateFor?: MapStateFor,
): () => void {
  host.replaceChildren();
  host.dataset.kind = summary.kind;
  const head = document.createElement('div');
  head.className = 'mdx-head';
  // A component's name is source vocabulary, not what the post says, so it
  // shows only when the block would otherwise be empty.
  const bare =
    !summary.title && !summary.chart && !summary.plot && !summary.map && !summary.children;
  if (summary.kind !== 'jsx' || bare) {
    const label = document.createElement('span');
    label.className = summary.kind === 'jsx' ? 'mdx-name' : 'mdx-muted';
    label.textContent = summary.label;
    head.appendChild(label);
  }
  if (summary.title) {
    const title = document.createElement('span');
    title.className = 'mdx-title';
    title.textContent = summary.title;
    head.appendChild(title);
  }
  if (head.childElementCount > 0) host.appendChild(head);
  const { chart } = summary;
  // No legend: each line carries its own name at its end, inside the plot,
  // exactly as the published chart does.
  if (chart) {
    host.appendChild(drawChart(chart, width || host.clientWidth || DEFAULT_WIDTH));
    // A prop the drawing leaves out is named, so the reader never takes the
    // preview for the page when the two differ.
    note(host, 'mdx-chart-ignored', 'Preview ignores', chart.ignored);
    note(host, 'mdx-chart-site-ignores', 'The site draws nothing for', chart.siteIgnores);
  }
  if (summary.plot) renderPlotChart(host, summary.plot);
  const release = summary.map ? renderStreetMap(host, summary.map, stateFor) : () => {};
  if (summary.children) {
    const kids = document.createElement('div');
    kids.className = 'mdx-children';
    kids.textContent = summary.children;
    host.appendChild(kids);
  }
  return release;
}

function note(host: HTMLElement, className: string, lead: string, props: string[]): void {
  if (props.length === 0) return;
  const line = document.createElement('div');
  line.className = `mdx-chart-note ${className}`;
  line.textContent = `${lead}: ${props.join(', ')}`;
  host.appendChild(line);
}
