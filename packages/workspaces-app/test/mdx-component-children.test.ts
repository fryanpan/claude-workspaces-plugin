import { prose } from '@claude-workspaces/core';
import {
  type ComponentHostApi,
  builtin,
  jsx,
  render,
} from '@claude-workspaces/core/mdx-component-runtime';
import { componentBuildsMap, componentInputs } from '@claude-workspaces/core/mdx-components';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import { setComponentDoc, setComponentLoaderForTest } from '../src/mdx-component.ts';
import { setPlotForTest } from '../src/mdx-plot-chart.ts';

/**
 * A component tag holding `<PlotChart>` children, as a carousel of charts is
 * written: the tag draws only as the component, and each chart inside it
 * keeps the title and subtitle its own card shows.
 *
 * Driven through the real editor over fragments parsed the way the server
 * parses an `.mdx`, with Plot and the bundle import swapped for stand-ins.
 */

const IMPORT = "import Carousel from './components/carousel.tsx'";
const chart = (name: string, indent = '') =>
  `${indent}<PlotChart title="${name}" subtitle="${name} crossings" data={{ rows: [{ x: 1, y: 2 }] }} marks={[{ mark: "lineY", data: "rows", options: { x: "x", y: "y" } }]} />`;
const NAMES = ['Harborlight', 'Riverbend', 'Saltmarsh'];
const CAROUSEL = [
  '<Carousel label="Neighborhood charts">',
  ...NAMES.map((n) => chart(n, '  ')),
  '</Carousel>',
].join('\n');
const CAROUSEL_DOC = `# Riverbend\n\n${IMPORT}\n\n${CAROUSEL}\n`;
/** The same charts before somebody wrapped them in the carousel. */
const LOOSE_DOC = `# Riverbend\n\n${NAMES.map((n) => chart(n)).join('\n\n')}\n`;
const KEY = componentInputs([IMPORT, CAROUSEL])[0]?.key ?? '';
const HASH = 'c'.repeat(32);

const open: Array<() => void> = [];

/** The bundle the server would build for the carousel tag: a carousel whose
 *  children are the three `<PlotChart>` built-ins, each in its own slide. */
function carouselModule() {
  const Carousel = (el: HTMLElement, props: Record<string, unknown>) => {
    for (const child of props.children as Node[]) {
      const slide = document.createElement('section');
      slide.className = 'slide';
      slide.append(child);
      el.append(slide);
    }
  };
  return {
    default: (host: HTMLElement, api: ComponentHostApi) =>
      render(host, api, () =>
        jsx(Carousel, {
          label: 'Neighborhood charts',
          children: NAMES.map((n) =>
            jsx(builtin('PlotChart'), {
              title: n,
              subtitle: `${n} crossings`,
              data: { rows: [{ x: 1, y: 2 }] },
              marks: [{ mark: 'lineY', data: 'rows', options: { x: 'x', y: 'y' } }],
            }),
          ),
        }),
      ),
  };
}

beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-harbor/docs/d-charts');
  setPlotForTest({
    renderPlotInto: (slot: HTMLElement) => {
      slot.replaceChildren(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    },
  } as never);
  setComponentLoaderForTest(async () => carouselModule());
});

afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  setComponentLoaderForTest(null);
  setPlotForTest(null);
});

function mount(md: string): { server: Y.Doc } {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  server.on('update', (u: Uint8Array) => Y.applyUpdate(client, u));
  setComponentDoc(client, true);
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc: client, awareness: new Awareness(client) });
  open.push(() => handle.destroy());
  return { server };
}

/** Replace the whole doc on the server, as a whole-file rewrite arrives. */
function rewrite(server: Y.Doc, md: string): void {
  const frag = prose.getProseFragment(server);
  server.transact(() => {
    frag.delete(0, frag.length);
    frag.push(prose.parseMarkdownBlocks(md, { mdx: true }));
  });
}

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 50 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};
const live = () => document.querySelector<HTMLElement>('.ProseMirror .mdx-live');
/** Charts drawn as a block's own card, outside any component. */
const cards = () =>
  [...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-view .mdx-plot')].filter(
    (p) => !p.closest('.mdx-live'),
  );
const shownErrors = () =>
  [...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-edit-error')].filter(
    (e) => !e.hidden,
  );

describe('a component tag holding PlotCharts', () => {
  it('draws only as the component when the doc is opened', async () => {
    const { server } = mount(CAROUSEL_DOC);
    componentBuildsMap(server).set(KEY, { hash: HASH, at: Date.now() });
    await settle(() => (live()?.querySelectorAll('.slide').length ?? 0) === 3);
    expect(live()?.querySelectorAll('.slide')).toHaveLength(3);
    expect(cards()).toHaveLength(0);
    expect(shownErrors()).toHaveLength(0);
  });

  it('leaves no chart card or chart error behind when charts are rewrapped as a carousel', async () => {
    const { server } = mount(LOOSE_DOC);
    await settle(() => cards().length === 3);
    expect(cards()).toHaveLength(3);
    rewrite(server, CAROUSEL_DOC);
    componentBuildsMap(server).set(KEY, { hash: HASH, at: Date.now() });
    await settle(() => (live()?.querySelectorAll('.slide').length ?? 0) === 3);
    expect(live()?.querySelectorAll('.slide')).toHaveLength(3);
    expect(cards()).toHaveLength(0);
    expect(shownErrors()).toHaveLength(0);
    // The import line reads as the import, not as the chart that stood there.
    const views = [...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-view')];
    expect(views.map((v) => v.dataset.kind)).toEqual(['esm', 'component']);
    expect(views[0]?.textContent).toBe('import Carousel');
  });

  it("keeps each chart's title and subtitle inside the component", async () => {
    const { server } = mount(CAROUSEL_DOC);
    componentBuildsMap(server).set(KEY, { hash: HASH, at: Date.now() });
    await settle(() => (live()?.querySelectorAll('.slide').length ?? 0) === 3);
    const slides = [...(live()?.querySelectorAll<HTMLElement>('.slide') ?? [])];
    expect(slides.map((s) => s.querySelector('.mdx-head .mdx-title')?.textContent)).toEqual(NAMES);
    expect(slides.map((s) => s.querySelector('.mdx-subtitle')?.textContent)).toEqual(
      NAMES.map((n) => `${n} crossings`),
    );
    expect(slides.every((s) => s.querySelector('.mdx-plot svg'))).toBe(true);
  });
});

describe('a PlotChart outside any component', () => {
  it('still draws its own card with its title, subtitle and chart', async () => {
    mount(`# Riverbend\n\n${chart('Saltmarsh')}\n`);
    await settle(() => cards().length === 1);
    const view = document.querySelector<HTMLElement>('.ProseMirror .mdx-view');
    expect(view?.querySelector('.mdx-head .mdx-title')?.textContent).toBe('Saltmarsh');
    expect(view?.querySelector('.mdx-subtitle')?.textContent).toBe('Saltmarsh crossings');
    expect(view?.querySelector('.mdx-plot svg')).not.toBeNull();
    expect(document.querySelector('.mdx-block')?.classList.contains('has-chart')).toBe(true);
    expect(shownErrors()).toHaveLength(0);
  });
});
