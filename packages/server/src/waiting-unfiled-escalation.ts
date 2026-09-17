/**
 * An unfiled ask that is still unfiled a second window later goes up the
 * ladder — and does it as ONE item for the whole fleet.
 *
 * `stall-nudge.ts` tells the board's lead about every task on the gate's
 * `unfiled` list on the first window. That is the right first addressee: the
 * lead can file the ask in one call. What it cannot do is notice that the
 * lead did not. An ask nobody filed, that the lead was told about, is
 * invisible to everybody who could act on it — which is the shape that put a
 * fleet's worth of waits in chat and nowhere else.
 *
 * BOTH ways onto that list age here (`waitingUnfiledRows`), because the list
 * has one remedy. Reading only `waiting-unfiled` left the older one with no
 * aging path at all; the story is at that function.
 *
 * So this is the aging half, and it is deliberately the SAME ladder
 * `stall-check/README.md` already has: lead → Team Lead → the owner. Team
 * Lead first, on whichever board it holds a stream, once per window; the
 * owner's own queue only when Team Lead cannot be reached either. That order
 * is not a formality — the design's second condition is that the owner is
 * only ever shown something they can act on, and "your agents are asking you
 * things in chat" is a report about the fleet, which Team Lead can fix and
 * the owner would only hand back.
 *
 * ── Why one item and not one per task ───────────────────────────────────
 *
 * The queue's failure mode is the wake's, wearing a different hat: an entry
 * per stuck task is a queue that grows with the outage instead of describing
 * it. `stall-escalation.ts` learned this and files one item per dead board;
 * this files one item for the whole SERVER, because the thing being reported
 * is a property of the fleet's discipline rather than of any board. It is
 * revised in place as tasks join and leave, and withdrawn the moment none is
 * left.
 *
 * The item has to hang on a ticket, so it hangs on the worst due task's, the
 * same way the dead-board item does — and, the same way, its own filing must
 * not exonerate that task: the wiring already skips this actor's items when
 * it reads a task's asks (`STALL_ESCALATION_ACTOR`), so the anchor keeps
 * reading as unfiled on every tick.
 */
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { STALL_ESCALATION_ACTOR, type TeamLeadReach } from './stall-escalation.ts';
import { OWNER_UNFILED_BUCKET } from './stall-gate.ts';
import { STALL_EVENT, type StallNudgeFrame, type StallSnapshot } from './stall-nudge.ts';
import type { TaskStore } from './tasks.ts';
import { type AgingWait, buildWaitingUnfiledReview } from './waiting-unfiled-review.ts';
import { isDue, ownerBound, teamLeadCarry } from './waiting-unfiled-routing.ts';
import {
  type Seen,
  type Sidecar,
  emptySidecar,
  loadSidecar,
  saveSidecar,
  sidecarPath,
} from './waiting-unfiled-sidecar.ts';

export { WAITING_UNFILED_FILENAME } from './waiting-unfiled-sidecar.ts';
import { WAITING_UNFILED_BUCKET } from './waiting-unfiled.ts';

/**
 * How many fleet wakes ONE row may cost before it stops waking that rung.
 *
 * The bug it bounds, and why three: `docs/architecture/stall-detection.md`,
 * under "the fleet rung is bounded". In one line — a row whose closing prose
 * reads as an ask with nothing anyone could file against it never clears, so
 * unbounded it cost Team Lead a whole turn every window for the life of the
 * board.
 *
 * What it bounds is the WAKE. A row past the cap is still on the gate's
 * `unfiled` list — the list the board's own lead is told about every window,
 * and the row's real survival — and it is handed ONCE to the owner's standing
 * item, which is a record rather than a wake. The count sits beside
 * `firstSeen` and is dropped with it, so a row that moves and later asks
 * again is a new wait, carried again.
 */
export const FLEET_TELL_CAP = 3;

