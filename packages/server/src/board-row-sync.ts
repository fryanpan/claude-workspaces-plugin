/**
 * Writing a board's task rows into its `tasks` Y.Map: every row, or only the
 * rows something named.
 *
 * Every store event, heartbeat, body snapshot and comment on a task used to
 * re-project the WHOLE board — measured at ~9 ms for 774 rows on the machine
 * prod runs on, about half of it re-serialising rows that had not changed to
 * find out that they had not. That runs on the server's one thread, so a busy
 * board taxes every request, the page load that is waiting for its first
 * sync frame included: under eight concurrent writers a board load's median
 * went from 99 ms to 649 ms and time to first byte from 2 ms to 245 ms.
 *
 * So a caller that knows which rows moved says so, and only those rows are
 * projected. That is a claim about the caller's knowledge, and three checks
 * decide whether it can be trusted before any row is skipped. Any one of them
 * failing turns the call into the full pass, which is always correct:
 *
 *   - **The roster is the one this map was last written against.** A row's
 *     owner kind is resolved against the board's attached agents, so a roster
 *     that moved can change every row whatever the caller named.
 *   - **No row's trim window has lapsed.** `slimTaskRow` drops a row's notes
 *     a day after it last moved — a change with no event behind it. The
 *     earliest such moment is kept, and reaching it forces a full pass.
 *   - **The set of rows is unchanged apart from the named ones.** A row the
 *     store added or removed without naming it (a scheduled occurrence, a
 *     batch) shows up as a key mismatch.
 *
 * What these checks do NOT catch is a store mutation that changed an existing
 * row's content and named a different row. The callers that name rows are
 * the single-row verbs and the per-row events; everything else still calls
 * the full pass. `task-projection-incremental.test.ts` drives random edit
 * sequences through both and asserts the incremental map equals a full
 * rebuild after every one.
 */
import * as Y from 'yjs';
import { type ProjectedTaskRow, notesKeptUntil } from './task-row-slim.ts';

/** What a sync needs to know about one row of the store. */
export interface SyncRow {
  id: string;
}

/** Counters a test reads to prove work was skipped, rather than timing it. */
export interface RowSyncStats {
  /** Rows projected and compared, across every pass. */
  rowsProjected: number;
  /** Passes that projected every row. */
  fullPasses: number;
  /** Passes that projected only the rows named. */
  scopedPasses: number;
}

/**
 * Per-board sync state. One instance per live `ws:` doc: a recreated doc
 * starts from a fresh instance, whose first pass is always full.
 */
export class BoardRowSync<T extends SyncRow> {
  private roster: string | null = null;
  /** Earliest instant a row written here would be trimmed differently. */
  private reprojectAt = Number.POSITIVE_INFINITY;

  constructor(private readonly stats: RowSyncStats) {}

  /**
   * Bring `tasksMap` in line with `rows`.
   *
   * `named` null means every row; otherwise the ids the caller knows moved,
   * which may name a row that no longer exists (it is removed) or an id that
   * is not a task at all (a goal — nothing happens to the map).
   */
  sync(opts: {
    tasksMap: Y.Map<unknown>;
    rows: readonly T[];
    named: readonly string[] | null;
    /** What every row reads from outside itself; null when unknown, which
     *  forces a full pass. */
    roster: string | null;
    now: number;
    project: (row: T) => ProjectedTaskRow;
  }): void {
    const { tasksMap, rows, named, roster, now, project } = opts;
    if (named !== null && this.canScope(tasksMap, rows, named, roster, now)) {
      this.stats.scopedPasses++;
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      for (const id of new Set(named)) {
        const row = byId.get(id);
        if (row) this.write(tasksMap, id, project(row), now);
        else if (tasksMap.has(id)) tasksMap.delete(id);
      }
      return;
    }
    this.stats.fullPasses++;
    this.roster = roster;
    this.reprojectAt = Number.POSITIVE_INFINITY;
    const ids = new Set(rows.map((r) => r.id));
    for (const key of Array.from(tasksMap.keys())) {
      if (!ids.has(key)) tasksMap.delete(key);
    }
    for (const row of rows) this.write(tasksMap, row.id, project(row), now);
  }

  private canScope(
    tasksMap: Y.Map<unknown>,
    rows: readonly T[],
    named: readonly string[],
    roster: string | null,
    now: number,
  ): boolean {
    if (roster === null || this.roster !== roster) return false;
    if (now >= this.reprojectAt) return false;
    const exempt = new Set(named);
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.id);
      if (!exempt.has(row.id) && !tasksMap.has(row.id)) return false;
    }
    for (const key of tasksMap.keys()) {
      if (!exempt.has(key) && !ids.has(key)) return false;
    }
    return true;
  }

  private write(
    tasksMap: Y.Map<unknown>,
    id: string,
    projected: ProjectedTaskRow,
    now: number,
  ): void {
    this.stats.rowsProjected++;
    const keptUntil = notesKeptUntil(projected);
    if (now < keptUntil && keptUntil < this.reprojectAt) this.reprojectAt = keptUntil;
    if (!sameJson(tasksMap.get(id), projected)) tasksMap.set(id, projected);
  }
}

/** JSON-compare a current map value (possibly a foreign-written Yjs type)
 *  against the projected plain object. */
export function sameJson(current: unknown, next: unknown): boolean {
  const plain = current instanceof Y.AbstractType ? current.toJSON() : current;
  return JSON.stringify(plain) === JSON.stringify(next);
}
