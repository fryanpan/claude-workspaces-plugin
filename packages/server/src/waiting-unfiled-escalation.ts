import { type TeamLeadReach } from './stall-escalation.ts';
import type { StallSnapshot } from './stall-nudge.ts';
import type { TaskStore } from './tasks.ts';
import { type FilingContext, fileEachBoard, withdrawBoardItem } from './waiting-unfiled-filing.ts';
import { buildFleetFrame } from './waiting-unfiled-frame.ts';
import { type AgingWait } from './waiting-unfiled-review.ts';
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
 * Every `unfiled` finding on one snapshot that anybody can act on — the
 * `waiting-unfiled` bucket, a task's own agent saying in its closing words
 * that it waits on a person with nothing filed. The remedy is one call: file
 * the ask, or say there was none.
 *
 * It read a second bucket between 2026-09-17 and 2026-09-22 —
 * `blocked-on-owner-unfiled`, the BOARD saying a person owns the row — and
 * routed it straight to the owner's item. Nobody could act on those: not an
 * agent, which cannot hand the row back, and not the person, who already
 * holds it. One row reached the owner on three items in five days that way.
 * The gate no longer puts that bucket on `unfiled` at all; the filter is kept
 * HERE as well because this module is the last gate before a person's queue,
 * and a list it is handed is not a list it wrote.
 *
 * A retired board says nobody is working it, so it contributes none.
 */
export function waitingUnfiledRows(
  board: StallSnapshot,
): Array<{ id: string; title: string; bucket: string; quietMs: number }> {
  if (board.retired) return [];
  return board.unfiled
    .filter((row) => row.bucket === WAITING_UNFILED_BUCKET)
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

    // Due: named a full window ago and STILL unfiled. One window (`isDue`,
    // `waiting-unfiled-routing.ts`) — a finding that clears inside it should
    // file nothing. One bucket reaches here, so nothing about the row changes
    // the addressee; what does is the tell cap, decided below. Worst first, so
    // the anchor is the task that has waited longest.
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
      // below files: ONE item per BOARD, revised in place as that board's set
      // changes, withdrawn when none is left, and never re-shown to somebody
      // who has answered or withdrawn it (`seenByOwner`). It is a record, not
      // a wake, so it costs no turn however long it stands — and its words
      // already offer the two answers that end it: file the ask, or say there
      // was none.
      //
      // Read off the sidecar rather than off `due`, because `due` carries the
      // count as it was at the top of the tick: a row that spent its last
      // wake seconds ago is capped NOW, and waiting a window to say so would
      // leave it with no audience in between.
      const forOwner = ownerBound(due, (row) => this.tellsOf(row), this.tellCap);
      if (forOwner.length > 0) {
        this.fileOrReviseEachBoard(forOwner, due, now);
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
    this.fileOrReviseEachBoard(due, due, now);
  }

  /** How many items stand — one per board that has one. Test surface for the
   *  withdrawal: an item that is never taken back is invisible otherwise. */
  filedCount(): number {
    return Object.keys(this.sidecar.filedByBoard ?? {}).length;
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
   * Send the one fleet frame, and count it only if it was delivered.
   *
   * The frame's shape and the reasoning for it are `waiting-unfiled-frame.ts`
   * — a pure builder, so what Team Lead reads can be driven without a reach.
   */
  private tellTeamLead(onBoard: string, due: readonly AgingWait[], now: number): boolean {
    const reach = this.teamLead;
    if (!reach) return false;
    let delivered = 0;
    try {
      delivered = reach.send(onBoard, reach.agentId, buildFleetFrame({ due, onBoard, now }));
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

  /** What `waiting-unfiled-filing.ts` needs, built fresh each call because
   *  `load()` replaces the sidecar object. */
  private filing(): FilingContext {
    return {
      store: this.store,
      sidecar: this.sidecar,
      agingMs: this.agingMs,
      say: (message) => this.say(message),
    };
  }

  /** One item per board, then one write. */
  private fileOrReviseEachBoard(
    filing: readonly AgingWait[],
    stillDue: readonly AgingWait[],
    now: number,
  ): void {
    fileEachBoard(this.filing(), filing, stillDue, now);
    this.save();
  }

  /** Take every board's item back and forget the stretch. */
  private clear(reason: string): void {
    this.sidecar.teamLeadToldAt = undefined;
    this.sidecar.seenByOwner = undefined;
    for (const workspaceId of Object.keys(this.sidecar.filedByBoard ?? {}))
      withdrawBoardItem(this.filing(), workspaceId, reason);
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
