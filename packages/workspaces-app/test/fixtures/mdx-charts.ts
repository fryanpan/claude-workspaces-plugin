/**
 * Chart components written the way posts write them — a tag over many lines or
 * on one, an apostrophe in a title, bare and numeric keys, trailing commas,
 * `{{ }}` objects, spaces in braces, non-ASCII. Every name and number in them
 * is made up. Shared by the prop-reading suite and the drawing suite.
 */

export const LINE: string = `<LineChart
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

export const ONE_LINE: string = `<LineChart title="Riverbend's crossings" series={[ { label: "A", values: [ { x: 0, y: 1 }, { x: 1, y: 3 }, ] }, ]} band={{ from: 1, to: 2 }} xTickLabels={{ 0: "Mon", 1: "Tue" }} />`;

export const BARS = (orientation: string): string => `<Chart
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
