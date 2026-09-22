/**
 * The per-board half of the unfiled-ask escalation: which board gets an item,
 * which board's item is revised, and which board's is taken back.
 *
 * Split out of `waiting-unfiled-escalation.ts` when the item went from one
 * for the whole server to one per board. That module decides WHEN a row is
 * due and WHO is told; this one decides what a person's queue ends up
 * holding, which is the half whose failures are visible to somebody outside
 * the fleet. Keeping them apart also means these three can be driven with a
 * plain store and a plain sidecar, without a tick, a clock or a Team Lead.
 *
 * Two invariants everything here is arranged around:
 *
 *  - **Never two items for one board.** A refused revise leaves the standing
 *    item alone and waits for the next tick; it is never a reason to file a
 *    second. A duplicate on somebody's queue is the failure this whole change
 *    exists to remove.
 *  - **One board's item names one board's rows.** A reader opens it on the
 *    board they are working, so a row from elsewhere is a row they cannot
 *    reach (Bryan, 2026-09-21: "The second isn't even in your project").
 *
 * The sidecar is mutated in place and never written here: the caller saves
 * once, after every board, so a tick costs one write however many boards
 * moved.
 */
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@claude-workspaces/core';
import { STALL_ESCALATION_ACTOR } from './stall-escalation.ts';
import type { TaskStore } from './tasks.ts';
import { type AgingWait, buildWaitingUnfiledReview } from './waiting-unfiled-review.ts';
import { type Filed, type Sidecar, dropFiled, setFiled } from './waiting-unfiled-sidecar.ts';

/** Everything these need from the escalation, and nothing about its tick. */
export interface FilingContext {
  store: TaskStore;
  /** Mutated in place. The caller owns writing it back. */
  sidecar: Sidecar;
  agingMs: number;
  /** Where a filing, a revise refusal or a withdrawal is announced. */
  say: (message: string) => void;
}

const key = (workspaceId: string, taskId: string): string => `${workspaceId}|${taskId}`;

/**
 * File or revise ONE item per board, and take back the item of any board that
 * is no longer due at all.
 *
 * `filing` is the set that reaches a person — every due row when Team Lead
 * cannot be reached, the capped rows when it can. `stillDue` is every due row
 * on the tick, which is what says whether a board still has a finding: a
 * board whose due rows all still have wakes left keeps its standing item
 * rather than having it withdrawn and re-filed a window later.
 *
 * The two loops are disjoint by construction — a board in `filing` is in
 * `stillDue`, so it is never cleared and re-filed on one tick.
 */
export function fileEachBoard(
  ctx: FilingContext,
  filing: readonly AgingWait[],
  stillDue: readonly AgingWait[],
  now: number,
): void {
  const dueBoards = new Set(stillDue.map((row) => row.workspaceId));
  for (const workspaceId of Object.keys(ctx.sidecar.filedByBoard ?? {})) {
    if (!dueBoards.has(workspaceId))
      withdrawBoardItem(ctx, workspaceId, 'every unfiled wait on this board was filed or cleared');
  }
  for (const workspaceId of [...new Set(filing.map((row) => row.workspaceId))]) {
    fileOrReviseBoard(
      ctx,
      workspaceId,
      filing.filter((row) => row.workspaceId === workspaceId),
      now,
    );
  }
}

