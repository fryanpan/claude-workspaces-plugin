/**
 * What happens when there is nobody on the board to wake.
 *
 * `stall-nudge.ts` ends at the lead: it names the stuck rows, wakes the
 * session responsible for the board, and stops. That is the right first
 * addressee and the wrong last one, because the one board that most needs
 * somebody told is the board whose lead has died — and there a wake is
 * addressed to silence, every window, forever.
 *
 * This module is the second addressee, and it runs on ONE trigger: liveness
 * (stall-check rebuild step 3, 2026-09-08). A board is DEAD when no session
 * on it is deliverable — no stream open, nobody observed inside the delivery
 * window — AND no session has written to it or heartbeated on it inside the
 * escalation window. Nothing else qualifies. In particular:
 *
 *  - a live lead that has been told and is slow is NOT escalated past. The
 *    wake keeps telling it; going over its head hands a person a row the lead
 *    is reachable about, and the only reply is to hand it back. Measured
 *    before this: 22 of 27 escalations on one board were of exactly that kind.
 *  - a row waiting on a person WITH the ask filed never escalates. It is not
 *    a finding (`StallSnapshot.waiting`), so it is not on the lists this reads.
 *
 * Two addressees, in order. **Team Lead first** — the fleet's session that
 * starts the others, reached on whichever board it is attached to — gets the
 * board's own stall frame with `escalatedFrom` naming the dead seat, once per
 * window while the board stays dead. It is the party that can restart the
 * lead, and it costs a person nothing. **The owner only when Team Lead cannot
 * be reached either**: then ONE review item is filed on the board, naming
 * every stuck row, written as the server. That item is the last resort, and
 * the keep-moving verdict counts it (`escalated`) so it is visible when it is
 * not one.
 *
 * ── The item withdraws the moment anybody is back ───────────────────────
 *
 * The item is per board, revised in place as the set of stuck rows changes,
 * and withdrawn on the first tick a session is alive on the board again — a
 * write, a heartbeat, a stream. There is no settle window and no re-file
 * cooldown, because the trigger no longer flickers: "alive" is a property the
 * board either has or lacks, not a quiet clock a note can reset. A board
 * that dies again files again, after a full window of being dead.
 *
 * The item hangs on a ticket — the worst unfiled row, else the quietest
 * stalled one — because a review item has to. Its own filing does NOT hide
 * that row from the stall check: the wiring skips this actor's items when it
 * reads a row's asks, so the anchor stays `stalled` or `unfiled` on every
 * tick, the verdict keeps naming it, and this module needs no private read of
 * the anchor's ticket to know whether it is still stuck. An anchor that is
 * closed or archived moves the item to the next stuck row in the same tick,
 * since an item on a done ticket is invisible to the reader.
 *
 * It goes on the queue through the same door the allow-rule proposals use
 * (`addReviewItem` on the store), so it never passes the quality judge: the
 * judge exists to make an agent's ask readable, and an item generated from
 * board state has no author to send it back to.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { taskDeepLink } from './home-brief.ts';
import { STALL_EVENT, type StallNudgeFrame, type StallSnapshot } from './stall-nudge.ts';
import type { TaskStore } from './tasks.ts';

/**
 * How long a board must be without a live session before it is dead. One
 * hour: long enough that a session mid-restart, or a lead doing an hour of
 * local work with its stream briefly down, is not reported; short enough that
 * a morning's work is not lost to a session nobody noticed had stopped. A
 * decision, not a measurement, so `CW_STALL_ESCALATE_MINUTES` overrides it.
 */
export const STALL_ESCALATE_DEFAULT_MS = 60 * 60_000;

/** `<dataDir>/stall-escalations.json` — beside `workspaces/`, like the
 *  allow-rule sidecar and the nudger's stamps. Exported so a test asserts the
 *  file the server actually writes rather than a copy of its name. */
export const STALL_ESCALATION_FILENAME = 'stall-escalations.json';

/**
 * Who files it. The server identity `park-migration.ts` and
 * `artifact-check.ts` already write as: no session decided this and no person
 * did, so neither a session's name nor a person's goes on the item. The
 * wiring also reads this name to keep the item from masking its own anchor.
 */
