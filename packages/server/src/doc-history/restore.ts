/**
 * Putting an earlier version back into a live doc, as one ordinary change.
 *
 * A restore never replaces the doc. It edits the live doc forward until each
 * top-level type reads as it did in the earlier version, touching only what
 * differs: a map's changed keys, a list's changed middle run of blocks, a
 * text's changed middle. Blocks that did not change keep their identity, so
 * a comment anchored in them stays anchored, and every page syncs the
 * restore like any other edit. Nothing the restore removes is lost: it is in
 * the history the restore was read from, and the version before the restore
 * is a record of its own (`recorder.ts`).
 *
 * Roots named in `skip` are left alone. The recorder skips `meta`, which the
 * server owns, and `threads`: a comment thread is a conversation about the
 * doc, not a version of it.
 */
import * as Y from 'yjs';
import { type RootKind, type TypedRoot, rootKindOf, typedRoot } from './replay.ts';

const json = (v: unknown): string => JSON.stringify(v instanceof Y.AbstractType ? v.toJSON() : v);

/** A value from the earlier doc, made fit to insert into the live one. */
function copyOf(v: unknown): unknown {
  if (v instanceof Y.AbstractType) return (v as { clone(): unknown }).clone();
  return v;
}

/** Same JSON and, for a shared type, the same kind of type. */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Y.AbstractType || b instanceof Y.AbstractType) {
    if (!(a instanceof Y.AbstractType && b instanceof Y.AbstractType)) return false;
    if (a.constructor !== b.constructor) return false;
  }
  return json(a) === json(b);
}

function restoreMap(live: Y.Map<unknown>, past: Y.Map<unknown>): void {
  for (const key of [...live.keys()]) if (!past.has(key)) live.delete(key);
  for (const [key, was] of past.entries()) {
    const now = live.get(key);
    if (same(now, was)) continue;
    // A nested map edits in place, so a change to one of its keys stays one key.
    if (now instanceof Y.Map && was instanceof Y.Map) restoreMap(now, was);
    else live.set(key, copyOf(was));
  }
}

/** Replace the run between the common head and tail of two lists. */
function restoreList(
  live: Y.Array<unknown> | Y.XmlFragment,
  past: Y.Array<unknown> | Y.XmlFragment,
): void {
  const now = live.toArray() as unknown[];
  const was = past.toArray() as unknown[];
  let head = 0;
  while (head < now.length && head < was.length && same(now[head], was[head])) head++;
  let tail = 0;
  while (
    tail < now.length - head &&
    tail < was.length - head &&
    same(now[now.length - 1 - tail], was[was.length - 1 - tail])
  ) {
    tail++;
  }
  const removed = now.length - head - tail;
  if (removed > 0) live.delete(head, removed);
  const inserted = was.slice(head, was.length - tail).map(copyOf);
  if (inserted.length > 0) {
    // Both list kinds take an array of values at an index.
    (live as Y.Array<unknown>).insert(head, inserted);
  }
}

function plainText(delta: Array<{ insert?: unknown; attributes?: unknown }>): boolean {
  return delta.every((op) => typeof op.insert === 'string' && op.attributes === undefined);
}

function restoreText(live: Y.Text, past: Y.Text): void {
  const nowDelta = live.toDelta() as Array<{ insert?: unknown; attributes?: unknown }>;
  const wasDelta = past.toDelta() as Array<{ insert?: unknown; attributes?: unknown }>;
  if (!plainText(nowDelta) || !plainText(wasDelta)) {
    if (JSON.stringify(nowDelta) === JSON.stringify(wasDelta)) return;
    live.delete(0, live.length);
    live.applyDelta(wasDelta);
    return;
  }
  const now = live.toString();
  const was = past.toString();
  let head = 0;
  while (head < now.length && head < was.length && now[head] === was[head]) head++;
  let tail = 0;
  while (
    tail < now.length - head &&
    tail < was.length - head &&
    now[now.length - 1 - tail] === was[was.length - 1 - tail]
  ) {
    tail++;
  }
  if (now.length - head - tail > 0) live.delete(head, now.length - head - tail);
  if (was.length - head - tail > 0) live.insert(head, was.slice(head, was.length - tail));
}

/** The kind to read a root as: what the live doc already calls it, else
 *  what either side's content says. Null when neither holds anything. */
function kindFor(live: Y.Doc, past: Y.Doc, name: string): RootKind | null {
  const l = live.share.get(name);
  const p = past.share.get(name);
  return (l && rootKindOf(l)) ?? (p && rootKindOf(p)) ?? null;
}

/**
 * Edit `live` so every root not in `skip` reads as it does in `past`. Runs
 * inside the caller's transaction. Returns the roots it changed. A root the
 * live doc holds under a different type than its content suggests is left
 * alone and named in `refused`.
 */
export function applyVersion(
  live: Y.Doc,
  past: Y.Doc,
  skip: ReadonlySet<string>,
): { changed: string[]; refused: string[] } {
  const changed: string[] = [];
  const refused: string[] = [];
  const names = new Set([...live.share.keys(), ...past.share.keys()]);
  for (const name of [...names].sort()) {
    if (skip.has(name)) continue;
    const kind = kindFor(live, past, name);
    if (!kind) continue;
    let l: TypedRoot;
    let p: TypedRoot;
    try {
      l = typedRoot(live, name, kind);
      p = typedRoot(past, name, kind);
    } catch {
      refused.push(name);
      continue;
    }
    const before = json(l.type);
    if (l.kind === 'map' && p.kind === 'map') restoreMap(l.type, p.type);
    else if (l.kind === 'text' && p.kind === 'text') restoreText(l.type, p.type);
    else if (l.kind === 'xml' && p.kind === 'xml') restoreList(l.type, p.type);
    else if (l.kind === 'array' && p.kind === 'array') restoreList(l.type, p.type);
    if (json(l.type) !== before) changed.push(name);
  }
  return { changed, refused };
}
