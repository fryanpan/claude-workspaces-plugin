import { buildPlot } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import { measured } from './fixtures/chrome-glyph-widths.ts';

/**
 * A chart whose x is years ticks whole years, each once, with no two labels
 * touching; and a lines chart's baseline label sits where no line, end dot or
 * end label is. Both read off the SVG real Plot draws.
 */

type Spec = Parameters<typeof buildPlot>[1];
type Pt = [number, number];
type Box = { text: string; a: number; b: number; top: number; bottom: number };

/** Chrome's box for one 13px line of the house font is about 16px tall. */
const LINE_BOX = 16;

const at = (spec: Spec, width: number) => buildPlot(Plot, spec, { width }) as SVGSVGElement;

const translate = (el: Element | null): Pt => {
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el?.getAttribute('transform') ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

/** The x tick labels, left to right, each with its box on x. */
const xTicks = (svg: Element) => {
  const g = svg.querySelector('[aria-label="x-axis tick label"]');
  const [gx] = translate(g);
  return [...(g?.querySelectorAll('text') ?? [])].map((t) => {
    const text = t.textContent ?? '';
    const x = translate(t)[0] + gx;
    return { text, a: x - measured(text) / 2, b: x + measured(text) / 2 };
  });
};

/** Every text label's box, at Chrome's measured glyph widths. */
const boxes = (svg: Element): Box[] =>
  [...svg.querySelectorAll('[aria-label="text"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('text')].map((t) => {
      const [x, y] = translate(t);
      const text = t.textContent ?? '';
      const lines = Math.max(1, t.querySelectorAll('tspan').length);
      const a = x + dx;
      const mid = y + dy;
      return {
        text,
        a,
        b: a + measured(text),
        top: mid - LINE_BOX / 2,
        bottom: mid + lines * LINE_BOX - LINE_BOX / 2,
      };
    });
  });

/** Each drawn line as its points, from Plot's "M…L…" paths. */
const linePoints = (svg: Element): Pt[][] =>
  [...svg.querySelectorAll('[aria-label="line"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('path')].map((p) =>
      [...(p.getAttribute('d') ?? '').matchAll(/[ML]([-\d.]+),([-\d.]+)/g)].map(
        (m) => [Number(m[1]) + dx, Number(m[2]) + dy] as Pt,
      ),
    );
  });

/** The end dots' centres. */
const dots = (svg: Element): Pt[] =>
  [...svg.querySelectorAll('[aria-label="dot"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('circle')].map(
      (c) => [Number(c.getAttribute('cx')) + dx, Number(c.getAttribute('cy')) + dy] as Pt,
    );
  });

/** Whether the segment from p to q passes through the box. */
const crosses = (box: Box, [p, q]: [Pt, Pt]) => {
  for (let k = 0; k <= 50; k++) {
    const x = p[0] + ((q[0] - p[0]) * k) / 50;
    const y = p[1] + ((q[1] - p[1]) * k) / 50;
    if (x >= box.a && x <= box.b && y >= box.top && y <= box.bottom) return true;
  }
  return false;
};

const touch = (m: Box, n: Box) => m.a < n.b && n.a < m.b && m.top < n.bottom && n.top < m.bottom;

const index = (from: number, years: number, rates: Record<string, number>) =>
  Array.from({ length: years }, (_, i) =>
    Object.entries(rates).map(([who, r]) => ({ year: from + i, who, v: 1 + r * i })),
  ).flat();

/** The peer's chart: two index series from 2020, the plan dashed. */
const REPRO = {
  data: { rows: index(2020, 6, { Riverbend: 0.2, Plan: 0.3 }) },
  preset: {
    type: 'lines',
    data: 'rows',
    x: 'year',
    y: 'v',
    series: 'who',
    dashed: ['Plan'],
    baseline: { value: 1, label: '2020 = 1' },
  },
} as Spec;

const withRows = (spec: Spec, rows: unknown[]) => ({ ...spec, data: { rows } }) as Spec;

const stacked = (from: number, to: number) =>
  ({
    data: {
      rows: Array.from({ length: to - from + 1 }, (_, i) => [
        { year: from + i, mode: 'Walking', n: 10 + i },
        { year: from + i, mode: 'Biking', n: 4 + i },
      ]).flat(),
    },
    preset: { type: 'stackedArea', data: 'rows', x: 'year', y: 'n', series: 'mode' },
  }) as Spec;

/** The x ticks are whole years, each once, rising, no two labels touching. */
function expectWholeYears(svg: Element) {
  const ticks = xTicks(svg);
  expect(ticks.length).toBeGreaterThan(1);
  const years = ticks.map((t) => t.text);
  for (const y of years) expect(y).toMatch(/^\d{4}$/);
  expect(new Set(years).size).toBe(years.length);
  const ns = years.map(Number);
  expect([...ns].sort((a, b) => a - b)).toEqual(ns);
  for (let i = 1; i < ticks.length; i++) {
    expect(ticks[i]?.a ?? 0).toBeGreaterThan(ticks[i - 1]?.b ?? 0);
  }
}

