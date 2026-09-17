/**
 * Never spend an agent's turn on an event that asks it for nothing.
 *
 * THE DEFECT. A person resolves a thread. The act carries no word —
 * `thread.resolved` is a status flip, and `channel-messages.ts` renders it
 * with an empty body for exactly that reason — so the MCP child woke the
 * agent, which read a line with nothing in it and learned that a click had
 * happened. Measured 2026-09-17 across the fleet's week, together with
 * `review_item.viewed`, at 3.3% of its wakes.
 *
 * WHY `review_item.viewed` IS NOT HERE, though it is the same kind of thing.
 * It is dropped in the SERVER, in the `taskStore.onEvent` fan-out, beside
 * `task.noted` and `dispatch.requested` — see `ANALYTICS_ONLY_EVENTS` in
 * `packages/server/src/review-items/analytics.ts`. That is the better home
 * whenever a drop is decidable from the event's NAME alone, because a
 * bundle-side filter only takes effect for sessions that have restarted onto
 * the new plugin, while a server-side one stops every attached session paying
 * the moment prod restarts. Two things that would normally argue the other way
 * do not apply to it: dropping at the fan-out means the frame never enters the
 * replay buffer either (so there is nothing for a reconnecting stream to leak
 * back), and the row carries no queue id, so no receipt is stranded. Nothing
 * in the browser reads it — `review-item-seen.ts` only WRITES the beacon.
 *
 * So the division is: a drop decidable from the name goes in the server fan-
 * out; a drop that needs the frame's own STATE goes here, because the child is
 * where that state is in hand. `thread.resolved` is the second kind — see the
 * carve-out below, which reads what the thread was carrying.
 *
 * THIS IS NOT THE SELF-ECHO RULE, and the two must not be merged. Telling
 * them apart is one question — WHOSE act is it?
 *
 *   - `self-authored.ts` drops a frame because THIS SESSION caused it. The
 *     event may carry a great deal; the session already has it. Another
 *     agent's copy of the identical frame is delivered, because for them it
 *     is news. The rule reads the frame's ACTOR and nothing else.
 *   - This file drops a frame because the EVENT carries no request, whoever
 *     caused it. Nobody is delivered it — not a peer, not the lead, not the
 *     agent that filed the ask. The rule reads the frame's NAME (and, for a
 *     resolve, what the thread was carrying) and never its actor.
 *
 * So a frame is suppressed here on a property of the event and there on a
 * property of the session, and a reviewer can tell which rule dropped a wake
 * by asking whether anyone else got it.
 *
 * WHAT IS NOT LOST — the same answer as the self-echo rule, and for the same
 * reason. Nothing here touches the store or any read path. The thread's
 * `resolved` status is exactly where the next `list_threads`, `get_thread` or
 * `get_doc` will find it. The event becomes state the agent reads on its next
 * wake rather than a wake of its own.
 *
 * WHY IT IS A LIST AND NOT A PREFIX. A wrong suppression is silence, and an
 * agent cannot tell silence from "nothing happened". So members are named one
 * at a time with the reason each carries no ask; a family prefix would
 * silently swallow the next event added under it, which is the failure this
 * whole area exists to avoid. An event with no entry here wakes its reader.
 *
 * WHAT IS DELIBERATELY ABSENT, having been considered:
 *
 *   - `thread.reopened` — a reopen says the work is not done. That is a
 *     request, and it is the exact inverse of a resolve.
 *   - `review_item.answered` — an answer is the outcome the filer is blocked
 *     on. It is ids-only like `viewed`, and its words do ride `thread.replied`
 *     and `decision.answered`, so a case could be made; the case is not
 *     strong enough to risk being the one that was the only signal. It is
 *     also, deliberately, not in the server's analytics list for the same
 *     reason.
 *   - `task.transitioned`, `task.regrouped`, `task.archived`,
 *     `task.retitled`, `task.body_edited`, `task.assigned` — each changes
 *     what the agent should be doing, not merely the record of what it did. A
 *     row archived, reassigned, moved to a different goal or rewritten under
 *     a working agent is news that agent has to act on, and a regroup that
 *     only reordered within a band is not separable from one that moved the
 *     row without reading `fromGoal` against `toGoal` here, which is a second
 *     copy of a rule that lives on the board.
 *   - `agent.attached` / `agent.detached` — a peer joining or leaving the
 *     board changes who can be handed work.
 *
 * The self-echo rule already covers the case where the acting session is the
 * reader for every one of those, which is what leaves this file needing only
 * the event whose CONTENT is empty for everybody.
 */

/** A comment as it rides a thread event, with the ask it may be carrying. */
interface ThreadComment {
  review?: {
    answeredAt?: unknown;
    answeredWith?: unknown;
    withdrawnAt?: unknown;
  };
}

/**
 * Might this thread have been carrying an ask that is still waiting on
 * somebody?
 *
 * A resolve RETIRES every review item on the thread —
 * `packages/core/src/review-item.ts` says so in as many words, and
 * `review-queue.ts` stops offering them the moment the status moves. So the
 * one resolve that is not bookkeeping is the one that closes an unanswered
 * ask: the agent that filed it is waiting, and nothing else in the server
 * will tell it that the question went away.
 *
 * Deliberately LOOSER than core's `pendingDeclaration`, and not a copy of it.
 * That function names the ONE live ask on a thread — newest by time, stepping
 * over withdrawn ones, `null` on a non-open thread — because a surface has to
 * pick a single item to offer. This asks only whether any unretired ask is
 * present at all, so an older declaration superseded by a newer answered one
 * still counts. The two rules disagree only in the direction of DELIVERING a
 * wake, which is the safe direction and the reason this is not worth an
 * import that would bind the renderer to a rule written for a different job.
 *
 * `undefined` — a payload with no readable thread on it — is a third answer
 * rather than a `false`: it means the question could not be asked, and the
 * caller delivers, exactly as `self-authored.ts` delivers a frame it cannot
 * attribute.
 */
function mayCarryAnOpenAsk(thread: unknown): boolean | undefined {
  if (!thread || typeof thread !== 'object') return undefined;
  const comments = (thread as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) return undefined;
  return comments.some((c) => {
    const review = (c as ThreadComment | undefined)?.review;
    if (!review || typeof review !== 'object') return false;
    return (
      review.answeredAt === undefined &&
      review.answeredWith === undefined &&
      review.withdrawnAt === undefined
    );
  });
}

/**
 * Whether this frame records something that happened without asking the
 * reader for anything.
 *
 * `true` means "do not wake"; every event not named below answers `false`.
 */
export function isBookkeepingEvent(event: string, payload: unknown): boolean {
  // A thread closed. Nothing was said — `channel-messages.ts` renders a
  // resolve with an empty body for exactly this reason — and a closed thread
  // is the absence of a request rather than one. Unless it closed over an ask
  // nobody answered; see `mayCarryAnOpenAsk`.
  if (event === 'thread.resolved') {
    if (!payload || typeof payload !== 'object') return false;
    return mayCarryAnOpenAsk((payload as { thread?: unknown }).thread) === false;
  }
  return false;
}
