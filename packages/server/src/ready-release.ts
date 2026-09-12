/**
 * Which rows one act FREED — the difference between two readings of a board's
 * ready set.
 *
 * `ready-nudge.ts` can already wake a lead about a row a person moved to
 * `todo` (`personQueuedTask`). That watches the moved row's own transition,
 * and a person can make work dispatchable without transitioning the work:
 *
 *  - **agreeing a goal band** releases every row under it at once, and the
 *    transition is on the GOAL row;
 *  - **closing a blocker** releases whatever was waiting on the `after` edge,
 *    and the transition is on the blocker.
 *
 * Neither is a transition on the row that became ready, so the row-watching
 * wake sees nothing and the board falls back to the fifteen-minute idle
 * window. Measured on this branch before it was written: a goal agreement
 * that made two rows ready delivered zero frames under the production window,
 * and so did a blocker close that made one ready.
 *
 * ── Why a diff rather than a list of releasing gestures ─────────────────
 *
 * The alternative was to enumerate the moves that can free a row — agree a
 * goal, close a blocker, and then whatever the next one turns out to be — and
 * fire on each. That list is a second copy of the dispatch rule, kept by hand,
 * and the day it falls behind `ready-gate.ts` the wake claims a row is ready
 * that the lead will be told is held, or stays silent about one that is.
 *
 * Reading the ready set before and after has no such copy in it. The judge is
 * the board's own gate, both times; what comes out is exactly the set of rows
 * whose readiness this act changed, whatever the act was. A move that frees
 * nothing produces an empty answer and therefore no wake, which is the same
 * sentence rather than a separate rule.
 *
 * ── Why the trimmed rows count as ready ────────────────────────────────
 *
 * A board at its parallelism cap presents an EMPTY `ready` and a perfectly
 * ready row, because the cap trims the set after the dependency gate has run
 * (see `capacityTrimmed` on `ReadyWorkSnapshot`). Reading only `ready` would
 * make a full board's release invisible, and — worse — would report rows as
 * newly freed when all that happened was a slot opening. Both readings take
 * the union, so the answer is about dependency state on both sides and the cap
 * cancels out.
 *
 * Structural types rather than `ready-nudge.ts`'s own, so the diff can be
 * unit-tested without a nudger and the two modules do not have to import each
 * other.
 */

/** A row, reduced to what a wake needs to name. Structurally `ReadyRow`. */
export interface ReleasableRow {
  id: string;
  title: string;
}

/** A board, reduced to the two lists that decide what is dispatchable.
 *  Structurally satisfied by `ReadyWorkSnapshot`. */
export interface ReleasableBoard {
  ready: readonly ReleasableRow[];
  /** Rows the parallelism cap cut out of `ready` — ready by the dependency
   *  gate, held only by how many builders the board may run at once. */
  capacityTrimmed?: readonly ReleasableRow[];
}

/**
 * A board's dispatchable rows as they stood at one moment.
 *
 * Ids only: the diff asks which rows are new, and a title that changed in the
 * same write must not make an already-ready row look freed.
 *
 * `readable` is the field that keeps "the board had nothing dispatchable" from
 * being spelled the same way as "I could not read the board". Both give an
 * empty id set, and the diff subtracts `before` from `after` — so an
 * unreadable reading recorded as empty would make EVERY ready row on the board
 * come back as newly freed, and one lookup that threw mid-hydrate would wake
 * the lead with a release naming work nobody released. The distinction is not
 * a nicety; it is the difference between a silence and a false wake.
 */
export interface ReadyMark {
  /** False when the board could not be read at all — a lookup that threw, a
   *  retired board, an id that names nothing. `freedRows` then answers with
   *  nothing rather than guessing what changed. */
  readonly readable: boolean;
  readonly ids: ReadonlySet<string>;
}

/** What a board nobody could read marks as. Exported so the two sites that
 *  need it cannot drift into two different spellings of "I could not look". */
export const UNREADABLE_MARK: ReadyMark = { readable: false, ids: new Set<string>() };

/** Read the board's dispatchable rows. Call this BEFORE the write. */
export function readyMark(board: ReleasableBoard | undefined): ReadyMark {
  if (!board) return UNREADABLE_MARK;
  const ids = new Set<string>();
  for (const row of board.ready) ids.add(row.id);
  for (const row of board.capacityTrimmed ?? []) ids.add(row.id);
  return { readable: true, ids };
}

/**
 * Rows that are dispatchable now and were not when `before` was taken, in the
 * board's own priority order.
 *
 * `except` drops one id — the row the caller's own act named. A person moving
 * a row to `todo` is `personQueuedTask`'s wake and is announced there; letting
 * it through here too would put two frames on the lead's channel about one
 * move, which is the noise every arming rule in `ready-nudge.ts` exists to
 * prevent.
 *
 * Order is `ready` first and then `capacityTrimmed`, which is the order
 * `readyWorkSnapshot` cut them in — so the row named first is the row the
 * board would hand over first.
 */
export function freedRows(
  before: ReadyMark,
  after: ReleasableBoard | undefined,
  except?: string,
): ReleasableRow[] {
  // Nothing to compare against, so nothing can be said to have changed. A
  // reading that failed must not be subtracted as if it had succeeded — that
  // turns one unreadable moment into a wake naming every ready row on the
  // board as just released.
  if (!before.readable) return [];
  if (!after) return [];
  const freed: ReleasableRow[] = [];
  const seen = new Set<string>();
  for (const row of [...after.ready, ...(after.capacityTrimmed ?? [])]) {
    if (row.id === except) continue;
    if (before.ids.has(row.id)) continue;
    // A row cannot be freed twice. `ready` and `capacityTrimmed` are disjoint
    // slices of one list today; the guard costs nothing and means a future
    // snapshot that overlaps them cannot name a row to the lead twice.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    freed.push(row);
  }
  return freed;
}
