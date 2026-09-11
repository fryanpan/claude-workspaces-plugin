/**
 * WHAT A MEETING COST, summed from the calls it actually made.
 *
 * The arithmetic is deliberately trivial and deliberately in one place. Every
 * number here comes off a stored `NotesCallUsage` row — one per model call,
 * written at the moment the API reported its usage — so a meeting's bill is a
 * sum over records rather than a rate somebody measured once and typed into a
 * string. The prices are core's (`model-cost.ts`), which is also what the
 * chooser row and the eval harness multiply through, so the three cannot
 * disagree about what a token costs.
 *
 * COMPOSE AND CAPTURE ARE KEPT APART because they answer different questions.
 * The compose is what the notes cost. The capture is what listening for
 * spoken asks costs, and it is the half a person can switch off
 * (`CW_MEETING_TASKS=0`) — a total that cannot be split cannot price that
 * choice. It was also the half that was invisible: the call went out every
 * tick and nothing read its usage, so the figure a person saw was the compose
 * alone, against a bill that was roughly half as much again.
 *
 * AN UNPRICED MODEL IS NAMED, NEVER SILENTLY ZERO. A model this build has no
 * price for contributes nothing to the total, which would quietly report a
 * meeting as cheap; the names ride out with the total so the caller can say
 * the figure is short rather than print it as if it were whole.
 */

import {
  type TokenUsage,
  ZERO_USAGE,
  addUsage,
  dollars,
  isPricedModel,
} from '@claude-workspaces/core';
import type { NotesCallKind, NotesCallUsage } from './notes-timing.ts';

/** What a set of calls came to, split the way a reader needs it. */
export interface MeetingSpend {
  /** Dollars over every priced call. */
  totalUsd: number;
  /** The same total, split by which call made it. */
  byCall: Record<NotesCallKind, number>;
  /** Tokens over every call, priced or not — the raw quantity. */
  usage: TokenUsage;
  /** How many model calls were made at all. */
  calls: number;
  /** Models with no row in the price table, deduped. Their tokens are in
   *  `usage` and their dollars are in nobody's total. */
  unpricedModels: readonly string[];
}

export const NO_SPEND: MeetingSpend = {
  totalUsd: 0,
  byCall: { compose: 0, capture: 0 },
  usage: ZERO_USAGE,
  calls: 0,
  unpricedModels: [],
};

/** Sum a meeting's recorded calls. */
export function meetingSpend(calls: readonly NotesCallUsage[]): MeetingSpend {
  const byCall: Record<NotesCallKind, number> = { compose: 0, capture: 0 };
  let usage = ZERO_USAGE;
  const unpriced = new Set<string>();
  for (const c of calls) {
    usage = addUsage(usage, c.usage);
    if (!isPricedModel(c.model)) {
      unpriced.add(c.model);
      continue;
    }
    byCall[c.call] += dollars(c.usage, c.model);
  }
  return {
    totalUsd: byCall.compose + byCall.capture,
    byCall,
    usage,
    calls: calls.length,
    unpricedModels: [...unpriced],
  };
}