export interface WaitingUnfiledEscalationOptions {
  store: TaskStore;
  /** Omitted → memory only, which is what every test that is not about
   *  persistence wants. */
  dataDir?: string;
  /**
   * How long a task may be an `unfiled` finding before it goes past
   * its lead. One more quiet window by default, so the ladder reads: named to
   * the lead at the first window, escalated at the second.
   */
  agingMs?: number;
  /** How many fleet wakes one row may cost (`FLEET_TELL_CAP`). An option so
   *  that the control for the cap — the same windows with the cap out of
   *  reach — is a case in the suite rather than a number somebody once ran by
   *  hand. Production never sets it. */
  fleetTellCap?: number;
  teamLead?: TeamLeadReach;
  report?: (message: string) => void;
  now?: () => number;
}

const key = (workspaceId: string, taskId: string): string => `${workspaceId}|${taskId}`;

/**
 * Every `unfiled` finding on one snapshot — BOTH ways onto that list.
 *
 * `stall-gate.ts` keeps them on one list because they have one remedy: a
 * person is being waited on and cannot see it, and the fix is to file the ask
 * or say there was none. `waiting-unfiled` is the task's own agent saying so
 * in its closing words; `blocked-on-owner-unfiled` is the BOARD saying so.
 * They part company at the rung, not here — `waiting-unfiled-routing.ts`.
 *
 * It read the first bucket alone until 2026-09-17, which left the second with
 * no aging path at all: `stall-escalation.ts` — the only other filer — fires
 * only on a board where no session is alive.
 *
 * A retired board says nobody is working it, so it contributes none.
 */
export function waitingUnfiledRows(
  board: StallSnapshot,
): Array<{ id: string; title: string; bucket: string; quietMs: number }> {
  if (board.retired) return [];
  return board.unfiled
    .filter((row) => row.bucket === WAITING_UNFILED_BUCKET || row.bucket === OWNER_UNFILED_BUCKET)
    .map((row) => ({
      id: row.id,
      title: row.title,
      bucket: row.bucket,
      quietMs: row.quietMs,
    }));
}

export class WaitingUnfiledEscalations {
  private readonly store: TaskStore;
  private readonly path: string | null;
  private readonly agingMs: number;
  private readonly tellCap: number;
  private readonly teamLead: TeamLeadReach | undefined;
  private readonly report: (message: string) => void;
  private sidecar: Sidecar = emptySidecar();
  private lastPersisted = '';

  constructor(opts: WaitingUnfiledEscalationOptions) {
    this.store = opts.store;
    this.path = opts.dataDir === undefined ? null : sidecarPath(opts.dataDir);
    this.agingMs = opts.agingMs ?? 30 * 60_000;
    this.tellCap = opts.fleetTellCap ?? FLEET_TELL_CAP;
    this.teamLead = opts.teamLead;
    this.report = opts.report ?? ((message) => console.error(message));
    this.load();
  }

