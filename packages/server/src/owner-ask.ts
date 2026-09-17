/**
 * Whether a person is owed an answer on a task, and whether the ask is where
 * they read it.
 *
 * Its own module because it is its own QUESTION. `keep-moving.ts` answers a
 * different one — is this row work somebody picks up — and the two shared a
 * branch until a rule row showed why they cannot. A row carrying a schedule
 * was bucketed `scheduled-rule` before anything looked for an ask, so the
 * unfiled reading below was unreachable for every rule row, and a question
 * left on one went unread while the rule kept closing green. Nothing here
 * reads a bucket, and the bucketing reads nothing here.
 *
 * It does read the schedule's DATE, which is a different thing and was the
 * correction of 2026-09-17. Splitting the two questions made every reading
 * here reachable for a rule row, including for one whose date has not
 * arrived — and a row deferred to January owes nobody an answer today. Six
 * rows on a peer board were named "waiting on a person with NO question
 * filed" the day after the split, all scheduled months out, one of them
 * deferred by its owner in as many words. So the rule's calendar is a fourth
 * fact below, and the bucket is still not.
 *
 * "Waiting on a person" is DECLARED, never inferred (rebuild step 2,
 * 2026-09-08): a task is waiting when an open review item is filed for it,
 * and it then carries the ADDRESS of that item. Whether an item is open is
 * the Home queue's own predicate, read by the caller that builds the rows
 * handed to `indexFiledAsks`; nothing here reads prose.
 */

import { type TaskSchedule, nextOccurrence } from '@claude-workspaces/core/task-schedule';

/**
 * Where a filed item lives — the thing a waiting row carries so that every
 * later reader (the wake, the verdict, the escalation) can find the ask
 * rather than take the row's word for it. Same three shapes the review gate
 * addresses (`review-gate.ts`), minus nothing: a ticket's own decision is a
 * `task` address under the derived legacy id.
 */
export type FiledItemAddress =
  | { kind: 'task'; taskId: string; reviewItemId: string }
  | { kind: 'thread'; docId: string; threadId: string; commentId: string };

export interface ReviewItemRow {
  taskId?: string;
  docId?: string;
  /** When the ask was filed — a review filing is board activity. */
  askedAt?: number;
  /** The item's own address. Absent only from a caller that has none to
   *  give; the server always does. */
  address?: FiledItemAddress;
}

/**
 * A person is owed an answer. `'filed'` means the ask is on their queue;
 * `'unfiled'` means it exists only in somebody's head. The absence of a
 * reading means nobody is waiting on a person at all — which is not the same
 * as `'filed'`, and conflating the two is how a silence gets excused.
 */
export type OwnerAsk = 'filed' | 'unfiled';

/** The board's open review items, indexed by the task they were filed for. */
export interface FiledAsks {
  /** Whether ANY open item is filed for the task. This is what "an ask is
   *  FILED" means; nothing softer counts. */
  has(taskId: string): boolean;
  /** When the newest open item for the task was filed, so an old ask can go
   *  on the "re-verify the blocker is still real" list. */
  newestAt(taskId: string): number | undefined;
  /** Every open item filed for the task, newest first, for the row to name.
   *  Undefined when none of them carried an address. */
  addressesFor(taskId: string): FiledItemAddress[] | undefined;
}

/**
 * Index the items once for a whole pass. A `docId` of `task:<id>` is the same
 * address as a `taskId` — the thread-borne items arrive spelled that way.
 */
export function indexFiledAsks(items: readonly ReviewItemRow[]): FiledAsks {
  const asked = new Set<string>();
  const newest = new Map<string, number>();
  const addresses = new Map<string, Array<{ at: number; address: FiledItemAddress }>>();
  for (const r of items) {
    const id = r.taskId ?? (r.docId?.startsWith('task:') ? r.docId.slice(5) : undefined);
    if (!id) continue;
    asked.add(id);
    if (typeof r.askedAt === 'number' && r.askedAt > (newest.get(id) ?? Number.NEGATIVE_INFINITY))
      newest.set(id, r.askedAt);
    if (r.address) {
      const list = addresses.get(id) ?? [];
      list.push({ at: r.askedAt ?? 0, address: r.address });
      addresses.set(id, list);
    }
  }
  return {
    has: (taskId) => asked.has(taskId),
    newestAt: (taskId) => newest.get(taskId),
    addressesFor: (taskId) => {
      const list = addresses.get(taskId);
      if (!list || list.length === 0) return undefined;
      return [...list].sort((a, b) => b.at - a.at).map((entry) => entry.address);
    },
  };
}

/**
 * The reading, from the three facts the board can check.
 *
 * Owner-blocked is only LEGITIMATE waiting when a pending item exists — that
 * is what puts the ask on the owner's Home queue. An owner-band task, or a
 * person-owned one (`ownerKind`, the server's authoritative call), with no
 * pending item is an ask that exists nowhere he reads: a protocol violation
 * counting toward FAIL (the 08-27 review: 7 of 10 "blocked-on-owner" rows
 * were invisible on his queue). Prose is not a third way in — a "waiting on
 * Bryan" note only loses its movement credit (`waiting-unfiled.ts`).
 *
 * UNLESS the task is in the BACKLOG — the band the board runs for nobody,
 * outside the dispatch order AND the owner band — where there is no ask
 * anyone could file. Only the person half narrows: `dispatchable` SUBTRACTS
 * the owner band (`stall-wiring.ts`), so reading the backlog first would have
 * silenced the owner band's asks entirely.
 */
export function ownerAskOf(facts: {
  /** An open review item is filed for the task (`FiledAsks.has`). */
  hasPendingAsk: boolean;
  /** The board says a person owns this, by assignee or by band. */
  boardSaysOwnerWaits: boolean;
  /** The task's band is neither dispatched nor the owner's. */
  inBacklog: boolean;
  /** The row's rule, when it has one (`Task.schedule`). Read here for its
   *  DATE and nothing else — the bucketing still reads it separately, and
   *  neither reading is derived from the other. */
  schedule?: TaskSchedule;
  /** Now, so the date above can be judged. The module stays pure. */
  now: number;
}): OwnerAsk | undefined {
  if (facts.hasPendingAsk) return 'filed';
  if (facts.boardSaysOwnerWaits && !facts.inBacklog && !deferredToADate(facts.schedule, facts.now))
    return 'unfiled';
  return undefined;
}

/**
 * Whether the row's rule is still waiting for its own date.
 *
 * `nextOccurrence` with no cursor, because the question is about the rule's
 * calendar and not about any instance it has produced: a next occurrence in
 * the future means the work has not started, so nobody has been asked
 * anything yet. No occurrence at all — a one-off already fired, an `until`
 * exhausted — is NOT a deferral: the rule is spent, and a person-owned row
 * the board is still carrying owes the same answer any other one does.
 */
function deferredToADate(schedule: TaskSchedule | undefined, now: number): boolean {
  if (schedule === undefined) return false;
  const next = nextOccurrence(schedule);
  return next !== undefined && next > now;
}
