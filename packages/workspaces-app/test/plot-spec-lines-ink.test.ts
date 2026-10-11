import { buildPlot } from '@claude-workspaces/core/plot-spec';
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import { measured } from './fixtures/chrome-glyph-widths.ts';

/**
 * A lines chart's end labels are text, and no series colour reaches 4.5:1 as
 * text on the paper, so they draw in the house ink; the dot that ends each
 * line keeps its series colour and is what ties a label to its line. Read off
 * the SVG real Plot draws.
 */

type Spec = Parameters<typeof buildPlot>[1];
type Pt = [number, number];
type Box = { a: number; b: number; top: number; bottom: number };

const INK = 'var(--ink, #15181c)';
/** Chrome's box for one 13px line is about 16px tall; each further line adds 1em. */
const LINE_BOX = 16;
const LEADING = 13;

const at = (spec: Spec, width: number) => buildPlot(Plot, spec, { width }) as SVGSVGElement;

const translate = (el: Element | null): Pt => {
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el?.getAttribute('transform') ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

const index = (years: number, rates: Record<string, number>) =>
  Array.from({ length: years }, (_, i) =>
    Object.entries(rates).map(([who, r]) => ({ year: 2020 + i, who, v: 1 + r * i })),
  ).flat();

/** Four series, one dashed, finishing far enough apart that no two labels meet. */
const SPEC = {
  data: { rows: index(6, { Riverbend: 0.2, Harborlight: 0.1, Saltmarsh: 0.05, Plan: 0.3 }) },
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

const NAMES = ['Riverbend', 'Harborlight', 'Saltmarsh', 'Plan'];

const withRows = (rows: unknown[]) => ({ ...SPEC, data: { rows } }) as Spec;

/** Riverbend and Harborlight end 0.05 apart, and Saltmarsh ends on the baseline. */
const CLOSE = withRows([
  ...index(6, { Riverbend: 0.2, Harborlight: 0.21, Plan: 0.3 }),
  ...index(6, { Saltmarsh: 0 }),
]);

/**
 * Saltmarsh and Harborlight end 0.05 apart just above the baseline, so the
 * spread moves one of them onto the place the baseline label wants.
 */
const NEAR_BASE = withRows([
  ...index(6, { Riverbend: 0.2, Plan: 0.3 }),
  ...index(6, { Saltmarsh: 0.02, Harborlight: 0.03 }),
]);

/**
 * Each label's first word, fill and box, for the text drawn by the groups
 * `selector` names. Under 600px an end label is two lines, name over value.
 */
function textBoxes(svg: Element, selector: string) {
  return [...svg.querySelectorAll(selector)].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('text')].map((t) => {
      const [x, y] = translate(t);
      const spans = [...t.querySelectorAll('tspan')].map((s) => s.textContent ?? '');
      const lines = spans.length > 0 ? spans : [t.textContent ?? ''];
      const height = LINE_BOX + (lines.length - 1) * LEADING;
      const top = y + dy - height / 2;
      return {
        name: (lines[0] ?? '').split(' ')[0],
        fill: t.getAttribute('fill') ?? g.getAttribute('fill'),
        a: x + dx,
        b: x + dx + Math.max(...lines.map((l) => measured(l))),
        top,
        bottom: top + height,
      };
    });
  });
}

/** The end labels: the text drawn right after the end dots. */
const endLabels = (svg: Element) => textBoxes(svg, '[aria-label="dot"] + [aria-label="text"]');

const touch = (m: Box, n: Box) => m.a < n.b && n.a < m.b && m.top < n.bottom && n.top < m.bottom;

/** Each line's last point and its stroke. */
function lineEnds(svg: Element) {
  return [...svg.querySelectorAll('[aria-label="line"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('path')].map((p) => {
      const pts = [...(p.getAttribute('d') ?? '').matchAll(/[ML]([-\d.]+),([-\d.]+)/g)];
      const last = pts[pts.length - 1];
      return {
        at: [Number(last?.[1]) + dx, Number(last?.[2]) + dy] as Pt,
        stroke: p.getAttribute('stroke') ?? g.getAttribute('stroke'),
      };
    });
  });
}

/** The end dots, each with its centre and fill. */
function endDots(svg: Element) {
  return [...svg.querySelectorAll('[aria-label="dot"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('circle')].map((c) => ({
      at: [Number(c.getAttribute('cx')) + dx, Number(c.getAttribute('cy')) + dy] as Pt,
      fill: c.getAttribute('fill') ?? g.getAttribute('fill'),
    }));
  });
}

describe('the lines preset’s end labels', () => {
  it.each([430, 704, 1180])('draw every end label in ink at %ipx', (w) => {
    const labels = endLabels(at(SPEC, w));
    expect(labels.map((l) => l.name).sort()).toEqual([...NAMES].sort());
    for (const l of labels) expect(l.fill).toBe(INK);
  });

  it.each([
    [430, SPEC],
    [704, SPEC],
    [1180, SPEC],
    [430, CLOSE],
    [1180, CLOSE],
  ])('keep each end dot in its own line’s colour, on its line, at %ipx', (w, spec) => {
    const svg = at(spec, w);
    const ends = lineEnds(svg);
    const dots = endDots(svg);
    expect(dots).toHaveLength(NAMES.length);
    expect(new Set(dots.map((d) => d.fill)).size).toBe(NAMES.length);
    for (const d of dots) {
      const mine = ends.find((e) => Math.hypot(e.at[0] - d.at[0], e.at[1] - d.at[1]) < 0.5);
      expect(mine?.stroke).toBeTruthy();
      expect(d.fill).toBe(mine?.stroke);
      expect(d.fill).not.toBe(INK);
    }
  });

  it.each([430, 704, 1180])('never overlap one another at %ipx', (w) => {
    const labels = endLabels(at(SPEC, w));
    for (const m of labels) {
      for (const n of labels) if (m !== n) expect(touch(m, n)).toBe(false);
    }
  });
});

describe('end labels of lines that finish close together', () => {
  it.each([430, 1180])('are moved apart on y, in the order their lines end, at %ipx', (w) => {
    const labels = endLabels(at(CLOSE, w));
    expect(labels).toHaveLength(NAMES.length);
    for (const m of labels) {
      for (const n of labels) if (m !== n) expect(touch(m, n)).toBe(false);
    }
    const top = (name: string) => labels.find((l) => l.name === name)?.top ?? Number.NaN;
    expect(top('Plan')).toBeLessThan(top('Harborlight'));
    expect(top('Harborlight')).toBeLessThan(top('Riverbend'));
    expect(top('Riverbend')).toBeLessThan(top('Saltmarsh'));
  });

  it.each([
    [430, CLOSE],
    [1180, CLOSE],
    [430, NEAR_BASE],
    [1180, NEAR_BASE],
  ])('leave the baseline label clear of every one at %ipx', (w, spec) => {
    const svg = at(spec, w);
    const [base] = textBoxes(svg, '[aria-label="text"]').filter((b) => b.name === '2020');
    expect(base).toBeDefined();
    for (const l of endLabels(svg)) expect(touch(base as Box, l)).toBe(false);
  });
});
