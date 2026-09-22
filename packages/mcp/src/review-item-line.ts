/**
 * The line an agent reads when a review item on a TASK is filed, revised,
 * withdrawn or answered — and, for the last two, whether it reads one at all.
 *
 * THE DEFECT THIS CLOSES. These are ticket events:
 * `packages/server/src/review-items/store.ts` emits `added`, `revised` and
 * `withdrawn` with `workspaceId`, `taskId`, `reviewItemId`, `shape`,
 * `headline` and `actor`, and `review-items/analytics.ts` emits `answered`
 * with ids. None of those names appears in `BOARD_EVENT_RE`, so every one of
 * them fell through to the doc-shaped tail of `emitChannelMessage`, which
 * reads `docId`, `threadId`, a comment author and an anchor snippet — four
 * fields a ticket event does not have. The frame that reached a reader said
 * `doc_id="unknown"`, an empty thread id and an empty author, and named
 * neither the board, the task, nor the ask. Seen on prod 2026-09-22: the
 * scheduler filed its stale-rule item on a lead's own task and the lead spent
 * six tool calls failing to work out what the wake was about before the item
 * withdrew itself.
 *
 * WHY A SEPARATE MODULE rather than four more arms of the board switch. Same
 * reason `nudge-line.ts`, `decision-line.ts`, `scheduled-line.ts` and
 * `voice-line.ts` exist: the wording is a decision that has to be assertable
 * without spawning a renderer, and `channel-messages.ts` is already a listed
 * exception to the 500-line bar. This file holds the wording and the two
 * questions the renderer asks of these events; the routing decision stays in
 * one place, in `emitChannelMessage`.
 *
 * WHY THE BRANCH IS ON `taskId`. A review item has two homes: a ticket, and a
 * thread on an ordinary doc. Only the ticket form carries `taskId`, and only
 * the doc form carries `docId` — the reader addresses one by task and the
 * other by doc and thread, and a frame that named the wrong pair is the same
 * defect pointing the other way.
 *
 * WHAT THE LINE MUST NOT CLAIM. A filing and a revision are emitted by the
 * STORE; the route judges them afterwards, and a held item "is not on
 * anybody's queue" (`routes/task-review-items.ts`). A reinstatement is the
 * same: that route withholds its own announcement when the reinstated item is
 * still held. So no line here says an item is on a queue or in front of a
 * reader. It says what happened to the item, which is what the frame knows.
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
   *  ask verbatim. The other three carry no headline at all. */
  headline?: string;
  /** `review_item.added` only: decision, approval and the rest. In the meta
   *  rather than the line — it changes how the reader answers, not whether
   *  they look. */
  shape?: string;
  /** `review_item.revised` only: the newest asked-back question on the item
   *  at the time of the revision. NOT a claim that this revision answered it
   *  — `latestThreadedQuestion` picks the newest, whatever the revision was
   *  about — which is why the line says "after a question on" rather than
   *  "answers". */
  threadId?: string;
  /** `review_item.withdrawn` only: true on the undo. */
  reinstated?: boolean;
  /** `review_item.withdrawn` only: the asker's one line on why. */
  reason?: string;
  /** `review_item.withdrawn` and `.answered`: the agent that RAISED the ask,
   *  which is who the frame is for. See `addressedToFiler`. */
  filedById?: string;
  actor?: { id?: string; name?: string };
}

/**
 * The four ticket events this renderer claims.
 *
 * `review_item.viewed` is deliberately absent: it is the one review-item row
 * the server really does keep off the fan-out
 * (`ANALYTICS_ONLY_EVENTS` in `review-items/analytics.ts` holds it and
 * nothing else), so no child ever sees one. `review_item.answered` is NOT on
 * that list, deliberately — an answer is the thing an agent waits for — so it
 * reaches a child and belongs here.
 */
const TASK_REVIEW_ITEM_EVENTS = new Set([
  'review_item.added',
  'review_item.revised',
  'review_item.withdrawn',
  'review_item.answered',
]);

/**
 * The two whose only reader is the agent that RAISED the ask.
 *
 * A withdrawal retires somebody's question and an answer settles it; either
 * way the one session with something to do is the one that stopped for it.
 * Everyone else on the board has nothing — and "everyone else" is the common
 * case rather than the rare one: `withdraw_review_item` says in as many words
 * that any agent may retire a stale ask, and every server auto-withdrawal
 * (the scheduler's stale-rule item, the stall escalation's, the done-when
 * owner's) fires as a board actor the self-echo gate suppresses for nobody.
 *
 * This is NOT the self-echo rule and not the bookkeeping rule. Self-echo asks
 * whose act it was and drops the actor's own copy; bookkeeping asks whether
 * the event carries a request at all and drops it for everybody. This asks
 * who the request is FOR, and delivers to exactly one session.
 */
const FILER_ADDRESSED_EVENTS = new Set(['review_item.withdrawn', 'review_item.answered']);

/**
 * Is this a review-item event about a TASK, as opposed to one about a doc
 * thread?
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

/**
 * May this session read this frame?
 *
 * `true` for every event that is news to the board — a filing, a revision.
 * For the two addressed ones it is `true` only for the filer the server
 * named, so a frame with no `filedById` reaches nobody.
 *
 * That last part is a suppression on missing data, which this codebase
 * otherwise refuses to do. It is deliberate and it is bounded: `filedById` is
 * absent only on an item raised before the store began stamping its filer, so
 * the silence ages out with those items, and what is lost is one notice about
 * an ask whose state the filer's next `list_tasks` reads anyway. Delivering
 * instead would put every one of those back on every agent on the board,
 * which is the noise this rule exists to remove.
 */
export function readsThisReviewItemEvent(
  event: string,
  p: ReviewItemEventPayload,
  selfId: string,
): boolean {
  if (!FILER_ADDRESSED_EVENTS.has(event)) return true;
  const filer = p.filedById?.trim();
  if (filer === undefined || filer === '') return false;
  return filer.toLowerCase() === selfId.trim().toLowerCase();
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
 * frame carries no name: `by ?` reads as an attribution and is not one. The
 * answered line has no actor clause at all — that row names who answered as a
 * bare id derived from an email, and this file does not print those.
 */
export function reviewItemTaskLine(event: string, p: ReviewItemEventPayload): string {
  const item = p.reviewItemId ?? '?';
  const where = `item ${item} on task ${p.taskId ?? '?'}`;
  const by = p.actor?.name ? ` by ${p.actor.name}` : '';
  if (event === 'review_item.added') {
    const ask = p.headline ? `"${truncate(p.headline, HEADLINE_MAX)}" — ` : '';
    return `[review item filed] ${ask}${where}${by}`;
  }
  if (event === 'review_item.revised') {
    const after = p.threadId ? ` — after a question on thread ${p.threadId}` : '';
    return `[review item revised] ${where}${by}${after}`;
  }
  if (event === 'review_item.answered') {
    // Delivered to the filer alone, so the second person is accurate.
    return `[review item answered] ${where} — the ask you filed has an answer`;
  }
  if (p.reinstated === true) {
    return `[review item reinstated] ${where}${by} — the ask is back on the ticket`;
  }
  const why = p.reason ? ` — ${truncate(p.reason, 80)}` : '';
  return `[review item withdrawn] ${where}${by}${why}`;
}
