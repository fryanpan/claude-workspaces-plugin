/**
 * The host wrapper for a page that is not a doc: an Astro page or SF Works
 * mounts a component with a state hook over a JSON snapshot (design "One
 * component, three hosts"). The snapshot is what `get_component_state`
 * returned for the component's id, saved beside the page.
 *
 * The hook reads exactly as the doc's live hook does
 * (`mdx-component-state.ts`), so a component file runs unchanged on both.
 * Its writes stay on the page: they change this page's copy and call the
 * component's listeners, and reach no doc. The snapshot handed in is never
 * changed.
 *
 * It imports nothing at run time, so a page that bundles it gets no Yjs.
 */
import type { MountFn, StateHook, StatePath, StateWrite } from './mdx-component-runtime.ts';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function segments(path: StatePath | undefined): string[] {
  if (path === undefined) return [];
  if (Array.isArray(path)) return path.map(String);
  return String(path).split('.').filter(Boolean);
}

/** A hook over a copy of `snapshot`. A snapshot that is not an object is
 *  read as an empty state. */
export function snapshotState(snapshot: unknown): StateHook {
  let state: Json = isObject(snapshot) ? structuredClone(snapshot) : {};
  const listeners = new Set<(s: unknown) => void>();

  const write = (path: StatePath, change: (parent: Json | unknown[], key: string) => void) => {
    const segs = segments(path);
    const where = segs.join('.') || '(the whole state)';
    if (segs.length === 0) return refuse(`A write needs a path (at "${where}").`);
    if (segs.includes('__proto__') || segs.includes('constructor') || segs.includes('prototype')) {
      return refuse(
        `State has no key "${segs.find((s) => /^(__proto__|constructor|prototype)$/.test(s))}" (at "${where}").`,
      );
    }
    const next = structuredClone(state);
    let parent: Json | unknown[] = next;
    for (const seg of segs.slice(0, -1)) {
      const child: unknown = Array.isArray(parent) ? parent[Number(seg)] : parent[seg];
      if (child === undefined) {
        if (Array.isArray(parent)) return refuse(`No item ${seg} in the list at "${where}".`);
        parent[seg] = {};
        parent = parent[seg] as Json;
      } else if (isObject(child) || Array.isArray(child)) {
        parent = child;
      } else {
        return refuse(`"${seg}" holds a value, not an object, so "${where}" cannot be written.`);
      }
    }
    try {
      change(parent, segs[segs.length - 1] as string);
    } catch (err) {
      return refuse(`${(err as Error).message} (at "${where}").`);
    }
    state = next;
    for (const fn of [...listeners]) fn(structuredClone(state));
    return { ok: true } as const;
  };

  return {
    get(path?: StatePath): unknown {
      let v: unknown = state;
      for (const seg of segments(path)) {
        if (Array.isArray(v)) v = v[Number(seg)];
        else if (isObject(v) && Object.hasOwn(v, seg)) v = v[seg];
        else return undefined;
      }
      return v === undefined ? undefined : structuredClone(v);
    },
    set(path, value) {
      return write(path, (parent, key) => {
        if (Array.isArray(parent)) parent[index(parent, key, true)] = structuredClone(value);
        else parent[key] = structuredClone(value);
      });
    },
    push(path, value) {
      return write(path, (parent, key) => {
        const at = Array.isArray(parent) ? parent[index(parent, key, false)] : parent[key];
        if (at === undefined && !Array.isArray(parent)) parent[key] = [structuredClone(value)];
        else if (Array.isArray(at)) at.push(structuredClone(value));
        else throw new Error('Only a list can be pushed to');
      });
    },
    delete(path) {
      return write(path, (parent, key) => {
        if (Array.isArray(parent)) parent.splice(index(parent, key, false), 1);
        else delete parent[key];
      });
    },
    on(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    canWrite: true,
  };
}

/** Mount `mount` into `el` with `props` and, when there is a snapshot, a
 *  hook over it. Returns the component's cleanup, or one that does nothing. */
export function mountFromSnapshot(
  el: HTMLElement,
  mount: MountFn,
  props: Record<string, unknown>,
  snapshot?: unknown,
): () => void {
  const out = mount(el, props, snapshot === undefined ? undefined : snapshotState(snapshot));
  return typeof out === 'function' ? out : () => {};
}

function refuse(error: string): StateWrite {
  return { ok: false, error };
}

function index(list: unknown[], seg: string, extend: boolean): number {
  const i = Number(seg);
  const max = extend ? list.length : list.length - 1;
  if (!Number.isInteger(i) || i < 0 || i > max) throw new Error(`No item ${seg} in this list`);
  return i;
}
