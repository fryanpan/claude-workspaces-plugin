/**
 * The library chart: one component file that draws an Observable Plot chart
 * through `plot-spec.mjs`, and runs unchanged in a doc and on a site (design
 * task 7, "One component, three hosts").
 *
 *   import Chart from './plot-chart.ts'
 *   <Chart id="ferry" title="Ferry trips" data={{ rows: [...] }}
 *          marks={[{ mark: "barY", data: "rows", options: { x: "town", y: "trips" } }]} />
 *
 * Its props are a `<PlotChart>` spec (`data`, `marks` or `preset`,
 * `options`) plus a `title`, `subtitle` and `note`. Its state may hold
 * `title`, `subtitle`, `note` (a string there wins over the prop's, so an
 * empty one clears it) and `data`; each key of the state's `data` replaces that key of the
 * props' data, so an agent or a reader can change what is charted without
 * touching the tag. The chart redraws whenever the state changes.
 *
 * In a doc the state hook is live over the doc's Y.Doc, so a write on any
 * page redraws every page. On an Astro page it is a hook over a JSON snapshot
 * (`component-snapshot.ts`), whose writes stay on the page. With no hook it
 * draws its props.
 *
 * A site copies this file and `plot-spec.mjs` side by side, as they sit
 * here, and imports nothing else: the types it needs are written out below.
 * Plot comes from esm.sh at an exact version, which is what a doc build
 * accepts; a site's bundler maps that address to its own installed copy
 * (templates/astro-chart/astro.config.mjs). Text reaches the page only as
 * text nodes.
 */
import * as Plot from 'https://esm.sh/@observablehq/plot@0.6.17';
import { renderPlot } from './plot-spec.mjs';

/** What the chart reads of a state hook: `mdx-component-runtime.ts`'s
 *  `StateHook`, narrowed, so this file imports nothing to say it. */
interface ChartState {
  get(path?: string): unknown;
  on(fn: (state: unknown) => void): () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export default function mount(
  el: HTMLElement,
  props: Record<string, unknown>,
  state?: ChartState,
): (() => void) | undefined {
  const doc = el.ownerDocument;
  const figure = doc.createElement('figure');
  figure.className = 'plot-chart';
  const title = doc.createElement('figcaption');
  title.className = 'plot-chart-title';
  const subtitle = doc.createElement('p');
  subtitle.className = 'plot-chart-subtitle';
  const slot = doc.createElement('div');
  slot.className = 'plot-chart-slot';
  const note = doc.createElement('p');
  note.className = 'plot-chart-note';
  figure.append(title, subtitle, slot, note);
  el.replaceChildren(figure);

  const draw = (): void => {
    const live = state?.get();
    const s = isRecord(live) ? live : {};
    // A string in the state wins, even an empty one, so the state can clear
    // a line the props wrote.
    const words = (key: string, node: HTMLElement): void => {
      const v = typeof s[key] === 'string' ? s[key] : props[key];
      node.textContent = typeof v === 'string' ? v : '';
      node.hidden = node.textContent === '';
    };
    words('title', title);
    words('subtitle', subtitle);
    words('note', note);
    const data = {
      ...(isRecord(props.data) ? props.data : {}),
      ...(isRecord(s.data) ? s.data : {}),
    };
    renderPlot(Plot, slot, {
      data,
      ...(props.marks === undefined ? {} : { marks: props.marks }),
      ...(props.preset === undefined ? {} : { preset: props.preset }),
      ...(isRecord(props.options) ? { options: props.options } : {}),
    });
  };
  draw();
  return state ? state.on(draw) : undefined;
}
