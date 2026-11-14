/**
 * A component's state, stored in the doc's Y.Doc so every page holding the
 * doc shares it live (design decisions 8 and 9: only in the `.ydoc`; two
 * tags with one id share one state).
 *
 * Each component id gets a root Y.Map of its own, `component-state:<id>`.
 * The design proposed one `components` map keyed by id; a root type is used
 * instead because two pages that write a component's first value before
 * seeing each other would each create the nested map under that key, and
 * Yjs keeps only one of the two — losing the other page's write. Root types
 * merge by name, so both first writes survive. Below the root, objects are
 * nested Y.Maps and arrays Y.Arrays, so writes to different paths both
 * survive, two writes to one path settle on one value on every peer, and
 * push keeps both appends.
 *
 * The limits are checked here, on the page that writes, before anything
 * reaches the doc: 256 KB per component, 2 MB per doc, 8 levels deep, 20
 * writes a second per component. A refused write returns a message and
 * changes nothing. The server does not check them; a member who goes around
 * the page can write any size or shape, which is why components treat state
 * as data (design "Trust model").
 */
import * as Y from 'yjs';
import {
  type StateOp as Op,
  STATE_LIMITS,
  byteLength,
  checkWrite,
  isContainer,
  kb,
  rateRefusal,
  recentWrites,
  segments,
} from './component-state-rules.ts';
import type { StateHook, StatePath, StateWrite } from './mdx-component-runtime.ts';

export type { StateHook, StatePath, StateWrite };
export { STATE_LIMITS };

const refuse = (error: string): StateWrite => ({ ok: false, error });

export const COMPONENT_STATE_PREFIX = 'component-state:';

/** A component id: the existing block-name pattern. */
export const COMPONENT_STATE_ID = /^[a-z0-9-]{1,64}$/;

export function componentStateMap(ydoc: Y.Doc, id: string): Y.Map<unknown> {
  return ydoc.getMap(COMPONENT_STATE_PREFIX + id);
}

/** The ids that hold state in `ydoc`, sorted. A root type another page made
 *  is in `ydoc.share` before anything here has asked for it. */
export function componentStateIds(ydoc: Y.Doc): string[] {
  const ids: string[] = [];
  for (const name of ydoc.share.keys()) {
    if (!name.startsWith(COMPONENT_STATE_PREFIX)) continue;
    const id = name.slice(COMPONENT_STATE_PREFIX.length);
    if (COMPONENT_STATE_ID.test(id) && componentStateMap(ydoc, id).size > 0) ids.push(id);
  }
  return ids.sort();
}

/** One component's state as plain JSON. */
export function readComponentState(ydoc: Y.Doc, id: string): Record<string, unknown> {
  return componentStateMap(ydoc, id).toJSON();
}

export interface StateHookOptions {
  /** False on a page that may read and may not write. */
  canWrite: boolean;
  /** The clock the rate limit reads; a test hands in its own. */
  now?: () => number;
}

/** The hook plus the teardown its owner calls when the component goes. */
export interface OwnedStateHook extends StateHook {
  dispose(): void;
}

/** Accepted write times per component, shared by every hook on one doc, so
 *  two tags with one id spend one budget. */
const writeTimes = new WeakMap<Y.Doc, Map<string, number[]>>();

export function createStateHook(ydoc: Y.Doc, id: string, opts: StateHookOptions): OwnedStateHook {
  const root = componentStateMap(ydoc, id);
  const now = opts.now ?? (() => Date.now());
  const listeners = new Set<(events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => void>();

  const write = (path: StatePath, op: Op): StateWrite => {
    if (!opts.canWrite) {
      return refuse(
        'This page can only read component state: writing it needs edit access to the doc.',
      );
    }
    const checked = checkWrite(root.toJSON(), path, op, id);
    if ('error' in checked) return refuse(checked.error);
    const { segs, bytes } = checked;
    let total = bytes;
    for (const other of componentStateIds(ydoc)) {
      if (other !== id) total += byteLength(readComponentState(ydoc, other));
    }
    if (total > STATE_LIMITS.docBytes) {
      return refuse(
        `This doc's component state would be ${kb(total)} KB, over the 2 MB limit for one doc.`,
      );
    }
    const t = now();
    const perDoc = writeTimes.get(ydoc) ?? new Map<string, number[]>();
    writeTimes.set(ydoc, perDoc);
    const recent = recentWrites(perDoc.get(id) ?? [], t);
    const tooFast = rateRefusal(recent, id);
    if (tooFast) {
      perDoc.set(id, recent);
      return refuse(tooFast);
    }
    recent.push(t);
    perDoc.set(id, recent);
    ydoc.transact(() => applyY(root, segs, op));
    return { ok: true };
  };

  return {
    canWrite: opts.canWrite,
    get(path?: StatePath): unknown {
      let at: unknown = root.toJSON();
      for (const seg of segments(path ?? '')) {
        if (Array.isArray(at)) at = at[Number(seg)];
        else if (at !== null && typeof at === 'object' && Object.hasOwn(at, seg)) {
          at = (at as Record<string, unknown>)[seg];
        } else return undefined;
      }
      return at;
    },
    set: (path, value) => write(path, { kind: 'set', value }),
    push: (path, value) => write(path, { kind: 'push', value }),
    delete: (path) => write(path, { kind: 'delete' }),
    on(fn) {
      const listener = () => fn(root.toJSON());
      listeners.add(listener);
      root.observeDeep(listener);
      return () => {
        listeners.delete(listener);
        root.unobserveDeep(listener);
      };
    },
    dispose() {
      for (const l of listeners) root.unobserveDeep(l);
      listeners.clear();
    },
  };
}

function toY(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>();
    arr.push(value.map(toY));
    return arr;
  }
  if (isContainer(value)) {
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(value)) map.set(k, toY(v));
    return map;
  }
  return value;
}

/** Apply `op`, already checked against a plain copy, to the shared types. */
function applyY(root: Y.Map<unknown>, segs: string[], op: Op): void {
  if (segs.length === 0) {
    root.clear();
    for (const [k, v] of Object.entries(op.kind === 'set' ? (op.value as object) : {})) {
      root.set(k, toY(v));
    }
    return;
  }
  let at: Y.Map<unknown> | Y.Array<unknown> = root;
  for (const seg of segs.slice(0, -1)) {
    const next: unknown = at instanceof Y.Array ? at.get(Number(seg)) : at.get(seg);
    if (next instanceof Y.Map || next instanceof Y.Array) {
      at = next;
    } else if (op.kind === 'delete') {
      return;
    } else {
      const made = new Y.Map<unknown>();
      (at as Y.Map<unknown>).set(seg, made);
      at = made;
    }
  }
  const last = segs[segs.length - 1] as string;
  if (op.kind === 'push') {
    const cur = at instanceof Y.Array ? at.get(Number(last)) : at.get(last);
    if (cur instanceof Y.Array) cur.push([toY(op.value)]);
    else (at as Y.Map<unknown>).set(last, toY([op.value]));
  } else if (at instanceof Y.Array) {
    const i = Number(last);
    if (i < at.length) at.delete(i, 1);
    if (op.kind === 'set') at.insert(i, [toY(op.value)]);
  } else if (op.kind === 'set') at.set(last, toY(op.value));
  else at.delete(last);
}
