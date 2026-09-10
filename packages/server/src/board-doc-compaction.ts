/**
 * Shedding a board doc's CRDT history at hydrate, so the price of opening a
 * board is what it currently HOLDS rather than everything it ever held.
 *
 * A `ws:<workspaceId>.ydoc` is a full `encodeStateAsUpdate` snapshot, and a
 * Yjs snapshot carries every deleted struct's id range and the whole delete
 * set forever. The board's projection rewrites a whole row on every field
 * change, so a busy board tombstones a row per edit and pays for it on every
 * page load, in one sync-step-2 frame, for as long as the board exists.
 * Measured on the live board on 2026-09-09: 5,433,631 bytes persisted, of
 * which 1,967,098 was history — 1.60 MB on the wire against 1.10 MB for the
 * same content in a doc with no past.
 *
 * That is safe to drop HERE and nowhere else, for a reason specific to this
 * one kind of doc: a board doc is a PROJECTION. The task sidecar is the
 * source of truth, `TaskProjection.init` reasserts every row from the store
 * after load, and nothing in a `ws:` doc was ever typed by a person. Deleting
 * its history destroys no user content — this is the one place in the repo
 * where rebuilding a CRDT from its own contents is a compaction rather than
 * a data loss.
 *
 * Three guards keep that claim true rather than assumed:
 *
 *   - **Only maps.** A rebuild copies top-level entries, so a doc holding a
 *     Y.Text, a Y.Array or an XmlFragment would come back empty. Anything
 *     that is not a Y.Map declines the compaction, which is what stops this
 *     ever running over a `task:<id>` body doc or a bound document if a
 *     caller is later widened by mistake.
 *   - **Only at hydrate.** Every client resyncs from the server's state
 *     vector on connect, but a rebuild changes the clientIDs a doc's structs
 *     were written under, so a peer mid-session would see a doc it cannot
 *     merge into. At hydrate there are no peers.
 *   - **Only when it pays.** Below the floor, or when the rebuild is not
 *     materially smaller, the persisted bytes are used unchanged — so a doc
 *     that has nothing to shed pays a decode it would have paid anyway and
 *     nothing else.
 */
import * as Y from 'yjs';

/** Under this, a board doc is not worth rebuilding whatever its ratio. */
export const COMPACT_FLOOR_BYTES = 128 * 1024;

/** How much smaller the rebuild has to be before it is taken. 1.2 rather than
 *  1.0 so a doc hovering at the line is not rebuilt on every restart for a
 *  few hundred bytes. */
export const COMPACT_MIN_RATIO = 1.2;

/** What was decided, and the two readings behind it. */
export interface CompactionResult {
  /** The bytes to apply to the live doc — the rebuild, or the original. */
  update: Uint8Array;
  compacted: boolean;
  /** Why it declined, for the log. Null when it did not. */
  declined: 'under-floor' | 'not-worth-it' | 'not-all-maps' | null;
  beforeBytes: number;
  afterBytes: number;
}

/**
 * Read a persisted board doc and answer with the bytes worth applying.
 *
 * Pure over its input: it decodes into scratch docs of its own and hands back
 * an update, so the caller decides what to do with it and a test can drive it
 * with nothing but bytes.
 */
export function compactBoardState(persisted: Uint8Array): CompactionResult {
  const before = persisted.length;
  if (before < COMPACT_FLOOR_BYTES) {
    return {
      update: persisted,
      compacted: false,
      declined: 'under-floor',
      beforeBytes: before,
      afterBytes: before,
    };
  }
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, persisted);
  const names = topLevelMapNames(scratch);
  if (names === null) {
    return {
      update: persisted,
      compacted: false,
      declined: 'not-all-maps',
      beforeBytes: before,
      afterBytes: before,
    };
  }
  const rebuilt = new Y.Doc();
  rebuilt.transact(() => {
    for (const name of names) {
      const from = scratch.getMap(name);
      const to = rebuilt.getMap(name);
      from.forEach((value, key) => to.set(key, value));
    }
  });
  const update = Y.encodeStateAsUpdate(rebuilt);
  if (update.length * COMPACT_MIN_RATIO > before) {
    return {
      update: persisted,
      compacted: false,
      declined: 'not-worth-it',
      beforeBytes: before,
      afterBytes: before,
    };
  }
  return {
    update,
    compacted: true,
    declined: null,
    beforeBytes: before,
    afterBytes: update.length,
  };
}

/**
 * The doc's top-level names when every one of them is a Y.Map, else null.
 *
 * Yjs decides a shared type's class the first time it is materialised, so a
 * doc read straight off disk reports `AbstractType` for everything. Calling
 * `getMap(name)` is what commits each one — and it THROWS if that name was
 * written as another type, which is exactly the answer this needs. Reading
 * `_start`/`_map` internals instead would be a guess; the throw is the
 * library telling us.
 */
function topLevelMapNames(doc: Y.Doc): string[] | null {
  const names = [...doc.share.keys()];
  for (const name of names) {
    const type = doc.share.get(name);
    if (type === undefined) return null;
    // The class cannot be asked here, and that is the whole difficulty. A doc
    // decoded from an update holds UNTYPED `AbstractType`s in `share` until
    // something names them, so `getMap` RETYPES a Y.Text instead of throwing
    // and `instanceof Y.Map` then answers true about the thing it just
    // converted. The first version of this guard asked both of those
    // questions and a doc holding a Y.Text sailed through both.
    //
    // What survives decoding is the SHAPE. A list-like type — Text, Array,
    // XmlFragment — carries its content as items on `_start`; a map carries
    // its entries in `_map`. So anything holding list items is not a map,
    // whether or not it has been typed yet.
    if (type._start !== null) return null;
    // An already-typed non-map is still worth refusing outright: it costs
    // nothing and it is the case a future caller is most likely to create.
    if (type.constructor !== Y.AbstractType && !(type instanceof Y.Map)) return null;
  }
  return names;
}
