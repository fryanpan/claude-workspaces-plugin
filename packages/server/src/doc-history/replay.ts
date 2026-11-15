/**
 * Reading a doc's history: the doc as it was after a record, and who changed
 * each part of it since.
 *
 * Everything here works on records (`log.ts`) and fresh Y.Docs built from
 * them; nothing touches a live doc. A version is the last base at or before
 * the record, with every later update up to it applied, into a doc that keeps
 * deleted content (`gc: false`) so a reader can see what a change removed.
 *
 * A "part" is what a reader would point at:
 *
 *   - a key of a top-level map: a task on a board (`tasks`), a shape on a
 *     whiteboard (`elements`), one value of a component's state
 *     (`component-state:<id>`);
 *   - a top-level block of a list of nested types: a paragraph or heading of
 *     a markdown doc's prose, by its index in the doc now, or `removed`;
 *   - a whole top-level text or list of plain values.
 */
import * as Y from 'yjs';
import type { HistoryAuthor, HistoryRecord } from './log.ts';

/** Any shared type, as a doc's `share` holds it. */
export type AnyType = NonNullable<ReturnType<Y.Doc['share']['get']>>;

/** How a top-level type of a doc is read. */
export type RootKind = 'map' | 'text' | 'xml' | 'array';

/** What one top-level type holds, judged from its content. Null when it is
 *  empty, so there is nothing to read or restore. */
export function rootKindOf(type: AnyType): RootKind | null {
  if (type instanceof Y.Map) return 'map';
  if (type instanceof Y.Text) return 'text';
  if (type instanceof Y.XmlFragment) return 'xml';
  if (type instanceof Y.Array) return 'array';
  // A root nobody has asked for by type yet: read its items.
  for (let item = type._start; item; item = item.right) {
    const c = item.content;
    if (c instanceof Y.ContentString || c instanceof Y.ContentFormat) return 'text';
    if (c instanceof Y.ContentEmbed) return 'text';
    if (c instanceof Y.ContentType) {
      const t = c.type;
      return t instanceof Y.XmlElement || t instanceof Y.XmlText || t instanceof Y.XmlHook
        ? 'xml'
        : 'array';
    }
    if (c instanceof Y.ContentDeleted) continue;
    return 'array';
  }
  return type._map.size > 0 ? 'map' : null;
}

/** A top-level type, read as its kind. */
export type TypedRoot =
  | { kind: 'map'; type: Y.Map<unknown> }
  | { kind: 'text'; type: Y.Text }
  | { kind: 'xml'; type: Y.XmlFragment }
  | { kind: 'array'; type: Y.Array<unknown> };

/** The top-level type `name` of `doc`, as `kind`. Throws when the doc
 *  already holds it as another kind. */
export function typedRoot(doc: Y.Doc, name: string, kind: RootKind): TypedRoot {
  switch (kind) {
    case 'map':
      return { kind, type: doc.getMap(name) };
    case 'text':
      return { kind, type: doc.getText(name) };
    case 'xml':
      return { kind, type: doc.getXmlFragment(name) };
    case 'array':
      return { kind, type: doc.getArray(name) };
  }
}

/** The doc as it was after record `seq` (the last record when `seq` is past
 *  the end). A doc with no records at or before `seq` is empty. */
export function versionAt(records: readonly HistoryRecord[], seq: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  let start = -1;
  for (let i = Math.min(seq, records.length - 1); i >= 0; i--) {
    if (records[i]?.kind === 'base') {
      start = i;
      break;
    }
  }
  // No base: the log began before bases were written. Apply from the start.
  for (let i = Math.max(start, 0); i <= seq && i < records.length; i++) {
    const r = records[i];
    if (r) Y.applyUpdate(doc, r.update);
  }
  return doc;
}

/** The last record at or before `at` (epoch ms), or -1 when none is. */
export function seqAtTime(records: readonly HistoryRecord[], at: number): number {
  let seq = -1;
  for (const r of records) {
    if (r.at > at) break;
    seq = r.seq;
  }
  return seq;
}

/** One part a reader can point at, and everyone who changed it. */
export interface ChangedPart {
  root: string;
  /** A map's key. */
  key?: string;
  /** A block's index in the doc now. */
  index?: number;
  /** The block was removed. */
  removed?: true;
  authors: HistoryAuthor[];
  /** Seqs of the records that changed it, in order. */
  seqs: number[];
}

