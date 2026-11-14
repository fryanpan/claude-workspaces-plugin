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
import type { StateHook, StatePath, StateWrite } from './mdx-component-runtime.ts';

export type { StateHook, StatePath, StateWrite };

export const COMPONENT_STATE_PREFIX = 'component-state:';

/** A component id: the existing block-name pattern. */
export const COMPONENT_STATE_ID = /^[a-z0-9-]{1,64}$/;

export const STATE_LIMITS = {
  instanceBytes: 256 * 1024,
  docBytes: 2 * 1024 * 1024,
  depth: 8,
  writesPerSecond: 20,
} as const;

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

type Op = { kind: 'set'; value: unknown } | { kind: 'push'; value: unknown } | { kind: 'delete' };

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
    const segs = segments(path);
    const where = segs.join('.') || '(the whole state)';
    if (segs.includes('__proto__')) return refuse(`State has no key "__proto__" (at "${where}").`);
    if (op.kind !== 'delete') {
      const bad = notJson(op.value, where);
      if (bad) return refuse(bad);
    }
    let next: unknown;
    try {
      next = applyPlain(root.toJSON(), segs, op);
    } catch (err) {
      return refuse((err as Error).message);
    }
    const depth = depthOf(next);
    if (depth > STATE_LIMITS.depth) {
      return refuse(
        `Component "${id}" state would be nested ${depth} levels deep, over the limit of ${STATE_LIMITS.depth}.`,
      );
    }
    const bytes = byteLength(next);
    if (bytes > STATE_LIMITS.instanceBytes) {
      return refuse(
        `Component "${id}" state would be ${kb(bytes)} KB, over the 256 KB limit for one component. Keep large data in a file the component imports.`,
      );
    }
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
    const recent = (perDoc.get(id) ?? []).filter((at) => t - at < 1000);
    if (recent.length >= STATE_LIMITS.writesPerSecond) {
      perDoc.set(id, recent);
      return refuse(
        `Component "${id}" wrote more than ${STATE_LIMITS.writesPerSecond} times a second, so this write was refused. Write a drag's position when it ends, or at most every 50 ms.`,
      );
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

const refuse = (error: string): StateWrite => ({ ok: false, error });

function segments(path: StatePath): string[] {
  const parts = typeof path === 'string' ? (path === '' ? [] : path.split('.')) : [...path];
  return parts.map(String);
}

const kb = (bytes: number) => Math.ceil(bytes / 1024);

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function depthOf(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  let deepest = 0;
  for (const v of Object.values(value)) deepest = Math.max(deepest, depthOf(v));
  return 1 + deepest;
}

/** Why `value` is not JSON, or null when it is. */
function notJson(value: unknown, where: string): string | null {
  const why = (what: string) =>
    `State holds JSON only: ${what} at "${where}" is not a string, number, boolean, null, array or plain object.`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : why(String(value));
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const bad = notJson(v, `${where}.${i}`);
      if (bad) return bad;
    }
    return null;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return why(`a ${proto?.constructor?.name}`);
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__') return `State has no key "__proto__" (at "${where}").`;
      const bad = notJson(v, `${where}.${k}`);
      if (bad) return bad;
    }
    return null;
  }
  return why(value === undefined ? 'undefined' : `a ${typeof value}`);
}

type Container = Record<string, unknown> | unknown[];

const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object';

function indexIn(arr: { length: number }, seg: string, path: string, extend: boolean): number {
  const i = /^\d+$/.test(seg) ? Number(seg) : -1;
  if (i < 0 || i > arr.length || (i === arr.length && !extend)) {
    throw new Error(`"${path}" names no item of its list.`);
  }
  return i;
}

/** The state `op` would leave, worked on a plain copy so a refusal changes
 *  nothing. Throws a message for a path that cannot be followed. */
function applyPlain(state: Record<string, unknown>, segs: string[], op: Op): unknown {
  if (segs.length === 0) {
    if (op.kind === 'set' && isContainer(op.value) && !Array.isArray(op.value)) return op.value;
    throw new Error('The whole state can only be set to a plain object.');
  }
  let at: Container = state;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    const path = segs.slice(0, i + 1).join('.');
    const next: unknown = Array.isArray(at)
      ? at[indexIn(at, seg, path, false)]
      : Object.hasOwn(at, seg)
        ? (at as Record<string, unknown>)[seg]
        : undefined;
    if (next === undefined && op.kind === 'delete') return state;
    if (next === undefined && !Array.isArray(at)) {
      const made: Record<string, unknown> = {};
      (at as Record<string, unknown>)[seg] = made;
      at = made;
      continue;
    }
    if (!isContainer(next))
      throw new Error(`"${path}" holds no keys, so "${segs.join('.')}" cannot be reached.`);
    at = next;
  }
  const last = segs[segs.length - 1] as string;
  const path = segs.join('.');
  if (op.kind === 'push') {
    const cur = Array.isArray(at)
      ? at[indexIn(at, last, path, false)]
      : Object.hasOwn(at, last)
        ? at[last]
        : undefined;
    if (cur === undefined && !Array.isArray(at)) at[last] = [op.value];
    else if (Array.isArray(cur)) cur.push(op.value);
    else throw new Error(`"${path}" is not a list, so nothing can be pushed onto it.`);
  } else if (Array.isArray(at)) {
    const i = indexIn(at, last, path, op.kind === 'set');
    if (op.kind === 'set') at[i] = op.value;
    else at.splice(i, 1);
  } else if (op.kind === 'set') at[last] = op.value;
  else delete at[last];
  return state;
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