/** One board's item. */
function fileOrReviseBoard(
  ctx: FilingContext,
  workspaceId: string,
  due: readonly AgingWait[],
  now: number,
): void {
  const keys = due.map((row) => key(row.workspaceId, row.taskId)).sort();
  const filed = ctx.sidecar.filedByBoard?.[workspaceId];
  const item = filed ? liveItem(ctx, filed) : undefined;
  const standing =
    filed !== undefined &&
    item !== undefined &&
    isReviewItemOpen(item) &&
    !reviewWithdrawn(item.review) &&
    anchorReachable(ctx, filed);
  if (filed && standing) {
    if (sameKeys(keys, filed.keys)) return;
    const res = ctx.store.reviseReviewItem(
      filed.taskId,
      filed.itemId,
      buildWaitingUnfiledReview({ rows: due, agingMs: ctx.agingMs, now }),
      { actor: { ...STALL_ESCALATION_ACTOR } },
    );
    if (!res.ok) {
      // A refusal is never a reason to file a second item — that is the one
      // outcome this module must not produce. The next tick tries again.
      ctx.say(`[stall] waiting-unfiled revise refused item=${filed.itemId}: ${res.error}`);
      return;
    }
    setFiled(ctx.sidecar, workspaceId, { ...filed, keys });
    return;
  }
  if (filed) {
    // Two ways to stop standing, and only one of them means the owner saw it.
    // ANSWERED or WITHDRAWN is a person having read the list, so those tasks
    // are not asked about again this stretch. An anchor that CLOSED took the
    // item off the queue without anybody reading it — marking its tasks seen
    // there would retire a live finding on the strength of one ticket being
    // completed, so the keys stay unseen and the lines below re-file against
    // a due task that is still open.
    if (item && anchorReachable(ctx, filed)) {
      ctx.sidecar.seenByOwner = union(ctx.sidecar.seenByOwner ?? [], filed.keys);
    }
    dropFiled(ctx.sidecar, workspaceId);
  }
  const unseen = due.filter(
    (row) => !(ctx.sidecar.seenByOwner ?? []).includes(key(row.workspaceId, row.taskId)),
  );
  const anchor = unseen[0];
  if (!anchor) return;
  const res = ctx.store.addReviewItem(
    anchor.taskId,
    buildWaitingUnfiledReview({ rows: unseen, agingMs: ctx.agingMs, now }),
    { actor: { ...STALL_ESCALATION_ACTOR } },
  );
  if (!res.ok) {
    ctx.say(`[stall] waiting-unfiled filing refused task=${anchor.taskId}: ${res.error}`);
    return;
  }
  setFiled(ctx.sidecar, workspaceId, {
    workspaceId: anchor.workspaceId,
    taskId: anchor.taskId,
    itemId: res.item.id,
    keys: unseen.map((row) => key(row.workspaceId, row.taskId)).sort(),
  });
  ctx.say(
    `[stall] waiting-unfiled filed ws=${workspaceId} rows=${unseen.length} item=${res.item.id}`,
  );
}

/** Take ONE board's item back. */
export function withdrawBoardItem(ctx: FilingContext, workspaceId: string, reason: string): void {
  const filed = ctx.sidecar.filedByBoard?.[workspaceId];
  dropFiled(ctx.sidecar, workspaceId);
  if (!filed) return;
  const item = liveItem(ctx, filed);
  if (!item || !isReviewItemOpen(item) || reviewWithdrawn(item.review)) return;
  const res = ctx.store.withdrawReviewItem(filed.taskId, filed.itemId, {
    actor: { ...STALL_ESCALATION_ACTOR },
    reason,
  });
  if (!res.ok)
    ctx.say(`[stall] waiting-unfiled withdraw refused item=${filed.itemId}: ${res.error}`);
  else ctx.say(`[stall] waiting-unfiled cleared item=${filed.itemId}: ${reason}`);
}

function liveItem(ctx: FilingContext, filed: Filed): TaskReviewItem | undefined {
  try {
    return ctx.store.listReviewItems(filed.taskId).find((i) => i.id === filed.itemId);
  } catch {
    return undefined;
  }
}

/** Can the item still be SEEN where it hangs? `taskReviewItems` skips a done
 *  ticket's items, so one left on a closed task is off the queue while
 *  `isReviewItemOpen` still answers true. */
function anchorReachable(ctx: FilingContext, filed: Filed): boolean {
  const task = ctx.store.getTask(filed.taskId);
  if (!task) return false;
  return task.status !== 'done' && task.archivedAt === undefined;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
