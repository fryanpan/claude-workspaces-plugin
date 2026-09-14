import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { renderMdxSummary, summarizeMdx } from '../src/mdx-preview.ts';

/**
 * A chart component in a bound `.mdx` draws its chart: lines with axes, a
 * legend and a shaded band, or labelled bars. The fixtures are written the
 * way posts write them — a tag over many lines or on one, an apostrophe in a
 * title, bare and numeric keys, trailing commas, `{{ }}` objects, spaces in
 * braces, non-ASCII — and every name and number in them is made up.
 */

const LINE = `<LineChart
  title="Riverbend's crossings × weekday – 2025"
  unit="crossings"
  series={[
    {
      label: "Harborlight route",
      values: [
        { x: 1, y: 1200 },
        { x: 2, y: 1350 },
        { x: 3, y: 1280, },
        { x: 4, y: 1510 },
      ],
    },
    {
      label: 'Saltmarsh route',
      dashed: true,
      values: [ { x: 1, y: 800 }, { x: 2, y: 950 }, { x: 3, y: 900 }, { x: 4, y: 1020 }, ],
    },
  ]}
  band={{ from: 1000, to: 1300, label: "Planned capacity" }}
  xTickLabels={{ 1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr" }}
  zeroBaseline={false}
  yTickFormat="thousands"
/>`;

const ONE_LINE = `<LineChart title="Riverbend's crossings" series={[ { label: "A", values: [ { x: 0, y: 1 }, { x: 1, y: 3 }, ] }, ]} band={{ from: 1, to: 2 }} xTickLabels={{ 0: "Mon", 1: "Tue" }} />`;

const BARS = (orientation: string) => `<Chart
  type="bar"
  orientation="${orientation}"
  title="Riders by pier"
  unit="%"
  data={[
    { label: "North pier", value: 42 },
    { label: "South pier", value: 31, color: "#0b7285" },
    { label: "Ferry slip", value: 17, color: "url(https://example.invalid/x)" },
  ]}
  highlightIndex={1}
/>`;

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md: string): EditorHandle {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: true });
  open.push(() => handle.destroy());
  return handle;
}

const views = () => [
  ...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-block .mdx-view'),
];
const texts = (root: Element | null | undefined, sel: string) =>
  [...(root?.querySelectorAll(sel) ?? [])].map((t) => t.textContent);

describe('reading a chart written the way posts write it', () => {
  it("reads a line chart's series values, band, unit and numeric-keyed tick labels", () => {
    const s = summarizeMdx(LINE);
    expect(s.title).toBe("Riverbend's crossings × weekday – 2025");
    expect(s.chart).toEqual({
      type: 'line',
      series: [
        {
          label: 'Harborlight route',
          dashed: false,
          points: [
            { x: 1, y: 1200 },
            { x: 2, y: 1350 },
            { x: 3, y: 1280 },
            { x: 4, y: 1510 },
          ],
        },
        {
          label: 'Saltmarsh route',
          dashed: true,
          points: [
            { x: 1, y: 800 },
            { x: 2, y: 950 },
            { x: 3, y: 900 },
            { x: 4, y: 1020 },
          ],
        },
      ],
      unit: 'crossings',
      band: { from: 1000, to: 1300, label: 'Planned capacity' },
      zeroBaseline: false,
      yTickFormat: 'thousands',
      xTickLabels: [
        { x: 1, label: 'Jan' },
        { x: 2, label: 'Feb' },
        { x: 3, label: 'Mar' },
        { x: 4, label: 'Apr' },
      ],
    });
  });

  it('reads the same chart written on one line with spaces inside its braces', () => {
    const s = summarizeMdx(ONE_LINE);
    expect(s.title).toBe("Riverbend's crossings");
    expect(s.chart?.type === 'line' && s.chart.series[0]?.points).toHaveLength(2);
    expect(s.chart?.type === 'line' && s.chart.band).toEqual({ from: 1, to: 2 });
    expect(s.chart?.type === 'line' && s.chart.xTickLabels?.map((t) => t.label)).toEqual([
      'Mon',
      'Tue',
    ]);
  });

  it("reads a bar chart's rows, orientation and highlight, and keeps only a plain colour", () => {
    expect(summarizeMdx(BARS('horizontal')).chart).toEqual({
      type: 'bar',
      orientation: 'horizontal',
      unit: '%',
      highlightIndex: 1,
      bars: [
        { label: 'North pier', value: 42 },
        { label: 'South pier', value: 31, color: '#0b7285' },
        { label: 'Ferry slip', value: 17 },
      ],
    });
  });

  it('reads no chart from props that are not literals of a chart shape', () => {
    expect(summarizeMdx('<LineChart title="Riders" series={rows} />').chart).toBeUndefined();
    expect(summarizeMdx('<Chart data={[{ label: "A", value: n }]} />').chart).toBeUndefined();
    expect(summarizeMdx('<Callout type="note">Words</Callout>').chart).toBeUndefined();
  });
});

