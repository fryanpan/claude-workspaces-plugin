/**
 * WHAT A MODEL CALL COST, from one table both ends read.
 *
 * The chooser used to print `$0.60/hr` from a one-off eval and the eval
 * printed its own total from a second copy of the same multiplication. Two
 * copies of a price is two numbers that drift apart in a direction nobody
 * notices, and the direction they drifted was cheap: the chooser said sixty
 * cents an hour for a meeting whose compose alone billed about two dollars
 * and whose capture pass was never counted at all. So the prices live here,
 * once, and every reader — chooser, meeting report, eval harness — multiplies
 * through the same function.
 *
 * IN CORE BECAUSE BOTH ENDS READ IT. The server prices a finished meeting
 * from stored token counts; the browser renders the figure on a chooser row.
 * A table in the server could not be read by the second, and a table in the
 * client could not be trusted by the first.
 *
 * CACHED TOKENS ARE THE HALF THAT GETS FORGOTTEN. `input_tokens` off the API
 * is the UNCACHED remainder only — a prompt served mostly from cache reports
 * a small input and carries the rest in `cache_read_input_tokens`. Summing
 * input and output alone therefore prices a cached meeting at a fraction of
 * its bill. Both cache counts are here, priced as multipliers of the model's
 * own input rate so a price change moves one number rather than three.
 */

/**
 * What one call reported, in tokens, exactly as the API's `usage` block
 * spells it out. Four numbers rather than one total because the four bill at
 * four different rates.
 */
export interface TokenUsage {
  /** Fresh input tokens, billed at the full rate. */
  inputTokens: number;
  outputTokens: number;
  /** Served from an existing cache entry, billed at a tenth. */
  cacheReadTokens: number;
  /** Written into a new cache entry, billed at 1.25x. */
  cacheWriteTokens: number;
}

/** Dollars per token, input and output, for one model. */
export interface ModelPrice {
  input: number;
  output: number;
}

/** A cache read bills at a tenth of the model's input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** A five-minute cache write bills at 1.25x the model's input rate. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * The read-to-write ratio a cache has to beat before it is worth having.
 *
 * Caching R tokens and writing W of them beats sending R + W plain only while
 * `0.1R + 1.25W < R + W` — that is, while `R/W > 0.25/0.9`. A run can serve
 * half its prompt from cache and still cost more than one that cached
 * nothing, so the share served is not the verdict; this is.
 */
export const CACHE_BREAK_EVEN_RATIO: number =
  (CACHE_WRITE_MULTIPLIER - 1) / (1 - CACHE_READ_MULTIPLIER);

/**
 * Dollars per MILLION tokens, as the published price list states them. The
 * per-token numbers every caller wants are derived below rather than typed
 * out with six leading zeros, because a price with a typo in its exponent
 * reads as a plausible number.
 *
 * KEYED ON THE BARE MODEL FAMILY. A request names a dated snapshot
 * (`claude-haiku-4-5-20251001`) and a reply echoes it; the price belongs to
 * the family, so `modelPrice` strips the date before looking here. A new
 * family added to this table is the whole of adding its price.
 */
export const MODEL_PRICES_PER_MILLION: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

/**
 * The smallest prompt each model will cache at all.
 *
 * A `cache_control` marker on anything shorter is IGNORED IN SILENCE: no
 * entry, no error, and a reply that looks exactly like a hit. The first ticks
 * of a meeting sit below Haiku's 4096 because the doc has barely any notes in
 * it yet, so a short meeting caches nothing — that is the model's rule, not a
 * bug in the layout, and the recorded `cacheReadTokens` is what says which of
 * the two a given meeting met.
 */
export const MIN_CACHEABLE_TOKENS: Readonly<Record<string, number>> = {
  'claude-haiku-4-5': 4096,
};

/** A dated snapshot id reduced to the family the price list names. */
export function modelFamily(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

/**
 * The price of a model, or `undefined` when this table has never heard of it.
 *
 * Undefined rather than a zero: a caller that wants to report an unpriced
 * model as unpriced can, and one that wants to treat it as free has to say so
 * in its own code. A model priced at zero by accident reports a meeting as
 * free, which is the one wrong number this module exists to prevent.
 */
export function modelPrice(model: string): ModelPrice | undefined {
  return MODEL_PRICES_PER_MILLION[modelFamily(model)];
}

/** Whether this table can price the model at all. */
export function isPricedModel(model: string): boolean {
  return modelPrice(model) !== undefined;
}

/**
 * What one call cost, in dollars. An unpriced model costs 0 — see
 * {@link isPricedModel} for telling that apart from a call that was free.
 */
export function dollars(usage: TokenUsage, model: string): number {
  const per = modelPrice(model);
  if (!per) return 0;
  const input = per.input / 1_000_000;
  const output = per.output / 1_000_000;
  return (
    usage.inputTokens * input +
    usage.outputTokens * output +
    usage.cacheReadTokens * input * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * input * CACHE_WRITE_MULTIPLIER
  );
}

/** Add two usage records. The identity is {@link ZERO_USAGE}. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Dollars per hour, or `null` when the elapsed time cannot carry a rate.
 *
 * Null rather than Infinity on a zero-length meeting, and null rather than
 * zero: a meeting that ran for no measurable time has no per-hour figure, and
 * printing `$0.00/hr` for it would be a measurement rather than an absence.
 */
export function perHour(totalDollars: number, elapsedMs: number): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return (totalDollars * 3_600_000) / elapsedMs;
}

/**
 * The figure as a chooser row or a report line spells it: `$0.60/hr`.
 *
 * Two decimals, because that is what a person compares two rows on and
 * because the third digit of a rolling average over a handful of meetings is
 * noise dressed as precision.
 */
export function formatPerHour(usdPerHour: number): string {
  return `$${usdPerHour.toFixed(2)}/hr`;
}

/** A dollar amount as a report line spells it: `$1.83`. Cents matter here —
 *  a single meeting can genuinely cost less than a dollar. */
export function formatDollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
