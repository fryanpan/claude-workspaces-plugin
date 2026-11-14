import { describe, expect, it } from 'vitest';
import { mountFromSnapshot, snapshotState } from './component-snapshot.ts';
import type { MountFn, StateHook } from './mdx-component-runtime.ts';

/**
 * A page that is not a doc (an Astro page, SF Works) hands a component a
 * state hook over a JSON snapshot: it reads like the live hook, and its
 * writes stay on the page.
 */

const SNAPSHOT = {
  data: { rows: [{ town: 'Harborlight', trips: 4 }] },
  filter: 'Riverbend',
};

describe('a state hook over a JSON snapshot', () => {
  it('reads the snapshot by path, as copies', () => {
    const hook = snapshotState(SNAPSHOT);
    expect(hook.get('filter')).toBe('Riverbend');
    expect(hook.get(['data', 'rows', 0, 'town'])).toBe('Harborlight');
    expect(hook.get('data.rows.0.trips')).toBe(4);
    expect(hook.get('missing.key')).toBeUndefined();
    const whole = hook.get() as typeof SNAPSHOT;
    whole.filter = 'changed by a reader';
    expect(hook.get('filter')).toBe('Riverbend');
  });

  it('keeps writes on the page and leaves the snapshot it was given alone', () => {
    const given = structuredClone(SNAPSHOT);
    const hook = snapshotState(given);
    const seen: unknown[] = [];
    hook.on((s) => seen.push(s));
    expect(hook.set('filter', 'Saltmarsh')).toEqual({ ok: true });
    expect(hook.push('data.rows', { town: 'Saltmarsh', trips: 2 })).toEqual({ ok: true });
    expect(hook.push('pins', 'a')).toEqual({ ok: true });
    expect(hook.delete('data.rows.0')).toEqual({ ok: true });
    expect(hook.get()).toEqual({
      data: { rows: [{ town: 'Saltmarsh', trips: 2 }] },
      filter: 'Saltmarsh',
      pins: ['a'],
    });
    expect(seen).toHaveLength(4);
    expect(seen.at(-1)).toEqual(hook.get());
    expect(given).toEqual(SNAPSHOT);
    expect(hook.canWrite).toBe(true);
  });

  it('refuses a write it cannot place, and changes nothing', () => {
    const hook = snapshotState(SNAPSHOT);
    const refused = hook.set('filter.deeper', 1);
    expect(refused.ok).toBe(false);
    expect(hook.set('__proto__.polluted', true).ok).toBe(false);
    expect(hook.push('filter', 'x').ok).toBe(false);
    expect(hook.set('toString.x', 1).ok).toBe(true);
    hook.delete('toString');
    expect(hook.set('when', new Date(0)).ok).toBe(false);
    expect(hook.set('nothing', undefined).ok).toBe(false);
    expect(hook.push('pins', () => 1).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(hook.get()).toEqual(SNAPSHOT);
  });

  it('stops calling a listener once it unsubscribes', () => {
    const hook = snapshotState({});
    let calls = 0;
    const off = hook.on(() => calls++);
    hook.set('a', 1);
    off();
    hook.set('a', 2);
    expect(calls).toBe(1);
  });

  it('starts empty from no snapshot or a snapshot that is not an object', () => {
    expect(snapshotState(undefined).get()).toEqual({});
    expect(snapshotState([1, 2]).get()).toEqual({});
  });
});

describe('mounting a component from a snapshot', () => {
  it('hands the component its props and a snapshot hook, and returns its cleanup', () => {
    let got: { props?: Record<string, unknown>; state?: StateHook } = {};
    let cleaned = 0;
    const mount: MountFn = (_el, props, state) => {
      got = { props, ...(state ? { state } : {}) };
      return () => cleaned++;
    };
    const el = {} as HTMLElement;
    const cleanup = mountFromSnapshot(el, mount, { title: 'Bob' }, SNAPSHOT);
    expect(got.props).toEqual({ title: 'Bob' });
    expect(got.state?.get('filter')).toBe('Riverbend');
    cleanup();
    expect(cleaned).toBe(1);
  });

  it('gives a component no state when there is no snapshot', () => {
    let state: StateHook | undefined | 'unset' = 'unset';
    const mount: MountFn = (_el, _props, s) => {
      state = s;
    };
    const cleanup = mountFromSnapshot({} as HTMLElement, mount, {});
    expect(state).toBeUndefined();
    expect(cleanup).not.toThrow();
  });
});
