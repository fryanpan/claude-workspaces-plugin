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
  type PlainOp as Op,
  STATE_LIMITS,
  applyPlain,
  byteLength,
  componentSizeRefusal,
  isContainer,
  kb,
  opRefusal,
  rateRefusal,
  recentWrites,
  segments,
} from './component-state-rules.ts';
import type { StateHook, StatePath, StateWrite } from './mdx-component-runtime.ts';

export type { StateHook, StatePath, StateWrite };
export { STATE_LIMITS };

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
    const segs = segments(path);
    const bad = opRefusal(segs, op);
    if (bad) return refuse(bad);
    let next: unknown;
    try {
      next = applyPlain(root.toJSON(), segs, op);
    } catch (err) {
      return refuse((err as Error).message);
    }
    const over = overLimit(ydoc, id, next) ?? spendWrite(ydoc, id, now());
    if (over) return refuse(over);
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

/** One op of a batch: `set` and `push` carry a value, `delete` none. */
export type StateOp =
  | { op: 'set'; path: StatePath; value: unknown }
  | { op: 'push'; path: StatePath; value: unknown }
  | { op: 'delete'; path: StatePath };

export interface StateOpsOptions {
  /** The transaction origin, so a listener can tell who wrote. */
  origin?: unknown;
  now?: () => number;
}

/** Most ops one batch may carry. */
export const MAX_STATE_OPS = 100;

/**
 * Apply `ops` to component `id` in one transaction: every op is worked on a
 * plain copy first and the limits are checked on the result, so a refused op
 * anywhere in the batch changes nothing, and the refusal names its index.
 * The batch spends one write of the rate limit. The agent route's write
 * (`server/src/doc-components-agent.ts`); a page writes through the hook.
 */
export function applyStateOps(
  ydoc: Y.Doc,
  id: string,
  ops: readonly StateOp[],
  opts: StateOpsOptions = {},
): StateWrite {
  if (!COMPONENT_STATE_ID.test(id)) {
    return refuse(`"${id}" is not a component id: use 1 to 64 of a-z, 0-9 and -.`);
  }
  if (!Array.isArray(ops) || ops.length === 0) return refuse('ops must be a non-empty list.');
  if (ops.length > MAX_STATE_OPS) return refuse(`ops must hold at most ${MAX_STATE_OPS} entries.`);
  const root = componentStateMap(ydoc, id);
  const steps: Array<{ segs: string[]; op: Op }> = [];
  let next: unknown = root.toJSON();
  for (const [i, raw] of ops.entries()) {
    const parsed = parseOp(raw, i);
    if (typeof parsed === 'string') return refuse(parsed);
    const bad = opRefusal(parsed.segs, parsed.op);
    if (bad) return refuse(`ops[${i}]: ${bad}`);
    // The plain copy gets a copy of the value: a later op in the batch
    // changes the copy in place, and must not change what this op writes.
    const own: Op =
      parsed.op.kind === 'delete'
        ? parsed.op
        : { kind: parsed.op.kind, value: structuredClone(parsed.op.value) };
    try {
      next = applyPlain(next as Record<string, unknown>, parsed.segs, own);
    } catch (err) {
      return refuse(`ops[${i}]: ${(err as Error).message}`);
    }
    steps.push(parsed);
  }
  const over = overLimit(ydoc, id, next) ?? spendWrite(ydoc, id, (opts.now ?? Date.now)());
  if (over) return refuse(over);
  ydoc.transact(() => {
    for (const { segs, op } of steps) applyY(root, segs, op);
  }, opts.origin);
  return { ok: true };
}

function parseOp(raw: unknown, i: number): { segs: string[]; op: Op } | string {
  const r = raw as { op?: unknown; path?: unknown; value?: unknown } | null;
  if (r === null || typeof r !== 'object') return `ops[${i}] must be an object.`;
  const path = r.path;
  const okPath =
    typeof path === 'string' ||
    (Array.isArray(path) && path.every((p) => typeof p === 'string' || typeof p === 'number'));
  if (!okPath) return `ops[${i}].path must be a string like "pins.a" or a list of keys.`;
  const segs = segments(path as StatePath);
  if (r.op === 'delete') return { segs, op: { kind: 'delete' } };
  if (r.op === 'set' || r.op === 'push') {
    if (!('value' in r)) return `ops[${i}].value is required for "${r.op}".`;
    return { segs, op: { kind: r.op, value: r.value } };
  }
  return `ops[${i}].op must be "set", "push" or "delete".`;
}

/** Why `next` as component `id`'s state is past a size limit, or null. */
function overLimit(ydoc: Y.Doc, id: string, next: unknown): string | null {
  const over = componentSizeRefusal(id, next);
  if (over) return over;
  const bytes = byteLength(next);
  let total = bytes;
  for (const other of componentStateIds(ydoc)) {
    if (other !== id) total += byteLength(readComponentState(ydoc, other));
  }
  if (total > STATE_LIMITS.docBytes) {
    return `This doc's component state would be ${kb(total)} KB, over the 2 MB limit for one doc.`;
  }
  return null;
}

/** Spend one write of component `id`'s rate budget at `t`, or say why not. */
function spendWrite(ydoc: Y.Doc, id: string, t: number): string | null {
  const perDoc = writeTimes.get(ydoc) ?? new Map<string, number[]>();
  writeTimes.set(ydoc, perDoc);
  const recent = recentWrites(perDoc.get(id) ?? [], t);
  const tooFast = rateRefusal(recent, id);
  if (tooFast) {
    perDoc.set(id, recent);
    return tooFast;
  }
  recent.push(t);
  perDoc.set(id, recent);
  return null;
}

const refuse = (error: string): StateWrite => ({ ok: false, error });

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
