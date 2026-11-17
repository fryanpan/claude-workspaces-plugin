/**
 * The Starred rules over plain state: star, unstar, folders beside docs, and
 * one person's stars kept apart from another's.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'bun:test';
import { type StarState, isStarKind, setStar, starsFor } from '../src/library-stars.ts';

const all = () => true;

describe('library stars', () => {
  it('stars and unstars, newest first, and a repeat is no news', () => {
    const s: StarState = {};
    expect(setStar(s, 'known-alice', { kind: 'doc', id: 'd-plan' }, true, 1_000)).toBe(true);
    expect(setStar(s, 'known-alice', { kind: 'folder', id: 'f-1' }, true, 2_000)).toBe(true);
    expect(setStar(s, 'known-alice', { kind: 'doc', id: 'd-plan' }, true, 3_000)).toBe(false);
    expect(starsFor(s, 'known-alice', all)).toEqual([
      { kind: 'folder', id: 'f-1', at: 2_000 },
      { kind: 'doc', id: 'd-plan', at: 1_000 },
    ]);
    expect(setStar(s, 'known-alice', { kind: 'doc', id: 'd-plan' }, false, 4_000)).toBe(true);
    expect(setStar(s, 'known-alice', { kind: 'doc', id: 'd-plan' }, false, 5_000)).toBe(false);
    expect(starsFor(s, 'known-alice', all).map((x) => x.id)).toEqual(['f-1']);
  });

  it('a doc and a folder with the same id are two stars', () => {
    const s: StarState = {};
    setStar(s, 'known-alice', { kind: 'doc', id: 'x' }, true, 1);
    setStar(s, 'known-alice', { kind: 'folder', id: 'x' }, true, 2);
    setStar(s, 'known-alice', { kind: 'doc', id: 'x' }, false, 3);
    expect(starsFor(s, 'known-alice', all)).toEqual([{ kind: 'folder', id: 'x', at: 2 }]);
  });

  it('keeps each person’s stars apart, and drops what no longer exists', () => {
    const s: StarState = {};
    setStar(s, 'known-alice', { kind: 'doc', id: 'd-plan' }, true, 1);
    expect(starsFor(s, 'known-bob', all)).toEqual([]);
    expect(starsFor(s, null, all)).toEqual([]);
    expect(starsFor(s, 'known-alice', (x) => x.id !== 'd-plan')).toEqual([]);
  });

  it('names only the two kinds', () => {
    expect(isStarKind('doc')).toBe(true);
    expect(isStarKind('folder')).toBe(true);
    expect(isStarKind('task')).toBe(false);
    expect(isStarKind(undefined)).toBe(false);
  });
});