  /**
   * One pass over EVERY board, after the per-board wakes. Never throws — this
   * runs on a timer, and one bad board must not stop the rest.
   */
  onTick(boards: readonly StallSnapshot[], now: number): void {
    const present = new Map<string, AgingWait>();
    for (const board of boards) {
      for (const row of waitingUnfiledRows(board)) {
        const k = key(board.workspaceId, row.id);
        const prior = this.sidecar.seen[k];
        const firstSeen = prior?.firstSeen ?? now;
        const tells = prior?.tells ?? 0;
        present.set(k, {
          workspaceId: board.workspaceId,
          taskId: row.id,
          title: row.title,
          bucket: row.bucket,
          quietMs: row.quietMs,
          firstSeen,
          tells,
        });
      }
    }
    // Forget what is no longer a finding: the ask was filed, the task moved,
    // or the board is gone. A key that comes back starts its clock again,
    // which is right — the wait it names is a new one.
    const seen: Record<string, Seen> = {};
    for (const [k, row] of present) {
      seen[k] = {
        workspaceId: row.workspaceId,
        taskId: row.taskId,
        firstSeen: row.firstSeen,
        tells: row.tells,
      };
    }
    this.sidecar.seen = seen;

    // Due: named to a lead a full window ago and STILL unfiled — or blocked on
    // a person, which is due at once because no lead was ever named to
    // (`waiting-unfiled-routing.ts`). Worst first, so the anchor is the task
    // that has waited longest.
    const due = [...present.values()]
      .filter((row) => isDue(row, now, this.agingMs))
      .sort((a, b) => a.firstSeen - b.firstSeen);
    if (due.length === 0) {
      this.clear('every unfiled wait was filed or cleared');
      this.save();
      return;
    }
    const board = this.teamLeadBoard();
    if (board !== undefined) {
      // Only the rows with wakes left. A row past the cap is dropped from the
      // FRAME and from nothing else: it stays in `seen`, stays on the gate's
      // `unfiled` list, and is handed below to the one surface that can hold
      // it without costing anybody a turn.
      //
      // When nothing has a wake left the stamp is not moved either, so a row
      // that becomes a finding later is carried on its own clock rather than
      // waiting out a window it was never in.
      const carry = teamLeadCarry(due, (row) => row.tells, this.tellCap);
      const told = this.sidecar.teamLeadToldAt;
      if (carry.length > 0 && (told === undefined || now - told >= this.agingMs)) {
        if (this.tellTeamLead(board, carry, now)) {
          this.sidecar.teamLeadToldAt = now;
          this.spendTells(carry);
        }
      }
      // A row that has stopped waking Team Lead has to land somewhere a
      // person can still answer it, or the cap would be a way of losing a
      // genuine ask quietly — which is worse than the repetition it removes,
      // and would look exactly like success. So the capped rows go onto the
      // owner's standing item, the same one the unreachable-Team-Lead branch
      // below files: ONE item for the fleet, revised in place as the set
      // changes, withdrawn when none is left, and never re-shown to somebody
      // who has answered or withdrawn it (`seenByOwner`). It is a record, not
      // a wake, so it costs no turn however long it stands — and its words
      // already offer the two answers that end it: file the ask, or say there
      // was none.
      //
      // Read off the sidecar rather than off `due`, because `due` carries the
      // count as it was at the top of the tick: a row that spent its last
      // wake seconds ago is capped NOW, and waiting a window to say so would
      // leave it with no audience in between. A row the BOARD says a person
      // owns arrives here on its FIRST tick instead, never having been in
      // `carry`: no agent can end it, so none is woken on the way.
      const forOwner = ownerBound(due, (row) => this.tellsOf(row), this.tellCap);
      if (forOwner.length > 0) {
        this.fileOrRevise(forOwner, now);
        return;
      }
      // Team Lead is reachable and every row still has wakes left, so the
      // owner is not the addressee. An item already standing is left alone
      // rather than withdrawn: it is on the owner's queue because Team Lead
      // was unreachable when it was filed, and taking it back would drop the
      // ask rather than answer it.
      this.save();
      return;
    }
    this.fileOrRevise(due, now);
  }

  /** How many fleet items stand. Test surface for the withdrawal — an item
   *  that is never taken back is invisible otherwise. */
  filedCount(): number {
    return this.sidecar.filed === undefined ? 0 : 1;
  }

  /** The tasks currently being aged, for the verdict and the tests. */
  aging(): readonly Seen[] {
    return Object.values(this.sidecar.seen);
  }

  /**
   * Count a delivered wake against every row it named, and say once — in the
   * log that already records every filing this module makes — which rows have
   * now gone quiet at the fleet rung. Said at the moment it becomes true, and
   * not repeated, because the repetition is the thing being removed.
   */
  private spendTells(carried: readonly AgingWait[]): void {
    const spent: string[] = [];
    for (const row of carried) {
      // `carry` ⊆ `due` ⊆ `present`, and `seen` was rebuilt from `present`
      // earlier in this same tick, so the key is always there.
      const seen = this.sidecar.seen[key(row.workspaceId, row.taskId)] as Seen;
      seen.tells = (seen.tells ?? 0) + 1;
      if (seen.tells >= this.tellCap) spent.push(key(row.workspaceId, row.taskId));
    }
    if (spent.length > 0)
      this.say(
        `[stall] waiting-unfiled fleet-quiet after=${this.tellCap} rows=${spent.join(' ')}` +
          ' — now on the owner’s standing item, and still on each board’s own list',
      );
  }

