import { mountFromSnapshot } from '@claude-workspaces/core/component-snapshot';
import { createStateHook } from '@claude-workspaces/core/mdx-component-state';
import mount from '@claude-workspaces/core/plot-chart';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

/**
 * The library chart (`core/plot-chart.ts`) is one component file: drawn from
 * its props alone, from a JSON snapshot (an Astro page), or from the doc's
 * live state, where a write on another page redraws it. The browser halves
 * are `plot-chart-doc-browser.test.ts` and templates/astro-chart.
 */

const PROPS = {
  title: 'Ferry trips',
  data: {
    rows: [
      { town: 'Harborlight', trips: 4 },
      { town: 'Riverbend', trips: 7 },
    ],
  },
  marks: [{ mark: 'barY', data: 'rows', options: { x: 'town', y: 'trips' } }],
};

const THREE_ROWS = [
  { town: 'Harborlight', trips: 4 },
  { town: 'Riverbend', trips: 7 },
  { town: 'Saltmarsh', trips: 2 },
];

const bars = (el: Element) => el.querySelectorAll('[aria-label="bar"] rect').length;
const title = (el: Element) => el.querySelector('.plot-chart-title')?.textContent ?? null;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.innerHTML = '';
});

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

describe('the library chart', () => {
  it('draws from its props alone, with no state', () => {
    const el = host();
    const out = mount(el, PROPS);
    if (typeof out === 'function') cleanups.push(out);
    expect(bars(el)).toBe(2);
    expect(title(el)).toBe('Ferry trips');
  });

  it("draws a snapshot's data and title over its props, and redraws on a local write", () => {
    const el = host();
    const snapshot = { title: 'Ferry trips, November', data: { rows: THREE_ROWS } };
    let hook: { push(p: string, v: unknown): unknown } | undefined;
    cleanups.push(
      mountFromSnapshot(
        el,
        (e, p, s) => {
          hook = s;
          return mount(e, p, s);
        },
        PROPS,
        snapshot,
      ),
    );
    expect(bars(el)).toBe(3);
    expect(title(el)).toBe('Ferry trips, November');
    hook?.push('data.rows', { town: 'Bob crossing', trips: 1 });
    expect(bars(el)).toBe(4);
    expect(snapshot.data.rows).toHaveLength(3);
  });

  it('redraws when another page writes the live state', () => {
    // Two pages' Y.Docs, relaying every update as the doc socket does.
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== b) Y.applyUpdate(b, u, a);
    });
    b.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== a) Y.applyUpdate(a, u, b);
    });
    const onA = createStateHook(a, 'ferry', { canWrite: true });
    const onB = createStateHook(b, 'ferry', { canWrite: true });
    cleanups.push(
      () => onA.dispose(),
      () => onB.dispose(),
    );
    const el = host();
    const out = mount(el, PROPS, onB);
    if (typeof out === 'function') cleanups.push(out);
    expect(bars(el)).toBe(2);

    expect(onA.set('data.rows', THREE_ROWS)).toEqual({ ok: true });
    expect(bars(el)).toBe(3);
    expect(onA.set('title', 'Ferry trips, live')).toEqual({ ok: true });
    expect(title(el)).toBe('Ferry trips, live');
    expect(onA.set('title', '')).toEqual({ ok: true });
    expect(title(el)).toBe('');
  });

  it('stops redrawing once its cleanup runs', () => {
    const el = host();
    const snapshot = { data: { rows: PROPS.data.rows } };
    let hook: { set(p: string, v: unknown): unknown } | undefined;
    const cleanup = mountFromSnapshot(
      el,
      (e, p, s) => {
        hook = s;
        return mount(e, p, s);
      },
      PROPS,
      snapshot,
    );
    cleanup();
    hook?.set('data.rows', THREE_ROWS);
    expect(bars(el)).toBe(2);
  });

  it('shows why a spec cannot be drawn, in place of the chart', () => {
    const el = host();
    mount(el, { ...PROPS, marks: [{ mark: 'scriptTag', data: 'rows' }] });
    expect(bars(el)).toBe(0);
    expect(el.querySelector('.plot-spec-error')?.textContent).toContain('scriptTag');
  });
});