/** What a part is known by while records are replayed. */
type Identity = string | Y.Item;

interface Touch {
  root: string;
  key?: string;
  /** For a whole root (text, plain list): named by the root alone. */
  whole?: true;
  item?: Y.Item;
  authors: Map<string, HistoryAuthor>;
  seqs: number[];
}

/** The name each top-level type of `doc` is held under. */
function rootNames(doc: Y.Doc): Map<AnyType, string> {
  const names = new Map<AnyType, string>();
  for (const [name, type] of doc.share) names.set(type, name);
  return names;
}

/** Does this list root hold nested types, so each child is a part? */
function holdsBlocks(root: { _start: Y.Item | null }): boolean {
  for (let item = root._start; item; item = item.right) {
    if (item.content instanceof Y.ContentType) return true;
  }
  return false;
}

/** The parts one transaction changed, by identity. */
function partsOf(
  tr: Y.Transaction,
  names: Map<AnyType, string>,
): Map<Identity, Omit<Touch, 'authors' | 'seqs'>> {
  const out = new Map<Identity, Omit<Touch, 'authors' | 'seqs'>>();
  const addWhole = (root: string) => out.set(`w\0${root}`, { root, whole: true });
  const addKey = (root: string, key: string) => out.set(`k\0${root}\0${key}`, { root, key });
  const addItem = (root: string, item: Y.Item) => out.set(item, { root, item });
  for (const [type, keys] of tr.changed) {
    const rootName = names.get(type);
    if (rootName !== undefined) {
      // A change to a top-level type's own entries.
      for (const key of keys) {
        if (key !== null) {
          addKey(rootName, key);
          continue;
        }
        if (!holdsBlocks(type)) {
          addWhole(rootName);
          continue;
        }
        // Its list of blocks changed: the blocks inserted or deleted here.
        for (let item = type._start; item; item = item.right) {
          const before = tr.beforeState.get(item.id.client) ?? 0;
          if (item.id.clock >= before || Y.isDeleted(tr.deleteSet, item.id))
            addItem(rootName, item);
        }
      }
      continue;
    }
    // A nested type: the part is the top-level entry it sits in.
    let child: Y.Item | null = type._item;
    while (child) {
      const parent = child.parent as AnyType;
      const name = names.get(parent);
      if (name !== undefined) {
        if (child.parentSub !== null) addKey(name, child.parentSub);
        else addItem(name, child);
        break;
      }
      child = parent._item;
    }
  }
  return out;
}

/** A child's content, for matching blocks across a base. */
function fingerprint(item: Y.Item): string {
  const c = item.content;
  if (c instanceof Y.ContentType) return JSON.stringify(c.type.toJSON());
  return JSON.stringify(c.getContent());
}

/** Every part that differs between two docs, by value. Used across a base,
 *  where the doc's items are new and identity says nothing. */
function diffByValue(before: Y.Doc, after: Y.Doc): Map<Identity, Omit<Touch, 'authors' | 'seqs'>> {
  const out = new Map<Identity, Omit<Touch, 'authors' | 'seqs'>>();
  const names = new Set([...before.share.keys(), ...after.share.keys()]);
  for (const name of names) {
    const a = after.share.get(name);
    const b = before.share.get(name);
    const kind = (a && rootKindOf(a)) ?? (b && rootKindOf(b)) ?? null;
    if (!kind) continue;
    const ra = typedRoot(after, name, kind);
    const rb = typedRoot(before, name, kind);
    const ta = ra.type;
    const tb = rb.type;
    if (ra.kind === 'map' && rb.kind === 'map') {
      const ma = ra.type.toJSON();
      const mb = rb.type.toJSON();
      for (const key of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
        if (JSON.stringify(ma[key]) !== JSON.stringify(mb[key])) {
          out.set(`k\0${name}\0${key}`, { root: name, key });
        }
      }
    } else if (kind === 'text' || !holdsBlocks(ta)) {
      if (JSON.stringify(ta.toJSON()) !== JSON.stringify(tb.toJSON())) {
        out.set(`w\0${name}`, { root: name, whole: true });
      }
    } else {
      const seen = new Map<string, number>();
      for (let i = tb._start; i; i = i.right) {
        if (i.deleted) continue;
        const f = fingerprint(i);
        seen.set(f, (seen.get(f) ?? 0) + 1);
      }
      for (let i = ta._start; i; i = i.right) {
        if (i.deleted) continue;
        const f = fingerprint(i);
        const n = seen.get(f) ?? 0;
        if (n > 0) seen.set(f, n - 1);
        else out.set(i, { root: name, item: i });
      }
    }
  }
  return out;
}

