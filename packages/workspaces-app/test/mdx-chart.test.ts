import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { renderMdxSummary, summarizeMdx } from '../src/mdx-preview.ts';

/**
 * A chart component in a bound `.mdx` draws the chart the published site
 * draws: lines with axes, each line named at its own end inside the plot, a
 * band shading a stretch of x, an indexed chart's reference line, or labelled
 * bars. The fixtures are written the way posts write them — a tag over many lines or on one, an apostrophe in a
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
  band={{ from: 2, to: 3, label: "Planned capacity" }}
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
      band: { from: 2, to: 3, label: 'Planned capacity' },
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
  it('draws a line chart: title above, y ticks, one line per series, the band, x labels', () => {
    mount(`Crossings rose.\n\n${LINE}\n`);
    const view = views()[0];
    const svg = view?.querySelector('svg.mdx-chart[data-chart="line"]');
    expect(svg).not.toBeNull();
    // The title comes before the chart, and the name is not shown.
    expect(view?.firstElementChild?.querySelector('.mdx-title')?.textContent).toBe(
      "Riverbend's crossings × weekday – 2025",
    );
    expect(view?.querySelector('.mdx-name')).toBeNull();

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

    expect(texts(svg, '.mdx-band text')).toEqual(['Planned capacity']);
    expect(texts(svg, '.mdx-x-axis text')).toEqual(['Jan', 'Feb', 'Mar', 'Apr']);
    expect(texts(svg, '.mdx-axis-unit')).toEqual(['crossings']);
  });

  it('names each line at its own end inside the plot, in its colour, and shows no legend', () => {
    mount(`${LINE}\n`);
    const view = views()[0];
    const svg = view?.querySelector('svg.mdx-chart[data-chart="line"]');
    expect(view?.querySelector('.mdx-legend, .mdx-swatch')).toBeNull();

    const labels = [...(svg?.querySelectorAll('.mdx-end-label') ?? [])];
    expect(labels.map((l) => l.querySelector('tspan')?.textContent)).toEqual([
      'Harborlight route',
      'Saltmarsh route',
    ]);
    // Each carries its series' last value...
    expect(labels.map((l) => l.querySelectorAll('tspan')[1]?.textContent)).toEqual(['1.5k', '1k']);
    // ...wears that series' colour...
    const strokes = [...(svg?.querySelectorAll('.mdx-series polyline') ?? [])].map((l) =>
      l.getAttribute('stroke'),
    );
    expect(labels.map((l) => l.getAttribute('fill'))).toEqual(strokes);
    // ...and sits past the series' last point, inside the drawing.
    const lastX = Math.max(
      ...[...(svg?.querySelectorAll('.mdx-series polyline') ?? [])].flatMap((l) =>
        (l.getAttribute('points') ?? '').split(' ').map((p) => Number(p.split(',')[0])),
      ),
    );
    const width = Number(svg?.getAttribute('width'));
    for (const l of labels) {
      const x = Number(l.getAttribute('x'));
      expect(x).toBeGreaterThanOrEqual(lastX);
      expect(x).toBeLessThan(width);
    }
    // Two labels that would land on each other are pushed apart.
    const ys = labels.map((l) => Number(l.getAttribute('y'))).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBeGreaterThanOrEqual(14);
    }
  });

  it('keeps three crowded end labels apart, and ticks the x range every series reaches', () => {
    const near = (label: string, last: number) =>
      `{ label: "${label}", values: [{ x: 1, y: 10 }, { x: 2, y: ${last} }] }`;
    mount(
      `<LineChart series={[${near('Riverbend', 100)}, ${near('Harborlight', 101)}, ${near('Saltmarsh', 102)}]} />\n`,
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="line"]');
    const ys = [...(svg?.querySelectorAll('.mdx-end-label') ?? [])]
      .map((l) => Number(l.getAttribute('y')))
      .sort((a, b) => a - b);
    expect(ys).toHaveLength(3);
    for (let i = 1; i < ys.length; i++) {
      expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBeGreaterThanOrEqual(14);
    }
    // A short series that reaches past the first still gets ticks out there.
    mount(
      '<LineChart series={[{ label: "A", values: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }, { label: "B", values: [{ x: 1, y: 1 }, { x: 9, y: 3 }] }]} />\n',
    );
    expect(texts(views()[1], '.mdx-x-axis text')).toContain('9');
  });

  it('draws the band as a stretch of x over the whole plot, and keeps it out of the y axis', () => {
    mount(`${LINE}\n\n${LINE.replace(/\s*band=\{\{[^}]*\}\}\n/, '\n')}\n`);
    const [withBand, without] = views().map((v) =>
      v.querySelector('svg.mdx-chart[data-chart="line"]'),
    );
    // A band says nothing about y, so the axis reads the same either way.
    expect(texts(withBand, '.mdx-grid text')).toEqual(texts(without, '.mdx-grid text'));
    expect(without?.querySelector('.mdx-band')).toBeNull();

    const band = withBand?.querySelector('.mdx-band rect');
    const tickX = (label: string) =>
      Number(
        [...(withBand?.querySelectorAll('.mdx-x-axis text') ?? [])]
          .find((t) => t.textContent === label)
          ?.getAttribute('x'),
      );
    // It runs from its `from` tick to its `to` tick — Feb to Mar, not a y range.
    const left = Number(band?.getAttribute('x'));
    const right = left + Number(band?.getAttribute('width'));
    expect(Math.abs(left - tickX('Feb'))).toBeLessThan(1);
    expect(Math.abs(right - tickX('Mar'))).toBeLessThan(1);
    // ...and covers the plot's full height: every gridline crosses it.
    const top = Number(band?.getAttribute('y'));
    const bottom = top + Number(band?.getAttribute('height'));
    const gridYs = [...(withBand?.querySelectorAll('.mdx-grid line') ?? [])].map((l) =>
      Number(l.getAttribute('y1')),
    );
    expect(gridYs.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...gridYs)).toBeGreaterThanOrEqual(top);
    expect(Math.max(...gridYs)).toBeLessThanOrEqual(bottom);
    expect(bottom - top).toBeGreaterThan(100);
  });

  it("marks an indexed chart's reference line on the plot, with its label and a tick", () => {
    mount(
      '<LineChart baseline={100} baselineLabel="1931 = 100" series={[{ label: "GDP", values: [{ x: 1931, y: 100 }, { x: 1971, y: 247 }, { x: 2011, y: 515 }] }]} />\n',
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="line"]');
    const rule = svg?.querySelector('.mdx-baseline line');
    expect(rule).not.toBeNull();
    expect(texts(svg, '.mdx-baseline-label')).toEqual(['1931 = 100']);
    // The rule sits where the y axis says 100 does.
    const gridY = (label: string) =>
      Number(
        [...(svg?.querySelectorAll('.mdx-grid text') ?? [])]
          .find((t) => t.textContent === label)
          ?.getAttribute('y'),
      );
    expect(texts(svg, '.mdx-grid text')).toContain('100');
    expect(Math.abs(Number(rule?.getAttribute('y1')) - (gridY('100') - 4))).toBeLessThan(1);
    // A chart with no baseline draws no rule.
    mount('<LineChart series={[{ label: "GDP", values: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }]} />\n');
    expect(views()[1]?.querySelector('.mdx-baseline')).toBeNull();
  });

  it('ticks a short series at its own x values, and writes a year without a separator', () => {
    mount(
      '<LineChart series={[{ label: "Wages", values: [{ x: 1931, y: 48 }, { x: 1971, y: 41 }, { x: 2011, y: 35 }] }]} />\n',
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="line"]');
    expect(texts(svg, '.mdx-x-axis text')).toEqual(['1931', '1971', '2011']);
  });

  it('draws at the width the component asked for, whatever the column is', () => {
    const host = document.createElement('div');
    const at = (src: string, given: number) => {
      renderMdxSummary(host, summarizeMdx(src), given);
      return host.querySelector('svg');
    };
    const sized = at('<LineChart width={500} data={[{ x: 0, y: 1 }, { x: 1, y: 3 }]} />', 900);
    expect(sized?.getAttribute('width')).toBe('500');
    expect(sized?.getAttribute('viewBox')?.split(' ')[2]).toBe('500');
    // Without one, the column's width still decides.
    const fluid = at('<LineChart data={[{ x: 0, y: 1 }, { x: 1, y: 3 }]} />', 900);
    expect(fluid?.getAttribute('width')).toBe('900');
    // A bar chart reads it the same way.
    const bars = at('<Chart width={500} data={[{ label: "North", value: 3 }]} />', 900);
    expect(bars?.getAttribute('width')).toBe('500');
  });

  it('draws single-line self-closing tags with spaces inside every brace', () => {
    mount(
      `Before.\n\n<LineChart title="Riverbend's crossings" series={ [ { label: "A", values: [ { x: 0, y: 1 }, { x: 1, y: 3 }, ] }, { label: "B", dashed: true, values: [ { x: 0, y: 2 }, { x: 1, y: 2 } ] }, ] } band={ { from: 0, to: 1, label: "Target" } } xTickLabels={ { 0: "Mon", 1: "Tue" } } zeroBaseline={ false } />\n\n<Chart type="bar" orientation="horizontal" data={ [ { label: "North", value: 3 }, { label: "South", value: 5 }, ] } highlightIndex={ 1 } />\n\nAfter.\n`,
    );
    const [line, bars] = views();
    const svg = line?.querySelector('svg.mdx-chart[data-chart="line"]');
    expect(svg?.querySelectorAll('.mdx-series polyline')).toHaveLength(2);
    expect(texts(svg, '.mdx-x-axis text')).toEqual(['Mon', 'Tue']);
    expect(texts(svg, '.mdx-band text')).toEqual(['Target']);
    expect(
      [...(svg?.querySelectorAll('.mdx-end-label') ?? [])].map(
        (l) => l.querySelector('tspan')?.textContent,
      ),
    ).toEqual(['A', 'B']);
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

  it("puts a negative horizontal bar's value beside its negative end, clear of its label", () => {
    mount(
      '<Chart orientation="horizontal" data={[{ label: "Riverbend", value: 6 }, { label: "Saltmarsh", value: -4 }]} />\n',
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="bar"]');
    const num = (e: Element | undefined, a: string) => Number(e?.getAttribute(a));
    const [upBar, downBar] = [...(svg?.querySelectorAll('rect.mdx-bar') ?? [])];
    const [upValue, downValue] = [...(svg?.querySelectorAll('.mdx-bar-value') ?? [])];
    const downLabel = svg?.querySelectorAll('.mdx-bar-label')[1];
    expect(downValue?.textContent).toBe('-4');
    // The positive value starts past its bar's right end...
    expect(upValue?.getAttribute('text-anchor') ?? 'start').toBe('start');
    expect(num(upValue, 'x')).toBeGreaterThan(num(upBar, 'x') + num(upBar, 'width'));
    // ...and the negative one ends before its bar's left end, where the bar stops.
    expect(downValue?.getAttribute('text-anchor')).toBe('end');
    expect(num(downValue, 'x')).toBeLessThan(num(downBar, 'x'));
    expect(num(downValue, 'x')).toBeGreaterThan(num(downBar, 'x') - 12);
    // Its two glyphs (about 7px each) still end right of the row's label.
    expect(num(downValue, 'x') - 2 * 7).toBeGreaterThan(num(downLabel, 'x'));
  });

  it('keeps every bar of a narrow horizontal chart inside it, and an all-negative one uses its width', () => {
    const row = (label: string, value: number) => `{ label: "${label}", value: ${value} }`;
    const chart = (unit: string, ...rows: string[]) =>
      `<Chart orientation="horizontal" unit="${unit}" data={[${rows.join(', ')}]} />`;
    const allNegative = chart('crossings', row('Saltmarsh landing', -12000), row('Kiln wharf', -3));
    // Value labels too long for a gutter on each side of a 240px chart.
    const mixed = chart(
      'passenger crossings',
      row('Saltmarsh landing', -12000),
      row('Riverbend pier', 18000),
    );
    for (const [src, width] of [240, 300, 430].flatMap((w) => [
      [allNegative, w] as const,
      [mixed, w] as const,
    ])) {
      const host = document.createElement('div');
      renderMdxSummary(host, summarizeMdx(src), width);
      const bars = [...host.querySelectorAll('rect.mdx-bar')].map((r) => {
        const x = Number(r.getAttribute('x'));
        return { left: x, right: x + Number(r.getAttribute('width')) };
      });
      expect(bars).toHaveLength(2);
      for (const bar of bars) {
        expect(bar.left).toBeGreaterThanOrEqual(0);
        expect(bar.right).toBeLessThanOrEqual(width);
      }
      // ...and the bars still span enough room to tell a long one from a short one.
      const span = Math.max(...bars.map((b) => b.right)) - Math.min(...bars.map((b) => b.left));
      expect(span).toBeGreaterThanOrEqual(40);
      // No value sits right of an all-negative chart, so its bars reach the edge.
      if (src === allNegative) {
        expect(Math.max(...bars.map((b) => b.right))).toBeGreaterThan(width - 8);
      }
    }
  });

  it('draws a visible dot for each series that has only one point', () => {
    mount(
      '<LineChart series={[{ label: "Riverbend", values: [{ x: 1, y: 3 }] }, { label: "Kiln", values: [{ x: 2, y: 5 }] }]} />\n',
    );
    const svg = views()[0]?.querySelector('svg.mdx-chart[data-chart="line"]');
    const groups = [...(svg?.querySelectorAll('.mdx-series') ?? [])];
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      const marker = g.querySelector('circle.mdx-marker');
      expect(marker).not.toBeNull();
      expect(Number(marker?.getAttribute('r'))).toBeGreaterThan(0);
      expect(marker?.getAttribute('fill')).toBe(
        g.querySelector('polyline')?.getAttribute('stroke'),
      );
    }
    // A chart of one series with one point draws that dot too, not just its name.
    mount('<LineChart title="Kiln" data={[{ x: 4, y: 9 }]} />\n');
    expect(views()[1]?.querySelectorAll('svg.mdx-chart circle.mdx-marker')).toHaveLength(1);
    expect(views()[1]?.querySelector('.mdx-name')).toBeNull();
    // ...in the middle of the plot, not against its y axis.
    const axis = views()[1]?.querySelector('.mdx-x-axis line');
    const cx = Number(views()[1]?.querySelector('circle.mdx-marker')?.getAttribute('cx'));
    const mid = (Number(axis?.getAttribute('x1')) + Number(axis?.getAttribute('x2'))) / 2;
    expect(Math.abs(cx - mid)).toBeLessThan(1);
    // A series with a line to draw keeps its line and gets no dot.
    mount(`${LINE}\n`);
    expect(views()[2]?.querySelectorAll('circle.mdx-marker')).toHaveLength(0);
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
    expect(texts(page, '.mdx-end-label tspan')[0]).toContain('<img src=x onerror=alert(1)');
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
