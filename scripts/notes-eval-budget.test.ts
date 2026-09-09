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
import { DEFAULT_MAX_USD, SpendCapReached, costOf, overBudget } from './notes-eval.ts';

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
