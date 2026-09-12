/**
 * The diff behind the release wake — which rows one act made dispatchable.
 *
 * Driven directly rather than only through the route, because the rules that
 * matter here are about the SHAPE of the two readings: a board at its
 * parallelism cap presents an empty `ready` and a perfectly ready row, and a
 * reading that missed that would make a full board's release invisible while
 * every HTTP test on an uncapped board stayed green.
 */
import { describe, expect, it } from 'bun:test';
import { UNREADABLE_MARK, freedRows, readyMark } from '../src/ready-release.ts';

const rank = { id: 't-rank', title: 'Rank results by recency' };
const facets = { id: 't-facets', title: 'Cache the facet counts' };
const crawler = { id: 't-crawler', title: 'Rebuild the crawler queue' };

describe('readyMark', () => {
  it('counts the rows the cap trimmed as dispatchable', () => {
    // The cap is a fact about the whole board, not about any row. Reading only
    // `ready` would report a row as newly freed when all that happened was a
    // builder finishing and a slot opening.
    const mark = readyMark({ ready: [rank], capacityTrimmed: [facets] });
    expect(Array.from(mark.ids).sort()).toEqual([facets.id, rank.id]);
    expect(mark.readable).toBe(true);
  });

  it('marks an absent board UNREADABLE, not empty', () => {
    // A retired board, or a lookup that threw. The two spellings give the same
    // empty id set and mean opposite things: the diff subtracts `before` from
    // `after`, so recording an unreadable board as empty would make every ready
    // row come back as newly freed.
    expect(readyMark(undefined)).toBe(UNREADABLE_MARK);
    expect(readyMark(undefined).readable).toBe(false);
    // And a board that really is empty is readable — the silence below has to
    // come from the reading having failed, not from there being no rows.
    expect(readyMark({ ready: [] }).readable).toBe(true);
  });
});

describe('freedRows', () => {
  it('names only what was not dispatchable before', () => {
    const before = readyMark({ ready: [rank] });
    expect(freedRows(before, { ready: [rank, facets, crawler] })).toEqual([facets, crawler]);
  });

  it('says nothing when the act freed nothing', () => {
    const before = readyMark({ ready: [rank, facets] });
    // A person's transition that changed no readiness at all. Empty here is
    // what makes the wake silent rather than firing on every move.
    expect(freedRows(before, { ready: [rank, facets] })).toEqual([]);
    // And a row LEAVING the ready set is not a release either — closing a
    // blocker takes the blocker out of the set, which must not read as news.
    expect(freedRows(before, { ready: [rank] })).toEqual([]);
  });

  it('drops the row the caller’s own act named', () => {
    // A person moving a row to `todo` is `personQueuedTask`'s wake. Without
    // this the same move puts two frames on the channel about one row.
    const before = readyMark({ ready: [] });
    expect(freedRows(before, { ready: [rank, facets] }, rank.id)).toEqual([facets]);
  });

  it('frees a row the cap is holding, and is not fooled by a freed slot', () => {
    // Freed while the board is full: ready by the dependency gate, trimmed by
    // the cap, and still a row that just became dispatchable.
    const full = readyMark({ ready: [rank], capacityTrimmed: [] });
    expect(freedRows(full, { ready: [rank], capacityTrimmed: [facets] })).toEqual([facets]);
    // And the reverse: a row that only MOVED from the trimmed list into
    // `ready` because a slot opened was dispatchable all along.
    const trimmed = readyMark({ ready: [rank], capacityTrimmed: [facets] });
    expect(freedRows(trimmed, { ready: [rank, facets] })).toEqual([]);
  });

  it('frees a whole release that never reaches `ready`, on a board with no slot', () => {
    // The shape `readyWorkSnapshot` produces when every slot is busy: it trims
    // `ready` to the free slots, so a fully-occupied board presents an EMPTY
    // ready list at both readings and carries the entire release in
    // `capacityTrimmed`. A diff that read `ready` alone would answer nothing
    // here — and this is the board a lead most needs told, because the work is
    // piling up behind a cap they are the one who can move.
    const before = readyMark({ ready: [], capacityTrimmed: [rank] });
    expect(freedRows(before, { ready: [], capacityTrimmed: [rank, facets, crawler] })).toEqual([
      facets,
      crawler,
    ]);
  });

  it('keeps the board’s own priority order, ready before trimmed', () => {
    const before = readyMark({ ready: [] });
    expect(freedRows(before, { ready: [rank, facets], capacityTrimmed: [crawler] })).toEqual([
      rank,
      facets,
      crawler,
    ]);
  });

  it('names a row once even if both lists carry it', () => {
    const before = readyMark({ ready: [] });
    expect(freedRows(before, { ready: [rank], capacityTrimmed: [rank] })).toEqual([rank]);
  });

  it('frees nothing when the board cannot be read after the act', () => {
    expect(freedRows(readyMark({ ready: [] }), undefined)).toEqual([]);
  });

  it('frees nothing when the board could not be read BEFORE the act', () => {
    // The lookup threw mid-hydrate and the one after it succeeded. Every ready
    // row would otherwise read as newly released — a wake naming work nobody
    // released, which is worse than the missed wake it would be replacing.
    expect(freedRows(readyMark(undefined), { ready: [rank, facets] })).toEqual([]);
  });
});