export const STALL_ESCALATION_ACTOR = {
  id: 'agent-workspaces-server',
  name: 'Claude Workspaces',
  kind: 'agent',
} as const;

/** What one named row contributes to the item's body. */
export interface EscalatedRow {
  id: string;
  title: string;
  bucket: string;
  /** How long the row has been quiet — `StalledRow.quietMs`. */
  quietMs: number;
}

/** Plain words for each bucket — the reader is a person on a phone who was
 *  not there, and `ready-unpicked` is vocabulary from a different audience. */
const BUCKET_WORDS: Record<string, string> = {
  'blocked-on-owner-unfiled': 'waiting on a person, with no question filed anywhere they read',
  'blocked-on-owner': 'waiting on a person',
  'blocked-on-dependency': 'waiting on another row',
  'in-progress': 'claimed by somebody who has gone quiet',
  'ready-unpicked': 'nothing blocking it and nobody on it',
  'builder-silent': 'its builder stopped reporting',
  'backlog-unranked': 'ranked under no goal',
  'scheduled-rule': 'a schedule rule, whose instances are the work',
};

/** "3h", "45m", "2d" — a SPAN, not a moment, so it never reads as a clock
 *  time. Coarse on purpose: the reader acts on hours, not minutes. */
export function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The item's words. Exported so a test reads what a person would see rather
 * than asserting on the call that wrote it.
 *
 * Links are RELATIVE and inline (`/workspaces/<id>?task=<taskId>`): the board
 * is served from several hostnames and an absolute one would be right on
 * whichever it was generated from.
 */
