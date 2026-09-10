/**
 * Dropping a board doc's past, and refusing to drop anybody else's.
 *
 * A `ws:` doc is a projection whose source of truth is the task sidecar, so
 * rebuilding it from its own contents sheds CRDT history that has no reader.
 * The measurement that made it worth doing: the live board persisted at
 * 5,433,631 bytes with 1,967,098 of that history, and every browser paid for
 * it in one sync frame on every load.
 *
 * What these drive is the set of guards that keep "safe here" from becoming
 * "safe anywhere": only maps, only when it pays, and content identical
 * afterwards. The last one is the assertion that would catch a rebuild
 * quietly emptying a document.
 */
import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import {
  COMPACT_FLOOR_BYTES,
  COMPACT_MIN_RATIO,
  compactBoardState,
} from '../src/board-doc-compaction.ts';

/**
 * A board doc with a real history: every row rewritten many times, which is
 * what the projection does on every field change.
 *
 * ONE TRANSACTION PER ROW, and that detail is the fixture. Yjs garbage-
 * collects the CONTENT of an overwritten map value either way, so what a
 * rebuild actually sheds is the delete SET — the id ranges of everything that
 * has been superseded. Ranges written in one transaction stay contiguous and
 * encode in a few bytes, so a fixture that rewrote every row inside a single
 * `transact` produced a doc with a ratio of exactly 1.00 and made both
 * assertions below vacuous. The projection does not write that way: a board
 * write refreshes the handful of rows that changed, so months of use leave
 * thousands of small non-adjacent ranges. Writing per row is what models
 * that, and it takes this fixture to 1.77 against the live board's 1.57.
 */
function churnedBoard(rows: number, rewrites: number): Y.Doc {
  const doc = new Y.Doc();
  const tasks = doc.getMap('tasks');
  doc.getMap('workspace').set('name', 'harbor-relay');
  for (let pass = 0; pass < rewrites; pass++) {
    for (let i = 0; i < rows; i++) {
      doc.transact(() => {
        tasks.set(`t-${i}`, { id: `t-${i}`, title: `row ${i}`, pass, blurb: 'x'.repeat(400) });
      });
    }
  }
  return doc;
}

/** Every top-level map's contents, as plain JSON — what must survive. */
function contents(update: Uint8Array): Record<string, unknown> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const out: Record<string, unknown> = {};
  for (const name of doc.share.keys()) out[name] = doc.getMap(name).toJSON();
  return out;
}

describe('compacting a board doc', () => {
  const persisted = Y.encodeStateAsUpdate(churnedBoard(300, 40));

  it('sheds the history and keeps every byte of content', () => {
    const result = compactBoardState(persisted);
    expect(result.compacted).toBe(true);
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
    // The assertion the whole design rests on: same board, no past.
    expect(contents(result.update)).toEqual(contents(persisted));
  });

  it('is worth doing on a churned board — the fixture has a past to shed', () => {
    // Positive control. A rebuild that saved nothing would still report
    // `compacted: false` and every other assertion here would be vacuous.
    const result = compactBoardState(persisted);
    expect(result.beforeBytes / result.afterBytes).toBeGreaterThan(COMPACT_MIN_RATIO);
  });

  it('leaves a small doc alone whatever its shape', () => {
    const small = Y.encodeStateAsUpdate(churnedBoard(1, 1));
    expect(small.length).toBeLessThan(COMPACT_FLOOR_BYTES);
    const result = compactBoardState(small);
    expect(result.compacted).toBe(false);
    expect(result.declined).toBe('under-floor');
    expect(result.update).toBe(small);
  });

  it('leaves a large doc with nothing to shed alone', () => {
    // Written once, never rewritten: the rebuild would be the same size, and
    // paying a re-encode plus a fresh set of clientIDs for nothing is worse
    // than doing nothing.
    const fresh = Y.encodeStateAsUpdate(churnedBoard(600, 1));
    expect(fresh.length).toBeGreaterThan(COMPACT_FLOOR_BYTES);
    expect(compactBoardState(fresh).declined).toBe('not-worth-it');
  });

  it('refuses a doc that holds anything but maps', () => {
    // The guard that stops this ever running over prose. A rebuild copies
    // top-level map entries, so a doc with a text or a fragment in it would
    // come back EMPTY — which is why the refusal is asserted rather than
    // assumed, and why the content check above would not have caught it.
    const doc = new Y.Doc();
    doc.getMap('tasks').set('t-1', { blurb: 'x'.repeat(200_000) });
    doc.getText('prose').insert(0, 'y'.repeat(2_000));
    const update = Y.encodeStateAsUpdate(doc);
    expect(update.length).toBeGreaterThan(COMPACT_FLOOR_BYTES);
    const result = compactBoardState(update);
    expect(result.declined).toBe('not-all-maps');
    expect(result.compacted).toBe(false);
  });
});
