/**
 * The bound on what a hold may say. Drives `boundHoldWords` over verdicts of
 * the shape the judge actually returns; the end-to-end proof that a filed
 * item's hold carries no invented figure is in
 * `packages/server/test/review-judge-loop.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  REVIEW_HOLD_UNUSABLE_REASON,
  boundHoldWords,
  gateNoteOf,
  hasNumberNotIn,
  holdCountWord,
  holdGapKey,
  judgedText,
  numberTokens,
  spelledNumbers,
} from './review-hold.ts';

const ITEM = judgedText({
  headline: 'Should the nightly rebuild keep its 2GB cache?',
  detail: 'It runs at 02:00 and the morning sync starts at 07:30.',
  options: [
    { label: 'Keep it', detail: 'no extra time' },
    { label: 'Halve it', detail: 'adds an hour' },
  ],
});

describe('boundHoldWords', () => {
  it('keeps a reason whose every figure is one the item states', () => {
    const out = boundHoldWords(
      { reason: 'The detail says 02:00 but never says what waits.' },
      ITEM,
    );
    expect(out.reason).toBe('The detail says 02:00 but never says what waits.');
  });

  it('replaces a reason carrying a figure the item does not state', () => {
    const out = boundHoldWords(
      { reason: 'The rebuild takes 45 minutes, so the detail understates the risk.' },
      ITEM,
    );
    expect(out.reason).toBe(REVIEW_HOLD_UNUSABLE_REASON);
    expect(out.reason).not.toContain('45');
  });

  it('reads a whole figure, not the digit runs inside it', () => {
    // The item carries 2GB and 07:30. A hold about "30GB" or "2:30" is about
    // a figure the item does not state, even though every DIGIT in it appears
    // somewhere — which is the hole a run-by-run check left open (codex
    // review).
    expect(hasNumberNotIn('30GB', ITEM)).toBe(true);
    expect(hasNumberNotIn('2:30', ITEM)).toBe(true);
    // …and the figures the item really does state still pass.
    expect(hasNumberNotIn('2GB at 02:00 and 07:30', ITEM)).toBe(false);
    expect(numberTokens('at 02:00, twice')).toEqual(['02:00']);
  });

  it('reads 1,200 and 1200 as one figure written two ways', () => {
    expect(numberTokens('1,200')).toEqual(['1200']);
    expect(hasNumberNotIn('1200 runs', 'about 1,200 runs')).toBe(false);
  });

  it('keeps a quote the item actually contains, whitespace aside', () => {
    const out = boundHoldWords(
      { reason: 'Those words name no stakes.', quote: 'the morning   sync starts' },
      ITEM,
    );
    expect(out.quote).toBe('the morning sync starts');
  });

  it('drops a quote the item does not contain', () => {
    const out = boundHoldWords(
      { reason: 'Those words name no stakes.', quote: 'the release train departs' },
      ITEM,
    );
    expect(out.quote).toBeUndefined();
    expect(out.reason).toBe('Those words name no stakes.');
  });

  it('drops an empty quote rather than showing empty quotation marks', () => {
    expect(boundHoldWords({ reason: 'No stakes.', quote: '   ' }, ITEM).quote).toBeUndefined();
  });
});

describe('a figure spelled out is still a figure', () => {
  it('replaces a reason inventing one in words', () => {
    const out = boundHoldWords(
      { reason: 'The rebuild takes forty-five minutes, so the detail understates the risk.' },
      ITEM,
    );
    expect(out.reason).toBe(REVIEW_HOLD_UNUSABLE_REASON);
  });

  it('keeps one the item states, in either spelling', () => {
    const item = judgedText({ headline: 'h', detail: 'the sweep runs every 90 minutes' });
    expect(hasNumberNotIn('every ninety minutes', item)).toBe(false);
    expect(hasNumberNotIn('every 90 minutes', item)).toBe(false);
  });

  it('leaves the small words alone, because they are ordinary English', () => {
    // "one" in "choosing one" is not a claim about a quantity, and dropping a
    // whole diagnosis over it would silence far more real holds than
    // fabrications.
    expect(hasNumberNotIn('No option says what choosing one costs.', ITEM)).toBe(false);
    expect(spelledNumbers('one two three')).toEqual([]);
  });
});

describe('holdCountWord', () => {
  it('writes the small counts as words, because a card is prose', () => {
    expect(holdCountWord(1)).toBe('once');
    expect(holdCountWord(2)).toBe('twice');
    expect(holdCountWord(3)).toBe('three times');
    expect(holdCountWord(4)).toBe('4 times');
  });
});

describe('judgedText', () => {
  it('carries the option words, so a figure stated only in an option is allowed', () => {
    const text = judgedText({ headline: 'h', options: [{ label: 'l', detail: 'costs 3 hours' }] });
    expect(hasNumberNotIn('three hours, or 3 of them', text)).toBe(false);
  });
});

describe('holdGapKey', () => {
  it('gives one key to a demand the judge is making again, punctuation and case aside', () => {
    expect(holdGapKey('The detail never says what waits.')).toBe(
      holdGapKey('the detail never says what waits'),
    );
  });

  it('gives different keys to different gaps, so a new defect is still holdable', () => {
    expect(holdGapKey('No option says what choosing it costs.')).not.toBe(
      holdGapKey('The detail never says what waits.'),
    );
  });

  it('shows the sentence to nobody — the key is opaque', () => {
    // The sentence keyed may be the invented one the gate refused to display.
    const key = holdGapKey('The rebuild takes 45 minutes.');
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(key).not.toContain('45');
  });
});

describe('gateNoteOf', () => {
  it('says nothing about an item the gate never held', () => {
    expect(gateNoteOf(undefined)).toBeUndefined();
    expect(gateNoteOf({})).toBeUndefined();
  });

  it('counts the holds an item carried to the reader', () => {
    expect(gateNoteOf({ heldFor: ['no stakes', 'no costs'] })).toEqual({ holds: 2 });
  });

  it('marks an item the gate stopped holding rather than passed', () => {
    expect(gateNoteOf({ heldFor: ['a', 'b'], admitted: 'holds' })).toEqual({
      holds: 2,
      admitted: 'holds',
    });
  });

  it("carries the filer's own words when that is how it got through", () => {
    expect(
      gateNoteOf({
        heldFor: ['a'],
        admitted: 'less-specific',
        lessSpecific: 'the source gives a range',
      }),
    ).toEqual({ holds: 1, admitted: 'less-specific', lessSpecific: 'the source gives a range' });
  });
});