export function buildStallEscalationReview(input: {
  workspaceId: string;
  rows: readonly EscalatedRow[];
  /** How long the board has been dead. */
  deadForMs: number;
}): Record<string, unknown> {
  const { workspaceId, rows, deadForMs } = input;
  const n = rows.length;
  const headline =
    n === 1
      ? `Nobody is on this board, and “${clip(rows[0]?.title ?? '', 40)}” is stuck`
      : `Nobody is on this board, and ${n} tasks are stuck`;
  const lines = rows.map((row) => {
    const why = BUCKET_WORDS[row.bucket] ?? row.bucket;
    return `- [${label(row.title)}](${taskDeepLink(workspaceId, row.id)}) — ${why}. Quiet ${span(row.quietMs)}.`;
  });
  const detail = [
    `No session has written to this board, heartbeated on it or held a stream to it for over ${span(deadForMs)}, and Team Lead could not be reached either. The rows below are stuck with nobody to wake about them.`,
    '',
    ...lines,
    '',
    'The board filed this itself because there is nobody left to tell. Start or restart a session on it; this item withdraws on its own the moment one reports here.',
  ].join('\n');
  return { review_type: 'question', headline, detail };
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** A title as a markdown LINK LABEL. Square brackets are dropped rather than
 *  escaped, the same call `home-brief.ts` makes: a bracket in a title breaks
 *  the link syntax, and the visible title loses only the brackets. */
function label(title: string): string {
  return title.replace(/[[\]]/g, '');
}

/**
 * How long the board has been without anybody, or `undefined` while somebody
 * is on it. Exported for the verdict and the tests: this is the whole trigger.
 *
 * Three reads, and any one of them alive is alive: a deliverable session
 * (`sessionLive` — a stream open, or observed inside the store's delivery
 * window), the newest heartbeat or tool call the store recorded for any
 * attachment (`sessionObservedAt`), and the newest agent write on any row
 * (`agentActiveAt`). A board none of those has ever touched is dead from its
 * first tick with a finding: nobody has ever been there to wake.
 */
export function boardDeadFor(
  board: Pick<StallSnapshot, 'sessionLive' | 'sessionObservedAt' | 'agentActiveAt'>,
  now: number,
  escalateMs: number,
): number | undefined {
  if (board.sessionLive) return undefined;
  const last = Math.max(board.sessionObservedAt ?? 0, board.agentActiveAt ?? 0);
  if (last === 0) return escalateMs;
  const dead = now - last;
  return dead >= escalateMs ? dead : undefined;
}

/** One board's record while it is dead. Absent while it is alive. */
interface Dead {
  /** When the board was first seen dead — the item's "for over" span runs
   *  from the last observation, not from here, but this is when this module
   *  started caring. */
  since: number;
  /** When Team Lead was last sent the frame this stretch. */
  teamLeadToldAt?: number;
  /** The reader's item, while one stands. */
  filed?: { taskId: string; itemId: string; rowIds: string[] };
  /** Rows the reader has already been shown this stretch, on an item they
   *  answered or withdrew. Those are not asked about again; a row they were
   *  not shown is. */
  seenRowIds?: string[];
}

type Sidecar = Record<string, { dead: Dead }>;

/**
 * How Team Lead is reached: by id, on whichever board it holds a stream.
 * `send` is the same addressed delivery the wake rides — never a broadcast.
 */
export interface TeamLeadReach {
  agentId: string;
  /** Every board this server holds, so the search is not limited to the
   *  dead one. */
  boards: () => readonly string[];
  canReach: (workspaceId: string, agentId: string) => boolean;
  send: (workspaceId: string, agentId: string, frame: StallNudgeFrame) => number;
}

export interface StallEscalationOptions {
  store: TaskStore;
  /** Where the sidecar lives. Omitted → memory only, which is what every
   *  test that is not about persistence wants. */
  dataDir?: string;
  escalateMs?: number;
  /** Absent → no Team Lead on this server; the reader is the only addressee. */
  teamLead?: TeamLeadReach;
  /** Where a filing or a withdrawal is announced. Defaults to
   *  `console.error`, like the nudger's — this is the only record that the
   *  server wrote to somebody's queue on its own. */
  report?: (message: string) => void;
}

export class StallEscalations {
  private readonly store: TaskStore;
  private readonly path: string | null;
  private readonly escalateMs: number;
  private readonly teamLead: TeamLeadReach | undefined;
  private readonly report: (message: string) => void;
  private sidecar: Sidecar = {};
  /** What the file already holds, so an unchanged sidecar costs no write —
   *  this runs once a minute per board forever. */
  private lastPersisted = '';

  constructor(opts: StallEscalationOptions) {
    this.store = opts.store;
    this.path = opts.dataDir === undefined ? null : join(opts.dataDir, STALL_ESCALATION_FILENAME);
    this.escalateMs = opts.escalateMs ?? STALL_ESCALATE_DEFAULT_MS;
    this.teamLead = opts.teamLead;
    this.report = opts.report ?? ((message) => console.error(message));
    this.load();
  }

  /**
   * One board, once per tick. Called from the stall loop after the wake
   * decision; never throws — a filer that failed must not stop the boards
   * behind it (the caller isolates it too).
   */
  onBoard(board: StallSnapshot, now: number): void {
    const key = board.workspaceId;
    const prior = this.sidecar[key]?.dead;
    const deadFor = board.retired ? undefined : boardDeadFor(board, now, this.escalateMs);
    const rows = deadFor === undefined ? [] : qualifying(board);

    // Alive, retired, or dead with nothing stuck: nothing to say, and
    // anything already said is taken back on this very tick. A retired board
    // is the owner saying nobody is working it; the other two are somebody
    // being there, or nothing to be there for.
    if (rows.length === 0) {
      if (prior?.filed) {
        const item = this.liveItem(prior.filed);
        if (item && isReviewItemOpen(item) && !reviewWithdrawn(item.review)) {
          this.withdrawItem(
            key,
            prior.filed,
            board.retired
              ? 'the board was retired'
              : deadFor === undefined
                ? 'a session is on the board again'
                : 'the tasks it named are no longer stuck',
          );
        }
      }
      if (prior) delete this.sidecar[key];
      this.save();
      return;
    }

    const dead: Dead = prior ?? { since: now };
    // Team Lead first, once per window while the board stays dead — and
    // whether or not the reader already holds an item: Team Lead is the one
    // who can restart the lead, and the item withdraws itself when that
    // works.
    const teamLeadBoard = this.teamLeadBoard();
    if (teamLeadBoard !== undefined) {
      if (dead.teamLeadToldAt === undefined || now - dead.teamLeadToldAt >= this.escalateMs) {
        const sent = this.sendToTeamLead(teamLeadBoard, board, rows, now);
        if (sent) dead.teamLeadToldAt = now;
      }
    }
    const item = dead.filed ? this.liveItem(dead.filed) : undefined;
    if (dead.filed && item && isReviewItemOpen(item) && !reviewWithdrawn(item.review)) {
      this.updateLive(key, dead, rows, deadFor ?? this.escalateMs);
      return;
    }
    if (dead.filed) {
      // Answered or withdrawn by a person — they have seen this set — or the
      // ticket and item are gone. Either way the record no longer names a
      // standing ask.
      if (item) dead.seenRowIds = union(dead.seenRowIds ?? [], dead.filed.rowIds);
      dead.filed = undefined;
    }
    if (teamLeadBoard !== undefined) {
      this.sidecar[key] = { dead };
      this.save();
      return;
    }

    // …and the reader only when Team Lead is not there either.
    const unseen = rows.filter((row) => !(dead.seenRowIds ?? []).includes(row.id));
    if (unseen.length === 0) {
      this.sidecar[key] = { dead };
      this.save();
      return;
    }
    this.file(key, dead, rows, deadFor ?? this.escalateMs);
  }

  /** How many boards hold a live item. Test surface for the pruning that a
   *  recovered board does — a sidecar that only grows is invisible otherwise. */
  filedCount(): number {
    return Object.values(this.sidecar).filter((r) => r.dead.filed !== undefined).length;
  }

  /** The board Team Lead can be reached on right now, the dead board's own
   *  first. */
  private teamLeadBoard(): string | undefined {
    const reach = this.teamLead;
    if (!reach) return undefined;
    try {
      return reach.boards().find((id) => reach.canReach(id, reach.agentId));
    } catch {
      return undefined;
    }
  }

  /** The dead board's own stall frame, addressed to Team Lead on its board,
   *  with `escalatedFrom` naming the seat nobody is holding. */
  private sendToTeamLead(
    onBoard: string,
    board: StallSnapshot,
    rows: EscalatedRow[],
    now: number,
  ): boolean {
    const reach = this.teamLead;
    if (!reach) return false;
    const top = rows[0];
    const frame: StallNudgeFrame = {
      event: STALL_EVENT,
      workspaceId: board.workspaceId,
      ...(top ? { taskId: top.id, title: top.title } : {}),
      stalledCount: board.stalled.length,
      consideredCount: board.considered,
      ...(board.stalled.length > 0 ? { rows: board.stalled } : {}),
      ...(board.unfiled.length > 0 ? { unfiled: board.unfiled } : {}),
      ...(board.leadAgentId !== undefined ? { escalatedFrom: board.leadAgentId } : {}),
      ts: now,
    };
    let delivered = 0;
    try {
      delivered = reach.send(onBoard, reach.agentId, frame);
    } catch (err) {
      console.error('[stall] escalation send failed:', err);
      return false;
    }
    if (delivered > 0) {
      this.say(
        `[stall] escalated ws=${board.workspaceId} rows=${rows.length} to=${reach.agentId} on=${onBoard}`,
      );
    }
    return delivered > 0;
  }

  /** The item this board's record points at, when both the ticket and the
   *  item are still there. */
  private liveItem(filed: NonNullable<Dead['filed']>): TaskReviewItem | undefined {
    try {
      return this.store.listReviewItems(filed.taskId).find((i) => i.id === filed.itemId);
    } catch {
      return undefined;
    }
  }

  /**
   * Can the item still be SEEN where it hangs — a ticket that exists, is not
   * archived, and is not `done`? `taskReviewItems` in `review-queue.ts` skips
   * a done ticket's items outright, so an item left on one is gone from the
   * reader's queue while `isReviewItemOpen` still answers true.
   */
  private anchorReachable(filed: NonNullable<Dead['filed']>): boolean {
    const task = this.store.getTask(filed.taskId);
    if (!task) return false;
    return task.status !== 'done' && task.archivedAt === undefined;
  }

  /** Revise the open item to the rows that are stuck now, or move it when
   *  its anchor can no longer be seen. */
  private updateLive(key: string, dead: Dead, rows: EscalatedRow[], deadForMs: number): void {
    const filed = dead.filed;
    if (!filed) return;
    if (!this.anchorReachable(filed)) {
      // Moved in the same tick: this is one ask being carried somewhere the
      // reader can see it, not a second ask.
      this.withdrawItem(key, filed, 'moved to a task that is still stuck');
      dead.filed = undefined;
      this.file(key, dead, rows, deadForMs);
      return;
    }
    const ids = rows.map((row) => row.id);
    if (sameIds(ids, filed.rowIds)) {
      this.save();
      return;
    }
    const res = this.store.reviseReviewItem(
      filed.taskId,
      filed.itemId,
      buildStallEscalationReview({ workspaceId: key, rows, deadForMs }),
      { actor: { ...STALL_ESCALATION_ACTOR } },
    );
    if (!res.ok) {
      // A refusal is not a reason to file a second item — that is the one
      // outcome this module must never produce. The record stands and the
      // next tick tries again.
      this.say(`[stall] escalation revise refused ws=${key} item=${filed.itemId}: ${res.error}`);
      this.save();
      return;
    }
    dead.filed = { ...filed, rowIds: ids };
    this.sidecar[key] = { dead };
    this.save();
  }

  private file(key: string, dead: Dead, rows: EscalatedRow[], deadForMs: number): void {
    const anchor = rows[0];
    if (!anchor) return;
    const res = this.store.addReviewItem(
      anchor.id,
      buildStallEscalationReview({ workspaceId: key, rows, deadForMs }),
      { actor: { ...STALL_ESCALATION_ACTOR } },
    );
    if (!res.ok) {
      this.say(`[stall] escalation refused ws=${key} task=${anchor.id}: ${res.error}`);
      this.sidecar[key] = { dead };
      this.save();
      return;
    }
    dead.filed = { taskId: anchor.id, itemId: res.item.id, rowIds: rows.map((r) => r.id) };
    this.sidecar[key] = { dead };
    this.save();
    this.say(`[stall] escalated ws=${key} rows=${rows.length} item=${res.item.id}`);
  }

  /** Take the item back. The record is the caller's to keep or drop. */
  private withdrawItem(key: string, filed: NonNullable<Dead['filed']>, reason: string): void {
    const res = this.store.withdrawReviewItem(filed.taskId, filed.itemId, {
      actor: { ...STALL_ESCALATION_ACTOR },
      reason,
    });
    if (!res.ok)
      this.say(`[stall] escalation withdraw refused ws=${key} item=${filed.itemId}: ${res.error}`);
    else this.say(`[stall] escalation cleared ws=${key} item=${filed.itemId}: ${reason}`);
  }

  private say(message: string): void {
    try {
      this.report(message);
    } catch {
      // A reporter that throws must not undo a filing that already landed.
    }
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Only records of this shape are kept. A file written by the earlier
        // module (`filed` / `cleared` at the top level) is dropped, and an
        // item it named is no longer this module's to withdraw — one stale
        // item per board on an old file is the cost of the format change,
        // accepted, and the reader can withdraw it by hand.
        const out: Sidecar = {};
        for (const [key, record] of Object.entries(parsed as Record<string, unknown>)) {
          if (record && typeof record === 'object' && 'dead' in record) {
            out[key] = record as { dead: Dead };
          }
        }
        this.sidecar = out;
        this.lastPersisted = this.serialize();
      }
    } catch {
      // A corrupt sidecar costs at most one duplicate item, never a crash;
      // the review items themselves are the record and are untouched.
      this.sidecar = {};
    }
  }

  private serialize(): string {
    const out: Sidecar = {};
    for (const key of Object.keys(this.sidecar).sort()) {
      const record = this.sidecar[key];
      if (record) out[key] = record;
    }
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  /** Write the sidecar back, when it has actually moved. Never throws: this
   *  runs inside a timer tick, and a full disk must not stop the loop. */
  private save(): void {
    if (!this.path) return;
    const next = this.serialize();
    if (next === this.lastPersisted) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, this.path);
      this.lastPersisted = next;
    } catch (err) {
      console.error('[stall] could not persist escalations:', err);
    }
  }
}

/** The rows a dead board is escalated about: unfiled first, then stalled,
 *  each list in the gate's own order. The FIRST becomes the anchor. */
function qualifying(board: StallSnapshot): EscalatedRow[] {
  return [...board.unfiled, ...board.stalled].map((row) => ({
    id: row.id,
    title: row.title,
    bucket: row.bucket,
    quietMs: row.quietMs,
  }));
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
}
