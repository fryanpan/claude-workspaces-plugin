/**
 * Which idle docs leave memory: the eviction WINDOWS, apart from the holds.
 *
 * Every resident doc is heap the garbage collector walks. Measured on
 * 2026-09-29 over 2,700 synthetic docs: 169MB of JS heap and 3.4M objects,
 * about 62KB per doc and linear in the count (300 docs: 25MB; 1,000: 67MB).
 * A full collection over that heap took 38-61ms on a machine with memory to
 * spare. Prod's idle blocks of 2.4-2.7s came with ~290MB free under swap,
 * where the heap of an idle process is exactly the memory macOS pages out
 * first, and the next full collection has to page every one of it back in.
 * So the lever is how many docs are resident, and this file is the rule
 * that decides it.
 *
 * Two windows, and it is Bryan's rule (2026-09-29, reversing "leave it" on
 * the old two-day window): a doc a PERSON opened stays for up to a week, if
 * memory allows; anything else — an agent's read or edit, a threads listing,
 * a fan-out — gets the short window. "A person opened it" is a live editor
 * socket leaving the doc (while it is open, the connection holds the doc);
 * agents reach docs over HTTP and never open one.
 *
 * "If memory allows" is a count: at most {@link PERSON_KEEP_CAP} docs hold
 * the week, the ones a person was in most recently. A doc past the cap falls
 * back to the short window, never below it, so no doc anybody reached in the
 * last {@link SHORT_KEEP_MS} is evicted to satisfy the number.
 */

/** How long a doc a person opened may stay resident. */
export const PERSON_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long any other doc stays after it was last reached. Long enough that an
 * agent working a doc does not reload it between calls; re-hydrating one is
 * a `.ydoc` read, about 0.2ms each in the same measurement.
 */
export const SHORT_KEEP_MS = 30 * 60 * 1000;

/**
 * How many docs may hold the person window at once. At ~62KB of heap each
 * that is ~31MB — the same order as the whole process's heap at 300 docs,
 * where a full collection took 4-5ms.
 */
export const PERSON_KEEP_CAP = 500;

/** One resident doc's clocks, as the store knows them. */
export interface ResidencyEntry {
  docId: string;
  /** The last time anything reached for it, or when it was hydrated. */
  lastReachedAt: number;
  /** The last time a person's editor left it, if ever. */
  lastPersonAt?: number;
}

export interface ResidencyLimits {
  personKeepMs: number;
  shortKeepMs: number;
  personKeepCap: number;
}

export const RESIDENCY_LIMITS: ResidencyLimits = {
  personKeepMs: PERSON_KEEP_MS,
  shortKeepMs: SHORT_KEEP_MS,
  personKeepCap: PERSON_KEEP_CAP,
};

/** Which window still keeps a doc: the short one any reach earns, or the
 *  week a person's visit earns. */
export type WindowHold = 'short-window' | 'person-window';

/**
 * The window each doc is still inside, by id. A doc in neither is absent:
 * those are `pastWindow`'s answer. A doc inside both is named under the
 * short window, because that one alone would keep it.
 */
export function windowHolds(
  entries: readonly ResidencyEntry[],
  now: number,
  limits: ResidencyLimits = RESIDENCY_LIMITS,
): Map<string, WindowHold> {
  // The person window goes to the most recent person visits, cap-many.
  const personKept = new Set(
    entries
      .filter((e) => e.lastPersonAt !== undefined && now - e.lastPersonAt < limits.personKeepMs)
      .sort((a, b) => (b.lastPersonAt ?? 0) - (a.lastPersonAt ?? 0))
      .slice(0, limits.personKeepCap)
      .map((e) => e.docId),
  );
  const out = new Map<string, WindowHold>();
  for (const e of entries) {
    if (now - e.lastReachedAt < limits.shortKeepMs) out.set(e.docId, 'short-window');
    else if (personKept.has(e.docId)) out.set(e.docId, 'person-window');
  }
  return out;
}

/**
 * The docs whose window has run out, in the order given. The caller still
 * asks each one's holds (a connection, a pending write, a recording) before
 * evicting; this answers only "has it been kept long enough".
 */
export function pastWindow(
  entries: readonly ResidencyEntry[],
  now: number,
  limits: ResidencyLimits = RESIDENCY_LIMITS,
): string[] {
  const held = windowHolds(entries, now, limits);
  return entries.filter((e) => !held.has(e.docId)).map((e) => e.docId);
}