describe('a chart block on the doc page', () => {
  it('draws a line chart: title above, legend, y ticks, one line per series, the band, x labels', () => {
    mount(`Crossings rose.\n\n${LINE}\n`);
    const view = views()[0];
    const svg = view?.querySelector('svg.mdx-chart[data-chart="line"]');
    expect(svg).not.toBeNull();
    // The title comes before the chart, and the name is not shown.
    expect(view?.firstElementChild?.querySelector('.mdx-title')?.textContent).toBe(
      "Riverbend's crossings × weekday – 2025",
    );
    expect(view?.querySelector('.mdx-name')).toBeNull();
    expect(texts(view, '.mdx-legend-item')).toEqual(['Harborlight route', 'Saltmarsh route']);
    expect(view?.querySelectorAll('.mdx-legend .mdx-swatch.is-dashed')).toHaveLength(1);

    const yTicks = texts(svg, '.mdx-grid text');
    expect(yTicks.length).toBeGreaterThanOrEqual(3);
    expect(yTicks.every((t) => /^\d+(\.\d)?k$|^\d+$/.test(t ?? ''))).toBe(true);
    expect(yTicks).toContain('1k');
    // zeroBaseline={false}: the axis does not start at 0.
    expect(yTicks).not.toContain('0');

    const lines = [...(svg?.querySelectorAll('.mdx-series polyline') ?? [])];
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.getAttribute('points')?.split(' ').length)).toEqual([4, 4]);
    expect(lines.map((l) => l.hasAttribute('stroke-dasharray'))).toEqual([false, true]);
    expect(new Set(lines.map((l) => l.getAttribute('stroke'))).size).toBe(2);

    const band = svg?.querySelector('.mdx-band rect');
    expect(Number(band?.getAttribute('height'))).toBeGreaterThan(10);
    expect(texts(svg, '.mdx-band text')).toEqual(['Planned capacity']);
    expect(texts(svg, '.mdx-x-axis text')).toEqual(['Jan', 'Feb', 'Mar', 'Apr']);
    expect(texts(svg, '.mdx-axis-unit')).toEqual(['crossings']);
  });

  it('draws single-line self-closing tags with spaces inside every brace', () => {
    mount(
      `Before.\n\n<LineChart title="Riverbend's crossings" series={ [ { label: "A", values: [ { x: 0, y: 1 }, { x: 1, y: 3 }, ] }, { label: "B", dashed: true, values: [ { x: 0, y: 2 }, { x: 1, y: 2 } ] }, ] } band={ { from: 1, to: 2, label: "Target" } } xTickLabels={ { 0: "Mon", 1: "Tue" } } zeroBaseline={ false } />\n\n<Chart type="bar" orientation="horizontal" data={ [ { label: "North", value: 3 }, { label: "South", value: 5 }, ] } highlightIndex={ 1 } />\n\nAfter.\n`,
    );
    const [line, bars] = views();
    const svg = line?.querySelector('svg.mdx-chart[data-chart="line"]');
    expect(svg?.querySelectorAll('.mdx-series polyline')).toHaveLength(2);
    expect(texts(svg, '.mdx-x-axis text')).toEqual(['Mon', 'Tue']);
    expect(texts(svg, '.mdx-band text')).toEqual(['Target']);
    expect(texts(line, '.mdx-legend-item')).toEqual(['A', 'B']);
    const bar = bars?.querySelector('svg.mdx-chart[data-chart="bar"]');
    expect(texts(bar, '.mdx-bar-label')).toEqual(['North', 'South']);
    expect(
      [...(bar?.querySelectorAll('rect.mdx-bar') ?? [])].map((r) =>
        r.getAttribute('data-highlight'),
      ),
    ).toEqual([null, 'true']);
  });

  it('includes zero on the y axis by default', () => {
    mount(`${LINE.replace('  zeroBaseline={false}\n', '')}\n`);
    expect(texts(views()[0], '.mdx-grid text')).toContain('0');
  });

  for (const orientation of ['horizontal', 'vertical']) {
    it(`draws ${orientation} bars with labels, values and the highlighted bar`, () => {
      mount(`${BARS(orientation)}\n`);
      const svg = views()[0]?.querySelector(`svg.mdx-chart[data-chart="bar"]`);
      const bars = [...(svg?.querySelectorAll('rect.mdx-bar') ?? [])];
      expect(bars).toHaveLength(3);
      expect(texts(svg, '.mdx-bar-label')).toEqual(['North pier', 'South pier', 'Ferry slip']);
      expect(texts(svg, '.mdx-bar-value')).toEqual(['42%', '31%', '17%']);
      expect(bars.map((b) => b.getAttribute('data-highlight'))).toEqual([null, 'true', null]);
      expect(texts(svg, '.mdx-bar-value.is-highlight')).toEqual(['31%']);
      // The highlighted bar keeps its own colour; the others step back alike.
      const fills = bars.map((b) => b.getAttribute('fill'));
      expect(fills[1]).toBe('#0b7285');
      expect(fills[0]).toBe(fills[2]);
      expect(fills[0]).not.toBe(fills[1]);
      // ...and step back from the colour they wear with nothing highlighted.
      mount(`${BARS(orientation).replace('  highlightIndex={1}\n', '')}\n`);
      const plain = views()[1]?.querySelector('rect.mdx-bar')?.getAttribute('fill');
      expect(plain).toBeTruthy();
      expect(fills[0]).not.toBe(plain);
      // Longer bars for larger values, along the chart's own axis.
      const size = orientation === 'horizontal' ? 'width' : 'height';
      const lengths = bars.map((b) => Number(b.getAttribute(size)));
      expect(lengths[0]).toBeGreaterThan(lengths[1] ?? 0);
      expect(lengths[1]).toBeGreaterThan(lengths[2] ?? 0);
    });
  }

  it("keeps a negative bar's value clear of its label", () => {
    mount('<Chart data={[{ label: "Up", value: 5 }, { label: "Down", value: -4 }]} />\n');
    const svg = views()[0]?.querySelector('svg.mdx-chart');
    const value = svg?.querySelectorAll('.mdx-bar-value')[1];
    const label = svg?.querySelectorAll('.mdx-bar-label')[1];
    expect(value?.textContent).toBe('-4');
    // Baselines at least one 12px line apart.
    expect(
      Number(label?.getAttribute('y')) - Number(value?.getAttribute('y')),
    ).toBeGreaterThanOrEqual(14);
  });

  it('shows a component that is not a chart as before, and an unreadable chart by name', () => {
    mount(
      '<Callout type="note">\n  Last sailing at 21:30.\n</Callout>\n\n<LineChart series={rows} />\n',
    );
    expect(views().map((v) => v.textContent)).toEqual(['Last sailing at 21:30.', 'LineChart']);
    expect(document.querySelector('.mdx-chart')).toBeNull();
  });

  it('puts markup in labels on the page as text and draws no colour that loads a URL', () => {
    mount(
      `<LineChart series={[{ label: "<img src=x onerror=alert(1)>", values: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }]} xTickLabels={{ 0: "<b>Mon</b>" }} />\n\n${BARS('horizontal')}\n`,
    );
    const page = document.querySelector('.ProseMirror');
    expect(page?.querySelector('.mdx-view img, .mdx-view b')).toBeNull();
    expect(texts(page, '.mdx-legend-item')).toEqual(['<img src=x onerror=alert(1)>']);
    expect(texts(page, '.mdx-x-axis text')).toContain('<b>Mon</b>');
    const fills = [...(page?.querySelectorAll('rect.mdx-bar') ?? [])].map((b) =>
      b.getAttribute('fill'),
    );
    expect(fills.some((f) => f?.includes('url('))).toBe(false);
  });

  it('draws at the width it is given, one unit per pixel, and thins crowded x labels', () => {
    const many = `<LineChart series={[{ label: "A", values: [${Array.from(
      { length: 12 },
      (_, i) => `{ x: ${i}, y: ${i * 3} }`,
    ).join(', ')}] }]} xTickLabels={{ ${Array.from(
      { length: 12 },
      (_, i) => `${i}: "Month ${i + 1}"`,
    ).join(', ')} }} />`;
    const host = document.createElement('div');
    renderMdxSummary(host, summarizeMdx(many), 400);
    const narrow = host.querySelector('svg');
    expect(narrow?.getAttribute('viewBox')?.split(' ')[2]).toBe('400');
    const shown = texts(narrow, '.mdx-x-axis text');
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(12);

    renderMdxSummary(host, summarizeMdx(many), 1100);
    expect(texts(host.querySelector('svg'), '.mdx-x-axis text')).toHaveLength(12);
  });
});
