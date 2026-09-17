/**
 * The set of tasks the last wake named, per board and per session it reached.
 *
 * A wake is a session's whole turn. Measured over a week of the fleet's
 * transcripts, `workspace.stalled` frames naming exactly the task set the
 * previous frame had named were 5.4% of all model spend, and `ready_idle`
 * repeats sat beside them. Each of those frames carried something the stamp
 * rules counted as news — a board's oldest row crossing another repeat
 * window, a check-in coming round again, the idle clock restarting after an
 * unrelated write — and none of it was a task the reader had not already
 * been handed.
 *
 * So the question this answers is narrower than the stamps', and asked after
 * them: would this frame name anything this session was not handed last time?
 * If not, it is not sent. A set that GAINS even one entry is news. A set that
 * merely LOST one is not — the reader has already been handed everything that
 * is left, and the same growth-only rule the stamp uses applies here for the
 * same reason.
 *
 * ── Forgetting ──────────────────────────────────────────────────────────
 *
 * A task that leaves the board's findings and comes back much later is a new
 * stall, not a repeat — the failure this subsystem exists for is an ask that
 * died unseen. So each id carries when it was last NAMED on the board (by
 * `observe`, every pass, whether or not anything is sent), and an id not named
 * for `forgetMs` is dropped from every set it sits in. Its return then makes
 * the set differ.
 *
 * ── Restarts ────────────────────────────────────────────────────────────
 *
 * The sets are serialised beside the owning nudger's stamps. Seen-times are
 * not stored: every id is given a fresh window at load, so a restart can
 * extend what is remembered but never cut it short — the same trade
 * `stall-nudge.ts` makes for its told rows, and for the same reason: a deploy
 * must not re-send a set its reader already had.
 */

/** Board → session → the ids its last delivered frame named, sorted. */
export type SentSetsJson = Record<string, Record<string, string[]>>;

export class WakeSentSets {
  private readonly forgetMs: number;
  private readonly sent = new Map<string, Map<string, string[]>>();
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(forgetMs: number) {
    this.forgetMs = forgetMs;
  }

  /**
   * The ids this pass would name on a board, whether or not a frame goes out.
   * Refreshes each one's last-named time, then drops every id not named for
   * `forgetMs` from the board's sets.
   */
  observe(workspaceId: string, ids: Iterable<string>, now: number): void {
    let seen = this.seen.get(workspaceId);
    if (!seen) {
      seen = new Map();
      this.seen.set(workspaceId, seen);
    }
    // Swept BEFORE the new ids are stamped, not after. A row that comes back
    // on the very tick its window runs out is the case this exists for — the
    // recurrence after a clear — and refreshing first would keep it
    // remembered, so its return would read as the same finding it was.
    const forgotten = new Set<string>();
    for (const [id, at] of seen) {
      if (now - at > this.forgetMs) {
        seen.delete(id);
        forgotten.add(id);
      }
    }
    for (const id of ids) seen.set(id, now);
    if (forgotten.size === 0) return;
    const sets = this.sent.get(workspaceId);
    if (!sets) return;
    for (const [agentId, ids] of sets) {
      const kept = ids.filter((id) => !forgotten.has(id));
      if (kept.length === 0) sets.delete(agentId);
      else sets.set(agentId, kept);
    }
    if (sets.size === 0) this.sent.delete(workspaceId);
  }

  /**
   * True when this frame names nothing the session was not already handed —
   * the same set, or a SUBSET of it.
   *
   * A subset rather than an equality, and the difference is a measured wake:
   * a board whose oldest row crosses another repeat window while a different
   * row goes quiet elsewhere presents a smaller set on a bigger escalation
   * bucket, and equality reads that as news. It is not: the reader has been
   * handed every task it names. Growth is the only direction that can be new,
   * which is the rule the stamp's own `changeOn` has always used.
   *
   * An empty set is never a repeat: something else made the frame, and this
   * has nothing to say about it.
   */
  nothingNew(workspaceId: string, agentId: string, ids: Iterable<string>): boolean {
    const next = normalise(ids);
    if (next.length === 0) return false;
    const last = this.sent.get(workspaceId)?.get(agentId);
    if (last === undefined) return false;
    const held = new Set(last);
    return next.every((id) => held.has(id));
  }

  /** Record a DELIVERED frame. Never call it for a send nobody took. */
  record(workspaceId: string, agentId: string, ids: Iterable<string>, now: number): void {
    const next = normalise(ids);
    let sets = this.sent.get(workspaceId);
    if (!sets) {
      sets = new Map();
      this.sent.set(workspaceId, sets);
    }
    sets.set(agentId, next);
    this.observe(workspaceId, next, now);
  }

  /** Forget boards that are gone. */
  retain(live: ReadonlySet<string>): void {
    for (const key of this.sent.keys()) if (!live.has(key)) this.sent.delete(key);
    for (const key of this.seen.keys()) if (!live.has(key)) this.seen.delete(key);
  }

  /** Sorted at every level, so an unchanged memory serialises byte-identically. */
  toJSON(): SentSetsJson {
    const out: SentSetsJson = {};
    for (const workspaceId of [...this.sent.keys()].sort()) {
      const sets = this.sent.get(workspaceId);
      if (!sets || sets.size === 0) continue;
      const board: Record<string, string[]> = {};
      for (const agentId of [...sets.keys()].sort()) board[agentId] = sets.get(agentId) ?? [];
      out[workspaceId] = board;
    }
    return out;
  }

  /** Load what a previous run wrote. Tolerant row by row: one hand-edited
   *  entry must not cost every other board its memory. */
  load(json: unknown, now: number): void {
    if (!json || typeof json !== 'object') return;
    for (const [workspaceId, board] of Object.entries(json as Record<string, unknown>)) {
      if (!board || typeof board !== 'object') continue;
      for (const [agentId, ids] of Object.entries(board as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        const clean = ids.filter((id): id is string => typeof id === 'string');
        if (clean.length > 0) this.record(workspaceId, agentId, clean, now);
      }
    }
  }
}

function normalise(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}