describe('year ticks', () => {
  // Plot's own ticks for these six years go to half-years once the plot is
  // about 570px wide: from 712px with these end labels, and at 793px, the
  // width an iPad in landscape draws a doc's chart.
  it.each([704, 712, 793])('ticks each year once on the peer’s lines chart at %ipx', (w) => {
    const svg = at(REPRO, w);
    expectWholeYears(svg);
    expect(xTicks(svg).map((t) => t.text)).toEqual([
      '2020',
      '2021',
      '2022',
      '2023',
      '2024',
      '2025',
    ]);
  });

  it.each([430, 704, 1180])('ticks whole years for lines and stackedArea at %ipx', (w) => {
    expectWholeYears(at(REPRO, w));
    expectWholeYears(at(stacked(2018, 2026), w));
  });

  it.each([430, 704, 1180])('thins a twenty-year range to whole years at %ipx', (w) => {
    const long = withRows(REPRO, index(2005, 21, { Riverbend: 0.05, Plan: 0.08 }));
    expectWholeYears(at(long, w));
    expectWholeYears(at(stacked(2005, 2025), w));
  });

  it('ticks whole years in the marks form too', () => {
    const spec = {
      data: { rows: index(2020, 6, { Riverbend: 0.2 }) },
      marks: [{ mark: 'lineY', data: 'rows', options: { x: 'year', y: 'v' } }],
    } as Spec;
    expectWholeYears(at(spec, 1180));
  });

  it('keeps a spec’s own ticks and interval', () => {
    const own = (x: Record<string, unknown>) =>
      ({
        data: { rows: index(2020, 6, { Riverbend: 0.2 }) },
        options: { x },
        marks: [{ mark: 'lineY', data: 'rows', options: { x: 'year', y: 'v' } }],
      }) as Spec;
    expect(xTicks(at(own({ ticks: [2020, 2025] }), 704)).map((t) => t.text)).toEqual([
      '2020',
      '2025',
    ]);
    expect(xTicks(at(own({ interval: 5, ticks: 3 }), 704)).length).toBeLessThan(6);
    const preset = { ...REPRO, options: { x: { ticks: [2021, 2024] } } } as Spec;
    expect(xTicks(at(preset, 704)).map((t) => t.text)).toEqual(['2021', '2024']);
  });
});

describe('the baseline label', () => {
  /** The baseline label's box and every other label's. */
  const split = (svg: Element, label: string) => {
    const all = boxes(svg);
    const mine = all.find((b) => b.text === label);
    if (!mine) throw new Error(`no ${label} label`);
    return { mine, others: all.filter((b) => b !== mine) };
  };

  function expectClear(svg: Element, label: string) {
    const { mine, others } = split(svg, label);
    expect(others.filter((o) => touch(mine, o)).map((o) => o.text)).toEqual([]);
    for (const pts of linePoints(svg)) {
      for (let i = 1; i < pts.length; i++) {
        expect(crosses(mine, [pts[i - 1] as Pt, pts[i] as Pt])).toBe(false);
      }
    }
    for (const [x, y] of dots(svg)) {
      const r = 3.5;
      expect(x + r > mine.a && x - r < mine.b && y + r > mine.top && y - r < mine.bottom).toBe(
        false,
      );
    }
    return mine;
  }

  it.each([430, 704, 1180])('touches no line, dot or end label at %ipx', (w) => {
    const svg = at(REPRO, w);
    const mine = expectClear(svg, '2020 = 1');
    // Past the end dots, starting where the end labels start.
    const [dotX] = dots(svg)[0] ?? [0];
    expect(mine.a).toBeGreaterThan(dotX + 3.5);
    const ends = boxes(svg).filter((b) => b.text.startsWith('Riverbend'));
    expect(mine.a).toBeCloseTo(ends[0]?.a ?? 0, 0);
  });

  it.each([430, 704, 1180])('moves off an end label that finishes on the baseline at %ipx', (w) => {
    const rows = index(2020, 6, { Riverbend: 0.2, Plan: 0.3, Harborlight: 0 });
    expectClear(at(withRows(REPRO, rows), w), '2020 = 1');
    const dipping = index(2020, 6, { Riverbend: 0.2, Plan: 0.3 }).concat(
      [1, 1.2, 1.1, 1.05, 1.02, 1.03].map((v, i) => ({ year: 2020 + i, who: 'Saltmarsh', v })),
    );
    expectClear(at(withRows(REPRO, dipping), w), '2020 = 1');
  });
});