  /** This row's spent wakes as the sidecar holds them NOW, which is one
   *  ahead of the copy in `due` on the tick that spent the last one. */
  private tellsOf(row: AgingWait): number {
    return this.sidecar.seen[key(row.workspaceId, row.taskId)]?.tells ?? 0;
  }

  private teamLeadBoard(): string | undefined {
    const reach = this.teamLead;
    if (!reach) return undefined;
    try {
      return reach.boards().find((id) => reach.canReach(id, reach.agentId));
    } catch {
      return undefined;
    }
  }

  /**
   * ONE frame for the whole fleet, not one per board. A wake is a session's
   * whole turn (`stall-nudge.ts`'s wake economics), and the fact being
   * reported is the same fact however many boards it spans — so the frame
   * carries every due task and is addressed once.
   *
   * ── Every row says which board it is on ────────────────────────────────
   *
   * The fan-in above is deliberate; what was not is that the frame's SHAPE
   * could not express it. `unfiled` used to be mapped without `workspaceId`,
   * so every row it carried was read under the frame's single top-level tag —
   * `due[0]`'s board. Measured 2026-09-17: one frame tagged with one board
   * named three rows belonging to three different boards, one of which does
   * not appear in the tagged board's events file at all. The receiving lead
   * could only tell which row was its own by recognising the id, and its
   * "read my own board, route anything else to its lead" rule had nothing in
   * the event to stand on.
   *
   * It also explained the frame's oddest symptom: the same row quoted in two
   * frames with the IDENTICAL quiet time. Not two computations that agreed —
   * `waitingUnfiledRows` copies each board's already-rendered row, so the
   * board's own wake and this one carry the same number.
   *
   * So each row keeps its board here, and the frame's own `workspaceId`
   * stays the ANCHOR's board, which is what `taskId` and `title` below name.
   */
  private tellTeamLead(onBoard: string, due: readonly AgingWait[], now: number): boolean {
    const reach = this.teamLead;
    if (!reach) return false;
    const top = due[0];
    const frame: StallNudgeFrame = {
      event: STALL_EVENT,
      workspaceId: top?.workspaceId ?? onBoard,
      ...(top ? { taskId: top.taskId, title: top.title } : {}),
      stalledCount: 0,
      consideredCount: due.length,
      // Each task's OWN bucket: the frame is what Team Lead reads to decide
      // whose ask this is, and the two buckets ask for different reading —
      // one agent's closing words, one board's ownership.
      unfiled: due.map((row) => ({
        id: row.taskId,
        title: row.title,
        bucket: row.bucket,
        quietMs: row.quietMs,
        workspaceId: row.workspaceId,
      })),
      ts: now,
    };
    let delivered = 0;
    try {
      delivered = reach.send(onBoard, reach.agentId, frame);
    } catch (err) {
      console.error('[stall] waiting-unfiled escalation send failed:', err);
      return false;
    }
    if (delivered > 0) {
      this.say(
        `[stall] waiting-unfiled escalated rows=${due.length} to=${reach.agentId} on=${onBoard}`,
      );
    }
    return delivered > 0;
  }

  private liveItem(filed: NonNullable<Sidecar['filed']>): TaskReviewItem | undefined {
    try {
      return this.store.listReviewItems(filed.taskId).find((i) => i.id === filed.itemId);
    } catch {
      return undefined;
    }
  }

  /** Can the item still be SEEN where it hangs? `taskReviewItems` skips a done
   *  ticket's items, so one left on a closed task is off the queue while
   *  `isReviewItemOpen` still answers true. */
  private anchorReachable(filed: NonNullable<Sidecar['filed']>): boolean {
    const task = this.store.getTask(filed.taskId);
    if (!task) return false;
    return task.status !== 'done' && task.archivedAt === undefined;
  }

