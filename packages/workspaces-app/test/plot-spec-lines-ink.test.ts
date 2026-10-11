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

const INK = 'var(--ink, #15181c)';
const LINE_BOX = 16;

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

/**
 * The end labels, the text drawn right after the end dots: each one's series
 * name, its fill, and its box. Under 600px a label is two lines, name over
 * value.
 */
function endLabels(svg: Element) {
  return [...svg.querySelectorAll('[aria-label="dot"] + [aria-label="text"]')].flatMap((g) => {
    const [dx, dy] = translate(g);
    return [...g.querySelectorAll('text')].map((t) => {
      const [x, y] = translate(t);
      const spans = [...t.querySelectorAll('tspan')].map((s) => s.textContent ?? '');
      const lines = spans.length > 0 ? spans : [t.textContent ?? ''];
      const top = y + dy - LINE_BOX / 2 - (spans.length > 1 ? LINE_BOX / 2 : 0);
      return {
        name: (lines[0] ?? '').split(' ')[0],
        fill: t.getAttribute('fill') ?? g.getAttribute('fill'),
        a: x + dx,
        b: x + dx + Math.max(...lines.map(measured)),
        top,
        bottom: top + lines.length * LINE_BOX,
      };
    });
  });
}

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

  it.each([430, 704, 1180])('keep each end dot in its own line’s colour at %ipx', (w) => {
    const svg = at(SPEC, w);
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
      for (const n of labels) {
        if (m === n) continue;
        expect(m.a < n.b && n.a < m.b && m.top < n.bottom && n.top < m.bottom).toBe(false);
      }
    }
  });
});
