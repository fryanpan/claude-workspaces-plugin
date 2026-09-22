/**
 * The line an agent reads when a review item is filed, revised or put back on
 * a TASK.
 *
 * THE DEFECT THIS CLOSES. `review_item.added` / `.revised` / `.withdrawn` are
 * ticket events: `packages/server/src/review-items/store.ts` emits them with
 * `workspaceId`, `taskId`, `reviewItemId`, `shape`, `headline` and `actor`.
 * None of those names appears in `BOARD_EVENT_RE`, so every one of them fell
 * through to the doc-shaped tail of `emitChannelMessage`, which reads
 * `docId`, `threadId`, a comment author and an anchor snippet — four fields a
 * ticket event does not have. The frame that reached a reader therefore said
 * `doc_id="unknown"`, an empty thread id and an empty author, and named
 * neither the board, the task, nor the ask. Seen on prod 2026-09-22: the
 * scheduler filed its stale-rule item on a lead's own task and the lead spent
 * six tool calls failing to work out what the wake was about before the item
 * withdrew itself.
 *
 * WHY A SEPARATE MODULE rather than three more arms of the board switch.
 * Same reason `nudge-line.ts`, `decision-line.ts`, `scheduled-line.ts` and
 * `voice-line.ts` exist: the wording is a decision that has to be assertable
 * without spawning a renderer, and `channel-messages.ts` is already a listed
 * exception to the 500-line bar. This file holds wording and nothing else —
 * the routing decision stays in one place, in `emitChannelMessage`.
 *
 * WHY THE BRANCH IS ON `taskId`. A review item has two homes: a ticket, and a
 * thread on an ordinary doc. Only the ticket form carries `taskId`, and only
 * the doc form carries `docId` — the reader addresses one by task and the
 * other by doc and thread, and a frame that named the wrong pair is the same
 * defect pointing the other way. So the presence of `taskId` picks this
 * renderer, and anything carrying a `docId` keeps the doc path untouched.
 */

/** A ticket-borne review-item event, as `server.ts` puts it on `ws~<id>`: the
 *  store's row with `type` renamed to `event`. Every field is optional here
 *  because an older server omits some and this renderer must not throw on a
 *  frame it can still say something useful about. */
export interface ReviewItemEventPayload {
  workspaceId?: string;
  taskId?: string;
  reviewItemId?: string;
  /** `review_item.added` only, and the reason the line is worth reading: the
   *  ask verbatim. `.revised` and `.withdrawn` carry no headline at all. */
  headline?: string;
  /** `review_item.revised` only: the anchored thread the revision answers. */
  threadId?: string;
  /** `review_item.withdrawn` only: true on the undo, when the ask is back in
   *  front of the reader rather than gone. */
  reinstated?: boolean;
  /** `review_item.withdrawn` only: the asker's one line on why. */
  reason?: string;
  actor?: { id?: string; name?: string };
}

/** The three ticket events this renderer claims. `review_item.viewed` and
 *  `review_item.answered` are deliberately absent: both are measurement rows
 *  (`review-items/analytics.ts`), ids-only by contract, and `viewed` never
 *  leaves the server's fan-out at all. */
const TASK_REVIEW_ITEM_EVENTS = new Set([
  'review_item.added',
  'review_item.revised',
  'review_item.withdrawn',
]);

/**
 * Is this a review-item event about a TASK, as opposed to one about a doc
 * thread or a measurement row?
 *
 * Both halves matter. A `docId` on the frame means the item hangs on a doc
 * thread, where the existing doc rendering is the right one; no `taskId`
 * means there is no ticket to name, and inventing one would be the original
 * defect with a different placeholder.
 */
export function isTaskReviewItemEvent(event: string, payload: unknown): boolean {
  if (!TASK_REVIEW_ITEM_EVENTS.has(event)) return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as { taskId?: unknown; docId?: unknown };
  if (typeof p.docId === 'string' && p.docId.trim() !== '') return false;
  return typeof p.taskId === 'string' && p.taskId.trim() !== '';
}

/** Long enough for an ask written as a sentence, short enough that the line
 *  stays one line in a terminal beside the ids that follow it. */
const HEADLINE_MAX = 100;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * One line naming the ask, the item and the task — in that order, because the
 * ask is what decides whether the reader acts and the ids are what they act
 * with.
 *
 * The actor clause is dropped rather than filled with a placeholder when the
 * frame carries no name: `by ?` reads as an attribution and is not one.
 */
export function reviewItemTaskLine(event: string, p: ReviewItemEventPayload): string {
  const item = p.reviewItemId ?? '?';
  const where = `item ${item} on task ${p.taskId ?? '?'}`;
  const by = p.actor?.name ? ` by ${p.actor.name}` : '';
  if (event === 'review_item.added') {
    const ask = p.headline ? `"${truncate(p.headline, HEADLINE_MAX)}" — ` : '';
    return `[review item added] ${ask}${where}${by}`;
  }
  if (event === 'review_item.revised') {
    // An owner's revision puts the item back on the reader's queue, marked.
    // That, not the edit, is what the reader is being told.
    const answers = p.threadId ? `answers thread ${p.threadId}, ` : '';
    return `[review item revised] ${where}${by} — ${answers}back on the queue`;
  }
  if (p.reinstated === true) {
    return `[review item reinstated] ${where}${by} — back in front of the reader`;
  }
  // Reached only if the bookkeeping gate is ever narrowed: a plain withdrawal
  // asks the reader for nothing and is dropped before this renderer runs.
  const why = p.reason ? ` — ${truncate(p.reason, 80)}` : '';
  return `[review item withdrawn] ${where}${by}${why}`;
}
