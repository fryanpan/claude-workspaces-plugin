/**
 * The unfiled-ask ladder's two thresholds, as three functions over anything
 * carrying a first-seen, so the escalation's tick reads as sentences and each
 * threshold can be driven on its own.
 *
 * Every row that reaches them is `waiting-unfiled` — the task's OWN agent
 * saying, in its closing words, that it waits on a person with nothing filed.
 * An agent can end that: it files the ask, or it says there was none. So the
 * row climbs — the task's lead first, then Team Lead, and past the wake cap
 * onto the owner's standing item, which is a record rather than a wake and
 * costs nobody a turn.
 *
 * ── What used to be here, and what this module is now ───────────────────
 *
 * A second bucket, `blocked-on-owner-unfiled`: the BOARD saying a person owns
 * the row. It shared the list and skipped straight to the owner's item, on
 * the reasoning that no agent could hand it back. That was half right. The
 * person could not act on it either — the item asked them to file a question
 * to themselves about work already on their own queue — so one such row
 * reached the owner on three review items in five days. The finding is
 * retired rather than re-addressed: the gate no longer puts the bucket on
 * `unfiled` at all, and `waiting-unfiled-escalation.ts` refuses it a second
 * time on the way in. `StallVerdict.awaitingPerson` is where such a row is
 * written down now.
 *
 * `onlyAPersonCanEnd` went with it, and with it this module's original reason
 * to exist — the point where the two buckets parted company. What is left is
 * NOT a decision about a row: `teamLeadCarry` and `ownerBound` are exact
 * complements over one number the caller supplies, and the caller is the only
 * thing that knows which rows to hand each of them. That is worth keeping as
 * a named pair rather than inlining, because the two are read at DIFFERENT
 * moments on purpose (see `ownerBound`), and a reader of the escalation's
 * tick has to be able to see that they partition rather than infer it from
 * two filter callbacks twelve lines apart.
 */

/** The shape this decides over: anything carrying a first-seen. */
export interface RoutableWait {
  readonly firstSeen: number;
}

/**
 * Has this row waited long enough to leave the rung it is on?
 *
 * One window: a transient finding that clears inside it should file nothing.
 */
export function isDue(row: RoutableWait, now: number, agingMs: number): boolean {
  return now - row.firstSeen >= agingMs;
}

/** The due rows that may still cost a wake: they have wakes left under the
 *  cap. */
export function teamLeadCarry<T extends RoutableWait>(
  due: readonly T[],
  tellsOf: (row: T) => number,
  tellCap: number,
): T[] {
  return due.filter((row) => tellsOf(row) < tellCap);
}

/**
 * The due rows that go on the person's standing item: the ones that have
 * spent their wakes. No row is ever in both this and `teamLeadCarry` read at
 * the same moment — but they are deliberately read at different moments,
 * because a row that spends its last wake on this very tick is carried AND
 * capped, and must reach the owner now rather than a window later.
 */
export function ownerBound<T extends RoutableWait>(
  due: readonly T[],
  tellsOf: (row: T) => number,
  tellCap: number,
): T[] {
  return due.filter((row) => tellsOf(row) >= tellCap);
}
