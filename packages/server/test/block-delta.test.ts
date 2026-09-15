/**
 * `blockDelta` — the measurement the bound-file drop guard reads.
 *
 * Pure and exported for exactly this: the rule that decides whether a doc's
 * own copy is kept before an incoming file wins can be pinned without a
 * filesystem, a doc or a clock. The behaviour that rides on it — what is
 * actually kept, and what is announced — is `bound-file-drop.test.ts`.
 *
 * The case worth naming here: a section SWAPPED for another of the same size
 * leaves every count at zero net, so counts alone cannot tell the loudest
 * possible loss from somebody rewording a paragraph. The heading does.
 */
import { describe, expect, it } from 'bun:test';
import { blockDelta } from '../src/file-binding.ts';

describe('blockDelta', () => {
  it('sees a rewrite as one out and one in, so the net is zero', () => {
    expect(blockDelta(['a', 'b', 'c'], ['a', 'B!', 'c'])).toEqual({
      removed: 1,
      added: 1,
      net: 0,
      removedHeadings: 0,
    });
  });

  it('sees an addition as nothing removed', () => {
    expect(blockDelta(['a', 'b'], ['a', 'b', 'c'])).toEqual({
      removed: 0,
      added: 1,
      net: 0,
      removedHeadings: 0,
    });
  });

  it('sees a deletion as a net loss', () => {
    expect(blockDelta(['a', 'b', 'c', 'd'], ['a', 'b'])).toEqual({
      removed: 2,
      added: 0,
      net: 2,
      removedHeadings: 0,
    });
  });

  it('sees a same-size SWAP as removals with a zero net — the case a net-only rule misses', () => {
    expect(blockDelta(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd'])).toEqual({
      removed: 2,
      added: 2,
      net: 0,
      removedHeadings: 0,
    });
  });

  it('counts the net when a copy both deletes and rewrites', () => {
    expect(blockDelta(['a', 'b', 'c', 'd'], ['a', 'B!'])).toEqual({
      removed: 3,
      added: 1,
      net: 2,
      removedHeadings: 0,
    });
  });

  it('counts a duplicate that came back once, which a set would miss', () => {
    expect(blockDelta(['a', 'a'], ['a'])).toEqual({
      removed: 1,
      added: 0,
      net: 1,
      removedHeadings: 0,
    });
  });

  it('counts nothing for identical content in any order', () => {
    expect(blockDelta(['a', 'b'], ['b', 'a'])).toEqual({
      removed: 0,
      added: 0,
      net: 0,
      removedHeadings: 0,
    });
  });

  it('does not separate an ordinary reword from a section swap on block COUNTS', () => {
    // The measured reason `removed` cannot be the trigger: a three-paragraph
    // reword removes as many blocks as a whole section being swapped out, and
    // both leave the net at zero. No threshold on either could serve both.
    const reword = blockDelta(['t', 'p1', 'p2', 'p3'], ['t', 'P1', 'P2', 'P3']);
    const swap = blockDelta(['t', '## n', 'n1', 'n2'], ['t', '## r', 'r1', 'r2']);
    expect(reword.removed).toBe(swap.removed);
    expect(reword.added).toBe(swap.added);
    expect(reword.net).toBe(swap.net);
  });

  it('DOES separate them on the heading: a swap takes one, a reword takes none', () => {
    // The trigger the copy actually uses. A section cannot leave without its
    // heading leaving; paragraphs under a heading can be rewritten all day
    // without touching it.
    const reword = blockDelta(['t', 'p1', 'p2', 'p3'], ['t', 'P1', 'P2', 'P3']);
    const swap = blockDelta(['t', '## n', 'n1', 'n2'], ['t', '## r', 'r1', 'r2']);
    expect(reword.removedHeadings).toBe(0);
    expect(swap.removedHeadings).toBe(1);
  });

  it('counts a heading at any level, and only where the serializer puts one', () => {
    const delta = blockDelta(
      ['# one', '###### six', '```\n# not a heading\n```', '- # not one either'],
      [],
    );
    expect(delta.removed).toBe(4);
    expect(delta.removedHeadings).toBe(2);
  });
});
