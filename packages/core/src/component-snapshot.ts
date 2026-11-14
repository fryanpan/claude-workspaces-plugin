/**
 * The host wrapper for a page that is not a doc: an Astro page or SF Works
 * mounts a component with a state hook over a JSON snapshot (design "One
 * component, three hosts"). The snapshot is what `get_component_state`
 * returned for the component's id, saved beside the page.
 *
 * The hook reads and refuses as the doc's live hook does: both check every
 * write with `component-state-rules.ts`, so a component that runs on a site
 * runs in a doc. Its writes stay on the page: they change this page's copy
 * and call the component's listeners, and reach no doc. The snapshot handed
 * in is never changed.
 *
 * Nothing it imports reaches for Yjs, so a page that bundles it gets none.
 */
import {
  type StateOp,
  checkWrite,
  rateRefusal,
  recentWrites,
  segments,
} from './component-state-rules.ts';
import type { MountFn, StateHook, StatePath, StateWrite } from './mdx-component-runtime.ts';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface SnapshotOptions {
  /** The component's id, which a refusal names. */
  id?: string;
  /** The clock the rate limit reads; a test hands in its own. */
  now?: () => number;
}

/** A hook over a copy of `snapshot`. A snapshot that is not an object is
 *  read as an empty state. */
export function snapshotState(snapshot: unknown, opts: SnapshotOptions = {}): StateHook {
  const id = opts.id ?? 'snapshot';
  const now = opts.now ?? (() => Date.now());
  let state: Json = isObject(snapshot) ? structuredClone(snapshot) : {};
  let times: number[] = [];
  const listeners = new Set<(s: unknown) => void>();

  const write = (path: StatePath, op: StateOp): StateWrite => {
    const checked = checkWrite(state, path, op, id);
    if ('error' in checked) return { ok: false, error: checked.error };
    const t = now();
    times = recentWrites(times, t);
    const tooFast = rateRefusal(times, id);
    if (tooFast) return { ok: false, error: tooFast };
    times.push(t);
    state = checked.next as Json;
    for (const fn of [...listeners]) fn(structuredClone(state));
    return { ok: true };
  };

  return {
    get(path?: StatePath): unknown {
      let v: unknown = state;
      for (const seg of segments(path ?? '')) {
        if (Array.isArray(v)) v = v[Number(seg)];
        else if (isObject(v) && Object.hasOwn(v, seg)) v = v[seg];
        else return undefined;
      }
      return v === undefined ? undefined : structuredClone(v);
    },
    set: (path, value) => write(path, { kind: 'set', value: structuredCloneJson(value) }),
    push: (path, value) => write(path, { kind: 'push', value: structuredCloneJson(value) }),
    delete: (path) => write(path, { kind: 'delete' }),
    on(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    canWrite: true,
  };
}

/** A copy of a JSON value, so the caller's object is not stored; a value
 *  that is not JSON is passed on for the rules to refuse. */
function structuredCloneJson(value: unknown): unknown {
  try {
    return typeof value === 'function' ? value : structuredClone(value);
  } catch {
    return value;
  }
}

/** Mount `mount` into `el` with `props` and, when there is a snapshot, a
 *  hook over it. Returns the component's cleanup, or one that does nothing. */
export function mountFromSnapshot(
  el: HTMLElement,
  mount: MountFn,
  props: Record<string, unknown>,
  snapshot?: unknown,
  opts?: SnapshotOptions,
): () => void {
  const out = mount(el, props, snapshot === undefined ? undefined : snapshotState(snapshot, opts));
  return typeof out === 'function' ? out : () => {};
}
