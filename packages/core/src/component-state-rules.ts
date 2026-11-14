/**
 * The rules a component state write is held to, on every host: the live hook
 * over a doc's Y.Doc (`mdx-component-state.ts`) and the hook over a JSON
 * snapshot on a page that is not a doc (`component-snapshot.ts`). One copy,
 * so a component a site accepts is one a doc accepts, and the reverse: the
 * same paths, the same JSON-only values, no `__proto__` key, the same depth,
 * size and rate limits. The doc-wide size limit is the live hook's alone,
 * since a snapshot holds one component.
 *
 * Plain functions over plain JSON; it imports nothing, so a site bundling the
 * snapshot hook gets no Yjs.
 */
import type { StatePath } from './mdx-component-runtime.ts';

export const STATE_LIMITS = {
  instanceBytes: 256 * 1024,
  docBytes: 2 * 1024 * 1024,
  depth: 8,
  writesPerSecond: 20,
} as const;

export function segments(path: StatePath): string[] {
  const parts = typeof path === 'string' ? (path === '' ? [] : path.split('.')) : [...path];
  return parts.map(String);
}

export const kb = (bytes: number) => Math.ceil(bytes / 1024);

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function depthOf(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  let deepest = 0;
  for (const v of Object.values(value)) deepest = Math.max(deepest, depthOf(v));
  return 1 + deepest;
}

/** Why `value` is not JSON, or null when it is. */
export function notJson(value: unknown, where: string): string | null {
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

export const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object';

export function indexIn(
  arr: { length: number },
  seg: string,
  path: string,
  extend: boolean,
): number {
  const i = /^\d+$/.test(seg) ? Number(seg) : -1;
  if (i < 0 || i > arr.length || (i === arr.length && !extend)) {
    throw new Error(`"${path}" names no item of its list.`);
  }
  return i;
}

/** The state `op` would leave, worked on a plain copy so a refusal changes
 *  nothing. Throws a message for a path that cannot be followed. */
export function applyPlain(state: Record<string, unknown>, segs: string[], op: PlainOp): unknown {
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

export type PlainOp =
  | { kind: 'set'; value: unknown }
  | { kind: 'push'; value: unknown }
  | { kind: 'delete' };

/** Why `op` at `segs` is refused before it is tried, or null. */
export function opRefusal(segs: string[], op: PlainOp): string | null {
  const where = segs.join('.') || '(the whole state)';
  if (segs.includes('__proto__')) return `State has no key "__proto__" (at "${where}").`;
  return op.kind === 'delete' ? null : notJson(op.value, where);
}

/** Why `next` as component `id`'s state is past the depth or the
 *  one-component size limit, or null. */
export function componentSizeRefusal(id: string, next: unknown): string | null {
  const depth = depthOf(next);
  if (depth > STATE_LIMITS.depth) {
    return `Component "${id}" state would be nested ${depth} levels deep, over the limit of ${STATE_LIMITS.depth}.`;
  }
  const bytes = byteLength(next);
  if (bytes > STATE_LIMITS.instanceBytes) {
    return `Component "${id}" state would be ${kb(bytes)} KB, over the 256 KB limit for one component. Keep large data in a file the component imports.`;
  }
  return null;
}

/**
 * Check one write against `state` (plain JSON, which is not changed) and
 * work out the state it would leave. A refusal says why. The snapshot hook's
 * whole check; the live hook adds the doc-wide limit.
 */
export function checkWrite(
  state: Record<string, unknown>,
  path: StatePath,
  op: PlainOp,
  id: string,
): { next: unknown } | { error: string } {
  const segs = segments(path);
  const bad = opRefusal(segs, op);
  if (bad) return { error: bad };
  let next: unknown;
  try {
    next = applyPlain(structuredClone(state), segs, op);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const over = componentSizeRefusal(id, next);
  return over ? { error: over } : { next };
}

/** The accepted write times still inside the last second at `t`. */
export function recentWrites(times: readonly number[], t: number): number[] {
  return times.filter((at) => t - at < 1000);
}

/** Why one more write now is too fast, given the second's accepted writes. */
export function rateRefusal(recent: readonly number[], id: string): string | null {
  return recent.length >= STATE_LIMITS.writesPerSecond
    ? `Component "${id}" wrote more than ${STATE_LIMITS.writesPerSecond} times a second, so this write was refused. Write a drag's position when it ends, or at most every 50 ms.`
    : null;
}
