/**
 * Which rung of the unfiled-ask ladder each row belongs on, and nothing else.
 *
 * One `unfiled` list, two ways onto it, and after 2026-09-17 two different
 * audiences — which is the whole reason this is a module rather than three
 * lines inside `waiting-unfiled-escalation.ts`:
 *
 *  - `waiting-unfiled` is the task's OWN agent saying, in its closing words,
 *    that it waits on a person with nothing filed. An agent can end that: it
 *    files the ask, or says there was none. So the row climbs the ladder —
 *    the task's lead first, then Team Lead, and only past the wake cap does
 *    it land on the owner's standing item.
 *  - `blocked-on-owner-unfiled` is the BOARD saying a person owns the row.
 *    No agent can hand it back; waking one spends a turn that ends where it
 *    started. Measured over a week of the fleet's transcripts, stall frames
 *    naming rows blocked on a person were part of the 11% of model spend that
 *    repeat or empty reminders cost. So it skips the ladder entirely and goes
 *    straight to the one surface a person reads, as a record rather than a
 *    wake: it costs nobody a turn however long it stands.
 *
 * The stall wake drops the same rows from the lead's frame
 * (`withoutPersonBlocked`, `stall-frame-news.ts`), so the two halves have to
 * agree on one bucket word — they both take it from `stall-gate.ts`.
 */
import { OWNER_UNFILED_BUCKET } from './stall-gate.ts';

/** The shape this decides over: anything carrying a bucket and a first-seen. */
export interface RoutableWait {
  readonly bucket: string;
  readonly firstSeen: number;
}

/** Only a person can end this one. */
export function onlyAPersonCanEnd(row: RoutableWait): boolean {
  return row.bucket === OWNER_UNFILED_BUCKET;
}

/**
 * Has this row waited long enough to leave the rung it is on?
 *
 * One window for both buckets. What changed on 2026-09-17 is WHERE a due row
 * goes, not when: a transient finding that clears inside the window should
 * still file nothing, and that is as true of the person-blocked half as it was
 * when both halves climbed the same ladder.
 */
export function isDue(row: RoutableWait, now: number, agingMs: number): boolean {
  return now - row.firstSeen >= agingMs;
}

/**
 * The due rows that may still cost a wake: an agent can end them, and they
 * have wakes left under the cap.
 */
export function teamLeadCarry<T extends RoutableWait>(
  due: readonly T[],
  tellsOf: (row: T) => number,
  tellCap: number,
): T[] {
  return due.filter((row) => !onlyAPersonCanEnd(row) && tellsOf(row) < tellCap);
}

/**
 * The due rows that go on the person's standing item: every person-blocked
 * row, plus the rows that have spent their wakes. No row is ever in both this
 * and `teamLeadCarry` read at the same moment — but they are deliberately read
 * at different moments, because a row that spends its last wake on this very
 * tick is carried AND capped, and must reach the owner now rather than a
 * window later.
 */
export function ownerBound<T extends RoutableWait>(
  due: readonly T[],
  tellsOf: (row: T) => number,
  tellCap: number,
): T[] {
  return due.filter((row) => onlyAPersonCanEnd(row) || tellsOf(row) >= tellCap);
}
