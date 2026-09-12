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
import { NO_READY_MARK, freedRows, readyMark } from '../src/ready-release.ts';

const rank = { id: 't-rank', title: 'Rank results by recency' };
const facets = { id: 't-facets', title: 'Cache the facet counts' };
const crawler = { id: 't-crawler', title: 'Rebuild the crawler queue' };

describe('readyMark', () => {
  it('counts the rows the cap trimmed as dispatchable', () => {
    // The cap is a fact about the whole board, not about any row. Reading only
    // `ready` would report a row as newly freed when all that happened was a
    // builder finishing and a slot opening.
    const mark = readyMark({ ready: [rank], capacityTrimmed: [facets] });
    expect(Array.from(mark).sort()).toEqual([facets.id, rank.id]);
  });

  it('marks an absent board as empty rather than throwing', () => {
    // A retired board, or a lookup that threw. Empty is the safe direction:
    // the release then frees nothing it can name, where the alternative is
    // announcing every ready row on the board as just released.
    expect(readyMark(undefined)).toBe(NO_READY_MARK);
    expect(readyMark(undefined).size).toBe(0);
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
});