  private fileOrRevise(due: readonly AgingWait[], now: number): void {
    const keys = due.map((row) => key(row.workspaceId, row.taskId)).sort();
    const filed = this.sidecar.filed;
    const item = filed ? this.liveItem(filed) : undefined;
    const standing =
      filed !== undefined &&
      item !== undefined &&
      isReviewItemOpen(item) &&
      !reviewWithdrawn(item.review) &&
      this.anchorReachable(filed);
    if (filed && standing) {
      if (sameKeys(keys, filed.keys)) {
        this.save();
        return;
      }
      const res = this.store.reviseReviewItem(
        filed.taskId,
        filed.itemId,
        buildWaitingUnfiledReview({ rows: due, agingMs: this.agingMs, now }),
        { actor: { ...STALL_ESCALATION_ACTOR } },
      );
      if (!res.ok) {
        // A refusal is never a reason to file a second item — that is the one
        // outcome this module must not produce. The next tick tries again.
        this.say(`[stall] waiting-unfiled revise refused item=${filed.itemId}: ${res.error}`);
        this.save();
        return;
      }
      this.sidecar.filed = { ...filed, keys };
      this.save();
      return;
    }
    if (filed) {
      // Two ways to stop standing, and only one of them means the owner saw
      // it. ANSWERED or WITHDRAWN is a person having read the list, so those
      // tasks are not asked about again this stretch. An anchor that CLOSED
      // took the item off the queue without anybody reading it — marking its
      // tasks seen there would retire a live fleet-wide finding on the
      // strength of one ticket being completed, so the keys stay unseen and
      // the next few lines re-file against a due task that is still open.
      if (item && this.anchorReachable(filed)) {
        this.sidecar.seenByOwner = union(this.sidecar.seenByOwner ?? [], filed.keys);
      }
      this.sidecar.filed = undefined;
    }
    const unseen = due.filter(
      (row) => !(this.sidecar.seenByOwner ?? []).includes(key(row.workspaceId, row.taskId)),
    );
    if (unseen.length === 0) {
      this.save();
      return;
    }
    const anchor = unseen[0];
    if (!anchor) return;
    const res = this.store.addReviewItem(
      anchor.taskId,
      buildWaitingUnfiledReview({ rows: unseen, agingMs: this.agingMs, now }),
      { actor: { ...STALL_ESCALATION_ACTOR } },
    );
    if (!res.ok) {
      this.say(`[stall] waiting-unfiled filing refused task=${anchor.taskId}: ${res.error}`);
      this.save();
      return;
    }
    this.sidecar.filed = {
      workspaceId: anchor.workspaceId,
      taskId: anchor.taskId,
      itemId: res.item.id,
      keys: unseen.map((row) => key(row.workspaceId, row.taskId)).sort(),
    };
    this.save();
    this.say(`[stall] waiting-unfiled filed rows=${unseen.length} item=${res.item.id}`);
  }

  /** Take the item back and forget the stretch. */
  private clear(reason: string): void {
    const filed = this.sidecar.filed;
    this.sidecar.teamLeadToldAt = undefined;
    this.sidecar.seenByOwner = undefined;
    this.sidecar.filed = undefined;
    if (!filed) return;
    const item = this.liveItem(filed);
    if (!item || !isReviewItemOpen(item) || reviewWithdrawn(item.review)) return;
    const res = this.store.withdrawReviewItem(filed.taskId, filed.itemId, {
      actor: { ...STALL_ESCALATION_ACTOR },
      reason,
    });
    if (!res.ok)
      this.say(`[stall] waiting-unfiled withdraw refused item=${filed.itemId}: ${res.error}`);
    else this.say(`[stall] waiting-unfiled cleared item=${filed.itemId}: ${reason}`);
  }

  private say(message: string): void {
    try {
      this.report(message);
    } catch {
      // A reporter that throws must not undo a filing that already landed.
    }
  }

  private load(): void {
    const { sidecar, persisted } = loadSidecar(this.path);
    this.sidecar = sidecar;
    this.lastPersisted = persisted;
  }

  /** Write the sidecar back when it has actually moved. */
  private save(): void {
    this.lastPersisted = saveSidecar(this.path, this.sidecar, this.lastPersisted);
  }
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
