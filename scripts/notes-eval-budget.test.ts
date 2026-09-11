/**
 * The spend cap: the only part of "this must not cost more than a dollar a
 * day" that a machine can keep.
 *
 * A measured estimate says what yesterday cost. The run that matters is the
 * one where a fixture grew, a retry loop misbehaved, or somebody pointed
 * `--corpus` at three hundred meetings — and on that run an estimate arrives
 * after the money is gone. So the arithmetic below is what stops it.
 */
import { describe, expect, it } from 'vitest';
import {
  CACHE_BREAK_EVEN_RATIO,
  DEFAULT_MAX_USD,
  SpendCapReached,
  cacheVerdict,
  costOf,
  overBudget,
} from './notes-eval.ts';

const prices = {
  cheap: { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  dear: { input: 3 / 1_000_000, output: 15 / 1_000_000 },
};

describe('what a run has spent', () => {
  it('prices input and output separately, per model', () => {
    const spent = costOf({ cheap: { input: 1_000_000, output: 1_000_000 } }, prices);
    expect(spent).toBeCloseTo(6);
  });

  it('adds every model together, not just the busiest', () => {
    const spent = costOf(
      { cheap: { input: 1_000_000, output: 0 }, dear: { input: 1_000_000, output: 0 } },
      prices,
    );
    expect(spent).toBeCloseTo(4);
  });

  it('counts an unpriced model as nothing rather than throwing', () => {
    // A judge model added without its price must not abort a run. It is then
    // invisible to the cap, which is why the price goes in the same commit.
    expect(costOf({ unknown: { input: 9_000_000, output: 9_000_000 } }, prices)).toBe(0);
  });

  it('is zero before anything has been called', () => {
    expect(costOf({}, prices)).toBe(0);
  });

  // The prompt the note-taker sends is cached, and the API reports a cached
  // prompt's bulk under `cache_read_input_tokens` rather than under
  // `input_tokens`. A cost function that reads only the latter therefore
  // prices a heavily-cached run at a fraction of its bill — and the cap,
  // which exists to stop a runaway, reads that same fraction.
  it('prices a cache read at a tenth of input', () => {
    const spent = costOf({ cheap: { input: 0, output: 0, cacheRead: 1_000_000 } }, prices);
    expect(spent).toBeCloseTo(0.1);
  });

  it('prices a cache write above input, not below it', () => {
    const spent = costOf({ cheap: { input: 0, output: 0, cacheWrite: 1_000_000 } }, prices);
    expect(spent).toBeCloseTo(1.25);
  });

  it('bills the cached bulk that input_tokens no longer carries', () => {
    // One tick of the shape the notes pipeline actually sends: a small
    // uncached tail, the rest served from cache. Counting input alone would
    // have called this $0.001.
    const spent = costOf(
      { cheap: { input: 1_000, output: 100, cacheRead: 5_000_000, cacheWrite: 0 } },
      prices,
    );
    expect(spent).toBeCloseTo(0.001 + 0.0005 + 0.5);
  });

  it('still prices a model that reported no cache fields at all', () => {
    // Every existing caller passes two fields, and an uncached path reports
    // no cache tokens. Neither may become NaN.
    expect(costOf({ cheap: { input: 1_000_000, output: 0 } }, prices)).toBeCloseTo(1);
  });
});

describe('whether the cache is paying for itself', () => {
  // THE SHARE SERVED FROM CACHE IS NOT THE VERDICT. A run can serve half its
  // prompt from cache and cost MORE than one that cached nothing, because
  // each of those reads was bought with a write at 1.25x. Only the ratio
  // says which, and a dollar figure alone has hidden a losing cache before.
  it('calls a cache that writes four times what it reads a loss, and prices agree', () => {
    const losing = { cheap: { input: 0, output: 0, cacheRead: 250_000, cacheWrite: 1_000_000 } };
    expect(cacheVerdict(250_000, 1_000_000)).toContain('LOSING MONEY');
    // The claim under the word: sending those tokens plain would have been
    // cheaper than caching them.
    expect(costOf(losing, prices)).toBeGreaterThan(
      costOf({ cheap: { input: 1_250_000, output: 0 } }, prices),
    );
  });

  it('calls writing a little more than it reads a WIN, because 1:1 is not the bar', () => {
    // The trap this exists for. "Writes outran reads" reads like a losing
    // cache and is not one: the bar is 0.28, not 1. A run at 0.75 — which is
    // what an hour of meeting measured before the chunks — was paying, badly.
    expect(cacheVerdict(750_000, 1_000_000)).toContain('paying');
    expect(
      costOf({ cheap: { input: 0, output: 0, cacheRead: 750_000, cacheWrite: 1_000_000 } }, prices),
    ).toBeLessThan(costOf({ cheap: { input: 1_750_000, output: 0 } }, prices));
  });

  it('calls a cache that reads far more than it writes a win, and prices agree', () => {
    const paying = { cheap: { input: 0, output: 0, cacheRead: 1_800_000, cacheWrite: 180_000 } };
    expect(cacheVerdict(1_800_000, 180_000)).toContain('paying');
    expect(costOf(paying, prices)).toBeLessThan(
      costOf({ cheap: { input: 1_980_000, output: 0 } }, prices),
    );
  });

  it('puts the break-even exactly where the two prices meet', () => {
    // Just under and just over the published ratio, checked against the
    // arithmetic rather than against the constant restating itself.
    const w = 1_000_000;
    const under = Math.floor(CACHE_BREAK_EVEN_RATIO * w) - 1;
    const over = Math.ceil(CACHE_BREAK_EVEN_RATIO * w) + 1;
    expect(cacheVerdict(under, w)).toContain('LOSING MONEY');
    expect(cacheVerdict(over, w)).toContain('paying');
    expect(
      costOf({ cheap: { input: 0, output: 0, cacheRead: under, cacheWrite: w } }, prices),
    ).toBeGreaterThan(costOf({ cheap: { input: under + w, output: 0 } }, prices));
  });

  it('a run that wrote nothing is not a division by zero', () => {
    expect(cacheVerdict(5_000, 0)).toContain('nothing written');
  });
});

describe('whether the run may keep going', () => {
  it('stops once spend is past the cap, not when it merely reaches it', () => {
    expect(overBudget(0.99, 1)).toBe(false);
    expect(overBudget(1, 1)).toBe(false);
    expect(overBudget(1.0001, 1)).toBe(true);
  });

  it('treats a cap of zero as uncapped, not as spend-nothing', () => {
    // `--max-usd 0` is how somebody says "run the whole corpus, I know". If
    // zero meant a zero budget the first call of every full run would abort.
    expect(overBudget(500, 0)).toBe(false);
  });

  it('never stops a run that has spent nothing', () => {
    expect(overBudget(0, 1)).toBe(false);
    expect(overBudget(0, 0)).toBe(false);
  });

  it('caps at a dollar a day by default', () => {
    // Bryan's number. A change here changes what CI is allowed to spend.
    expect(DEFAULT_MAX_USD).toBe(1);
  });
});

describe('what the abort says', () => {
  it('names both the spend and the cap it broke', () => {
    // The number is the reason the run stopped. A reader who sees only
    // "aborted" goes looking for a bug instead of at the corpus.
    const err = new SpendCapReached(1.2345, 1);
    expect(err.message).toContain('1.2345');
    expect(err.message).toContain('1.00');
    expect(err).toBeInstanceOf(Error);
  });
});
