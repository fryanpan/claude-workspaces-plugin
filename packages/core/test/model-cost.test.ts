/**
 * The price table is the one number a person reads off the chooser and the
 * one number the meeting report states, so it gets its own tests: an
 * arithmetic nobody checked cannot settle an argument about a bill.
 *
 * The cases that earn their runtime are the ones that were WRONG in the
 * shipped code this replaces — cache tokens left out of the total, and a
 * model with no price silently reporting a meeting as free.
 */
import { describe, expect, test } from 'vitest';
import {
  CACHE_BREAK_EVEN_RATIO,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_PRICES_PER_MILLION,
  ZERO_USAGE,
  addUsage,
  dollars,
  formatDollars,
  formatPerHour,
  isPricedModel,
  modelFamily,
  modelPrice,
  perHour,
} from '../src/model-cost.ts';

const haiku = 'claude-haiku-4-5-20251001';

describe('what a call costs', () => {
  test('a million plain input tokens on Haiku costs its listed input price', () => {
    expect(dollars({ ...ZERO_USAGE, inputTokens: 1_000_000 }, haiku)).toBeCloseTo(1, 6);
  });

  test('output bills at the output rate, not the input one', () => {
    expect(dollars({ ...ZERO_USAGE, outputTokens: 1_000_000 }, haiku)).toBeCloseTo(5, 6);
  });

  test('cache reads bill at a tenth of input — the half the old sum left out', () => {
    const usage = { ...ZERO_USAGE, cacheReadTokens: 1_000_000 };
    expect(dollars(usage, haiku)).toBeCloseTo(CACHE_READ_MULTIPLIER, 6);
    // And the thing that made the old figure wrong: a mostly-cached call is
    // not free, so a total that drops cache reads is not the bill.
    expect(dollars(usage, haiku)).toBeGreaterThan(0);
  });

  test('cache writes bill above plain input, so caching a prompt once costs more', () => {
    const written = dollars({ ...ZERO_USAGE, cacheWriteTokens: 1_000_000 }, haiku);
    const plain = dollars({ ...ZERO_USAGE, inputTokens: 1_000_000 }, haiku);
    expect(written).toBeCloseTo(CACHE_WRITE_MULTIPLIER * plain, 6);
    expect(written).toBeGreaterThan(plain);
  });

  test('a cache below the break-even ratio loses money against sending it plain', () => {
    const write = 1_000_000;
    const under = Math.floor(CACHE_BREAK_EVEN_RATIO * write) - 1;
    const over = Math.ceil(CACHE_BREAK_EVEN_RATIO * write) + 1;
    const cached = (read: number): number =>
      dollars({ ...ZERO_USAGE, cacheReadTokens: read, cacheWriteTokens: write }, haiku);
    expect(cached(under)).toBeGreaterThan(
      dollars({ ...ZERO_USAGE, inputTokens: under + write }, haiku),
    );
    expect(cached(over)).toBeLessThan(dollars({ ...ZERO_USAGE, inputTokens: over + write }, haiku));
  });

  test('the four kinds add up together rather than one winning', () => {
    const usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 4_000,
    };
    const parts =
      dollars({ ...ZERO_USAGE, inputTokens: usage.inputTokens }, haiku) +
      dollars({ ...ZERO_USAGE, outputTokens: usage.outputTokens }, haiku) +
      dollars({ ...ZERO_USAGE, cacheReadTokens: usage.cacheReadTokens }, haiku) +
      dollars({ ...ZERO_USAGE, cacheWriteTokens: usage.cacheWriteTokens }, haiku);
    expect(dollars(usage, haiku)).toBeCloseTo(parts, 9);
  });
});

describe('which models the table can price', () => {
  test('a dated snapshot is priced as its family', () => {
    expect(modelFamily(haiku)).toBe('claude-haiku-4-5');
    expect(modelPrice(haiku)).toEqual(MODEL_PRICES_PER_MILLION['claude-haiku-4-5']);
  });

  test('an unknown model has no price and is reported as unpriced, not as free', () => {
    expect(modelPrice('claude-imaginary-9')).toBeUndefined();
    expect(isPricedModel('claude-imaginary-9')).toBe(false);
    // It contributes nothing — which is exactly why the caller has to be able
    // to ask, rather than read the zero as a measurement.
    expect(dollars({ ...ZERO_USAGE, inputTokens: 9_000_000 }, 'claude-imaginary-9')).toBe(0);
    expect(isPricedModel(haiku)).toBe(true);
  });

  test('the models this server actually calls are all priced', () => {
    for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'])
      expect(isPricedModel(model)).toBe(true);
  });
});

describe('adding usage up', () => {
  test('two records add field by field, and zero is the identity', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    expect(addUsage(a, ZERO_USAGE)).toEqual(a);
    expect(addUsage(a, a)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 8,
    });
  });
});

describe('the per-hour rate', () => {
  test('a cost over exactly an hour is that cost per hour', () => {
    expect(perHour(2.4, 3_600_000)).toBeCloseTo(2.4, 9);
  });

  test('a half-hour meeting costs twice as much per hour as its total', () => {
    expect(perHour(1.2, 1_800_000)).toBeCloseTo(2.4, 9);
  });

  test('a meeting of no measurable length has no rate, rather than zero or infinity', () => {
    expect(perHour(2, 0)).toBeNull();
    expect(perHour(2, -5)).toBeNull();
    expect(perHour(2, Number.NaN)).toBeNull();
  });
});

describe('how a figure is spelled', () => {
  test('a rate reads as the chooser row reads it', () => {
    expect(formatPerHour(0.6)).toBe('$0.60/hr');
    expect(formatPerHour(2.4449)).toBe('$2.44/hr');
  });

  test('a total reads in dollars and cents', () => {
    expect(formatDollars(1.8349)).toBe('$1.83');
    expect(formatDollars(0)).toBe('$0.00');
  });
});