/** Carry block identities across a base: each touched block of `before` to
 *  the unclaimed block of `after` with the same content, or to nothing. */
function remapBlocks(touched: Map<Identity, Touch>, after: Y.Doc): Map<Identity, Touch> {
  const pool = new Map<string, Y.Item[]>();
  for (const [name, type] of after.share) {
    for (let i = type._start; i; i = i.right) {
      if (i.deleted) continue;
      const k = `${name}\0${fingerprint(i)}`;
      pool.set(k, [...(pool.get(k) ?? []), i]);
    }
  }
  const out = new Map<Identity, Touch>();
  let gone = 0;
  for (const [id, t] of touched) {
    if (!t.item) {
      out.set(id, t);
      continue;
    }
    const match = t.item.deleted
      ? undefined
      : pool.get(`${t.root}\0${fingerprint(t.item)}`)?.shift();
    // A block the base no longer holds keeps its old item, which reads as removed.
    out.set(match ?? `gone\0${gone++}`, match ? { ...t, item: match } : t);
  }
  return out;
}

const authorKey = (a: HistoryAuthor): string => JSON.stringify(a);

function touch(
  touched: Map<Identity, Touch>,
  parts: Map<Identity, Omit<Touch, 'authors' | 'seqs'>>,
  rec: HistoryRecord,
): void {
  for (const [id, part] of parts) {
    let t = touched.get(id);
    if (!t) {
      t = { ...part, authors: new Map(), seqs: [] };
      touched.set(id, t);
    }
    t.authors.set(authorKey(rec.author), rec.author);
    if (t.seqs[t.seqs.length - 1] !== rec.seq) t.seqs.push(rec.seq);
  }
}

/** Index of a live block among its root's present children. */
function indexOf(item: Y.Item): number {
  let n = 0;
  for (let i = (item.parent as AnyType)._start; i && i !== item; i = i.right) {
    if (!i.deleted) n += i.length;
  }
  return n;
}

/**
 * Every part changed after record `sinceSeq`, with who changed it, in the
 * order the doc holds them now. `sinceSeq` -1 counts every record.
 */
export function changesSince(records: readonly HistoryRecord[], sinceSeq: number): ChangedPart[] {
  let doc = versionAt(records, sinceSeq);
  let touched = new Map<Identity, Touch>();
  for (const rec of records) {
    if (rec.seq <= sinceSeq) continue;
    if (rec.kind === 'base') {
      const next = new Y.Doc({ gc: false });
      Y.applyUpdate(next, rec.update);
      const parts = diffByValue(doc, next);
      touched = remapBlocks(touched, next);
      touch(touched, parts, rec);
      doc.destroy();
      doc = next;
      continue;
    }
    let parts = new Map<Identity, Omit<Touch, 'authors' | 'seqs'>>();
    const onTr = (tr: Y.Transaction) => {
      parts = partsOf(tr, rootNames(doc));
    };
    doc.on('afterTransaction', onTr);
    Y.applyUpdate(doc, rec.update);
    doc.off('afterTransaction', onTr);
    touch(touched, parts, rec);
  }
  const out: ChangedPart[] = [];
  for (const t of touched.values()) {
    const base = { root: t.root, authors: [...t.authors.values()], seqs: t.seqs };
    if (t.item) {
      out.push(t.item.deleted ? { ...base, removed: true } : { ...base, index: indexOf(t.item) });
    } else if (t.key !== undefined) out.push({ ...base, key: t.key });
    else out.push(base);
  }
  doc.destroy();
  return out.sort(
    (a, b) =>
      a.root.localeCompare(b.root) ||
      (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) ||
      (a.key ?? '').localeCompare(b.key ?? ''),
  );
}
