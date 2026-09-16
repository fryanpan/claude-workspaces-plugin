import { describe, expect, it } from 'vitest';
import { summarizeMdx } from '../src/mdx-preview.ts';
import { BARS, LINE, ONE_LINE } from './fixtures/mdx-charts.ts';

/**
 * The chart a component's literal props describe (`mdx-chart-props.ts`), read
 * by shape rather than by component name and never by running the source.
 */

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
